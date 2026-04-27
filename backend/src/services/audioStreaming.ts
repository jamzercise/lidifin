import * as fs from "fs";
import { promises as fsPromises } from "fs";
import { Request, Response } from "express";
import { logger } from "../utils/logger";
import * as path from "path";
import * as crypto from "crypto";
import { prisma } from "../utils/db";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import PQueue from "p-queue";
import { AppError, ErrorCode, ErrorCategory } from "../utils/errors";
import { parseRangeHeader } from "../utils/rangeParser";
import { parseFile } from "../utils/musicMetadata";

// Set FFmpeg path to bundled binary
ffmpeg.setFfmpegPath(ffmpegPath.path);

// Quality settings
export const QUALITY_SETTINGS = {
    original: { bitrate: null, format: null }, // No transcoding
    high: { bitrate: 320, format: "mp3" },
    medium: { bitrate: 192, format: "mp3" },
    low: { bitrate: 128, format: "mp3" },
} as const;

export type Quality = keyof typeof QUALITY_SETTINGS;

interface StreamFileInfo {
    filePath: string;
    mimeType: string;
}

export class AudioStreamingService {
    private transcodeQueue = new PQueue({ concurrency: 3 });
    private musicPath: string;
    private transcodeCachePath: string;
    private transcodeCacheMaxGb: number;
    private evictionInterval: NodeJS.Timeout | null = null;

    constructor(
        musicPath: string,
        transcodeCachePath: string,
        transcodeCacheMaxGb: number
    ) {
        this.musicPath = musicPath;
        this.transcodeCachePath = transcodeCachePath;
        this.transcodeCacheMaxGb = transcodeCacheMaxGb;

        // Ensure cache directory exists
        if (!fs.existsSync(this.transcodeCachePath)) {
            fs.mkdirSync(this.transcodeCachePath, { recursive: true });
        }

        // Start cache eviction timer (every 6 hours)
        this.evictionInterval = setInterval(() => {
            this.evictCache(this.transcodeCacheMaxGb).catch((err) => {
                logger.error("Cache eviction failed:", err);
            });
        }, 6 * 60 * 60 * 1000);
    }

    /**
     * Get file path for streaming (either original or transcoded).
     *
     * `sourceFileSizeBytes` and `sourceDurationSec` are optional but strongly
     * recommended: when provided we use them to compute an average bitrate
     * estimate (size×8 / duration) instead of opening and parsing the whole
     * audio file with music-metadata on every transcode request. The estimate
     * is more than accurate enough for the only decision being made here
     * ("is the source already at or below the target bitrate?") and avoids a
     * hot-path I/O+CPU stall that was contributing to event-loop blocking.
     */
    async getStreamFilePath(
        trackId: string,
        quality: Quality,
        sourceModified: Date,
        sourceAbsolutePath: string,
        sourceFileSizeBytes?: number,
        sourceDurationSec?: number
    ): Promise<StreamFileInfo> {
        logger.debug(`[AudioStreaming] Request: trackId=${trackId}, quality=${quality}, source=${path.basename(sourceAbsolutePath)}`);
        
        // If original quality requested, return source file
        if (quality === "original") {
            const mimeType = this.getMimeType(sourceAbsolutePath);
            logger.debug(`[AudioStreaming] Serving original: mimeType=${mimeType}`);
            return {
                filePath: sourceAbsolutePath,
                mimeType,
            };
        }

        // Check if we have a valid cached transcode
        const cachedPath = await this.getCachedTranscode(
            trackId,
            quality,
            sourceModified
        );

        if (cachedPath) {
            logger.debug(
                `[STREAM] Using cached transcode: ${quality} (${cachedPath})`
            );
            return {
                filePath: cachedPath,
                mimeType: "audio/mpeg",
            };
        }

        // Check source file bitrate to avoid pointless upsampling
        const targetBitrate = QUALITY_SETTINGS[quality].bitrate;
        if (targetBitrate) {
            const sourceBitrate = await this.estimateSourceBitrateKbps(
                trackId,
                sourceAbsolutePath,
                sourceFileSizeBytes,
                sourceDurationSec
            );

            if (sourceBitrate && sourceBitrate <= targetBitrate) {
                logger.debug(
                    `[STREAM] Source bitrate (${sourceBitrate}kbps) <= target (${targetBitrate}kbps), serving original`
                );
                return {
                    filePath: sourceAbsolutePath,
                    mimeType: this.getMimeType(sourceAbsolutePath),
                };
            }
        }

        // Need to transcode - check cache size first
        const currentSize = await this.getCacheSize();
        if (currentSize > this.transcodeCacheMaxGb * 0.9) {
            logger.debug(
                `[STREAM] Cache near full (${currentSize.toFixed(
                    2
                )}GB), evicting to 80%...`
            );
            await this.evictCache(this.transcodeCacheMaxGb * 0.8);
        }

        // Transcode to cache
        logger.debug(
            `[STREAM] Transcoding to ${quality} quality: ${sourceAbsolutePath}`
        );
        const transcodedPath = await this.transcodeToCache(
            trackId,
            quality,
            sourceAbsolutePath,
            sourceModified
        );

        return {
            filePath: transcodedPath,
            mimeType: "audio/mpeg",
        };
    }

