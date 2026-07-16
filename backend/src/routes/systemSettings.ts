import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { writeEnvFile } from "../utils/envWriter";
import {
    invalidateSystemSettingsCache,
    getSystemSettings,
} from "../utils/systemSettings";
import { queueCleaner } from "../jobs/queueCleaner";
import { encrypt } from "../utils/encryption";

const router = Router();

// Only admins can access system settings
router.use(requireAuth);
router.use(requireAdmin);

const systemSettingsSchema = z.object({
    // Download Services
    lidarrEnabled: z.boolean().optional(),
    lidarrUrl: z.string().optional(),
    lidarrApiKey: z.string().nullable().optional(),
    lidarrWebhookSecret: z.string().nullable().optional(),

    // AI Services
    openaiEnabled: z.boolean().optional(),
    openaiApiKey: z.string().nullable().optional(),
    openaiModel: z.string().optional(),
    openaiBaseUrl: z.string().nullable().optional(),

    fanartEnabled: z.boolean().optional(),
    fanartApiKey: z.string().nullable().optional(),

    lastfmApiKey: z.string().nullable().optional(),

    // Media Services
    audiobookshelfEnabled: z.boolean().optional(),
    audiobookshelfUrl: z.string().optional(),
    audiobookshelfApiKey: z.string().nullable().optional(),

    // Jellyfin (Lidifin - music library and streaming)
    jellyfinEnabled: z.boolean().optional(),
    jellyfinUrl: z.string().nullable().optional(),
    jellyfinApiKey: z.string().nullable().optional(),
    jellyfinUsername: z.string().nullable().optional(),
    jellyfinPassword: z.string().nullable().optional(),
    jellyfinUserId: z.string().nullable().optional(),
    jellyfinProxyStreams: z.boolean().optional(),

    // AudioMuse-AI (instant playlist from mood/vibe)
    audiomuseEnabled: z.boolean().optional(),
    audiomuseUrl: z.string().nullable().optional(),
    audiomuseAiProvider: z.string().nullable().optional(),
    audiomuseAiModel: z.string().nullable().optional(),
    audiomuseApiKey: z.string().nullable().optional(),
    audiomuseOllamaUrl: z.string().nullable().optional(),

    // Soulseek (direct connection via slsk-client)
    soulseekUsername: z.string().nullable().optional(),
    soulseekPassword: z.string().nullable().optional(),

    // Spotify (for playlist import)
    spotifyClientId: z.string().nullable().optional(),
    spotifyClientSecret: z.string().nullable().optional(),

    // Storage Paths
    musicPath: z.string().optional(),
    downloadPath: z.string().optional(),

    // Feature Flags
    autoSync: z.boolean().optional(),
    autoEnrichMetadata: z.boolean().optional(),

    // Advanced Settings
    maxConcurrentDownloads: z.number().optional(),
    downloadRetryAttempts: z.number().optional(),
    transcodeCacheMaxGb: z.number().optional(),
    soulseekConcurrentDownloads: z.number().min(1).max(10).optional(),

    // Download Preferences
    downloadSource: z.enum(["soulseek", "lidarr"]).optional(),
    primaryFailureFallback: z.enum(["none", "lidarr", "soulseek"]).optional(),
});

