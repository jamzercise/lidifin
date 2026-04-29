/**
 * Discovery Seeding Module
 *
 * Handles seed artist selection for discovering new music based on:
 * - User's listening history (recent plays)
 * - Library contents (fallback when insufficient history)
 * - Album ownership checks use Album + tracks (OwnedAlbum removed in Arch-X.d)
 */

import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { lidarrService } from '../lidarr';
import { getJellyfinSeedArtists } from '../jellyfinArtistBridge';
import { subWeeks } from 'date-fns';

export interface SeedArtist {
    name: string;
    mbid?: string;
}

export class DiscoverySeeding {
    private readonly DEFAULT_SEED_COUNT = 10;
    private readonly MIN_PLAYS_THRESHOLD = 5;
    private readonly RECENT_PLAYS_LIMIT = 50;

    /**
     * Gets seed artists based on user's listening history across both
     * native library and Jellyfin sources. Falls back to library artists
     * when insufficient play history.
     */
    async getSeedArtists(userId: string, seedCount?: number): Promise<SeedArtist[]> {
        const limit = seedCount ?? this.DEFAULT_SEED_COUNT;
        const fourWeeksAgo = subWeeks(new Date(), 4);

        // Query all recent plays (native + Jellyfin) without source filter
        const recentPlays = await prisma.play.groupBy({
            by: ['trackId'],
            where: {
                userId,
                playedAt: { gte: fourWeeksAgo },
            },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: this.RECENT_PLAYS_LIMIT,
        });

        if (recentPlays.length < this.MIN_PLAYS_THRESHOLD) {
            return this.getFallbackSeedArtists(limit);
        }

        // Split into native and Jellyfin track IDs
        const nativeTrackIds: string[] = [];
        const jellyfinTrackIds: string[] = [];
        for (const play of recentPlays) {
            if (play.trackId.startsWith('jellyfin:')) {
                jellyfinTrackIds.push(play.trackId);
            } else {
                nativeTrackIds.push(play.trackId);
            }
        }

        const artistMap = new Map<string, SeedArtist>();

        // Resolve native tracks → artists (existing logic)
        if (nativeTrackIds.length > 0) {
            const tracks = await prisma.track.findMany({
                where: {
                    id: { in: nativeTrackIds },
                    album: { tracks: { some: {} } },
                },
                include: { album: { include: { artist: true } } },
            });

            for (const track of tracks) {
                const artist = track.album.artist;
                if (!artistMap.has(artist.mbid) && this.isValidMbid(artist.mbid)) {
                    artistMap.set(artist.mbid, {
                        name: artist.name,
                        mbid: artist.mbid,
                    });
                }
            }
        }

        // Resolve Jellyfin tracks → artists via the bridge service
        if (jellyfinTrackIds.length > 0) {
            try {
                const jellyfinSeeds = await getJellyfinSeedArtists(
                    userId,
                    fourWeeksAgo,
                    limit
                );
                for (const bridged of jellyfinSeeds) {
                    if (!artistMap.has(bridged.mbid)) {
                        artistMap.set(bridged.mbid, {
                            name: bridged.name,
                            mbid: bridged.mbid,
                        });
                    }
                }
                logger.debug(
                    `[DiscoverySeeding] Bridged ${jellyfinSeeds.length} Jellyfin artists into seed pool`
                );
            } catch (err) {
                logger.warn(
                    '[DiscoverySeeding] Failed to bridge Jellyfin artists:',
                    err instanceof Error ? err.message : err
                );
            }
        }

        const artists = Array.from(artistMap.values()).slice(0, limit);
        logger.debug(`[DiscoverySeeding] Found ${artists.length} seed artists from play history (native + Jellyfin)`);
        return artists;
    }

    /**
     * Fallback: Get artists with most albums in library when play history is insufficient.
     */
    private async getFallbackSeedArtists(limit: number): Promise<SeedArtist[]> {
        logger.debug('[DiscoverySeeding] Insufficient play history, falling back to library');

        const albums = await prisma.album.groupBy({
            by: ['artistId'],
            where: { tracks: { some: {} } },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: limit,
        });

        const artists = await prisma.artist.findMany({
            where: { id: { in: albums.map((a) => a.artistId) } },
        });

        return artists
            .filter((a) => this.isValidMbid(a.mbid))
            .map((a) => ({ name: a.name, mbid: a.mbid }));
    }

    /**
     * Checks if an artist is already in the user's library (has albums).
     * Discovery should find NEW artists, not more albums from artists they already own.
     */
    async isArtistInLibrary(artistMbid: string): Promise<boolean> {
        if (!this.isValidMbid(artistMbid)) {
            return false;
        }

        const artist = await prisma.artist.findFirst({
            where: { mbid: artistMbid },
            include: { albums: { take: 1 } },
        });

        if (artist && artist.albums.length > 0) {
            logger.debug(`[DiscoverySeeding] Artist ${artistMbid} is in library`);
            return true;
        }

        return false;
    }

    /**
     * Checks if an album is already in the user's library or pipeline:
     * - Album with tracks
     * - Previous discovery
     * - Pending downloads
     * - Lidarr
     */
    async isAlbumOwned(albumMbid: string, userId: string): Promise<boolean> {
        const existingAlbum = await prisma.album.findFirst({
            where: { rgMbid: albumMbid, tracks: { some: {} } },
        });
        if (existingAlbum) return true;

        const previousDiscovery = await prisma.discoveryAlbum.findFirst({
            where: { rgMbid: albumMbid, userId },
        });
        if (previousDiscovery) return true;

        const pendingDownload = await prisma.downloadJob.findFirst({
            where: {
                targetMbid: albumMbid,
                status: { in: ['pending', 'processing'] },
            },
        });
        if (pendingDownload) return true;

        const inLidarr = await lidarrService.isAlbumAvailable(albumMbid);
        if (inLidarr) return true;

        return false;
    }

    /**
     * Validates that an MBID is not null/undefined and not a temporary ID.
     */
    private isValidMbid(mbid: string | null | undefined): mbid is string {
        return !!mbid && !mbid.startsWith('temp-');
    }
}

export const discoverySeeding = new DiscoverySeeding();
