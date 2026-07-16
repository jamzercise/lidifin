/**
 * Audio Context Re-exports + Architectural Overview
 *
 * Audio is split into THREE separate contexts so consumers can
 * subscribe to only the slice they need. This is a deliberate
 * performance optimization — context updates trigger re-renders
 * for every consumer, so co-locating high-frequency mutating values
 * (currentTime ticks) with rarely-changing values (currentTrack)
 * would force every consumer to re-render constantly.
 *
 *   1. audio-state-context.tsx
 *      - Rarely-changing values: currentTrack, queue, currentIndex,
 *        playerMode, volume, isShuffle, repeatMode, etc.
 *      - Hook: useAudioState()
 *
 *   2. audio-playback-context.tsx
 *      - Split into two nested contexts:
 *        - useAudioPlaybackState(): isPlaying, isBuffering,
 *          audioError, playbackState — low churn, safe everywhere.
 *          Also exposes getCurrentTime()/getDuration() stable getters
 *          for event handlers that need position without ticks.
 *        - useAudioPlaybackTime(): currentTime, duration — updates
 *          ~4x/second while playing; only for progress displays.
 *        - useAudioPlayback(): both combined (legacy; tick cost).
 *      - isPlaying/isBuffering are DERIVED from the playback state
 *        machine (lib/audio/playback-state-machine.ts); the machine
 *        is the single source of truth for engine state.
 *
 *   3. audio-controls-context.tsx
 *      - Stable callbacks (memoized): playTrack, pause, next, etc.
 *      - Hook: useAudioControls() OR useCastAwareAudioControls()
 *      - The cast-aware variant transparently routes calls to a
 *        casting receiver when one is connected.
 *
 * Provider order is enforced by ConditionalAudioProvider:
 *   AudioStateProvider -> AudioPlaybackProvider -> AudioControlsProvider.
 * (Playback reads state for position sync; controls reads both.)
 *
 * Consumer guidance:
 *   - Need controls only? Use useCastAwareAudioControls() — won't
 *     re-render on state or playback changes at all.
 *   - Need rarely-changing data? Use useAudioState() alone.
 *   - Need both, but no time tick? Combine state + controls hooks.
 *   - Need time/buffering? Use useAudioPlayback() (accept tick cost).
 *
 * The convenience useAudio() hook subscribes to all three; prefer
 * granular hooks above unless your component genuinely needs every
 * slice (e.g. the actual player components).
 */

export type { PlayerMode, Track, Audiobook, Podcast, AudioFeatures } from "./audio-state-context";

export { AudioStateProvider } from "./audio-state-context";
export { AudioPlaybackProvider } from "./audio-playback-context";
export { AudioControlsProvider } from "./audio-controls-context";

export { useAudioState } from "./audio-state-context";
export {
    useAudioPlayback,
    useAudioPlaybackState,
    useAudioPlaybackTime,
} from "./audio-playback-context";
export { useAudioControls } from "./audio-controls-context";

// Backward-compatibility unified hook. Discouraged for new code; see
// audio-hooks.tsx for guidance.
export { useAudio } from "./audio-hooks";
