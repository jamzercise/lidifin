"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Marks that we were the ones who pushed Settings onto the history stack, so
 * closing it can step back rather than guess at a destination.
 */
const OPENED_FROM_APP_KEY = "lidifin:settings-opened-from-app";

function readFlag(): boolean {
    try {
        return sessionStorage.getItem(OPENED_FROM_APP_KEY) === "1";
    } catch {
        // sessionStorage throws in some privacy modes.
        return false;
    }
}

function writeFlag(value: boolean) {
    try {
        if (value) {
            sessionStorage.setItem(OPENED_FROM_APP_KEY, "1");
        } else {
            sessionStorage.removeItem(OPENED_FROM_APP_KEY);
        }
    } catch {
        // Non-fatal: we fall back to sending the user home on close.
    }
}

/**
 * Settings behaves like a panel rather than a destination: the same icon that
 * opens it closes it again and puts you back where you were.
 */
export function useSettingsToggle() {
    const router = useRouter();
    const pathname = usePathname();
    const isOpen = pathname === "/settings";

    const toggle = useCallback(() => {
        if (!isOpen) {
            writeFlag(true);
            router.push("/settings");
            return;
        }

        const openedFromApp = readFlag();
        writeFlag(false);

        // Going back restores the previous page and its scroll position, but
        // only makes sense if we put Settings on the stack. Arriving by direct
        // link or a fresh load has nothing of ours to return to.
        if (openedFromApp) {
            router.back();
        } else {
            router.push("/");
        }
    }, [isOpen, router]);

    return { isOpen, toggle };
}
