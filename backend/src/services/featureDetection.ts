import { existsSync } from "fs";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getClapStats } from "./audioMuseService";

// Analyzer script paths in the Docker image
const ESSENTIA_ANALYZER_PATH = "/app/audio-analyzer/analyzer.py";

export interface AvailableFeatures {
    musicCNN: boolean;
    /** Natural-language vibe search and sonic similarity, served by AudioMuse-AI. */
    vibeEmbeddings: boolean;
}

const HEARTBEAT_TTL = 300000; // 5 minutes
const CACHE_TTL = 60000; // 60 seconds
// Kept well under the 10s service default: this probe runs on app load, so a
// slow or absent AudioMuse must not hold up the whole feature payload.
const VIBE_PROBE_TIMEOUT = 4000;

class FeatureDetectionService {
    private cache: AvailableFeatures | null = null;
    private lastCheck: number = 0;

    async getFeatures(): Promise<AvailableFeatures> {
        const now = Date.now();
        if (this.cache && now - this.lastCheck < CACHE_TTL) {
            return this.cache;
        }

        const [musicCNN, vibeEmbeddings] = await Promise.all([
            this.checkMusicCNN(),
            this.checkVibeSearch(),
        ]);

        this.cache = { musicCNN, vibeEmbeddings };
        this.lastCheck = now;

        logger.debug(
            `[FEATURE-DETECTION] Features: musicCNN=${musicCNN}, vibeEmbeddings=${vibeEmbeddings}`
        );

        return this.cache;
    }

    private async checkMusicCNN(): Promise<boolean> {
        try {
            // Analyzer script bundled in image = feature is available
            if (existsSync(ESSENTIA_ANALYZER_PATH)) {
                return true;
            }

            const heartbeat = await redisClient.get("audio:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                if (!isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL) {
                    return true;
                }
            }

            const trackWithEnergy = await prisma.track.findFirst({
                where: { energy: { not: null } },
                select: { id: true },
            });
            return trackWithEnergy !== null;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking MusicCNN:", error);
            return false;
        }
    }

    /**
     * Vibe search and sonic similarity are served by AudioMuse-AI, so the feature
     * is available only when AudioMuse is reachable, has CLAP enabled, and has
     * actually embedded something. The old check passed as soon as an analyzer
     * script existed on disk, which advertised a working feature over an empty
     * index — the surfaces then rendered and returned nothing.
     */
    private async checkVibeSearch(): Promise<boolean> {
        try {
            const { stats } = await getClapStats(VIBE_PROBE_TIMEOUT);
            return Boolean(stats?.clapEnabled && stats.numEmbeddings > 0);
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking vibe search:", error);
            return false;
        }
    }

    invalidateCache(): void {
        this.cache = null;
        this.lastCheck = 0;
    }
}

export const featureDetection = new FeatureDetectionService();
