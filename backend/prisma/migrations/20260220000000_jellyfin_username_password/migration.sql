-- Add optional Jellyfin username/password for AuthenticateByName (per jmshrv.com guide)
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "jellyfinUsername" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "jellyfinPassword" TEXT;
