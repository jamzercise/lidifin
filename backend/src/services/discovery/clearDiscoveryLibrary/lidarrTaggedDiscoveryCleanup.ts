import { logger } from "../../../utils/logger";
import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import type { ClearLibrarySettings } from "./types";

/**
 * Phase 3: remove Lidarr artists that still have the lidifin-discovery tag and no kept discovery albums.
 */
export async function runLidarrTaggedDiscoveryCleanup(
    settings: ClearLibrarySettings,
): Promise<number> {
    let lidarrArtistsRemoved = 0;

    if (
        !settings.lidarrEnabled ||
        !settings.lidarrUrl ||
        !settings.lidarrApiKey
    ) {
        return lidarrArtistsRemoved;
    }

    logger.debug(
        `\n[LIDARR CLEANUP] Tag-based cleanup (lidifin-discovery tag)...`,
    );

    try {
        const discoveryArtists = await lidarrService.getDiscoveryArtists();
        logger.debug(
            `   Found ${discoveryArtists.length} artists with discovery tag`,
        );

        for (const lidarrArtist of discoveryArtists) {
            const artistMbid = lidarrArtist.foreignArtistId;
            const artistName = lidarrArtist.artistName;

            if (!artistMbid) continue;

            const hasKeptDiscovery = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid: artistMbid,
                    status: { in: ["LIKED", "MOVED"] },
                },
            });

            if (hasKeptDiscovery) {
                logger.debug(
                    `   Keeping ${artistName} - has liked albums (removing tag)`,
                );
                await lidarrService.removeDiscoveryTagByMbid(artistMbid);
                continue;
            }

            try {
                const result = await lidarrService.deleteArtistById(
                    lidarrArtist.id,
                    true,
                );
                if (result.success) {
                    lidarrArtistsRemoved++;
                    logger.debug(` Removed: ${artistName}`);
                }
            } catch (deleteError: unknown) {
                const msg =
                    deleteError instanceof Error
                        ? deleteError.message
                        : String(deleteError);
                logger.debug(` Failed to remove ${artistName}: ${msg}`);
            }
        }

        logger.debug(
            `   Tag-based cleanup complete: ${lidarrArtistsRemoved} artists removed`,
        );
    } catch (lidarrError: unknown) {
        const msg =
            lidarrError instanceof Error
                ? lidarrError.message
                : String(lidarrError);
        logger.debug(`   Lidarr cleanup failed: ${msg}`);
    }

    return lidarrArtistsRemoved;
}
