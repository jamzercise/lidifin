import { ReactNode, memo } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { Accent, getAccent } from "./accent";

export interface SectionHeadingProps {
    title: string;
    /** Icon shown before the title; inherits the accent color. */
    icon?: ReactNode;
    /** Count rendered as a muted "(N)" after the title. */
    count?: number;
    accent?: Accent;
    /** Renders a "Show all" link on the right. */
    showAllHref?: string;
    /** Custom right-aligned content (overrides showAllHref). */
    action?: ReactNode;
    className?: string;
}

const SectionHeading = memo(function SectionHeading({
    title,
    icon,
    count,
    accent = "brand",
    showAllHref,
    action,
    className,
}: SectionHeadingProps) {
    const tokens = getAccent(accent);

    return (
        <div className={cn("flex items-center gap-3 mb-6", className)}>
            {icon && <span className={cn("shrink-0", tokens.eyebrow)}>{icon}</span>}
            <h2 className="text-xl font-semibold text-white">{title}</h2>
            {typeof count === "number" && (
                <span className="text-white/40 text-sm">({count})</span>
            )}
            {(action || showAllHref) && (
                <div className="ml-auto">
                    {action ? (
                        action
                    ) : (
                        <Link
                            href={showAllHref!}
                            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors font-semibold group"
                        >
                            Show all
                            <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                        </Link>
                    )}
                </div>
            )}
        </div>
    );
});

export { SectionHeading };