    /**
     * Estimate the source file's average bitrate in kbps.
     *
     * Order of preference:
     *   1. From DB-supplied `fileSize` + `duration` (free, exact average).
     *   2. From a small in-memory cache of prior parseFile() results.
     *   3. As a last resort, parseFile() the source file and cache the result.
     *
     * Returns null only if every path fails (e.g. duration is missing AND the
     * file can't be parsed). Callers should treat null as "transcode anyway".
     */
    private async estimateSourceBitrateKbps(
        trackId: string,
        sourceAbsolutePath: string,
        sourceFileSizeBytes?: number,
        sourceDurationSec?: number
    ): Promise<number | null> {
        // Path 1: arithmetic from DB-known fileSize+duration. This is the only
        // path that should ever execute on the hot streaming loop. Math is
        // synchronous and microseconds; no file I/O.
        if (
            typeof sourceFileSizeBytes === "number" &&
            sourceFileSizeBytes > 0 &&
            typeof sourceDurationSec === "number" &&
            sourceDurationSec > 0
        ) {
            const kbps = Math.round(
                (sourceFileSizeBytes * 8) / sourceDurationSec / 1000
            );
            return Number.isFinite(kbps) && kbps > 0 ? kbps : null;
        }

        // Path 2: cached parseFile result for this track. Bitrate is intrinsic
        // to the file contents, so once we've parsed a track we can reuse the
        // value forever (or until the cache LRU evicts it). Cache is keyed by
        // trackId because trackId is the unique-per-file identity here.
        const cached = AudioStreamingService.bitrateCache.get(trackId);
        if (cached !== undefined) {
            return cached;
        }

        // Path 3: fall back to parseFile. Should be rare in practice because
        // every Track row in the DB has fileSize and duration. Logged at warn
        // so the operator can tell when we're forced into the slow path.
        try {
            const metadata = await parseFile(sourceAbsolutePath);
            const kbps = metadata.format.bitrate
                ? Math.round(metadata.format.bitrate / 1000)
                : null;
            AudioStreamingService.cacheBitrate(trackId, kbps);
            return kbps;
        } catch (err) {
            logger.warn(
                `[STREAM] Failed to read source metadata for bitrate check, will transcode anyway:`,
                err
            );
            // Cache the null too so we don't keep retrying a busted file.
            AudioStreamingService.cacheBitrate(trackId, null);
            return null;
        }
    }

    /**
     * Process-wide LRU of trackId -> sourceBitrateKbps (or null if we tried and
     * failed). Bounded so a long-running process can't accumulate one entry
     * per track in the library.
     */
    private static bitrateCache = new Map<string, number | null>();
    private static readonly BITRATE_CACHE_MAX = 1024;

    private static cacheBitrate(trackId: string, kbps: number | null): void {
        if (this.bitrateCache.size >= this.BITRATE_CACHE_MAX) {
            // Cheap LRU: drop the oldest insertion (Map preserves insertion order).
            const firstKey = this.bitrateCache.keys().next().value;
            if (firstKey !== undefined) {
                this.bitrateCache.delete(firstKey);
            }
        }
        this.bitrateCache.set(trackId, kbps);
    }

