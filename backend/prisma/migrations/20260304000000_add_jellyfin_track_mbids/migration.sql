-- AlterTable
ALTER TABLE "JellyfinTrackMetadata" ADD COLUMN "artistMbid" TEXT;
ALTER TABLE "JellyfinTrackMetadata" ADD COLUMN "rgMbid" TEXT;

-- CreateIndex
CREATE INDEX "JellyfinTrackMetadata_artistMbid_idx" ON "JellyfinTrackMetadata"("artistMbid");
