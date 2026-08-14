import { logger } from "../utils/logger";

/**
 * Release Radar API
 *
 * Provides upcoming and recent releases from:
 * 1. Lidarr monitored artists (via calendar API)
 * 2. Similar artists from user's library (Last.fm similar artists)
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { lidarrService, CalendarRelease } from "../services/lidarr";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { openLibraryReader } from "../services/discovery";
import { prisma } from "../utils/db";

const router = Router();

router.use(requireAuth);

interface ReleaseRadarResponse {
    upcoming: ReleaseItem[];
    recent: ReleaseItem[];
    monitoredArtistCount: number;
    similarArtistCount: number;
}

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: 'lidarr' | 'similar';
    status: 'upcoming' | 'released' | 'available';
    inLibrary: boolean;
    canDownload: boolean;
}

/**
 * GET /releases/radar
 * 
 * Get upcoming and recent releases for the user's monitored artists
 * and their similar artists.
 */
router.get("/radar", async (req, res) => {
    try {
        const now = new Date();
        const daysBack = parseInt(req.query.daysBack as string) || 30;
        const daysAhead = parseInt(req.query.daysAhead as string) || 90;

        // Calculate date range
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysBack);
        
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + daysAhead);

        logger.debug(`[Releases] Fetching radar: ${daysBack} days back, ${daysAhead} days ahead`);

        // 1. Get releases from Lidarr calendar (monitored artists)
        const lidarrReleases = await lidarrService.getCalendar(startDate, endDate);
        
        // 2. Get monitored artists from Lidarr
        const monitoredArtists = await lidarrService.getMonitoredArtists();
        const monitoredMbids = new Set(monitoredArtists.map(a => a.mbid));

        // 3. Get similar artists from user's library that aren't monitored
        const similarArtists = await prisma.similarArtist.findMany({
            where: {
                // Source artist is in the library (has albums)
                fromArtist: {
                    albums: { some: {} }
                },
                // Target artist is NOT in library (no albums)
                toArtist: {
                    albums: { none: {} }
                }
            },
            select: {
                toArtist: {
                    select: {
                        id: true,
                        name: true,
                        mbid: true,
                    }
                },
                weight: true,
            },
            orderBy: { weight: 'desc' },
            take: 50, // Top 50 similar artists
        });

        // Filter out any that are already monitored in Lidarr
        const unmonitoredSimilar = similarArtists.filter(
            sa => sa.toArtist.mbid && !monitoredMbids.has(sa.toArtist.mbid)
        );

        logger.debug(`[Releases] Found ${lidarrReleases.length} Lidarr releases`);
        logger.debug(`[Releases] Found ${unmonitoredSimilar.length} unmonitored similar artists`);

        // 4. Check which releases the user already has, in whichever library.
        // This drives the download button as well as the badge, so getting it
        // wrong offers to re-download music they hold.
        const library = await openLibraryReader();
        const alreadyHeld = await library.ownedAlbums(
            lidarrReleases.map(release => ({
                artistName: release.artistName,
                albumTitle: release.title,
                rgMbid: release.albumMbid,
            }))
        );

        // 5. Transform Lidarr releases
        const releases: ReleaseItem[] = lidarrReleases.map((release, i) => {
            const releaseTime = new Date(release.releaseDate).getTime();
            const isUpcoming = releaseTime > now.getTime();
            const inLibrary = release.hasFile || alreadyHeld[i];

            return {
                id: release.id,
                title: release.title,
                artistName: release.artistName,
                artistMbid: release.artistMbid,
                albumMbid: release.albumMbid,
                releaseDate: release.releaseDate,
                coverUrl: release.coverUrl,
                source: 'lidarr' as const,
                status: isUpcoming ? 'upcoming' : (inLibrary ? 'available' : 'released'),
                inLibrary,
                canDownload: !inLibrary && !isUpcoming,
            };
        });

        // 6. Split into upcoming and recent
        const upcoming = releases
            .filter(r => r.status === 'upcoming')
            .sort((a, b) => new Date(a.releaseDate).getTime() - new Date(b.releaseDate).getTime());

        const recent = releases
            .filter(r => r.status !== 'upcoming')
            .sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());

        const response: ReleaseRadarResponse = {
            upcoming,
            recent,
            monitoredArtistCount: monitoredArtists.length,
            similarArtistCount: unmonitoredSimilar.length,
        };

        res.json(response);
    } catch (error: any) {
        logger.error("[Releases] Radar error:", error.message);
        res.status(500).json({ error: "Failed to fetch release radar" });
    }
});

/**
 * GET /releases/upcoming
 * 
 * Get only upcoming releases (next X days)
 */
