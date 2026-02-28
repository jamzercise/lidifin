"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

export interface FavoritesState {
    tracks: Array<{
        id: string;
        title: string;
        duration: number;
        artist?: { id: string; name: string };
        album?: { id: string; title: string; coverArt?: string | null };
    }>;
    isLoading: boolean;
    error: string | null;
    favoriteIds: Set<string>;
    addFavorite: (trackId: string) => Promise<void>;
    removeFavorite: (trackId: string) => Promise<void>;
    isFavorite: (trackId: string) => boolean;
    refetch: () => Promise<void>;
}

export function useFavorites(): FavoritesState {
    const { toast } = useToast();
    const [tracks, setTracks] = useState<FavoritesState["tracks"]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchFavorites = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await api.getFavorites();
            setTracks(res.tracks ?? []);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load favorites");
            setTracks([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchFavorites();
    }, [fetchFavorites]);

    const favoriteIds = new Set(tracks.map((t) => t.id));

    const addFavorite = useCallback(
        async (trackId: string) => {
            // Optimistic update: add to local state immediately
            setTracks((prev) => {
                if (prev.some((t) => t.id === trackId)) return prev;
                return [...prev, { id: trackId, title: "", duration: 0 }];
            });
            try {
                await api.addFavorite(trackId);
                await fetchFavorites();
            } catch (e) {
                // Revert optimistic update on error
                setTracks((prev) => prev.filter((t) => t.id !== trackId));
                fetchFavorites();
                const err = e as { message?: string; data?: { detail?: string } };
                const msg = err?.data?.detail ?? err?.message ?? "Failed to add to favorites";
                toast.error(msg);
            }
        },
        [fetchFavorites, toast]
    );

    const tracksRef = useRef(tracks);
    tracksRef.current = tracks;

    const removeFavorite = useCallback(
        async (trackId: string) => {
            const previous = [...tracksRef.current];
            setTracks((prev) => prev.filter((t) => t.id !== trackId));
            try {
                await api.removeFavorite(trackId);
                await fetchFavorites();
            } catch (e) {
                setTracks(previous);
                fetchFavorites();
                const err = e as { message?: string; data?: { detail?: string } };
                const msg = err?.data?.detail ?? err?.message ?? "Failed to remove from favorites";
                toast.error(msg);
            }
        },
        [fetchFavorites, toast]
    );

    const isFavorite = useCallback(
        (id: string) => favoriteIds.has(id),
        [tracks]
    );

    return {
        tracks,
        isLoading,
        error,
        favoriteIds,
        addFavorite,
        removeFavorite,
        isFavorite,
        refetch: fetchFavorites,
    };
}
