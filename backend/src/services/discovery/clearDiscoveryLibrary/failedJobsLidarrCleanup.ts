import axios from "axios";
import { logger } from "../../../utils/logger";
import { prisma } from "../../../utils/db";
import type { ClearLibrarySettings } from "./types";

type FailedJobMetadata = {
    artistMbid?: string;
    artistName?: string;
};

/**
 * Remove failed-batch artists from Lidarr when they have no native library or kept discovery albums.
 * Deletes matching failed DownloadJob rows after processing.
 */
export async function cleanupFailedJobsAndLidarrArtists(
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

    logger.debug(
        `\n[CLEANUP] Checking for failed artists to remove from Lidarr...`,
    );

    const failedJobs = await prisma.downloadJob.findMany({
        where: {
            userId,
            status: "failed",
            discoveryBatchId: { not: null },
        },
    });

    const failedArtistMbids = new Set<string>();
    const artistNames = new Map<string, string>();

    for (const job of failedJobs) {
        const metadata = job.metadata as FailedJobMetadata | null;
        if (metadata?.artistMbid) {
            failedArtistMbids.add(metadata.artistMbid);
            artistNames.set(
                metadata.artistMbid,
                metadata.artistName || "Unknown",
            );
        }
    }

    for (const artistMbid of failedArtistMbids) {
        try {
            const hasNativeOwnedAlbums = await prisma.album.findFirst({
                where: {
                    artist: { mbid: artistMbid },
                    tracks: { some: {} },
                },
                select: { id: true },
            });

            if (hasNativeOwnedAlbums) {
                logger.debug(
                    `   Keeping ${artistNames.get(
                        artistMbid,
                    )} - has native library content`,
                );
                continue;
            }

            const hasLikedDiscovery = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid,
                    status: { in: ["LIKED", "MOVED"] },
                },
            });

            if (hasLikedDiscovery) {
                logger.debug(
                    `   Keeping ${artistNames.get(
                        artistMbid,
                    )} - has liked discovery albums`,
                );
                continue;
            }

            const searchResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/artist`,
                {
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 10000,
                },
            );

            const lidarrArtist = searchResponse.data.find(
                (a: { foreignArtistId?: string }) =>
                    a.foreignArtistId === artistMbid,
            );

            if (lidarrArtist) {
                await axios.delete(
                    `${settings.lidarrUrl}/api/v1/artist/${lidarrArtist.id}`,
                    {
                        params: { deleteFiles: true },
                        headers: { "X-Api-Key": settings.lidarrApiKey },
                        timeout: 10000,
                    },
                );
                logger.debug(
                    ` Removed failed artist from Lidarr: ${artistNames.get(
                        artistMbid,
                    )}`,
                );
            }
        } catch {
            // Ignore errors - artist might already be removed
        }
    }

    await prisma.downloadJob.deleteMany({
        where: {
            userId,
            discoveryBatchId: { not: null },
            status: "failed",
        },
    });
}
