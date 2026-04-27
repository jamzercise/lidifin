import { Router } from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import {
    applyCoverArtCorsHeaders,
    fetchWithRetry,
    resolveIdForJellyfin,
    JELLYFIN_UNREACHABLE_MESSAGE,
    logger,
} from "./_helpers";
import { imageLimiter } from "../../middleware/rateLimiter";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { getSystemSettings } from "../../utils/systemSettings";
import { deezerService } from "../../services/deezer";
import { coverArtService } from "../../services/coverArt";
import { AudioStreamingService } from "../../services/audioStreaming";
import { extractColorsFromImage } from "../../utils/colorExtractor";
import {
    getJellyfinConfig,
    getJellyfinStreamUrl,
    streamJellyfinAudio,
} from "../../services/jellyfin";

const router = Router();

// GET /library/cover-art/:id?size= or GET /library/cover-art?url=&size=
// Apply lenient image limiter (500 req/min) instead of general API limiter (100 req/15min)
router.get("/cover-art/:id?", imageLimiter, async (req, res) => {
    try {
        const { size, url } = req.query;
        let coverUrl: string;
        let isAudiobook = false;

        // Check if a full URL was provided as a query parameter
        if (url) {
            const decodedUrl = decodeURIComponent(url as string);

            // Check if this is an audiobook cover (prefixed with "audiobook__")
            if (decodedUrl.startsWith("audiobook__")) {
                isAudiobook = true;
                const audiobookPath = decodedUrl.replace("audiobook__", "");

                // Get Audiobookshelf settings
                const settings = await getSystemSettings();
                const audiobookshelfUrl =
                    settings?.audiobookshelfUrl ||
                    process.env.AUDIOBOOKSHELF_URL ||
                    "";
                const audiobookshelfApiKey =
                    settings?.audiobookshelfApiKey ||
                    process.env.AUDIOBOOKSHELF_API_KEY ||
                    "";
                const audiobookshelfBaseUrl = audiobookshelfUrl.replace(
                    /\/$/,
                    ""
                );

                coverUrl = `${audiobookshelfBaseUrl}/api/${audiobookPath}`;

                // Fetch with authentication
                logger.debug(
                    `[COVER-ART] Fetching audiobook cover: ${coverUrl.substring(
                        0,
                        100
                    )}...`
                );
                const imageResponse = await fetchWithRetry(coverUrl, {
                    headers: {
                        Authorization: `Bearer ${audiobookshelfApiKey}`,
                    },
                });

                if (!imageResponse.ok) {
                    logger.error(
                        `[COVER-ART] Failed to fetch audiobook cover: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`
                    );
                    return res
                        .status(404)
                        .json({ error: "Audiobook cover art not found" });
                }

                const buffer = await imageResponse.arrayBuffer();
                const imageBuffer = Buffer.from(buffer);
                const contentType = imageResponse.headers.get("content-type");

                if (contentType) {
                    res.setHeader("Content-Type", contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    "public, max-age=31536000, immutable"
                );

                return res.send(imageBuffer);
            }

            // Check if this is a native cover (prefixed with "native:")
            if (decodedUrl.startsWith("native:")) {
                const nativePath = decodedUrl.replace("native:", "");

                const coverCachePath = path.join(
                    config.music.transcodeCachePath,
                    "../covers",
                    nativePath
                );

                logger.debug(
                    `[COVER-ART] Serving native cover: ${coverCachePath}`
                );

                // Check if file exists
                if (!fs.existsSync(coverCachePath)) {
                    logger.error(
                        `[COVER-ART] Native cover not found: ${coverCachePath}`
                    );
                    return res
                        .status(404)
                        .json({ error: "Cover art not found" });
                }

                // Serve the file directly
                const requestOrigin = req.headers.origin;
                const headers: Record<string, string> = {
                    "Content-Type": "image/jpeg", // Assume JPEG for now
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "Cross-Origin-Resource-Policy": "cross-origin",
                };
                if (requestOrigin) {
                    headers["Access-Control-Allow-Origin"] = requestOrigin;
                    headers["Access-Control-Allow-Credentials"] = "true";
                } else {
                    headers["Access-Control-Allow-Origin"] = "*";
                }

                return res.sendFile(coverCachePath, {
                    headers,
                });
            }

            coverUrl = decodedUrl;
        } else {
            // Otherwise use the ID from the path parameter
            const coverId = req.params.id;
            if (!coverId) {
                return res
                    .status(400)
                    .json({ error: "No cover ID or URL provided" });
            }

            const decodedId = decodeURIComponent(coverId);

            // Check if this is a native cover (prefixed with "native:")
            if (decodedId.startsWith("native:")) {
                const nativePath = decodedId.replace("native:", "");

                const coverCachePath = path.join(
                    config.music.transcodeCachePath,
                    "../covers",
                    nativePath
                );

                // Check if file exists
                if (fs.existsSync(coverCachePath)) {
                    // Serve the file directly
                    const requestOrigin = req.headers.origin;
                    const headers: Record<string, string> = {
                        "Content-Type": "image/jpeg",
                        "Cache-Control": "public, max-age=31536000, immutable",
                        "Cross-Origin-Resource-Policy": "cross-origin",
                    };
                    if (requestOrigin) {
                        headers["Access-Control-Allow-Origin"] = requestOrigin;
                        headers["Access-Control-Allow-Credentials"] = "true";
                    } else {
                        headers["Access-Control-Allow-Origin"] = "*";
                    }

                    return res.sendFile(coverCachePath, {
                        headers,
                    });
                }

                // Native cover file missing - try to find album and fetch from Deezer
                logger.warn(
                    `[COVER-ART] Native cover not found: ${coverCachePath}, trying Deezer fallback`
                );

                // Extract album ID from the path (format: albumId.jpg)
                const albumId = nativePath.replace(".jpg", "");
                try {
                    const album = await prisma.album.findUnique({
                        where: { id: albumId },
                        include: { artist: true },
                    });

                    if (album && album.artist) {
                        const deezerCover = await deezerService.getAlbumCover(
                            album.artist.name,
                            album.title
                        );

                        if (deezerCover) {
                            // Update album with Deezer cover
                            await prisma.album.update({
                                where: { id: albumId },
                                data: { coverUrl: deezerCover },
                            });

                            // Redirect to the Deezer cover
                            return res.redirect(deezerCover);
                        }
                    }
                } catch (error) {
                    logger.error(
                        `[COVER-ART] Failed to fetch Deezer fallback for ${albumId}:`,
                        error
                    );
                }

                return res.status(404).json({ error: "Cover art not found" });
            }

            // Check if this is an audiobook cover (prefixed with "audiobook__")
            if (decodedId.startsWith("audiobook__")) {
                isAudiobook = true;
                const audiobookPath = decodedId.replace("audiobook__", "");

                // Get Audiobookshelf settings
                const settings = await getSystemSettings();
                const audiobookshelfUrl =
                    settings?.audiobookshelfUrl ||
                    process.env.AUDIOBOOKSHELF_URL ||
                    "";
                const audiobookshelfApiKey =
                    settings?.audiobookshelfApiKey ||
                    process.env.AUDIOBOOKSHELF_API_KEY ||
                    "";
                const audiobookshelfBaseUrl = audiobookshelfUrl.replace(
                    /\/$/,
                    ""
                );

                coverUrl = `${audiobookshelfBaseUrl}/api/${audiobookPath}`;

                // Fetch with authentication
                logger.debug(
                    `[COVER-ART] Fetching audiobook cover: ${coverUrl.substring(
                        0,
                        100
                    )}...`
                );
                const imageResponse = await fetchWithRetry(coverUrl, {
                    headers: {
                        Authorization: `Bearer ${audiobookshelfApiKey}`,
                    },
                });

                if (!imageResponse.ok) {
                    logger.error(
                        `[COVER-ART] Failed to fetch audiobook cover: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`
                    );
                    return res
                        .status(404)
                        .json({ error: "Audiobook cover art not found" });
                }

                const buffer = await imageResponse.arrayBuffer();
                const imageBuffer = Buffer.from(buffer);
                const contentType = imageResponse.headers.get("content-type");

                if (contentType) {
                    res.setHeader("Content-Type", contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    "public, max-age=31536000, immutable"
                );

                return res.send(imageBuffer);
            }
            // Check if coverId is already a full URL (from Cover Art Archive or elsewhere)
            else if (
                decodedId.startsWith("http://") ||
                decodedId.startsWith("https://")
            ) {
                coverUrl = decodedId;
            } else {
                // Invalid cover ID format
                return res
                    .status(400)
                    .json({ error: "Invalid cover ID format" });
            }
        }

        // Create cache key from URL + size
        const cacheKey = `cover-art:${crypto
            .createHash("md5")
            .update(`${coverUrl}-${size || "original"}`)
            .digest("hex")}`;

        // Try to get from Redis cache first
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                const cachedData = JSON.parse(cached);

                // Check if this is a cached 404
                if (cachedData.notFound) {
                    logger.debug(
                        `[COVER-ART] Cached 404 for ${coverUrl.substring(
                            0,
                            60
                        )}...`
                    );
                    return res
                        .status(404)
                        .json({ error: "Cover art not found" });
                }

                logger.debug(
                    `[COVER-ART] Cache HIT for ${coverUrl.substring(0, 60)}...`
                );
                const imageBuffer = Buffer.from(cachedData.data, "base64");

                // Check if client has cached version
                if (req.headers["if-none-match"] === cachedData.etag) {
                    logger.debug(`[COVER-ART] Client has cached version (304)`);
                    return res.status(304).end();
                }

                // Set headers and send cached image
                if (cachedData.contentType) {
                    res.setHeader("Content-Type", cachedData.contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    "public, max-age=31536000, immutable"
                );
                res.setHeader("ETag", cachedData.etag);
                return res.send(imageBuffer);
            } else {
                logger.debug(
                    `[COVER-ART] ✗ Cache MISS for ${coverUrl.substring(
                        0,
                        60
                    )}...`
                );
            }
        } catch (cacheError) {
            logger.warn("[COVER-ART] Redis cache read error:", cacheError);
        }

        // Fetch the image and proxy it to avoid CORS issues
        logger.debug(`[COVER-ART] Fetching: ${coverUrl.substring(0, 100)}...`);
        const imageResponse = await fetchWithRetry(coverUrl);
        if (!imageResponse.ok) {
            logger.error(
                `[COVER-ART] Failed to fetch: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`
            );

            // Cache 404s for 1 hour to avoid repeatedly trying to fetch missing images
            if (imageResponse.status === 404) {
                try {
                    await redisClient.setEx(
                        cacheKey,
                        60 * 60, // 1 hour
                        JSON.stringify({ notFound: true })
                    );
                    logger.debug(`[COVER-ART] Cached 404 response for 1 hour`);
                } catch (cacheError) {
                    logger.warn(
                        "[COVER-ART] Redis cache write error:",
                        cacheError
                    );
                }
            }

            return res.status(404).json({ error: "Cover art not found" });
        }
        logger.debug(`[COVER-ART] Successfully fetched, caching...`);

        const buffer = await imageResponse.arrayBuffer();
        const imageBuffer = Buffer.from(buffer);

        // Generate ETag from content
        const etag = crypto.createHash("md5").update(imageBuffer).digest("hex");

        // Cache in Redis for 7 days
        try {
            const contentType = imageResponse.headers.get("content-type");
            await redisClient.setEx(
                cacheKey,
                7 * 24 * 60 * 60, // 7 days
                JSON.stringify({
                    etag,
                    contentType,
                    data: imageBuffer.toString("base64"),
                })
            );
        } catch (cacheError) {
            logger.warn("Redis cache write error:", cacheError);
        }

        // Check if client has cached version
        if (req.headers["if-none-match"] === etag) {
            return res.status(304).end();
        }

        // Set appropriate headers
        const contentType = imageResponse.headers.get("content-type");
        if (contentType) {
            res.setHeader("Content-Type", contentType);
        }

        // Set aggressive caching headers
        applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // Cache for 1 year
        res.setHeader("ETag", etag);

        // Send the image
        res.send(imageBuffer);
    } catch (error) {
        logger.error("Get cover art error:", error);
        res.status(500).json({ error: "Failed to fetch cover art" });
    }
});

// GET /library/album-cover/:mbid - Fetch and cache album cover by MBID
// This is called lazily by the frontend when an album doesn't have a cached cover
router.get("/album-cover/:mbid", imageLimiter, async (req, res) => {
    try {
        const { mbid } = req.params;

        if (!mbid || mbid.startsWith("temp-")) {
            return res.status(400).json({ error: "Valid MBID required" });
        }

        // Fetch from Cover Art Archive (this uses caching internally)
        const coverUrl = await coverArtService.getCoverArt(mbid);

        if (!coverUrl) {
            // Return 204 No Content instead of 404 to avoid console spam
            // Cover Art Archive doesn't have covers for all albums
            return res.status(204).send();
        }

        res.json({ coverUrl });
    } catch (error) {
        logger.error("Get album cover error:", error);
        res.status(500).json({ error: "Failed to fetch cover art" });
    }
});

// GET /library/cover-art-colors?url= - Extract colors from a cover art URL
router.get("/cover-art-colors", imageLimiter, async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: "URL parameter required" });
        }

        const imageUrl = decodeURIComponent(url as string);

        // Handle placeholder images - return default fallback colors
        if (
            imageUrl.includes("placeholder") ||
            imageUrl.startsWith("/placeholder")
        ) {
            logger.debug(
                `[COLORS] Placeholder image detected, returning fallback colors`
            );
            return res.json({
                vibrant: "#1db954",
                darkVibrant: "#121212",
                lightVibrant: "#181818",
                muted: "#535353",
                darkMuted: "#121212",
                lightMuted: "#b3b3b3",
            });
        }

        // Create cache key for colors
        const cacheKey = `colors:${crypto
            .createHash("md5")
            .update(imageUrl)
            .digest("hex")}`;

        // Try to get from Redis cache first
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(
                    `[COLORS] Cache HIT for ${imageUrl.substring(0, 60)}...`
                );
                return res.json(JSON.parse(cached));
            } else {
                logger.debug(
                    `[COLORS] ✗ Cache MISS for ${imageUrl.substring(0, 60)}...`
                );
            }
        } catch (cacheError) {
            logger.warn("[COLORS] Redis cache read error:", cacheError);
        }

        // Fetch the image
        logger.debug(
            `[COLORS] Fetching image: ${imageUrl.substring(0, 100)}...`
        );
        const imageResponse = await fetchWithRetry(imageUrl);

        if (!imageResponse.ok) {
            logger.error(
                `[COLORS] Failed to fetch image: ${imageUrl} (${imageResponse.status})`
            );
            return res.status(404).json({ error: "Image not found" });
        }

        const buffer = await imageResponse.arrayBuffer();
        const imageBuffer = Buffer.from(buffer);

        // Extract colors using sharp
        const colors = await extractColorsFromImage(imageBuffer);

        logger.debug(`[COLORS] Extracted colors:`, colors);

        // Cache the result for 30 days
        try {
            await redisClient.setEx(
                cacheKey,
                30 * 24 * 60 * 60, // 30 days
                JSON.stringify(colors)
            );
            logger.debug(`[COLORS] Cached colors for 30 days`);
        } catch (cacheError) {
            logger.warn("[COLORS] Redis cache write error:", cacheError);
        }

        res.json(colors);
    } catch (error) {
        logger.error("Extract colors error:", error);
        res.status(500).json({ error: "Failed to extract colors" });
    }
});

