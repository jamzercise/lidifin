import axios from "axios";
import fs from "fs";
import path from "path";
import type { DiscoveryAlbum } from "@prisma/client";
import { logger } from "../../../utils/logger";
import { prisma } from "../../../utils/db";
import { config } from "../../../config";
import type { ClearLibrarySettings } from "./types";

export async function deleteActiveDiscoveryAlbums(
    settings: ClearLibrarySettings,
    activeAlbums: DiscoveryAlbum[],
): Promise<number> {
    let activeDeleted = 0;

    if (activeAlbums.length === 0) {
        return activeDeleted;
    }

    logger.debug(`\n[CLEANUP] Deleting non-liked albums...`);

    const checkedArtistIds = new Set<number>();

    for (const album of activeAlbums) {
        try {
            if (
                settings.lidarrEnabled &&
                settings.lidarrUrl &&
                settings.lidarrApiKey &&
                album.lidarrAlbumId
            ) {
                try {
                    let artistId: number | undefined;
                    try {
                        const albumResponse = await axios.get(
                            `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                            {
                                headers: {
                                    "X-Api-Key": settings.lidarrApiKey,
                                },
                                timeout: 10000,
                            },
                        );
                        artistId = albumResponse.data.artistId;
                    } catch (e: unknown) {
                        if (
                            axios.isAxiosError(e) &&
                            e.response?.status === 404
                        ) {
                            // continue
                        } else {
                            throw e;
                        }
                    }

                    await axios.delete(
                        `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                        {
                            params: { deleteFiles: true },
                            headers: {
                                "X-Api-Key": settings.lidarrApiKey,
                            },
                            timeout: 10000,
                        },
                    );
                    logger.debug(
                        `    Deleted from Lidarr: ${album.albumTitle}`,
                    );

                    if (artistId && !checkedArtistIds.has(artistId)) {
                        checkedArtistIds.add(artistId);

                        try {
                            const artistResponse = await axios.get(
                                `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                {
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                },
                            );

                            const artist = artistResponse.data;
                            const artistMbid = artist.foreignArtistId;

                            const hasNativeOwnedAlbums =
                                await prisma.album.findFirst({
                                    where: {
                                        artist: { mbid: artistMbid },
                                        tracks: { some: {} },
                                    },
                                    select: { id: true },
                                });

                            const hasKeptDiscoveryAlbums =
                                await prisma.discoveryAlbum.findFirst({
                                    where: {
                                        artistMbid: artistMbid,
                                        status: {
                                            in: ["LIKED", "MOVED"],
                                        },
                                    },
                                });

                            if (
                                !hasNativeOwnedAlbums &&
                                !hasKeptDiscoveryAlbums
                            ) {
                                await axios.delete(
                                    `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                    {
                                        params: { deleteFiles: true },
                                        headers: {
                                            "X-Api-Key":
                                                settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    },
                                );
                                logger.debug(
                                    `    Removed artist from Lidarr: ${artist.artistName}`,
                                );
                            } else {
                                logger.debug(
                                    `    Keeping artist in Lidarr: ${artist.artistName} (has library or kept albums)`,
                                );
                            }
                        } catch {
                            // Artist might have other albums
                        }
                    }
                } catch (lidarrError: unknown) {
                    if (
                        axios.isAxiosError(lidarrError) &&
                        lidarrError.response?.status !== 404
                    ) {
                        const msg =
                            lidarrError instanceof Error
                                ? lidarrError.message
                                : String(lidarrError);
                        logger.debug(
                            `  Lidarr delete failed for ${album.albumTitle}: ${msg}`,
                        );
                    }
                }
            }

            try {
                const discoveryPath = path.join(
                    config.music.musicPath,
                    "discovery",
                );
                const possiblePaths = [
                    path.join(
                        discoveryPath,
                        album.artistName,
                        album.albumTitle,
                    ),
                    path.join(discoveryPath, album.artistName),
                    path.join(
                        discoveryPath,
                        `${album.artistName} - ${album.albumTitle}`,
                    ),
                ];

                for (const albumPath of possiblePaths) {
                    if (fs.existsSync(albumPath)) {
                        fs.rmSync(albumPath, {
                            recursive: true,
                            force: true,
                        });
                        logger.debug(`    Direct deleted: ${albumPath}`);
                        break;
                    }
                }
            } catch (fsError: unknown) {
                const msg =
                    fsError instanceof Error
                        ? fsError.message
                        : String(fsError);
                logger.debug(
                    `    Filesystem delete failed for ${album.albumTitle}: ${msg}`,
                );
            }

            await prisma.discoveryTrack.deleteMany({
                where: { discoveryAlbumId: album.id },
            });

            const dbAlbum = await prisma.album.findFirst({
                where: {
                    title: album.albumTitle,
                    artist: { name: album.artistName },
                },
                include: { tracks: true },
            });

            if (dbAlbum) {
                await prisma.track.deleteMany({
                    where: { albumId: dbAlbum.id },
                });

                await prisma.album.delete({
                    where: { id: dbAlbum.id },
                });
            }

            await prisma.discoveryAlbum.update({
                where: { id: album.id },
                data: { status: "DELETED" },
            });

            activeDeleted++;
        } catch (error: unknown) {
            const msg =
                error instanceof Error ? error.message : String(error);
            logger.error(
                `  ✗ Failed to delete ${album.albumTitle}: ${msg}`,
            );
        }
    }

    return activeDeleted;
}
