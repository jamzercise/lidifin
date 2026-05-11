"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Album, ArtistSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";
import { toAlbumRouteId } from "@/lib/route-ids";
import { usePrefetchAlbum, queryKeys } from "@/hooks/useQueries";

interface AvailableAlbumsProps {
    albums: Album[];
    artistName: string;
    source: ArtistSource;
    colors: ColorPalette | null;
    onDownloadAlbum: (album: Album, e: React.MouseEvent) => void;
    isPendingDownload: (mbid: string) => boolean;
}

function LazyAlbumCard({
    album,
    source,
    colors,
    onDownloadAlbum,
    isPendingDownload,
    onPrefetch,
    index,
    onToggleSavedForLater,
    bookmarkBusyMbid,
}: {
    album: Album;
    source: ArtistSource;
    colors: ColorPalette | null;
    onDownloadAlbum: (album: Album, e: React.MouseEvent) => void;
    isPendingDownload: (mbid: string) => boolean;
    onPrefetch?: () => void;
    index: number;
    onToggleSavedForLater?: (
        album: Album,
        e: React.MouseEvent,
        nextSaved: boolean
    ) => void;
    bookmarkBusyMbid: string | null;
}) {
    const [coverArt, setCoverArt] = useState<string | null>(() => {
        if (source === "library" && album.coverArt) {
            return api.getCoverArtUrl(album.coverArt, 300);
        }
        if (album.coverUrl) {
            return api.getCoverArtUrl(album.coverUrl, 300);
        }
        return null;
    });
    const [fetchAttempted, setFetchAttempted] = useState(false);

    useEffect(() => {
        if (coverArt || fetchAttempted) return;

        const mbid = album.rgMbid || album.mbid;
        if (!mbid || mbid.startsWith("temp-")) return;

        const fetchCover = async () => {
            try {
                const response = await api.request<{ coverUrl: string }>(
                    `/library/album-cover/${mbid}`
                );
                if (response.coverUrl) {
                    setCoverArt(api.getCoverArtUrl(response.coverUrl, 300));
                }
            } catch {
                /* cover optional */
            } finally {
                setFetchAttempted(true);
            }
        };

        const timeoutId = setTimeout(fetchCover, index * 100);
        return () => clearTimeout(timeoutId);
    }, [album, coverArt, fetchAttempted, index]);

    const albumMbid = album.rgMbid || album.mbid || "";
    const canBookmark =
        !!albumMbid &&
        !albumMbid.startsWith("temp-") &&
        !!onToggleSavedForLater;

    const subtitleParts: string[] = [];
    if (album.year) subtitleParts.push(String(album.year));
    if (album.type) subtitleParts.push(album.type);
    const subtitle = subtitleParts.join(" • ");

    return (
        <PlayableCard
            key={album.id}
            href={`/album/${encodeURIComponent(toAlbumRouteId(album))}`}
            onMouseEnter={onPrefetch}
            coverArt={coverArt}
            title={album.title}
            subtitle={subtitle}
            placeholderIcon={<Disc3 className="w-12 h-12 text-gray-600" />}
            circular={false}
            badge="download"
            showPlayButton={false}
            colors={colors}
            isDownloading={isPendingDownload(albumMbid)}
            onDownload={(e) => onDownloadAlbum(album, e)}
            bookmark={
                canBookmark
                    ? {
                          active: !!album.savedForLater,
                          busy: bookmarkBusyMbid === albumMbid,
                          onClick: (e) =>
                              onToggleSavedForLater!(
                                  album,
                                  e,
                                  !album.savedForLater
                              ),
                      }
                    : null
            }
            tvCardIndex={index}
        />
    );
}

