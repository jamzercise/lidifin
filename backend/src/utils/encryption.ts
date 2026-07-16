import crypto from "crypto";
import { logger } from "./logger";

// New values are encrypted with AES-256-GCM (authenticated encryption, so
// tampering is detected). Legacy values written by older builds used
// AES-256-CBC and are still decryptable for backward compatibility.
const GCM_ALGORITHM = "aes-256-gcm";
const CBC_ALGORITHM = "aes-256-cbc";
const GCM_PREFIX = "gcm:";

// Insecure default that must not be used in production
const INSECURE_DEFAULT = "default-encryption-key-change-me";

/**
 * Get and validate the encryption key from environment
 * Throws error if not set or using insecure default
 */
function getEncryptionKey(): Buffer {
    // Support both SETTINGS_ENCRYPTION_KEY (primary) and ENCRYPTION_KEY (compatibility)
    const key = process.env.SETTINGS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;

    if (!key) {
        throw new Error(
            "CRITICAL: SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY environment variable must be set.\n" +
            "This key is required to encrypt sensitive data (API keys, passwords, 2FA secrets).\n" +
            "Generate a secure key with: openssl rand -base64 32"
        );
    }

    if (key === INSECURE_DEFAULT) {
        throw new Error(
            "CRITICAL: Encryption key is set to the insecure default value.\n" +
            "You must set a unique SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY.\n" +
            "Generate a secure key with: openssl rand -base64 32"
        );
    }

    // The documented setup is `openssl rand -base64 32` which produces a 44-char
    // base64 string representing 32 random bytes — exactly what AES-256 needs.
    // Try base64 decode first; fall back to raw UTF-8 for plain-text keys.
    const decoded = Buffer.from(key, "base64");
    if (decoded.length >= 32) {
        return decoded.subarray(0, 32);
    }

    // Plain-text key: pad or truncate to exactly 32 bytes
    const raw = Buffer.from(key, "utf-8");
    if (raw.length < 32) {
        const padded = Buffer.alloc(32, 0);
        raw.copy(padded);
        return padded;
    }
    return raw.subarray(0, 32);
}

// Lazy, cached key resolution. Importing this module no longer throws when
// the env var is missing — only callers of `encrypt`/`decrypt` do. The
// production guard now lives in `docker-entrypoint.sh`, which refuses to boot
// without a valid key, so this is purely about not crashing test harnesses
// (or any future code path) that imports the module without ever using it.
let cachedKey: Buffer | null = null;

function resolveKey(): Buffer {
    if (cachedKey) return cachedKey;
    cachedKey = getEncryptionKey();
    return cachedKey;
}

// Test-only hook: allows Jest setup files to drop a cached key when env vars
// change between test runs. Intentionally not exported via the public types.
export function _resetEncryptionKeyCacheForTests(): void {
    cachedKey = null;
}

/**
 * Encrypt a string using AES-256-GCM (authenticated encryption).
 * Format: `gcm:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 * Returns empty string for empty/null input.
 */
export function encrypt(text: string): string {
    if (!text) return "";
    const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
    const cipher = crypto.createCipheriv(GCM_ALGORITHM, resolveKey(), iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${GCM_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptGcm(payload: string): string {
    const [ivHex, tagHex, dataHex] = payload.split(":");
    if (!ivHex || !tagHex || !dataHex) {
        throw new Error("Malformed GCM ciphertext");
    }
    const decipher = crypto.createDecipheriv(
        GCM_ALGORITHM,
        resolveKey(),
        Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
        decipher.update(Buffer.from(dataHex, "hex")),
        decipher.final(),
    ]).toString("utf8");
}

function decryptCbc(text: string): string {
    const parts = text.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = Buffer.from(parts.slice(1).join(":"), "hex");
    const decipher = crypto.createDecipheriv(CBC_ALGORITHM, resolveKey(), iv);
    return Buffer.concat([
        decipher.update(encryptedText),
        decipher.final(),
    ]).toString();
}

/**
 * Decrypt a string produced by `encrypt`. Handles both the current GCM
 * format and the legacy CBC format (`<iv_hex>:<ciphertext_hex>`).
 *
 * Returns empty string for empty/null input. Values that are not in a
 * recognized ciphertext format are returned as-is, to tolerate data that
 * predates encryption. Authentication/decryption failures on data that IS
 * in a ciphertext format are thrown, so callers never treat a corrupt or
 * tampered blob as a valid secret.
 */
export function decrypt(text: string): string {
    if (!text) return "";

    if (text.startsWith(GCM_PREFIX)) {
        // GCM auth failures must surface — a bad tag means tampering or the
        // wrong key, never "maybe it's plaintext".
        return decryptGcm(text.slice(GCM_PREFIX.length));
    }

    // Legacy CBC: `<32-hex-char iv>:<hex ciphertext>`. Only attempt CBC when
    // the shape matches; otherwise assume the value is genuinely unencrypted.
    const parts = text.split(":");
    if (parts.length < 2 || !/^[0-9a-f]{32}$/i.test(parts[0])) {
        return text;
    }

    try {
        return decryptCbc(text);
    } catch (error: any) {
        // Wrong key / corrupt ciphertext: throw so callers know the value is
        // unusable rather than silently returning ciphertext as a "secret".
        if (error.code === "ERR_OSSL_BAD_DECRYPT") {
            throw error;
        }
        logger.error("Decryption error:", error);
        throw error;
    }
}

/**
 * Encrypt a field value, returning null for empty/null values
 * Useful for database fields that should store null instead of empty encrypted strings
 */
export function encryptField(value: string | null | undefined): string | null {
    if (!value || value.trim() === "") return null;
    return encrypt(value);
}

/**
 * Decrypt a field value, returning null for null values
 * Returns empty string for empty input
 */
export function decryptField(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return decrypt(value);
}

