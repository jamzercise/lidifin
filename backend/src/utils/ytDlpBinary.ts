import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { logger } from "./logger";

/**
 * Resolves the yt-dlp binary for YouTube Music playlist import.
 *
 * Order of precedence:
 * 1. LIDIFIN_YT_DLP_PATH env var (explicit path to binary), or legacy LIDIFY_YT_DLP_PATH
 * 2. System yt-dlp on PATH
 * 3. Auto-downloaded binary into backend/data/yt-dlp/ (created on first use)
 *
 * The downloaded binary is cached so subsequent runs use it without re-downloading.
 */

const CACHE_DIR = path.join(process.cwd(), "data", "yt-dlp");
const BINARY_NAME = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const CACHED_BINARY_PATH = path.join(CACHE_DIR, BINARY_NAME);

const SYSTEM_COMMAND = "yt-dlp";

function getYtDlpPathFromEnv(): string | undefined {
    const lidifin = process.env.LIDIFIN_YT_DLP_PATH?.trim();
    if (lidifin) return lidifin;
    return process.env.LIDIFY_YT_DLP_PATH?.trim();
}

let resolvedPath: string | null | undefined = undefined;
let downloadPromise: Promise<string | null> | null = null;

function checkSystemYtDlp(): boolean {
    try {
        execSync(`${SYSTEM_COMMAND} --version`, { stdio: "pipe", timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

function ensureCacheDir(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

async function downloadYtDlp(): Promise<string | null> {
    if (downloadPromise) return downloadPromise;
    downloadPromise = (async () => {
        ensureCacheDir();
        const destPath = CACHED_BINARY_PATH;
        if (fs.existsSync(destPath)) {
            try {
                execSync(`"${destPath}" --version`, { stdio: "pipe", timeout: 5000 });
                return destPath;
            } catch {
                fs.unlinkSync(destPath);
            }
        }
        try {
            const YTDlpWrap = (await import("yt-dlp-wrap")).default;
            logger.info("[yt-dlp] Downloading yt-dlp binary for YouTube Music import...");
            await YTDlpWrap.downloadFromGithub(destPath, undefined, os.platform());
            if (process.platform !== "win32") {
                fs.chmodSync(destPath, 0o755);
            }
            logger.info("[yt-dlp] Binary saved to " + destPath);
            return destPath;
        } catch (err: any) {
            logger.error("[yt-dlp] Failed to download yt-dlp:", err?.message || err);
            return null;
        }
    })();
    return downloadPromise;
}

/**
 * Returns the path to the yt-dlp binary to use, or null if unavailable.
 * - If LIDIFIN_YT_DLP_PATH (or legacy LIDIFY_YT_DLP_PATH) is set, that path is used (must exist).
 * - Else if yt-dlp is on PATH, returns the string "yt-dlp" (spawn by name).
 * - Else downloads yt-dlp into data/yt-dlp/ and returns that path.
 */
export async function getYtDlpPath(): Promise<string | null> {
    if (resolvedPath !== undefined) return resolvedPath;

    const envPath = getYtDlpPathFromEnv();
    if (envPath) {
        if (fs.existsSync(envPath)) {
            resolvedPath = envPath;
            return resolvedPath;
        }
        logger.warn(
            "[yt-dlp] LIDIFIN_YT_DLP_PATH or LIDIFY_YT_DLP_PATH is set but file not found: " +
                envPath
        );
    }

    if (checkSystemYtDlp()) {
        resolvedPath = SYSTEM_COMMAND;
        return resolvedPath;
    }

    const cached = await downloadYtDlp();
    resolvedPath = cached ?? null;
    return resolvedPath;
}

/**
 * Synchronous check: is yt-dlp available (system or already cached)?
 * Does not trigger download. Use getYtDlpPath() when you need to ensure availability (and allow download).
 */
export function isYtDlpAvailableSync(): boolean {
    const envPath = getYtDlpPathFromEnv();
    if (envPath && fs.existsSync(envPath)) {
        return true;
    }
    if (checkSystemYtDlp()) return true;
    if (fs.existsSync(CACHED_BINARY_PATH)) {
        try {
            execSync(`"${CACHED_BINARY_PATH}" --version`, { stdio: "pipe", timeout: 5000 });
            return true;
        } catch {
            return false;
        }
    }
    return false;
}
