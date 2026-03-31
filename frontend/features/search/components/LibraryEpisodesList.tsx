"use client";

import Link from "next/link";
import { Mic } from "lucide-react";
import { formatTime } from "@/utils/formatTime";
import type { Episode } from "../types";

interface LibraryEpisodesListProps {
    episodes: Episode[];
}

export function LibraryEpisodesList({ episodes }: LibraryEpisodesListProps) {
    if (!episodes || episodes.length === 0) return null;

    return (
        <div className="space-y-1" data-tv-section="search-results-episodes">
            {episodes.slice(0, 8).map((episode, index) => {
                const publishDate = episode.publishedAt
                    ? new Date(episode.publishedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                      })
                    : null;

                return (
                    <Link
                        key={episode.id}
                        href={`/podcasts/${episode.podcastId}`}
                        className="flex items-center gap-3 p-2 rounded-md group transition-colors hover:bg-white/5"
                        data-tv-card
                        data-tv-card-index={index}
                        tabIndex={0}
                    >
                        <div className="w-10 h-10 bg-[#282828] rounded flex items-center justify-center flex-shrink-0">
                            <Mic className="w-5 h-5 text-gray-500" />
                        </div>

                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-white truncate">
                                {episode.title}
                            </p>
                            <p className="text-xs text-gray-400 truncate">
                                {episode.podcastTitle}
                                {publishDate && (
                                    <span className="mx-1">• {publishDate}</span>
                                )}
                            </p>
                        </div>

                        {episode.duration > 0 && (
                            <span className="text-sm text-gray-400 flex-shrink-0">
                                {formatTime(episode.duration)}
                            </span>
                        )}
                    </Link>
                );
            })}
        </div>
    );
}
