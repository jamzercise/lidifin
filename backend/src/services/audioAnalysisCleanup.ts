import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { enrichmentFailureService } from "./enrichmentFailureService";

const STALE_THRESHOLD_MINUTES = 15;
const MAX_RETRIES = 3;
const CIRCUIT_BREAKER_THRESHOLD = 30;
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;

async function cleanupStaleJellyfinAnalysisRows(cutoff: Date): Promise<{
    reset: number;
    permanent: number;
}> {
    const stale = await prisma.jellyfinTrackAnalysis.findMany({
        where: {
            analysisStatus: "processing",
            OR: [
                { analysisStartedAt: { lt: cutoff } },
                { analysisStartedAt: null, updatedAt: { lt: cutoff } },
            ],
        },
    });
    let reset = 0;
    let permanent = 0;
    for (const row of stale) {
        const rc = row.analysisRetryCount ?? 0;
        if (rc + 1 >= MAX_RETRIES) {
            await prisma.jellyfinTrackAnalysis.update({
                where: { jellyfinTrackId: row.jellyfinTrackId },
                data: {
                    analysisStatus: "failed",
                    analysisError: `Stale processing exceeded ${MAX_RETRIES} retries`,
                    analysisRetryCount: rc + 1,
                    analysisStartedAt: null,
                },
            });
            permanent++;
        } else {
            await prisma.jellyfinTrackAnalysis.update({
                where: { jellyfinTrackId: row.jellyfinTrackId },
                data: {
                    analysisStatus: "pending",
                    analysisStartedAt: null,
                    analysisRetryCount: rc + 1,
                    analysisError: "Reset after stale processing",
                },
            });
            reset++;
        }
    }
    if (reset > 0 || permanent > 0) {
        logger.debug(
            `[AudioAnalysisCleanup] JellyfinTrackAnalysis stale: ${reset} reset, ${permanent} permanent fail`
        );
    }
    return { reset, permanent };
}

type CircuitState = "closed" | "open" | "half-open";

class AudioAnalysisCleanupService {
    private state: CircuitState = "closed";
    private failureCount = 0;
    private lastFailureTime: Date | null = null;

    private shouldAttemptReset(): boolean {
        if (!this.lastFailureTime) return false;
        const timeSinceFailure = Date.now() - this.lastFailureTime.getTime();
        return timeSinceFailure >= CIRCUIT_BREAKER_WINDOW_MS;
    }

    private onSuccess(): void {
        if (this.state === "half-open") {
            logger.info(
                `[AudioAnalysisCleanup] Circuit breaker CLOSED - recovery successful after ${this.failureCount} failures`
            );
            this.state = "closed";
            this.failureCount = 0;
            this.lastFailureTime = null;
        } else if (this.state === "closed" && this.failureCount > 0) {
            logger.debug(
                "[AudioAnalysisCleanup] Resetting failure counter on success"
            );
            this.failureCount = 0;
            this.lastFailureTime = null;
        }
    }

    private onFailure(
        resetCount: number,
        permanentlyFailedCount: number
    ): void {
        // Count cleanup runs, not individual tracks -- a single batch of stale
        // tracks shouldn't immediately trip the breaker
        this.failureCount += 1;
        this.lastFailureTime = new Date();

        if (this.state === "half-open") {
            this.state = "open";
            logger.warn(
                `[AudioAnalysisCleanup] Circuit breaker REOPENED - recovery attempt failed (${this.failureCount} total failures)`
            );
        } else if (this.failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
            this.state = "open";
            logger.warn(
                `[AudioAnalysisCleanup] Circuit breaker OPEN - ${this.failureCount} failures in window. ` +
                    `Pausing audio analysis queuing until analyzer shows signs of life.`
            );
        }
    }

    isCircuitOpen(): boolean {
        if (this.state === "open" && this.shouldAttemptReset()) {
            this.state = "half-open";
            logger.info(
                `[AudioAnalysisCleanup] Circuit breaker HALF-OPEN - attempting recovery after ${
                    CIRCUIT_BREAKER_WINDOW_MS / 60000
                } minute cooldown`
            );
        }
        return this.state === "open";
    }

    recordSuccess(): void {
        this.onSuccess();
    }

