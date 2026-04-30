import axios from "axios";
import type { DiscoveryAlbum } from "@prisma/client";
import { logger } from "../../../utils/logger";
import { prisma } from "../../../utils/db";
import type { ClearLibrarySettings } from "./types";

export async function moveLikedAlbumsToLibrary(
    settings: ClearLibrarySettings,
    likedAlbums: DiscoveryAlbum[],
): Promise<number> {
    let likedMoved = 0;

    if (likedAlbums.length === 0) {
        return likedMoved;
    }

    logger.debug(`\n[LIBRARY] Moving liked albums to library...`);

    for (const album of likedAlbums) {
        try {
            const dbAlbum = await prisma.album.findFirst({
                where: {
                    title: album.albumTitle,
                    artist: { name: album.artistName },
                },
                include: { artist: true },
            });

            if (dbAlbum) {
                if (
                    settings.lidarrEnabled &&
                    settings.lidarrUrl &&
                    settings.lidarrApiKey &&
                    album.lidarrAlbumId
                ) {
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

                        const artistId = albumResponse.data.artistId;

                        const artistResponse = await axios.get(
                            `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                            {
                                headers: {
                                    "X-Api-Key": settings.lidarrApiKey,
                                },
                                timeout: 10000,
                            },
                        );

                        if (
                            artistResponse.data.path?.includes("/music/discovery")
                        ) {
                            await axios.put(
                                `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                {
                                    ...artistResponse.data,
                                    path: artistResponse.data.path.replace(
                                        "/music/discovery",
                                        "/music",
                                    ),
                                    moveFiles: true,
                                },
                                {
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 30000,
                                },
                            );
                            logger.debug(
                                `    Moved to library: ${album.artistName} - ${album.albumTitle}`,
                            );
                        }
                    } catch (lidarrError: unknown) {
                        const msg =
                            lidarrError instanceof Error
                                ? lidarrError.message
                                : String(lidarrError);
                        logger.debug(
                            `  Lidarr move failed for ${album.albumTitle}: ${msg}`,
                        );
                    }
                }

                likedMoved++;
            }

            await prisma.discoveryAlbum.update({
                where: { id: album.id },
                data: { status: "MOVED" },
            });
        } catch (error: unknown) {
            const msg =
                error instanceof Error ? error.message : String(error);
            logger.error(
                `  ✗ Failed to move ${album.albumTitle}: ${msg}`,
            );
        }
    }

    return likedMoved;
}
