"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";

export function useSingleTrackDownload() {
    const [soulseekEnabled, setSoulseekEnabled] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadingTrackId, setDownloadingTrackId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const check = async () => {
            try {
                const status = await api.getSlskdStatus();
                if (!cancelled) setSoulseekEnabled(Boolean(status?.enabled));
            } catch {
                if (!cancelled) setSoulseekEnabled(false);
            }
        };
        check();
        return () => {
            cancelled = true;
        };
    }, []);

    const downloadTrack = useCallback(
        async (trackId: string, artistName: string, trackTitle: string, albumTitle?: string) => {
            if (!soulseekEnabled) {
                toast.error(
                    "Soulseek is not configured. Add username and password in System Settings to download tracks."
                );
                return;
            }
            if (isDownloading) return;

            setIsDownloading(true);
            setDownloadingTrackId(trackId);
            const toastId = `download-track-${trackId}`;
            toast.loading(`Queueing "${trackTitle}"...`, { id: toastId });

            try {
                const result = await api.downloadTrackByArtistTitle(
                    artistName,
                    trackTitle,
                    albumTitle || "Unknown Album"
                );

                if (result?.success) {
                    // The transfer runs in the background and can take minutes;
                    // Activity is where its progress and outcome show up.
                    toast.success(
                        `Searching for "${trackTitle}" — see Activity for progress`,
                        { id: toastId }
                    );
                    if (typeof window !== "undefined") {
                        window.dispatchEvent(
                            new CustomEvent("set-activity-panel-tab", { detail: { tab: "active" } })
                        );
                        window.dispatchEvent(new CustomEvent("open-activity-panel"));
                        window.dispatchEvent(new CustomEvent("notifications-changed"));
                    }
                } else {
                    toast.error(result?.error || "Download failed", { id: toastId });
                }
            } catch (err: unknown) {
                const message =
                    err && typeof err === "object" && "message" in err
                        ? String((err as { message: string }).message)
                        : "Download failed";
                toast.error(message, { id: toastId });
            } finally {
                setIsDownloading(false);
                setDownloadingTrackId(null);
            }
        },
        [soulseekEnabled, isDownloading]
    );

    return { downloadTrack, isDownloading, downloadingTrackId, soulseekEnabled };
}