// GET /system-settings
router.get("/", async (req, res) => {
    try {
        let settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
        });

        // Create default settings if they don't exist
        if (!settings) {
            settings = await prisma.systemSettings.create({
                data: {
                    id: "default",
                    lidarrEnabled: true,
                    lidarrUrl: "http://localhost:8686",
                    openaiEnabled: false,
                    openaiModel: "gpt-4",
                    fanartEnabled: false,
                    audiobookshelfEnabled: false,
                    audiobookshelfUrl: "http://localhost:13378",
                    musicPath: "/music",
                    downloadPath: "/downloads",
                    autoSync: true,
                    autoEnrichMetadata: true,
                    maxConcurrentDownloads: 3,
                    downloadRetryAttempts: 3,
                    transcodeCacheMaxGb: 10,
                },
            });
        }

        // SECURITY: never send stored secrets back to the client. Secrets are
        // write-only from the API's perspective — the client sees whether a
        // value is configured (`<field>Set: true`) but never its plaintext.
        // This keeps a compromised/XSS'd admin browser from exfiltrating every
        // integration credential in one GET.
        const isSet = (value: string | null | undefined): boolean =>
            !!(value && String(value).trim() !== "");

        const jellyfinApiKeyFromEnv =
            process.env.JELLYFIN_API_KEY != null &&
            process.env.JELLYFIN_API_KEY !== "";

        const maskedSettings = {
            ...settings,
            // Blank out every secret field...
            lidarrApiKey: "",
            lidarrWebhookSecret: "",
            openaiApiKey: "",
            fanartApiKey: "",
            lastfmApiKey: "",
            audiobookshelfApiKey: "",
            soulseekPassword: "",
            spotifyClientSecret: "",
            audiomuseApiKey: "",
            jellyfinApiKey: "",
            jellyfinPassword: "",
            jellyfinUsername: settings.jellyfinUsername ?? undefined,
            jellyfinUserId: settings.jellyfinUserId ?? undefined,
            // ...and expose only whether each is configured.
            lidarrApiKeySet: isSet(settings.lidarrApiKey),
            lidarrWebhookSecretSet: isSet(settings.lidarrWebhookSecret),
            openaiApiKeySet: isSet(settings.openaiApiKey),
            fanartApiKeySet: isSet(settings.fanartApiKey),
            lastfmApiKeySet: isSet(settings.lastfmApiKey),
            audiobookshelfApiKeySet: isSet(settings.audiobookshelfApiKey),
            soulseekPasswordSet: isSet(settings.soulseekPassword),
            spotifyClientSecretSet: isSet(settings.spotifyClientSecret),
            audiomuseApiKeySet: isSet(settings.audiomuseApiKey),
            jellyfinApiKeySet:
                jellyfinApiKeyFromEnv || isSet(settings.jellyfinApiKey),
            jellyfinPasswordSet: isSet(settings.jellyfinPassword),
            jellyfinApiKeyFromEnv: jellyfinApiKeyFromEnv || undefined,
        };

        res.json(maskedSettings);
    } catch (error) {
        logger.error("Get system settings error:", error);
        res.status(500).json({ error: "Failed to get system settings" });
    }
});

