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
 *      - Frequently-changing values: isPlaying, currentTime,
 *        duration, isBuffering, audioError, playbackState.
 *      - Hook: useAudioPlayback()
 *      - NOTE: isPlaying and currentTime currently share a context,
 *        which means consumers of isPlaying still re-render on each
 *        time tick. A future PR could split these into separate
 *        contexts (or use useSyncExternalStore selectors) for
 *        further per-render-cost reduction.
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
export { useAudioPlayback } from "./audio-playback-context";
export { useAudioControls } from "./audio-controls-context";

// Backward-compatibility unified hook. Discouraged for new code; see
// audio-hooks.tsx for guidance.
export { useAudio } from "./audio-hooks";
