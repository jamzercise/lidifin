-- Store device API keys as SHA-256 hashes instead of plaintext.
--
-- Existing plaintext keys are hashed in place, so already-linked devices keep
-- working (the middleware hashes the incoming key and looks up the digest).
-- After this migration the plaintext column is gone; a database leak can no
-- longer expose usable credentials.

-- Add the hash column (nullable during backfill)
ALTER TABLE "ApiKey" ADD COLUMN "keyHash" TEXT;

-- Backfill: hash the existing plaintext keys (sha256() is built into
-- Postgres 11+; no pgcrypto extension required)
UPDATE "ApiKey" SET "keyHash" = encode(sha256(convert_to("key", 'UTF8')), 'hex');

-- Enforce NOT NULL + uniqueness now that every row has a hash
ALTER TABLE "ApiKey" ALTER COLUMN "keyHash" SET NOT NULL;
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- Drop the plaintext column (and its unique index with it)
ALTER TABLE "ApiKey" DROP COLUMN "key";