// POST /system-settings
router.post("/", async (req, res) => {
    try {
        const data = systemSettingsSchema.parse(req.body);

        if (data.jellyfinEnabled) {
            if (!data.jellyfinUrl?.trim()) {
                return res.status(400).json({
                    error: "Jellyfin URL is required when Jellyfin is enabled",
                });
            }
            if (!data.jellyfinUserId?.trim()) {
                return res.status(400).json({
                    error: "Jellyfin User ID is required when Jellyfin is enabled",
                });
            }
        }

        logger.debug("[SYSTEM SETTINGS] Saving settings...");
        logger.debug(
            "[SYSTEM SETTINGS] transcodeCacheMaxGb:",
            data.transcodeCacheMaxGb
        );

        // Secrets are write-only. The client never receives stored secrets
        // (see the GET handler), so it echoes back an empty string for any
        // secret it isn't changing. Treat empty/undefined as "keep existing"
        // and only encrypt + persist secrets that were actually provided.
        // This prevents a normal settings save from wiping stored credentials.
        const SECRET_FIELDS = [
            "lidarrApiKey",
            "lidarrWebhookSecret",
            "openaiApiKey",
            "fanartApiKey",
            "lastfmApiKey",
            "audiobookshelfApiKey",
            "soulseekPassword",
            "spotifyClientSecret",
            "audiomuseApiKey",
            "jellyfinApiKey",
            "jellyfinPassword",
        ] as const;

        const encryptedData: any = { ...data };

        for (const field of SECRET_FIELDS) {
            const value = (data as Record<string, unknown>)[field];
            if (typeof value === "string" && value.trim() !== "") {
                encryptedData[field] = encrypt(value);
            } else {
                // Not provided (or blank) — never overwrite the stored secret.
                delete encryptedData[field];
            }
        }

        if (data.jellyfinUsername !== undefined)
            encryptedData.jellyfinUsername = data.jellyfinUsername || null;
        if (data.jellyfinUserId !== undefined)
            encryptedData.jellyfinUserId = data.jellyfinUserId || null;

        const settings = await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: {
                id: "default",
                ...encryptedData,
            },
            update: encryptedData,
        });

        invalidateSystemSettingsCache();

        // Clear Jellyfin auth caches when credentials change so next request uses new token/user
        if (
            data.jellyfinUrl !== undefined ||
            data.jellyfinApiKey !== undefined ||
            data.jellyfinUsername !== undefined ||
            data.jellyfinPassword !== undefined ||
            data.jellyfinUserId !== undefined
        ) {
            try {
                const { clearJellyfinSessionCache } = await import("../services/jellyfin");
                clearJellyfinSessionCache();
            } catch (err) {
                logger.warn("Failed to clear Jellyfin session cache:", err);
            }
        }

        // Refresh Last.fm API key if it was updated
        try {
            const { lastFmService } = await import("../services/lastfm");
            await lastFmService.refreshApiKey();
        } catch (err) {
            logger.warn("Failed to refresh Last.fm API key:", err);
        }

        // Disconnect Soulseek if credentials changed
        if (
            data.soulseekUsername !== undefined ||
            data.soulseekPassword !== undefined
        ) {
            try {
                const { soulseekService } = await import(
                    "../services/soulseek"
                );
                soulseekService.disconnect();
                logger.debug(
                    "[SYSTEM SETTINGS] Disconnected Soulseek service due to credential update"
                );
            } catch (err) {
                logger.warn("Failed to disconnect Soulseek service:", err);
            }
        }

        // If Audiobookshelf was disabled, clear all audiobook-related data
        if (data.audiobookshelfEnabled === false) {
            logger.debug(
                "[CLEANUP] Audiobookshelf disabled - clearing all audiobook data from database"
            );
            try {
                const deletedProgress =
                    await prisma.audiobookProgress.deleteMany({});
                logger.debug(
                    `   Deleted ${deletedProgress.count} audiobook progress entries`
                );
            } catch (clearError) {
                logger.error("Failed to clear audiobook data:", clearError);
                // Don't fail the request
            }
        }

        // Write to .env file for Docker containers
        try {
            await writeEnvFile({
                LIDARR_ENABLED: data.lidarrEnabled ? "true" : "false",
                LIDARR_URL: data.lidarrUrl || null,
                LIDARR_API_KEY: data.lidarrApiKey || null,
                FANART_API_KEY: data.fanartApiKey || null,
                OPENAI_API_KEY: data.openaiApiKey || null,
                AUDIOBOOKSHELF_URL: data.audiobookshelfUrl || null,
                AUDIOBOOKSHELF_API_KEY: data.audiobookshelfApiKey || null,
                SOULSEEK_USERNAME: data.soulseekUsername || null,
                SOULSEEK_PASSWORD: data.soulseekPassword || null,
            });
            logger.debug(".env file synchronized with database settings");
        } catch (envError) {
            logger.error("Failed to write .env file:", envError);
            // Don't fail the request if .env write fails
        }

        // Auto-configure Lidarr webhook if Lidarr is enabled
        if (data.lidarrEnabled && data.lidarrUrl && data.lidarrApiKey) {
            try {
                logger.debug("[LIDARR] Auto-configuring webhook...");

                const axios = (await import("axios")).default;
                const lidarrUrl = data.lidarrUrl;
                const apiKey = data.lidarrApiKey;

                // Determine webhook URL
                // Use LIDIFIN_CALLBACK_URL (or legacy LIDIFY_CALLBACK_URL) if set, otherwise default to backend:3006
                // In Docker, services communicate via Docker network names (backend, lidarr, etc.)
                const callbackHost =
                    process.env.LIDIFIN_CALLBACK_URL ||
                    process.env.LIDIFY_CALLBACK_URL ||
                    "http://backend:3006";
                const webhookUrl = `${callbackHost}/api/webhooks/lidarr`;

                logger.debug(`   Webhook URL: ${webhookUrl}`);

                // The webhook endpoint requires a shared secret (it is
                // otherwise unauthenticated). Ensure one exists — generate it
                // on first configure — and hand it to Lidarr as the webhook's
                // Basic-auth password, which our handler verifies.
                const crypto = await import("crypto");
                let webhookSecret =
                    (await getSystemSettings(true))?.lidarrWebhookSecret || "";
                if (!webhookSecret) {
                    webhookSecret = crypto.randomBytes(32).toString("hex");
                    await prisma.systemSettings.update({
                        where: { id: "default" },
                        data: { lidarrWebhookSecret: encrypt(webhookSecret) },
                    });
                    invalidateSystemSettingsCache();
                    logger.debug("   Generated new Lidarr webhook secret");
                }

                // Check if webhook already exists - find by name "Lidifin" (or legacy "Lidify") OR by URL containing "lidifin"/"lidify" or "webhooks/lidarr"
                const notificationsResponse = await axios.get(
                    `${lidarrUrl}/api/v1/notification`,
                    {
                        headers: { "X-Api-Key": apiKey },
                        timeout: 10000,
                    }
                );

                // Find existing Lidifin webhook by name (primary) or URL pattern (fallback)
                const existingWebhook = notificationsResponse.data.find(
                    (n: any) =>
                        n.implementation === "Webhook" &&
                        // Match by name
                        (n.name === "Lidifin" ||
                            n.name === "Lidify" ||
                            // Or match by URL pattern (catches old webhooks with different URLs)
                            n.fields?.find(
                                (f: any) =>
                                    f.name === "url" &&
                                    (f.value?.includes("webhooks/lidarr") ||
                                        f.value?.includes("lidifin") ||
                                        f.value?.includes("lidify"))
                            ))
                );

                if (existingWebhook) {
                    const currentUrl = existingWebhook.fields?.find(
                        (f: any) => f.name === "url"
                    )?.value;
                    logger.debug(
                        `   Found existing webhook: "${existingWebhook.name}" with URL: ${currentUrl}`
                    );
                    if (currentUrl !== webhookUrl) {
                        logger.debug(
                            `   URL needs updating from: ${currentUrl}`
                        );
                        logger.debug(
                            `   URL will be updated to: ${webhookUrl}`
                        );
                    }
                }

                const webhookConfig = {
                    onGrab: true,
                    onReleaseImport: true,
                    onAlbumDownload: true,
                    onDownloadFailure: true,
                    onImportFailure: true,
                    onAlbumDelete: true,
                    onRename: true,
                    onHealthIssue: false,
                    onApplicationUpdate: false,
                    supportsOnGrab: true,
                    supportsOnReleaseImport: true,
                    supportsOnAlbumDownload: true,
                    supportsOnDownloadFailure: true,
                    supportsOnImportFailure: true,
                    supportsOnAlbumDelete: true,
                    supportsOnRename: true,
                    supportsOnHealthIssue: true,
                    supportsOnApplicationUpdate: true,
                    includeHealthWarnings: false,
                    name: "Lidifin",
                    implementation: "Webhook",
                    implementationName: "Webhook",
                    configContract: "WebhookSettings",
                    infoLink:
                        "https://wiki.servarr.com/lidarr/supported#webhook",
                    tags: [],
                    fields: [
                        { name: "url", value: webhookUrl },
                        { name: "method", value: 1 }, // 1 = POST
                        // Lidarr sends these as HTTP Basic auth; the webhook
                        // handler verifies the password as the shared secret.
                        { name: "username", value: "lidifin" },
                        { name: "password", value: webhookSecret },
                    ],
                };

                if (existingWebhook) {
                    // Update existing webhook
                    await axios.put(
                        `${lidarrUrl}/api/v1/notification/${existingWebhook.id}?forceSave=true`,
                        { ...existingWebhook, ...webhookConfig },
                        {
                            headers: { "X-Api-Key": apiKey },
                            timeout: 10000,
                        }
                    );
                    logger.debug("   Webhook updated");
                } else {
                    // Create new webhook (use forceSave to skip test)
                    await axios.post(
                        `${lidarrUrl}/api/v1/notification?forceSave=true`,
                        webhookConfig,
                        {
                            headers: { "X-Api-Key": apiKey },
                            timeout: 10000,
                        }
                    );
                    logger.debug("   Webhook created");
                }

                logger.debug("Lidarr webhook configured automatically\n");
            } catch (webhookError: any) {
                logger.error(
                    "Failed to auto-configure webhook:",
                    webhookError.message
                );
                if (webhookError.response?.data) {
                    logger.error(
                        "   Lidarr error details:",
                        JSON.stringify(webhookError.response.data, null, 2)
                    );
                }
                logger.debug(
                    " User can configure webhook manually in Lidarr UI\n"
                );
                // Don't fail the request if webhook config fails
            }
        }

        res.json({
            success: true,
            message:
                "Settings saved successfully. Restart Docker containers to apply changes.",
            requiresRestart: true,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid settings", details: error.errors });
        }
        logger.error("Update system settings error:", error);
        res.status(500).json({ error: "Failed to update system settings" });
    }
});

