"use client";

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingsSidebar, SidebarItem } from "./SettingsSidebar";
import {
    SettingsSectionsProvider,
    useSettingsSections,
} from "./SettingsSectionsContext";

interface SettingsLayoutProps {
    children: ReactNode;
    sidebarItems: SidebarItem[];
    isAdmin: boolean;
}

export function SettingsLayout({ children, sidebarItems, isAdmin }: SettingsLayoutProps) {
    const visibleIds = useMemo(
        () =>
            sidebarItems
                .filter((item) => !item.adminOnly || isAdmin)
                .map((item) => item.id),
        [sidebarItems, isAdmin]
    );

    return (
        <SettingsSectionsProvider sectionIds={visibleIds}>
            <SettingsLayoutInner sidebarItems={sidebarItems} isAdmin={isAdmin}>
                {children}
            </SettingsLayoutInner>
        </SettingsSectionsProvider>
    );
}

function SettingsLayoutInner({ children, sidebarItems, isAdmin }: SettingsLayoutProps) {
    const [activeSection, setActiveSection] = useState(sidebarItems[0]?.id || "");
    const mainContentRef = useRef<HTMLDivElement>(null);
    const sections = useSettingsSections();
    // Depend on the stable `open` callback rather than the context object, whose
    // identity changes on every toggle — otherwise the hash effect below would
    // re-run and scroll back to the deep-linked section on each expand.
    const openSection = sections?.open;

    // Expanding changes the page height, so scroll on the next frame once the
    // target has settled into its final position.
    const revealSection = useCallback(
        (id: string) => {
            openSection?.(id);
            requestAnimationFrame(() => {
                document
                    .getElementById(id)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
        },
        [openSection]
    );

    // Handle sidebar click - expand then scroll to section
    const handleSectionClick = useCallback(
        (id: string) => {
            if (!document.getElementById(id)) return;
            revealSection(id);
            setActiveSection(id);
        },
        [revealSection]
    );

    // Deep links (/settings#soulseek) must expand their target, not just scroll
    // to a collapsed header.
    useEffect(() => {
        const hash = window.location.hash.slice(1);
        if (!hash) return;

        const timer = setTimeout(() => {
            if (document.getElementById(hash)) {
                revealSection(hash);
                setActiveSection(hash);
            }
        }, 100);

        return () => clearTimeout(timer);
    }, [revealSection]);

    const allExpanded =
        !!sections &&
        sections.sectionCount > 0 &&
        sections.openCount === sections.sectionCount;
    
    // Track active section based on scroll position
    useEffect(() => {
        const visibleItems = sidebarItems.filter(item => !item.adminOnly || isAdmin);
        
        // Find the scrollable parent (the main element in AuthenticatedLayout)
        const findScrollableParent = (el: HTMLElement | null): HTMLElement | null => {
            while (el) {
                const style = window.getComputedStyle(el);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        };
        
        const scrollContainer = mainContentRef.current 
            ? findScrollableParent(mainContentRef.current) 
            : null;
        
        if (!scrollContainer) return;
        
        // Use scroll event for smooth tracking
        const handleScroll = () => {
            const containerRect = scrollContainer.getBoundingClientRect();
            const offset = 150; // Offset from top
            
            // Find the section that's currently in view
            let currentSection = visibleItems[0]?.id || "";
            
            for (const item of visibleItems) {
                const element = document.getElementById(item.id);
                if (element) {
                    const rect = element.getBoundingClientRect();
                    // Check if element top is above the offset line
                    if (rect.top <= containerRect.top + offset) {
                        currentSection = item.id;
                    }
                }
            }
            
            setActiveSection(prev => {
                if (prev !== currentSection) {
                    return currentSection;
                }
                return prev;
            });
        };
        
        // Throttle scroll events
        let ticking = false;
        const scrollHandler = () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    handleScroll();
                    ticking = false;
                });
                ticking = true;
            }
        };
        
        scrollContainer.addEventListener("scroll", scrollHandler, { passive: true });
        
        // Initial check
        handleScroll();
        
        return () => scrollContainer.removeEventListener("scroll", scrollHandler);
    }, [sidebarItems, isAdmin]);
    
    return (
        <div className="min-h-screen bg-theme-primary relative">
            {/* Subtle gradient for systems page feel */}
            <div 
                className="absolute inset-0 pointer-events-none"
                style={{
                    backgroundImage: 'linear-gradient(to bottom, var(--bg-hover) 0%, var(--bg-secondary) 15%, var(--bg-primary) 30%)'
                }}
            />
            
            <div className="relative max-w-5xl mx-auto px-4 md:px-8 py-8">
                {/* Header */}
                <div className="flex items-center justify-between gap-4 mb-8">
                    <h1 className="text-2xl font-bold text-theme-text-primary">Settings</h1>
                    {sections && sections.sectionCount > 0 && (
                        <button
                            type="button"
                            onClick={
                                allExpanded
                                    ? sections.collapseAll
                                    : sections.expandAll
                            }
                            className="text-sm text-theme-text-secondary hover:text-theme-text-primary transition-colors px-3 py-1.5 rounded-md hover:bg-[var(--bg-hover)]"
                        >
                            {allExpanded ? "Collapse all" : "Expand all"}
                        </button>
                    )}
                </div>
                
                {/* Layout */}
                <div className="flex gap-12">
                    {/* Sidebar */}
                    <SettingsSidebar
                        items={sidebarItems}
                        activeSection={activeSection}
                        onSectionClick={handleSectionClick}
                        isAdmin={isAdmin}
                    />
                    
                    {/* Main Content */}
                    <main ref={mainContentRef} className="flex-1 min-w-0">
                        {children}
                    </main>
                </div>
            </div>
        </div>
    );
}

