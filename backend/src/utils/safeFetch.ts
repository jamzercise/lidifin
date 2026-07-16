/**
 * SSRF-safe outbound fetch helpers.
 *
 * Several endpoints fetch URLs that originate from user-controllable data
 * (cover art URLs stored on albums, podcast RSS feeds, etc.). Without
 * validation, those endpoints act as an authenticated proxy into the
 * server's network: private LAN services, Redis, cloud metadata endpoints.
 *
 * Policy:
 *  - Only http/https URLs are allowed.
 *  - URLs whose origin matches an admin-configured service (Jellyfin,
 *    Audiobookshelf, Lidarr, AudioMuse) are trusted even when private —
 *    those bases were deliberately configured by the admin.
 *  - All other hostnames are resolved via DNS and rejected if any resolved
 *    address is loopback, private, link-local, or otherwise reserved.
 *  - Redirects are followed manually and every hop is re-validated.
 *  - Responses are size-capped while streaming, not after buffering.
 *
 * Known residual risk: DNS rebinding (TOCTOU between the lookup here and
 * the lookup fetch performs). Eliminating that requires pinning sockets to
 * the resolved IP, which undici does not expose simply; for a self-hosted
 * app this check removes the practical attack surface.
 */

import dns from "dns";
import net from "net";
import { logger } from "./logger";
import { getSystemSettings } from "./systemSettings";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024; // 25MB — covers large artwork

export class UnsafeUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnsafeUrlError";
    }
}

function isPrivateIPv4(ip: string): boolean {
    const octets = ip.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) {
        return true; // unparseable — treat as unsafe
    }
    const [a, b] = octets;
    return (
        a === 0 || // "this network"
        a === 10 || // private
        a === 127 || // loopback
        (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
        (a === 169 && b === 254) || // link-local / cloud metadata
        (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
        (a === 192 && b === 168) || // private
        (a === 192 && b === 0) || // 192.0.0/24 + 192.0.2/24 doc
        (a === 198 && (b === 18 || b === 19)) || // benchmarking
        (a === 198 && b === 51) || // 198.51.100/24 doc
        (a === 203 && b === 0) || // 203.0.113/24 doc
        a >= 224 // multicast + reserved + broadcast
    );
}

function isPrivateAddress(ip: string): boolean {
    if (net.isIPv4(ip)) return isPrivateIPv4(ip);

    const lower = ip.toLowerCase();
    // IPv4-mapped IPv6, dotted form (::ffff:10.0.0.1)
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);

    // IPv4-mapped IPv6, hex form (::ffff:7f00:1 — what `new URL()` normalizes
    // [::ffff:127.0.0.1] into)
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16);
        const lo = parseInt(mappedHex[2], 16);
        return isPrivateIPv4(
            `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
        );
    }

    return (
        lower === "::" ||
        lower === "::1" || // loopback
        lower.startsWith("fc") || // unique-local fc00::/7
        lower.startsWith("fd") ||
        lower.startsWith("fe8") || // link-local fe80::/10
        lower.startsWith("fe9") ||
        lower.startsWith("fea") ||
        lower.startsWith("feb") ||
        lower.startsWith("ff") // multicast
    );
}

/**
 * Origins the admin explicitly configured. These are allowed to be private
 * addresses — that is the whole point of self-hosting them.
 */
async function getTrustedOrigins(): Promise<Set<string>> {
    const bases: Array<string | null | undefined> = [
        process.env.JELLYFIN_URL,
        process.env.AUDIOBOOKSHELF_URL,
        process.env.LIDARR_URL,
        process.env.AUDIOMUSE_URL,
    ];

    try {
        const settings = await getSystemSettings();
        bases.push(
            settings?.jellyfinUrl,
            settings?.audiobookshelfUrl,
            settings?.lidarrUrl,
            settings?.audiomuseUrl
        );
    } catch (error) {
        logger.warn("[SafeFetch] Could not load system settings for trusted origins:", error);
    }

    const origins = new Set<string>();
    for (const base of bases) {
        if (!base) continue;
        try {
            origins.add(new URL(base).origin);
        } catch {
            // Ignore malformed configured URLs
        }
    }
    return origins;
}

/**
 * Throws UnsafeUrlError unless the URL is http(s) and points at either a
 * trusted configured origin or a publicly routable address.
 */
export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new UnsafeUrlError(`Invalid URL: ${rawUrl.substring(0, 100)}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new UnsafeUrlError(`Unsupported protocol: ${url.protocol}`);
    }

    const trustedOrigins = await getTrustedOrigins();
    if (trustedOrigins.has(url.origin)) {
        return url;
    }

    // Strip brackets from IPv6 literals for net.isIP
    const hostname = url.hostname.replace(/^\[|\]$/g, "");

    if (net.isIP(hostname)) {
        if (isPrivateAddress(hostname)) {
            throw new UnsafeUrlError(`Refusing to fetch private address: ${hostname}`);
        }
        return url;
    }

    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
        throw new UnsafeUrlError(`Refusing to fetch internal hostname: ${hostname}`);
    }

    let records: dns.LookupAddress[];
    try {
        records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw new UnsafeUrlError(`Could not resolve hostname: ${hostname}`);
    }

    for (const record of records) {
        if (isPrivateAddress(record.address)) {
            throw new UnsafeUrlError(
                `Refusing to fetch ${hostname}: resolves to private address ${record.address}`
            );
        }
    }

    return url;
}