// POST /system-settings/test-lidarr
router.post("/test-lidarr", async (req, res) => {
    try {
        let { url, apiKey } = req.body;

        // Fall back to the stored secret when the client omits it (secrets are
        // no longer sent to the client, so the field is blank when unchanged).
        if (!apiKey || !String(apiKey).trim()) {
            const stored = await getSystemSettings();
            apiKey = stored?.lidarrApiKey || apiKey;
            if (!url) url = stored?.lidarrUrl || url;
        }

        logger.debug("[Lidarr Test] Testing connection to:", url);

        if (!url || !apiKey) {
            return res
                .status(400)
                .json({ error: "URL and API key are required" });
        }

        // Normalize URL - remove trailing slash
        const normalizedUrl = url.replace(/\/+$/, "");

        const axios = require("axios");
        const response = await axios.get(
            `${normalizedUrl}/api/v1/system/status`,
            {
                headers: { "X-Api-Key": apiKey },
                timeout: 10000,
            }
        );

        logger.debug(
            "[Lidarr Test] Connection successful, version:",
            response.data.version
        );

        res.json({
            success: true,
            message: "Lidarr connection successful",
            version: response.data.version,
        });
    } catch (error: any) {
        logger.error("[Lidarr Test] Error:", error.message);
        logger.error(
            "[Lidarr Test] Details:",
            error.response?.data || error.code
        );

        let details = error.message;
        if (error.code === "ECONNREFUSED") {
            details =
                "Connection refused - check if Lidarr is running and accessible";
        } else if (error.code === "ENOTFOUND") {
            details = "Host not found - check the URL";
        } else if (error.response?.status === 401) {
            details = "Invalid API key";
        } else if (error.response?.data?.message) {
            details = error.response.data.message;
        }

        res.status(500).json({
            error: "Failed to connect to Lidarr",
            details,
        });
    }
});

