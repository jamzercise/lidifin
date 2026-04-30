import { logger } from "../../../utils/logger";
import { prisma } from "../../../utils/db";
import { getSystemSettings } from "../../../utils/systemSettings";
import { moveLikedAlbumsToLibrary } from "./moveLikedAlbums";
import { deleteActiveDiscoveryAlbums } from "./deleteActiveAlbums";
import { cleanupExtraCompletedDownloadJobs } from "./extraCompletedJobsCleanup";
import { deleteUnavailableAlbumsForUser, pruneOrphanDiscoveryDbRecords } from "./orphansAndPruning";
import { cleanupFailedJobsAndLidarrArtists } from "./failedJobsLidarrCleanup";
import { runLidarrTaggedDiscoveryCleanup } from "./lidarrTaggedDiscoveryCleanup";
import { queuePostClearLibraryScan } from "./queuePostClearScan";
import type { ClearDiscoveryLibraryResult } from "./types";

export type { ClearDiscoveryLibraryResult } from "./types";

/**
 * Finalize a discovery batch: move LIKED albums into the library and tear down
 * the rest (Lidarr + filesystem + Prisma rows). Used by DELETE /discover/clear.
 */
export async function clearDiscoveryLibraryForUser(
    userId: string,
): Promise<ClearDiscoveryLibraryResult> {
    logger.debug(`\n Clearing Discover Weekly playlist for user ${userId}`);

    const discoveryAlbums = await prisma.discoveryAlbum.findMany({
        where: {
            userId,
            status: { in: ["ACTIVE", "LIKED"] },
        },
    });

    if (discoveryAlbums.length === 0) {
        return {
            success: true,
            message: "No discovery albums to clear",
            likedMoved: 0,
            activeDeleted: 0,
            orphanedAlbumsDeleted: 0,
            lidarrArtistsRemoved: 0,
        };
    }

    const likedAlbums = discoveryAlbums.filter((a) => a.status === "LIKED");
    const activeAlbums = discoveryAlbums.filter((a) => a.status === "ACTIVE");

    logger.debug(
        `  Found ${likedAlbums.length} liked albums to move to library`,
    );
    logger.debug(`  Found ${activeAlbums.length} active albums to delete`);

    const settings = await getSystemSettings();
    if (!settings) {
        throw new Error("System settings not found");
    }

    const likedMoved = await moveLikedAlbumsToLibrary(settings, likedAlbums);
    const activeDeleted = await deleteActiveDiscoveryAlbums(
        settings,
        activeAlbums,
    );

    await cleanupExtraCompletedDownloadJobs(userId, settings);
    await deleteUnavailableAlbumsForUser(userId);
    await cleanupFailedJobsAndLidarrArtists(userId, settings);

    const { orphanedAlbumsDeleted } =
        await pruneOrphanDiscoveryDbRecords(userId);

    const lidarrArtistsRemoved =
        await runLidarrTaggedDiscoveryCleanup(settings);

    await queuePostClearLibraryScan(userId);

    logger.debug(
        `\nClear complete: ${likedMoved} moved to library, ${activeDeleted} deleted, ${orphanedAlbumsDeleted} orphans cleaned, ${lidarrArtistsRemoved} Lidarr artists removed`,
    );

    return {
        success: true,
        message: "Discovery playlist cleared",
        likedMoved,
        activeDeleted,
        orphanedAlbumsDeleted,
        lidarrArtistsRemoved,
    };
}