function AlbumGrid({
    albums,
    source,
    colors,
    onDownloadAlbum,
    isPendingDownload,
    prefetchAlbum,
    onToggleSavedForLater,
    bookmarkBusyMbid,
}: Omit<AvailableAlbumsProps, "artistName"> & {
    prefetchAlbum: (id: string) => void;
    onToggleSavedForLater?: (
        album: Album,
        e: React.MouseEvent,
        nextSaved: boolean
    ) => void;
    bookmarkBusyMbid: string | null;
}) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {albums.map((album, index) => (
                <LazyAlbumCard
                    key={album.id}
                    album={album}
                    source={source}
                    colors={colors}
                    onDownloadAlbum={onDownloadAlbum}
                    isPendingDownload={isPendingDownload}
                    onPrefetch={() => prefetchAlbum(toAlbumRouteId(album))}
                    index={index}
                    onToggleSavedForLater={onToggleSavedForLater}
                    bookmarkBusyMbid={bookmarkBusyMbid}
                />
            ))}
        </div>
    );
}

export function AvailableAlbums({
    albums,
    artistName,
    source,
    colors,
    onDownloadAlbum,
    isPendingDownload,
}: AvailableAlbumsProps) {
    const params = useParams();
    const artistPageId = params.id as string;
    const queryClient = useQueryClient();
    const prefetchAlbum = usePrefetchAlbum();
    const [bookmarkBusyMbid, setBookmarkBusyMbid] = useState<string | null>(
        null
    );

    const onToggleSavedForLater = useCallback(
        async (album: Album, e: React.MouseEvent, nextSaved: boolean) => {
            e.preventDefault();
            e.stopPropagation();
            const mbid = album.rgMbid || album.mbid;
            if (!mbid || mbid.startsWith("temp-")) return;
            setBookmarkBusyMbid(mbid);
            try {
                if (nextSaved) {
                    await api.saveDiscoveryAlbum({
                        rgMbid: mbid,
                        artistName,
                        albumTitle: album.title,
                        coverUrl: album.coverUrl ?? album.coverArt ?? null,
                        source: "artist-page",
                    });
                    toast.success("Saved for later");
                } else {
                    await api.unsaveDiscoveryAlbum(mbid);
                    toast.success("Removed from saved");
                }
                await queryClient.invalidateQueries({
                    queryKey: queryKeys.artistEnrichment(artistPageId),
                });
                await queryClient.invalidateQueries({
                    queryKey: ["discover", "saved-albums"],
                });
            } catch (err) {
                console.error(err);
                toast.error(
                    nextSaved ? "Could not save album" : "Could not remove save"
                );
            } finally {
                setBookmarkBusyMbid(null);
            }
        },
        [artistName, artistPageId, queryClient]
    );

    if (!albums || albums.length === 0) {
        return null;
    }

    const studioAlbums = albums.filter(
        (album) => album.type?.toLowerCase() === "album"
    );
    const epsAndSingles = albums.filter(
        (album) => album.type?.toLowerCase() !== "album"
    );

    return (
        <>
            {studioAlbums.length > 0 && (
                <section>
                    <h2 className="text-xl font-bold mb-4">Albums Available</h2>
                    <div data-tv-section="available-albums">
                        <AlbumGrid
                            albums={studioAlbums}
                            source={source}
                            colors={colors}
                            onDownloadAlbum={onDownloadAlbum}
                            isPendingDownload={isPendingDownload}
                            prefetchAlbum={prefetchAlbum}
                            onToggleSavedForLater={onToggleSavedForLater}
                            bookmarkBusyMbid={bookmarkBusyMbid}
                        />
                    </div>
                </section>
            )}

            {epsAndSingles.length > 0 && (
                <section>
                    <h2 className="text-xl font-bold mb-4">Singles and EPs</h2>
                    <div data-tv-section="available-eps-singles">
                        <AlbumGrid
                            albums={epsAndSingles}
                            source={source}
                            colors={colors}
                            onDownloadAlbum={onDownloadAlbum}
                            isPendingDownload={isPendingDownload}
                            prefetchAlbum={prefetchAlbum}
                            onToggleSavedForLater={onToggleSavedForLater}
                            bookmarkBusyMbid={bookmarkBusyMbid}
                        />
                    </div>
                </section>
            )}
        </>
    );
}
