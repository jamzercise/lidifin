"use client";

import { useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { RestartModal } from "@/components/ui/RestartModal";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { useSystemSettings } from "@/features/settings/hooks/useSystemSettings";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { InlineStatus, useInlineStatus } from "@/components/ui/InlineStatus";
import {
    SettingsLayout,
    SidebarItem
} from "@/features/settings/components/ui";

// Section components
import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { AppearanceSection } from "@/features/settings/components/sections/AppearanceSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { DownloadPreferencesSection } from "@/features/settings/components/sections/DownloadPreferencesSection";
import { LidarrSection } from "@/features/settings/components/sections/LidarrSection";
import { AudiobookshelfSection } from "@/features/settings/components/sections/AudiobookshelfSection";
import { JellyfinSection } from "@/features/settings/components/sections/JellyfinSection";
import { AudioMuseSection } from "@/features/settings/components/sections/AudioMuseSection";
import { SoulseekSection } from "@/features/settings/components/sections/SoulseekSection";
import { AIServicesSection } from "@/features/settings/components/sections/AIServicesSection";
import { StoragePathsSection } from "@/features/settings/components/sections/StoragePathsSection";
import { CacheSection } from "@/features/settings/components/sections/CacheSection";
import { UserManagementSection } from "@/features/settings/components/sections/UserManagementSection";

// Define sidebar items
const sidebarItems: SidebarItem[] = [
    { id: "account", label: "Account" },
    { id: "appearance", label: "Appearance" },
    { id: "playback", label: "Playback" },
    { id: "download-preferences", label: "Download Preferences", adminOnly: true },
    { id: "lidarr", label: "Download Services", adminOnly: true },
    { id: "audiobookshelf", label: "Media Servers", adminOnly: true },
    { id: "jellyfin", label: "Jellyfin (Music)", adminOnly: true },
    { id: "audiomuse", label: "AudioMuse-AI", adminOnly: true },
    { id: "soulseek", label: "P2P Networks", adminOnly: true },
    { id: "ai-services", label: "Artwork", adminOnly: true },
    { id: "storage", label: "Storage", adminOnly: true },
    { id: "cache", label: "Cache & Automation", adminOnly: true },
    { id: "users", label: "Users", adminOnly: true },
];

export default function SettingsPage() {
    const { isAuthenticated, isLoading: authLoading, user } = useAuth();
    useSearchParams();
    const [isSaving, setIsSaving] = useState(false);
    const [showRestartModal, setShowRestartModal] = useState(false);
    const [testingServices, setTestingServices] = useState<Record<string, boolean>>({});
    const saveStatus = useInlineStatus();

    const isAdmin = user?.role === "admin";

    // User settings hook
    const {
        settings: userSettings,
        updateSettings: updateUserSettings,
        saveSettings: saveUserSettings,
    } = useSettingsData();

    // System settings hook (only used if admin)
    const {
        systemSettings,
        changedServices,
        updateSystemSettings,
        saveSystemSettings,
        testService,
    } = useSystemSettings();

    // Initial hash handling lives in SettingsLayout, which also has to expand
    // the target section before scrolling to it.

    // Unified save function
    const handleSaveAll = useCallback(async () => {
        setIsSaving(true);
        saveStatus.setLoading();
        let hasError = false;
        let changedSystemServices: string[] = [];

        try {
            await saveUserSettings(userSettings);
        } catch (error) {
            console.error("Failed to save user settings:", error);
            hasError = true;
        }

        if (isAdmin) {
            if (systemSettings.jellyfinEnabled && (!(systemSettings.jellyfinUrl ?? "").trim() || !(systemSettings.jellyfinUserId ?? "").trim())) {
                saveStatus.setError("When Jellyfin is enabled, URL and User ID are required");
                setIsSaving(false);
                return;
            }
            try {
                changedSystemServices = await saveSystemSettings(systemSettings) || [];
            } catch (error: unknown) {
                console.error("Failed to save system settings:", error);
                const msg = error && typeof error === "object" && "response" in error
                    ? (error as { response?: { data?: { error?: string } } }).response?.data?.error
                    : undefined;
                saveStatus.setError(msg || "Failed to save system settings");
                hasError = true;
            }
        }

        setIsSaving(false);

        if (hasError) {
            saveStatus.setError("Failed to save");
        } else {
            saveStatus.setSuccess("Saved");
            if (changedSystemServices.length > 0) {
                setShowRestartModal(true);
            }
        }
    }, [userSettings, systemSettings, isAdmin, saveUserSettings, saveSystemSettings, saveStatus]);

    // Test service wrapper
    const handleTestService = useCallback(async (service: string) => {
        setTestingServices(prev => ({ ...prev, [service]: true }));
        try {
            return await testService(service);
        } finally {
            setTestingServices(prev => ({ ...prev, [service]: false }));
        }
    }, [testService]);

    if (authLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-theme-primary">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <>
            <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
                {/* Account Section */}
                <AccountSection />

                {/* Appearance Section */}
                <AppearanceSection />

                {/* Playback Section */}
                <PlaybackSection
                    value={userSettings.playbackQuality}
                    onChange={(quality) => updateUserSettings({ playbackQuality: quality })}
                />

                {/* Admin-only sections */}
                {isAdmin && (
                    <>
                        {/* Download Preferences */}
                        <DownloadPreferencesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* Download Services - Lidarr */}
                        <LidarrSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.lidarr || false}
                        />

                        {/* Media Servers - Audiobookshelf */}
                        <AudiobookshelfSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.audiobookshelf || false}
                        />

                        {/* Jellyfin (Music) - Lidifin */}
                        <JellyfinSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.jellyfin || false}
                        />

                        {/* AudioMuse-AI - Instant mood playlists */}
                        <AudioMuseSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            isTesting={false}
                        />

                        {/* P2P Networks - Soulseek */}
                        <SoulseekSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.slskd || false}
                        />

                        {/* AI Services */}
                        <AIServicesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.openai || testingServices.fanart || false}
                        />

                        {/* Storage */}
                        <StoragePathsSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={false}
                        />

                        {/* Cache & Automation */}
                        <CacheSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* User Management */}
                        <UserManagementSection />
                    </>
                )}

                {/* Save Button - Fixed at bottom */}
                <div className="sticky bottom-0 pt-8 pb-8 bg-theme-primary">
                    <div className="relative">
                        <button
                            onClick={handleSaveAll}
                            disabled={isSaving}
                            className="w-full bg-white text-black font-semibold py-3 px-4 rounded-full
                                hover:scale-[1.02] active:scale-[0.98] transition-transform
                                disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                        >
                            {isSaving ? "Saving..." : "Save"}
                        </button>
                        {/* Status appears below button, absolutely positioned */}
                        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2">
                            <InlineStatus {...saveStatus.props} />
                        </div>
                    </div>
                </div>
            </SettingsLayout>

            {/* Restart Modal */}
            <RestartModal
                isOpen={showRestartModal}
                onClose={() => setShowRestartModal(false)}
                changedServices={changedServices}
            />
        </>
    );
}
