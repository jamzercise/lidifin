"use client";

import Link from "next/link";
import { ListMusic } from "lucide-react";
import Image from "next/image";
import { api } from "@/lib/api";
import type { PlaylistResult } from "../types";

interface LibraryPlaylistsGridProps {
    playlists: PlaylistResult[];
}

export function LibraryPlaylistsGrid({ playlists }: LibraryPlaylistsGridProps) {
    return (
        <div
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-4"
            data-tv-section="search-results-playlists"
        >
            {playlists.slice(0, 6).map((playlist, index) => (
                <Link
                    key={playlist.id}
                    href={`/playlist/${playlist.id}`}
                    data-tv-card
                    data-tv-card-index={index}
                    tabIndex={0}
                >
                    <div className="bg-[#121212] hover:bg-[#181818] transition-all p-4 rounded-lg group cursor-pointer">
                        <div className="relative aspect-square bg-[#181818] rounded-md mb-4 flex items-center justify-center overflow-hidden">
                            {playlist.coverUrl ? (
                                <Image
                                    src={api.getCoverArtUrl(playlist.coverUrl, 200)}
                                    alt={playlist.name}
                                    fill
                                    className="object-cover"
                                    loading="lazy"
                                    unoptimized
                                />
                            ) : (
                                <ListMusic className="w-12 h-12 text-gray-600" />
                            )}
                        </div>
                        <h3 className="text-base font-bold text-white line-clamp-1 mb-1">
                            {playlist.name}
                        </h3>
                        <p className="text-sm text-[#b3b3b3] line-clamp-1">
                            {playlist.trackCount} {playlist.trackCount === 1 ? "song" : "songs"}
                        </p>
                    </div>
                </Link>
            ))}
        </div>
    );
}
