"use client";

import { useState, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useSearchData } from "@/features/search/hooks/useSearchData";
import { useSoulseekSearch } from "@/features/search/hooks/useSoulseekSearch";
import { useFavorites } from "@/hooks/useFavorites";
import { SearchFilters } from "@/features/search/components/SearchFilters";
import { TopResult } from "@/features/search/components/TopResult";
import { EmptyState } from "@/features/search/components/EmptyState";
import { LibraryAlbumsGrid } from "@/features/search/components/LibraryAlbumsGrid";
import { LibraryPodcastsGrid } from "@/features/search/components/LibraryPodcastsGrid";
import { LibraryAudiobooksGrid } from "@/features/search/components/LibraryAudiobooksGrid";
import { LibraryPlaylistsGrid } from "@/features/search/components/LibraryPlaylistsGrid";
import { LibraryTracksList } from "@/features/search/components/LibraryTracksList";
import { LibraryEpisodesList } from "@/features/search/components/LibraryEpisodesList";
import { SimilarArtistsGrid } from "@/features/search/components/SimilarArtistsGrid";
import { AliasResolutionBanner } from "@/features/search/components/AliasResolutionBanner";
import { SoulseekSongsList } from "@/features/search/components/SoulseekSongsList";
import { TVSearchInput } from "@/features/search/components/TVSearchInput";
import { ResultCategoryTabs } from "@/features/search/components/ResultCategoryTabs";
import type { FilterTab, ResultCategory } from "@/features/search/types";

