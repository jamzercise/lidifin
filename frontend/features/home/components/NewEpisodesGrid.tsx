"use client";

import Link from "next/link";
import Image from "next/image";
import { Play, Mic2 } from "lucide-react";
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
    progress?: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: string;
    } | null;
}

interface NewEpisodesGridProps {
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
    const { playPodcast } = useAudio();
    const { setPodcastEpisodeQueue } = useAudioState();

    const coverUrl = episode.coverUrl ?? episode.podcast.coverUrl;
    const imageUrl = getProxiedImageUrl(coverUrl);

    const handlePlay = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setPodcastEpisodeQueue([
            {
                id: episode.id,
                title: episode.title,
                duration: episode.duration,
                publishedAt: episode.publishedAt,
                progress: episode.progress
                    ? {
                          currentTime: episode.progress.currentTime,
                          progress: episode.progress.progress,
                          isFinished: episode.progress.isFinished,
                          lastPlayedAt: new Date(episode.progress.lastPlayedAt),
                      }
                    : undefined,
            },
        ]);
        playPodcast({
            id: `${episode.podcast.id}:${episode.id}`,
            title: episode.title,
            podcastTitle: episode.podcast.title,
            coverUrl: coverUrl ?? null,
            duration: episode.duration,
            mimeType: episode.mimeType,
            progress: episode.progress
                ? {
                      currentTime: episode.progress.currentTime,
                      progress: episode.progress.progress,
                      isFinished: episode.progress.isFinished,
                      lastPlayedAt: new Date(episode.progress.lastPlayedAt),
                  }
                : null,
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
                                <Play className="w-5 h-5 text-black ml-0.5" fill="black" />
                            </div>
                        </button>
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
                        <span>{formatDuration(episode.duration)}</span>
                    </div>
                </div>
            </Link>
        </CarouselItem>
    );
});

export function NewEpisodesGrid({ episodes }: NewEpisodesGridProps) {
    return (
        <HorizontalCarousel>
            {episodes.map((episode, index) => (
                <EpisodeCard key={episode.id} episode={episode} index={index} />
            ))}
        </HorizontalCarousel>
    );
}
