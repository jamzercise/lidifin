-- Drop redundant indexes that duplicate existing PK / unique constraints.
-- Each of these had no read benefit (the planner already had an equivalent
-- index from the PK or @unique) but every INSERT/UPDATE on the table was
-- still maintaining them.

-- DropIndex
-- PlaybackState.userId is the primary key, which auto-creates a unique B-tree
-- index. The explicit @@index([userId]) was redundant.
DROP INDEX "PlaybackState_userId_idx";

-- DropIndex
-- ApiKey.key is @unique, which auto-creates a unique B-tree index. The
-- explicit @@index([key]) was redundant.
DROP INDEX "ApiKey_key_idx";

-- DropIndex
-- OwnedAlbum has composite PK [artistId, rgMbid]. Postgres can use that PK
-- index as a left-prefix to satisfy `WHERE artistId = X`, so the explicit
-- @@index([artistId]) was redundant.
DROP INDEX "OwnedAlbum_artistId_idx";

-- DropIndex
-- SimilarArtist has composite PK [fromArtistId, toArtistId]. Same story as
-- OwnedAlbum: PK already covers `WHERE fromArtistId = X`.
DROP INDEX "SimilarArtist_fromArtistId_idx";

-- CreateIndex
-- OwnedAlbum's composite PK [artistId, rgMbid] is left-anchored, so it cannot
-- satisfy `WHERE rgMbid IN (...)` lookups (the legacy ownership reads on the
-- artist page). Without this index, those queries fall back to a sequential
-- scan over OwnedAlbum, which gets noticeably slow as the library grows.
CREATE INDEX "OwnedAlbum_rgMbid_idx" ON "OwnedAlbum"("rgMbid");