// POST /system-settings/test-openai
router.post("/test-openai", async (req, res) => {
    try {
        let { apiKey } = req.body;
        const { model } = req.body;

        if (!apiKey || !String(apiKey).trim()) {
            const stored = await getSystemSettings();
            apiKey = stored?.openaiApiKey || apiKey;
        }

        if (!apiKey) {
            return res.status(400).json({ error: "API key is required" });
        }

        const axios = require("axios");
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: model || "gpt-3.5-turbo",
                messages: [{ role: "user", content: "Test" }],
                max_tokens: 5,
            },
            {
                headers: { Authorization: `Bearer ${apiKey}` },
                timeout: 10000,
            }
        );

        res.json({
            success: true,
            message: "OpenAI connection successful",
            model: response.data.model,
        });
    } catch (error: any) {
        logger.error("OpenAI test error:", error.message);
        res.status(500).json({
            error: "Failed to connect to OpenAI",
            details: error.response?.data?.error?.message || error.message,
        });
    }
});

// Test Fanart.tv connection
router.post("/test-fanart", async (req, res) => {
    try {
        let { fanartApiKey } = req.body;

        if (!fanartApiKey || !String(fanartApiKey).trim()) {
            const stored = await getSystemSettings();
            fanartApiKey = stored?.fanartApiKey || fanartApiKey;
        }

        if (!fanartApiKey) {
            return res.status(400).json({ error: "API key is required" });
        }

        const axios = require("axios");

        // Test with a known artist (The Beatles MBID)
        const testMbid = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";

        const response = await axios.get(
            `https://webservice.fanart.tv/v3/music/${testMbid}`,
            {
                params: { api_key: fanartApiKey },
                timeout: 5000,
            }
        );

        // If we get here, the API key is valid
        res.json({
            success: true,
            message: "Fanart.tv connection successful",
        });
    } catch (error: any) {
        logger.error("Fanart.tv test error:", error.message);
        if (error.response?.status === 401) {
            res.status(401).json({
                error: "Invalid Fanart.tv API key",
            });
        } else {
            res.status(500).json({
                error: "Failed to connect to Fanart.tv",
                details: error.response?.data || error.message,
            });
        }
    }
});

