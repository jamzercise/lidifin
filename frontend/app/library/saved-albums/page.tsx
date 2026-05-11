"use client";

import Link from "next/link";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Disc3 } from "lucide-react";
import { api } from "@/lib/api";
import { queryKeys } from "@/hooks/useQueries";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { toast } from "sonner";

export default function SavedDiscoveryAlbumsPage() {
    const queryClient = useQueryClient();
    const { data, isLoading, isError } = useQuery({
        queryKey: queryKeys.savedDiscoveryAlbums({ limit: 200, offset: 0 }),
        queryFn: () => api.getSavedDiscoveryAlbums({ limit: 200, offset: 0 }),
    });

    const unsaveMutation = useMutation({
        mutationFn: (rgMbid: string) => api.unsaveDiscoveryAlbum(rgMbid),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["discover", "saved-albums"],
            });
            queryClient.invalidateQueries({
                queryKey: ["artist", "enrichment"],
            });
        },
    });

    const albums = data?.albums ?? [];

    return (
        <div className="min-h-screen bg-[#0a0a0a] text-white pb-24">
            <div className="max-w-6xl mx-auto px-4 pt-8">
                <Link
                    href="/library"
                    className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-6"
                >
                    <ArrowLeft className="w-4 h-4" aria-hidden />
                    Back to Library
                </Link>

                <h1 className="text-2xl font-bold mb-1">Saved albums</h1>
                <p className="text-sm text-gray-400 mb-8">
                    Release groups you bookmarked from discovery (MusicBrainz).
                    Open an album for details or download from its page.
                </p>

                {isLoading && (
                    <div className="flex justify-center py-20">
                        <GradientSpinner size="lg" />
                    </div>
                )}

                {isError && (
                    <p className="text-red-400 text-sm">
                        Could not load saved albums. Try again later.
                    </p>
                )}

                {!isLoading && !isError && albums.length === 0 && (
                    <p className="text-gray-400 text-sm">
                        Nothing saved yet. On an artist page, use the bookmark on
                        an available album to save it for later.
                    </p>
                )}

                {!isLoading && !isError && albums.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                        {albums.map((row, index) => {
                            const cover = row.coverUrl
                                ? api.getCoverArtUrl(row.coverUrl, 300)
                                : null;
                            const busy = unsaveMutation.isPending;
                            return (
                                <PlayableCard
                                    key={row.id}
                                    href={`/album/${encodeURIComponent(row.rgMbid)}`}
                                    coverArt={cover}
                                    title={row.albumTitle}
                                    subtitle={row.artistName}
                                    placeholderIcon={
                                        <Disc3 className="w-12 h-12 text-gray-600" />
                                    }
                                    circular={false}
                                    showPlayButton={false}
                                    bookmark={{
                                        active: true,
                                        busy:
                                            busy &&
                                            unsaveMutation.variables ===
                                                row.rgMbid,
                                        onClick: (e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            unsaveMutation.mutate(row.rgMbid, {
                                                onSuccess: (res) => {
                                                    if (res.removed) {
                                                        toast.success(
                                                            "Removed from saved"
                                                        );
                                                    }
                                                },
                                                onError: () => {
                                                    toast.error(
                                                        "Could not remove save"
                                                    );
                                                },
                                            });
                                        },
                                    }}
                                    tvCardIndex={index}
                                />
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
