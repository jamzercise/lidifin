"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useRef,
    useCallback,
    ReactNode,
    useMemo,
} from "react";
import { useAudioState } from "./audio-state-context";
import { playbackStateMachine, type PlaybackState } from "./audio";

/**
 * Playback state is split into two contexts so that components which only
 * care about play/pause/buffering state don't re-render on every 250ms
 * currentTime tick:
 *
 * - AudioPlaybackStateContext — isPlaying/isBuffering/errors (low churn)
 * - AudioPlaybackTimeContext  — currentTime/duration (ticks at ~4Hz)
 *
 * useAudioPlayback() merges both for backwards compatibility; prefer the
 * granular hooks in new code.
 */

interface AudioPlaybackStateContextType {
    isPlaying: boolean;
    isBuffering: boolean;
    targetSeekPosition: number | null;
    canSeek: boolean;
    downloadProgress: number | null; // 0-100 for downloading, null for not downloading
    isSeekLocked: boolean; // True when a seek operation is in progress
    audioError: string | null; // Error message from state machine
    playbackState: PlaybackState; // Raw state machine state for advanced use
    setIsPlaying: (playing: boolean) => void;
    setIsBuffering: (buffering: boolean) => void;
    setTargetSeekPosition: (position: number | null) => void;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    lockSeek: (targetTime: number) => void; // Lock updates during seek
    unlockSeek: () => void; // Unlock after seek completes
    clearAudioError: () => void; // Clear the audio error state
    /** Stable getter for the latest playback position. Use inside event
     * handlers/callbacks instead of subscribing to currentTime, so the
     * component doesn't re-render on every 250ms tick. */
    getCurrentTime: () => number;
    /** Stable getter for the latest duration (same rationale). */
    getDuration: () => number;
}

interface AudioPlaybackTimeContextType {
    currentTime: number;
    duration: number;
    setCurrentTime: (time: number) => void;
    setCurrentTimeFromEngine: (time: number) => void; // For timeupdate events - respects seek lock
    setDuration: (duration: number) => void;
}

type AudioPlaybackContextType = AudioPlaybackStateContextType &
    AudioPlaybackTimeContextType;

const AudioPlaybackStateContext = createContext<
    AudioPlaybackStateContextType | undefined
>(undefined);

const AudioPlaybackTimeContext = createContext<
    AudioPlaybackTimeContextType | undefined
>(undefined);