// Test Last.fm connection
router.post("/test-lastfm", async (req, res) => {
    try {
        let { lastfmApiKey } = req.body;

        if (!lastfmApiKey || !String(lastfmApiKey).trim()) {
            const stored = await getSystemSettings();
            lastfmApiKey = stored?.lastfmApiKey || lastfmApiKey;
        }

        if (!lastfmApiKey) {
            return res.status(400).json({ error: "API key is required" });
        }

        const axios = require("axios");

        // Test with a known artist (The Beatles)
        const testArtist = "The Beatles";

        const response = await axios.get("http://ws.audioscrobbler.com/2.0/", {
            params: {
                method: "artist.getinfo",
                artist: testArtist,
                api_key: lastfmApiKey,
                format: "json",
            },
            timeout: 5000,
        });

        // If we get here and have artist data, the API key is valid
        if (response.data.artist) {
            res.json({
                success: true,
                message: "Last.fm connection successful",
            });
        } else {
            res.status(500).json({
                error: "Unexpected response from Last.fm",
            });
        }
    } catch (error: any) {
        logger.error("Last.fm test error:", error.message);
        if (
            error.response?.status === 403 ||
            error.response?.data?.error === 10
        ) {
            res.status(401).json({
                error: "Invalid Last.fm API key",
            });
        } else {
            res.status(500).json({
                error: "Failed to connect to Last.fm",
                details: error.response?.data || error.message,
            });
        }
    }
});

// Test Audiobookshelf connection
router.post("/test-audiobookshelf", async (req, res) => {
    try {
        let { url, apiKey } = req.body;

        if (!apiKey || !String(apiKey).trim()) {
            const stored = await getSystemSettings();
            apiKey = stored?.audiobookshelfApiKey || apiKey;
            if (!url) url = stored?.audiobookshelfUrl || url;
        }

        if (!url || !apiKey) {
            return res
                .status(400)
                .json({ error: "URL and API key are required" });
        }

        const axios = require("axios");

        const response = await axios.get(`${url}/api/libraries`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            timeout: 5000,
        });

        res.json({
            success: true,
            message: "Audiobookshelf connection successful",
            libraries: response.data.libraries?.length || 0,
        });
    } catch (error: any) {
        logger.error("Audiobookshelf test error:", error.message);
        if (error.response?.status === 401 || error.response?.status === 403) {
            res.status(401).json({
                error: "Invalid Audiobookshelf API key",
            });
        } else {
            res.status(500).json({
                error: "Failed to connect to Audiobookshelf",
                details: error.response?.data || error.message,
            });
        }
    }
});

