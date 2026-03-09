"use client";

import Link from "next/link";
import Image from "next/image";
import { api } from "@/lib/api";
import { memo } from "react";

interface MixCardProps {
    mix: {
        id: string;
        name: string;
        description: string;
        coverUrls: string[];
        trackCount: number;
    };
    index?: number;
}

const MixCard = memo(
    function MixCard({ mix, index }: MixCardProps) {
        const coverUrl = api.getMixCoverUrl(mix.id, 300);

        return (
            <Link
                href={`/mix/${mix.id}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    {/* Generated cover art (gradient + abstract shapes) */}
                    <div className="aspect-square bg-[#282828] rounded-full mb-3 overflow-hidden relative shadow-lg">
                        <Image
                            src={coverUrl}
                            alt=""
                            fill
                            className="object-cover group-hover:scale-105 transition-transform duration-300"
                            sizes="180px"
                            unoptimized
                        />
                    </div>

                    <h3 className="text-sm font-semibold text-white truncate">
                        {mix.name}
                    </h3>
                    <p className="text-xs text-gray-400 line-clamp-2 mt-0.5">
                        {mix.description}
                    </p>
                </div>
            </Link>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.mix.id === nextProps.mix.id &&
            prevProps.mix.name === nextProps.mix.name &&
            prevProps.mix.description === nextProps.mix.description &&
            prevProps.mix.trackCount === nextProps.mix.trackCount
        );
    }
);

export { MixCard };
