"use client";

import { useState, useEffect, useRef } from "react";
import { Timer } from "lucide-react";
import { cn } from "@/utils/cn";

const OPTIONS = [
    { label: "Off", value: null as number | null },
    { label: "1 min", value: 1 },
    { label: "5 min", value: 5 },
    { label: "10 min", value: 10 },
    { label: "15 min", value: 15 },
    { label: "20 min", value: 20 },
    { label: "30 min", value: 30 },
    { label: "45 min", value: 45 },
    { label: "60 min", value: 60 },
];

interface SleepTimerButtonProps {
    sleepTimerEndsAt: number | null;
    setSleepTimer: (minutes: number | null) => void;
    disabled?: boolean;
    hasMedia?: boolean;
    /** Placement of dropdown: "top" (above button) or "bottom" (below) */
    dropdownPlacement?: "top" | "bottom";
    /** Smaller icon for mini/overlay */
    size?: "sm" | "md";
    className?: string;
}

export function SleepTimerButton({
    sleepTimerEndsAt,
    setSleepTimer,
    disabled = false,
    hasMedia = true,
    dropdownPlacement = "top",
    size = "md",
    className,
}: SleepTimerButtonProps) {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Tick once a minute while a timer is active so the displayed countdown
    // updates. Reading Date.now() during render is impure (React 19 compiler
    // flags it because two renders at different wall-clock times can disagree).
    // Storing "now" in state keeps the render output deterministic for a given
    // render pass.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (sleepTimerEndsAt == null) return;
        const tick = () => setNow(Date.now());
        tick();
        const id = setInterval(tick, 30_000);
        return () => clearInterval(id);
    }, [sleepTimerEndsAt]);

    const minutesRemaining = sleepTimerEndsAt
        ? Math.max(0, Math.ceil((sleepTimerEndsAt - now) / 60000))
        : null;

    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("click", handleClick);
        return () => document.removeEventListener("click", handleClick);
    }, [open]);

    const iconClass = size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4";

    return (
        <div className={cn("relative", className)} ref={menuRef}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                disabled={disabled || !hasMedia}
                className={cn(
                    "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                    sleepTimerEndsAt ? "text-amber-400 hover:text-amber-300" : "text-gray-400 hover:text-white"
                )}
                aria-label={sleepTimerEndsAt ? `Sleep timer: ${minutesRemaining} min left` : "Sleep timer"}
                aria-expanded={open}
                aria-haspopup="true"
                title={
                    sleepTimerEndsAt
                        ? `Sleep timer: ${minutesRemaining} min (click to change)`
                        : "Sleep timer - stop playback after a set time"
                }
            >
                <Timer className={iconClass} />
                {minutesRemaining != null && minutesRemaining > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 text-[9px] font-bold text-amber-400">
                        {minutesRemaining}
                    </span>
                )}
            </button>
            {open && (
                <div
                    className={cn(
                        "absolute left-1/2 -translate-x-1/2 py-1.5 min-w-[120px] bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl z-50",
                        dropdownPlacement === "top" ? "bottom-full mb-2" : "top-full mt-2"
                    )}
                    role="menu"
                >
                    <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-white/5">
                        Sleep timer
                    </div>
                    {OPTIONS.map(({ label, value }) => (
                        <button
                            key={label}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setSleepTimer(value);
                                setOpen(false);
                            }}
                            className="w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 transition-colors text-gray-300"
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
