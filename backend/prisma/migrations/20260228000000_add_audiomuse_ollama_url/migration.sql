-- Add optional Ollama URL override for AudioMuse-AI chatPlaylist (when using OLLAMA provider)
-- Fixes incorrect default Ollama URL in AudioMuse (e.g. http://:11434/api/generate)
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "audiomuseOllamaUrl" TEXT;