    async cleanupStaleProcessing(): Promise<{
        reset: number;
        permanentlyFailed: number;
    }> {
        const cutoff = new Date(
            Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000
        );

        const staleTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "processing",
                OR: [
                    { analysisStartedAt: { lt: cutoff } },
                    {
                        analysisStartedAt: null,
                        updatedAt: { lt: cutoff },
                    },
                ],
            },
            include: {
                album: {
                    include: {
                        artist: { select: { name: true } },
                    },
                },
            },
        });

        if (staleTracks.length === 0) {
            const jfOnly = await cleanupStaleJellyfinAnalysisRows(cutoff);
            return {
                reset: jfOnly.reset,
                permanentlyFailed: jfOnly.permanent,
            };
        }

        logger.debug(
            `[AudioAnalysisCleanup] Found ${staleTracks.length} stale tracks (processing > ${STALE_THRESHOLD_MINUTES} min)`
        );

        const permanentTracks: typeof staleTracks = [];
        const resetTracks: typeof staleTracks = [];

        for (const track of staleTracks) {
            const newRetryCount = (track.analysisRetryCount || 0) + 1;
            if (newRetryCount >= MAX_RETRIES) {
                permanentTracks.push(track);
            } else {
                resetTracks.push(track);
            }
        }

        for (const track of permanentTracks) {
            const newRetryCount = (track.analysisRetryCount || 0) + 1;
            const trackName = `${track.album.artist.name} - ${track.title}`;
            await prisma.track.update({
                where: { id: track.id },
                data: {
                    analysisStatus: "failed",
                    analysisError: `Exceeded ${MAX_RETRIES} retry attempts (stale processing)`,
                    analysisRetryCount: newRetryCount,
                    analysisStartedAt: null,
                },
            });
            await enrichmentFailureService.recordFailure({
                entityType: "audio",
                entityId: track.id,
                entityName: trackName,
                errorMessage: `Analysis timed out ${MAX_RETRIES} times - track may be corrupted or unsupported`,
                errorCode: "MAX_RETRIES_EXCEEDED",
                metadata: {
                    filePath: track.filePath,
                    retryCount: newRetryCount,
                },
            });
            logger.warn(
                `[AudioAnalysisCleanup] Permanently failed: ${trackName}`
            );
        }

        if (resetTracks.length > 0) {
            for (const track of resetTracks) {
                const newRetryCount = (track.analysisRetryCount || 0) + 1;
                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        analysisStatus: "pending",
                        analysisStartedAt: null,
                        analysisRetryCount: newRetryCount,
                        analysisError: `Reset after stale processing (attempt ${newRetryCount}/${MAX_RETRIES})`,
                    },
                });
                logger.debug(
                    `[AudioAnalysisCleanup] Reset for retry (${newRetryCount}/${MAX_RETRIES}): ${track.album.artist.name} - ${track.title}`
                );
            }
        }

        const resetCount = resetTracks.length;
        const permanentlyFailedCount = permanentTracks.length;

        if (resetCount > 0 || permanentlyFailedCount > 0) {
            this.onFailure(resetCount, permanentlyFailedCount);
        }

        const jfStale = await cleanupStaleJellyfinAnalysisRows(cutoff);

        logger.debug(
            `[AudioAnalysisCleanup] Cleanup complete: ${resetCount + jfStale.reset} reset, ${permanentlyFailedCount + jfStale.permanent} permanently failed`
        );

        return {
            reset: resetCount + jfStale.reset,
            permanentlyFailed: permanentlyFailedCount + jfStale.permanent,
        };
    }

    async getStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
        circuitOpen: boolean;
        circuitState: CircuitState;
        failureCount: number;
    }> {
        const [pending, processing, completed, failed] = await Promise.all([
            prisma.track.count({ where: { analysisStatus: "pending" } }),
            prisma.track.count({ where: { analysisStatus: "processing" } }),
            prisma.track.count({ where: { analysisStatus: "completed" } }),
            prisma.track.count({ where: { analysisStatus: "failed" } }),
        ]);

        return {
            pending,
            processing,
            completed,
            failed,
            circuitOpen: this.state === "open",
            circuitState: this.state,
            failureCount: this.failureCount,
        };
    }
}

export const audioAnalysisCleanupService = new AudioAnalysisCleanupService();
