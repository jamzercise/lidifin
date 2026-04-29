/**
 * Data Integrity Worker
 *
 * Periodic cleanup to maintain database health:
 * 1. Remove expired DiscoverExclusion records
 * 2. Clean up orphaned DiscoveryTrack records
 * 3. Clean up orphaned discovery-path albums (no active DiscoveryAlbum link)
 * 4. Consolidate duplicate artists (temp MBID vs real MBID)
 * 5. Clean up orphaned artists (no albums)
 * 6. Clean up old completed/failed DownloadJob records
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import {
    canonicalizeArtistArticleOrder,
    getPreferredArtistName,
    normalizeArtistName,
} from "../utils/artistNormalization";

interface IntegrityReport {
    expiredExclusions: number;
    orphanedDiscoveryTracks: number;
    mislocatedAlbums: number;
    orphanedAlbums: number;
    consolidatedArtists: number;
    orphanedArtists: number;
    oldDownloadJobs: number;
}

type ConsolidationArtist = {
    id: string;
    mbid: string;
    name: string;
    normalizedName: string;
    heroUrl: string | null;
    similarArtistsJson: unknown;
    _count: {
        albums: number;
    };
};

function isTempMbid(mbid: string | null | undefined): boolean {
    return !!mbid && mbid.startsWith("temp-");
}

function hasValidMbid(artist: Pick<ConsolidationArtist, "mbid">): boolean {
    return !!artist.mbid && !isTempMbid(artist.mbid);
}

function artistNameConsolidationKey(
    artist: Pick<ConsolidationArtist, "name">
): string {
    return `name:${normalizeArtistName(canonicalizeArtistArticleOrder(artist.name))}`;
}

function scoreArtistForCanonical(artist: ConsolidationArtist): number {
    let score = 0;
    if (hasValidMbid(artist)) score += 1000;
    if (artist.heroUrl) score += 15;
    if (Array.isArray(artist.similarArtistsJson) && artist.similarArtistsJson.length > 0) {
        score += 10;
    }
    score += artist._count.albums * 10;

    // Prefer canonical leading-article names ("The Books")
    if (
        artist.name.trim() === canonicalizeArtistArticleOrder(artist.name.trim())
    ) {
        score += 8;
    }
    return score;
}

function pickCanonicalArtist(group: ConsolidationArtist[]): ConsolidationArtist {
    const sorted = [...group].sort((a, b) => {
        const diff = scoreArtistForCanonical(b) - scoreArtistForCanonical(a);
        if (diff !== 0) return diff;
        return a.id.localeCompare(b.id);
    });
    return sorted[0];
}

export async function runDataIntegrityCheck(): Promise<IntegrityReport> {
    logger.debug("\nRunning data integrity check...");

    const report: IntegrityReport = {
        expiredExclusions: 0,
        orphanedDiscoveryTracks: 0,
        mislocatedAlbums: 0,
        orphanedAlbums: 0,
        consolidatedArtists: 0,
        orphanedArtists: 0,
        oldDownloadJobs: 0,
    };

    // 1. Remove expired DiscoverExclusion records
    const expiredExclusions = await prisma.discoverExclusion.deleteMany({
        where: {
            expiresAt: { lt: new Date() },
        },
    });
    report.expiredExclusions = expiredExclusions.count;
    if (expiredExclusions.count > 0) {
        logger.debug(
            `     Removed ${expiredExclusions.count} expired exclusions`
        );
    }

    // 2. Clean up orphaned DiscoveryTrack records (tracks whose Track record was deleted)
    const orphanedDiscoveryTracks = await prisma.discoveryTrack.deleteMany({
        where: {
            trackId: null,
        },
    });
    report.orphanedDiscoveryTracks = orphanedDiscoveryTracks.count;
    if (orphanedDiscoveryTracks.count > 0) {
        logger.debug(
            `     Removed ${orphanedDiscoveryTracks.count} orphaned discovery track records`
        );
    }

    // 3. Orphaned discovery-only albums (Arch-X.d: no Album.location; use file paths)
    const discoveryPathSegment = "/music/discovery";
    const discoverAlbums = await prisma.album.findMany({
        where: {
            tracks: {
                some: {},
                every: {
                    filePath: {
                        contains: discoveryPathSegment,
                        mode: "insensitive",
                    },
                },
            },
        },
        include: { artist: true },
    });

    for (const album of discoverAlbums) {
        const hasActiveRecord = await prisma.discoveryAlbum.findFirst({
            where: {
                OR: [
                    { rgMbid: album.rgMbid },
                    {
                        albumTitle: { equals: album.title, mode: "insensitive" },
                        artistName: { equals: album.artist.name, mode: "insensitive" },
                    },
                ],
                status: { in: ["ACTIVE", "LIKED", "MOVED"] },
            },
        });

        if (!hasActiveRecord) {
            await prisma.track.deleteMany({
                where: { albumId: album.id },
            });
            await prisma.album.delete({
                where: { id: album.id },
            });
            report.orphanedAlbums++;
            logger.debug(
                `     Removed orphaned album: ${album.artist.name} - ${album.title}`
            );
        }
    }

    // 4. Clean up albums with NO tracks
    const emptyAlbums = await prisma.album.findMany({
        where: {
            tracks: { none: {} },
        },
        include: { artist: true },
    });

    for (const album of emptyAlbums) {
        await prisma.album.delete({
            where: { id: album.id },
        });

        report.orphanedAlbums++;
        logger.debug(
            `     Removed empty album (no tracks): ${album.artist.name} - ${album.title}`
        );
    }

    // 5. Consolidate duplicate artists:
    // - temp MBID <-> real MBID duplicates
    // - alias form duplicates ("Books, The" <-> "The Books")
    const allArtists = (await prisma.artist.findMany({
        select: {
            id: true,
            mbid: true,
            name: true,
            normalizedName: true,
            heroUrl: true,
            similarArtistsJson: true,
            _count: {
                select: {
                    albums: true,
                },
            },
        },
    })) as ConsolidationArtist[];

    const mbidGroups = new Map<string, ConsolidationArtist[]>();
    const nameGroups = new Map<string, ConsolidationArtist[]>();
    for (const artist of allArtists) {
        if (hasValidMbid(artist)) {
            const mbidKey = `mbid:${artist.mbid.toLowerCase()}`;
            const existingMbid = mbidGroups.get(mbidKey) ?? [];
            existingMbid.push(artist);
            mbidGroups.set(mbidKey, existingMbid);
        }
        const nameKey = artistNameConsolidationKey(artist);
        const existingName = nameGroups.get(nameKey) ?? [];
        existingName.push(artist);
        nameGroups.set(nameKey, existingName);
    }

    // Build artist-merge graph:
    // - always connect identical valid MBIDs
    // - connect same-name aliases only when one side lacks a valid MBID
    //   (or both share MBID), to avoid merging distinct artists with same name.
    const adjacency = new Map<string, Set<string>>();
    const connect = (a: ConsolidationArtist, b: ConsolidationArtist) => {
        if (a.id === b.id) return;
        if (!adjacency.has(a.id)) adjacency.set(a.id, new Set());
        if (!adjacency.has(b.id)) adjacency.set(b.id, new Set());
        adjacency.get(a.id)!.add(b.id);
        adjacency.get(b.id)!.add(a.id);
    };

    for (const group of mbidGroups.values()) {
        if (group.length < 2) continue;
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                connect(group[i], group[j]);
            }
        }
    }
    for (const group of nameGroups.values()) {
        if (group.length < 2) continue;
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const a = group[i];
                const b = group[j];
                const compatibleByMbid =
                    !hasValidMbid(a) ||
                    !hasValidMbid(b) ||
                    a.mbid.toLowerCase() === b.mbid.toLowerCase();
                if (compatibleByMbid) {
                    connect(a, b);
                }
            }
        }
    }

    const byId = new Map(allArtists.map((a) => [a.id, a]));
    const visited = new Set<string>();
    const duplicateClusters: ConsolidationArtist[][] = [];

    for (const artist of allArtists) {
        if (visited.has(artist.id)) continue;
        const neighbors = adjacency.get(artist.id);
        if (!neighbors || neighbors.size === 0) continue;

        const stack = [artist.id];
        const component = new Set<string>();
        while (stack.length > 0) {
            const current = stack.pop()!;
            if (visited.has(current)) continue;
            visited.add(current);
            component.add(current);
            for (const next of adjacency.get(current) ?? []) {
                if (!visited.has(next)) stack.push(next);
            }
        }

        if (component.size > 1) {
            duplicateClusters.push(
                Array.from(component)
                    .map((id) => byId.get(id))
                    .filter(Boolean) as ConsolidationArtist[]
            );
        }
    }

    for (const cluster of duplicateClusters) {
        const canonical = pickCanonicalArtist(cluster);
        const duplicates = cluster.filter((a) => a.id !== canonical.id);
        for (const duplicate of duplicates) {
            try {
                // Keep best metadata on canonical artist
                const mergedName = canonicalizeArtistArticleOrder(
                    getPreferredArtistName(canonical.name, duplicate.name)
                );
                const mergedMbid = hasValidMbid(canonical)
                    ? canonical.mbid
                    : hasValidMbid(duplicate)
                        ? duplicate.mbid
                        : canonical.mbid;
                const mergedHeroUrl = canonical.heroUrl ?? duplicate.heroUrl ?? null;

                await prisma.artist.update({
                    where: { id: canonical.id },
                    data: {
                        name: mergedName,
                        normalizedName: normalizeArtistName(mergedName),
                        mbid: mergedMbid,
                        heroUrl: mergedHeroUrl,
                    },
                });
                canonical.name = mergedName;
                canonical.normalizedName = normalizeArtistName(mergedName);
                canonical.mbid = mergedMbid;
                canonical.heroUrl = mergedHeroUrl;

                await prisma.album.updateMany({
                    where: { artistId: duplicate.id },
                    data: { artistId: canonical.id },
                });

                // Merge SimilarArtist edges while preserving strongest weight.
                const oldEdges = await prisma.similarArtist.findMany({
                    where: {
                        OR: [
                            { fromArtistId: duplicate.id },
                            { toArtistId: duplicate.id },
                        ],
                    },
                });
                for (const edge of oldEdges) {
                    const fromArtistId =
                        edge.fromArtistId === duplicate.id
                            ? canonical.id
                            : edge.fromArtistId;
                    const toArtistId =
                        edge.toArtistId === duplicate.id
                            ? canonical.id
                            : edge.toArtistId;
                    if (fromArtistId === toArtistId) continue;

                    const existingEdge = await prisma.similarArtist.findUnique({
                        where: {
                            fromArtistId_toArtistId: { fromArtistId, toArtistId },
                        },
                    });
                    if (existingEdge) {
                        if (edge.weight > existingEdge.weight) {
                            await prisma.similarArtist.update({
                                where: {
                                    fromArtistId_toArtistId: {
                                        fromArtistId,
                                        toArtistId,
                                    },
                                },
                                data: { weight: edge.weight },
                            });
                        }
                    } else {
                        await prisma.similarArtist.create({
                            data: { fromArtistId, toArtistId, weight: edge.weight },
                        });
                    }
                }

                await prisma.similarArtist.deleteMany({
                    where: {
                        OR: [
                            { fromArtistId: duplicate.id },
                            { toArtistId: duplicate.id },
                        ],
                    },
                });

                await prisma.artist.delete({
                    where: { id: duplicate.id },
                });

                report.consolidatedArtists++;
                logger.debug(
                    `     Consolidated duplicate artist "${duplicate.name}" -> "${mergedName}"`
                );
            } catch (err: unknown) {
                logger.warn(
                    `[Integrity] Failed consolidating artist "${duplicate.name}" into "${canonical.name}":`,
                    err instanceof Error ? err.message : err
                );
            }
        }
    }

    // 6. Clean up orphaned artists (no albums)
    const orphanedArtists = await prisma.artist.findMany({
        where: {
            albums: { none: {} },
        },
    });

    if (orphanedArtists.length > 0) {
        // Delete SimilarArtist relations first
        await prisma.similarArtist.deleteMany({
            where: {
                OR: [
                    { fromArtistId: { in: orphanedArtists.map((a) => a.id) } },
                    {
                        toArtistId: {
                            in: orphanedArtists.map((a) => a.id),
                        },
                    },
                ],
            },
        });

        // Delete orphaned artists
        await prisma.artist.deleteMany({
            where: { id: { in: orphanedArtists.map((a) => a.id) } },
        });

        report.orphanedArtists = orphanedArtists.length;
    }

    // 7. Clean up old DownloadJob records (older than 30 days, completed/failed)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oldJobs = await prisma.downloadJob.deleteMany({
        where: {
            status: { in: ["completed", "failed"] },
            completedAt: { lt: thirtyDaysAgo },
        },
    });
    report.oldDownloadJobs = oldJobs.count;
    if (oldJobs.count > 0) {
        logger.debug(`     Removed ${oldJobs.count} old download jobs`);
    }

    // Summary
    logger.debug("\nData integrity check complete:");
    logger.debug(`   - Expired exclusions: ${report.expiredExclusions}`);
    logger.debug(
        `   - Orphaned discovery tracks: ${report.orphanedDiscoveryTracks}`
    );
    logger.debug(`   - Mislocated albums (deprecated; always 0 post Arch-X.d): ${report.mislocatedAlbums}`);
    logger.debug(`   - Orphaned albums: ${report.orphanedAlbums}`);
    logger.debug(`   - Consolidated artists: ${report.consolidatedArtists}`);
    logger.debug(`   - Orphaned artists: ${report.orphanedArtists}`);
    logger.debug(`   - Old download jobs: ${report.oldDownloadJobs}`);

    return report;
}

// CLI entry point
if (require.main === module) {
    runDataIntegrityCheck()
        .then((report) => {
            logger.debug("\nData integrity check completed successfully");
            process.exit(0);
        })
        .catch((err) => {
            logger.error("\n Data integrity check failed:", err);
            process.exit(1);
        });
}
