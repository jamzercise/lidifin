"use client";

import { useAudio } from "@/lib/audio-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    ChevronDown,
    Music as MusicIcon,
    ListMusic,
    Shuffle,
    Repeat,
    Repeat1,
    AudioWaveform,
    Loader2,
    RotateCcw,
    RotateCw,
    RefreshCw,
    Heart,
} from "lucide-react";
import { formatTime, clampTime, formatTimeRemaining } from "@/utils/formatTime";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { toast } from "sonner";
import { SeekSlider } from "./SeekSlider";
import { SleepTimerButton } from "./SleepTimerButton";
import { PlaybackSpeedButton } from "./PlaybackSpeedButton";
import { useQueuePanel } from "@/lib/queue-panel-context";
import { useFeatures } from "@/lib/features-context";
import { useCast } from "@/lib/cast-context";
import { CastIcon } from "./CastIcon";
import { useFavorites } from "@/hooks/useFavorites";

export function OverlayPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        isBuffering,
        currentTime,
        canSeek,
        downloadProgress,
        isShuffle,
        repeatMode,
        vibeMode,
        audioError,
        clearAudioError,
        pause,
        resume,
        next,
        previous,
        returnToPreviousMode,
        seek,
        skipForward,
        skipBackward,
        toggleShuffle,
        toggleRepeat,
        startVibeMode,
        stopVibeMode,
        sleepTimerEndsAt,
        setSleepTimer,
        playbackRate,
        setPlaybackRate,
        duration: playbackDuration,
    } = useAudio();
    const { openQueue } = useQueuePanel();
    const { favoriteIds, addFavorite, removeFavorite } = useFavorites();
    const { isAvailable, isCasting, requestSession, stopCasting } = useCast();

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Swipe state for track skipping
    const touchStartX = useRef<number | null>(null);
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const { title, subtitle, coverUrl, artistLink, mediaLink } = useMediaInfo(500);

    const duration = (() => {
        if (playbackType === "podcast" && currentPodcast?.duration) {
            return currentPodcast.duration;
        }
        if (playbackType === "audiobook" && currentAudiobook?.duration) {
            return currentAudiobook.duration;
        }
        return (
            playbackDuration ||
            currentTrack?.duration ||
            currentAudiobook?.duration ||
            currentPodcast?.duration ||
            0
        );
    })();

    if (!currentTrack && !currentAudiobook && !currentPodcast) return null;

    const displayTime = (() => {
        let time = currentTime;
        
        if (time <= 0) {
            if (
                playbackType === "audiobook" &&
                currentAudiobook?.progress?.currentTime
            ) {
                time = currentAudiobook.progress.currentTime;
            } else if (
                playbackType === "podcast" &&
                currentPodcast?.progress?.currentTime
            ) {
                time = currentPodcast.progress.currentTime;
            }
        }
        
        // CRITICAL: Clamp to duration to prevent display of invalid times
        return clampTime(time, duration);
    })();

    const progress =
        duration > 0
            ? Math.min(100, Math.max(0, (displayTime / duration) * 100))
            : 0;
    const canSkip = playbackType === "track";
    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    const handleSeek = (time: number) => {
        seek(time);
    };

    // Swipe handlers for track skipping
    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartX.current = e.touches[0].clientX;
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (touchStartX.current === null) return;
        const deltaX = e.touches[0].clientX - touchStartX.current;
        setSwipeOffset(Math.max(-100, Math.min(100, deltaX)));
    };

    const handleTouchEnd = () => {
        if (touchStartX.current === null) return;

        if (canSkip) {
            if (swipeOffset > 60) {
                previous();
            } else if (swipeOffset < -60) {
                next();
            }
        }

        setSwipeOffset(0);
        touchStartX.current = null;
    };

    // Handle Vibe toggle
    const handleVibeToggle = async () => {
        if (!currentTrack?.id) return;

        if (vibeMode) {
            stopVibeMode();
            toast.success("Vibe mode off");
            return;
        }

        setIsVibeLoading(true);
        try {
            const result = await startVibeMode();

            if (result.success && result.trackCount > 0) {
                toast.success(`Vibe mode on`, {
                    description: `${result.trackCount} similar tracks queued`,
                    icon: <AudioWaveform className="w-4 h-4 text-[#f5c518]" />,
                });
            } else {
                toast.error("Couldn't find matching tracks");
            }
        } catch (error) {
            console.error("Failed to start vibe match:", error);
            toast.error("Failed to match vibe");
        } finally {
            setIsVibeLoading(false);
        }
    };

    return (
        <div
            className="fixed inset-0 bg-gradient-to-b from-[#1a1a2e] via-[#121218] to-[#000000] z-[9999] flex flex-col overflow-hidden"
            onTouchStart={isMobileOrTablet ? handleTouchStart : undefined}
            onTouchMove={isMobileOrTablet ? handleTouchMove : undefined}
            onTouchEnd={isMobileOrTablet ? handleTouchEnd : undefined}
        >
            {/* Header with close button */}
            <div
                className="flex items-center justify-between px-4 py-3 flex-shrink-0"
                style={{ paddingTop: "calc(12px + env(safe-area-inset-top))" }}
            >
                <button
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        returnToPreviousMode();
                    }}
                    className="text-gray-400 hover:text-white transition-colors p-2 -ml-2 rounded-full hover:bg-white/10"
                    title="Close"
                >
                    <ChevronDown className="w-7 h-7" />
                </button>
                {/* Now Playing indicator */}
                <span className="text-xs text-gray-500 uppercase tracking-widest font-medium">
                    Now Playing
                </span>
                <div className="flex items-center gap-1">
                    {playbackType === "track" && currentTrack?.id?.startsWith("jellyfin:") && (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const isFav = favoriteIds.has(currentTrack.id);
                                if (isFav) removeFavorite(currentTrack.id);
                                else addFavorite(currentTrack.id);
                            }}
                            className="text-gray-400 hover:text-white transition-colors p-2 rounded-full hover:bg-white/10"
                            aria-label={favoriteIds.has(currentTrack.id) ? "Remove from Favorites" : "Add to Favorites"}
                            title={favoriteIds.has(currentTrack.id) ? "Remove from Favorites" : "Add to Favorites"}
                        >
                            <Heart
                                className={cn("w-5 h-5", favoriteIds.has(currentTrack.id) && "fill-current text-red-400")}
                            />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={openQueue}
                        className="text-gray-400 hover:text-white transition-colors p-2 -mr-2 rounded-full hover:bg-white/10"
                        aria-label="Now playing queue"
                        title="Now playing queue"
                    >
                        <ListMusic className="w-5 h-5" />
                    </button>
                    <button
                        type="button"
                        onClick={isAvailable ? (isCasting ? stopCasting : requestSession) : undefined}
                        className={cn(
                            "transition-colors p-2 -mr-2 rounded-full hover:bg-white/10",
                            isCasting
                                ? "text-[#B1D2C3] hover:text-[#9bc4b3]"
                                : isAvailable
                                  ? "text-gray-400 hover:text-white"
                                  : "text-gray-500/60 cursor-not-allowed"
                        )}
                        disabled={!isAvailable}
                        aria-label={isCasting ? "Stop casting" : "Cast to device"}
                        title={
                            isCasting
                                ? "Stop casting"
                                : isAvailable
                                  ? "Cast to device"
                                  : "Cast requires Chrome or Edge"
                        }
                    >
                        <CastIcon isCasting={isCasting} className="w-5 h-5" size={20} />
                    </button>
                </div>
            </div>

            {/* Main Content - Portrait vs Landscape */}
            <div className="flex-1 flex flex-col landscape:flex-row items-center justify-center px-6 pb-6 landscape:px-8 landscape:gap-8 overflow-hidden">
                {/* Artwork Section */}
                <div
                    className="w-full max-w-[320px] landscape:max-w-[240px] landscape:w-[240px] aspect-square flex-shrink-0 mb-6 landscape:mb-0 relative"
                    style={{
                        transform: `translateX(${swipeOffset * 0.5}px)`,
                        opacity: 1 - Math.abs(swipeOffset) / 200,
                    }}
                >
                    {/* Glow effect */}
                    <div
                        className={cn(
                            "absolute inset-0 rounded-2xl blur-2xl opacity-50",
                            vibeMode
                                ? "bg-gradient-to-br from-brand/30 via-transparent to-purple-500/30"
                                : "bg-gradient-to-br from-[#f5c518]/20 via-transparent to-[#a855f7]/20"
                        )}
                    />

                    {/* Album art - always show album art, even in vibe mode */}
                    <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-2xl overflow-hidden shadow-2xl">
                        {coverUrl ? (
                            <Image
                                key={coverUrl}
                                src={coverUrl}
                                alt={title}
                                fill
                                sizes="280px"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <MusicIcon className="w-24 h-24 text-gray-600" />
                            </div>
                        )}
                    </div>

                    {/* Swipe hint indicators */}
                    {canSkip &&
                        isMobileOrTablet &&
                        Math.abs(swipeOffset) > 20 && (
                            <div
                                className={cn(
                                    "absolute top-1/2 -translate-y-1/2 text-white/60",
                                    swipeOffset > 0 ? "-left-8" : "-right-8"
                                )}
                            >
                                {swipeOffset > 0 ? (
                                    <SkipBack className="w-6 h-6" />
                                ) : (
                                    <SkipForward className="w-6 h-6" />
                                )}
                            </div>
                        )}
                </div>

                {/* Info & Controls Section */}
                <div className="w-full max-w-[320px] landscape:max-w-[280px] landscape:flex-1 flex flex-col">
                    {/* Track Info */}
                    <div className="text-center landscape:text-left mb-6">
                        {mediaLink ? (
                            <Link
                                href={mediaLink}
                                onClick={returnToPreviousMode}
                                className="block hover:underline"
                            >
                                <h2 className="text-xl font-bold text-white mb-1 truncate">
                                    {title}
                                </h2>
                            </Link>
                        ) : (
                            <h2 className="text-xl font-bold text-white mb-1 truncate">
                                {title}
                            </h2>
                        )}
                        {artistLink ? (
                            <Link
                                href={artistLink}
                                onClick={returnToPreviousMode}
                                className="block hover:underline"
                            >
                                <p className="text-base text-gray-400 truncate">
                                    {subtitle}
                                </p>
                            </Link>
                        ) : (
                            <p className="text-base text-gray-400 truncate">
                                {subtitle}
                            </p>
                        )}

                    </div>

                    {/* Progress Bar */}
                    <div className="mb-6">
                        <SeekSlider
                            progress={progress}
                            duration={duration}
                            currentTime={displayTime}
                            onSeek={handleSeek}
                            canSeek={canSeek}
                            hasMedia={hasMedia}
                            downloadProgress={downloadProgress}
                            variant="overlay"
                            showHandle={false}
                            className="mb-2"
                        />
                        <div className="flex justify-between text-xs text-gray-500 font-medium tabular-nums">
                            <span>{formatTime(displayTime)}</span>
                            <span>
                                {playbackType === "podcast" || playbackType === "audiobook"
                                    ? formatTimeRemaining(Math.max(0, duration - displayTime))
                                    : formatTime(duration)}
                            </span>
                        </div>
                    </div>

                    {/* Main Controls */}
                    <div className="flex items-center justify-center gap-6 mb-6">
                        {/* Skip -30s (for audiobooks/podcasts) */}
                        {!canSkip && (
                            <button
                                onClick={() => skipBackward(30)}
                                className="text-white/80 hover:text-white transition-all hover:scale-110 relative"
                                title="Rewind 30 seconds"
                            >
                                <RotateCcw className="w-7 h-7" />
                                <span className="absolute text-[9px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>
                        )}

                        <button
                            onClick={() => previous()}
                            className={cn(
                                "text-white/80 hover:text-white transition-all hover:scale-110",
                                !canSkip &&
                                    "opacity-30 cursor-not-allowed hover:scale-100"
                            )}
                            disabled={!canSkip}
                            title={canSkip ? "Previous" : "Skip only for music"}
                        >
                            <SkipBack className="w-8 h-8" />
                        </button>

                        <button
                            onClick={
                                audioError
                                    ? () => {
                                        clearAudioError();
                                        resume();
                                    }
                                    : isBuffering
                                    ? undefined
                                    : isPlaying
                                    ? pause
                                    : resume
                            }
                            className={cn(
                                "w-16 h-16 rounded-full flex items-center justify-center hover:scale-105 transition-all shadow-xl",
                                audioError
                                    ? "bg-red-500 text-white hover:bg-red-400"
                                    : isBuffering
                                    ? "bg-white/80 text-black"
                                    : "bg-white text-black"
                            )}
                            disabled={isBuffering}
                            title={
                                audioError
                                    ? "Retry playback"
                                    : isBuffering
                                    ? "Buffering..."
                                    : isPlaying
                                    ? "Pause"
                                    : "Play"
                            }
                        >
                            {audioError ? (
                                <RefreshCw className="w-7 h-7" />
                            ) : isBuffering ? (
                                <Loader2 className="w-7 h-7 animate-spin" />
                            ) : isPlaying ? (
                                <Pause className="w-7 h-7" />
                            ) : (
                                <Play className="w-7 h-7 ml-1" />
                            )}
                        </button>

                        <button
                            onClick={() => next()}
                            className={cn(
                                "text-white/80 hover:text-white transition-all hover:scale-110",
                                !canSkip &&
                                    "opacity-30 cursor-not-allowed hover:scale-100"
                            )}
                            disabled={!canSkip}
                            title={canSkip ? "Next" : "Skip only for music"}
                        >
                            <SkipForward className="w-8 h-8" />
                        </button>

                        {/* Skip +30s (for audiobooks/podcasts) */}
                        {!canSkip && (
                            <button
                                onClick={() => skipForward(30)}
                                className="text-white/80 hover:text-white transition-all hover:scale-110 relative"
                                title="Forward 30 seconds"
                            >
                                <RotateCw className="w-7 h-7" />
                                <span className="absolute text-[9px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>
                        )}
                    </div>

                    {/* Secondary Controls */}
                    <div className="flex items-center justify-center gap-8">
                        <button
                            onClick={toggleShuffle}
                            disabled={!canSkip}
                            className={cn(
                                "transition-colors",
                                !canSkip
                                    ? "text-gray-700 cursor-not-allowed"
                                    : isShuffle
                                    ? "text-[#f5c518]"
                                    : "text-gray-500 hover:text-white"
                            )}
                            title="Shuffle"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>

                        <button
                            onClick={toggleRepeat}
                            disabled={!canSkip}
                            className={cn(
                                "transition-colors",
                                !canSkip
                                    ? "text-gray-700 cursor-not-allowed"
                                    : repeatMode !== "off"
                                    ? "text-[#f5c518]"
                                    : "text-gray-500 hover:text-white"
                            )}
                            title={
                                repeatMode === "one"
                                    ? "Repeat One"
                                    : repeatMode === "all"
                                    ? "Repeat All"
                                    : "Repeat Off"
                            }
                        >
                            {repeatMode === "one" ? (
                                <Repeat1 className="w-5 h-5" />
                            ) : (
                                <Repeat className="w-5 h-5" />
                            )}
                        </button>

                        {/* Sleep timer */}
                        <SleepTimerButton
                            sleepTimerEndsAt={sleepTimerEndsAt}
                            setSleepTimer={setSleepTimer}
                            hasMedia={!!(currentTrack || currentAudiobook || currentPodcast)}
                            dropdownPlacement="top"
                        />

                        {/* Playback speed - podcast/audiobook only */}
                        <PlaybackSpeedButton
                            playbackRate={playbackRate}
                            setPlaybackRate={setPlaybackRate}
                            visible={playbackType === "podcast" || playbackType === "audiobook"}
                            dropdownPlacement="top"
                        />

                        {/* Vibe button - only when embeddings available */}
                        {!featuresLoading && vibeEmbeddings && (
                            <button
                                onClick={handleVibeToggle}
                                disabled={!canSkip || isVibeLoading}
                                className={cn(
                                    "transition-colors",
                                    !canSkip
                                        ? "text-gray-700 cursor-not-allowed"
                                        : vibeMode
                                        ? "text-[#f5c518]"
                                        : "text-gray-500 hover:text-[#f5c518]"
                                )}
                                title={
                                    vibeMode
                                        ? "Turn off vibe mode"
                                        : "Match this vibe"
                                }
                            >
                                {isVibeLoading ? (
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                ) : (
                                    <AudioWaveform className="w-5 h-5" />
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Safe area padding at bottom */}
            <div style={{ height: "env(safe-area-inset-bottom)" }} />
        </div>
    );
}
