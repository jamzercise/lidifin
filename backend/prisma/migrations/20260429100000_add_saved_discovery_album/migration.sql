-- Arch-X.c: introduce SavedDiscoveryAlbum (user-bookmarked discovery
-- albums). Replaces the historical pattern of writing
-- Album.location = DISCOVER rows during artist enrichment, which conflated
-- owned content with transient browsing suggestions. After the Arch-X.a
-- Jellyfin-first cutover, no active code path persists discovery items
-- to the Album table; this is the storage for the explicit "save for
-- later" flow that follow-up UI work will surface.

-- CreateTable
CREATE TABLE "SavedDiscoveryAlbum" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rgMbid" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "artistMbid" TEXT,
    "albumTitle" TEXT NOT NULL,
    "coverUrl" TEXT,
    "source" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedDiscoveryAlbum_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SavedDiscoveryAlbum_userId_rgMbid_key" ON "SavedDiscoveryAlbum"("userId", "rgMbid");
CREATE INDEX "SavedDiscoveryAlbum_userId_savedAt_idx" ON "SavedDiscoveryAlbum"("userId", "savedAt");
CREATE INDEX "SavedDiscoveryAlbum_rgMbid_idx" ON "SavedDiscoveryAlbum"("rgMbid");

-- AddForeignKey
ALTER TABLE "SavedDiscoveryAlbum" ADD CONSTRAINT "SavedDiscoveryAlbum_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
