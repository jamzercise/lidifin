"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCastAwareAudioControls } from "@/lib/useCastAwareAudioControls";
import type { Track } from "@/types/music";

/** Minimal seed a caller needs to provide to start a song radio. */
export interface SongRadioSeed {
    id: string;
    title: string;
    artist?: { name: string; id?: string };
    album?: { title?: string; id?: string; coverArt?: string | null };
    duration?: number;
}

/** Loose shape covering the different similar-track API payloads. */
interface RawSimilarTrack {
    id: string;
    title: string;
    duration?: number;
    inLibrary?: boolean;
    artist?: { name?: string; id?: string } | null;
    album?: {
        title?: string;
        id?: string;
        coverArt?: string | null;
        coverUrl?: string | null;
    } | null;
}

function toTrack(raw: RawSimilarTrack): Track {
    return {
        id: raw.id,
        title: raw.title,
        artist: { name: raw.artist?.name ?? "Unknown", id: raw.artist?.id },
        album: {
            title: raw.album?.title ?? "Unknown",
            id: raw.album?.id,
            coverArt: raw.album?.coverArt ?? raw.album?.coverUrl ?? null,
        },
        duration: raw.duration ?? 0,
    };
}

/**
 * Starts an endless "song radio" queue seeded from any track, reusing the
 * existing similarity engines with graceful fallback so it works regardless of
 * which analyzers are configured:
 *   1. AudioMuse similar tracks (best quality, library-resolved) — Jellyfin ids
 *   2. Vibe similarity (library-resolved)
 *   3. Last.fm similar tracks mapped to owned library tracks
 *
 * The seed track plays first, followed by the similar queue.
 */
export function useSongRadio() {
    const { playTracks } = useCastAwareAudioControls();
    const [startingId, setStartingId] = useState<string | null>(null);

    const startRadio = useCallback(
        async (seed: SongRadioSeed) => {
            setStartingId(seed.id);
            try {
                let similar: Track[] = [];

                // 1. AudioMuse (Jellyfin-resolved ids only)
                if (seed.id.startsWith("jellyfin:")) {
                    try {
                        const res = await api.getAudioMuseSimilarTracks(
                            seed.id,
                            30
                        );
                        similar = (res.tracks ?? []).map((t) =>
                            toTrack(t as RawSimilarTrack)
                        );
                    } catch {
                        /* fall through */
                    }
                }

                // 2. Vibe similarity
                if (similar.length === 0) {
                    try {
                        const res = await api.getVibeSimilarTracks(seed.id, 30);
                        similar = (res.tracks ?? []).map((t) =>
                            toTrack(t as RawSimilarTrack)
                        );
                    } catch {
                        /* fall through */
                    }
                }

                // 3. Last.fm similar tracks, restricted to tracks we own
                if (similar.length === 0) {
                    try {
                        const res = await api.getSimilarTracks(seed.id, 30);
                        const recs = (res.recommendations ??
                            []) as RawSimilarTrack[];
                        similar = recs
                            .filter((t) => t.inLibrary)
                            .map((t) => toTrack(t));
                    } catch {
                        /* fall through */
                    }
                }

                if (similar.length === 0) {
                    toast.error("Couldn't start a radio from this song", {
                        description:
                            "No similar tracks found in your library yet.",
                    });
                    return;
                }

                // Lead with the seed itself when we have enough to play it.
                const hasPlayableSeed =
                    seed.duration != null && seed.artist != null;
                const queue: Track[] = hasPlayableSeed
                    ? [toTrack(seed as RawSimilarTrack), ...similar]
                    : similar;

                playTracks(queue, 0);
                toast.success("Song radio started", {
                    description: `Queued ${similar.length} similar tracks`,
                });
            } finally {
                setStartingId(null);
            }
        },
        [playTracks]
    );

    return { startRadio, startingId };
}