// GET /library/tracks/:id/stream
router.get("/tracks/:id/stream", async (req, res) => {
    try {
        const trackId = req.params.id;
        logger.debug("[STREAM] Request received for track:", trackId);
        const { quality } = req.query;
        const userId = req.user?.id;

        if (!userId) {
            logger.debug("[STREAM] No userId in session - unauthorized");
            return res.status(401).json({ error: "Unauthorized" });
        }

        if (trackId.startsWith("jellyfin:")) {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
            const rawId = trackId.slice("jellyfin:".length);
            const recentPlay = await prisma.play.findFirst({
                where: {
                    userId,
                    trackId,
                    playedAt: { gte: new Date(Date.now() - 30 * 1000) },
                },
                orderBy: { playedAt: "desc" },
            });
            if (!recentPlay) {
                await prisma.play.create({
                    data: { userId, trackId },
                });
            }
            const settings = await getSystemSettings();
            const proxyStreams = !!settings?.jellyfinProxyStreams;
            if (proxyStreams) {
                try {
                    const rangeHeader = req.headers.range as string | undefined;
                    const { stream, headers, status } = await streamJellyfinAudio(
                        cfg,
                        rawId,
                        rangeHeader
                    );
                    const responseStatus = status || (rangeHeader ? 206 : 200);
                    res.status(responseStatus);
                    res.setHeader(
                        "Content-Type",
                        headers["content-type"] || "audio/mpeg"
                    );
                    if (headers["content-length"])
                        res.setHeader("Content-Length", headers["content-length"]);
                    if (headers["accept-ranges"])
                        res.setHeader("Accept-Ranges", headers["accept-ranges"]);
                    if (headers["content-range"])
                        res.setHeader("Content-Range", headers["content-range"]);
                    res.setHeader("Cache-Control", "public, max-age=0");
                    res.on("close", () => {
                        if (!stream.destroyed) stream.destroy();
                    });
                    stream.pipe(res);
                    stream.on("error", (err: Error) => {
                        logger.error("[STREAM] Jellyfin proxy stream error:", err.message);
                        if (!res.headersSent) {
                            res.status(503).json({
                                error: JELLYFIN_UNREACHABLE_MESSAGE,
                                jellyfin: true,
                            });
                        } else {
                            res.end();
                        }
                    });
                    return;
                } catch (err: any) {
                    logger.error("[STREAM] Jellyfin proxy failed:", err?.message);
                    return res.status(503).json({
                        error: JELLYFIN_UNREACHABLE_MESSAGE,
                        jellyfin: true,
                    });
                }
            }
            const streamUrl = await getJellyfinStreamUrl(cfg, rawId);
            return res.redirect(302, streamUrl);
        }

        const track = await prisma.track.findUnique({
            where: { id: trackId },
        });

        if (!track) {
            logger.debug("[STREAM] Track not found");
            return res.status(404).json({ error: "Track not found" });
        }

        // Log play start - only if this is a new playback session
        const recentPlay = await prisma.play.findFirst({
            where: {
                userId,
                trackId: track.id,
                playedAt: {
                    gte: new Date(Date.now() - 30 * 1000),
                },
            },
            orderBy: { playedAt: "desc" },
        });

        if (!recentPlay) {
            await prisma.play.create({
                data: {
                    userId,
                    trackId: track.id,
                },
            });
            logger.debug("[STREAM] Logged new play for track:", track.title);
        }

        // Get user's quality preference
        let requestedQuality: string = "medium";
        if (quality) {
            requestedQuality = quality as string;
        } else {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
            });
            requestedQuality = settings?.playbackQuality || "medium";
        }

        const ext = track.filePath
            ? path.extname(track.filePath).toLowerCase()
            : "";
        logger.debug(
            `[STREAM] Quality: requested=${
                quality || "default"
            }, using=${requestedQuality}, format=${ext}`
        );

        // === NATIVE FILE STREAMING ===
        // Check if track has native file path
        if (track.filePath && track.fileModified) {
            try {
                // Initialize streaming service
                const streamingService = new AudioStreamingService(
                    config.music.musicPath,
                    config.music.transcodeCachePath,
                    config.music.transcodeCacheMaxGb
                );

                // Get absolute path to source file
                // Normalize path separators for cross-platform compatibility (Windows -> Linux)
                const normalizedFilePath = track.filePath.replace(/\\/g, "/");
                const absolutePath = path.join(
                    config.music.musicPath,
                    normalizedFilePath
                );

                logger.debug(
                    `[STREAM] Using native file: ${track.filePath} (${requestedQuality})`
                );

                // Get stream file (either original or transcoded). Pass the
                // DB-known fileSize and duration so the bitrate-vs-target
                // upsampling check can be done arithmetically instead of
                // re-parsing the entire audio file with music-metadata on
                // every transcode request (was a hot-path event-loop blocker).
                const { filePath, mimeType } =
                    await streamingService.getStreamFilePath(
                        track.id,
                        requestedQuality as any,
                        track.fileModified,
                        absolutePath,
                        track.fileSize,
                        track.duration
                    );

                // Stream file with range support
                logger.debug(
                    `[STREAM] Sending file: ${filePath}, mimeType: ${mimeType}`
                );

                await streamingService.streamFileWithRangeSupport(
                    req,
                    res,
                    filePath,
                    mimeType
                );
                streamingService.destroy();
                logger.debug(
                    `[STREAM] File sent successfully: ${path.basename(
                        filePath
                    )}`
                );

                return;
            } catch (err: any) {
                // If FFmpeg not found, try original quality instead
                if (
                    err.code === "FFMPEG_NOT_FOUND" &&
                    requestedQuality !== "original"
                ) {
                    logger.warn(
                        `[STREAM] FFmpeg not available, falling back to original quality`
                    );
                    const fallbackFilePath = track.filePath.replace(/\\/g, "/");
                    const absolutePath = path.join(
                        config.music.musicPath,
                        fallbackFilePath
                    );

                    const streamingService = new AudioStreamingService(
                        config.music.musicPath,
                        config.music.transcodeCachePath,
                        config.music.transcodeCacheMaxGb
                    );

                    const { filePath, mimeType } =
                        await streamingService.getStreamFilePath(
                            track.id,
                            "original",
                            track.fileModified,
                            absolutePath,
                            track.fileSize,
                            track.duration
                        );

                    await streamingService.streamFileWithRangeSupport(
                        req,
                        res,
                        filePath,
                        mimeType
                    );
                    streamingService.destroy();
                    return;
                }

                logger.error("[STREAM] Native streaming failed:", err.message);
                return res
                    .status(500)
                    .json({ error: "Failed to stream track" });
            }
        }

        // No file path available
        logger.debug("[STREAM] Track has no file path - unavailable");
        return res.status(404).json({ error: "Track not available" });
    } catch (error) {
        logger.error("Stream track error:", error);
        res.status(500).json({ error: "Failed to stream track" });
    }
});

export default router;
