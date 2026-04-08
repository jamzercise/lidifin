-- CreateEnum
CREATE TYPE "ArtistCreditRole" AS ENUM ('PRIMARY', 'COMPILATION', 'FEATURED', 'CONTRIBUTOR');

-- AlterTable
ALTER TABLE "Album"
ADD COLUMN "isCompilation" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AlbumArtistCredit" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "artistId" TEXT,
    "displayName" TEXT NOT NULL,
    "normalizedDisplayName" TEXT NOT NULL DEFAULT '',
    "role" "ArtistCreditRole" NOT NULL DEFAULT 'PRIMARY',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "source" "SourceSystem" NOT NULL DEFAULT 'NATIVE',
    "sourceArtistId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlbumArtistCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackArtistCredit" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "artistId" TEXT,
    "displayName" TEXT NOT NULL,
    "normalizedDisplayName" TEXT NOT NULL DEFAULT '',
    "role" "ArtistCreditRole" NOT NULL DEFAULT 'PRIMARY',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "source" "SourceSystem" NOT NULL DEFAULT 'NATIVE',
    "sourceArtistId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackArtistCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlbumArtistCredit_albumId_sortOrder_idx" ON "AlbumArtistCredit"("albumId", "sortOrder");

-- CreateIndex
CREATE INDEX "AlbumArtistCredit_artistId_idx" ON "AlbumArtistCredit"("artistId");

-- CreateIndex
CREATE INDEX "AlbumArtistCredit_normalizedDisplayName_idx" ON "AlbumArtistCredit"("normalizedDisplayName");

-- CreateIndex
CREATE INDEX "AlbumArtistCredit_source_sourceArtistId_idx" ON "AlbumArtistCredit"("source", "sourceArtistId");

-- CreateIndex
CREATE INDEX "TrackArtistCredit_trackId_sortOrder_idx" ON "TrackArtistCredit"("trackId", "sortOrder");

-- CreateIndex
CREATE INDEX "TrackArtistCredit_artistId_idx" ON "TrackArtistCredit"("artistId");

-- CreateIndex
CREATE INDEX "TrackArtistCredit_normalizedDisplayName_idx" ON "TrackArtistCredit"("normalizedDisplayName");

-- CreateIndex
CREATE INDEX "TrackArtistCredit_source_sourceArtistId_idx" ON "TrackArtistCredit"("source", "sourceArtistId");

-- AddForeignKey
ALTER TABLE "AlbumArtistCredit"
ADD CONSTRAINT "AlbumArtistCredit_albumId_fkey"
FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumArtistCredit"
ADD CONSTRAINT "AlbumArtistCredit_artistId_fkey"
FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackArtistCredit"
ADD CONSTRAINT "TrackArtistCredit_trackId_fkey"
FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackArtistCredit"
ADD CONSTRAINT "TrackArtistCredit_artistId_fkey"
FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill album artist credits from canonical Album.artist relation.
INSERT INTO "AlbumArtistCredit" (
    "id",
    "albumId",
    "artistId",
    "displayName",
    "normalizedDisplayName",
    "role",
    "sortOrder",
    "source",
    "sourceArtistId",
    "confidence",
    "evidence",
    "createdAt",
    "updatedAt"
)
SELECT
    'bf_albac_' || a."id",
    a."id",
    ar."id",
    ar."name",
    trim(regexp_replace(lower(coalesce(ar."name", '')), '[^a-z0-9\s]+', ' ', 'g')),
    'PRIMARY'::"ArtistCreditRole",
    0,
    'NATIVE'::"SourceSystem",
    NULL,
    1.0,
    jsonb_build_object('backfilledFrom', 'Album.artistId'),
    NOW(),
    NOW()
FROM "Album" a
JOIN "Artist" ar ON ar."id" = a."artistId";

-- Backfill track artist credits from track -> album primary artist relation.
INSERT INTO "TrackArtistCredit" (
    "id",
    "trackId",
    "artistId",
    "displayName",
    "normalizedDisplayName",
    "role",
    "sortOrder",
    "source",
    "sourceArtistId",
    "confidence",
    "evidence",
    "createdAt",
    "updatedAt"
)
SELECT
    'bf_trkac_' || t."id",
    t."id",
    ar."id",
    ar."name",
    trim(regexp_replace(lower(coalesce(ar."name", '')), '[^a-z0-9\s]+', ' ', 'g')),
    'PRIMARY'::"ArtistCreditRole",
    0,
    'NATIVE'::"SourceSystem",
    NULL,
    1.0,
    jsonb_build_object('backfilledFrom', 'Track.album.artistId'),
    NOW(),
    NOW()
FROM "Track" t
JOIN "Album" a ON a."id" = t."albumId"
JOIN "Artist" ar ON ar."id" = a."artistId";
