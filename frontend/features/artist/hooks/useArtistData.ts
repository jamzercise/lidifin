import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { toArtistRouteId } from "@/lib/route-ids";
import { ArtistSource } from "../types";
import { useMemo, useEffect, useRef, useState } from "react";

export function useArtistData() {
    const params = useParams();
    const router = useRouter();
    const id = params.id as string;
    const queryClient = useQueryClient();
    const { downloadStatus } = useDownloadContext();
    const prevActiveCountRef = useRef(downloadStatus.activeDownloads.length);

    // Phase 1: Fetch minimal artist (fast – Jellyfin artist returns without enrichment)
    const {
        data: artist,
        isLoading,
        isError,
        refetch,
    } = useQuery({
        queryKey: queryKeys.artist(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Artist ID is required");
            try {
                return await api.getArtist(id);
            } catch {
                if (id.startsWith("jellyfin:")) {
                    throw new Error("Artist not found");
                }
                return await api.getArtistDiscovery(id);
            }
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    // Phase 2: Fetch enrichment for Jellyfin artists (bio, similar artists, discovery albums)
    const { data: enrichment } = useQuery({
        queryKey: queryKeys.artistEnrichment(id || ""),
        queryFn: () => api.getArtistEnrichment(id),
        enabled: !!id && !!artist?.id?.startsWith?.("jellyfin:"),
        staleTime: 10 * 60 * 1000,
    });

    // Merge enrichment into artist when available (two-phase load)
    const mergedArtist = useMemo(() => {
        if (!artist) return null;
        if (!enrichment) return artist;
        const ownedRgMbids = new Set(
            (artist.albums || []).map((a: { rgMbid?: string }) => a.rgMbid).filter(Boolean)
        );
        const discoveryToAdd = (enrichment.discoveryAlbums || []).filter(
            (d: { rgMbid?: string }) => !ownedRgMbids.has(d.rgMbid)
        );
        const mergedAlbums = [...(artist.albums || []), ...discoveryToAdd].sort(
            (a: { year?: number }, b: { year?: number }) => (b.year ?? 0) - (a.year ?? 0)
        );
        return {
            ...artist,
            bio: enrichment.bio ?? artist.bio,
            image: enrichment.image ?? artist.image,
            coverArt: enrichment.image ?? artist.coverArt,
            heroUrl: enrichment.image ?? artist.heroUrl,
            genres: enrichment.genres ?? artist.genres ?? [],
            listeners: enrichment.listeners ?? artist.listeners,
            playcount: enrichment.playcount ?? artist.playcount,
            similarArtists: enrichment.similarArtists ?? artist.similarArtists ?? [],
            topTracks: enrichment.topTracks?.length ? enrichment.topTracks : artist.topTracks,
            albums: mergedAlbums,
        };
    }, [artist, enrichment]);

    // Refetch when downloads complete (active count decreases)
    useEffect(() => {
        const currentActiveCount = downloadStatus.activeDownloads.length;
        if (
            prevActiveCountRef.current > 0 &&
            currentActiveCount < prevActiveCountRef.current
        ) {
            queryClient.invalidateQueries({ queryKey: queryKeys.artist(id) });
            queryClient.invalidateQueries({ queryKey: queryKeys.artistEnrichment(id) });
        }
        prevActiveCountRef.current = currentActiveCount;
    }, [downloadStatus.activeDownloads.length, id, queryClient]);

    // Canonicalize URL: if we landed on /artist/{mbid} and have artist data,
    // replace URL with /artist/{name} so all artist pages use name-based URLs
    useEffect(() => {
        if (!mergedArtist || !id) return;
        const canonical = toArtistRouteId(mergedArtist);
        if (canonical && canonical !== decodeURIComponent(id)) {
            router.replace(`/artist/${encodeURIComponent(canonical)}`, {
                scroll: false,
            });
        }
    }, [mergedArtist, id, router]);

    // Determine source from the artist data (if it came from library or discovery)
    const source: ArtistSource | null = useMemo(() => {
        if (!mergedArtist) return null;
        if (mergedArtist.id?.startsWith("jellyfin:")) return "library";
        return mergedArtist.id && !mergedArtist.id.includes("-") ? "library" : "discovery";
    }, [mergedArtist]);

    // Sort state: 'year' or 'dateAdded'
    const [sortBy, setSortBy] = useState<"year" | "dateAdded">("year");

    // Sort albums by year or dateAdded (auto-memoized by React Compiler)
    const albums = !mergedArtist?.albums
        ? []
        : [...mergedArtist.albums].sort((a, b) => {
              if (sortBy === "dateAdded") {
                  if (!a.lastSynced && !b.lastSynced) return 0;
                  if (!a.lastSynced) return 1;
                  if (!b.lastSynced) return -1;
                  return (
                      new Date(b.lastSynced).getTime() -
                      new Date(a.lastSynced).getTime()
                  );
              } else {
                  if (a.year == null && b.year == null) return 0;
                  if (a.year == null) return 1;
                  if (b.year == null) return -1;
                  return b.year - a.year;
              }
          });

    // Handle errors - only show toast once, don't auto-navigate
    // The page component should handle displaying a "not found" state
    // Don't call router.back() as it causes navigation loops

    const reloadArtist = () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.artist(id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.artistEnrichment(id) });
    };

    return {
        artist: mergedArtist,
        albums,
        loading: isLoading,
        error: isError,
        source,
        sortBy,
        setSortBy,
        reloadArtist,
    };
}
