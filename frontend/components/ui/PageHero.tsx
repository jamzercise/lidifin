import { ReactNode, memo } from "react";
import Image from "next/image";
import { cn } from "@/utils/cn";
import { Accent, getAccent } from "./accent";

export interface PageHeroStat {
    /** Small icon rendered before the label; inherits the accent color. */
    icon?: ReactNode;
    label: string;
}

export interface PageHeroProps {
    /** Large headline. */
    title: string;
    /** Small uppercase label above the title (e.g. "Release Radar"). */
    eyebrow?: string;
    /** Icon shown beside the eyebrow; inherits the accent color. */
    icon?: ReactNode;
    /** Supporting copy beneath the title. */
    subtitle?: ReactNode;
    /** Stat chips rendered beneath the subtitle (counts, durations, etc.). */
    stats?: PageHeroStat[];
    /**
     * Cover-art URLs blurred into a tinted collage behind the header.
     * Falsy entries are skipped; at most 4 are used. When absent, the hero
     * falls back to a large watermark of `icon` plus an accent glow.
     */
    backdropImages?: Array<string | null | undefined>;
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

const MAX_BACKDROP_IMAGES = 4;

function BackdropCollage({ images }: { images: string[] }) {
    return (
        <div className="absolute inset-0 flex" aria-hidden>
            {images.map((src, i) => (
                <div key={`${src}-${i}`} className="relative flex-1">
                    <Image
                        src={src}
                        alt=""
                        fill
                        sizes="25vw"
                        unoptimized
                        className="object-cover blur-2xl scale-125 opacity-40 saturate-150"
                    />
                </div>
            ))}
        </div>
    );
}

function StatChips({
    stats,
    eyebrowClass,
    className,
}: {
    stats: PageHeroStat[];
    eyebrowClass: string;
    className?: string;
}) {
    return (
        <div className={cn("flex flex-wrap items-center gap-2", className)}>
            {stats.map((stat, i) => (
                <span
                    key={i}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/10 text-xs text-white/70 backdrop-blur-sm"
                >
                    {stat.icon && (
                        <span
                            className={cn(
                                "shrink-0 [&_svg]:w-3.5 [&_svg]:h-3.5",
                                eyebrowClass
                            )}
                        >
                            {stat.icon}
                        </span>
                    )}
                    {stat.label}
                </span>
            ))}
        </div>
    );
}

const PageHero = memo(function PageHero({
    title,
    eyebrow,
    icon,
    subtitle,
    stats,
    backdropImages,
    accent = "brand",
    actions,
    variant = "cinematic",
    className,
}: PageHeroProps) {
    const tokens = getAccent(accent);
    const backdrop = (backdropImages ?? [])
        .filter((src): src is string => Boolean(src))
        .slice(0, MAX_BACKDROP_IMAGES);
    const hasBackdrop = backdrop.length > 0;
    const hasStats = Boolean(stats && stats.length > 0);

    if (variant === "compact") {
        return (
            <div className={cn("relative", className)}>
                <div className="absolute inset-0 pointer-events-none">
                    {/* Blurred cover-art collage, faded into the page background */}
                    {hasBackdrop && (
                        <div
                            className="absolute inset-0 overflow-hidden"
                            style={{ height: "30vh" }}
                        >
                            <BackdropCollage images={backdrop} />
                            <div className="absolute inset-0 bg-[#0A0A0A]/55" />
                            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0A0A0A]/30 to-[#0A0A0A]" />
                        </div>
                    )}

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

                    {/* Watermark icon + glow when there's no artwork to show */}
                    {!hasBackdrop && (
                        <div
                            className="absolute inset-x-0 top-0 overflow-hidden"
                            style={{ height: "22vh" }}
                            aria-hidden
                        >
                            <div
                                className={cn(
                                    "absolute -top-12 left-8 w-72 h-40 rounded-full blur-3xl",
                                    tokens.glow
                                )}
                            />
                            {icon && (
                                <span className="absolute -right-5 -top-5 text-white opacity-[0.05] [&_svg]:w-40 [&_svg]:h-40">
                                    {icon}
                                </span>
                            )}
                        </div>
                    )}
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
                        {hasStats && (
                            <StatChips
                                stats={stats!}
                                eyebrowClass={tokens.eyebrow}
                                className="mt-2"
                            />
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
            {hasBackdrop && (
                <>
                    <BackdropCollage images={backdrop} />
                    <div className="absolute inset-0 bg-[#0A0A0A]/50" />
                </>
            )}

            <div
                className={cn(
                    "absolute inset-0 bg-gradient-to-br",
                    tokens.heroGradient
                )}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0A] via-transparent to-transparent" />

            {!hasBackdrop && (
                <div className="absolute inset-0 pointer-events-none" aria-hidden>
                    <div
                        className={cn(
                            "absolute -top-16 left-10 w-96 h-56 rounded-full blur-3xl",
                            tokens.glow
                        )}
                    />
                    {icon && (
                        <span className="absolute -right-8 -bottom-10 text-white opacity-[0.05] [&_svg]:w-64 [&_svg]:h-64">
                            {icon}
                        </span>
                    )}
                </div>
            )}

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
                {hasStats && (
                    <StatChips
                        stats={stats!}
                        eyebrowClass={tokens.eyebrow}
                        className="mt-3"
                    />
                )}
                {actions && <div className="mt-4 flex flex-wrap gap-3">{actions}</div>}
            </div>
        </div>
    );
});

export { PageHero };
