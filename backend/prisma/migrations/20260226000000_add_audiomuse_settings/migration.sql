-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "audiomuseEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "audiomuseUrl" TEXT DEFAULT 'http://localhost:8000';
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "audiomuseAiProvider" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "audiomuseApiKey" TEXT;
