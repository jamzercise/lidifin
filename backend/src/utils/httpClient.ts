import axios, { AxiosInstance, CreateAxiosDefaults } from "axios";
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

const DEFAULT_UA = "Lidifin/1.0.0 (https://github.com/jamzercise/lidifin)";
const DEFAULT_TIMEOUT = 15_000;

interface ApiClientOptions {
    baseURL?: string;
    timeout?: number;
    userAgent?: string;
    headers?: Record<string, string>;
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

    client.interceptors.response.use(undefined, (error) => {
        const url = error.config?.url ?? "unknown";
        const status = error.response?.status;
        if (status) {
            logger.warn(`[${name}] HTTP ${status} from ${url}`);
        } else if (error.code === "ECONNABORTED") {
            logger.warn(`[${name}] Timeout requesting ${url}`);
        }
        return Promise.reject(error);
    });

    return client;
}
