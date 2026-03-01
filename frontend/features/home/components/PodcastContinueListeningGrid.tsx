"use client";

import Link from "next/link";
import Image from "next/image";
import { Play, Pause, Mic2 } from "lucide-react";
import { memo } from "react";
import { api } from "@/lib/api";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { useAudio } from "@/lib/audio-context";
import { useAudioState } from "@/lib/audio-state-context";
import { formatDuration } from "@/utils/formatTime";
import { formatDate } from "@/features/podcast/utils";

export interface EpisodeWithPodcast {
    id: string;
    title: string;
    duration: number;
    publishedAt: string;
    coverUrl?: string | null;
    podcast: {
        id: string;
        title: string;
        author?: string | null;
        coverUrl?: string | null;
    };
    progress: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: string;
    };
}

interface PodcastContinueListeningGridProps {
    episodes: EpisodeWithPodcast[];
}

const getProxiedImageUrl = (url: string | undefined | null): string | null => {
    if (!url) return null;
    if (url.startsWith("/podcasts/")) {
        return api.getCoverArtUrl(url, 300);
    }
    return api.getCoverArtUrl(url, 300);
};

const EpisodeCard = memo(function EpisodeCard({
    episode,
    index,
}: {
    episode: EpisodeWithPodcast;
    index: number;
}) {
    const { playPodcast, currentPodcast, isPlaying, pause, resume } = useAudio();
    const { setPodcastEpisodeQueue } = useAudioState();

    const coverUrl = episode.coverUrl ?? episode.podcast.coverUrl;
    const imageUrl = getProxiedImageUrl(coverUrl);
    const isCurrentEpisode =
        currentPodcast?.id === `${episode.podcast.id}:${episode.id}`;

    const handlePlay = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (isCurrentEpisode && isPlaying) {
            pause();
            return;
        }
        if (isCurrentEpisode) {
            resume();
            return;
        }
        setPodcastEpisodeQueue([
            {
                id: episode.id,
                title: episode.title,
                duration: episode.duration,
                publishedAt: episode.publishedAt,
                progress: {
                    currentTime: episode.progress.currentTime,
                    progress: episode.progress.progress,
                    isFinished: episode.progress.isFinished,
                    lastPlayedAt: new Date(episode.progress.lastPlayedAt),
                },
            },
        ]);
        playPodcast({
            id: `${episode.podcast.id}:${episode.id}`,
            title: episode.title,
            podcastTitle: episode.podcast.title,
            coverUrl: coverUrl ?? null,
            duration: episode.duration,
            progress: {
                currentTime: episode.progress.currentTime,
                progress: episode.progress.progress,
                isFinished: episode.progress.isFinished,
                lastPlayedAt: new Date(episode.progress.lastPlayedAt),
            },
        });
    };

    return (
        <CarouselItem>
            <Link
                href={`/podcasts/${episode.podcast.id}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    <div className="aspect-square bg-[#282828] rounded-lg mb-3 flex items-center justify-center overflow-hidden relative shadow-lg">
                        {imageUrl ? (
                            <Image
                                src={imageUrl}
                                alt={episode.title}
                                fill
                                sizes="180px"
                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                                unoptimized
                            />
                        ) : (
                            <Mic2 className="w-10 h-10 text-gray-600" />
                        )}
                        <button
                            onClick={handlePlay}
                            className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                            <div className="w-12 h-12 rounded-full bg-[#B1D2C3] flex items-center justify-center">
                                {isCurrentEpisode && isPlaying ? (
                                    <Pause className="w-5 h-5 text-black" />
                                ) : (
                                    <Play className="w-5 h-5 text-black ml-0.5" fill="black" />
                                )}
                            </div>
                        </button>
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                            <div
                                className="h-full bg-[#B1D2C3]"
                                style={{
                                    width: `${Math.min(100, episode.progress.progress)}%`,
                                }}
                            />
                        </div>
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">
                        {episode.title}
                    </h3>
                    <p className="text-xs text-gray-400 truncate mt-0.5">
                        {episode.podcast.title}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-white/40">
                        <span>{formatDate(episode.publishedAt)}</span>
                        <span>•</span>
                        <span className="text-[#B1D2C3]">
                            {Math.floor(episode.progress.progress)}%
                        </span>
                    </div>
                </div>
            </Link>
        </CarouselItem>
    );
});

export function PodcastContinueListeningGrid({
    episodes,
}: PodcastContinueListeningGridProps) {
    return (
        <HorizontalCarousel>
            {episodes.map((episode, index) => (
                <EpisodeCard key={episode.id} episode={episode} index={index} />
            ))}
        </HorizontalCarousel>
    );
}
