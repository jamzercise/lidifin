/**
 * SSRF policy tests for assertSafeRemoteUrl.
 *
 * IP-literal cases need no network. Hostname cases would hit DNS, so they
 * mock dns.promises.lookup.
 */
import dns from "dns";
import { assertSafeRemoteUrl, UnsafeUrlError } from "../safeFetch";

// getSystemSettings is consulted for admin-configured trusted origins; keep
// it inert so tests don't touch the database.
jest.mock("../systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue(null),
}));

describe("assertSafeRemoteUrl", () => {
    const expectBlocked = async (url: string) => {
        await expect(assertSafeRemoteUrl(url)).rejects.toThrow(UnsafeUrlError);
    };

    it("rejects non-http(s) protocols", async () => {
        await expectBlocked("file:///etc/passwd");
        await expectBlocked("ftp://example.com/x");
        await expectBlocked("gopher://example.com/x");
    });

    it("rejects malformed URLs", async () => {
        await expectBlocked("not a url");
        await expectBlocked("");
    });

    it("rejects private / reserved IPv4 literals", async () => {
        await expectBlocked("http://127.0.0.1/admin");
        await expectBlocked("http://10.0.0.5:8686/api");
        await expectBlocked("http://172.16.1.1/");
        await expectBlocked("http://192.168.1.10:6379/");
        await expectBlocked("http://169.254.169.254/latest/meta-data/"); // cloud metadata
        await expectBlocked("http://100.64.0.1/"); // CGNAT
        await expectBlocked("http://0.0.0.0/");
    });

    it("rejects loopback / private IPv6 literals", async () => {
        await expectBlocked("http://[::1]/");
        await expectBlocked("http://[fd00::1]/");
        await expectBlocked("http://[fe80::1]/");
        await expectBlocked("http://[::ffff:127.0.0.1]/"); // v4-mapped loopback
    });

    it("rejects localhost-style hostnames without a DNS lookup", async () => {
        await expectBlocked("http://localhost:3006/api");
        await expectBlocked("http://foo.localhost/");
        await expectBlocked("http://redis.internal/");
    });

    it("allows public IP literals", async () => {
        const url = await assertSafeRemoteUrl("https://93.184.216.34/image.jpg");
        expect(url.hostname).toBe("93.184.216.34");
    });

    describe("hostname resolution", () => {
        let lookupSpy: jest.SpyInstance;

        afterEach(() => {
            lookupSpy?.mockRestore();
        });

        it("allows hostnames that resolve to public addresses", async () => {
            lookupSpy = jest
                .spyOn(dns.promises, "lookup")
                .mockResolvedValue([
                    { address: "151.101.1.140", family: 4 },
                ] as never);

            const url = await assertSafeRemoteUrl(
                "https://coverartarchive.org/release/x/front"
            );
            expect(url.hostname).toBe("coverartarchive.org");
        });

        it("rejects hostnames that resolve to private addresses (DNS-based SSRF)", async () => {
            lookupSpy = jest
                .spyOn(dns.promises, "lookup")
                .mockResolvedValue([
                    { address: "10.0.0.7", family: 4 },
                ] as never);

            await expectBlocked("https://evil.example.com/img.png");
        });

        it("rejects when ANY resolved address is private (dual answers)", async () => {
            lookupSpy = jest.spyOn(dns.promises, "lookup").mockResolvedValue([
                { address: "151.101.1.140", family: 4 },
                { address: "192.168.0.2", family: 4 },
            ] as never);

            await expectBlocked("https://mixed.example.com/img.png");
        });

        it("rejects unresolvable hostnames", async () => {
            lookupSpy = jest
                .spyOn(dns.promises, "lookup")
                .mockRejectedValue(new Error("ENOTFOUND"));

            await expectBlocked("https://does-not-exist.example.com/");
        });
    });
});
