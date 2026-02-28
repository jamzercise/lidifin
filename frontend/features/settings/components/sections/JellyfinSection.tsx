"use client";

import { useState, useEffect, useRef } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";
import { Loader2 } from "lucide-react";

interface JellyfinSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function JellyfinSection({ settings, onUpdate, onTest, isTesting }: JellyfinSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");
    const [enriching, setEnriching] = useState(false);
    const [enrichMessage, setEnrichMessage] = useState("");
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const handleEnrichGenres = async () => {
        if (enriching) return;
        setEnriching(true);
        setEnrichMessage("");
        try {
            const res = await api.enrichJellyfinMetadata();
            if (!res.success) {
                setEnrichMessage("Enrichment already in progress");
                setEnriching(false);
                return;
            }
            // Poll for completion (enrich runs async in background)
            const maxPoll = 30 * 60 * 1000; // 30 min
            const start = Date.now();
            pollRef.current = setInterval(async () => {
                try {
                    const status = await api.getJellyfinMetadataStatus();
                    if (status.status === "idle") {
                        if (pollRef.current) clearInterval(pollRef.current);
                        pollRef.current = null;
                        setEnriching(false);
                        if (status.lastError) {
                            setEnrichMessage(status.lastError);
                        } else if (status.lastEnriched !== undefined) {
                            setEnrichMessage(
                                status.lastEnriched > 0
                                    ? `Enriched ${status.lastEnriched} tracks. Run again if you have more.`
                                    : "All tracks are already enriched."
                            );
                        }
                    } else if (Date.now() - start > maxPoll) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        pollRef.current = null;
                        setEnriching(false);
                        setEnrichMessage("Enrichment is still running. Check back later.");
                    }
                } catch {
                    /* ignore poll errors */
                }
            }, 2000);
        } catch (err: unknown) {
            const e = err as { status?: number };
            if (e?.status === 409) {
                setEnrichMessage("Enrichment already in progress – polling…");
                // Job is running; poll until idle
                const maxPoll = 30 * 60 * 1000;
                const start = Date.now();
                pollRef.current = setInterval(async () => {
                    try {
                        const status = await api.getJellyfinMetadataStatus();
                        if (status.status === "idle") {
                            if (pollRef.current) clearInterval(pollRef.current);
                            pollRef.current = null;
                            setEnriching(false);
                            setEnrichMessage(
                                status.lastEnriched !== undefined && status.lastEnriched > 0
                                    ? `Enriched ${status.lastEnriched} tracks.`
                                    : "Enrichment complete."
                            );
                        } else if (Date.now() - start > maxPoll) {
                            if (pollRef.current) clearInterval(pollRef.current);
                            pollRef.current = null;
                            setEnriching(false);
                            setEnrichMessage("Enrichment is still running. Check back later.");
                        }
                    } catch {
                        /* ignore */
                    }
                }, 2000);
            } else {
                setEnrichMessage("Failed to start enrichment. Check console.");
                console.error("Jellyfin enrich error:", err);
                setEnriching(false);
            }
        }
    };

    useEffect(() => () => {
        if (pollRef.current) clearInterval(pollRef.current);
    }, []);

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
            description="Use Jellyfin as your music library and streaming source (Lidifin). API key and User ID are required when enabled."
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
                        label="Jellyfin User ID (required)"
                        description="Required when Jellyfin is enabled. Find it in Jellyfin: Dashboard → Users → your user → the ID in the URL or API."
                    >
                        <SettingsInput
                            value={settings.jellyfinUserId ?? ""}
                            onChange={(v) => onUpdate({ jellyfinUserId: v || null })}
                            placeholder="e.g. 8152d64174a3fe92b4f191666d5107af"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Proxy streams through Lidifin"
                        description="When enabled, audio is streamed through Lidifin instead of directly from Jellyfin. Use this when accessing Lidifin from a network that cannot reach Jellyfin (e.g. mobile data, remote). Requires Lidifin backend to reach Jellyfin."
                        htmlFor="jellyfin-proxy-streams"
                    >
                        <SettingsToggle
                            id="jellyfin-proxy-streams"
                            checked={!!settings.jellyfinProxyStreams}
                            onChange={(checked) => onUpdate({ jellyfinProxyStreams: checked })}
                        />
                    </SettingsRow>

                    <div className="pt-2 space-y-3">
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
                        <div>
                            <button
                                onClick={handleEnrichGenres}
                                disabled={enriching}
                                className="px-4 py-1.5 text-sm bg-[#B1D2C3] text-black rounded-full
                                    hover:bg-[#9fc4b5] disabled:opacity-50 disabled:cursor-not-allowed transition-colors
                                    inline-flex items-center gap-2"
                            >
                                {enriching ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Enriching...
                                    </>
                                ) : (
                                    "Enrich genres & moods"
                                )}
                            </button>
                            <p className="text-xs text-white/50 mt-1.5">
                                Fetches genre and mood tags from Last.fm for Genre Radio. Run repeatedly to backfill a large library.
                            </p>
                            {enrichMessage && (
                                <p className="text-xs text-white/70 mt-1">{enrichMessage}</p>
                            )}
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
