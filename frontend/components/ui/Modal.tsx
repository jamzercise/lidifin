"use client";

import { ReactNode, useEffect, useId } from "react";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "./Button";
import FocusTrap from "focus-trap-react";

export interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    footer?: ReactNode;
    className?: string;
    /**
     * If true, clicking the dimmed backdrop closes the modal.
     * Defaults to true. Set to false for confirmation/destructive flows
     * where accidental dismissal would be costly.
     */
    closeOnBackdropClick?: boolean;
}

export function Modal({
    isOpen,
    onClose,
    title,
    children,
    footer,
    className,
    closeOnBackdropClick = true,
}: ModalProps) {
    const titleId = useId();

    useEffect(() => {
        if (!isOpen) return;

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };

        const previousOverflow = document.body.style.overflow;
        document.addEventListener("keydown", handleEscape);
        document.body.style.overflow = "hidden";

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = previousOverflow;
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <FocusTrap
            focusTrapOptions={{
                escapeDeactivates: false,
                allowOutsideClick: true,
                returnFocusOnDeactivate: true,
            }}
        >
            <div
                className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
                onClick={
                    closeOnBackdropClick
                        ? (e) => {
                              if (e.target === e.currentTarget) onClose();
                          }
                        : undefined
                }
            >
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    className={cn(
                        "bg-gradient-to-br from-[#141414] to-[#0f0f0f] border border-[#262626] rounded-sm shadow-2xl max-w-md w-full p-6",
                        className
                    )}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between mb-4 pb-4 border-b border-[#1c1c1c]">
                        <h2 id={titleId} className="text-lg font-medium text-white">
                            {title}
                        </h2>
                        <Button
                            variant="icon"
                            onClick={onClose}
                            aria-label="Close dialog"
                            className="hover:text-gray-300"
                        >
                            <X className="w-5 h-5" aria-hidden="true" />
                        </Button>
                    </div>

                    {/* Content */}
                    <div className="mb-6">{children}</div>

                    {/* Footer */}
                    {footer && (
                        <div className="flex gap-3 justify-end">{footer}</div>
                    )}
                </div>
            </div>
        </FocusTrap>
    );
}