export default function SearchPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const [filterTab, setFilterTab] = useState<FilterTab>("all");
    const urlQuery = searchParams.get("q") ?? "";
    // `query` is local state so the user can type ahead of URL updates, but it
    // tracks the URL when the URL is the source of truth (back/forward, deep
    // links). Reading the URL during render and feeding it into the same state
    // updater lets us avoid a setState-in-effect cascading render.
    const [query, setQuery] = useState(() => urlQuery);
    if (urlQuery && urlQuery !== query) {
        // setState during render with the same input is allowed by React (it
        // schedules a re-render with the new value before commit). This avoids
        // the flicker an effect-based sync would produce.
        setQuery(urlQuery);
    }

    const {
        libraryResults,
        discoverResults,
        similarArtists,
        aliasInfo,
        isLibrarySearching,
        isDiscoverSearching,
        hasSearched,
    } = useSearchData({ query });
    const {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
    } = useSoulseekSearch({ query, enabled: filterTab !== "library" });
    const { favoriteIds, addFavorite, removeFavorite } = useFavorites();

    // Result category resets to "all" whenever the source filter or query
    // changes. Track the previous values during render so we can derive the
    // reset without an effect (avoids the wasted re-render that
    // setState-in-effect would cause).
    const [resultCategory, setResultCategory] = useState<ResultCategory>("all");
    const [lastFilterTab, setLastFilterTab] = useState(filterTab);
    const [lastQuery, setLastQuery] = useState(query);
    if (filterTab !== lastFilterTab || query !== lastQuery) {
        setLastFilterTab(filterTab);
        setLastQuery(query);
        setResultCategory("all");
    }

    const topArtist = discoverResults.find((r) => r.type === "music");
    const showLibrary = filterTab === "all" || filterTab === "library";
    const showDiscover = filterTab === "all" || filterTab === "discover";
    const showSoulseek = filterTab === "all" || filterTab === "soulseek";

    const counts = useMemo(() => ({
        artists: (libraryResults?.artists?.length ?? 0),
        albums: (libraryResults?.albums?.length ?? 0),
        songs: (libraryResults?.tracks?.length ?? 0),
        playlists: (libraryResults?.playlists?.length ?? 0),
    }), [libraryResults]);

    const hasLibraryResults = counts.artists + counts.albums + counts.songs + counts.playlists > 0;
    const isLoading = isLibrarySearching || isDiscoverSearching || isSoulseekSearching || isSoulseekPolling;

    const showCategoryTabs =
        hasSearched && showLibrary && hasLibraryResults;

    // Category-filtered visibility
    const showArtists = resultCategory === "all" || resultCategory === "artists";
    const showAlbums = resultCategory === "all" || resultCategory === "albums";
    const showSongs = resultCategory === "all" || resultCategory === "songs";
    const showPlaylists = resultCategory === "all" || resultCategory === "playlists";

    // In "all" category with 2-column layout: top result + songs side-by-side
    const hasTopResult = libraryResults?.artists?.[0] || topArtist;
    const hasTracks = (libraryResults?.tracks?.length ?? 0) > 0 || soulseekResults.length > 0;
    const show2ColumnLayout =
        hasSearched &&
        resultCategory === "all" &&
        hasTopResult &&
        hasTracks &&
        (showLibrary || showDiscover);

    const handleTVSearch = (searchQuery: string) => {
        setQuery(searchQuery);
        router.push(`/search?q=${encodeURIComponent(searchQuery)}`);
    };

    return (
        <div className="min-h-screen px-6 py-6">
            <TVSearchInput initialQuery={query} onSearch={handleTVSearch} />

            <SearchFilters
                filterTab={filterTab}
                onFilterChange={setFilterTab}
                soulseekEnabled={soulseekEnabled}
                hasSearched={hasSearched}
            />

            <div className="pb-24 space-y-8">
                {hasSearched && aliasInfo && (
                    <AliasResolutionBanner aliasInfo={aliasInfo} />
                )}

                <EmptyState hasSearched={hasSearched} isLoading={isLoading} />

                {/* Loading spinner — only when no results at all yet */}
                {hasSearched &&
                    isLibrarySearching &&
                    !hasLibraryResults &&
                    discoverResults.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-16 relative z-10">
                            <div className="relative w-16 h-16 mb-4">
                                <svg className="w-16 h-16 animate-spin" viewBox="0 0 64 64">
                                    <defs>
                                        <linearGradient id="spinnerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                            <stop offset="0%" style={{ stopColor: "#facc15", stopOpacity: 1 }} />
                                            <stop offset="50%" style={{ stopColor: "#c026d3", stopOpacity: 1 }} />
                                            <stop offset="100%" style={{ stopColor: "#facc15", stopOpacity: 1 }} />
                                        </linearGradient>
                                    </defs>
                                    <circle cx="32" cy="32" r="28" fill="none" stroke="url(#spinnerGrad)" strokeWidth="4" strokeLinecap="round" strokeDasharray="140 40" />
                                </svg>
                            </div>
                            <p className="text-gray-400 text-sm">Searching your library...</p>
                        </div>
                    )}

                {/* Category tabs for library results */}
                {showCategoryTabs && (
                    <ResultCategoryTabs
                        category={resultCategory}
                        onChange={setResultCategory}
                        counts={counts}
                    />
                )}

                {/* === 2-Column Layout: Top Result + Songs === */}
                {show2ColumnLayout ? (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div>
                            <TopResult
                                libraryArtist={libraryResults?.artists?.[0]}
                                discoveryArtist={topArtist}
                            />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
                                {showSoulseek && soulseekResults.length > 0
                                    ? "Songs"
                                    : showSoulseek && (isSoulseekSearching || isSoulseekPolling)
                                      ? <>
                                            <span>Songs</span>
                                            <span className="inline-flex items-center gap-2 text-sm font-normal text-gray-400">
                                                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                                                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="40 20" />
                                                </svg>
                                                Searching...
                                            </span>
                                        </>
                                      : "Songs"}
                            </h2>
                            {showSoulseek && soulseekResults.length > 0 ? (
                                <SoulseekSongsList
                                    soulseekResults={soulseekResults}
                                    downloadingFiles={downloadingFiles}
                                    onDownload={handleDownload}
                                />
                            ) : showLibrary && (libraryResults?.tracks?.length ?? 0) > 0 ? (
                                <LibraryTracksList
                                    tracks={libraryResults!.tracks!}
                                    favoriteIds={favoriteIds}
                                    onToggleFavorite={(trackId, isFavorite) => {
                                        if (isFavorite) addFavorite(trackId);
                                        else removeFavorite(trackId);
                                    }}
                                />
                            ) : null}
                        </div>
                    </div>
                ) : (
                    <>
                        {/* Single-column: Top Result */}
                        {hasSearched && showArtists &&
                            (showDiscover || showLibrary) &&
                            hasTopResult && (
                                <TopResult
                                    libraryArtist={libraryResults?.artists?.[0]}
                                    discoveryArtist={topArtist}
                                />
                            )}

                        {/* Soulseek Songs */}
                        {hasSearched && showSoulseek && showSongs && soulseekResults.length > 0 && (
                            <section>
                                <SoulseekSongsList
                                    soulseekResults={soulseekResults}
                                    downloadingFiles={downloadingFiles}
                                    onDownload={handleDownload}
                                />
                            </section>
                        )}

                        {/* Soulseek Loading */}
                        {hasSearched && showSoulseek && showSongs &&
                            soulseekResults.length === 0 &&
                            (isSoulseekSearching || isSoulseekPolling) && (
                                <section>
                                    <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
                                        <span>Soulseek</span>
                                        <span className="inline-flex items-center gap-2 text-sm font-normal text-gray-400">
                                            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                                                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="40 20" />
                                            </svg>
                                            Searching P2P network... (~45s)
                                        </span>
                                    </h2>
                                    <div className="space-y-2">
                                        {[1, 2, 3].map((i) => (
                                            <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-white/5 animate-pulse">
                                                <div className="w-10 h-10 rounded bg-white/10" />
                                                <div className="flex-1 space-y-2">
                                                    <div className="h-4 bg-white/10 rounded w-3/4" />
                                                    <div className="h-3 bg-white/10 rounded w-1/2" />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                        {/* Library Songs */}
                        {hasSearched && showLibrary && showSongs &&
                            (libraryResults?.tracks?.length ?? 0) > 0 && (
                                <section>
                                    <h2 className="text-2xl font-bold text-white mb-6">Songs</h2>
                                    <LibraryTracksList
                                        tracks={libraryResults!.tracks!}
                                        favoriteIds={favoriteIds}
                                        onToggleFavorite={(trackId, isFavorite) => {
                                            if (isFavorite) addFavorite(trackId);
                                            else removeFavorite(trackId);
                                        }}
                                    />
                                </section>
                            )}
                    </>
                )}

                {/* Library Albums */}
                {hasSearched && showLibrary && showAlbums &&
                    (libraryResults?.albums?.length ?? 0) > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">Albums</h2>
                            <LibraryAlbumsGrid albums={libraryResults!.albums!} />
                        </section>
                    )}

                {/* Library Playlists */}
                {hasSearched && showLibrary && showPlaylists &&
                    libraryResults?.playlists &&
                    libraryResults.playlists.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">Playlists</h2>
                            <LibraryPlaylistsGrid playlists={libraryResults.playlists} />
                        </section>
                    )}

                {/* Podcasts (only in "all" category) */}
                {hasSearched && showLibrary && resultCategory === "all" &&
                    (libraryResults?.podcasts?.length ?? 0) > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">Podcasts</h2>
                            <LibraryPodcastsGrid podcasts={libraryResults!.podcasts!} />
                        </section>
                    )}

                {/* Audiobooks (only in "all" category) */}
                {hasSearched && showLibrary && resultCategory === "all" &&
                    libraryResults?.audiobooks &&
                    libraryResults.audiobooks.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">Audiobooks</h2>
                            <LibraryAudiobooksGrid audiobooks={libraryResults.audiobooks} />
                        </section>
                    )}

                {/* Podcast Episodes (only in "all" category) */}
                {hasSearched && showLibrary && resultCategory === "all" &&
                    libraryResults?.episodes &&
                    libraryResults.episodes.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">Podcast Episodes</h2>
                            <LibraryEpisodesList episodes={libraryResults.episodes} />
                        </section>
                    )}

                {/* Related Artists (only in "all" or "artists" category) */}
                {hasSearched && showDiscover && showArtists &&
                    similarArtists.length > 0 && (
                        <SimilarArtistsGrid similarArtists={similarArtists} />
                    )}

                {/* No Results */}
                {hasSearched &&
                    !isLoading &&
                    !topArtist &&
                    soulseekResults.length === 0 &&
                    (!libraryResults ||
                        (!libraryResults.artists?.length &&
                            !libraryResults.albums?.length &&
                            !libraryResults.tracks?.length &&
                            !libraryResults.playlists?.length &&
                            !libraryResults.podcasts?.length &&
                            !libraryResults.audiobooks?.length &&
                            !libraryResults.episodes?.length)) && (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <SearchIcon className="w-16 h-16 text-gray-700 mb-4" />
                            <h3 className="text-xl font-bold text-white mb-2">No results found</h3>
                            <p className="text-gray-400">Try searching for something else</p>
                        </div>
                    )}
            </div>
        </div>
    );
}
