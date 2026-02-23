"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface JellyfinSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function JellyfinSection({ settings, onUpdate, onTest, isTesting }: JellyfinSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Testing...");
        const result = await onTest("jellyfin");
        if (result.success) {
            setTestStatus("success");
            setTestMessage("Connected");
        } else {
            setTestStatus("error");
            setTestMessage(result.error || "Failed");
        }
    };

    return (
        <SettingsSection
            id="jellyfin"
            title="Jellyfin (Music)"
            description="Use Jellyfin as your music library and streaming source (Lidifin). Provide your API key and User ID so Library, Favorites, and streaming work correctly."
        >
            <SettingsRow
                label="Use Jellyfin for music"
                description="When enabled, the Library tab and streaming use your Jellyfin server"
                htmlFor="jellyfin-enabled"
            >
                <SettingsToggle
                    id="jellyfin-enabled"
                    checked={!!settings.jellyfinEnabled}
                    onChange={(checked) => onUpdate({ jellyfinEnabled: checked })}
                />
            </SettingsRow>

            {settings.jellyfinEnabled && (
                <>
                    <SettingsRow label="Jellyfin server URL">
                        <SettingsInput
                            value={settings.jellyfinUrl ?? ""}
                            onChange={(v) => onUpdate({ jellyfinUrl: v || null })}
                            placeholder="http://localhost:8096"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="API key"
                        description={
                            settings.jellyfinApiKeyFromEnv
                                ? "Using API key from environment"
                                : "From Jellyfin: Dashboard → API Keys"
                        }
                    >
                        <SettingsInput
                            type="password"
                            value={settings.jellyfinApiKeyFromEnv ? "" : (settings.jellyfinApiKey ?? "")}
                            onChange={(v) => onUpdate({ jellyfinApiKey: v || null })}
                            placeholder={settings.jellyfinApiKeyFromEnv ? "Set via JELLYFIN_API_KEY env" : "Enter API key"}
                            className="w-64"
                            disabled={!!settings.jellyfinApiKeyFromEnv}
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Jellyfin User ID"
                        description="Required for Library and Favorites on most servers. Find it in Jellyfin: Dashboard → Users → your user → the ID in the URL or API."
                    >
                        <SettingsInput
                            value={settings.jellyfinUserId ?? ""}
                            onChange={(v) => onUpdate({ jellyfinUserId: v || null })}
                            placeholder="e.g. 8152d64174a3fe92b4f191666d5107af"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleTest}
                                disabled={
                                    isTesting ||
                                    !settings.jellyfinUrl?.trim() ||
                                    (!settings.jellyfinApiKey && !settings.jellyfinApiKeyFromEnv)
                                }
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                    hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {testStatus === "loading" ? "Testing..." : "Test connection"}
                            </button>
                            <InlineStatus
                                status={testStatus}
                                message={testMessage}
                                onClear={() => setTestStatus("idle")}
                            />
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