    /**
     * Get cached transcode if it exists and is valid
     */
    private async getCachedTranscode(
        trackId: string,
        quality: Quality,
        sourceModified: Date
    ): Promise<string | null> {
        const cached = await prisma.transcodedFile.findFirst({
            where: {
                trackId,
                quality,
            },
        });

        if (!cached) return null;

        // Invalidate if source file was modified after transcode was created
        if (cached.sourceModified < sourceModified) {
            logger.debug(
                `[STREAM] Cache stale for track ${trackId}, removing...`
            );
            await prisma.transcodedFile.delete({ where: { id: cached.id } });

            // Delete file from disk
            const cachePath = path.join(
                this.transcodeCachePath,
                cached.cachePath
            );
            await fs.promises.unlink(cachePath).catch(() => {});

            return null;
        }

        // Update last accessed time
        await prisma.transcodedFile.update({
            where: { id: cached.id },
            data: { lastAccessed: new Date() },
        });

        const fullPath = path.join(this.transcodeCachePath, cached.cachePath);

        // Verify file exists
        if (!fs.existsSync(fullPath)) {
            logger.debug(`[STREAM] Cache file missing: ${fullPath}`);
            await prisma.transcodedFile.delete({ where: { id: cached.id } });
            return null;
        }

        return fullPath;
    }

    /**
     * Transcode audio file to cache
     */
    private async transcodeToCache(
        trackId: string,
        quality: Quality,
        sourcePath: string,
        sourceModified: Date
    ): Promise<string> {
        const settings = QUALITY_SETTINGS[quality];
        if (!settings.bitrate || !settings.format) {
            throw new AppError(
                ErrorCode.INVALID_CONFIG,
                ErrorCategory.FATAL,
                `Invalid quality setting: ${quality}`
            );
        }

        // Generate cache file path
        const hash = crypto
            .createHash("md5")
            .update(`${trackId}-${quality}`)
            .digest("hex");
        const cacheFileName = `${hash}.${settings.format}`;
        const cachePath = path.join(this.transcodeCachePath, cacheFileName);

        return new Promise((resolve, reject) => {
            try {
                ffmpeg(sourcePath)
                    .audioBitrate(settings.bitrate)
                    .audioCodec("libmp3lame")
                    .format(settings.format)
                    .on("error", (err) => {
                        // Check if error is due to missing FFmpeg
                        const errorMsg = err.message.toLowerCase();
                        if (
                            errorMsg.includes("ffmpeg") &&
                            errorMsg.includes("not found")
                        ) {
                            reject(
                                new AppError(
                                    ErrorCode.FFMPEG_NOT_FOUND,
                                    ErrorCategory.FATAL,
                                    "FFmpeg not installed. Please install FFmpeg to enable transcoding.",
                                    { trackId, quality }
                                )
                            );
                        } else {
                            reject(
                                new AppError(
                                    ErrorCode.TRANSCODE_FAILED,
                                    ErrorCategory.RECOVERABLE,
                                    `Transcoding failed: ${err.message}`,
                                    { trackId, quality, source: sourcePath }
                                )
                            );
                        }
                    })
                    .on("end", async () => {
                        try {
                            // Get file size
                            const stats = await fs.promises.stat(cachePath);

                            // Save to database
                            await prisma.transcodedFile.create({
                                data: {
                                    trackId,
                                    quality,
                                    cachePath: cacheFileName,
                                    cacheSize: stats.size,
                                    sourceModified,
                                    lastAccessed: new Date(),
                                },
                            });

                            logger.debug(
                                `[STREAM] Transcode complete: ${cacheFileName} (${(
                                    stats.size /
                                    1024 /
                                    1024
                                ).toFixed(2)}MB)`
                            );
                            resolve(cachePath);
                        } catch (err: any) {
                            reject(
                                new AppError(
                                    ErrorCode.DB_QUERY_ERROR,
                                    ErrorCategory.RECOVERABLE,
                                    `Failed to save transcode record: ${err.message}`,
                                    { trackId, quality }
                                )
                            );
                        }
                    })
                    .save(cachePath);
            } catch (err: any) {
                reject(
                    new AppError(
                        ErrorCode.FFMPEG_NOT_FOUND,
                        ErrorCategory.FATAL,
                        "FFmpeg not available. Please install FFmpeg to enable transcoding.",
                        { trackId, quality }
                    )
                );
            }
        });
    }

