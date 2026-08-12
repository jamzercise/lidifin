/**
 * Per-track view of a playlist import.
 *
 * An import job only records totals — "12 of 40 matched", "downloading" — which
 * is no help when one album's download stalls and takes the whole import with
 * it. The underlying state is already there: each track either matched the
 * library during preview, or it waits on the download job for its album. This
 * module joins those together so the UI can show where every track stands and
 * offer to abandon the one that is holding everything up.
 */

/**
 * Where a single track stands in an import.
 */
export type ImportTrackState =
    /** Matched an existing library track during preview; nothing to download. */
    | "in_library"
    /** Its album downloaded successfully. */
    | "downloaded"
    /** Its album is being fetched right now. */
    | "downloading"
    /** Its album download is queued but hasn't started. */
    | "queued"
    /** Its album download failed or was skipped. */
    | "download_failed"
    /** Nothing was ever queued for it, so it can't arrive on its own. */
    | "no_source"
    /** The import finished but this track never made it into the playlist. */
    | "unmatched";

/** A track as stored on the import job. */
export interface ImportPendingTrack {
    artist: string;
    title: string;
    album: string;
    albumMbid: string | null;
    preMatchedTrackId: string | null;
}

/** The parts of a DownloadJob this module needs. */
export interface ImportDownloadJob {
    id: string;
    status: string;
    subject: string;
    targetMbid: string | null;
    error: string | null;
    metadata: unknown;
}

export interface ImportTrackRow {
    /** Position in the job's track list; the handle for acting on a track. */
    index: number;
    artist: string;
    title: string;
    album: string;
    albumMbid: string | null;
    state: ImportTrackState;
    /** Human-readable elaboration, e.g. the download phase or failure reason. */
    detail: string | null;
    /** The download this track is waiting on, if any. */
    downloadJobId: string | null;
    /**
     * How many tracks in this import share that download. Skipping is an
     * album-level action, so the UI has to say what else it affects.
     */
    downloadTrackCount: number;
}

export interface ImportTrackSummary {
    total: number;
    inLibrary: number;
    downloaded: number;
    inFlight: number;
    failed: number;
    unresolved: number;
}

const IN_FLIGHT_STATUSES = new Set(["pending", "processing"]);

function readMetadata(metadata: unknown): Record<string, unknown> {
    return metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : {};
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Key an album download so tracks can find it. MBID is the reliable handle;
 * artist/title is the fallback for downloads queued without one.
 */
function downloadKeys(job: ImportDownloadJob): string[] {
    const metadata = readMetadata(job.metadata);
    const keys: string[] = [];

    const mbid = job.targetMbid || asString(metadata.albumMbid);
    if (mbid) keys.push(`mbid:${mbid.toLowerCase()}`);

    const artist = asString(metadata.artistName);
    const album = asString(metadata.albumTitle);
    if (artist && album) {
        keys.push(`name:${artist.toLowerCase()}|${album.toLowerCase()}`);
    }

    return keys;
}

function trackKeys(track: ImportPendingTrack): string[] {
    const keys: string[] = [];
    if (track.albumMbid) keys.push(`mbid:${track.albumMbid.toLowerCase()}`);
    if (track.artist && track.album) {
        keys.push(
            `name:${track.artist.toLowerCase()}|${track.album.toLowerCase()}`
        );
    }
    return keys;
}

/**
 * Describe what a download is currently doing, preferring the detail the
 * Soulseek progress reporter writes over the bare status.
 */
function describeDownload(job: ImportDownloadJob): string | null {
    const metadata = readMetadata(job.metadata);
    return (
        asString(metadata.statusText) ??
        asString(metadata.soulseekPhase) ??
        asString(job.error) ??
        null
    );
}

/** Normalized key for comparing a track against playlist leftovers. */
export function unmatchedTrackKey(artist: string, title: string): string {
    return `${artist.trim().toLowerCase()}|${title.trim().toLowerCase()}`;
}

/**
 * Join an import's tracks to the downloads they depend on.
 */
export function deriveImportTrackRows(input: {
    pendingTracks: ImportPendingTrack[];
    downloadJobs: ImportDownloadJob[];
    /**
     * Tracks the finished import left out of the playlist, as
     * unmatchedTrackKey values. Ignored while the import is still running.
     */
    unmatchedKeys?: Set<string>;
    /** Whether the import has reached a terminal state. */
    jobFinished?: boolean;
}): { tracks: ImportTrackRow[]; summary: ImportTrackSummary } {
    const { pendingTracks, downloadJobs, unmatchedKeys, jobFinished } = input;

    const downloadsByKey = new Map<string, ImportDownloadJob>();
    for (const job of downloadJobs) {
        for (const key of downloadKeys(job)) {
            // First writer wins so a retry doesn't displace the original.
            if (!downloadsByKey.has(key)) downloadsByKey.set(key, job);
        }
    }

    const matchedDownloads = pendingTracks.map((track) => {
        for (const key of trackKeys(track)) {
            const job = downloadsByKey.get(key);
            if (job) return job;
        }
        return null;
    });

    const trackCountByDownload = new Map<string, number>();
    for (const job of matchedDownloads) {
        if (!job) continue;
        trackCountByDownload.set(
            job.id,
            (trackCountByDownload.get(job.id) ?? 0) + 1
        );
    }

    const tracks = pendingTracks.map((track, index) => {
        const download = matchedDownloads[index];
        const row: ImportTrackRow = {
            index,
            artist: track.artist,
            title: track.title,
            album: track.album,
            albumMbid: track.albumMbid,
            state: "no_source",
            detail: null,
            downloadJobId: download?.id ?? null,
            downloadTrackCount: download
                ? trackCountByDownload.get(download.id) ?? 1
                : 0,
        };

        if (track.preMatchedTrackId) {
            row.state = "in_library";
            return row;
        }

        if (download) {
            if (download.status === "completed") {
                row.state = "downloaded";
            } else if (download.status === "processing") {
                row.state = "downloading";
                row.detail = describeDownload(download);
            } else if (download.status === "pending") {
                row.state = "queued";
                row.detail = describeDownload(download);
            } else {
                row.state = "download_failed";
                row.detail = asString(download.error) ?? "Download failed";
            }
        }

        // Once the import is over, a track the playlist never got is unmatched
        // regardless of how its download went — that's the outcome the user
        // cares about, and it says the file didn't land where we could see it.
        if (
            jobFinished &&
            unmatchedKeys?.has(unmatchedTrackKey(track.artist, track.title)) &&
            row.state !== "in_library"
        ) {
            row.detail =
                row.detail ??
                (row.state === "downloaded"
                    ? "Downloaded but not found in the library scan"
                    : null);
            row.state = "unmatched";
        }

        return row;
    });

    const summary: ImportTrackSummary = {
        total: tracks.length,
        inLibrary: tracks.filter((t) => t.state === "in_library").length,
        downloaded: tracks.filter((t) => t.state === "downloaded").length,
        inFlight: tracks.filter(
            (t) => t.state === "downloading" || t.state === "queued"
        ).length,
        failed: tracks.filter((t) => t.state === "download_failed").length,
        unresolved: tracks.filter(
            (t) => t.state === "no_source" || t.state === "unmatched"
        ).length,
    };

    return { tracks, summary };
}

/**
 * The downloads still holding an import open, which are the ones worth
 * offering to abandon.
 */
export function inFlightDownloadIds(jobs: ImportDownloadJob[]): string[] {
    return jobs
        .filter((job) => IN_FLIGHT_STATUSES.has(job.status))
        .map((job) => job.id);
}
