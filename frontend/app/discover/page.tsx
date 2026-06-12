"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Music2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useAudioState, useAudioPlayback } from "@/lib/audio-context";
import { useDiscoverData } from "@/features/discover/hooks/useDiscoverData";
import { useDiscoverActions } from "@/features/discover/hooks/useDiscoverActions";
import { usePreviewPlayer } from "@/features/discover/hooks/usePreviewPlayer";
import { DiscoverHero } from "@/features/discover/components/DiscoverHero";
import { DiscoverActionBar } from "@/features/discover/components/DiscoverActionBar";
import { DiscoverSettings } from "@/features/discover/components/DiscoverSettings";
import { TrackList } from "@/features/discover/components/TrackList";
import { TrackFilters, type TrackSort } from "@/features/discover/components/TrackFilters";
import { UnavailableAlbums } from "@/features/discover/components/UnavailableAlbums";
import { HowItWorks } from "@/features/discover/components/HowItWorks";
import { DiscoverShelves } from "@/features/discover/components/DiscoverShelves";
import { GenerationStatusCard } from "@/features/discover/components/GenerationStatusCard";

export default function DiscoverWeeklyPage() {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const [showSettings, setShowSettings] = useState(false);
    const [sortBy, setSortBy] = useState<TrackSort>("order");
    const [tierFilter, setTierFilter] = useState<string>("all");

    const { playlist, config, setConfig, loading, reloadData, batchStatus, refreshBatchStatus, setPendingGeneration, updateTrackLiked, isGenerating, handleRebuild, handleCancel, handleRetryAlbum } = useDiscoverData();
    const {
        handleGenerate,
        handleLike,
        handlePlayPlaylist,
        handlePlayTrack,
        handleTogglePlay,
    } = useDiscoverActions(playlist, reloadData, isGenerating, refreshBatchStatus, setPendingGeneration, updateTrackLiked);
    const { currentPreview, handleTogglePreview } = usePreviewPlayer();

    const isPlaylistPlaying = playlist?.tracks.some(
        (t) => t.id === currentTrack?.id
    );

    const TIER_ORDER: Record<string, number> = {
        high: 0,
        medium: 1,
        explore: 2,
        wildcard: 3,
    };

    const displayedTracks = useMemo(() => {
        if (!playlist) return [];
        let tracks = playlist.tracks;
        if (tierFilter !== "all") {
            tracks = tracks.filter((t) => t.tier === tierFilter);
        }
        if (sortBy === "match") {
            tracks = [...tracks].sort(
                (a, b) => (b.similarity || 0) - (a.similarity || 0)
            );
        } else if (sortBy === "tier") {
            tracks = [...tracks].sort(
                (a, b) =>
                    (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) ||
                    (b.similarity || 0) - (a.similarity || 0)
            );
        }
        return tracks;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- TIER_ORDER is a stable literal
    }, [playlist, sortBy, tierFilter]);

    // Map a row index in the (possibly filtered/sorted) displayed list back to
    // the original playlist index so the player queues the right track.
    const handlePlayDisplayedTrack = (displayIndex: number) => {
        const track = displayedTracks[displayIndex];
        if (!track || !playlist) return;
        const realIndex = playlist.tracks.findIndex((t) => t.id === track.id);
        handlePlayTrack(realIndex >= 0 ? realIndex : 0);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    const batchContext = playlist?.batchContext;

    const handleDismissFailed = async () => {
        await api.dismissFailedDiscoverJobs(batchContext?.batchId);
        await Promise.all([reloadData(), refreshBatchStatus()]);
    };

    return (
        <div className="min-h-screen">
            <DiscoverHero playlist={playlist} config={config} />

            <DiscoverActionBar
                playlist={playlist}
                config={config}
                isPlaylistPlaying={isPlaylistPlaying || false}
                isPlaying={isPlaying}
                onPlayToggle={isPlaylistPlaying && isPlaying ? handleTogglePlay : handlePlayPlaylist}
                onGenerate={handleGenerate}
                onToggleSettings={() => setShowSettings(!showSettings)}
                isGenerating={isGenerating}
                batchStatus={batchStatus}
            />

            {showSettings && (
                <DiscoverSettings
                    config={config}
                    onUpdateConfig={setConfig}
                    onPlaylistCleared={reloadData}
                />
            )}

            {/* Track Listing */}
            <div className="px-4 md:px-8">
                {playlist && playlist.tracks.length > 0 ? (
                        <div className="space-y-6">
                            {isGenerating && (
                                <GenerationStatusCard
                                    batchContext={batchContext ?? null}
                                    batchStatus={batchStatus}
                                    isGenerating={isGenerating}
                                    hasPlaylist
                                    onRebuild={handleRebuild}
                                    onGenerate={handleGenerate}
                                    onCancel={handleCancel}
                                    onRetryAlbum={handleRetryAlbum}
                                    onDismissFailed={handleDismissFailed}
                                />
                            )}
                            <div
                                className={cn(
                                    "space-y-6 transition-opacity",
                                    isGenerating && "opacity-50"
                                )}
                                aria-busy={isGenerating}
                            >
                                <TrackFilters
                                    tracks={playlist.tracks}
                                    sortBy={sortBy}
                                    onSortChange={setSortBy}
                                    tierFilter={tierFilter}
                                    onTierChange={setTierFilter}
                                />
                                {displayedTracks.length > 0 ? (
                                    <TrackList
                                        tracks={displayedTracks}
                                        currentTrack={currentTrack}
                                        isPlaying={isPlaying}
                                        onPlayTrack={handlePlayDisplayedTrack}
                                        onTogglePlay={handleTogglePlay}
                                        onLike={handleLike}
                                    />
                                ) : (
                                    <p className="text-sm text-gray-500 px-4 py-8 text-center">
                                        No tracks match this filter.
                                    </p>
                                )}

                                <UnavailableAlbums
                                    unavailable={playlist.unavailable}
                                    currentPreview={currentPreview}
                                    onTogglePreview={handleTogglePreview}
                                />

                                <HowItWorks exclusionMonths={config?.exclusionMonths} />
                            </div>
                        </div>
                    ) : batchContext ? (
                        <div className="py-6">
                            <GenerationStatusCard
                                batchContext={batchContext}
                                batchStatus={batchStatus}
                                isGenerating={isGenerating}
                                hasPlaylist={false}
                                onRebuild={handleRebuild}
                                onGenerate={handleGenerate}
                                onCancel={handleCancel}
                                onRetryAlbum={handleRetryAlbum}
                                onDismissFailed={handleDismissFailed}
                            />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <div className="w-20 h-20 bg-gradient-to-br from-purple-600/20 to-yellow-600/20 rounded-full flex items-center justify-center mb-4 shadow-xl border border-white/10">
                                <Music2 className="w-10 h-10 text-purple-400" />
                            </div>
                            <h3 className="text-lg font-medium text-white mb-1">
                                No Discover Weekly Yet
                            </h3>
                            <p className="text-sm text-gray-500 mb-6 max-w-md">
                                Generate your first playlist based on your
                                listening history!
                            </p>
                            <button
                                onClick={handleGenerate}
                                disabled={isGenerating}
                                className={cn(
                                    "flex items-center gap-2 px-6 py-3 rounded-full text-white font-semibold transition-all",
                                    isGenerating
                                        ? "bg-white/5 cursor-not-allowed opacity-50"
                                        : "bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 hover:scale-105"
                                )}
                            >
                                {isGenerating ? (
                                    <>
                                        <GradientSpinner size="sm" />
                                        {batchStatus?.status === "scanning" 
                                            ? "Importing tracks..."
                                            : `Downloading... ${batchStatus?.completed || 0}/${batchStatus?.total || 0}`
                                        }
                                    </>
                                ) : (
                                    <>
                                        <RefreshCw className="w-5 h-5" />
                                        Generate Now
                                    </>
                                )}
                            </button>
                        </div>
                    )}
            </div>

            {/* Discover hub shelves — complementary discovery rails below the
                Discover Weekly headline experience. */}
            <div className="px-4 md:px-8 pt-12 pb-32">
                <DiscoverShelves
                    hiddenGems={playlist?.unavailable ?? []}
                    currentPreview={currentPreview}
                    onTogglePreview={handleTogglePreview}
                />
            </div>
        </div>
    );
}

