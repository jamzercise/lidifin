import { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { createApiClient, headerToString } from "../httpClient";

jest.mock("../logger", () => ({
    logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

type ScriptedOutcome =
    | { status: number; headers?: Record<string, string> }
    | { code: string };

/**
 * Stand-in transport that replays a scripted sequence of outcomes, so retry
 * behaviour can be asserted without touching the network. The last entry repeats
 * once exhausted.
 */
function scriptedAdapter(outcomes: ScriptedOutcome[]) {
    const attempts: string[] = [];

    const adapter = async (
        config: InternalAxiosRequestConfig
    ): Promise<AxiosResponse> => {
        const outcome = outcomes[Math.min(attempts.length, outcomes.length - 1)];
        attempts.push(config.url ?? "");

        if ("code" in outcome) {
            throw new AxiosError("network down", outcome.code, config);
        }

        const response: AxiosResponse = {
            data: { ok: outcome.status < 400 },
            status: outcome.status,
            statusText: String(outcome.status),
            headers: outcome.headers ?? {},
            config,
        };

        if (outcome.status >= 400) {
            throw new AxiosError(
                `HTTP ${outcome.status}`,
                "ERR_BAD_RESPONSE",
                config,
                {},
                response
            );
        }
        return response;
    };

    return { adapter, attempts };
}

function clientWith(outcomes: ScriptedOutcome[], maxRetries?: number) {
    const { adapter, attempts } = scriptedAdapter(outcomes);
    const client = createApiClient("Test", { maxRetries });
    client.defaults.adapter = adapter as never;
    return { client, attempts };
}

describe("createApiClient retries", () => {
    it("replays a GET after a 503 and returns the eventual success", async () => {
        const { client, attempts } = clientWith(
            [{ status: 503 }, { status: 200 }],
            1
        );

        const response = await client.get("/release-group/abc");

        expect(response.status).toBe(200);
        expect(attempts).toHaveLength(2);
    });

    it("retries dropped connections", async () => {
        const { client, attempts } = clientWith(
            [{ code: "ECONNRESET" }, { status: 200 }],
            1
        );

        await expect(client.get("/artist/abc")).resolves.toMatchObject({
            status: 200,
        });
        expect(attempts).toHaveLength(2);
    });

    it("gives up once maxRetries is exhausted and surfaces the last error", async () => {
        const { client, attempts } = clientWith([{ status: 503 }], 2);

        await expect(client.get("/release-group/abc")).rejects.toMatchObject({
            response: { status: 503 },
        });
        // Original attempt plus two retries.
        expect(attempts).toHaveLength(3);
    });

    it("does not retry client errors like 404", async () => {
        const { client, attempts } = clientWith([{ status: 404 }], 3);

        await expect(client.get("/release-group/missing")).rejects.toMatchObject(
            { response: { status: 404 } }
        );
        expect(attempts).toHaveLength(1);
    });

    it("retries 429 because it is explicit throttling, not a client mistake", async () => {
        const { client, attempts } = clientWith(
            [{ status: 429 }, { status: 200 }],
            1
        );

        await expect(client.get("/artist/abc")).resolves.toMatchObject({
            status: 200,
        });
        expect(attempts).toHaveLength(2);
    });

    it("never replays a non-idempotent POST", async () => {
        const { client, attempts } = clientWith([{ status: 503 }], 3);

        await expect(client.post("/submit", { a: 1 })).rejects.toMatchObject({
            response: { status: 503 },
        });
        expect(attempts).toHaveLength(1);
    });

    it("honours maxRetries: 0 as opt-out", async () => {
        const { client, attempts } = clientWith([{ status: 503 }], 0);

        await expect(client.get("/artist/abc")).rejects.toBeDefined();
        expect(attempts).toHaveLength(1);
    });

    it("refuses to sleep through an unreasonably long Retry-After", async () => {
        const { client, attempts } = clientWith(
            [{ status: 503, headers: { "retry-after": "3600" } }],
            2
        );

        await expect(client.get("/release-group/abc")).rejects.toMatchObject({
            response: { status: 503 },
        });
        // Blocking for an hour is worse than failing fast, so no replay happens.
        expect(attempts).toHaveLength(1);
    });

    it("still retries when MusicBrainz sends Retry-After: 0 while shedding load", async () => {
        // Exactly what the live 503s carry: remaining quota, retry-after 0.
        const { client, attempts } = clientWith(
            [
                {
                    status: 503,
                    headers: { "retry-after": "0", "x-ratelimit-remaining": "13" },
                },
                { status: 200 },
            ],
            1
        );

        await expect(client.get("/release-group/abc")).resolves.toMatchObject({
            status: 200,
        });
        expect(attempts).toHaveLength(2);
    });
});

describe("headerToString", () => {
    describe("returns undefined for empty values", () => {
        it("undefined", () => {
            expect(headerToString(undefined)).toBeUndefined();
        });
        it("null", () => {
            expect(headerToString(null)).toBeUndefined();
        });
        it("empty string", () => {
            expect(headerToString("")).toBeUndefined();
        });
        it("boolean false", () => {
            expect(headerToString(false)).toBeUndefined();
        });
        it("empty array", () => {
            expect(headerToString([])).toBeUndefined();
        });
    });

    describe("preserves scalar header values", () => {
        it("plain string", () => {
            expect(headerToString("audio/mpeg")).toBe("audio/mpeg");
        });
        it("numeric Content-Length", () => {
            expect(headerToString(12345)).toBe("12345");
        });
        it("numeric zero", () => {
            // Content-Length: 0 is a real header; we must not drop it.
            expect(headerToString(0)).toBe("0");
        });
        it("boolean true (rare but possible from upstream)", () => {
            expect(headerToString(true)).toBe("true");
        });
    });

    describe("normalizes array headers", () => {
        it("single-element array", () => {
            expect(headerToString(["bytes"])).toBe("bytes");
        });
        it("multi-element array joins with comma-space", () => {
            // RFC 7230 §3.2.2: list headers MAY be combined this way.
            expect(headerToString(["bytes", "ranges"])).toBe("bytes, ranges");
        });
    });

    describe("AxiosHeaders-like objects", () => {
        it("uses toString() on object-like values", () => {
            const fake = { toString: () => "audio/mp4" };
            expect(headerToString(fake)).toBe("audio/mp4");
        });
        it("returns undefined when toString throws", () => {
            const broken = {
                toString: () => {
                    throw new Error("nope");
                },
            };
            expect(headerToString(broken)).toBeUndefined();
        });
    });

    describe("real-world streaming headers (regression)", () => {
        // These are the exact shapes that previously caused TS2345 / TS2769 in
        // backend/src/routes/{audiobooks,podcasts}.ts and backend/src/services/podcastDownload.ts.
        // Keep these as a guardrail — if anyone changes the helper to return
        // non-string types again, these will fail before headers reach Express.
        it("Content-Length as numeric string", () => {
            expect(headerToString("8421376")).toBe("8421376");
        });
        it("Content-Range bytes=0-/8421376", () => {
            expect(headerToString("bytes 0-8421375/8421376")).toBe(
                "bytes 0-8421375/8421376"
            );
        });
        it("Accept-Ranges bytes", () => {
            expect(headerToString("bytes")).toBe("bytes");
        });
    });
});
