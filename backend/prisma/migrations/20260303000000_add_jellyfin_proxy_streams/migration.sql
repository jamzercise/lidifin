-- Add jellyfinProxyStreams to enable proxying Jellyfin audio through Lidifin for remote access
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "jellyfinProxyStreams" BOOLEAN NOT NULL DEFAULT false;
