/**
 * Jest setup: provide deterministic, test-only values for env vars that the
 * runtime config (`src/config.ts`) and crypto helpers (`src/utils/encryption.ts`)
 * read at module load. We set them *before* any test imports, so simply
 * importing a service that transitively pulls in `config.ts` doesn't
 * `process.exit(1)` with a Zod validation error.
 *
 * These are dummy values, not secrets — they only exist to let modules load.
 * Tests that need real behaviour around DB/Redis/encryption should mock those
 * dependencies explicitly.
 */

// Fall back, don't override — let real env vars win in CI / dev shells.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATABASE_URL =
    process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.SESSION_SECRET =
    process.env.SESSION_SECRET ||
    "test-session-secret-at-least-32-characters-long-for-zod-validation";
process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    // 32-byte base64 value; exactly matches what `openssl rand -base64 32`
    // would produce and what `getEncryptionKey()` expects.
    "dGVzdC1lbmNyeXB0aW9uLWtleS1mb3ItamVzdC1ydW5zLWFhYWE=";
