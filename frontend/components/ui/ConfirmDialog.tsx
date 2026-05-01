"use client";

import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: "danger" | "warning" | "info";
    /** Raise above another open `Modal` (e.g. `z-[60]`). */
    overlayClassName?: string;
}

export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "danger",
    overlayClassName,
}: ConfirmDialogProps) {
    const variantStyles = {
        danger: {
            icon: "text-red-500",
            iconBg: "bg-red-500/10",
        },
        warning: {
            icon: "text-yellow-500",
            iconBg: "bg-yellow-500/10",
        },
        info: {
            icon: "text-blue-500",
            iconBg: "bg-blue-500/10",
        },
    };

    const styles = variantStyles[variant];

    const handleConfirm = () => {
        onConfirm();
        onClose();
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            description={message}
            dialogRole="alertdialog"
            overlayClassName={overlayClassName}
            className="max-w-md rounded-xl border-white/10 bg-[#121212]"
            titleLeading={
                <div
                    className={`w-12 h-12 rounded-full ${styles.iconBg} flex items-center justify-center shrink-0`}
                >
                    <AlertTriangle
                        className={`w-6 h-6 ${styles.icon}`}
                        aria-hidden="true"
                    />
                </div>
            }
            footer={
                <div className="flex w-full gap-3">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        className="flex-1 border-white/10"
                    >
                        {cancelText}
                    </Button>
                    <Button
                        type="button"
                        variant="primary"
                        onClick={handleConfirm}
                        className={
                            variant === "danger"
                                ? "flex-1 !bg-red-500 hover:!bg-red-600 text-white"
                                : variant === "warning"
                                  ? "flex-1 !bg-yellow-500 hover:!bg-yellow-600 !text-black"
                                  : "flex-1 !bg-blue-500 hover:!bg-blue-600 text-white"
                        }
                    >
                        {confirmText}
                    </Button>
                </div>
            }
        />
    );
}
