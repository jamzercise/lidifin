import axios, { AxiosInstance, CreateAxiosDefaults } from "axios";
import { logger } from "./logger";

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
