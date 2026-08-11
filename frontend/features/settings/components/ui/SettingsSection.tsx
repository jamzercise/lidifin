"use client";

import { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { useSettingsSections } from "./SettingsSectionsContext";

interface SettingsSectionProps {
    id: string;
    title: string;
    description?: string;
    children: ReactNode;
    showSeparator?: boolean;
}

export function SettingsSection({
    id,
    title,
    description,
    children,
    showSeparator = true,
}: SettingsSectionProps) {
    const sections = useSettingsSections();

    // Without a provider the section stays permanently expanded, preserving the
    // original behaviour for any standalone use.
    const collapsible = sections !== null;
    const isOpen = sections ? sections.isOpen(id) : true;
    const contentId = `${id}-content`;

    return (
        <section id={id} className="scroll-mt-24">
            <h2
                className={cn(
                    "text-base font-semibold text-theme-text-primary",
                    collapsible ? (isOpen ? "mb-2" : "mb-0") : "mb-1"
                )}
            >
                {collapsible ? (
                    <button
                        type="button"
                        onClick={() => sections.toggle(id)}
                        aria-expanded={isOpen}
                        aria-controls={contentId}
                        className={cn(
                            "w-full flex items-center gap-2 text-left",
                            "py-2 -mx-2 px-2 rounded-md transition-colors",
                            "hover:bg-[var(--bg-hover)]"
                        )}
                    >
                        <ChevronRight
                            aria-hidden="true"
                            className={cn(
                                "w-4 h-4 shrink-0 text-theme-text-secondary transition-transform duration-150",
                                isOpen && "rotate-90"
                            )}
                        />
                        {title}
                    </button>
                ) : (
                    title
                )}
            </h2>

            {/* Kept mounted while collapsed so in-progress edits and local UI
                state survive toggling. */}
            <div id={contentId} hidden={!isOpen}>
                {description && (
                    <p
                        className={cn(
                            "text-sm text-theme-text-secondary mb-4",
                            // Align with the title text, clearing the chevron.
                            collapsible && "ml-6"
                        )}
                    >
                        {description}
                    </p>
                )}

                <div className="space-y-1">{children}</div>
            </div>

            {showSeparator && (
                <div
                    className={cn(
                        "border-t border-white/5 mb-6",
                        isOpen ? "mt-6" : "mt-2"
                    )}
                />
            )}
        </section>
    );
}
