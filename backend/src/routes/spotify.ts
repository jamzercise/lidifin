import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { z } from "zod";
import { spotifyService } from "../services/spotify";
import {
    spotifyImportService,
    type ImportPreview,
    type TrackEdit,
} from "../services/spotifyImport";
import { deezerService } from "../services/deezer";
import { youtubeMusicService } from "../services/youtubeMusic";
import { readSessionLog, getSessionLogPath } from "../utils/playlistLogger";

const router = Router();

// All routes require authentication
router.use(requireAuthOrToken);

// Validation schemas
const parseUrlSchema = z.object({
    url: z.string().url(),
});

/**
 * A user correction to one track, keyed by the source track id. Capped in count
 * and length because it is applied to a playlist we re-fetch server side.
 */
const trackEditSchema = z.object({
    spotifyId: z.string().min(1).max(200),
    artist: z.string().trim().max(300).optional(),
    title: z.string().trim().max(300).optional(),
    album: z.string().trim().max(300).optional(),
});

const trackEditsSchema = z.array(trackEditSchema).max(2000).optional();

const previewSchema = z.object({
    url: z.string().url(),
    trackEdits: trackEditsSchema,
});

const importSchema = z.object({
    spotifyPlaylistId: z.string(),
    url: z.string().url().optional(),
    playlistName: z.string().min(1).max(200),
    albumMbidsToDownload: z.array(z.string()),
    trackEdits: trackEditsSchema,
});

/** Omitting the ids means "skip everything still in flight". */
const skipDownloadsSchema = z.object({
    downloadJobIds: z.array(z.string()).max(500).optional(),
});

type PreviewOutcome =
    | { ok: true; preview: ImportPreview }
    | { ok: false; status: number; error: string };

/**
 * Fetch a playlist from whichever service the URL points at and build the
 * preview. Shared by /preview and /import so the import can't drift from what
 * the user was shown — in particular so both apply the same corrections.
 */
async function buildPreviewForUrl(
    url: string,
    trackEdits?: TrackEdit[]
): Promise<PreviewOutcome> {
    if (url.includes("deezer.com")) {
        const deezerMatch = url.match(/playlist[\/:](\d+)/);
        if (!deezerMatch) {
            return {
                ok: false,
                status: 400,
                error: "Invalid Deezer playlist URL",
            };
        }
        const deezerPlaylist = await deezerService.getPlaylist(deezerMatch[1]);
        if (!deezerPlaylist) {
            return {
                ok: false,
                status: 404,
                error: "Deezer playlist not found",
            };
        }
        return {
            ok: true,
            preview: await spotifyImportService.generatePreviewFromDeezer(
                deezerPlaylist,
                trackEdits
            ),
        };
    }

    const ytParsed = youtubeMusicService.parseUrl(url);
    if (ytParsed?.type === "playlist") {
        const ytPlaylist = await youtubeMusicService.getPlaylist(ytParsed.id);
        if (!ytPlaylist) {
            return {
                ok: false,
                status: 502,
                error: "Could not fetch YouTube Music playlist. Ensure yt-dlp is installed (e.g. pip install yt-dlp) and the playlist is public.",
            };
        }
        return {
            ok: true,
            preview: await spotifyImportService.generatePreviewFromYouTubeMusic(
                ytPlaylist,
                trackEdits
            ),
        };
    }

    return {
        ok: true,
        preview: await spotifyImportService.generatePreview(url, trackEdits),
    };
}

/**
 * POST /api/spotify/parse
 * Parse a Spotify URL and return basic info
 */
