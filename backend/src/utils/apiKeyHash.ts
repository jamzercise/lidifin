import crypto from "crypto";

/**
 * Hash a device API key for storage/lookup.
 *
 * Keys are 32 bytes of CSPRNG output (~256 bits of entropy), so a single
 * unsalted SHA-256 is sufficient — brute force is infeasible and a
 * deterministic hash lets us look keys up via the unique index. The
 * plaintext key is shown to the user once at creation and never persisted.
 */
export function hashApiKey(key: string): string {
    return crypto.createHash("sha256").update(key).digest("hex");
}