    /**
     * Get total cache size in GB
     */
    async getCacheSize(): Promise<number> {
        const cached = await prisma.transcodedFile.findMany({
            select: { cacheSize: true },
        });
        const totalBytes = cached.reduce((sum, f) => sum + f.cacheSize, 0);
        return totalBytes / (1024 * 1024 * 1024);
    }

    /**
     * Evict cache using LRU until size is below target
     */
    async evictCache(targetGb: number): Promise<void> {
        logger.debug(`[CACHE] Starting eviction, target: ${targetGb}GB`);

        let currentSize = await this.getCacheSize();
        logger.debug(`[CACHE] Current size: ${currentSize.toFixed(2)}GB`);

        if (currentSize <= targetGb) {
            logger.debug("[CACHE] Below target, no eviction needed");
            return;
        }

        // Get all cached files sorted by last accessed (oldest first)
        const cached = await prisma.transcodedFile.findMany({
            orderBy: { lastAccessed: "asc" },
        });

        let evicted = 0;
        for (const file of cached) {
            if (currentSize <= targetGb) break;

            // Delete file from disk
            const fullPath = path.join(this.transcodeCachePath, file.cachePath);
            try {
                await fs.promises.unlink(fullPath);
            } catch (err) {
                logger.warn(`[CACHE] Failed to delete ${fullPath}:`, err);
            }

            // Delete from database
            await prisma.transcodedFile.delete({ where: { id: file.id } });

            currentSize -= file.cacheSize / (1024 * 1024 * 1024);
            evicted++;
        }

        logger.debug(
            `[CACHE] Evicted ${evicted} files, new size: ${currentSize.toFixed(
                2
            )}GB`
        );
    }

    /**
     * Get MIME type from file extension
     */
    getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            ".mp3": "audio/mpeg",
            ".flac": "audio/flac",
            ".m4a": "audio/mp4",
            ".aac": "audio/aac",
            ".ogg": "audio/ogg",
            ".opus": "audio/opus",
            ".wav": "audio/wav",
            ".wma": "audio/x-ms-wma",
            ".ape": "audio/x-ape",
            ".wv": "audio/x-wavpack",
        };
        return mimeTypes[ext] || "audio/mpeg";
    }

    /**
     * Stream file with proper HTTP Range support (fixes Firefox FLAC issue #42/#17)
     * Manually handles Range requests to ensure compatibility with Firefox's strict
     * Content-Range header validation for large FLAC files.
     */
    async streamFileWithRangeSupport(
        req: Request,
        res: Response,
        filePath: string,
        mimeType: string
    ): Promise<void> {
        try {
            // Get file stats for size
            const stats = await fsPromises.stat(filePath);
            const fileSize = stats.size;

            // Parse Range header
            const range = req.headers.range;
            let start = 0;
            let end = fileSize - 1;

            if (range) {
                const parsed = parseRangeHeader(range, fileSize);
                if (!parsed.ok) {
                    res.status(416).set({
                        "Content-Range": `bytes */${fileSize}`,
                    });
                    res.end();
                    return;
                }
                start = parsed.start;
                end = parsed.end;
            }

            const contentLength = end - start + 1;

            // Set response headers
            const headers: Record<string, string> = {
                "Content-Type": mimeType,
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=31536000",
                "Content-Length": contentLength.toString(),
            };

            // Add CORS headers from request origin
            if (req.headers.origin) {
                headers["Access-Control-Allow-Origin"] = req.headers.origin;
                headers["Access-Control-Allow-Credentials"] = "true";
            }

            // Set status and range-specific headers
            if (range) {
                res.status(206);
                headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
            } else {
                res.status(200);
            }

            res.set(headers);

            // Create read stream with range
            const stream = fs.createReadStream(filePath, { start, end });

            // Handle stream errors
            stream.on("error", (err) => {
                logger.error(`[AudioStreaming] Stream error for ${filePath}:`, err);
                if (!res.headersSent) {
                    res.status(500).end();
                }
            });

            // Handle cleanup on response close
            res.on("close", () => {
                stream.destroy();
            });

            // Pipe stream to response
            stream.pipe(res);
        } catch (err) {
            logger.error(`[AudioStreaming] Failed to stream ${filePath}:`, err);
            if (!res.headersSent) {
                res.status(500).end();
            }
        }
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        if (this.evictionInterval) {
            clearInterval(this.evictionInterval);
            this.evictionInterval = null;
        }
    }
}
