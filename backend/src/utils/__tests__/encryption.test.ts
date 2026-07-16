/**
 * Encryption round-trip and backward-compatibility tests.
 *
 * New values are AES-256-GCM (`gcm:` prefix, authenticated). Values written
 * by older builds used AES-256-CBC (`<iv_hex>:<ciphertext_hex>`) and must
 * still decrypt with the same key derivation.
 */
import crypto from "crypto";
import { encrypt, decrypt } from "../encryption";

/** Mirror of the legacy CBC writer so we can produce old-format ciphertexts. */
function legacyCbcEncrypt(text: string): string {
    // Same key derivation as src/utils/encryption.ts getEncryptionKey()
    const keyString = process.env.SETTINGS_ENCRYPTION_KEY!;
    const decoded = Buffer.from(keyString, "base64");
    let key: Buffer;
    if (decoded.length >= 32) {
        key = decoded.subarray(0, 32);
    } else {
        key = Buffer.alloc(32, 0);
        Buffer.from(keyString, "utf-8").copy(key);
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    return iv.toString("hex") + ":" + encrypted.toString("hex");
}

describe("encrypt/decrypt (AES-256-GCM)", () => {
    it("round-trips a secret", () => {
        const secret = "my-lidarr-api-key-12345";
        const ciphertext = encrypt(secret);
        expect(ciphertext).toMatch(/^gcm:[0-9a-f]{24}:[0-9a-f]{32}:/);
        expect(ciphertext).not.toContain(secret);
        expect(decrypt(ciphertext)).toBe(secret);
    });

    it("round-trips unicode and long values", () => {
        const secret = "pässwörd-🎵-" + "x".repeat(500);
        expect(decrypt(encrypt(secret))).toBe(secret);
    });

    it("produces a different ciphertext each call (random nonce)", () => {
        expect(encrypt("same")).not.toBe(encrypt("same"));
    });

    it("returns empty string for empty input", () => {
        expect(encrypt("")).toBe("");
        expect(decrypt("")).toBe("");
    });

    it("throws on tampered GCM ciphertext instead of returning garbage", () => {
        const ciphertext = encrypt("secret-value");
        const parts = ciphertext.split(":");
        // Flip a hex digit in the payload
        const payload = parts[3];
        const flipped = (payload[0] === "0" ? "1" : "0") + payload.slice(1);
        const tampered = [parts[0], parts[1], parts[2], flipped].join(":");
        expect(() => decrypt(tampered)).toThrow();
    });

    it("decrypts legacy CBC ciphertexts (backward compatibility)", () => {
        const secret = "legacy-cbc-secret";
        const legacy = legacyCbcEncrypt(secret);
        expect(legacy.startsWith("gcm:")).toBe(false);
        expect(decrypt(legacy)).toBe(secret);
    });

    it("passes through values that predate encryption entirely", () => {
        // Not shaped like either ciphertext format — treated as plaintext.
        expect(decrypt("plain-old-api-key")).toBe("plain-old-api-key");
        expect(decrypt("http://host:8686/path")).toBe("http://host:8686/path");
    });
});
