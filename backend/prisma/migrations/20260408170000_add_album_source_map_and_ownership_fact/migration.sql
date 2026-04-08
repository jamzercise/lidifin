-- CreateEnum
CREATE TYPE "SourceSystem" AS ENUM ('NATIVE', 'JELLYFIN', 'MUSICBRAINZ', 'LASTFM', 'DEEZER', 'SPOTIFY');

-- CreateEnum
CREATE TYPE "OwnershipStatus" AS ENUM ('OWNED', 'UNOWNED', 'UNKNOWN', 'CONFLICT');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('EXACT_SOURCE_ID', 'RGMBID', 'ARTIST_RGMBID', 'TITLE_ARTIST_NORMALIZED', 'TITLE_ARTIST_FUZZY', 'MANUAL');

-- CreateTable
CREATE TABLE "AlbumSourceMap" (
    "id" TEXT NOT NULL,
    "source" "SourceSystem" NOT NULL,
    "sourceAlbumId" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "matchMethod" "MatchMethod" NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlbumSourceMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumOwnershipFact" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "source" "SourceSystem" NOT NULL,
    "sourceAlbumId" TEXT,
    "status" "OwnershipStatus" NOT NULL DEFAULT 'UNKNOWN',
    "matchMethod" "MatchMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "evidence" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlbumOwnershipFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlbumSourceMap_source_sourceAlbumId_key" ON "AlbumSourceMap"("source", "sourceAlbumId");

-- CreateIndex
CREATE INDEX "AlbumSourceMap_albumId_idx" ON "AlbumSourceMap"("albumId");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumOwnershipFact_albumId_source_key" ON "AlbumOwnershipFact"("albumId", "source");

-- CreateIndex
CREATE INDEX "AlbumOwnershipFact_status_idx" ON "AlbumOwnershipFact"("status");

-- CreateIndex
CREATE INDEX "AlbumOwnershipFact_albumId_status_idx" ON "AlbumOwnershipFact"("albumId", "status");

-- CreateIndex
CREATE INDEX "AlbumOwnershipFact_source_sourceAlbumId_idx" ON "AlbumOwnershipFact"("source", "sourceAlbumId");

-- AddForeignKey
ALTER TABLE "AlbumSourceMap" ADD CONSTRAINT "AlbumSourceMap_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumOwnershipFact" ADD CONSTRAINT "AlbumOwnershipFact_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill initial ownership facts from existing jellyfin_sync OwnedAlbum rows.
INSERT INTO "AlbumOwnershipFact" (
    "id",
    "albumId",
    "source",
    "sourceAlbumId",
    "status",
    "matchMethod",
    "confidence",
    "evidence",
    "observedAt",
    "updatedAt"
)
SELECT
    'bf_jf_' || a."id",
    a."id",
    'JELLYFIN'::"SourceSystem",
    NULL,
    'OWNED'::"OwnershipStatus",
    'RGMBID'::"MatchMethod",
    1.0,
    jsonb_build_object('backfilledFrom', 'OwnedAlbum', 'ownedAlbumSource', oa."source"),
    NOW(),
    NOW()
FROM "OwnedAlbum" oa
JOIN "Album" a ON a."rgMbid" = oa."rgMbid"
WHERE oa."source" = 'jellyfin_sync'
ON CONFLICT ("albumId", "source") DO NOTHING;
