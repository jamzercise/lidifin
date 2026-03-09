"use client";

import { Cast } from "lucide-react";
import { cn } from "@/utils/cn";

/**
 * Cast icon with two states:
 * - Default: outline (Lucide)
 * - Active (casting): filled screen + signal waves, with glow
 */
export function CastIcon({
    isCasting,
    className,
    size = 16,
}: {
    isCasting: boolean;
    className?: string;
    size?: number;
}) {
    if (isCasting) {
        // Filled Cast icon - solid screen + signal waves (matches Google's active state)
        return (
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width={size}
                height={size}
                className={cn("fill-current drop-shadow-[0_0_6px_rgba(177,210,195,0.9)]", className)}
                aria-hidden
            >
                {/* Screen - filled rectangle with rounded corners */}
                <rect x="2" y="4" width="20" height="16" rx="2" ry="2" fill="currentColor" />
                {/* Signal waves - curved arcs */}
                <path d="M2 18v-2a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M2 14v-2a13 13 0 0 1 13 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M2 10a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
        );
    }

    return <Cast className={cn(className)} size={size} />;
}
