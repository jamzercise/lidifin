import { spawn } from "child_process";
import { logger } from "../utils/logger";
import { getYtDlpPath, isYtDlpAvailableSync } from "../utils/ytDlpBinary";

/**
 * YouTube Music Service
 *
 * Fetches playlist metadata and track list from YouTube Music via yt-dlp.
 * The binary is resolved automatically: system PATH, or LIDIFIN_YT_DLP_PATH (or legacy LIDIFY_YT_DLP_PATH), or
 * auto-downloaded into backend/data/yt-dlp/ on first use (via yt-dlp-wrap).
 *
 * Playlists must be public (or accessible without login).
 * Supported URLs: https://music.youtube.com/playlist?list=PLxxx
 */

export interface YouTubeMusicTrack {
    youtubeId: string;
    title: string;
    artist: string;
    album: string;
    durationMs: number;
    coverUrl: string | null;
}

export interface YouTubeMusicPlaylist {
    id: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: YouTubeMusicTrack[];
}

const YT_DLP_TIMEOUT_MS = 90_000; // 90 seconds for large playlists

/**
 * Parse a YouTube Music playlist URL and return the playlist ID.
 * Supports:
 *   https://music.youtube.com/playlist?list=PLxxx
 *   https://www.youtube.com/watch?v=...&list=PLxxx (video in playlist)
 */
export function parseYouTubeMusicPlaylistUrl(url: string): { type: "playlist"; id: string } | null {
    const trimmed = (url || "").trim();
    // music.youtube.com/playlist?list=
    const musicPlaylistMatch = trimmed.match(/music\.youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/);
    if (musicPlaylistMatch) {
        return { type: "playlist", id: musicPlaylistMatch[1] };
    }
    // youtube.com/watch with list= (extract playlist ID)
    const watchListMatch = trimmed.match(/(?:youtube\.com\/watch|youtube\.com\/playlist).*[?&]list=([a-zA-Z0-9_-]+)/);
    if (watchListMatch) {
        return { type: "playlist", id: watchListMatch[1] };
    }
    return null;
}

/**
 * Check if yt-dlp is available (system or cached). Does not trigger download.
 */
export async function isYtDlpAvailable(): Promise<boolean> {
    return Promise.resolve(isYtDlpAvailableSync());
}

/**
 * Extract artist from YouTube Music track.
 * Often title is "Song Title" and uploader is "Artist Name" or "Artist Name - Topic".
 */
function extractArtist(entry: { uploader?: string; artist?: string; creator?: string; channel?: string }): string {
    const raw =
        entry.artist ||
        entry.creator ||
        entry.uploader ||
        entry.channel ||
        "";
    // Remove " - Topic" suffix common on YouTube Music
    return raw.replace(/\s*-\s*Topic\s*$/i, "").trim() || "Unknown Artist";
}

/**
 * Extract title; fallback to "Unknown" if missing.
 */
function extractTitle(entry: { title?: string }): string {
    return (entry.title || "").trim() || "Unknown";
}

/**
 * Duration in seconds from entry; convert to ms.
 */
function durationMs(entry: { duration?: number | null }): number {
    const sec = entry.duration;
    if (typeof sec === "number" && sec >= 0) return Math.round(sec * 1000);
    return 0;
}

/**
 * Fetch a YouTube Music playlist by ID using yt-dlp.
 * Returns null if yt-dlp is not installed, playlist is private/invalid, or on error.
 */
export async function getYouTubeMusicPlaylist(playlistId: string): Promise<YouTubeMusicPlaylist | null> {
    const url = `https://music.youtube.com/playlist?list=${playlistId}`;

    const binaryPath = await getYtDlpPath();
    if (!binaryPath) {
        logger.warn(
            "[YouTube Music] yt-dlp is not available and auto-download failed. " +
            "Install yt-dlp (e.g. brew install yt-dlp) or set LIDIFIN_YT_DLP_PATH (or legacy LIDIFY_YT_DLP_PATH)."
        );
        return null;
    }

    return new Promise((resolve) => {
        // -j = one JSON object per line (per playlist entry); --flat-playlist = no download
        const args = [
            "--flat-playlist",
            "--no-download",
            "-j",
            "--no-warnings",
            "--no-check-certificates",
            url,
        ];

        const proc = spawn(binaryPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timeout = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill("SIGKILL");
            } catch {
                // ignore
            }
            logger.warn("[YouTube Music] yt-dlp timed out fetching playlist");
            resolve(null);
        }, YT_DLP_TIMEOUT_MS);

        proc.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        proc.on("error", (err: Error) => {
            clearTimeout(timeout);
            logger.error("[YouTube Music] yt-dlp spawn error:", err.message);
            resolve(null);
        });

        proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
            clearTimeout(timeout);
            if (timedOut) return;

            if (code !== 0) {
                logger.warn("[YouTube Music] yt-dlp exited with code", code, "signal", signal, stderr.slice(0, 500));
                resolve(null);
                return;
            }

            try {
                // yt-dlp -j --flat-playlist outputs one JSON object per line (one per track)
                const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
                const tracks: YouTubeMusicTrack[] = [];

                let playlistTitle = `YouTube Music Playlist (${lines.length} tracks)`;
                let playlistCreator = "YouTube Music";
                let playlistThumbnail: string | null = null;

                for (const line of lines) {
                    const e = JSON.parse(line);
                    if (e._type === "playlist" && Array.isArray(e.entries)) {
                        playlistTitle = (e.title || playlistTitle).trim() || playlistTitle;
                        playlistCreator = (e.uploader || e.creator || e.channel || playlistCreator).trim() || playlistCreator;
                        playlistThumbnail = e.thumbnail || null;
                        for (const ent of e.entries) {
                            if (!ent || ent.id === undefined) continue;
                            tracks.push({
                                youtubeId: String(ent.id),
                                title: extractTitle(ent),
                                artist: extractArtist(ent),
                                album: "Unknown Album",
                                durationMs: durationMs(ent),
                                coverUrl: ent.thumbnail || null,
                            });
                        }
                        break;
                    }
                    if (!e.id) continue;
                    tracks.push({
                        youtubeId: String(e.id),
                        title: extractTitle(e),
                        artist: extractArtist(e),
                        album: "Unknown Album",
                        durationMs: durationMs(e),
                        coverUrl: e.thumbnail || null,
                    });
                }

                if (tracks.length > 0 && !playlistThumbnail) {
                    playlistThumbnail = tracks[0].coverUrl;
                }
                resolve({
                    id: playlistId,
                    title: tracks.length > 0 ? playlistTitle : "YouTube Music Playlist",
                    description: null,
                    creator: playlistCreator,
                    imageUrl: playlistThumbnail,
                    trackCount: tracks.length,
                    tracks,
                });
            } catch (parseErr: any) {
                logger.error("[YouTube Music] Failed to parse yt-dlp output:", parseErr?.message);
                resolve(null);
            }
        });
    });
}

/**
 * Singleton-style export for use in routes.
 */
export const youtubeMusicService = {
    parseUrl: parseYouTubeMusicPlaylistUrl,
    getPlaylist: getYouTubeMusicPlaylist,
    isAvailable: isYtDlpAvailable,
};