const RETRYABLE_ERRORS = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"];

function isRetryableError(err: unknown): boolean {
    const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    const code = e?.code ?? e?.cause?.code;
    if (code && RETRYABLE_ERRORS.includes(code)) return true;
    const message = String(e?.message ?? "").toLowerCase();
    return message.includes("econnreset") || message.includes("fetch failed") || message.includes("aborted");
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export type FetchWithRetryOptions = RequestInit & { timeoutMs?: number };

/**
 * fetch with a timeout, a Lidifin User-Agent, and up to 2 retries on
 * transient network errors. Performs NO SSRF validation — use
 * safeFetchRemote for URLs derived from user-controllable data.
 */
export async function fetchWithRetry(
    url: string,
    options: FetchWithRetryOptions = {}
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
                logger.debug(
                    `[FETCH] Retry ${attempt}/${maxAttempts - 1} for ${url.substring(0, 60)}...:`,
                    (err as Error).message
                );
                await new Promise((r) => setTimeout(r, 400));
            } else {
                throw err;
            }
        }
    }
    throw lastError;
}

export type SafeFetchOptions = FetchWithRetryOptions & {
    /** Reject responses larger than this many bytes. */
    maxResponseBytes?: number;
    /** Require the response Content-Type to start with this prefix (e.g. "image/"). */
    requireContentTypePrefix?: string;
};

export type SafeFetchResult = {
    ok: boolean;
    status: number;
    statusText: string;
    contentType: string | null;
    /** Present only when ok. */
    body: Buffer | null;
};

/**
 * Fetch a remote URL derived from user-controllable data. Validates the
 * initial URL and every redirect hop against the SSRF policy, and streams
 * the body with a hard size cap.
 */
export async function safeFetchRemote(
    rawUrl: string,
    options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
    const {
        maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
        requireContentTypePrefix,
        ...fetchOptions
    } = options;

    let currentUrl = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertSafeRemoteUrl(currentUrl);

        const res = await fetchWithRetry(currentUrl, {
            ...fetchOptions,
            redirect: "manual",
        });

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            // Drain/cancel the redirect body before following
            try {
                await res.body?.cancel();
            } catch {
                // ignore
            }
            if (!location) {
                return {
                    ok: false,
                    status: res.status,
                    statusText: res.statusText,
                    contentType: null,
                    body: null,
                };
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }

        if (!res.ok) {
            try {
                await res.body?.cancel();
            } catch {
                // ignore
            }
            return {
                ok: false,
                status: res.status,
                statusText: res.statusText,
                contentType: res.headers.get("content-type"),
                body: null,
            };
        }

        const contentType = res.headers.get("content-type");
        if (
            requireContentTypePrefix &&
            (!contentType || !contentType.toLowerCase().startsWith(requireContentTypePrefix))
        ) {
            try {
                await res.body?.cancel();
            } catch {
                // ignore
            }
            throw new UnsafeUrlError(
                `Unexpected content type ${contentType ?? "unknown"} from ${currentUrl.substring(0, 100)}`
            );
        }

        const declaredLength = Number(res.headers.get("content-length") || 0);
        if (declaredLength > maxResponseBytes) {
            try {
                await res.body?.cancel();
            } catch {
                // ignore
            }
            throw new UnsafeUrlError(`Response too large (${declaredLength} bytes)`);
        }

        // Stream with a hard cap — Content-Length can lie or be absent.
        const chunks: Buffer[] = [];
        let total = 0;
        if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > maxResponseBytes) {
                    try {
                        await reader.cancel();
                    } catch {
                        // ignore
                    }
                    throw new UnsafeUrlError(`Response exceeded ${maxResponseBytes} byte limit`);
                }
                chunks.push(Buffer.from(value));
            }
        }

        return {
            ok: true,
            status: res.status,
            statusText: res.statusText,
            contentType,
            body: Buffer.concat(chunks),
        };
    }

    throw new UnsafeUrlError(`Too many redirects fetching ${rawUrl.substring(0, 100)}`);
}
