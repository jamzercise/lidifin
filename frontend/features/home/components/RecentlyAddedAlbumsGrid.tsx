"use client";

import Link from "next/link";
import Image from "next/image";
import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";
import { toAlbumRouteId } from "@/lib/route-ids";
import { usePrefetchAlbum } from "@/hooks/useQueries";
import { memo } from "react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";

interface Album {
    id: string;
    title: string;
    coverArt?: string | null;
    year?: number;
    rgMbid?: string | null;
    artist?: { id: string; name: string };
}

interface RecentlyAddedAlbumsGridProps {
    albums: Album[];
}

const getAlbumCoverSrc = (album: Album) => {
    const url = album.coverArt;
    if (!url) return null;
    return api.getCoverArtUrl(url, 300);
};

interface AlbumCardProps {
    album: Album;
    index: number;
}

const AlbumCard = memo(function AlbumCard({ album, index }: AlbumCardProps) {
    const coverSrc = getAlbumCoverSrc(album);
    const prefetchAlbum = usePrefetchAlbum();
    const routeId = toAlbumRouteId(album);

    return (
        <CarouselItem>
            <Link
                href={`/album/${encodeURIComponent(routeId)}`}
                onMouseEnter={() => prefetchAlbum(routeId)}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    <div className="aspect-square bg-[#282828] rounded-md mb-3 flex items-center justify-center overflow-hidden relative shadow-lg">
                        {coverSrc ? (
                            <Image
                                src={coverSrc}
                                alt={album.title}
                                fill
                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                                sizes="180px"
                                priority={false}
                                unoptimized
                            />
                        ) : (
                            <Disc3 className="w-10 h-10 text-gray-600" />
                        )}
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">
                        {album.title}
                    </h3>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {album.artist?.name ?? "Unknown Artist"}
                    </p>
                </div>
            </Link>
        </CarouselItem>
    );
});

const RecentlyAddedAlbumsGrid = memo(function RecentlyAddedAlbumsGrid({
    albums,
}: RecentlyAddedAlbumsGridProps) {
    return (
        <HorizontalCarousel>
            {albums.map((album, index) => (
                <AlbumCard key={album.id} album={album} index={index} />
            ))}
        </HorizontalCarousel>
    );
});

export { RecentlyAddedAlbumsGrid };
