import { ReactNode, memo } from "react";
import Link from "next/link";
import Image from "next/image";
import { cn } from "@/utils/cn";
import { Accent, getAccent } from "./accent";

export type CoverCardBadgeTone = "accent" | "success" | "neutral";

export interface CoverCardBadge {
    label: string;
    tone?: CoverCardBadgeTone;
}

export interface CoverCardAction {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    loading?: boolean;
    /** Force the overlay to stay visible (e.g. while loading). */
    visible?: boolean;
}

export interface CoverCardProps {
    title: string;
    subtitle?: string;
    /** Extra line below the subtitle (e.g. a release date). */
    caption?: ReactNode;
    imageUrl?: string | null;
    placeholderIcon?: ReactNode;
    /** Navigates when the card body is clicked. */
    href?: string;
    /** Badge pinned to the top-left of the cover. */
    badge?: CoverCardBadge;
    /** Small indicator pinned to the bottom-right of the cover. */
    cornerIndicator?: ReactNode;
    /** Hover-revealed primary action overlaying the cover. */
    action?: CoverCardAction;
    shape?: "square" | "circle";
    accent?: Accent;
    /** Responsive `sizes` hint for the underlying next/image. */
    imageSizes?: string;
    className?: string;
}

const DEFAULT_SIZES =
    "(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw";

function badgeToneClass(tone: CoverCardBadgeTone, accentBadge: string): string {
    switch (tone) {
        case "accent":
            return accentBadge;
        case "success":
            return "bg-emerald-500/90 text-black";
        case "neutral":
        default:
            return "bg-white/20 text-white";
    }
}

const CoverCard = memo(function CoverCard({
    title,
    subtitle,
    caption,
    imageUrl,
    placeholderIcon,
    href,
    badge,
    cornerIndicator,
    action,
    shape = "square",
    accent = "brand",
    imageSizes,
    className,
}: CoverCardProps) {
    const tokens = getAccent(accent);
    const roundedCover = shape === "circle" ? "rounded-full" : "rounded-lg";

    const cover = (
        <div
            className={cn(
                "aspect-square overflow-hidden bg-white/5 relative shadow-lg",
                roundedCover
            )}
        >
            {imageUrl ? (
                <Image
                    src={imageUrl}
                    alt={title}
                    fill
                    sizes={imageSizes ?? DEFAULT_SIZES}
                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                    unoptimized
                />
            ) : (
                <div className="w-full h-full flex items-center justify-center text-white/20">
                    {placeholderIcon}
                </div>
            )}

            {badge && (
                <div
                    className={cn(
                        "absolute top-2 left-2 px-2 py-1 rounded text-xs font-medium",
                        badgeToneClass(badge.tone ?? "neutral", tokens.solidBadge)
                    )}
                >
                    {badge.label}
                </div>
            )}

            {cornerIndicator && (
                <div className="absolute bottom-2 right-2">{cornerIndicator}</div>
            )}
        </div>
    );

    const meta = (
        <div className="space-y-1 mt-3">
            <h3
                className="text-sm font-medium text-white truncate"
                title={title}
            >
                {title}
            </h3>
            {subtitle && (
                <p className="text-xs text-white/50 truncate" title={subtitle}>
                    {subtitle}
                </p>
            )}
            {caption && <div className="text-xs">{caption}</div>}
        </div>
    );

    const body = href ? (
        <Link href={href} className="block">
            {cover}
            {meta}
        </Link>
    ) : (
        <>
            {cover}
            {meta}
        </>
    );

    return (
        <div className={cn("group relative", className)}>
            {body}

            {/* Overlay action lives outside any <Link> to avoid nested anchors. */}
            {action && (
                <button
                    type="button"
                    onClick={action.onClick}
                    disabled={action.loading}
                    aria-label={action.label}
                    className={cn(
                        "absolute inset-x-0 top-0 z-10 aspect-square flex items-center justify-center",
                        roundedCover,
                        "bg-black/60 text-white transition-opacity",
                        action.visible || action.loading
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                        action.loading && "cursor-not-allowed"
                    )}
                >
                    {action.icon}
                </button>
            )}
        </div>
    );
});

export { CoverCard };
