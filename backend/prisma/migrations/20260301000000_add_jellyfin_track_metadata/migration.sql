-- CreateTable
CREATE TABLE "JellyfinTrackMetadata" (
    "jellyfinId" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "trackTitle" TEXT NOT NULL,
    "albumTitle" TEXT,
    "lastfmTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastEnriched" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JellyfinTrackMetadata_pkey" PRIMARY KEY ("jellyfinId")
);

-- CreateIndex
CREATE INDEX "JellyfinTrackMetadata_lastfmTags_idx" ON "JellyfinTrackMetadata" USING GIN ("lastfmTags");