// Test Jellyfin connection (Lidifin). Uses API key only (User ID is required in settings for library access).
router.post("/test-jellyfin", async (req, res) => {
    try {
        let { url, apiKey } = req.body || {};
        if (!url) {
            const settings = await getSystemSettings();
            url = settings?.jellyfinUrl;
        }
        if (!url?.trim()) {
            return res.status(400).json({ error: "Jellyfin URL is required" });
        }
        if (!apiKey?.trim()) {
            const settings = await getSystemSettings();
            if (settings?.jellyfinApiKey?.trim()) apiKey = settings.jellyfinApiKey;
        }
        const effectiveApiKey = (apiKey != null && String(apiKey).trim() !== "") ? String(apiKey).trim() : "";
        if (!effectiveApiKey) {
            return res.status(400).json({ error: "API key is required to test connection" });
        }
        const { testJellyfinConnection } = await import("../services/jellyfin");
        const result = await testJellyfinConnection(url, effectiveApiKey);
        if (result.ok) {
            return res.json({ success: true, message: "Jellyfin connection successful" });
        }
        return res.status(400).json({ error: result.error || "Connection failed" });
    } catch (error: any) {
        logger.error("Jellyfin test error:", error?.message);
        return res.status(500).json({
            error: "Failed to connect to Jellyfin",
            details: error?.message,
        });
    }
});

// Test Soulseek connection (direct via slsk-client)
router.post("/test-soulseek", async (req, res) => {
    try {
        let { password } = req.body;
        const { username } = req.body;

        if (!password || !String(password).trim()) {
            const stored = await getSystemSettings();
            password = stored?.soulseekPassword || password;
        }

        if (!username || !password) {
            return res.status(400).json({
                error: "Soulseek username and password are required",
            });
        }

        logger.debug(`[SOULSEEK-TEST] Testing connection as "${username}"...`);

        // Import soulseek service
        const { soulseekService } = await import("../services/soulseek");

        // Temporarily set credentials for test
        // The service will use the provided credentials
        try {
            // Try to connect with the provided credentials
            const slsk = require("slsk-client");

            await new Promise<void>((resolve, reject) => {
                slsk.connect(
                    {
                        user: username,
                        pass: password,
                        host: "server.slsknet.org",
                        port: 2242,
                        // slsk-client defaults to a 2s login timeout, which the
                        // slsknet server regularly exceeds; match the service.
                        timeout: 15000,
                    },
                    (err: Error | null, client: any) => {
                        if (err) {
                            logger.debug(
                                `[SOULSEEK-TEST] Connection failed: ${err.message}`
                            );
                            return reject(err);
                        }
                        logger.debug(`[SOULSEEK-TEST] Connected successfully`);
                        // Disconnect the test client to avoid socket leak
                        try {
                            if (client && typeof client.destroy === "function") {
                                client.destroy();
                            } else if (client && typeof client.disconnect === "function") {
                                client.disconnect();
                            }
                        } catch (_) { /* best-effort cleanup */ }
                        resolve();
                    }
                );
            });

            res.json({
                success: true,
                message: `Connected to Soulseek as "${username}"`,
                soulseekUsername: username,
                isConnected: true,
            });
        } catch (connectError: any) {
            logger.error(`[SOULSEEK-TEST] Error: ${connectError.message}`);
            res.status(401).json({
                error: "Invalid Soulseek credentials or connection failed",
                details: connectError.message,
            });
        }
    } catch (error: any) {
        logger.error("[SOULSEEK-TEST] Error:", error.message);
        res.status(500).json({
            error: "Failed to test Soulseek connection",
            details: error.message,
        });
    }
});

