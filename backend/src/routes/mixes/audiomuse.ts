import type { Router } from "express";
import { logger } from "../../utils/logger";
import {
    moodBucketService,
    VALID_MOODS,
    MoodType,
} from "../../services/moodBucketService";
import {
    generateInstantPlaylist,
    MOOD_TO_PROMPT,
    getSimilarTracks,
    getSimilarArtists,
    getArtistTracks,
    runAlchemy,
    createPlaylistViaAudioMuse,
} from "../../services/audioMuseService";
import { getJellyfinConfig } from "../../services/jellyfin";
import { resolveTrackReferences } from "../../services/jellyfin";
import { resolveAndFormatTracks } from "./helpers";

export function registerMixAudiomuseRoutes(router: Router): void {
    router.post("/audiomuse/instant", async (req, res) => {
        try {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res.status(400).json({
                    error: "Jellyfin must be configured to use AudioMuse-AI",
                });
            }

            const { userInput, mood } = req.body as {
                userInput?: string;
                mood?: MoodType;
            };

            const prompt =
                mood && VALID_MOODS.includes(mood)
                    ? MOOD_TO_PROMPT[mood] || mood
                    : typeof userInput === "string" && userInput.trim()
                      ? userInput.trim()
                      : null;

            if (!prompt) {
                return res.status(400).json({
                    error: "Provide userInput or mood",
                });
            }

            const result = await generateInstantPlaylist(prompt);

            if (result.error) {
                return res.status(400).json({
                    error: result.error,
                });
            }

            if (result.itemIds.length === 0) {
                return res.status(200).json({
                    tracks: [],
                    message: "No tracks found for this request",
                });
            }

            const trackIds = result.itemIds.map((id) => `jellyfin:${id}`);
            const resolved = await resolveTrackReferences(trackIds);

            const tracks = resolved
                .map((t) =>
                    t
                        ? {
                              id: t.id,
                              title: t.title,
                              duration: t.duration,
                              artist: t.artist,
                              album: {
                                  id: t.album.id,
                                  title: t.album.title,
                                  coverUrl: t.album.coverArt,
                                  coverArt: t.album.coverArt,
                              },
                          }
                        : null,
                )
                .filter(Boolean);

            res.json({
                tracks,
                totalCount: tracks.length,
            });
        } catch (error) {
            logger.error("AudioMuse instant playlist error:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    error: "Failed to generate instant playlist",
                });
            }
        }
    });

    /**
     * POST /mixes/audiomuse/test
     * Test AudioMuse-AI connection with a URL (from form, before save).
     * Allows testing with current form values without saving first.
     */
    router.post("/audiomuse/test", async (req, res) => {
        try {
            const { url } = req.body as { url?: string };
            const testUrl = (url || "").trim().replace(/\/$/, "");
            if (!testUrl) {
                return res.status(400).json({
                    enabled: false,
                    available: false,
                    message: "URL is required",
                });
            }
            try {
                const axios = (await import("axios")).default;
                await axios.get(`${testUrl}/`, { timeout: 5000 });
                return res.json({
                    enabled: true,
                    available: true,
                    message: "Connected",
                });
            } catch {
                return res.json({
                    enabled: true,
                    available: false,
                    message: "URL provided but instance not reachable",
                });
            }
        } catch (error) {
            logger.error("AudioMuse test error:", error);
            res.status(500).json({
                error: "Failed to test AudioMuse connection",
            });
        }
    });

    /**
     * GET /mixes/audiomuse/status
     * Check if AudioMuse-AI is configured and available.
     */
    router.get("/audiomuse/status", async (req, res) => {
        try {
            const { getAudioMuseConfig } =
                await import("../../services/audioMuseService");
            const config = await getAudioMuseConfig();
            if (!config) {
                return res.json({
                    enabled: false,
                    available: false,
                    message: "AudioMuse-AI is not configured",
                });
            }

            try {
                const axios = (await import("axios")).default;
                await axios.get(`${config.url}/`, { timeout: 5000 });
                return res.json({
                    enabled: true,
                    available: true,
                    aiProvider: config.aiProvider || "OLLAMA",
                });
            } catch {
                return res.json({
                    enabled: true,
                    available: false,
                    message: "AudioMuse-AI is configured but not reachable",
                });
            }
        } catch (error) {
            logger.error("AudioMuse status error:", error);
            res.status(500).json({ error: "Failed to check AudioMuse status" });
        }
    });

    /**
     * GET /mixes/audiomuse/similar-tracks?trackId=...
     * Playlist from Similar Song
     */
    router.get("/audiomuse/similar-tracks", async (req, res) => {
        try {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res
                    .status(400)
                    .json({ error: "Jellyfin must be configured" });
            }

            const trackId = req.query.trackId as string;
            const n = Math.min(
                Math.max(1, parseInt(req.query.n as string) || 20),
                100,
            );

            if (!trackId || !trackId.startsWith("jellyfin:")) {
                return res
                    .status(400)
                    .json({ error: "trackId (jellyfin:xxx) required" });
            }

            const result = await getSimilarTracks(trackId, n);
            if (result.error) {
                return res.status(400).json({ error: result.error });
            }
            if (result.tracks.length === 0) {
                return res.json({ tracks: [], totalCount: 0 });
            }

            const formatted = await resolveAndFormatTracks(
                result.tracks.map((t) => t.itemId),
            );
            res.json({ tracks: formatted, totalCount: formatted.length });
        } catch (error) {
            logger.error("AudioMuse similar-tracks error:", error);
            res.status(500).json({ error: "Failed to get similar tracks" });
        }
    });

    /**
     * GET /mixes/audiomuse/similar-artists?artistId=... or ?artist=...
     * Artist Similarity
     */
    router.get("/audiomuse/similar-artists", async (req, res) => {
        try {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res
                    .status(400)
                    .json({ error: "Jellyfin must be configured" });
            }

            const artistId = req.query.artistId as string;
            const artist = req.query.artist as string;
            const n = Math.min(
                Math.max(1, parseInt(req.query.n as string) || 10),
                50,
            );

            const query = artistId || artist;
            if (!query) {
                return res
                    .status(400)
                    .json({ error: "artistId or artist required" });
            }

            const result = await getSimilarArtists(query, n);
            if (result.error) {
                return res.status(400).json({ error: result.error });
            }

            res.json({
                artists: result.artists.map((a) => ({
                    id: a.artistId ? `jellyfin:${a.artistId}` : null,
                    name: a.artist,
                    divergence: a.divergence,
                })),
            });
        } catch (error) {
            logger.error("AudioMuse similar-artists error:", error);
            res.status(500).json({ error: "Failed to get similar artists" });
        }
    });

    /**
     * GET /mixes/audiomuse/artist-tracks?artistId=... or ?artist=...
     * Get tracks by artist (for building playlists from similar artists)
     */
    router.get("/audiomuse/artist-tracks", async (req, res) => {
        try {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res
                    .status(400)
                    .json({ error: "Jellyfin must be configured" });
            }

            const artistId = req.query.artistId as string;
            const artist = req.query.artist as string;
            const query = artistId || artist;
            if (!query) {
                return res
                    .status(400)
                    .json({ error: "artistId or artist required" });
            }

            const result = await getArtistTracks(query);
            if (result.error) {
                return res.status(400).json({ error: result.error });
            }
            if (result.tracks.length === 0) {
                return res.json({ tracks: [], totalCount: 0 });
            }

            const formatted = await resolveAndFormatTracks(
                result.tracks.map((t) => t.itemId),
            );
            res.json({ tracks: formatted, totalCount: formatted.length });
        } catch (error) {
            logger.error("AudioMuse artist-tracks error:", error);
            res.status(500).json({ error: "Failed to get artist tracks" });
        }
    });

    /**
     * POST /mixes/audiomuse/alchemy
     * Song Alchemy: ADD/SUBTRACT items to get curated playlist
     * Body: { items: [{ id, op: "ADD"|"SUBTRACT", type: "song"|"artist" }], n?: number }
     */
    router.post("/audiomuse/alchemy", async (req, res) => {
        try {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res
                    .status(400)
                    .json({ error: "Jellyfin must be configured" });
            }

            const { items, n } = req.body as {
                items?: { id: string; op: string; type?: string }[];
                n?: number;
            };

            if (!Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ error: "items array required" });
            }

            const alchemyItems = items.map((i) => ({
                id: i.id,
                op: (i.op?.toUpperCase() === "SUBTRACT"
                    ? "SUBTRACT"
                    : "ADD") as "ADD" | "SUBTRACT",
                type: (i.type === "artist" ? "artist" : "song") as
                    | "song"
                    | "artist",
            }));

            const result = await runAlchemy(
                alchemyItems,
                Math.min(n ?? 100, 200),
            );
            if (result.error) {
                return res.status(400).json({ error: result.error });
            }
            if (result.itemIds.length === 0) {
                return res.json({ tracks: [], totalCount: 0 });
            }

            const formatted = await resolveAndFormatTracks(result.itemIds);
            res.json({ tracks: formatted, totalCount: formatted.length });
        } catch (error) {
            logger.error("AudioMuse alchemy error:", error);
            res.status(500).json({ error: "Failed to run Song Alchemy" });
        }
    });

    /**
     * POST /mixes/audiomuse/save-playlist
     * Save a generated playlist to Jellyfin via AudioMuse-AI
     * Body: { name: string, trackIds: string[] }
     */
    router.post("/audiomuse/save-playlist", async (req, res) => {
        try {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res
                    .status(400)
                    .json({ error: "Jellyfin must be configured" });
            }

            const { name, trackIds } = req.body as {
                name?: string;
                trackIds?: string[];
            };
            if (
                !name?.trim() ||
                !Array.isArray(trackIds) ||
                trackIds.length === 0
            ) {
                return res
                    .status(400)
                    .json({ error: "name and trackIds required" });
            }

            const result = await createPlaylistViaAudioMuse(
                name.trim(),
                trackIds,
            );
            if (!result.success) {
                return res.status(400).json({ error: result.error });
            }

            res.json({ success: true, playlistId: result.playlistId });
        } catch (error) {
            logger.error("AudioMuse save-playlist error:", error);
            res.status(500).json({ error: "Failed to save playlist" });
        }
    });
}
