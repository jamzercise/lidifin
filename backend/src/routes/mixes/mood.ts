import type { Router } from "express";
import { logger } from "../../utils/logger";
import { requireAdmin } from "../../middleware/auth";
import { programmaticPlaylistService } from "../../services/programmaticPlaylists";
import {
    moodBucketService,
    VALID_MOODS,
    MoodType,
} from "../../services/moodBucketService";
import { loadOrderedMixTracks } from "../../services/mixes/loadMixTrackDetails";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { getRequestUserId } from "./helpers";

/** Mood on-demand, presets, buckets, preferences, admin backfill */
export function registerMixMoodRoutes(router: Router): void {
    router.post("/mood", async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }

            const params = req.body;

            // Validate parameters
            const validKeys = [
                // Basic audio features
                "valence",
                "energy",
                "danceability",
                "acousticness",
                "instrumentalness",
                "arousal",
                "bpm",
                "keyScale",
                // ML mood predictions
                "moodHappy",
                "moodSad",
                "moodRelaxed",
                "moodAggressive",
                "moodParty",
                "moodAcoustic",
                "moodElectronic",
                // Other
                "limit",
            ];
            for (const key of Object.keys(params)) {
                if (!validKeys.includes(key)) {
                    return res
                        .status(400)
                        .json({ error: `Invalid parameter: ${key}` });
                }
            }

            const mix = await programmaticPlaylistService.generateMoodOnDemand(
                userId,
                params,
            );

            if (!mix) {
                return res.status(400).json({
                    error: "Not enough tracks matching your criteria",
                    suggestion:
                        "Try widening your parameters or wait for more tracks to be analyzed",
                });
            }

            // Load full track details (native Track rows and/or jellyfin ids)
            const orderedTracks = await loadOrderedMixTracks(mix.trackIds);

            logger.debug(
                `[MIXES] Generated mood-on-demand mix with ${mix.trackCount} tracks`,
            );

            res.json({
                ...mix,
                tracks: orderedTracks,
            });
        } catch (error) {
            logger.error("Generate mood mix error:", error);
            res.status(500).json({ error: "Failed to generate mood mix" });
        }
    });

    /**
     * Available mood presets for the UI
     */
    router.get("/mood/presets", async (req, res) => {
        // Presets use ML mood predictions for more accurate matching
        // These mirror the logic used in programmatic mixes (Chill Mix, Party Mix, etc.)
        const presets = [
            {
                id: "happy",
                name: "Happy & Upbeat",
                color: "from-yellow-400 to-orange-500",
                params: {
                    moodHappy: { min: 0.5 },
                    moodSad: { max: 0.4 },
                    energy: { min: 0.4 },
                },
            },
            {
                id: "sad",
                name: "Melancholic",
                color: "from-blue-600 to-indigo-700",
                params: {
                    moodSad: { min: 0.5 },
                    moodHappy: { max: 0.4 },
                    keyScale: "minor",
                },
            },
            {
                id: "chill",
                name: "Chill & Relaxed",
                color: "from-teal-400 to-cyan-500",
                params: {
                    moodRelaxed: { min: 0.5 },
                    moodAggressive: { max: 0.3 },
                    energy: { max: 0.55 },
                },
            },
            {
                id: "energetic",
                name: "High Energy",
                color: "from-red-500 to-orange-600",
                params: {
                    arousal: { min: 0.6 },
                    energy: { min: 0.65 },
                    moodRelaxed: { max: 0.4 },
                },
            },
            {
                id: "focus",
                name: "Focus Mode",
                color: "from-purple-600 to-violet-700",
                params: {
                    instrumentalness: { min: 0.5 },
                    moodRelaxed: { min: 0.3 },
                    energy: { min: 0.2, max: 0.6 },
                },
            },
            {
                id: "dance",
                name: "Dance Party",
                color: "from-pink-500 to-rose-600",
                params: {
                    moodParty: { min: 0.5 },
                    danceability: { min: 0.6 },
                    energy: { min: 0.5 },
                },
            },
            {
                id: "acoustic",
                name: "Acoustic Vibes",
                color: "from-amber-500 to-yellow-600",
                params: {
                    moodAcoustic: { min: 0.5 },
                    moodElectronic: { max: 0.4 },
                },
            },
            {
                id: "dark",
                name: "Dark & Moody",
                color: "from-gray-700 to-slate-800",
                params: {
                    moodAggressive: { min: 0.4 },
                    moodHappy: { max: 0.4 },
                    keyScale: "minor",
                },
            },
            {
                id: "romantic",
                name: "Romantic",
                color: "from-rose-500 to-pink-600",
                params: {
                    moodRelaxed: { min: 0.3 },
                    moodAggressive: { max: 0.3 },
                    acousticness: { min: 0.3 },
                    energy: { max: 0.6 },
                },
            },
            {
                id: "workout",
                name: "Workout Beast",
                color: "from-green-500 to-emerald-600",
                params: {
                    arousal: { min: 0.6 },
                    energy: { min: 0.7 },
                    moodRelaxed: { max: 0.4 },
                    bpm: { min: 110 },
                },
            },
            {
                id: "sleepy",
                name: "Sleep & Unwind",
                color: "from-indigo-400 to-purple-500",
                params: {
                    moodRelaxed: { min: 0.5 },
                    energy: { max: 0.35 },
                    moodAggressive: { max: 0.2 },
                },
            },
            {
                id: "confident",
                name: "Confidence Boost",
                color: "from-amber-400 to-orange-500",
                params: {
                    moodHappy: { min: 0.4 },
                    moodParty: { min: 0.3 },
                    energy: { min: 0.5 },
                    danceability: { min: 0.5 },
                },
            },
        ];

        res.json(presets);
    });

    /**
     * Save user's mood mix preferences
     * These preferences are used to generate "Your Mood Mix" in the mix rotation
     */
    router.post("/mood/save-preferences", async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }

            const params = req.body;

            // Validate that at least some params are provided
            if (!params || Object.keys(params).length === 0) {
                return res
                    .status(400)
                    .json({ error: "No mood parameters provided" });
            }

            // Save to user record
            await prisma.user.update({
                where: { id: userId },
                data: { moodMixParams: params },
            });

            // Invalidate mix cache so the new mood mix appears
            const cacheKey = `mixes:${userId}`;
            await redisClient.del(cacheKey);

            logger.debug(
                `[MIXES] Saved mood mix preferences for user ${userId}`,
            );

            res.json({ success: true, message: "Mood preferences saved" });
        } catch (error) {
            logger.error("Save mood preferences error:", error);
            res.status(500).json({ error: "Failed to save mood preferences" });
        }
    });

    /**
     * @openapi
     * /mixes/mood/buckets/presets:
     *   get:
     *     summary: Get mood presets with track counts
     *     description: Returns available mood categories with how many tracks are available for each
     *     tags: [Mixes]
     *     security:
     *       - sessionAuth: []
     *       - apiKeyAuth: []
     *     responses:
     *       200:
     *         description: List of mood presets with track counts
     */
    router.get("/mood/buckets/presets", async (req, res) => {
        try {
            const presets = await moodBucketService.getMoodPresets();
            res.json(presets);
        } catch (error) {
            logger.error("Get mood presets error:", error);
            res.status(500).json({ error: "Failed to get mood presets" });
        }
    });

    /**
     * @openapi
     * /mixes/mood/buckets/{mood}:
     *   get:
     *     summary: Get a mood mix for a specific mood
     *     description: Fast lookup from pre-computed mood bucket table
     *     tags: [Mixes]
     *     security:
     *       - sessionAuth: []
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: path
     *         name: mood
     *         required: true
     *         schema:
     *           type: string
     *           enum: [happy, sad, chill, energetic, party, focus, melancholy, aggressive, acoustic]
     *         description: Mood category
     *     responses:
     *       200:
     *         description: Mood mix with track details
     *       400:
     *         description: Invalid mood or not enough tracks
     */
    router.get("/mood/buckets/:mood", async (req, res) => {
        try {
            const mood = req.params.mood as MoodType;

            if (!VALID_MOODS.includes(mood)) {
                return res.status(400).json({
                    error: `Invalid mood: ${mood}`,
                    validMoods: VALID_MOODS,
                });
            }

            const mix = await moodBucketService.getMoodMix(mood);

            if (!mix) {
                return res.status(400).json({
                    error: `Not enough tracks for mood: ${mood}`,
                    suggestion: "Wait for more tracks to be analyzed",
                });
            }

            const orderedTracks = await loadOrderedMixTracks(mix.trackIds);

            res.json({
                ...mix,
                tracks: orderedTracks,
            });
        } catch (error) {
            logger.error("Get mood bucket mix error:", error);
            res.status(500).json({ error: "Failed to get mood mix" });
        }
    });

    /**
     * @openapi
     * /mixes/mood/buckets/{mood}/save:
     *   post:
     *     summary: Save a mood as user's active mood mix
     *     description: Generates a mix for the mood and saves it as the user's "Your X Mix" on the home page
     *     tags: [Mixes]
     *     security:
     *       - sessionAuth: []
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: path
     *         name: mood
     *         required: true
     *         schema:
     *           type: string
     *           enum: [happy, sad, chill, energetic, party, focus, melancholy, aggressive, acoustic]
     *     responses:
     *       200:
     *         description: Mood mix saved and returned for immediate playback
     *       400:
     *         description: Invalid mood or not enough tracks
     */
    router.post("/mood/buckets/:mood/save", async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }

            const mood = req.params.mood as MoodType;

            if (!VALID_MOODS.includes(mood)) {
                return res.status(400).json({
                    error: `Invalid mood: ${mood}`,
                    validMoods: VALID_MOODS,
                });
            }

            const savedMix = await moodBucketService.saveUserMoodMix(
                userId,
                mood,
            );

            if (!savedMix) {
                return res.status(400).json({
                    error: `Not enough tracks for mood: ${mood}`,
                    suggestion: "Wait for more tracks to be analyzed",
                });
            }

            // Invalidate mixes cache so home page refetches
            const cacheKey = `mixes:${userId}`;
            await redisClient.del(cacheKey);

            const orderedTracks = await loadOrderedMixTracks(savedMix.trackIds);

            logger.debug(
                `[MIXES] Saved mood bucket mix for user ${userId}: ${mood} (${savedMix.trackCount} tracks)`,
            );

            res.json({
                success: true,
                mix: {
                    ...savedMix,
                    tracks: orderedTracks,
                },
            });
        } catch (error) {
            logger.error("Save mood bucket mix error:", error);
            res.status(500).json({ error: "Failed to save mood mix" });
        }
    });

    /**
     * @openapi
     * /mixes/mood/buckets/backfill:
     *   post:
     *     summary: Backfill mood buckets for all analyzed tracks
     *     description: Admin endpoint to populate mood buckets for existing tracks
     *     tags: [Mixes]
     *     security:
     *       - sessionAuth: []
     *       - apiKeyAuth: []
     *     responses:
     *       200:
     *         description: Backfill completed
     */
    router.post("/mood/buckets/backfill", requireAdmin, async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }

            logger.debug(
                `[MIXES] Starting mood bucket backfill requested by user ${userId}`,
            );

            const result = await moodBucketService.backfillAllTracks();

            res.json({
                success: true,
                processed: result.processed,
                assigned: result.assigned,
            });
        } catch (error) {
            logger.error("Backfill mood buckets error:", error);
            res.status(500).json({ error: "Failed to backfill mood buckets" });
        }
    });
}
