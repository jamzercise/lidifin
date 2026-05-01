"use client";

import { ReactNode, useEffect, useId, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "./Button";
import FocusTrap from "focus-trap-react";

const PANEL_EASE = [0.16, 1, 0.3, 1] as const;
const PANEL_DURATION_SEC = 0.22;

export interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    /** Optional icon or badge before the title column. */
    titleLeading?: ReactNode;
    /** Shown under the title (muted). */
    subtitle?: ReactNode;
    /** Renders before the close control. */
    headerActions?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
    className?: string;
    /** Applied to the body wrapper around `children` (after optional `description`). */
    contentClassName?: string;
    closeOnBackdropClick?: boolean;
    /** Merged with default backdrop overlay classes (`bg-black/60`). */
    backdropClassName?: string;
    /** Merged onto the full-screen overlay wrapper (e.g. `z-[60]` when stacking). */
    overlayClassName?: string;
    dialogRole?: "dialog" | "alertdialog";
    /** When set, renders muted body copy and sets `aria-describedby`. */
    description?: string;
    /**
     * Fade/scale the overlay and panel (honours `prefers-reduced-motion`).
     * Set `false` for an instant open/close.
     */
    panelMotion?: boolean;
}

export function Modal({
    isOpen,
    onClose,
    title,
    titleLeading,
    subtitle,
    headerActions,
    children,
    footer,
    className,
    contentClassName,
    closeOnBackdropClick = true,
    backdropClassName,
    overlayClassName,
    dialogRole = "dialog",
    description,
    panelMotion = true,
}: ModalProps) {
    const titleId = useId();
    const descriptionId = useId();
    const reducedMotion = useReducedMotion();
    const animatePanel = panelMotion && !reducedMotion;
    const scrollRestoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null
    );

    useEffect(() => {
        if (!isOpen) return;

        if (scrollRestoreTimeoutRef.current != null) {
            clearTimeout(scrollRestoreTimeoutRef.current);
            scrollRestoreTimeoutRef.current = null;
        }

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };

        const previousOverflow = document.body.style.overflow;
        document.addEventListener("keydown", handleEscape);
        document.body.style.overflow = "hidden";

        return () => {
            document.removeEventListener("keydown", handleEscape);
            if (scrollRestoreTimeoutRef.current != null) {
                clearTimeout(scrollRestoreTimeoutRef.current);
                scrollRestoreTimeoutRef.current = null;
            }
            const delayMs = animatePanel ? PANEL_DURATION_SEC * 1000 : 0;
            scrollRestoreTimeoutRef.current = setTimeout(() => {
                document.body.style.overflow = previousOverflow;
                scrollRestoreTimeoutRef.current = null;
            }, delayMs);
        };
    }, [isOpen, onClose, animatePanel]);

    const panelTransition = {
        duration: animatePanel ? PANEL_DURATION_SEC : 0,
        ease: PANEL_EASE,
    };

    return (
        <AnimatePresence>
            {isOpen ? (
                <motion.div
                    key="modal-overlay"
                    className={cn(
                        "fixed inset-0 z-50 bg-black/60",
                        backdropClassName,
                        overlayClassName
                    )}
                    role="presentation"
                    initial={
                        animatePanel ? { opacity: 0 } : { opacity: 1 }
                    }
                    animate={{ opacity: 1 }}
                    exit={animatePanel ? { opacity: 0 } : { opacity: 1 }}
                    transition={{
                        duration: panelTransition.duration,
                        ease: animatePanel ? PANEL_EASE : "linear",
                    }}
                >
                    <FocusTrap
                        focusTrapOptions={{
                            escapeDeactivates: false,
                            allowOutsideClick: true,
                            returnFocusOnDeactivate: true,
                        }}
                    >
                        <div
                            className="flex h-full min-h-0 w-full items-center justify-center p-4"
                            onClick={
                                closeOnBackdropClick
                                    ? (e) => {
                                          if (e.target === e.currentTarget)
                                              onClose();
                                      }
                                    : undefined
                            }
                        >
                            <motion.div
                                role={dialogRole}
                                aria-modal="true"
                                aria-labelledby={titleId}
                                aria-describedby={
                                    description ? descriptionId : undefined
                                }
                                className={cn(
                                    "bg-gradient-to-br from-[#141414] to-[#0f0f0f] border border-[#262626] rounded-sm shadow-2xl max-w-md w-full p-6",
                                    className
                                )}
                                initial={
                                    animatePanel
                                        ? { opacity: 0, scale: 0.96 }
                                        : { opacity: 1, scale: 1 }
                                }
                                animate={{ opacity: 1, scale: 1 }}
                                exit={
                                    animatePanel
                                        ? { opacity: 0, scale: 0.96 }
                                        : { opacity: 1, scale: 1 }
                                }
                                transition={panelTransition}
                                onClick={(e) => e.stopPropagation()}
                            >
                    <div className="flex items-start justify-between gap-4 mb-4 pb-4 border-b border-[#1c1c1c] shrink-0">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                            {titleLeading}
                            <div className="min-w-0 flex-1">
                                <h2
                                    id={titleId}
                                    className={cn(
                                        "font-medium text-white",
                                        titleLeading
                                            ? "text-xl"
                                            : "text-lg"
                                    )}
                                >
                                    {title}
                                </h2>
                                {subtitle != null && (
                                    <div className="text-sm text-gray-400 mt-1">
                                        {subtitle}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            {headerActions}
                            <Button
                                variant="icon"
                                onClick={onClose}
                                aria-label="Close dialog"
                                className="hover:text-gray-300"
                            >
                                <X className="w-5 h-5" aria-hidden="true" />
                            </Button>
                        </div>
                    </div>

                    {description ? (
                        <p
                            id={descriptionId}
                            className="text-sm text-gray-400 mb-4"
                        >
                            {description}
                        </p>
                    ) : null}

                    {children != null && (
                        <div
                            className={cn(
                                footer ? "mb-6" : "mb-0",
                                contentClassName
                            )}
                        >
                            {children}
                        </div>
                    )}

                    {footer ? (
                        <div className="w-full flex flex-wrap gap-3 justify-end shrink-0">
                            {footer}
                        </div>
                    ) : null}
                            </motion.div>
                        </div>
                    </FocusTrap>
                </motion.div>
            ) : null}
        </AnimatePresence>
    );
}
