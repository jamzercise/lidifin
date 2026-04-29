import type { Router } from "express";
import axios from "axios";
import fs from "fs";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { parseRangeHeader } from "../../utils/rangeParser";
import { headerToString } from "../../utils/httpClient";

/** Episode cache status, streaming (range + cache), and playback progress. */
export function registerPodcastEpisodeRoutes(router: Router): void {
    router.get(
        "/:podcastId/episodes/:episodeId/cache-status",
        async (req, res) => {
            try {
                const { episodeId } = req.params;

                const {
                    getCachedFilePath,
                    isDownloading,
                    getDownloadProgress,
                } = await import("../../services/podcastDownload");

                const cachedPath = await getCachedFilePath(episodeId);
                const downloading = isDownloading(episodeId);
                const progress = getDownloadProgress(episodeId);

                res.json({
                    episodeId,
                    cached: !!cachedPath,
                    downloading,
                    downloadProgress: progress?.progress ?? null, // 0-100 or null
                    path: cachedPath ? true : false, // Don't expose actual path
                });
            } catch (error: any) {
                logger.error("[PODCAST] Cache status check failed:", error);
                res.status(500).json({ error: "Failed to check cache status" });
            }
        },
    );

    /**
     * GET /podcasts/:podcastId/episodes/:episodeId/stream
     * Stream a podcast episode (from local cache or RSS URL)
     * Auto-caches episodes in background for better seeking support
     */
    router.get("/:podcastId/episodes/:episodeId/stream", async (req, res) => {
        try {
            const { podcastId, episodeId } = req.params;
            const userId = req.user?.id;
            const podcastDebug = process.env.PODCAST_DEBUG === "1";

            logger.debug(`\n [PODCAST STREAM] Request:`);
            logger.debug(`   Podcast ID: ${podcastId}`);
            logger.debug(`   Episode ID: ${episodeId}`);
            if (podcastDebug) {
                logger.debug(`   Range: ${req.headers.range || "none"}`);
                logger.debug(
                    `   UA: ${req.headers["user-agent"] || "unknown"}`,
                );
            }

            const episode = await prisma.podcastEpisode.findUnique({
                where: { id: episodeId },
            });

            if (!episode) {
                return res.status(404).json({ error: "Episode not found" });
            }

            if (podcastDebug) {
                logger.debug(`   Episode DB: title="${episode.title}"`);
                logger.debug(`   Episode DB: guid="${episode.guid}"`);
                logger.debug(`   Episode DB: audioUrl="${episode.audioUrl}"`);
                logger.debug(
                    `   Episode DB: mimeType="${
                        episode.mimeType || "unknown"
                    }" fileSize=${episode.fileSize || 0}`,
                );
            }

            const range = req.headers.range;

            // Import podcast download service
            const { getCachedFilePath, downloadInBackground, isDownloading } =
                await import("../../services/podcastDownload");

            // Check if episode is cached locally (with full range support)
            const cachedPath = await getCachedFilePath(episodeId);

            if (cachedPath) {
                logger.debug(`   Streaming from cache: ${cachedPath}`);
                try {
                    const stats = await fs.promises.stat(cachedPath);
                    const fileSize = stats.size;
                    if (podcastDebug) {
                        logger.debug(`   Cache file size: ${fileSize}`);
                    }

                    if (fileSize === 0) {
                        throw new Error("Cached file is empty");
                    }

                    if (range) {
                        const parsed = parseRangeHeader(range, fileSize);

                        let start: number;
                        let end: number;

                        if (!parsed.ok) {
                            // Clamp to 1MB window near EOF instead of 416 (prevents client stalls during seeking)
                            const clampWindowBytes = 1024 * 1024;
                            start = Math.max(0, fileSize - clampWindowBytes);
                            end = fileSize - 1;
                            logger.debug(
                                `    Invalid range, clamping to last ${fileSize - start} bytes`,
                            );
                        } else {
                            start = parsed.start;
                            end = parsed.end;
                        }

                        const chunkSize = end - start + 1;

                        logger.debug(
                            `    Serving range: bytes ${start}-${end}/${fileSize}`,
                        );

                        res.writeHead(206, {
                            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                            "Accept-Ranges": "bytes",
                            "Content-Length": chunkSize,
                            "Content-Type": episode.mimeType || "audio/mpeg",
                            "Cache-Control": "public, max-age=3600",
                            "Access-Control-Allow-Origin":
                                req.headers.origin || "*",
                            "Access-Control-Allow-Credentials": "true",
                        });

                        const fileStream = fs.createReadStream(cachedPath, {
                            start,
                            end: end,
                        });
                        // Clean up file stream when client disconnects
                        res.on("close", () => {
                            if (!fileStream.destroyed) {
                                fileStream.destroy();
                            }
                        });
                        fileStream.pipe(res);
                        fileStream.on("error", (err) => {
                            logger.error("    Cache stream error:", err);
                            if (!res.headersSent) {
                                res.status(500).json({
                                    error: "Failed to stream episode",
                                });
                            } else {
                                res.end();
                            }
                        });
                        return; // CRITICAL: Exit after starting cache stream
                    }

                    // No range - serve entire file
                    logger.debug(`    Serving full file: ${fileSize} bytes`);
                    res.writeHead(200, {
                        "Content-Type": episode.mimeType || "audio/mpeg",
                        "Content-Length": fileSize,
                        "Accept-Ranges": "bytes",
                        "Cache-Control": "public, max-age=3600",
                        "Access-Control-Allow-Origin":
                            req.headers.origin || "*",
                        "Access-Control-Allow-Credentials": "true",
                    });

                    const fileStream = fs.createReadStream(cachedPath);
                    // Clean up file stream when client disconnects
                    res.on("close", () => {
                        if (!fileStream.destroyed) {
                            fileStream.destroy();
                        }
                    });
                    fileStream.pipe(res);
                    fileStream.on("error", (err) => {
                        logger.error("    Cache stream error:", err);
                        if (!res.headersSent) {
                            res.status(500).json({
                                error: "Failed to stream episode",
                            });
                        } else {
                            res.end();
                        }
                    });
                    return; // CRITICAL: Exit after starting cache stream
                } catch (err: any) {
                    logger.error(
                        "    Failed to stream from cache, falling back to RSS:",
                        err.message,
                    );
                    // Fall through to RSS streaming only if cache fails
                }
            }

            // Not cached yet - trigger background download while streaming from RSS
            if (userId && !isDownloading(episodeId)) {
                logger.debug(`   Triggering background download for caching`);
                downloadInBackground(episodeId, episode.audioUrl, userId);
            }

            // Stream from RSS URL
            logger.debug(`   Streaming from RSS: ${episode.audioUrl}`);

            // Get file size first for proper range handling
            let fileSize = episode.fileSize;
            if (!fileSize) {
                try {
                    const headResponse = await axios.head(episode.audioUrl);
                    fileSize = parseInt(
                        headerToString(
                            headResponse.headers["content-length"],
                        ) || "0",
                        10,
                    );
                    if (Number.isFinite(fileSize) && fileSize > 0) {
                        await prisma.podcastEpisode.update({
                            where: { id: episode.id },
                            data: { fileSize },
                        });
                    }
                } catch (err) {
                    logger.warn("    Could not get file size via HEAD request");
                }
            }

            if (range && fileSize) {
                const parsed = parseRangeHeader(range, fileSize);
                if (!parsed.ok) {
                    res.status(416).set({
                        "Content-Range": `bytes */${fileSize}`,
                    });
                    res.end();
                    return;
                }
                const { start, end } = parsed;
                const chunkSize = end - start + 1;

                logger.debug(
                    `    Range request: bytes=${start}-${end}/${fileSize}`,
                );

                const controller = new AbortController();

                // Handle client disconnect BEFORE starting the request
                res.on("close", () => {
                    controller.abort();
                });

                try {
                    // Try range request first
                    const response = await axios.get(episode.audioUrl, {
                        headers: { Range: `bytes=${start}-${end}` },
                        responseType: "stream",
                        validateStatus: (status) =>
                            status === 206 || status === 200,
                        timeout: 30000,
                        signal: controller.signal,
                    });

                    // If upstream returned 200 OK instead of 206 Partial Content, it ignored our Range header.
                    // In this case, we must stream the whole response as 200 OK, or the browser will be confused
                    // if we try to wrap it in a 206.
                    if (response.status === 200) {
                        logger.debug(
                            `    Upstream returned 200 OK (ignored Range), streaming full response`,
                        );
                        const respLen = headerToString(
                            response.headers["content-length"],
                        );
                        res.writeHead(200, {
                            "Content-Type": episode.mimeType || "audio/mpeg",
                            "Accept-Ranges": "bytes",
                            "Content-Length": respLen || String(fileSize),
                            "Cache-Control": "public, max-age=3600",
                            "Access-Control-Allow-Origin":
                                req.headers.origin || "*",
                            "Access-Control-Allow-Credentials": "true",
                        });
                    } else {
                        // Send 206 Partial Content with proper range
                        res.writeHead(206, {
                            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                            "Accept-Ranges": "bytes",
                            "Content-Length": chunkSize,
                            "Content-Type": episode.mimeType || "audio/mpeg",
                            "Cache-Control": "public, max-age=3600",
                            "Access-Control-Allow-Origin":
                                req.headers.origin || "*",
                            "Access-Control-Allow-Credentials": "true",
                        });
                    }

                    // Handle stream errors to prevent process crash
                    response.data.on("error", (err: Error) => {
                        // Client disconnect errors are expected during seeking
                        if (
                            (err as any).code !== "ERR_STREAM_PREMATURE_CLOSE"
                        ) {
                            logger.debug(
                                `    RSS stream error: ${err.message}`,
                            );
                        }
                        if (!res.writableEnded) {
                            res.end();
                        }
                    });

                    // Clean up axios stream when client disconnects
                    res.on("close", () => {
                        if (response.data && !response.data.destroyed) {
                            response.data.destroy();
                        }
                    });
                    response.data.pipe(res);
                    return;
                } catch (rangeError: any) {
                    if (axios.isCancel(rangeError)) {
                        logger.debug("    Request aborted by client");
                        return;
                    }
                    // 416 = Range Not Satisfiable - many podcast CDNs don't support range requests
                    // Fall back to streaming the full file and let the browser handle seeking
                    logger.debug(
                        `    Range request failed (${
                            rangeError.response?.status || rangeError.message
                        }), falling back to full stream`,
                    );

                    // Stream full file instead - browser will handle seeking locally
                    const response = await axios.get(episode.audioUrl, {
                        responseType: "stream",
                        timeout: 60000,
                        signal: controller.signal,
                    });

                    const contentLength = headerToString(
                        response.headers["content-length"],
                    );

                    res.writeHead(200, {
                        "Content-Type": episode.mimeType || "audio/mpeg",
                        "Accept-Ranges": "bytes",
                        ...(contentLength && {
                            "Content-Length": contentLength,
                        }),
                        "Cache-Control": "public, max-age=3600",
                        "Access-Control-Allow-Origin":
                            req.headers.origin || "*",
                        "Access-Control-Allow-Credentials": "true",
                    });

                    // Handle stream errors to prevent process crash
                    response.data.on("error", (err: Error) => {
                        // Client disconnect errors are expected during seeking
                        if (
                            (err as any).code !== "ERR_STREAM_PREMATURE_CLOSE"
                        ) {
                            logger.debug(
                                `    RSS fallback stream error: ${err.message}`,
                            );
                        }
                        if (!res.writableEnded) {
                            res.end();
                        }
                    });

                    // Clean up axios stream when client disconnects
                    res.on("close", () => {
                        if (response.data && !response.data.destroyed) {
                            response.data.destroy();
                        }
                    });
                    response.data.pipe(res);
                    return;
                }
            } else {
                // No range request - stream entire file
                logger.debug(`    Streaming full file`);

                const controller = new AbortController();
                res.on("close", () => {
                    controller.abort();
                });

                try {
                    const response = await axios.get(episode.audioUrl, {
                        responseType: "stream",
                        signal: controller.signal,
                    });

                    const contentLength = headerToString(
                        response.headers["content-length"],
                    );

                    res.writeHead(200, {
                        "Content-Type": episode.mimeType || "audio/mpeg",
                        "Accept-Ranges": "bytes",
                        ...(contentLength && {
                            "Content-Length": contentLength,
                        }),
                        "Cache-Control": "public, max-age=3600",
                        "Access-Control-Allow-Origin":
                            req.headers.origin || "*",
                        "Access-Control-Allow-Credentials": "true",
                    });

                    // Handle stream errors to prevent process crash
                    response.data.on("error", (err: Error) => {
                        // Client disconnect errors are expected during seeking
                        if (
                            (err as any).code !== "ERR_STREAM_PREMATURE_CLOSE"
                        ) {
                            logger.debug(
                                `    RSS full stream error: ${err.message}`,
                            );
                        }
                        if (!res.writableEnded) {
                            res.end();
                        }
                    });

                    // Clean up axios stream when client disconnects
                    res.on("close", () => {
                        if (response.data && !response.data.destroyed) {
                            response.data.destroy();
                        }
                    });
                    response.data.pipe(res);
                } catch (error: any) {
                    if (axios.isCancel(error)) {
                        logger.debug("    Request aborted by client");
                        return;
                    }
                    throw error;
                }
            }
        } catch (error: any) {
            logger.error("\n [PODCAST STREAM] Error:", error.message);
            if (!res.headersSent) {
                res.status(500).json({
                    error: "Failed to stream episode",
                    message: error.message,
                });
            }
        }
    });

    /**
     * POST /podcasts/:podcastId/episodes/:episodeId/progress
     * Update playback progress for a podcast episode
     */
    router.post(
        "/:podcastId/episodes/:episodeId/progress",
        async (req, res) => {
            try {
                const { podcastId, episodeId } = req.params;
                const { currentTime, duration, isFinished } = req.body;

                logger.debug(`\n [PODCAST PROGRESS] Update:`);
                logger.debug(`   User: ${req.user!.username}`);
                logger.debug(`   Episode ID: ${episodeId}`);
                logger.debug(`   Current Time: ${currentTime}s`);
                logger.debug(`   Duration: ${duration}s`);
                logger.debug(`   Finished: ${isFinished}`);

                const progress = await prisma.podcastProgress.upsert({
                    where: {
                        userId_episodeId: {
                            userId: req.user!.id,
                            episodeId: episodeId,
                        },
                    },
                    create: {
                        userId: req.user!.id,
                        episodeId: episodeId,
                        currentTime,
                        duration,
                        isFinished: isFinished || false,
                    },
                    update: {
                        currentTime,
                        duration,
                        isFinished: isFinished || false,
                        lastPlayedAt: new Date(),
                    },
                });

                logger.debug(`   Progress saved`);

                res.json({
                    success: true,
                    progress: {
                        currentTime: progress.currentTime,
                        progress:
                            progress.duration > 0
                                ? (progress.currentTime / progress.duration) *
                                  100
                                : 0,
                        isFinished: progress.isFinished,
                    },
                });
            } catch (error: any) {
                logger.error("Error updating progress:", error);
                res.status(500).json({
                    error: "Failed to update progress",
                    message: error.message,
                });
            }
        },
    );

    /**
     * DELETE /podcasts/:podcastId/episodes/:episodeId/progress
     * Remove/reset progress for a podcast episode
     */
    router.delete(
        "/:podcastId/episodes/:episodeId/progress",
        async (req, res) => {
            try {
                const { episodeId } = req.params;

                logger.debug(`\n[PODCAST PROGRESS] Delete:`);
                logger.debug(`   User: ${req.user!.username}`);
                logger.debug(`   Episode ID: ${episodeId}`);

                await prisma.podcastProgress.deleteMany({
                    where: {
                        userId: req.user!.id,
                        episodeId: episodeId,
                    },
                });

                logger.debug(`   Progress removed`);

                res.json({
                    success: true,
                    message: "Progress removed",
                });
            } catch (error: any) {
                logger.error("Error removing progress:", error);
                res.status(500).json({
                    error: "Failed to remove progress",
                    message: error.message,
                });
            }
        },
    );
}
