-- AlterTable
ALTER TABLE "JellyfinTrackMetadata" ADD COLUMN "genres" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "JellyfinTrackMetadata_genres_idx" ON "JellyfinTrackMetadata" USING GIN ("genres");
