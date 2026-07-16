/**
 * Lidarr Webhook Handler (Refactored)
 *
 * Handles Lidarr webhooks for download tracking and Discovery Weekly integration.
 * Uses the stateless simpleDownloadManager for all operations.
 */

import { Router } from "express";
import crypto from "crypto";
import { scanQueue } from "../workers/queues";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const router = Router();

/**
 * Constant-time comparison of two secrets that avoids leaking length or
 * content via timing. Returns false for any length mismatch.
 */
function timingSafeMatch(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Extract the webhook secret from the request. Supports:
 *  - X-Webhook-Secret header (manual configuration)
 *  - HTTP Basic auth password (what our Lidarr auto-configure sets, since
 *    Lidarr's webhook notification has username/password fields but no
 *    custom-header support)
 */
function extractWebhookSecret(req: { headers: Record<string, unknown> }): string {
    const headerSecret = req.headers["x-webhook-secret"];
    if (typeof headerSecret === "string" && headerSecret) {
        return headerSecret;
    }

    const authHeader = req.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Basic ")) {
        try {
            const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
            const separator = decoded.indexOf(":");
            if (separator >= 0) {
                return decoded.slice(separator + 1);
            }
        } catch {
            // fall through — treated as missing secret
        }
    }

    return "";
}

// GET /webhooks/lidarr/verify - Webhook verification endpoint
router.get("/lidarr/verify", (req, res) => {
    logger.debug("[WEBHOOK] Verification request received");
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "lidifin",
        version: process.env.npm_package_version || "unknown",
    });
});

// POST /webhooks/lidarr - Handle Lidarr webhooks
router.post("/lidarr", async (req, res) => {
    try {
        // Check if Lidarr is enabled before processing any webhooks
        const settings = await getSystemSettings();
        if (
            !settings?.lidarrEnabled ||
            !settings?.lidarrUrl ||
            !settings?.lidarrApiKey
        ) {
            logger.debug(
                `[WEBHOOK] Lidarr webhook received but Lidarr is disabled. Ignoring.`
            );
            return res.status(202).json({
                success: true,
                ignored: true,
                reason: "lidarr-disabled",
            });
        }

        // Verify the webhook secret. This endpoint is unauthenticated (Lidarr
        // has no session), so the shared secret is the ONLY thing preventing an
        // attacker from forging download/scan side effects. A secret is
        // therefore mandatory — if none is configured we refuse to process.
        // Note: settings.lidarrWebhookSecret is already decrypted by getSystemSettings()
        const configuredSecret = settings.lidarrWebhookSecret;
        if (!configuredSecret) {
            logger.warn(
                "[WEBHOOK] Rejected Lidarr webhook: no webhook secret is configured. " +
                    "Set a secret in Settings and configure Lidarr to send it as the X-Webhook-Secret header."
            );
            return res.status(401).json({
                error: "Webhook secret not configured",
            });
        }

        const providedSecret = extractWebhookSecret(req);
        if (!timingSafeMatch(providedSecret, configuredSecret)) {
            logger.debug(
                `[WEBHOOK] Lidarr webhook received with invalid or missing secret`
            );
            return res.status(401).json({
                error: "Unauthorized - Invalid webhook secret",
            });
        }

        const eventType = req.body.eventType;
        logger.debug(`[WEBHOOK] Lidarr event: ${eventType}`);

        // Log payload in debug mode only (avoid verbose logs in production)
        if (process.env.DEBUG_WEBHOOKS === "true") {
            logger.debug(`   Payload:`, JSON.stringify(req.body, null, 2));
        }

        switch (eventType) {
            case "Grab":
                await handleGrab(req.body);
                break;

            case "Download":
            case "AlbumDownload":
            case "TrackRetag":
            case "Rename":
                await handleDownload(req.body);
                break;

            case "ImportFailure":
            case "DownloadFailed":
            case "DownloadFailure":
                await handleImportFailure(req.body);
                break;

            case "Health":
            case "HealthIssue":
            case "HealthRestored":
                // Ignore health events
                break;

            case "Test":
                logger.debug("   Lidarr test webhook received");
                break;

            default:
                logger.debug(`   Unhandled event: ${eventType}`);
        }

        res.json({ success: true });
    } catch (error: any) {
        logger.error("Webhook error:", error.message);
        res.status(500).json({ error: "Webhook processing failed" });
    }
});

/**
 * Handle Grab event (download started by Lidarr)
 */
async function handleGrab(payload: any) {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.albums?.[0]?.foreignAlbumId || payload.albums?.[0]?.mbId;
    const albumTitle = payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const lidarrAlbumId = payload.albums?.[0]?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   MBID: ${albumMbid}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return;
    }

    // Use the download manager's multi-strategy matching
    const result = await simpleDownloadManager.onDownloadGrabbed(
        downloadId,
        albumMbid || "",
        albumTitle || "",
        artistName || "",
        lidarrAlbumId || 0
    );

    if (result.matched) {
        // Start queue cleaner to monitor this download
        queueCleaner.start();
    }
}

/**
 * Handle Download event (download complete + imported)
 */
async function handleDownload(payload: any) {
    const downloadId = payload.downloadId;
    const albumTitle = payload.album?.title || payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const lidarrAlbumId = payload.album?.id || payload.albums?.[0]?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Album MBID: ${albumMbid}`);
    logger.debug(`   Lidarr Album ID: ${lidarrAlbumId}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return;
    }

    // Handle completion through download manager
    const result = await simpleDownloadManager.onDownloadComplete(
        downloadId,
        albumMbid,
        artistName,
        albumTitle,
        lidarrAlbumId
    );

    if (result.jobId) {
        // Find the download job that triggered this webhook to get userId
        const downloadJob = await prisma.downloadJob.findUnique({
            where: { id: result.jobId },
            select: { userId: true, id: true },
        });

        // Trigger scan immediately for this album (incremental scan with enrichment data)
        // Don't wait for batch completion - enrichment should happen per-album
        logger.debug(
            `   Triggering incremental scan for: ${artistName} - ${albumTitle}`
        );
        await scanQueue.add("scan", {
            userId: downloadJob?.userId || null,
            source: "lidarr-webhook",
            artistName: artistName,
            albumMbid: albumMbid,
            downloadId: result.jobId,
        });

        // Discovery batch completion (for playlist building) is handled by download manager
    } else {
        // No job found - this might be an external download not initiated by us
        // Still trigger a scan to pick up the new music
        logger.debug(`   No matching job, triggering scan anyway...`);
        await scanQueue.add("scan", {
            type: "full",
            source: "lidarr-import-external",
        });
    }
}

/**
 * Handle import failure with automatic retry
 */
async function handleImportFailure(payload: any) {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const albumTitle = payload.album?.title || payload.release?.title;
    const reason = payload.message || "Import failed";

    logger.debug(`   Album: ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Reason: ${reason}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return;
    }

    // Handle failure through download manager (handles retry logic)
    await simpleDownloadManager.onImportFailed(downloadId, reason, albumMbid);
}

export default router;
