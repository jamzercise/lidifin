-- CreateIndex
CREATE INDEX "Track_lastfmTags_idx" ON "Track" USING GIN ("lastfmTags");
