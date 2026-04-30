import { logger } from "../../../utils/logger";
import { prisma } from "../../../utils/db";

const DISCOVERY_PATH_SEGMENT = "/music/discovery";

export async function deleteUnavailableAlbumsForUser(
    userId: string,
): Promise<void> {
    await prisma.unavailableAlbum.deleteMany({
        where: { userId },
    });
}

/**
 * Orphaned discovery-only Album rows, empty artists, dangling DiscoveryTracks, old MOVED/DELETED rows.
 */
export async function pruneOrphanDiscoveryDbRecords(
    userId: string,
): Promise<{ orphanedAlbumsDeleted: number }> {
    logger.debug(`\n Cleaning up orphaned discovery records...`);

    const orphanedAlbums = await prisma.album.findMany({
        where: {
            tracks: {
                some: {},
                every: {
                    filePath: {
                        contains: DISCOVERY_PATH_SEGMENT,
                        mode: "insensitive",
                    },
                },
            },
        },
        include: { artist: true, tracks: true },
    });

    let orphanedAlbumsDeleted = 0;
    for (const orphanAlbum of orphanedAlbums) {
        const hasDiscoveryRecord = await prisma.discoveryAlbum.findFirst({
            where: {
                OR: [
                    { rgMbid: orphanAlbum.rgMbid },
                    {
                        albumTitle: orphanAlbum.title,
                        artistName: orphanAlbum.artist.name,
                    },
                ],
                status: { in: ["ACTIVE", "LIKED", "MOVED"] },
            },
        });

        if (!hasDiscoveryRecord) {
            await prisma.track.deleteMany({
                where: { albumId: orphanAlbum.id },
            });
            await prisma.album.delete({
                where: { id: orphanAlbum.id },
            });
            orphanedAlbumsDeleted++;
            logger.debug(
                `    Deleted orphaned album: ${orphanAlbum.artist.name} - ${orphanAlbum.title}`,
            );
        }
    }

    if (orphanedAlbumsDeleted > 0) {
        logger.debug(
            `  Cleaned up ${orphanedAlbumsDeleted} orphaned discovery albums`,
        );
    }

    const orphanedArtists = await prisma.artist.findMany({
        where: {
            albums: { none: {} },
        },
    });

    if (orphanedArtists.length > 0) {
        const orphanIds = orphanedArtists.map((a) => a.id);

        await prisma.similarArtist.deleteMany({
            where: {
                OR: [
                    { fromArtistId: { in: orphanIds } },
                    { toArtistId: { in: orphanIds } },
                ],
            },
        });

        await prisma.artist.deleteMany({
            where: { id: { in: orphanIds } },
        });
        logger.debug(`  Cleaned up ${orphanedArtists.length} orphaned artists`);
    }

    const orphanedDiscoveryTracks = await prisma.discoveryTrack.deleteMany({
        where: {
            trackId: null,
        },
    });

    if (orphanedDiscoveryTracks.count > 0) {
        logger.debug(
            `  Cleaned up ${orphanedDiscoveryTracks.count} orphaned discovery track records`,
        );
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oldDiscoveryAlbums = await prisma.discoveryAlbum.deleteMany({
        where: {
            userId,
            status: { in: ["DELETED", "MOVED"] },
            downloadedAt: { lt: thirtyDaysAgo },
        },
    });

    if (oldDiscoveryAlbums.count > 0) {
        logger.debug(
            `  Cleaned up ${oldDiscoveryAlbums.count} old discovery album records`,
        );
    }

    return { orphanedAlbumsDeleted };
}
