import { headerToString } from "../httpClient";

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
