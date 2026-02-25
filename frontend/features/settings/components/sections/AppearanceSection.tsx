"use client";

import { SettingsSection, SettingsRow } from "../ui";
import { useTheme, type ThemeId } from "@/lib/theme-context";
import { cn } from "@/utils/cn";

const THEMES: { id: ThemeId; label: string; description: string }[] = [
    { id: "dark", label: "Dark", description: "Default dark theme" },
    { id: "light", label: "Light", description: "Light background" },
    { id: "warm", label: "Warm", description: "Amber and orange tones" },
    { id: "cool", label: "Cool", description: "Blue and slate tones" },
    { id: "high-contrast", label: "High Contrast", description: "Maximum contrast for accessibility" },
];

export function AppearanceSection() {
    const { theme, setTheme } = useTheme();

    return (
        <SettingsSection id="appearance" title="Appearance">
            <SettingsRow
                label="Theme"
                description="Choose a color theme for the app"
            >
                <div className="flex flex-wrap gap-2">
                    {THEMES.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => setTheme(t.id)}
                            className={cn(
                                "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                                theme === t.id
                                    ? "bg-[var(--color-primary)] text-black"
                                    : "bg-[var(--bg-hover)] text-[var(--text-body)] hover:bg-[var(--bg-active)]"
                            )}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </SettingsRow>
        </SettingsSection>
    );
}
