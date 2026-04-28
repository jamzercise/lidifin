import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAudioState } from "@/lib/audio-state-context";
import { useCastAwareAudioControls } from "@/lib/useCastAwareAudioControls";

/**
 * Hook that automatically switches player mode based on the current page
 * - Full player: On media pages (album, audiobook, podcast)
 * - Mini player: On other pages
 * - Overlay: Manual user control (doesn't auto-switch)
 */
export function usePlayerMode() {
    const pathname = usePathname();
    // Subscribes only to state + controls — no playback fields, so this hook
    // doesn't re-render on every currentTime tick.
    const { currentTrack, currentAudiobook, currentPodcast, playerMode } =
        useAudioState();
    const { setPlayerMode } = useCastAwareAudioControls();

    useEffect(() => {
        // Don't auto-switch if in overlay mode (user manually opened it)
        if (playerMode === "overlay") return;

        // Don't auto-switch if no media is playing
        if (!currentTrack && !currentAudiobook && !currentPodcast) return;

        // Determine if we're on the EXACT page where the current media is playing
        const isOnCurrentMediaPage =
            (currentTrack && pathname === `/album/${currentTrack.album?.id}`) ||
            (currentAudiobook && pathname === `/audiobooks/${currentAudiobook.id}`) ||
            (currentPodcast && pathname.includes(`/podcasts/${currentPodcast.id}`));

        // Auto-expand to full when on the current media page
        // But don't auto-minimize - let users keep it expanded if they want
        if (isOnCurrentMediaPage && playerMode === "mini") {
            setPlayerMode("full");
        }
    }, [
        pathname,
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playerMode,
        setPlayerMode,
    ]);
}
