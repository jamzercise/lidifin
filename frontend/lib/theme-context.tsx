"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    ReactNode,
} from "react";

export type ThemeId = "dark" | "light" | "warm" | "cool" | "high-contrast";

const STORAGE_KEY = "lidifin-theme";
const LEGACY_THEME_KEY = "lidify-theme";

interface ThemeContextType {
    theme: ThemeId;
    setTheme: (theme: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const VALID_THEMES: ThemeId[] = ["dark", "light", "warm", "cool", "high-contrast"];

function getInitialTheme(): ThemeId {
    if (typeof document === "undefined") return "dark";
    const current = document.documentElement.getAttribute("data-theme");
    if (current && VALID_THEMES.includes(current as ThemeId)) return current as ThemeId;
    return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<ThemeId>(getInitialTheme);

    useEffect(() => {
        try {
            const legacy = localStorage.getItem(LEGACY_THEME_KEY);
            if (legacy != null) {
                if (!localStorage.getItem(STORAGE_KEY)) {
                    localStorage.setItem(STORAGE_KEY, legacy);
                }
                localStorage.removeItem(LEGACY_THEME_KEY);
            }
            const stored = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
            if (stored && VALID_THEMES.includes(stored)) {
                setThemeState(stored);
            }
        } catch {
            // Ignore localStorage errors
        }
    }, []);

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
    }, [theme]);

    const setTheme = useCallback((newTheme: ThemeId) => {
        setThemeState(newTheme);
        try {
            localStorage.setItem(STORAGE_KEY, newTheme);
        } catch {
            // Ignore
        }
    }, []);

    const value: ThemeContextType = { theme, setTheme };

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error("useTheme must be used within a ThemeProvider");
    }
    return context;
}
