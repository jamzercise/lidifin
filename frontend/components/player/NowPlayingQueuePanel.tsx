"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useFavorites } from "@/hooks/useFavorites";
import { useQueuePanel } from "@/lib/queue-panel-context";
import { api } from "@/lib/api";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import {
    X,
    ListMusic,
    Music as MusicIcon,
    Play,
    Heart,
    Mic2,
    Headphones,
    Radio,
} from "lucide-react";
import { formatTime } from "@/utils/formatTime";
import { cn } from "@/utils/cn";
import { useSongRadio } from "@/hooks/useSongRadio";

export function NowPlayingQueuePanel() {
    const { isOpen, closeQueue } = useQueuePanel();
    // Granular hooks: this panel only needs queue/media state and actions,
    // so it must not subscribe to the playback context (currentTime ticks).
    const {
        playbackType,
        currentTrack,
        currentPodcast,
        currentAudiobook,
        queue,
        currentIndex,
        podcastEpisodeQueue,
    } = useAudioState();
    const { playTracks, removeFromQueue, playPodcast } = useAudioControls();

    const { favoriteIds, addFavorite, removeFavorite } = useFavorites();
    const { startRadio, startingId } = useSongRadio();
    const hasMedia = !!(currentTrack || currentPodcast || currentAudiobook);
    const upNextTracks = playbackType === "track" ? queue.slice(currentIndex + 1) : [];
    const currentEpisodeId =
        playbackType === "podcast" && currentPodcast
            ? currentPodcast.id.split(":")[1]
            : null;
    const podcastCurrentIdx =
        currentEpisodeId && podcastEpisodeQueue
            ? podcastEpisodeQueue.findIndex((ep) => ep.id === currentEpisodeId)
            : -1;
    const upNextEpisodes =
        playbackType === "podcast" && podcastEpisodeQueue && podcastCurrentIdx >= 0
            ? podcastEpisodeQueue.slice(podcastCurrentIdx + 1)
            : [];

    const handlePlayTrackAt = (index: number) => {
        playTracks(queue, index);
        closeQueue();
    };

    const handlePlayPodcastEpisode = (episodeId: string) => {
        if (!currentPodcast || !podcastEpisodeQueue) return;
        const podcastId = currentPodcast.id.split(":")[0];
        const episode = podcastEpisodeQueue.find((ep) => ep.id === episodeId);
        if (!episode) return;
        playPodcast({
            id: `${podcastId}:${episode.id}`,
            title: episode.title,
            podcastTitle: currentPodcast.podcastTitle,
            coverUrl: currentPodcast.coverUrl,
            duration: episode.duration,
            mimeType: episode.mimeType,
            progress: episode.progress || null,
        });
        closeQueue();
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="fixed inset-0 bg-black/50 z-[10000]"
                        aria-hidden="true"
                        onClick={closeQueue}
                    />
                    <motion.aside
                        initial={{ x: "100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: "100%" }}
                        transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
                        className={cn(
                            "fixed top-0 right-0 bottom-0 w-full max-w-md bg-[#0f0f0f] border-l border-white/10 z-[10001]",
                            "flex flex-col shadow-2xl"
                        )}
                        role="dialog"
                        aria-label="Now playing queue"
                    >
                {/* Header */}
                <div className="flex items-center justify-between flex-shrink-0 px-4 py-3 border-b border-white/10">
                    <div className="flex items-center gap-2">
                        <ListMusic className="w-5 h-5 text-gray-400" />
                        <h2 className="text-lg font-semibold text-white">
                            Now playing
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={closeQueue}
                        className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                        aria-label="Close queue"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto min-h-0">
                    {!hasMedia ? (
                        <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                            <ListMusic className="w-12 h-12 text-gray-600 mb-4" />
                            <p className="text-gray-400 text-sm">
                                Nothing playing. Start something to see your queue here.
                            </p>
                        </div>
                    ) : (
                        <div className="py-2">
                            {/* Now playing */}
                            <div className="px-4 pb-2">
                                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                    Now playing
                                </p>
                                {playbackType === "track" && currentTrack && (
                                    <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
                                        <div className="relative w-12 h-12 flex-shrink-0 rounded overflow-hidden bg-[#1a1a1a]">
                                            {currentTrack.album?.coverArt ? (
                                                <Image
                                                    src={api.getCoverArtUrl(
                                                        currentTrack.album.coverArt,
                                                        100
                                                    )}
                                                    alt=""
                                                    fill
                                                    sizes="48px"
                                                    className="object-cover"
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center">
                                                    <MusicIcon className="w-6 h-6 text-gray-600" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-white truncate">
                                                {currentTrack.displayTitle ?? currentTrack.title}
                                            </p>
                                            <p className="text-xs text-gray-400 truncate">
                                                {currentTrack.artist?.name}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                startRadio({
                                                    id: currentTrack.id,
                                                    title: currentTrack.title,
                                                    artist: currentTrack.artist,
                                                    album: currentTrack.album,
                                                    duration: currentTrack.duration,
                                                });
                                            }}
                                            disabled={startingId === currentTrack.id}
                                            className="p-1.5 rounded-md transition-colors flex-shrink-0 text-gray-400 hover:text-white disabled:opacity-50"
                                            title="Start a song radio from this track"
                                            aria-label="Start a song radio from this track"
                                        >
                                            <Radio className="w-4 h-4" />
                                        </button>
                                        {currentTrack.id?.startsWith("jellyfin:") && (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    const isFav = favoriteIds.has(currentTrack.id);
                                                    if (isFav) removeFavorite(currentTrack.id);
                                                    else addFavorite(currentTrack.id);
                                                }}
                                                className={cn(
                                                    "p-1.5 rounded-md transition-colors flex-shrink-0",
                                                    favoriteIds.has(currentTrack.id)
                                                        ? "text-red-400 hover:text-red-300"
                                                        : "text-gray-400 hover:text-white"
                                                )}
                                                title={favoriteIds.has(currentTrack.id) ? "Remove from Favorites" : "Add to Favorites"}
                                            >
                                                <Heart
                                                    className={cn("w-4 h-4", favoriteIds.has(currentTrack.id) && "fill-current")}
                                                />
                                            </button>
                                        )}
                                        <span className="text-xs text-gray-500 flex-shrink-0">
                                            {currentTrack.duration
                                                ? formatTime(currentTrack.duration)
                                                : ""}
                                        </span>
                                    </div>
                                )}
                                {playbackType === "podcast" && currentPodcast && (
                                    <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
                                        <div className="relative w-12 h-12 flex-shrink-0 rounded overflow-hidden bg-[#1a1a1a]">
                                            {currentPodcast.coverUrl ? (
                                                <Image
                                                    src={api.getCoverArtUrl(
                                                        currentPodcast.coverUrl,
                                                        100
                                                    )}
                                                    alt=""
                                                    fill
                                                    sizes="48px"
                                                    className="object-cover"
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center">
                                                    <Mic2 className="w-6 h-6 text-gray-600" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-white truncate">
                                                {currentPodcast.title}
                                            </p>
                                            <p className="text-xs text-gray-400 truncate">
                                                {currentPodcast.podcastTitle}
                                            </p>
                                        </div>
                                        <span className="text-xs text-gray-500 flex-shrink-0">
                                            {currentPodcast.duration
                                                ? formatTime(currentPodcast.duration)
                                                : ""}
                                        </span>
                                    </div>
                                )}
                                {playbackType === "audiobook" && currentAudiobook && (
                                    <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
                                        <div className="relative w-12 h-12 flex-shrink-0 rounded overflow-hidden bg-[#1a1a1a]">
                                            {currentAudiobook.coverUrl ? (
                                                <Image
                                                    src={api.getCoverArtUrl(
                                                        currentAudiobook.coverUrl,
                                                        100
                                                    )}
                                                    alt=""
                                                    fill
                                                    sizes="48px"
                                                    className="object-cover"
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center">
                                                    <Headphones className="w-6 h-6 text-gray-600" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-white truncate">
                                                {currentAudiobook.title}
                                            </p>
                                            <p className="text-xs text-gray-400 truncate">
                                                {currentAudiobook.author}
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Up next - tracks */}
                            {playbackType === "track" && upNextTracks.length > 0 && (
                                <div className="px-4 pt-4">
                                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                        Up next ({upNextTracks.length})
                                    </p>
                                    <ul className="divide-y divide-white/5">
                                        {upNextTracks.map((track, idx) => {
                                            const queueIndex = currentIndex + 1 + idx;
                                            return (
                                                <li
                                                    key={`${track.id}-${queueIndex}`}
                                                    className="group flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-lg hover:bg-white/5"
                                                >
                                                    <div className="relative w-10 h-10 flex-shrink-0 rounded overflow-hidden bg-[#1a1a1a]">
                                                        {track.album?.coverArt ? (
                                                            <Image
                                                                src={api.getCoverArtUrl(
                                                                    track.album.coverArt,
                                                                    80
                                                                )}
                                                                alt=""
                                                                fill
                                                                sizes="40px"
                                                                className="object-cover"
                                                                unoptimized
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full flex items-center justify-center">
                                                                <MusicIcon className="w-5 h-5 text-gray-600" />
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm text-gray-200 truncate">
                                                            {track.displayTitle ?? track.title}
                                                        </p>
                                                        <p className="text-xs text-gray-500 truncate">
                                                            {track.artist?.name}
                                                        </p>
                                                    </div>
                                                    <span className="text-xs text-gray-500 flex-shrink-0">
                                                        {track.duration
                                                            ? formatTime(track.duration)
                                                            : ""}
                                                    </span>
                                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        {track.id?.startsWith("jellyfin:") && (
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    const isFav = favoriteIds.has(track.id);
                                                                    if (isFav) removeFavorite(track.id);
                                                                    else addFavorite(track.id);
                                                                }}
                                                                className={cn(
                                                                    "p-1.5 rounded-md transition-colors",
                                                                    favoriteIds.has(track.id)
                                                                        ? "text-red-400 hover:text-red-300"
                                                                        : "text-gray-400 hover:text-white"
                                                                )}
                                                                title={favoriteIds.has(track.id) ? "Remove from Favorites" : "Add to Favorites"}
                                                            >
                                                                <Heart
                                                                    className={cn("w-4 h-4", favoriteIds.has(track.id) && "fill-current")}
                                                                />
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                handlePlayTrackAt(queueIndex)
                                                            }
                                                            className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/10"
                                                            title="Play now"
                                                            aria-label={`Play ${track.title}`}
                                                        >
                                                            <Play className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                removeFromQueue(queueIndex)
                                                            }
                                                            className="p-1.5 rounded-md text-gray-400 hover:text-red-400 hover:bg-red-500/10"
                                                            title="Remove from queue"
                                                            aria-label={`Remove ${track.title} from queue`}
                                                        >
                                                            <X className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            )}

                            {/* Up next - podcast episodes */}
                            {playbackType === "podcast" && upNextEpisodes.length > 0 && (
                                <div className="px-4 pt-4">
                                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                        Up next ({upNextEpisodes.length})
                                    </p>
                                    <ul className="divide-y divide-white/5">
                                        {upNextEpisodes.map((episode) => (
                                            <li
                                                key={episode.id}
                                                className="group flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-lg hover:bg-white/5"
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm text-gray-200 truncate">
                                                        {episode.title}
                                                    </p>
                                                    <p className="text-xs text-gray-500">
                                                        {formatTime(episode.duration)}
                                                    </p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handlePlayPodcastEpisode(episode.id)
                                                    }
                                                    className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                                                    title="Play episode"
                                                    aria-label={`Play ${episode.title}`}
                                                >
                                                    <Play className="w-4 h-4" />
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* Empty up next for track/podcast when none */}
                            {playbackType === "track" && upNextTracks.length === 0 && (
                                <div className="px-4 pt-2">
                                    <p className="text-xs text-gray-500">
                                        No more tracks in queue. Add from Library or play an album/playlist.
                                    </p>
                                </div>
                            )}
                            {playbackType === "podcast" && upNextEpisodes.length === 0 && (
                                <div className="px-4 pt-2">
                                    <p className="text-xs text-gray-500">
                                        No more episodes in queue.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    );
}
