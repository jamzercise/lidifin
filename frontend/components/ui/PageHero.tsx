import { ReactNode, memo } from "react";
import { cn } from "@/utils/cn";
import { Accent, getAccent } from "./accent";

export interface PageHeroProps {
    /** Large headline. */
    title: string;
    /** Small uppercase label above the title (e.g. "Release Radar"). */
    eyebrow?: string;
    /** Icon shown beside the eyebrow; inherits the accent color. */
    icon?: ReactNode;
    /** Supporting copy / stats beneath the title. */
    subtitle?: ReactNode;
    /** Accent color. Defaults to the themeable brand accent. */
    accent?: Accent;
    /** Optional actions rendered at the bottom of the hero. */
    actions?: ReactNode;
    /**
     * `cinematic` (default): tall full-bleed banner for browse/grid pages.
     * `compact`: lightweight header for list-heavy pages (Library, Favorites).
     */
    variant?: "cinematic" | "compact";
    className?: string;
}

const PageHero = memo(function PageHero({
    title,
    eyebrow,
    icon,
    subtitle,
    accent = "brand",
    actions,
    variant = "cinematic",
    className,
}: PageHeroProps) {
    const tokens = getAccent(accent);

    if (variant === "compact") {
        return (
            <div className={cn("relative", className)}>
                <div className="absolute inset-0 pointer-events-none">
                    <div
                        className={cn(
                            "absolute inset-0 bg-gradient-to-b",
                            tokens.heroGradient
                        )}
                        style={{ height: "35vh" }}
                    />
                    <div
                        className={cn(
                            "absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))]",
                            tokens.heroGradient
                        )}
                        style={{ height: "25vh" }}
                    />
                </div>

                <div className="relative px-4 md:px-8 pt-6 pb-2 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        {eyebrow && (
                            <div className="flex items-center gap-2 mb-1">
                                {icon && (
                                    <span className={cn("shrink-0", tokens.eyebrow)}>
                                        {icon}
                                    </span>
                                )}
                                <span
                                    className={cn(
                                        "text-xs font-medium uppercase tracking-wider",
                                        tokens.eyebrow
                                    )}
                                >
                                    {eyebrow}
                                </span>
                            </div>
                        )}
                        <h1 className="text-2xl font-bold text-white truncate">
                            {title}
                        </h1>
                        {subtitle && (
                            <p className="text-sm text-gray-400 mt-0.5">
                                {subtitle}
                            </p>
                        )}
                    </div>
                    {actions && <div className="shrink-0">{actions}</div>}
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                "relative h-64 md:h-80 overflow-hidden",
                className
            )}
        >
            <div
                className={cn(
                    "absolute inset-0 bg-gradient-to-br",
                    tokens.heroGradient
                )}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0A] via-transparent to-transparent" />

            <div className="relative h-full flex flex-col justify-end p-6 md:p-8">
                {eyebrow && (
                    <div className="flex items-center gap-3 mb-2">
                        {icon && (
                            <span className={cn("shrink-0", tokens.eyebrow)}>
                                {icon}
                            </span>
                        )}
                        <span
                            className={cn(
                                "text-sm font-medium uppercase tracking-wider",
                                tokens.eyebrow
                            )}
                        >
                            {eyebrow}
                        </span>
                    </div>
                )}
                <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
                    {title}
                </h1>
                {subtitle && (
                    <p className="text-white/60 text-sm md:text-base max-w-xl">
                        {subtitle}
                    </p>
                )}
                {actions && <div className="mt-4 flex flex-wrap gap-3">{actions}</div>}
            </div>
        </div>
    );
});

export { PageHero };