// Test Spotify credentials
router.post("/test-spotify", async (req, res) => {
    try {
        let { clientSecret } = req.body;
        const { clientId } = req.body;

        if (!clientSecret || !String(clientSecret).trim()) {
            const stored = await getSystemSettings();
            clientSecret = stored?.spotifyClientSecret || clientSecret;
        }

        if (!clientId || !clientSecret) {
            return res.status(400).json({
                error: "Client ID and Client Secret are required",
            });
        }

        // Test credentials by trying to get an access token
        const axios = require("axios");
        try {
            const response = await axios.post(
                "https://accounts.spotify.com/api/token",
                "grant_type=client_credentials",
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Authorization: `Basic ${Buffer.from(
                            `${clientId}:${clientSecret}`
                        ).toString("base64")}`,
                    },
                    timeout: 10000,
                }
            );

            if (response.data.access_token) {
                res.json({
                    success: true,
                    message: "Spotify credentials are valid",
                });
            } else {
                res.status(401).json({
                    error: "Invalid Spotify credentials",
                });
            }
        } catch (tokenError: any) {
            res.status(401).json({
                error: "Invalid Spotify credentials",
                details:
                    tokenError.response?.data?.error_description ||
                    tokenError.message,
            });
        }
    } catch (error: any) {
        logger.error("Spotify test error:", error.message);
        res.status(500).json({
            error: "Failed to test Spotify credentials",
            details: error.message,
        });
    }
});

// Get queue cleaner status
router.get("/queue-cleaner-status", (req, res) => {
    res.json(queueCleaner.getStatus());
});

// Start queue cleaner manually
router.post("/queue-cleaner/start", async (req, res) => {
    try {
        await queueCleaner.start();
        res.json({
            success: true,
            message: "Queue cleaner started",
            status: queueCleaner.getStatus(),
        });
    } catch (error: any) {
        res.status(500).json({
            error: "Failed to start queue cleaner",
            details: error.message,
        });
    }
});

// Stop queue cleaner manually
router.post("/queue-cleaner/stop", (req, res) => {
    queueCleaner.stop();
    res.json({
        success: true,
        message: "Queue cleaner stopped",
        status: queueCleaner.getStatus(),
    });
});

// Clear all Redis caches
router.post("/clear-caches", async (req, res) => {
    try {
        const { redisClient } = require("../utils/redis");
        const { notificationService } = await import(
            "../services/notificationService"
        );

        // Use SCAN to iterate keys without blocking Redis (safe for large keyspaces)
        const keysToDelete: string[] = [];
        let cursor = 0;
        do {
            const result = await redisClient.scan(cursor, { MATCH: "*", COUNT: 200 });
            cursor = result.cursor;
            for (const key of result.keys) {
                if (!key.startsWith("sess:")) {
                    keysToDelete.push(key);
                }
            }
        } while (cursor !== 0);

        if (keysToDelete.length > 0) {
            logger.debug(
                `[CACHE] Clearing ${keysToDelete.length} cache entries (preserving session keys)...`
            );
            const BATCH = 100;
            for (let i = 0; i < keysToDelete.length; i += BATCH) {
                const batch = keysToDelete.slice(i, i + BATCH);
                await redisClient.del(batch);
            }
            logger.debug(
                `[CACHE] Successfully cleared ${keysToDelete.length} cache entries`
            );

            // Send notification to user
            await notificationService.notifySystem(
                req.user!.id,
                "Caches Cleared",
                `Successfully cleared ${keysToDelete.length} cache entries`
            );

            res.json({
                success: true,
                message: `Cleared ${keysToDelete.length} cache entries`,
                clearedKeys: keysToDelete.length,
            });
        } else {
            await notificationService.notifySystem(
                req.user!.id,
                "Caches Cleared",
                "No cache entries to clear"
            );

            res.json({
                success: true,
                message: "No cache entries to clear",
                clearedKeys: 0,
            });
        }
    } catch (error: any) {
        logger.error("Clear caches error:", error);
        res.status(500).json({
            error: "Failed to clear caches",
            details: error.message,
        });
    }
});

export default router;