// LocalStorage keys
const STORAGE_KEYS = {
    IS_PLAYING: "lidifin_is_playing",
    CURRENT_TIME: "lidifin_current_time",
};

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(() => {
        if (typeof window === "undefined") return 0;
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.CURRENT_TIME);
            return saved ? parseFloat(saved) : 0;
        } catch { return 0; }
    });
    const [duration, setDuration] = useState(0);
    const [isBuffering, setIsBuffering] = useState(false);
    const [targetSeekPosition, setTargetSeekPosition] = useState<number | null>(
        null
    );
    const [canSeek, setCanSeek] = useState(true); // Default true for music, false for uncached podcasts
    const [downloadProgress, setDownloadProgress] = useState<number | null>(
        null
    );
    const [audioError, setAudioError] = useState<string | null>(null);
    const [playbackState, setPlaybackState] = useState<PlaybackState>("IDLE");
    const [isHydrated] = useState(() => typeof window !== "undefined");
    const lastSaveTimeRef = useRef<number>(0);

    // Latest position/duration for stable getters (no tick re-renders).
    // Refs are synced in an effect (not during render) per react-hooks/refs;
    // getters are only called from event handlers, which run post-commit.
    const currentTimeRef = useRef(currentTime);
    const durationRef = useRef(duration);
    useEffect(() => {
        currentTimeRef.current = currentTime;
        durationRef.current = duration;
    }, [currentTime, duration]);
    const getCurrentTime = useCallback(() => currentTimeRef.current, []);
    const getDuration = useCallback(() => durationRef.current, []);

    // Clear audio error
    const clearAudioError = useCallback(() => {
        setAudioError(null);
        // Also reset state machine if in error state
        if (playbackStateMachine.hasError) {
            playbackStateMachine.forceTransition("IDLE");
        }
    }, []);

    // Subscribe to state machine changes.
    //
    // The machine is the single source of truth for engine state. The
    // mapping below is deliberately transition-aware:
    // - LOADING/BUFFERING/SEEKING preserve the previous isPlaying value so
    //   the play/pause button doesn't flicker during track changes or
    //   transient stalls (play intent survives until confirmed/denied).
    // - READY only means "paused" when we actually came from PLAYING or
    //   SEEKING; READY reached from LOADING is just "load complete" and
    //   must not cancel a pending autoplay.
    useEffect(() => {
        const unsubscribe = playbackStateMachine.subscribe((ctx) => {
            setPlaybackState(ctx.state);

            setIsPlaying((prev) => {
                switch (ctx.state) {
                    case "PLAYING":
                        return true;
                    case "IDLE":
                    case "ERROR":
                        return false;
                    case "READY":
                        return ctx.previousState === "LOADING" ? prev : false;
                    // LOADING / BUFFERING / SEEKING: keep current value
                    default:
                        return prev;
                }
            });

            const machineIsBuffering =
                ctx.state === "BUFFERING" || ctx.state === "LOADING";
            setIsBuffering((prev) =>
                prev !== machineIsBuffering ? machineIsBuffering : prev
            );

            // Update error state
            if (ctx.state === "ERROR" && ctx.error) {
                setAudioError(ctx.error);
            } else if (ctx.state !== "ERROR" && audioError) {
                // Clear error when leaving error state
                setAudioError(null);
            }
        });

        return unsubscribe;
    }, [audioError]);

    // Seek lock state - prevents stale timeupdate events from overwriting optimistic UI updates
    const [isSeekLocked, setIsSeekLocked] = useState(false);
    const seekTargetRef = useRef<number | null>(null);
    const seekLockTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Lock the seek state - ignores timeupdate events until audio catches up or timeout
    const lockSeek = useCallback((targetTime: number) => {
        setIsSeekLocked(true);
        seekTargetRef.current = targetTime;

        // Clear any existing timeout
        if (seekLockTimeoutRef.current) {
            clearTimeout(seekLockTimeoutRef.current);
        }

        // Auto-unlock after 500ms as a safety measure
        seekLockTimeoutRef.current = setTimeout(() => {
            setIsSeekLocked(false);
            seekTargetRef.current = null;
            seekLockTimeoutRef.current = null;
        }, 500);
    }, []);

    // Unlock the seek state
    const unlockSeek = useCallback(() => {
        setIsSeekLocked(false);
        seekTargetRef.current = null;
        if (seekLockTimeoutRef.current) {
            clearTimeout(seekLockTimeoutRef.current);
            seekLockTimeoutRef.current = null;
        }
    }, []);

    // setCurrentTimeFromEngine - for timeupdate events from Howler
    // Respects seek lock to prevent stale updates causing flicker
    const setCurrentTimeFromEngine = useCallback(
        (time: number) => {
            if (isSeekLocked && seekTargetRef.current !== null) {
                // During seek, only accept updates that are close to our target
                // This prevents old positions from briefly showing during seek
                const isNearTarget = Math.abs(time - seekTargetRef.current) < 2;
                if (!isNearTarget) {
                    return; // Ignore stale position update
                }
                // Position is near target - seek completed, unlock
                setIsSeekLocked(false);
                seekTargetRef.current = null;
                if (seekLockTimeoutRef.current) {
                    clearTimeout(seekLockTimeoutRef.current);
                    seekLockTimeoutRef.current = null;
                }
            }
            setCurrentTime(time);
        },
        [isSeekLocked]
    );

    // currentTime and isHydrated are initialized via lazy useState from localStorage

    // Get state from AudioStateContext for position sync
    const state = useAudioState();

    // Sync currentTime from audiobook/podcast progress when not playing (render-time adjustment)
    const progressKey = isHydrated && !isPlaying
        ? `${state.playbackType}-${state.currentAudiobook?.progress?.currentTime}-${state.currentPodcast?.progress?.currentTime}`
        : null;
    const [prevProgressKey, setPrevProgressKey] = useState<string | null>(progressKey);

    if (progressKey !== prevProgressKey) {
        setPrevProgressKey(progressKey);
        if (progressKey !== null) {
            if (state.playbackType === "audiobook" && state.currentAudiobook?.progress?.currentTime) {
                setCurrentTime(state.currentAudiobook.progress.currentTime);
            } else if (state.playbackType === "podcast" && state.currentPodcast?.progress?.currentTime) {
                setCurrentTime(state.currentPodcast.progress.currentTime);
            }
        }
    }

    // Cleanup seek lock timeout on unmount
    useEffect(() => {
        return () => {
            if (seekLockTimeoutRef.current) {
                clearTimeout(seekLockTimeoutRef.current);
            }
        };
    }, []);

    // Save currentTime to localStorage (throttled to avoid excessive writes)
    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;

        // Throttle saves to every 5 seconds using timestamp comparison
        const now = Date.now();
        if (now - lastSaveTimeRef.current < 5000) return;

        lastSaveTimeRef.current = now;
        try {
            localStorage.setItem(
                STORAGE_KEYS.CURRENT_TIME,
                currentTime.toString()
            );
        } catch (error) {
            console.error("[AudioPlayback] Failed to save currentTime:", error);
        }
    }, [currentTime, isHydrated]);

    // Memoize to prevent re-renders when values haven't changed
    const stateValue = useMemo(
        () => ({
            isPlaying,
            isBuffering,
            targetSeekPosition,
            canSeek,
            downloadProgress,
            isSeekLocked,
            audioError,
            playbackState,
            setIsPlaying,
            setIsBuffering,
            setTargetSeekPosition,
            setCanSeek,
            setDownloadProgress,
            lockSeek,
            unlockSeek,
            clearAudioError,
            getCurrentTime,
            getDuration,
        }),
        [
            isPlaying,
            isBuffering,
            targetSeekPosition,
            canSeek,
            downloadProgress,
            isSeekLocked,
            audioError,
            playbackState,
            lockSeek,
            unlockSeek,
            clearAudioError,
            getCurrentTime,
            getDuration,
        ]
    );

    const timeValue = useMemo(
        () => ({
            currentTime,
            duration,
            setCurrentTime,
            setCurrentTimeFromEngine,
            setDuration,
        }),
        [currentTime, duration, setCurrentTimeFromEngine]
    );

    return (
        <AudioPlaybackStateContext.Provider value={stateValue}>
            <AudioPlaybackTimeContext.Provider value={timeValue}>
                {children}
            </AudioPlaybackTimeContext.Provider>
        </AudioPlaybackStateContext.Provider>
    );
}

/**
 * Play/pause/buffering state only — does NOT re-render on currentTime
 * ticks. Prefer this in components that just need to know whether audio
 * is playing (play buttons, track highlighting, etc.).
 */
export function useAudioPlaybackState() {
    const context = useContext(AudioPlaybackStateContext);
    if (!context) {
        throw new Error(
            "useAudioPlaybackState must be used within AudioPlaybackProvider"
        );
    }
    return context;
}

/**
 * currentTime/duration — re-renders ~4x per second while audio plays.
 * Only use in components that display or manipulate playback position.
 */
export function useAudioPlaybackTime() {
    const context = useContext(AudioPlaybackTimeContext);
    if (!context) {
        throw new Error(
            "useAudioPlaybackTime must be used within AudioPlaybackProvider"
        );
    }
    return context;
}

/**
 * Combined playback hook (state + time). Re-renders on every time tick.
 * Kept for backwards compatibility; prefer useAudioPlaybackState() /
 * useAudioPlaybackTime() in new code.
 */
export function useAudioPlayback(): AudioPlaybackContextType {
    const state = useAudioPlaybackState();
    const time = useAudioPlaybackTime();
    return useMemo(() => ({ ...state, ...time }), [state, time]);
}
