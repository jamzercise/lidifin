"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { formatTime } from "@/utils/formatTime";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
    ArrowLeft,
    Check,
    X,
    Download,
    Loader2,
    ExternalLink,
    ChevronDown,
    ChevronUp,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import {
    useActiveImports,
    isImportFinished,
    importStatusLabel,
    type ImportStatus,
} from "@/hooks/useActiveImports";
import {
    EditableTrackRow,
    type TrackEdit,
} from "@/features/import/components/EditableTrackRow";

// Deezer icon
const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

// YouTube Music icon (official red #FF0000 per YouTube branding guidelines)
const YouTubeMusicIcon = ({ className }: { className?: string }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
    >
        <path
            d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0z"
            fill="#FF0000"
        />
        <path d="M10 8l6 4-6 4V8z" fill="white" />
    </svg>
);

// Types for Spotify Import
interface SpotifyTrack {
    spotifyId: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    isrc: string | null;
    durationMs: number;
    trackNumber: number;
    previewUrl: string | null;
    coverUrl: string | null;
}

interface MatchedTrack {
    spotifyTrack: SpotifyTrack;
    localTrack: {
        id: string;
        title: string;
        albumId: string;
        albumTitle: string;
        artistName: string;
    } | null;
    matchType: "exact" | "fuzzy" | "none";
    matchConfidence: number;
}

interface AlbumToDownload {
    spotifyAlbumId: string;
    albumName: string;
    artistName: string;
    artistMbid: string | null;
    albumMbid: string | null;
    coverUrl: string | null;
    trackCount: number;
    tracksNeeded: SpotifyTrack[];
}

type PlaylistSource = "spotify" | "deezer" | "youtube-music";

interface ImportPreview {
    source?: PlaylistSource;
    playlist: {
        id: string;
        name: string;
        description: string | null;
        owner: string;
        imageUrl: string | null;
        trackCount: number;
    };
    matchedTracks: MatchedTrack[];
    albumsToDownload: AlbumToDownload[];
    summary: {
        total: number;
        inLibrary: number;
        downloadable: number;
        notFound: number;
    };
}

interface ImportJob {
    id: string;
    status: ImportStatus;
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number;
    createdPlaylistId: string | null;
    error: string | null;
}

type Step = "input" | "preview" | "importing" | "complete";

function SpotifyImportPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const hasAutoFetched = useRef(false);
    // Which job the ?job= param has already been resolved for. Keyed by id
    // rather than a flag because navigating from the Activity panel swaps the
    // param without remounting this page.
    const restoredJobId = useRef<string | null>(null);
    const {
        imports: activeImports,
        forget: forgetActiveImport,
        refetch: refetchActiveImports,
    } = useActiveImports();

    // State
    const [step, setStep] = useState<Step>("input");
    const [url, setUrl] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [selectedAlbums, setSelectedAlbums] = useState<Set<string>>(
        new Set()
    );
    const [playlistName, setPlaylistName] = useState("");
    const [importJob, setImportJob] = useState<ImportJob | null>(null);
    const [refreshStatusMessage, setRefreshStatusMessage] = useState<
        string | null
    >(null);
    const [expandedSection, setExpandedSection] = useState<
        "matched" | "download" | null
    >("matched");
    // Corrections the user has made, keyed by source track id. Sent with the
    // re-check and with the import so the backend applies them before matching.
    const [trackEdits, setTrackEdits] = useState<Record<string, TrackEdit>>({});
    const [expandedAlbums, setExpandedAlbums] = useState<Set<string>>(
        new Set()
    );
    const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
    const [isRechecking, setIsRechecking] = useState(false);
    // Which corrections the preview on screen was actually built with, so we can
    // tell when what's displayed no longer reflects the pending edits.
    const [previewEditSignature, setPreviewEditSignature] = useState("[]");

    // Adopt a freshly fetched preview, dropping anything tied to whatever
    // playlist was loaded before it.
    const applyFreshPreview = useCallback((result: ImportPreview) => {
        setPreview(result);
        setPlaylistName(result.playlist.name);
        // Select every album: Soulseek can search for any track, even without an
        // MBID, so nothing is inherently unavailable.
        setSelectedAlbums(
            new Set(
                result.albumsToDownload.map(
                    (a) => a.albumMbid || a.spotifyAlbumId
                )
            )
        );
        setTrackEdits({});
        setPreviewEditSignature("[]");
        setExpandedAlbums(new Set());
        setEditingTrackId(null);
        setStep("preview");
    }, []);

    // Pick a job back up when the page is loaded with one in the URL. This is
    // what makes a refresh mid-import land back on the progress view instead of
    // an empty form, and it's the target of the Activity panel's import links.
    useEffect(() => {
        const jobParam = searchParams.get("job");
        if (!jobParam || restoredJobId.current === jobParam) return;
        restoredJobId.current = jobParam;

        (async () => {
            try {
                const job = await api.get<ImportJob>(
                    `/spotify/import/${jobParam}/status`
                );
                setImportJob(job);
                setStep(isImportFinished(job.status) ? "complete" : "importing");
            } catch {
                // Job is gone, or belongs to someone else. Leave the user on the
                // input step rather than showing an error for a stale link.
            }
        })();
    }, [searchParams]);

    // Auto-fetch preview if URL is provided in query params
    useEffect(() => {
        const urlParam = searchParams.get("url");
        if (urlParam && !hasAutoFetched.current && !searchParams.get("job")) {
            hasAutoFetched.current = true;
            setUrl(urlParam);
            // Auto-trigger preview fetch
            (async () => {
                setIsLoading(true);
                try {
                    const result = await api.post<ImportPreview>(
                        "/spotify/preview",
                        {
                            url: urlParam,
                        }
                    );
                    applyFreshPreview(result);
                } catch (err) {
                    const message =
                        err instanceof Error
                            ? err.message
                            : "Failed to fetch playlist";
                    toast.error(message);
                } finally {
                    setIsLoading(false);
                }
            })();
        }
    }, [searchParams, toast, applyFreshPreview]);

    // Only the id and liveness matter here; depending on the whole job object
    // would tear down and rebuild the interval on every poll.
    const pollingJobId =
        importJob && !isImportFinished(importJob.status) ? importJob.id : null;

    // In-flight imports other than the one this page is already showing.
    const otherActiveImports = activeImports.filter(
        (job) => job.id !== importJob?.id
    );

    const editList = Object.values(trackEdits);
    const editSignature = JSON.stringify(
        editList
            .map((e) => [e.spotifyId, e.artist, e.title, e.album])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
    // True while the preview on screen was built from a different set of
    // corrections than the ones currently pending.
    const hasUncheckedEdits = editSignature !== previewEditSignature;

    // Poll for import job status
    useEffect(() => {
        if (!pollingJobId) return;

        const interval = setInterval(async () => {
            try {
                const job = await api.get<ImportJob>(
                    `/spotify/import/${pollingJobId}/status`
                );
                setImportJob(job);

                if (isImportFinished(job.status)) {
                    setStep("complete");
                    // Drop it from the shared cache so the Activity panel stops
                    // advertising it as in-flight before its next poll.
                    forgetActiveImport(pollingJobId);
                    window.dispatchEvent(
                        new CustomEvent("notifications-changed")
                    );
                    if (job.status !== "failed") {
                        window.dispatchEvent(
                            new CustomEvent("playlist-created")
                        );
                    }
                }
            } catch (err) {
                console.error("Failed to poll job status:", err);
            }
        }, 2000);

        return () => clearInterval(interval);
    }, [pollingJobId, forgetActiveImport]);

    // Handle URL paste/change
    const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setUrl(e.target.value);
    };

    // Fetch preview
    const handleFetchPreview = async () => {
        if (!url.trim()) {
            toast.error("Please enter a playlist URL");
            return;
        }

        setIsLoading(true);
        try {
            const result = await api.post<ImportPreview>("/spotify/preview", {
                url,
            });
            applyFreshPreview(result);
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to fetch playlist";
            toast.error(message);
        } finally {
            setIsLoading(false);
        }
    };

    // Start import
    const handleStartImport = async () => {
        if (!preview) return;

        setIsLoading(true);
        setRefreshStatusMessage(null);
        try {
            const response = await api.post<{ jobId: string; status: string }>(
                "/spotify/import",
                {
                    spotifyPlaylistId: preview.playlist.id,
                    url,
                    playlistName: playlistName || preview.playlist.name,
                    albumMbidsToDownload: Array.from(selectedAlbums),
                    trackEdits: editList,
                }
            );

            setImportJob({
                id: response.jobId,
                status: "pending",
                progress: 0,
                albumsTotal: selectedAlbums.size,
                albumsCompleted: 0,
                tracksMatched: preview.summary.inLibrary,
                tracksTotal: preview.summary.total,
                tracksDownloadable: preview.summary.downloadable,
                createdPlaylistId: null,
                error: null,
            });
            setStep("importing");

            // Put the job in the URL so a refresh comes back to this progress
            // view, and let the Activity panel know about it immediately.
            restoredJobId.current = response.jobId;
            router.replace(
                `/import/spotify?job=${encodeURIComponent(response.jobId)}`,
                { scroll: false }
            );
            refetchActiveImports();
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to start import";
            toast.error(message);
        } finally {
            setIsLoading(false);
        }
    };

    const toggleAlbumExpanded = (albumKey: string) => {
        setExpandedAlbums((prev) => {
            const next = new Set(prev);
            if (next.has(albumKey)) {
                next.delete(albumKey);
            } else {
                next.add(albumKey);
            }
            return next;
        });
    };

    const saveTrackEdit = (
        track: SpotifyTrack,
        values: { artist: string; title: string; album: string },
        groupTracks: SpotifyTrack[],
        applyAlbumToGroup: boolean
    ) => {
        setTrackEdits((prev) => {
            const next = { ...prev };
            next[track.spotifyId] = {
                spotifyId: track.spotifyId,
                artist: values.artist.trim(),
                title: values.title.trim(),
                album: values.album.trim(),
            };

            if (applyAlbumToGroup) {
                // Fixing one track's album usually means the whole group was
                // labelled wrong, so carry it across without touching titles.
                for (const sibling of groupTracks) {
                    if (sibling.spotifyId === track.spotifyId) continue;
                    const existing = next[sibling.spotifyId];
                    next[sibling.spotifyId] = {
                        spotifyId: sibling.spotifyId,
                        artist: existing?.artist ?? sibling.artist,
                        title: existing?.title ?? sibling.title,
                        album: values.album.trim(),
                    };
                }
            }

            return next;
        });
        setEditingTrackId(null);
    };

    const revertTrackEdit = (spotifyId: string) => {
        setTrackEdits((prev) => {
            const next = { ...prev };
            delete next[spotifyId];
            return next;
        });
    };

    // Re-run the preview with the corrections applied so the user can see
    // whether a fix actually found the track before committing to an import.
    const handleRecheckMatches = async () => {
        if (!preview) return;

        const signatureForThisRun = editSignature;
        setIsRechecking(true);
        try {
            const result = await api.post<ImportPreview>("/spotify/preview", {
                url:
                    url ||
                    `https://open.spotify.com/playlist/${preview.playlist.id}`,
                trackEdits: editList,
            });
            setPreview(result);
            setSelectedAlbums(
                new Set(
                    result.albumsToDownload.map(
                        (a) => a.albumMbid || a.spotifyAlbumId
                    )
                )
            );
            setEditingTrackId(null);
            setPreviewEditSignature(signatureForThisRun);
            toast.success(
                `${result.summary.inLibrary} of ${result.summary.total} songs now match your library`
            );
        } catch (err) {
            const message =
                err instanceof Error
                    ? err.message
                    : "Failed to re-check matches";
            toast.error(message);
        } finally {
            setIsRechecking(false);
        }
    };

    // Toggle album selection
    const toggleAlbum = (albumMbid: string) => {
        setSelectedAlbums((prev) => {
            const next = new Set(prev);
            if (next.has(albumMbid)) {
                next.delete(albumMbid);
            } else {
                next.add(albumMbid);
            }
            return next;
        });
    };

    // Select/deselect all albums
    const toggleAllAlbums = () => {
        if (!preview) return;

        // All albums are downloadable via Soulseek (even without MBID)
        const allAlbumIds = preview.albumsToDownload.map(
            (a) => a.albumMbid || a.spotifyAlbumId
        );

        if (selectedAlbums.size === allAlbumIds.length) {
            setSelectedAlbums(new Set());
        } else {
            setSelectedAlbums(new Set(allAlbumIds));
        }
    };

    // Cancel import
    const [isCancelling, setIsCancelling] = useState(false);
    const handleCancelImport = async () => {
        if (!importJob) return;

        setIsCancelling(true);
        try {
            await api.post<{
                message: string;
                playlistId: string | null;
                tracksMatched: number;
            }>(`/spotify/import/${importJob.id}/cancel`, {});

            setImportJob((prev) =>
                prev
                    ? {
                          ...prev,
                          status: "cancelled",
                          createdPlaylistId: null,
                          tracksMatched: 0,
                      }
                    : prev
            );
            setStep("complete");
            forgetActiveImport(importJob.id);

            // Only dispatch notifications-changed, not playlist-created since no playlist was made
            window.dispatchEvent(new CustomEvent("notifications-changed"));
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to cancel import";
            toast.error(message);
        } finally {
            setIsCancelling(false);
        }
    };


    return (
        <div className="min-h-screen relative">
            {/* Quick gradient fade - yellow to purple like home page */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-linear-to-b from-[#B1D2C3]/15 via-purple-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#B1D2C3]/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            <div className="relative max-w-3xl mx-auto px-6 py-6">
                {/* Header */}
                <div className="flex items-center gap-4 mb-6">
                    <button
                        onClick={() => router.back()}
                        className="p-2 hover:bg-white/5 rounded-full transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5 text-gray-400" />
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-white">
                            Import Playlist
                        </h1>
                        <p className="text-sm text-gray-400">
                            Import from Spotify or Deezer and download missing
                            albums
                        </p>
                    </div>
                </div>

                {/* Imports running that aren't the one on screen, so leaving and
                    coming back doesn't make them vanish */}
                {otherActiveImports.length > 0 && (
                    <div className="mb-6 space-y-2">
                        {otherActiveImports.map((job) => (
                            <div
                                key={job.id}
                                className="flex items-center gap-3 p-3 rounded-lg bg-[#B1D2C3]/10 border border-[#B1D2C3]/20"
                            >
                                <Loader2 className="w-4 h-4 text-[#B1D2C3] animate-spin shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm text-white truncate">
                                        {job.playlistName}
                                    </p>
                                    <p className="text-xs text-gray-400">
                                        {importStatusLabel(job.status)} •{" "}
                                        {job.progress}%
                                    </p>
                                </div>
                                <Link
                                    href={`/import/spotify?job=${encodeURIComponent(
                                        job.id
                                    )}`}
                                    className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-[#B1D2C3] text-black hover:brightness-110 transition-all"
                                >
                                    View
                                </Link>
                            </div>
                        ))}
                    </div>
                )}

                {/* Browse Link */}
                <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                    <p className="text-sm text-gray-300">
                        Looking for playlists to import?{" "}
                        <Link
                            href="/browse/playlists"
                            className="text-[#B1D2C3] hover:underline font-medium"
                        >
                            Browse Deezer playlists, or paste a Spotify/YouTube Music URL above →
                        </Link>
                    </p>
                </div>

                {/* Step: Input */}
                {step === "input" && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Playlist URL
                            </label>
                            <input
                                type="text"
                                value={url}
                                onChange={handleUrlChange}
                                placeholder="Deezer, Spotify, or YouTube Music playlist URL"
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#B1D2C3]/50 focus:border-[#B1D2C3] transition-colors"
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleFetchPreview()
                                }
                            />
                            <p className="text-xs text-gray-500 mt-2">
                                Paste a public{" "}
                                <span className="text-[#AD47FF]">Deezer</span>,{" "}
                                <span className="text-[#1DB954]">Spotify</span>, or{" "}
                                <span className="text-[#FF0000]">YouTube Music</span>{" "}
                                playlist URL
                            </p>
                        </div>
                        <button
                            onClick={handleFetchPreview}
                            disabled={isLoading || !url.trim()}
                            className="w-full py-3 rounded-full font-medium bg-[#B1D2C3] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                        >
                            {isLoading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Loading...
                                </>
                            ) : (
                                "Continue"
                            )}
                        </button>
                    </div>
                )}

                {/* Step: Preview */}
                {step === "preview" && preview && (
                    <div className="space-y-4">
                        {/* Playlist Info */}
                        <div className="flex items-start gap-4 p-4 bg-white/5 rounded-lg">
                            {preview.playlist.imageUrl ? (
                                <div className="relative w-20 h-20">
                                    <Image
                                        src={preview.playlist.imageUrl}
                                        alt={preview.playlist.name}
                                        fill
                                        sizes="80px"
                                        className="rounded-md object-cover"
                                        unoptimized
                                    />
                                </div>
                            ) : (
                                <div className="w-20 h-20 rounded-md bg-white/10 flex items-center justify-center">
                                    {preview.source === "youtube-music" ? (
                                        <YouTubeMusicIcon className="w-10 h-10" />
                                    ) : preview.source === "deezer" ? (
                                        <DeezerIcon className="w-10 h-10 text-[#AD47FF]" />
                                    ) : (
                                        <Image
                                            src="/assets/images/SpotIcon.png"
                                            alt="Spotify"
                                            width={32}
                                            height={32}
                                        />
                                    )}
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
                                <h2 className="text-lg font-bold text-white truncate">
                                    {preview.playlist.name}
                                </h2>
                                <p className="text-sm text-gray-400">
                                    {preview.playlist.owner} ·{" "}
                                    {preview.playlist.trackCount} songs
                                    {preview.source && (
                                        <span className="ml-2">
                                            {preview.source === "youtube-music" && (
                                                <span className="inline-flex items-center gap-1 text-[#FF0000]">
                                                    <YouTubeMusicIcon className="w-3.5 h-3.5" />
                                                    YouTube Music
                                                </span>
                                            )}
                                            {preview.source === "deezer" && (
                                                <span className="text-[#AD47FF]">Deezer</span>
                                            )}
                                            {preview.source === "spotify" && (
                                                <span className="text-[#1DB954]">Spotify</span>
                                            )}
                                        </span>
                                    )}
                                </p>
                                {preview.playlist.description && (
                                    <p className="text-sm text-gray-500 mt-1 line-clamp-1">
                                        {preview.playlist.description}
                                    </p>
                                )}
                            </div>
                            <a
                                href={
                                    url ||
                                    (preview.source === "youtube-music"
                                        ? `https://music.youtube.com/playlist?list=${preview.playlist.id}`
                                        : preview.source === "deezer"
                                        ? `https://www.deezer.com/playlist/${preview.playlist.id}`
                                        : `https://open.spotify.com/playlist/${preview.playlist.id}`)
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                className={`text-gray-400 transition-colors ${
                                    preview.source === "youtube-music"
                                        ? "hover:text-[#FF0000]"
                                        : preview.source === "deezer"
                                        ? "hover:text-[#AD47FF]"
                                        : "hover:text-[#1DB954]"
                                }`}
                                aria-label={`Open in ${preview.source === "youtube-music" ? "YouTube Music" : preview.source === "deezer" ? "Deezer" : "Spotify"}`}
                            >
                                <ExternalLink className="w-4 h-4" />
                            </a>
                        </div>

                        {/* Summary Stats */}
                        <div className="grid grid-cols-4 gap-3">
                            <div className="text-center py-3 bg-white/5 rounded-lg">
                                <div className="text-xl font-bold text-white">
                                    {preview.summary.total}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Total
                                </div>
                            </div>
                            <div className="text-center py-3 bg-green-500/10 rounded-lg">
                                <div className="text-xl font-bold text-green-400">
                                    {preview.summary.inLibrary}
                                </div>
                                <div className="text-xs text-gray-500">
                                    In Library
                                </div>
                            </div>
                            <div className="text-center py-3 bg-[#1DB954]/10 rounded-lg">
                                <div className="text-xl font-bold text-[#1DB954]">
                                    {preview.albumsToDownload.length}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Albums to get
                                </div>
                            </div>
                            <div className="text-center py-3 bg-[#1DB954]/10 rounded-lg">
                                <div className="text-xl font-bold text-[#1DB954]">
                                    {preview.summary.downloadable}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Songs to get
                                </div>
                            </div>
                        </div>

                        {/* Corrections the displayed preview doesn't reflect yet */}
                        {hasUncheckedEdits && (
                            <div className="flex items-center gap-3 p-3 rounded-lg bg-[#B1D2C3]/10 border border-[#B1D2C3]/20">
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-white">
                                        {editList.length > 0
                                            ? `${editList.length} correction${
                                                  editList.length === 1
                                                      ? ""
                                                      : "s"
                                              } not applied to what's shown`
                                            : "Corrections removed"}
                                    </p>
                                    <p className="text-xs text-gray-400">
                                        Re-check to see what they match. The
                                        import uses them either way.
                                    </p>
                                </div>
                                <button
                                    onClick={handleRecheckMatches}
                                    disabled={isRechecking}
                                    className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-[#B1D2C3] text-black hover:brightness-110 disabled:opacity-50 transition-all inline-flex items-center gap-1.5"
                                >
                                    {isRechecking ? (
                                        <>
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            Re-checking...
                                        </>
                                    ) : (
                                        "Re-check matches"
                                    )}
                                </button>
                            </div>
                        )}

                        {/* Tracks already in library */}
                        {preview.summary.inLibrary > 0 && (
                            <div className="bg-white/5 rounded-lg overflow-hidden">
                                <button
                                    onClick={() =>
                                        setExpandedSection(
                                            expandedSection === "matched"
                                                ? null
                                                : "matched"
                                        )
                                    }
                                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <Check className="w-4 h-4 text-green-400" />
                                        <span className="text-sm font-medium text-white">
                                            {preview.summary.inLibrary} songs in
                                            your library
                                        </span>
                                    </div>
                                    {expandedSection === "matched" ? (
                                        <ChevronUp className="w-4 h-4 text-gray-500" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-gray-500" />
                                    )}
                                </button>
                                {expandedSection === "matched" && (
                                    <div className="border-t border-white/5 max-h-48 overflow-y-auto">
                                        {preview.matchedTracks
                                            .filter((m) => m.localTrack)
                                            .map((match, i) => (
                                                <div
                                                    key={
                                                        match.spotifyTrack
                                                            .spotifyId
                                                    }
                                                    className="flex items-center gap-3 px-4 py-2 hover:bg-white/5"
                                                >
                                                    <span className="text-xs text-gray-600 w-5 text-right">
                                                        {i + 1}
                                                    </span>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm text-white truncate">
                                                            {match.localTrack
                                                                ?.title ||
                                                                match
                                                                    .spotifyTrack
                                                                    .title}
                                                        </div>
                                                        <div className="text-xs text-gray-500 truncate">
                                                            {match.localTrack
                                                                ?.artistName ||
                                                                match
                                                                    .spotifyTrack
                                                                    .artist}
                                                        </div>
                                                    </div>
                                                    <span className="text-xs text-gray-600">
                                                        {formatTime(
                                                            Math.round(match.spotifyTrack
                                                                .durationMs / 1000)
                                                        )}
                                                    </span>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Albums to download */}
                        {preview.albumsToDownload.length > 0 && (
                            <div className="bg-white/5 rounded-lg overflow-hidden">
                                <button
                                    onClick={() =>
                                        setExpandedSection(
                                            expandedSection === "download"
                                                ? null
                                                : "download"
                                        )
                                    }
                                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <Download className="w-4 h-4 text-[#1DB954]" />
                                        <span className="text-sm font-medium text-white">
                                            {preview.albumsToDownload.length}{" "}
                                            albums to download
                                        </span>
                                        <span className="text-xs text-gray-500">
                                            — expand to fix details
                                        </span>
                                    </div>
                                    {expandedSection === "download" ? (
                                        <ChevronUp className="w-4 h-4 text-gray-500" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-gray-500" />
                                    )}
                                </button>
                                {expandedSection === "download" && (
                                    <div className="border-t border-white/5">
                                        <div className="flex items-center justify-between px-4 py-2 bg-black/20">
                                            <button
                                                onClick={toggleAllAlbums}
                                                className="text-xs text-[#1DB954] hover:underline"
                                            >
                                                {selectedAlbums.size ===
                                                preview.albumsToDownload.length
                                                    ? "Deselect All"
                                                    : "Select All"}
                                            </button>
                                            <span className="text-xs text-gray-500">
                                                {selectedAlbums.size} selected
                                            </span>
                                        </div>
                                        <div
                                            role="group"
                                            aria-label="Albums to download"
                                            className="max-h-96 overflow-y-auto"
                                        >
                                            {preview.albumsToDownload.map(
                                                (album, index) => {
                                                    const albumKey =
                                                        album.albumMbid ||
                                                        album.spotifyAlbumId;
                                                    const rowKey =
                                                        albumKey ||
                                                        `album-${index}`;
                                                    const isExpanded =
                                                        expandedAlbums.has(
                                                            rowKey
                                                        );
                                                    const editedCount =
                                                        album.tracksNeeded.filter(
                                                            (t) =>
                                                                trackEdits[
                                                                    t.spotifyId
                                                                ]
                                                        ).length;

                                                    return (
                                                        <div
                                                            key={rowKey}
                                                            className="border-b border-white/5 last:border-0"
                                                        >
                                                            <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/5">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={selectedAlbums.has(
                                                                        albumKey
                                                                    )}
                                                                    onChange={() =>
                                                                        toggleAlbum(
                                                                            albumKey
                                                                        )
                                                                    }
                                                                    aria-label={`Download ${album.albumName} by ${album.artistName}`}
                                                                    className="w-4 h-4 rounded border-white/20 bg-transparent text-[#1DB954] focus:ring-[#1DB954] focus:ring-offset-0"
                                                                />
                                                                {album.coverUrl && (
                                                                    <div className="relative w-10 h-10 shrink-0">
                                                                        <Image
                                                                            src={album.coverUrl}
                                                                            alt={album.albumName}
                                                                            fill
                                                                            sizes="40px"
                                                                            className="rounded object-cover"
                                                                            unoptimized
                                                                        />
                                                                    </div>
                                                                )}
                                                                <button
                                                                    onClick={() =>
                                                                        toggleAlbumExpanded(
                                                                            rowKey
                                                                        )
                                                                    }
                                                                    aria-expanded={
                                                                        isExpanded
                                                                    }
                                                                    className="flex-1 min-w-0 flex items-center gap-2 text-left"
                                                                >
                                                                    <span className="flex-1 min-w-0">
                                                                        <span className="block text-sm text-white truncate">
                                                                            {
                                                                                album.albumName
                                                                            }
                                                                        </span>
                                                                        <span className="block text-xs text-gray-500 truncate">
                                                                            {
                                                                                album.artistName
                                                                            }{" "}
                                                                            ·{" "}
                                                                            {
                                                                                album.tracksNeeded
                                                                                    .length
                                                                            }{" "}
                                                                            songs
                                                                            needed
                                                                            {editedCount >
                                                                                0 && (
                                                                                <span className="text-[#B1D2C3]">
                                                                                    {" "}
                                                                                    ·{" "}
                                                                                    {
                                                                                        editedCount
                                                                                    }{" "}
                                                                                    edited
                                                                                </span>
                                                                            )}
                                                                        </span>
                                                                    </span>
                                                                    {isExpanded ? (
                                                                        <ChevronUp className="w-4 h-4 text-gray-500 shrink-0" />
                                                                    ) : (
                                                                        <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
                                                                    )}
                                                                </button>
                                                            </div>

                                                            {isExpanded && (
                                                                <div className="bg-black/20 border-t border-white/5">
                                                                    {album.tracksNeeded.map(
                                                                        (
                                                                            trackNeeded
                                                                        ) => (
                                                                            <EditableTrackRow
                                                                                key={
                                                                                    trackNeeded.spotifyId
                                                                                }
                                                                                track={
                                                                                    trackNeeded
                                                                                }
                                                                                albumTrackCount={
                                                                                    album
                                                                                        .tracksNeeded
                                                                                        .length
                                                                                }
                                                                                isEdited={Boolean(
                                                                                    trackEdits[
                                                                                        trackNeeded
                                                                                            .spotifyId
                                                                                    ]
                                                                                )}
                                                                                isEditing={
                                                                                    editingTrackId ===
                                                                                    trackNeeded.spotifyId
                                                                                }
                                                                                onStartEdit={() =>
                                                                                    setEditingTrackId(
                                                                                        trackNeeded.spotifyId
                                                                                    )
                                                                                }
                                                                                onCancelEdit={() =>
                                                                                    setEditingTrackId(
                                                                                        null
                                                                                    )
                                                                                }
                                                                                onSave={(
                                                                                    values,
                                                                                    applyAlbumToGroup
                                                                                ) =>
                                                                                    saveTrackEdit(
                                                                                        trackNeeded,
                                                                                        values,
                                                                                        album.tracksNeeded,
                                                                                        applyAlbumToGroup
                                                                                    )
                                                                                }
                                                                                onRevert={() =>
                                                                                    revertTrackEdit(
                                                                                        trackNeeded.spotifyId
                                                                                    )
                                                                                }
                                                                            />
                                                                        )
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                }
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Playlist name input */}
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Playlist Name
                            </label>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(e) =>
                                    setPlaylistName(e.target.value)
                                }
                                placeholder="Enter playlist name"
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#1DB954]/50 focus:border-[#1DB954] transition-colors"
                            />
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-3 pt-2">
                            <button
                                onClick={() => {
                                    setStep("input");
                                    setPreview(null);
                                }}
                                className="px-6 py-3 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Back
                            </button>
                            <button
                                onClick={handleStartImport}
                                disabled={
                                    isLoading ||
                                    (preview.summary.inLibrary === 0 &&
                                        selectedAlbums.size === 0)
                                }
                                className="flex-1 py-3 rounded-full font-medium bg-[#1DB954] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Starting...
                                    </>
                                ) : preview.summary.inLibrary > 0 &&
                                  selectedAlbums.size > 0 ? (
                                    `Import ${preview.summary.inLibrary} songs + Download ${selectedAlbums.size} albums`
                                ) : preview.summary.inLibrary > 0 ? (
                                    `Import ${preview.summary.inLibrary} songs`
                                ) : selectedAlbums.size > 0 ? (
                                    `Download ${selectedAlbums.size} albums`
                                ) : (
                                    "Select albums to download"
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {/* Step: Importing */}
                {step === "importing" && importJob && (
                    <div className="text-center py-12">
                        <Loader2 className="w-10 h-10 text-[#1DB954] animate-spin mx-auto mb-4" />
                        <h2 className="text-lg font-bold text-white mb-1">
                            {importJob.status === "downloading"
                                ? "Queueing Album Downloads"
                                : importJob.status === "scanning"
                                ? "Scanning Library"
                                : importJob.status === "creating_playlist" ||
                                  importJob.status === "matching_tracks"
                                ? "Creating Playlist"
                                : importJob.status === "pending"
                                ? "Waiting for Downloads"
                                : "Starting Import"}
                        </h2>
                        <p className="text-sm text-gray-400 mb-6">
                            {importJob.status === "downloading" && (
                                <>
                                    Queued {importJob.albumsCompleted} of{" "}
                                    {importJob.albumsTotal} albums
                                </>
                            )}
                            {importJob.status === "pending" && (
                                <>
                                    Waiting for{" "}
                                    {importJob.albumsTotal -
                                        importJob.albumsCompleted}{" "}
                                    downloads to complete
                                </>
                            )}
                            {importJob.status === "scanning" && (
                                <>Importing downloaded files into library</>
                            )}
                            {(importJob.status === "creating_playlist" ||
                                importJob.status === "matching_tracks") && (
                                <>Adding {importJob.tracksMatched} songs</>
                            )}
                        </p>
                        <div className="w-full max-w-xs mx-auto bg-white/10 rounded-full h-1.5">
                            <div
                                className="bg-[#1DB954] h-1.5 rounded-full transition-all duration-500"
                                style={{ width: `${importJob.progress}%` }}
                            />
                        </div>
                        <p className="text-xs text-gray-500 mt-3">
                            {importJob.progress}% complete • downloads continue
                            in the background
                        </p>
                        {/* Cancel button */}
                        <button
                            onClick={handleCancelImport}
                            disabled={isCancelling}
                            className="mt-6 px-5 py-2 rounded-full text-sm font-medium text-gray-400 hover:text-white hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-50"
                        >
                            {isCancelling ? (
                                <>
                                    <Loader2 className="w-3 h-3 animate-spin inline mr-2" />
                                    Cancelling...
                                </>
                            ) : (
                                "Cancel Import"
                            )}
                        </button>
                        <p className="text-xs text-gray-600 mt-2">
                            Playlist will be created with tracks downloaded so
                            far
                        </p>
                    </div>
                )}

                {/* Step: Complete */}
                {step === "complete" && importJob && (
                    <div className="text-center py-12">
                        <div
                            className={
                                "w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 " +
                                (importJob.status === "failed"
                                    ? "bg-red-500"
                                    : importJob.status === "cancelled"
                                    ? "bg-amber-500"
                                    : "bg-[#1DB954]")
                            }
                        >
                            {importJob.status === "failed" || importJob.status === "cancelled" ? (
                                <X className="w-7 h-7 text-white" />
                            ) : (
                                <Check className="w-7 h-7 text-black" />
                            )}
                        </div>

                        <h2 className="text-lg font-bold text-white mb-1">
                            {importJob.status === "failed"
                                ? "Import Failed"
                                : importJob.status === "cancelled"
                                ? "Import Cancelled"
                                : "Import Complete"}
                        </h2>

                        {importJob.status === "failed" ? (
                            <p className="text-sm text-gray-400">
                                {importJob.error ||
                                    "Something went wrong while importing."}
                            </p>
                        ) : importJob.status === "cancelled" ? (
                            <p className="text-sm text-gray-400">
                                Import was cancelled. No playlist was created.
                            </p>
                        ) : (
                            <>
                                <p className="text-sm text-gray-400">
                                    {importJob.tracksMatched > 0
                                        ? `Added ${importJob.tracksMatched} songs to your playlist`
                                        : "Playlist created (songs still downloading)"}
                                </p>
                                {importJob.tracksDownloadable > 0 &&
                                    importJob.tracksMatched < importJob.tracksTotal && (
                                        <p className="text-sm text-amber-400 mt-2">
                                            {importJob.tracksDownloadable} songs still
                                            downloading
                                        </p>
                                    )}
                            </>
                        )}
                        <div className="flex items-center justify-center gap-3 mt-6">
                            <button
                                onClick={() => {
                                    setStep("input");
                                    setUrl("");
                                    setPreview(null);
                                    setImportJob(null);
                                    setRefreshStatusMessage(null);
                                    // Drop ?job= so a refresh doesn't drag the
                                    // finished import back onto the screen.
                                    router.replace("/import/spotify", {
                                        scroll: false,
                                    });
                                }}
                                className="px-5 py-2.5 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Import Another
                            </button>
                            {importJob.tracksDownloadable > 0 &&
                                importJob.tracksMatched <
                                    importJob.tracksTotal && (
                                    <button
                                        onClick={async () => {
                                            try {
                                                setIsLoading(true);
                                                setRefreshStatusMessage(null);
                                                const result = await api.post<{
                                                    added: number;
                                                    total: number;
                                                }>(
                                                    `/spotify/import/${importJob.id}/refresh`,
                                                    {}
                                                );
                                                if (result.added > 0) {
                                                    setRefreshStatusMessage(
                                                        `Added ${result.added} new song(s).`
                                                    );
                                                    setImportJob((prev) =>
                                                        prev
                                                            ? {
                                                                  ...prev,
                                                                  tracksMatched:
                                                                      result.total,
                                                              }
                                                            : prev
                                                    );
                                                } else {
                                                    setRefreshStatusMessage(
                                                        "Albums still downloading. Try again later."
                                                    );
                                                }
                                            } catch {
                                                setRefreshStatusMessage(
                                                    "Failed to refresh."
                                                );
                                            } finally {
                                                setIsLoading(false);
                                            }
                                        }}
                                        disabled={isLoading}
                                        className="px-5 py-2.5 rounded-full text-sm font-medium bg-#0a0a0a text-white hover:bg-white/20 disabled:opacity-50 transition-colors"
                                    >
                                        {isLoading
                                            ? "Refreshing..."
                                            : "Refresh"}
                                    </button>
                                )}
                            {refreshStatusMessage && (
                                <p className="text-xs text-gray-500 mt-3">
                                    {refreshStatusMessage}
                                </p>
                            )}
                            {importJob.createdPlaylistId && (
                                <button
                                    onClick={() =>
                                        router.push(
                                            `/playlist/${importJob.createdPlaylistId}`
                                        )
                                    }
                                    className="px-5 py-2.5 rounded-full text-sm font-medium bg-[#1DB954] text-black hover:brightness-110 transition-all"
                                >
                                    View Playlist
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function SpotifyImportPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-[#B1D2C3] animate-spin" />
                </div>
            }
        >
            <SpotifyImportPageContent />
        </Suspense>
    );
}
