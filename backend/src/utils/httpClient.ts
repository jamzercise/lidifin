import axios, {
    AxiosError,
    AxiosInstance,
    CreateAxiosDefaults,
    InternalAxiosRequestConfig,
} from "axios";
import { logger } from "./logger";

/**
 * Normalize an axios response header value to a single string.
 *
 * Axios v1 typings allow header values to be `string | number | boolean | string[] | AxiosHeaders | undefined`,
 * but Express (and the upstream content APIs we consume) only accept scalar header strings.
 * Passing the raw axios header into `res.setHeader` / `res.writeHead` is a TypeScript error and
 * a real runtime risk: certain HTTP/2 stacks emit numeric or array headers that would otherwise
 * coerce to junk like `"true"` or `"a,b"`.
 *
 * Returns `undefined` when the value is missing / empty so callers can branch cleanly.
 */
export function headerToString(
    value: string | number | boolean | string[] | undefined | null | { toString(): string }
): string | undefined {
    if (value === undefined || value === null || value === "" || value === false) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.length ? value.join(", ") : undefined;
    }
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    // AxiosHeaders or other object-like header containers
    try {
        return String(value);
    } catch {
        return undefined;
    }
}

const DEFAULT_UA = "Lidifin/1.0.6 (https://github.com/jamzercise/lidifin)";
const DEFAULT_TIMEOUT = 15_000;

const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

/**
 * Upstream told us to come back later, but we won't hold a request open forever.
 * A `Retry-After` longer than this is treated as "unavailable" rather than slept through.
 */
const RETRY_AFTER_CEILING_MS = 15_000;

/** Only replayed for methods that are safe to repeat. */
const IDEMPOTENT_METHODS = new Set(["get", "head", "options"]);

const RETRYABLE_NETWORK_CODES = new Set([
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "EPIPE",
    "ERR_NETWORK",
]);

interface ApiClientOptions {
    baseURL?: string;
    timeout?: number;
    userAgent?: string;
    headers?: Record<string, string>;
    /** Attempts after the first for transient failures. 0 disables retrying. */
    maxRetries?: number;
}

type RetryableConfig = InternalAxiosRequestConfig & { __retryCount?: number };

/**
 * Parse `Retry-After`, which may be either a delay in seconds or an HTTP date.
 * Returns undefined when absent or unparseable so the caller falls back to backoff.
 */
function parseRetryAfter(value: unknown): number | undefined {
    const raw = headerToString(value as string | number | undefined);
    if (!raw) return undefined;

    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const date = Date.parse(raw);
    if (!Number.isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return undefined;
}

/**
 * Transient failures worth replaying: server-side errors (5xx), explicit
 * throttling (429), and dropped/timed-out connections. Client errors other than
 * 429 are the caller's fault and will fail identically on a replay.
 */
function isTransient(error: AxiosError): boolean {
    const status = error.response?.status;
    if (status !== undefined) {
        return status >= 500 || status === 429;
    }
    return error.code ? RETRYABLE_NETWORK_CODES.has(error.code) : false;
}

function backoffDelay(attempt: number): number {
    const exponential = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    // Jitter keeps concurrent callers from retrying in lockstep against an
    // already-struggling upstream.
    const jitter = Math.random() * RETRY_BASE_DELAY_MS;
    return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

export function createApiClient(
    name: string,
    options: ApiClientOptions = {}
): AxiosInstance {
    const config: CreateAxiosDefaults = {
        baseURL: options.baseURL,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
        headers: {
            "User-Agent": options.userAgent ?? DEFAULT_UA,
            ...options.headers,
        },
    };

    const client = axios.create(config);
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    client.interceptors.response.use(undefined, async (error: AxiosError) => {
        const requestConfig = error.config as RetryableConfig | undefined;
        const url = requestConfig?.url ?? "unknown";
        const status = error.response?.status;

        if (status) {
            logger.warn(`[${name}] HTTP ${status} from ${url}`);
        } else if (error.code === "ECONNABORTED") {
            logger.warn(`[${name}] Timeout requesting ${url}`);
        }

        const method = (requestConfig?.method ?? "get").toLowerCase();
        const attempted = requestConfig?.__retryCount ?? 0;

        const retryable =
            !!requestConfig &&
            maxRetries > 0 &&
            attempted < maxRetries &&
            IDEMPOTENT_METHODS.has(method) &&
            isTransient(error);

        if (!retryable) return Promise.reject(error);

        const attempt = attempted + 1;
        const retryAfter = parseRetryAfter(error.response?.headers?.["retry-after"]);

        if (retryAfter !== undefined && retryAfter > RETRY_AFTER_CEILING_MS) {
            logger.warn(
                `[${name}] ${url} asked for a ${Math.round(retryAfter / 1000)}s wait; giving up rather than blocking`
            );
            return Promise.reject(error);
        }

        // Respect Retry-After when it's longer than our backoff, but never retry
        // faster than the backoff — some servers send `Retry-After: 0` while
        // shedding load, and hammering them immediately makes it worse.
        const backoff = backoffDelay(attempt);
        const delay = Math.max(backoff, retryAfter ?? 0);

        logger.warn(
            `[${name}] Retrying ${url} in ${delay}ms (attempt ${attempt}/${maxRetries}${
                status ? `, last status ${status}` : `, ${error.code}`
            })`
        );

        requestConfig.__retryCount = attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return client.request(requestConfig);
    });

    return client;
}