router.post("/parse", async (req, res) => {
    try {
        const { url } = parseUrlSchema.parse(req.body);

        const parsed = spotifyService.parseUrl(url);
        if (!parsed) {
            return res.status(400).json({
                error: "Invalid Spotify URL. Please provide a valid playlist URL.",
            });
        }

        // For now, only support playlists
        if (parsed.type !== "playlist") {
            return res.status(400).json({
                error: `Only playlist imports are supported. Got: ${parsed.type}`,
            });
        }

        res.json({
            type: parsed.type,
            id: parsed.id,
            url: `https://open.spotify.com/playlist/${parsed.id}`,
        });
    } catch (error: any) {
        logger.error("Spotify parse error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        res.status(500).json({ error: error.message || "Failed to parse URL" });
    }
});

/**
 * POST /api/spotify/preview
 * Generate a preview of what will be imported from a Spotify or Deezer playlist
 */
router.post("/preview", async (req, res) => {
    try {
        const { url, trackEdits } = previewSchema.parse(req.body);

        logger.debug(`[Playlist Import] Generating preview for: ${url}`);

        const outcome = await buildPreviewForUrl(url, trackEdits);
        if (!outcome.ok) {
            return res.status(outcome.status).json({ error: outcome.error });
        }

        logger.debug(
            `[Playlist Import] Preview generated: ${outcome.preview.summary.total} tracks, ${outcome.preview.summary.inLibrary} in library`
        );
        res.json(outcome.preview);
    } catch (error: any) {
        logger.error("Playlist preview error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        // MusicBrainz (used for matching tracks) returns 503 when rate-limited
        const isRateLimit =
            error.response?.status === 503 ||
            error.response?.status === 429 ||
            (error.response?.data?.error && String(error.response.data.error).toLowerCase().includes("rate limit"));
        if (isRateLimit) {
            return res.status(503).json({
                error:
                    "MusicBrainz is temporarily rate-limiting lookup requests. Please wait a minute and try again.",
            });
        }
        res.status(500).json({
            error: error.message || "Failed to generate preview",
        });
    }
});

/**
 * POST /api/spotify/import
 * Start importing a Spotify playlist
 */
router.post("/import", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const {
            spotifyPlaylistId,
            url,
            playlistName,
            albumMbidsToDownload,
            trackEdits,
        } = importSchema.parse(req.body);
        const userId = req.user.id;

        // Re-generate preview to ensure fresh data
        const effectiveUrl =
            url?.trim() ||
            `https://open.spotify.com/playlist/${spotifyPlaylistId}`;

        const outcome = await buildPreviewForUrl(effectiveUrl, trackEdits);
        if (!outcome.ok) {
            return res.status(outcome.status).json({ error: outcome.error });
        }
        const preview = outcome.preview;

        logger.debug(
            `[Spotify Import] Starting import for user ${userId}: ${playlistName}`
        );
        logger.debug(
            `[Spotify Import] Downloading ${albumMbidsToDownload.length} albums`
        );

        const job = await spotifyImportService.startImport(
            userId,
            spotifyPlaylistId,
            playlistName,
            albumMbidsToDownload,
            preview
        );

        res.json({
            jobId: job.id,
            status: job.status,
            message: "Import started",
        });
    } catch (error: any) {
        logger.error("Spotify import error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        res.status(500).json({
            error: error.message || "Failed to start import",
        });
    }
});

/**
 * GET /api/spotify/import/:jobId/status
 * Get the status of an import job
 */
router.get("/import/:jobId/status", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const { jobId } = req.params;
        const userId = req.user.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to view this job" });
        }

        res.json(job);
    } catch (error: any) {
        logger.error("Spotify job status error:", error);
        res.status(500).json({
            error: error.message || "Failed to get job status",
        });
    }
});

/**
 * GET /api/spotify/import/:jobId/tracks
 * Per-track state for one import, so a stalled track is visible instead of
 * being hidden behind an overall percentage.
 */
router.get("/import/:jobId/tracks", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const { jobId } = req.params;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }
        if (job.userId !== req.user.id) {
            return res
                .status(403)
                .json({ error: "Not authorized to view this job" });
        }

        const detail = await spotifyImportService.getJobTracks(jobId);
        if (!detail) {
            return res.status(404).json({ error: "Import job not found" });
        }

        res.json({
            jobId: job.id,
            status: job.status,
            playlistName: job.playlistName,
            createdPlaylistId: job.createdPlaylistId,
            progress: job.progress,
            error: job.error,
            ...detail,
        });
    } catch (error: any) {
        logger.error("Spotify import tracks error:", error);
        res.status(500).json({
            error: error.message || "Failed to get import tracks",
        });
    }
});

/**
 * POST /api/spotify/import/:jobId/skip-downloads
 * Give up on downloads the import is waiting for so it can finish with what it
 * has. Body may name specific downloads; by default every in-flight one goes.
 */
