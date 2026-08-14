DROP TABLE IF EXISTS "track_embeddings";

DROP INDEX IF EXISTS "JellyfinTrackAnalysis_vibeAnalysisStatus_idx";

ALTER TABLE "Track" DROP COLUMN IF EXISTS "vibeAnalysisStatus";
ALTER TABLE "Track" DROP COLUMN IF EXISTS "vibeAnalysisStartedAt";
ALTER TABLE "Track" DROP COLUMN IF EXISTS "vibeAnalysisError";
ALTER TABLE "Track" DROP COLUMN IF EXISTS "vibeAnalysisRetryCount";
ALTER TABLE "Track" DROP COLUMN IF EXISTS "vibeAnalysisStatusUpdatedAt";

ALTER TABLE "JellyfinTrackAnalysis" DROP COLUMN IF EXISTS "vibeAnalysisStatus";
ALTER TABLE "JellyfinTrackAnalysis" DROP COLUMN IF EXISTS "vibeAnalysisStartedAt";
ALTER TABLE "JellyfinTrackAnalysis" DROP COLUMN IF EXISTS "vibeAnalysisError";
ALTER TABLE "JellyfinTrackAnalysis" DROP COLUMN IF EXISTS "vibeAnalysisRetryCount";
ALTER TABLE "JellyfinTrackAnalysis" DROP COLUMN IF EXISTS "vibeAnalysisStatusUpdatedAt";

ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "clapWorkers";
