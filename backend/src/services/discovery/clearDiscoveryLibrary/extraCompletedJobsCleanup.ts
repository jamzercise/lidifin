import axios from "axios";
import { logger } from "../../../utils/logger";
import { prisma } from "../../../utils/db";
import type { ClearLibrarySettings } from "./types";

type JobMetadata = {
    artistName?: string;
    albumTitle?: string;
    artistMbid?: string;
};

/**
 * Clean up completed download jobs that never made it into DiscoveryAlbum (extras),
 * with guards so LIKED / MOVED discovery content is never removed.
 */
export async function cleanupExtraCompletedDownloadJobs(
    userId: string,
    settings: ClearLibrarySettings,
): Promise<void> {
    if (
        !settings.lidarrEnabled ||
        !settings.lidarrUrl ||
        !settings.lidarrApiKey
    ) {
        return;
    }

    const completedJobs = await prisma.downloadJob.findMany({
        where: {
            userId,
            discoveryBatchId: { not: null },
            status: "completed",
        },
    });

    const allDiscoveryAlbums = await prisma.discoveryAlbum.findMany({
        where: { userId },
        select: {
            rgMbid: true,
            artistName: true,
            albumTitle: true,
            status: true,
        },
    });
    const discoveryMbids = new Set(allDiscoveryAlbums.map((da) => da.rgMbid));

    const likedArtistNames = new Set(
        allDiscoveryAlbums
            .filter((da) => da.status === "LIKED" || da.status === "MOVED")
            .map((da) => da.artistName.toLowerCase()),
    );

    const extraJobs = completedJobs.filter((job) => {
        if (discoveryMbids.has(job.targetMbid)) return false;

        const metadata = job.metadata as JobMetadata | null;
        const artistName = metadata?.artistName?.toLowerCase();
        if (artistName && likedArtistNames.has(artistName)) {
            logger.debug(
                `    Skipping ${metadata?.albumTitle} - artist ${metadata?.artistName} has liked albums`,
            );
            return false;
        }

        return true;
    });

    if (extraJobs.length === 0) {
        return;
    }

    logger.debug(
        `\n[CLEANUP] Found ${extraJobs.length} extra albums to clean from Lidarr...`,
    );

    for (const job of extraJobs) {
        const metadata = job.metadata as JobMetadata | null;
        const albumTitle = metadata?.albumTitle || job.subject;
        const artistName = metadata?.artistName;

        const isLikedByName = await prisma.discoveryAlbum.findFirst({
            where: {
                userId,
                artistName: {
                    equals: artistName,
                    mode: "insensitive",
                },
                albumTitle: {
                    equals: albumTitle,
                    mode: "insensitive",
                },
                status: { in: ["LIKED", "MOVED"] },
            },
        });

        if (isLikedByName) {
            logger.debug(`    Skipping ${albumTitle} - marked as LIKED`);
            continue;
        }

        if (!job.lidarrAlbumId) continue;

        try {
            let artistId: number | undefined;
            try {
                const albumResponse = await axios.get(
                    `${settings.lidarrUrl}/api/v1/album/${job.lidarrAlbumId}`,
                    {
                        headers: {
                            "X-Api-Key": settings.lidarrApiKey,
                        },
                        timeout: 10000,
                    },
                );
                artistId = albumResponse.data.artistId;
            } catch {
                // Album might not exist
            }

            await axios.delete(
                `${settings.lidarrUrl}/api/v1/album/${job.lidarrAlbumId}`,
                {
                    params: { deleteFiles: true },
                    headers: {
                        "X-Api-Key": settings.lidarrApiKey,
                    },
                    timeout: 10000,
                },
            );
            logger.debug(`    Cleaned up extra album: ${albumTitle}`);

            if (artistId) {
                const hasLikedByArtistName =
                    await prisma.discoveryAlbum.findFirst({
                        where: {
                            artistName: {
                                equals: artistName,
                                mode: "insensitive",
                            },
                            status: { in: ["LIKED", "MOVED"] },
                        },
                    });

                if (hasLikedByArtistName) {
                    logger.debug(
                        `    Keeping artist: ${artistName} (has liked albums)`,
                    );
                    continue;
                }

                const artistMbid = metadata?.artistMbid;
                if (artistMbid && !artistMbid.startsWith("temp-")) {
                    const hasNativeLibrary = await prisma.album.findFirst({
                        where: {
                            artist: { mbid: artistMbid },
                            tracks: { some: {} },
                        },
                        select: { id: true },
                    });

                    if (!hasNativeLibrary) {
                        try {
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                {
                                    params: {
                                        deleteFiles: true,
                                    },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                },
                            );
                            logger.debug(
                                `    Removed extra artist from Lidarr: ${artistName}`,
                            );
                        } catch {
                            // Artist might have other albums
                        }
                    }
                }
            }
        } catch (e: unknown) {
            if (axios.isAxiosError(e) && e.response?.status !== 404) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.debug(`    Failed to clean up ${albumTitle}: ${msg}`);
            }
        }
    }
}
