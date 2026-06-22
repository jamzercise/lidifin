"use client";

import Link from "next/link";
import {
    useQueryClient,
    useMutation,
    useInfiniteQuery,
} from "@tanstack/react-query";
import { ArrowLeft, Disc3, RefreshCw, Bookmark } from "lucide-react";
import { api } from "@/lib/api";
import { queryKeys } from "@/hooks/useQueries";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { PageHero } from "@/components/ui/PageHero";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { toast } from "sonner";

const PAGE_SIZE = 48;

export default function SavedDiscoveryAlbumsPage() {
    const queryClient = useQueryClient();
    const savedQueryKey = queryKeys.savedDiscoveryAlbumsInfinite(PAGE_SIZE);

    const {
        data,
        isLoading,
        isError,
        isFetching,
        refetch,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
    } = useInfiniteQuery({
        queryKey: savedQueryKey,
        queryFn: ({ pageParam }) =>
            api.getSavedDiscoveryAlbums({
                limit: PAGE_SIZE,
                offset: pageParam as number,
            }),
        initialPageParam: 0,
        getNextPageParam: (lastPage) => {
            const nextOffset = lastPage.offset + lastPage.albums.length;
            return nextOffset < lastPage.total ? nextOffset : undefined;
        },
    });

    const albums = data?.pages.flatMap((p) => p.albums) ?? [];
    const total = data?.pages[0]?.total ?? 0;

    const unsaveMutation = useMutation({
        mutationFn: (rgMbid: string) => api.unsaveDiscoveryAlbum(rgMbid),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["discover", "saved-albums"],
            });
        },
    });

    const showInitialSpinner = isLoading && !data;
    const isEmpty = !isLoading && !isError && albums.length === 0;

    return (
        <div className="min-h-screen bg-[#0a0a0a] text-white pb-24">
            <PageHero
                variant="compact"
                accent="rose"
                eyebrow="Your Collection"
                icon={<Bookmark className="w-4 h-4" />}
                title="Saved Albums"
                subtitle="Bookmarked release groups — separate from your library and favorites."
                backdropImages={albums
                    .slice(0, 4)
                    .map((a) =>
                        a.coverUrl ? api.getCoverArtUrl(a.coverUrl, 300) : null
                    )}
                stats={
                    total > 0
                        ? [
                              {
                                  icon: <Bookmark />,
                                  label: `${total} saved ${
                                      total === 1 ? "album" : "albums"
                                  }`,
                              },
                          ]
                        : undefined
                }
            />
            <div className="max-w-6xl mx-auto px-4 pt-6">
                <Link
                    href="/library"
                    className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-6"
                >
                    <ArrowLeft className="w-4 h-4" aria-hidden />
                    Back to Library
                </Link>

                {!isError && albums.length > 0 && total > 0 && (
                    <p className="text-xs text-gray-500 mb-4" aria-live="polite">
                        Showing {albums.length} of {total} saved{" "}
                        {total === 1 ? "album" : "albums"}
                    </p>
                )}

                {showInitialSpinner && (
                    <div className="flex justify-center py-20">
                        <GradientSpinner size="lg" />
                    </div>
                )}

                {isError && (
                    <div
                        className="rounded-lg border border-red-500/30 bg-red-950/40 px-4 py-4"
                        role="alert"
                    >
                        <p className="text-red-300 text-sm mb-3">
                            Could not load saved albums. Check your connection
                            and try again.
                        </p>
                        <button
                            type="button"
                            onClick={() => void refetch()}
                            disabled={isFetching}
                            className="inline-flex items-center gap-2 rounded-lg bg-white/10 hover:bg-white/15 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                        >
                            <RefreshCw
                                className={
                                    "w-4 h-4" +
                                    (isFetching ? " animate-spin" : "")
                                }
                                aria-hidden
                            />
                            Retry
                        </button>
                    </div>
                )}

                {isEmpty && (
                    <div className="text-gray-400 text-sm space-y-3 max-w-lg">
                        <p>Nothing saved yet.</p>
                        <p>
                            Use the{" "}
                            <span className="text-gray-300">bookmark</span> on an
                            available album on an{" "}
                            <span className="text-gray-300">artist</span> page, or{" "}
                            <span className="text-gray-300">Save for later</span>{" "}
                            on an album you’re browsing. Your saved list stays here
                            until you remove it.
                        </p>
                        <p>
                            <Link
                                href="/discover"
                                className="text-purple-400 hover:text-purple-300 underline-offset-4 hover:underline"
                            >
                                Discover Weekly
                            </Link>
                            {" — "}
                            <Link
                                href="/library"
                                className="text-purple-400 hover:text-purple-300 underline-offset-4 hover:underline"
                            >
                                Browse library artists
                            </Link>
                            .
                        </p>
                    </div>
                )}

                {!showInitialSpinner && !isError && albums.length > 0 && (
                    <>
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
                                                unsaveMutation.mutate(
                                                    row.rgMbid,
                                                    {
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
                                                    }
                                                );
                                            },
                                        }}
                                        tvCardIndex={index}
                                    />
                                );
                            })}
                        </div>

                        {hasNextPage && (
                            <div className="flex justify-center mt-8">
                                <button
                                    type="button"
                                    onClick={() => void fetchNextPage()}
                                    disabled={
                                        isFetchingNextPage ||
                                        unsaveMutation.isPending
                                    }
                                    className="rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50"
                                >
                                    {isFetchingNextPage ?
                                        "Loading…"
                                    :   `Load more${
                                            total > albums.length ?
                                                ` (${total - albums.length} left)`
                                            :   ""
                                        }`}
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
