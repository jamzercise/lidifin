-- Add optional AI model override for AudioMuse-AI chatPlaylist (e.g. gemini-1.5-flash-latest)
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "audiomuseAiModel" TEXT;
