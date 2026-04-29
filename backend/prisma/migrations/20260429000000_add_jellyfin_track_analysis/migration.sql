-- Arch-X.b.1: introduce JellyfinTrackAnalysis (audio + vibe analysis for
-- Jellyfin-sourced tracks, keyed by jellyfin:uuid). Decouples analysis
-- storage from the legacy `Track` table; writers/readers migrate in
-- follow-up X.b commits, legacy `Track` analysis columns drop in X.d.

-- CreateTable
CREATE TABLE "JellyfinTrackAnalysis" (
    "jellyfinTrackId" TEXT NOT NULL,
    "bpm" DOUBLE PRECISION,
    "beatsCount" INTEGER,
    "key" TEXT,
    "keyScale" TEXT,
    "keyStrength" DOUBLE PRECISION,
    "energy" DOUBLE PRECISION,
    "loudness" DOUBLE PRECISION,
    "dynamicRange" DOUBLE PRECISION,
    "danceability" DOUBLE PRECISION,
    "valence" DOUBLE PRECISION,
    "arousal" DOUBLE PRECISION,
    "instrumentalness" DOUBLE PRECISION,
    "acousticness" DOUBLE PRECISION,
    "speechiness" DOUBLE PRECISION,
    "moodHappy" DOUBLE PRECISION,
    "moodSad" DOUBLE PRECISION,
    "moodRelaxed" DOUBLE PRECISION,
    "moodAggressive" DOUBLE PRECISION,
    "moodParty" DOUBLE PRECISION,
    "moodAcoustic" DOUBLE PRECISION,
    "moodElectronic" DOUBLE PRECISION,
    "danceabilityMl" DOUBLE PRECISION,
    "moodTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "essentiaGenres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "analysisStatus" TEXT NOT NULL DEFAULT 'pending',
    "analysisVersion" TEXT,
    "analysisMode" TEXT,
    "analyzedAt" TIMESTAMP(3),
    "analysisError" TEXT,
    "analysisRetryCount" INTEGER NOT NULL DEFAULT 0,
    "analysisStartedAt" TIMESTAMP(3),
    "vibeAnalysisStatus" TEXT,
    "vibeAnalysisStartedAt" TIMESTAMP(3),
    "vibeAnalysisError" TEXT,
    "vibeAnalysisRetryCount" INTEGER NOT NULL DEFAULT 0,
    "vibeAnalysisStatusUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JellyfinTrackAnalysis_pkey" PRIMARY KEY ("jellyfinTrackId")
);

-- CreateIndex
CREATE INDEX "JellyfinTrackAnalysis_analysisStatus_idx" ON "JellyfinTrackAnalysis"("analysisStatus");
CREATE INDEX "JellyfinTrackAnalysis_analysisMode_idx" ON "JellyfinTrackAnalysis"("analysisMode");
CREATE INDEX "JellyfinTrackAnalysis_bpm_idx" ON "JellyfinTrackAnalysis"("bpm");
CREATE INDEX "JellyfinTrackAnalysis_energy_idx" ON "JellyfinTrackAnalysis"("energy");
CREATE INDEX "JellyfinTrackAnalysis_valence_idx" ON "JellyfinTrackAnalysis"("valence");
CREATE INDEX "JellyfinTrackAnalysis_danceability_idx" ON "JellyfinTrackAnalysis"("danceability");
CREATE INDEX "JellyfinTrackAnalysis_arousal_idx" ON "JellyfinTrackAnalysis"("arousal");
CREATE INDEX "JellyfinTrackAnalysis_acousticness_idx" ON "JellyfinTrackAnalysis"("acousticness");
CREATE INDEX "JellyfinTrackAnalysis_instrumentalness_idx" ON "JellyfinTrackAnalysis"("instrumentalness");
CREATE INDEX "JellyfinTrackAnalysis_moodHappy_idx" ON "JellyfinTrackAnalysis"("moodHappy");
CREATE INDEX "JellyfinTrackAnalysis_moodSad_idx" ON "JellyfinTrackAnalysis"("moodSad");
CREATE INDEX "JellyfinTrackAnalysis_moodRelaxed_idx" ON "JellyfinTrackAnalysis"("moodRelaxed");
CREATE INDEX "JellyfinTrackAnalysis_moodAggressive_idx" ON "JellyfinTrackAnalysis"("moodAggressive");
CREATE INDEX "JellyfinTrackAnalysis_moodParty_idx" ON "JellyfinTrackAnalysis"("moodParty");
CREATE INDEX "JellyfinTrackAnalysis_moodAcoustic_idx" ON "JellyfinTrackAnalysis"("moodAcoustic");
CREATE INDEX "JellyfinTrackAnalysis_moodElectronic_idx" ON "JellyfinTrackAnalysis"("moodElectronic");
CREATE INDEX "JellyfinTrackAnalysis_vibeAnalysisStatus_idx" ON "JellyfinTrackAnalysis"("vibeAnalysisStatus");
