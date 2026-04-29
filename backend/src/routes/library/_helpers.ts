import { Response } from "express";
import { logger } from "../../utils/logger";

export { logger };

export const JELLYFIN_UNREACHABLE_MESSAGE =
    "Jellyfin is slow or unreachable. Check your Jellyfin instance.";

export const JELLYFIN_UUID_REGEX = /^[a-f0-9]{32}$/i;
export const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveIdForJellyfin(idParam: string): string {
    if (idParam.startsWith("jellyfin:")) return idParam;
    if (JELLYFIN_UUID_REGEX.test(idParam)) return `jellyfin:${idParam}`;
    return idParam;
}

export const ARTIST_SORT_MAP: Record<string, any> = {
    "name": { name: "asc" as const },
    "name-desc": { name: "desc" as const },
    // Arch-X.d removed `Artist.totalTrackCount`. The "tracks" sort
    // option falls back to alphabetical until a Jellyfin-derived count
    // sort lands in a follow-up.
    "tracks": { name: "asc" as const },
};

export const ALBUM_SORT_MAP: Record<string, any> = {
    "name": { title: "asc" as const },
    "name-desc": { title: "desc" as const },
    "recent": { year: "desc" as const },
};

export const TRACK_SORT_MAP: Record<string, any> = {
    "name": { title: "asc" as const },
    "name-desc": { title: "desc" as const },
};

export const MAX_LIMIT = 10000;

export const applyCoverArtCorsHeaders = (res: Response, origin?: string) => {
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
};

const RETRYABLE_ERRORS = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"];

function isRetryableError(err: unknown): boolean {
    const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    const code = e?.code ?? e?.cause?.code;
    if (code && RETRYABLE_ERRORS.includes(code)) return true;
    const message = String(e?.message ?? "").toLowerCase();
    return message.includes("econnreset") || message.includes("fetch failed") || message.includes("aborted");
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export async function fetchWithRetry(
    url: string,
    options: RequestInit & { timeoutMs?: number } = {}
): Promise<FetchResponse> {
    const { timeoutMs = 15000, ...fetchOptions } = options;
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const res = await fetch(url, {
                ...fetchOptions,
                signal: controller.signal,
                headers: {
                    "User-Agent": "Lidifin/1.0.0 (https://github.com/jamzercise/lidifin)",
                    ...(fetchOptions.headers as Record<string, string>),
                },
            });
            clearTimeout(timeoutId);
            return res;
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts && isRetryableError(err)) {
                logger.debug(`[FETCH] Retry ${attempt}/${maxAttempts - 1} for ${url.substring(0, 60)}...:`, (err as Error).message);
                await new Promise((r) => setTimeout(r, 400));
            } else {
                throw err;
            }
        }
    }
    throw lastError;
}
