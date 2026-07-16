"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";

const AI_PROVIDERS = [
    { value: "OLLAMA", label: "Ollama (local)" },
    { value: "GEMINI", label: "Gemini" },
    { value: "OPENAI", label: "OpenAI / OpenRouter" },
    { value: "MISTRAL", label: "Mistral" },
];

interface AudioMuseSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    isTesting: boolean;
}

export function AudioMuseSection({ settings, onUpdate, isTesting }: AudioMuseSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Checking...");
        try {
            // Try test with current form URL first (works before save)
            const url = settings.audiomuseUrl?.trim();
            if (url) {
                const result = await api.testAudioMuse(url);
                if (result?.available) {
                    setTestStatus("success");
                    setTestMessage(result?.message || "Connected");
                } else {
                    setTestStatus("error");
                    setTestMessage(result?.message || "Not reachable");
                }
                return;
            }
            // Fallback: check saved config (requires save first)
            const result = await api.getAudioMuseStatus();
            if (result?.enabled && result?.available) {
                setTestStatus("success");
                setTestMessage(`Connected (${result.aiProvider || "OLLAMA"})`);
            } else {
                setTestStatus("error");
                setTestMessage(result?.message || "Not configured. Enter URL and save, or test with URL above.");
            }
        } catch {
            setTestStatus("error");
            setTestMessage("Request failed");
        }
    };

    return (
        <SettingsSection
            id="audiomuse"
            title="AudioMuse-AI"
            description="Instant mood-based playlists. Requires Jellyfin + a running AudioMuse-AI instance. Configure an AI provider (Ollama recommended) in AudioMuse-AI."
        >
            <SettingsRow
                label="Enable AudioMuse-AI"
                description="Use AudioMuse-AI for Mood Mixer instant playlists when Jellyfin is your music source"
                htmlFor="audiomuse-enabled"
            >
                <SettingsToggle
                    id="audiomuse-enabled"
                    checked={!!settings.audiomuseEnabled}
                    onChange={(checked) => onUpdate({ audiomuseEnabled: checked })}
                />
            </SettingsRow>

            {settings.audiomuseEnabled && (
                <>
                    <SettingsRow label="AudioMuse-AI URL">
                        <SettingsInput
                            value={settings.audiomuseUrl ?? ""}
                            onChange={(v) => onUpdate({ audiomuseUrl: v || null })}
                            placeholder="http://localhost:8000"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="AI provider"
                        description="Must match AudioMuse-AI config. Ollama is free and runs locally."
                    >
                        <select
                            value={settings.audiomuseAiProvider ?? "OLLAMA"}
                            onChange={(e) =>
                                onUpdate({
                                    audiomuseAiProvider: e.target.value || null,
                                })
                            }
                            className="w-64 px-3 py-2 bg-[#1a1a1a] border border-white/10 rounded-lg text-white text-sm"
                        >
                            {AI_PROVIDERS.map((p) => (
                                <option key={p.value} value={p.value}>
                                    {p.label}
                                </option>
                            ))}
                        </select>
                    </SettingsRow>

                    {(settings.audiomuseAiProvider || "OLLAMA") === "OLLAMA" && (
                        <SettingsRow
                            label="Ollama URL"
                            description="Override if AudioMuse uses wrong default (e.g. in Docker use host.docker.internal:11434)"
                        >
                            <SettingsInput
                                value={settings.audiomuseOllamaUrl ?? ""}
                                onChange={(v) =>
                                    onUpdate({ audiomuseOllamaUrl: v || null })
                                }
                                placeholder="http://localhost:11434/api/generate"
                                className="w-64"
                            />
                        </SettingsRow>
                    )}

                    <SettingsRow
                        label="AI model"
                        description="Optional. Leave blank to use AudioMuse-AI default (e.g. gemini-1.5-flash-latest, mistral:7b)"
                    >
                        <SettingsInput
                            value={settings.audiomuseAiModel ?? ""}
                            onChange={(v) =>
                                onUpdate({ audiomuseAiModel: v || null })
                            }
                            placeholder="e.g. gemini-1.5-flash-latest"
                            className="w-64"
                        />
                    </SettingsRow>

                    {(settings.audiomuseAiProvider === "GEMINI" ||
                        settings.audiomuseAiProvider === "OPENAI" ||
                        settings.audiomuseAiProvider === "MISTRAL") && (
                        <SettingsRow
                            label="API key"
                            description="Required for cloud AI providers"
                        >
                            <SettingsInput
                                type="password"
                                value={settings.audiomuseApiKey ?? ""}
                                onChange={(v) =>
                                    onUpdate({ audiomuseApiKey: v || null })
                                }
                                placeholder={settings.audiomuseApiKeySet ? "•••••••• (saved — leave blank to keep)" : "Enter API key"}
                                className="w-64"
                            />
                        </SettingsRow>
                    )}

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleTest}
                                disabled={
                                    isTesting ||
                                    !settings.audiomuseUrl?.trim()
                                }
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full hover:bg-[#444] disabled:opacity-50"
                            >
                                Test connection
                            </button>
                            <InlineStatus status={testStatus} message={testMessage} />
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
