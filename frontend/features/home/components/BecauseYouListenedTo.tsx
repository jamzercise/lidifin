"use client";

import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { toArtistRouteId } from "@/lib/route-ids";
import { usePrefetchArtist } from "@/hooks/useQueries";
import { memo } from "react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { SectionHeader } from "./SectionHeader";

interface RecommendedArtist {
    id: string;
    mbid?: string | null;
    name: string;
    coverArt?: string | null;
}

interface BecauseYouListenedSection {
    seedArtist: {
        name: string;
        image: string | null;
    };
    recommendations: RecommendedArtist[];
}

interface BecauseYouListenedToProps {
    sections: BecauseYouListenedSection[];
}

const ArtistCard = memo(function ArtistCard({
    artist,
    index,
}: {
    artist: RecommendedArtist;
    index: number;
}) {
    const prefetchArtist = usePrefetchArtist();
    const routeId = toArtistRouteId(artist);
    const imageSrc = artist.coverArt
        ? api.getCoverArtUrl(artist.coverArt, 300)
        : null;

    return (
        <CarouselItem>
            <Link
                href={`/artist/${encodeURIComponent(routeId)}`}
                onMouseEnter={() => prefetchArtist(routeId, artist)}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    <div className="aspect-square bg-[#282828] rounded-full mb-3 flex items-center justify-center overflow-hidden relative shadow-lg">
                        {imageSrc ? (
                            <Image
                                src={imageSrc}
                                alt={artist.name}
                                fill
                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                                sizes="180px"
                                priority={false}
                                unoptimized
                            />
                        ) : (
                            <Music className="w-10 h-10 text-gray-600" />
                        )}
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">
                        {artist.name}
                    </h3>
                    <p className="text-xs text-gray-400 mt-0.5">Artist</p>
                </div>
            </Link>
        </CarouselItem>
    );
});

const BecauseYouListenedTo = memo(function BecauseYouListenedTo({
    sections,
}: BecauseYouListenedToProps) {
    if (!sections || sections.length === 0) return null;

    return (
        <>
            {sections.map((section) => (
                <section key={section.seedArtist.name}>
                    <SectionHeader
                        title={`Because you listened to ${section.seedArtist.name}`}
                    />
                    <HorizontalCarousel>
                        {section.recommendations.map((artist, index) => (
                            <ArtistCard
                                key={artist.id}
                                artist={artist}
                                index={index}
                            />
                        ))}
                    </HorizontalCarousel>
                </section>
            ))}
        </>
    );
});

export { BecauseYouListenedTo };
export type { BecauseYouListenedSection };