router.post("/import/:jobId/skip-downloads", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const { jobId } = req.params;
        const { downloadJobIds } = skipDownloadsSchema.parse(req.body ?? {});

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }
        if (job.userId !== req.user.id) {
            return res
                .status(403)
                .json({ error: "Not authorized to modify this job" });
        }

        let idsToSkip = downloadJobIds;
        if (!idsToSkip || idsToSkip.length === 0) {
            const detail = await spotifyImportService.getJobTracks(jobId);
            idsToSkip = detail?.skippableDownloadIds ?? [];
        }

        const { skipped } = await spotifyImportService.skipDownloads(
            jobId,
            idsToSkip
        );

        res.json({
            skipped,
            message:
                skipped > 0
                    ? `Skipped ${skipped} download${skipped === 1 ? "" : "s"}`
                    : "Nothing left to skip",
        });
    } catch (error: any) {
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        logger.error("Spotify skip downloads error:", error);
        res.status(500).json({
            error: error.message || "Failed to skip downloads",
        });
    }
});

/**
 * GET /api/spotify/imports/active
 * In-flight imports for the current user, so the UI can pick an import back up
 * after a refresh or a navigation away from the import page.
 */
router.get("/imports/active", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const jobs = await spotifyImportService.getActiveJobs(req.user.id);
        res.json(jobs);
    } catch (error: any) {
        logger.error("Spotify active imports error:", error);
        res.status(500).json({
            error: error.message || "Failed to get active imports",
        });
    }
});

/**
 * GET /api/spotify/imports/recent
 * Recent imports, running and finished, so progress and history can be shown
 * together where the user starts imports rather than only in the Activity panel.
 */
router.get("/imports/recent", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const limit = Number.parseInt(String(req.query.limit ?? "20"), 10);
        const jobs = await spotifyImportService.getRecentJobs(
            req.user.id,
            Number.isFinite(limit) ? limit : 20
        );
        res.json(jobs);
    } catch (error: any) {
        logger.error("Spotify recent imports error:", error);
        res.status(500).json({
            error: error.message || "Failed to get recent imports",
        });
    }
});

/**
 * GET /api/spotify/imports
 * Get all import jobs for the current user
 */
router.get("/imports", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const jobs = await spotifyImportService.getUserJobs(userId);
        res.json(jobs);
    } catch (error: any) {
        logger.error("Spotify imports error:", error);
        res.status(500).json({
            error: error.message || "Failed to get imports",
        });
    }
});

/**
 * POST /api/spotify/import/:jobId/refresh
 * Re-match pending tracks and add newly downloaded ones to the playlist
 */
router.post("/import/:jobId/refresh", async (req, res) => {
    try {
        const { jobId } = req.params;
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        const userId = req.user.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to refresh this job" });
        }

        const result = await spotifyImportService.refreshJobMatches(jobId);

        res.json({
            message:
                result.added > 0
                    ? `Added ${result.added} newly downloaded track(s)`
                    : "No new tracks found yet. Albums may still be downloading.",
            added: result.added,
            total: result.total,
        });
    } catch (error: any) {
        logger.error("Spotify refresh error:", error);
        res.status(500).json({
            error: error.message || "Failed to refresh tracks",
        });
    }
});

/**
 * POST /api/spotify/import/:jobId/cancel
 * Cancel an import job and create playlist with whatever succeeded
 */
router.post("/import/:jobId/cancel", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to cancel this job" });
        }

        const result = await spotifyImportService.cancelJob(jobId);

        res.json({
            message: result.playlistCreated
                ? `Import cancelled. Playlist created with ${result.tracksMatched} track(s).`
                : "Import cancelled. No tracks were downloaded.",
            playlistId: result.playlistId,
            tracksMatched: result.tracksMatched,
        });
    } catch (error: any) {
        logger.error("Spotify cancel error:", error);
        res.status(500).json({
            error: error.message || "Failed to cancel import",
        });
    }
});

/**
 * GET /api/spotify/import/session-log
 * Get the current session log for debugging import issues
 */
router.get("/import/session-log", async (req, res) => {
    try {
        const log = readSessionLog();
        const logPath = getSessionLogPath();

        res.json({
            path: logPath,
            content: log,
        });
    } catch (error: any) {
        logger.error("Session log error:", error);
        res.status(500).json({
            error: error.message || "Failed to read session log",
        });
    }
});

export default router;
