"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";

const STORAGE_KEY = "lidifin:settings:open-sections";

interface SettingsSectionsValue {
    isOpen: (id: string) => boolean;
    toggle: (id: string) => void;
    open: (id: string) => void;
    expandAll: () => void;
    collapseAll: () => void;
    openCount: number;
    sectionCount: number;
}

const SettingsSectionsContext = createContext<SettingsSectionsValue | null>(
    null
);

function readStoredIds(): Set<string> {
    if (typeof window === "undefined") return new Set();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return new Set(
            Array.isArray(parsed)
                ? parsed.filter((id): id is string => typeof id === "string")
                : []
        );
    } catch {
        // Unavailable or corrupt storage just means everything starts collapsed.
        return new Set();
    }
}

/**
 * Tracks which settings sections are expanded.
 *
 * State lives above the sections so the sidebar and deep links can expand a
 * target before scrolling to it, and so "expand all" can act on every section
 * at once. Choices persist across navigation and reloads.
 */
export function SettingsSectionsProvider({
    children,
    sectionIds,
}: {
    children: ReactNode;
    sectionIds: string[];
}) {
    // Reading storage in the lazy initializer (rather than a mount effect) avoids
    // a cascading render, matching useActivityPanel and theme-context.
    const [openIds, setOpenIds] = useState<Set<string>>(readStoredIds);

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify([...openIds]));
        } catch {
            // Persistence is a convenience; failing to save must not break the page.
        }
    }, [openIds]);

    const isOpen = useCallback((id: string) => openIds.has(id), [openIds]);

    const toggle = useCallback((id: string) => {
        setOpenIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const open = useCallback((id: string) => {
        setOpenIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    }, []);

    const expandAll = useCallback(
        () => setOpenIds(new Set(sectionIds)),
        [sectionIds]
    );

    const collapseAll = useCallback(() => setOpenIds(new Set()), []);

    const value = useMemo<SettingsSectionsValue>(
        () => ({
            isOpen,
            toggle,
            open,
            expandAll,
            collapseAll,
            openCount: sectionIds.filter((id) => openIds.has(id)).length,
            sectionCount: sectionIds.length,
        }),
        [isOpen, toggle, open, expandAll, collapseAll, openIds, sectionIds]
    );

    return (
        <SettingsSectionsContext.Provider value={value}>
            {children}
        </SettingsSectionsContext.Provider>
    );
}

/**
 * Returns null when a section renders outside the provider, so SettingsSection
 * can fall back to being permanently expanded rather than throwing.
 */
export function useSettingsSections(): SettingsSectionsValue | null {
    return useContext(SettingsSectionsContext);
}
