-- Arch-X.d: schema slim. Removes the legacy Prisma-as-content-mirror
-- surface that the Arch-X.a/b/c work made obsolete:
--
--   * OwnedAlbum, AlbumOwnershipFact: ownership facts. Superseded by
--     the Jellyfin-first /library/albums/:id and /library/artists/:id
--     handlers, which read ownership from Jellyfin directly.
--   * AlbumSourceMap: external-source -> canonical-album mapping. Only
--     written by jellyfinMetadataSync's owned-album cache, which X.a
--     stopped reading from.
--   * AlbumArtistCredit, TrackArtistCredit: normalized artist credits
--     for compilations. Replaced by Jellyfin's albumArtists payload +
--     albumDetailHelpers.isCompilationAlbumFromArtists in X.a.2.
--   * Album.location + AlbumLocation enum: discovery-vs-library
--     distinction at the Album row level. After X.a, no active code
--     path persists DISCOVER rows; bookmarked discovery items live on
--     SavedDiscoveryAlbum (X.c).
--   * Artist.libraryAlbumCount, .discoveryAlbumCount, .totalTrackCount,
--     .countsLastUpdated: denormalized counts, computed by
--     artistCountsService. The service goes away with the columns.
--   * SourceSystem, OwnershipStatus, MatchMethod, ArtistCreditRole
--     enums: only used by the dropped models.
--
-- The Track.* analysis columns are deliberately NOT touched here; they
-- still serve as the audio-analyzer's write target. They drop in a
-- follow-up after Arch-X.b.W rewires the Python analyzer to write to
-- JellyfinTrackAnalysis.
--
-- Destructive: cannot be rolled back without a database backup. CASCADE
-- is used on FK drops where the dependent rows are themselves being
-- removed; explicit drop ordering avoids unintended cascades on Album
-- or Artist.

-- DropForeignKey on dependents first so we can DROP TABLE safely.
ALTER TABLE "OwnedAlbum"          DROP CONSTRAINT IF EXISTS "OwnedAlbum_artistId_fkey";
ALTER TABLE "AlbumArtistCredit"   DROP CONSTRAINT IF EXISTS "AlbumArtistCredit_albumId_fkey";
ALTER TABLE "AlbumArtistCredit"   DROP CONSTRAINT IF EXISTS "AlbumArtistCredit_artistId_fkey";
ALTER TABLE "TrackArtistCredit"   DROP CONSTRAINT IF EXISTS "TrackArtistCredit_trackId_fkey";
ALTER TABLE "TrackArtistCredit"   DROP CONSTRAINT IF EXISTS "TrackArtistCredit_artistId_fkey";
ALTER TABLE "AlbumSourceMap"      DROP CONSTRAINT IF EXISTS "AlbumSourceMap_albumId_fkey";
ALTER TABLE "AlbumOwnershipFact"  DROP CONSTRAINT IF EXISTS "AlbumOwnershipFact_albumId_fkey";

-- DropTable
DROP TABLE IF EXISTS "OwnedAlbum"          CASCADE;
DROP TABLE IF EXISTS "AlbumArtistCredit"   CASCADE;
DROP TABLE IF EXISTS "TrackArtistCredit"   CASCADE;
DROP TABLE IF EXISTS "AlbumSourceMap"      CASCADE;
DROP TABLE IF EXISTS "AlbumOwnershipFact"  CASCADE;

-- DropIndex on Album.location-related indexes, then drop the column.
DROP INDEX IF EXISTS "Album_location_idx";
DROP INDEX IF EXISTS "Album_artistId_location_idx";
ALTER TABLE "Album" DROP COLUMN IF EXISTS "location";

-- DropIndex on Artist denormalized-count indexes, then drop the columns.
DROP INDEX IF EXISTS "Artist_libraryAlbumCount_idx";
DROP INDEX IF EXISTS "Artist_discoveryAlbumCount_idx";
DROP INDEX IF EXISTS "Artist_totalTrackCount_idx";
ALTER TABLE "Artist" DROP COLUMN IF EXISTS "libraryAlbumCount";
ALTER TABLE "Artist" DROP COLUMN IF EXISTS "discoveryAlbumCount";
ALTER TABLE "Artist" DROP COLUMN IF EXISTS "totalTrackCount";
ALTER TABLE "Artist" DROP COLUMN IF EXISTS "countsLastUpdated";

-- DropEnum (after every column / table that referenced these is gone).
DROP TYPE IF EXISTS "AlbumLocation";
DROP TYPE IF EXISTS "ArtistCreditRole";
DROP TYPE IF EXISTS "OwnershipStatus";
DROP TYPE IF EXISTS "MatchMethod";
DROP TYPE IF EXISTS "SourceSystem";
