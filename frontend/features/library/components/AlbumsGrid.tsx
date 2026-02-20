import React, { memo, useCallback, useMemo } from "react";
import Link from "next/link";
import { Album } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { Disc3, Play, Trash2 } from "lucide-react";
import { api } from "@/lib/api";

interface AlbumsGridProps {
    albums: Album[];
    onPlay: (albumId: string) => Promise<void>;
    onDelete: (albumId: string, albumTitle: string) => void;
    isLoading?: boolean;
}

interface AlbumCardItemProps {
    album: Album;
    index: number;
    onPlay: (albumId: string) => Promise<void>;
    onDelete: (albumId: string, albumTitle: string) => void;
}

const AlbumCardItem = memo(
    function AlbumCardItem({
        album,
        index,
        onPlay,
        onDelete,
    }: AlbumCardItemProps) {
        const handlePlay = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onPlay(album.id);
            },
            [album.id, onPlay],
        );
        const handleDelete = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(album.id, album.title);
            },
            [album.id, album.title, onDelete],
        );

        const coverArtUrl = useMemo(
            () => (album.coverArt ? api.getCoverArtUrl(album.coverArt, 200) : null),
            [album.coverArt],
        );

        return (
            <Link
                href={`/album/${encodeURIComponent(album.id)}`}
                prefetch={false}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className="group"
            >
                <div className="p-3 rounded-md cursor-pointer hover:bg-white/5 transition-colors" style={{ transform: "translateZ(0)" }}>
                    <div className="relative aspect-square mb-3">
                        <div className="w-full h-full bg-[#282828] rounded-md flex items-center justify-center overflow-hidden" style={{ contain: "content" }}>
                            {coverArtUrl ? (
                                <CachedImage
                                    src={coverArtUrl}
                                    alt={album.title}
                                    fill
                                    className="object-cover group-hover:scale-105 transition-transform"
                                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
                                />
                            ) : (
                                <Disc3 className="w-10 h-10 text-gray-600" />
                            )}
                        </div>
                        {/* Play button */}
                        <button
                            onClick={handlePlay}
                            className="absolute bottom-1 right-1 w-10 h-10 rounded-full bg-[#ecb200] flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                            <Play className="w-4 h-4 fill-current ml-0.5 text-black" />
                        </button>
                        {/* Delete button */}
                        <button
                            onClick={handleDelete}
                            className="absolute top-1 right-1 w-7 h-7 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-opacity"
                            title="Delete album"
                        >
                            <Trash2 className="w-3.5 h-3.5 text-white" />
                        </button>
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">
                        {album.title}
                    </h3>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {album.artist?.name}
                    </p>
                </div>
            </Link>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.album.id === nextProps.album.id;
    },
);

const AlbumsGrid = memo(function AlbumsGrid({
    albums,
    onPlay,
    onDelete,
    isLoading = false,
}: AlbumsGridProps) {
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (albums.length === 0) {
        return (
            <EmptyState
                icon={<Disc3 className="w-12 h-12" />}
                title="No albums yet"
                description="Your library is empty. Sync your music to get started."
            />
        );
    }

    return (
        <div
            data-tv-section="library-albums"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4"
        >
            {albums.map((album, index) => (
                <AlbumCardItem
                    key={album.id}
                    album={album}
                    index={index}
                    onPlay={onPlay}
                    onDelete={onDelete}
                />
            ))}
        </div>
    );
});

export { AlbumsGrid };
