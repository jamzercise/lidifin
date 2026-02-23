-- Add optional Jellyfin User ID so API key + userId can be used without username/password
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "jellyfinUserId" TEXT;
