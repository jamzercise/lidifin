/**
 * Accent token system for the shared page design language.
 *
 * Hybrid strategy: the default `brand` accent maps to the themeable CSS
 * variables (`var(--color-primary)` via Tailwind's `brand` color), so it
 * adapts to whichever theme the user has selected. Pages that want a signature
 * identity (e.g. the Release Radar's amber) can opt into a fixed accent.
 *
 * Class strings are written out in full (not constructed) so Tailwind's
 * content scanner keeps them in the build.
 */

export type Accent =
    | "brand"
    | "amber"
    | "purple"
    | "emerald"
    | "rose"
    | "blue";

export interface AccentTokens {
    /** Vibrant gradient stops for the hero backdrop. Direction-agnostic. */
    heroGradient: string;
    /** Text/icon color for eyebrow labels and section icons. */
    eyebrow: string;
    /** Solid badge used for the page's signature status (e.g. "upcoming"). */
    solidBadge: string;
}

export const ACCENTS: Record<Accent, AccentTokens> = {
    brand: {
        heroGradient: "from-brand/25 via-brand/10 to-transparent",
        eyebrow: "text-brand",
        solidBadge: "bg-brand text-black",
    },
    amber: {
        heroGradient: "from-amber-500/20 via-orange-600/10 to-transparent",
        eyebrow: "text-amber-400",
        solidBadge: "bg-amber-500/90 text-black",
    },
    purple: {
        heroGradient: "from-purple-500/20 via-fuchsia-600/10 to-transparent",
        eyebrow: "text-purple-400",
        solidBadge: "bg-purple-500/90 text-white",
    },
    emerald: {
        heroGradient: "from-emerald-500/20 via-teal-600/10 to-transparent",
        eyebrow: "text-emerald-400",
        solidBadge: "bg-emerald-500/90 text-black",
    },
    rose: {
        heroGradient: "from-rose-500/20 via-pink-600/10 to-transparent",
        eyebrow: "text-rose-400",
        solidBadge: "bg-rose-500/90 text-white",
    },
    blue: {
        heroGradient: "from-blue-500/20 via-sky-600/10 to-transparent",
        eyebrow: "text-blue-400",
        solidBadge: "bg-blue-500/90 text-white",
    },
};

export function getAccent(accent: Accent = "brand"): AccentTokens {
    return ACCENTS[accent] ?? ACCENTS.brand;
}
