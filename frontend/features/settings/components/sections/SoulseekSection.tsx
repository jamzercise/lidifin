"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { SystemSettings } from "../../types";
import { ExternalLink } from "lucide-react";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface SoulseekSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function SoulseekSection({ settings, onUpdate, onTest, isTesting }: SoulseekSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Connecting...");
        const result = await onTest("soulseek");
        if (result.success) {
            setTestStatus("success");
            setTestMessage("Connected to Soulseek");
        } else {
            setTestStatus("error");
            setTestMessage(result.error || "Connection failed");
        }
    };

    const hasCredentials =
        settings.soulseekUsername &&
        (settings.soulseekPassword || settings.soulseekPasswordSet);

    return (
        <SettingsSection
            id="soulseek"
            title="Soulseek (P2P)"
            description="Your Soulseek (slsknet.org) account. Used for: (1) manual search & download on the Search page, and (2) automatic downloads when importing playlists or using Discovery, if Soulseek is set as the primary download source below."
        >
            <SettingsRow
                label="Soulseek Username"
                description={
                    <span className="flex items-center gap-1.5">
                        Your Soulseek account username
                        <a
                            href="https://www.slsknet.org/news/node/1"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[#B1D2C3] hover:underline"
                        >
                            <ExternalLink className="w-3 h-3" />
                            Create Account
                        </a>
                    </span>
                }
            >
                <SettingsInput
                    value={settings.soulseekUsername || ""}
                    onChange={(v) => onUpdate({ soulseekUsername: v })}
                    placeholder="your_username"
                    className="w-64"
                />
            </SettingsRow>

            <SettingsRow
                label="Soulseek Password"
                description="Your Soulseek account password"
            >
                <SettingsInput
                    type="password"
                    value={settings.soulseekPassword || ""}
                    onChange={(v) => onUpdate({ soulseekPassword: v })}
                    placeholder={settings.soulseekPasswordSet ? "•••••••• (saved — leave blank to keep)" : "your_password"}
                    className="w-64"
                />
            </SettingsRow>

            <div className="pt-2 space-y-2">
                <div className="inline-flex items-center gap-3">
                    <button
                        onClick={handleTest}
                        disabled={isTesting || !hasCredentials}
                        className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                            hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        {testStatus === "loading" ? "Connecting..." : "Test Connection"}
                    </button>
                    <InlineStatus
                        status={testStatus}
                        message={testMessage}
                        onClear={() => setTestStatus("idle")}
                    />
                </div>
                <p className="text-xs text-white/40">
                    Downloads will be saved to your Singles folder automatically
                </p>
            </div>
        </SettingsSection>
    );
}
