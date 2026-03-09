"use client";

import { useMemo } from "react";
import { useAudioControls } from "./audio-controls-context";
import { useCast } from "./cast-context";

/**
 * Returns audio controls that delegate to the Cast session when casting.
 * Use this in player components (FullPlayer, MiniPlayer, OverlayPlayer) so that
 * play/pause, seek, skip, next, and previous control the casted audio.
 */
export function useCastAwareAudioControls() {
    const controls = useAudioControls();
    const cast = useCast();

    return useMemo(() => {
        if (!cast.isCasting) {
            return controls;
        }

        return {
            ...controls,
            pause: () => cast.castPause(),
            resume: () => cast.castPlay(),
            seek: (time: number) => cast.castSeek(time),
            skipForward: (seconds = 30) => cast.castSkipForward(seconds),
            skipBackward: (seconds = 30) => cast.castSkipBackward(seconds),
            next: () => controls.next(true),
            previous: () => controls.previous(true),
        };
    }, [controls, cast]);
}