router.get("/upcoming", async (req, res) => {
    try {
        const daysAhead = parseInt(req.query.days as string) || 90;
        
        const now = new Date();
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + daysAhead);

        const releases = await lidarrService.getCalendar(now, endDate);
        
        // Sort by release date (soonest first)
        const sorted = releases.sort((a, b) => 
            new Date(a.releaseDate).getTime() - new Date(b.releaseDate).getTime()
        );

        res.json({
            releases: sorted,
            count: sorted.length,
            daysAhead,
        });
    } catch (error: any) {
        logger.error("[Releases] Upcoming error:", error.message);
        res.status(500).json({ error: "Failed to fetch upcoming releases" });
    }
});

/**
 * GET /releases/recent
 * 
 * Get recently released albums (last X days) that user might want to download
 */
router.get("/recent", async (req, res) => {
    try {
        const daysBack = parseInt(req.query.days as string) || 30;
        
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysBack);

        const releases = await lidarrService.getCalendar(startDate, now);
        
        // Get library albums to mark what's already downloaded
        const libraryAlbums = await prisma.album.findMany({
            select: { rgMbid: true }
        });
        const libraryMbids = new Set(libraryAlbums.map(a => a.rgMbid).filter(Boolean));

        // Filter to releases not in library and sort (newest first)
        const notInLibrary = releases
            .filter(r => !r.hasFile && !libraryMbids.has(r.albumMbid))
            .sort((a, b) => 
                new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime()
            );

        res.json({
            releases: notInLibrary,
            count: notInLibrary.length,
            daysBack,
            inLibraryCount: releases.length - notInLibrary.length,
        });
    } catch (error: any) {
        logger.error("[Releases] Recent error:", error.message);
        res.status(500).json({ error: "Failed to fetch recent releases" });
    }
});

/**
 * POST /releases/download/:albumMbid
 * 
 * Download a release from the radar
 */
router.post("/download/:albumMbid", async (req, res) => {
    try {
        const { albumMbid } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: "Authentication required" });
        }

        if (!albumMbid) {
            return res.status(400).json({ error: "albumMbid is required" });
        }

        if (!(await lidarrService.isEnabled())) {
            return res.status(400).json({
                error: "Lidarr is not configured. Connect Lidarr in Settings to download releases.",
            });
        }

        // The radar UI has the full release on hand; prefer the posted
        // metadata and fall back to a calendar lookup if it's missing.
        let artistName: string | undefined = req.body?.artistName;
        let albumTitle: string | undefined = req.body?.albumTitle;

        if (!artistName || !albumTitle) {
            const now = new Date();
            const start = new Date(now);
            start.setDate(start.getDate() - 365);
            const end = new Date(now);
            end.setDate(end.getDate() + 365);
            const calendar = await lidarrService.getCalendar(start, end);
            const match = calendar.find((r) => r.albumMbid === albumMbid);
            artistName = artistName || match?.artistName;
            albumTitle = albumTitle || match?.title;
        }

        if (!artistName || !albumTitle) {
            return res.status(404).json({
                error: "Could not resolve the release. Try refreshing the radar.",
            });
        }

        logger.debug(
            `[Releases] Download requested: ${artistName} - ${albumTitle} (${albumMbid})`
        );

        // The DownloadJob table is the source of truth — if this album is
        // already downloading, report that instead of double-grabbing.
        const existingJob = await prisma.downloadJob.findFirst({
            where: {
                targetMbid: albumMbid,
                status: { in: ["pending", "processing"] },
            },
            select: { id: true, status: true },
        });
        if (existingJob) {
            return res.status(202).json({
                success: true,
                message: `"${albumTitle}" is already downloading`,
                jobId: existingJob.id,
                duplicate: true,
            });
        }

        // Reuse the same job + Lidarr pipeline as every other album download.
        let job;
        try {
            job = await prisma.downloadJob.create({
                data: {
                    userId,
                    subject: `${albumTitle} by ${artistName}`,
                    type: "album",
                    targetMbid: albumMbid,
                    status: "pending",
                    metadata: {
                        downloadType: "album",
                        source: "release-radar",
                        artistName,
                        albumTitle,
                    },
                },
            });
        } catch (error: any) {
            // P2002: a concurrent request created the active job first.
            if (error.code === "P2002") {
                const racedJob = await prisma.downloadJob.findFirst({
                    where: {
                        targetMbid: albumMbid,
                        status: { in: ["pending", "processing"] },
                    },
                    select: { id: true },
                });
                if (racedJob) {
                    return res.status(202).json({
                        success: true,
                        message: `"${albumTitle}" is already downloading`,
                        jobId: racedJob.id,
                        duplicate: true,
                    });
                }
            }
            throw error;
        }

        const result = await simpleDownloadManager.startDownload(
            job.id,
            artistName,
            albumTitle,
            albumMbid,
            userId
        );

        if (!result.success) {
            return res.status(502).json({
                error: result.error || "Failed to queue download in Lidarr",
                jobId: job.id,
            });
        }

        res.status(202).json({
            success: true,
            message: `Queued "${albumTitle}" for download`,
            jobId: job.id,
        });
    } catch (error: any) {
        logger.error("[Releases] Download error:", error.message);
        res.status(500).json({ error: "Failed to start download" });
    }
});

export default router;

