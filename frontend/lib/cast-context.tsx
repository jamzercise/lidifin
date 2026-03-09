"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useRef,
    ReactNode,
} from "react";
import { useAudioState } from "./audio-state-context";
import { useAudioPlayback } from "./audio-playback-context";
import { useAudioControls } from "./audio-controls-context";
import { api } from "./api";

// Default Media Receiver - works out of the box, no registration required
const DEFAULT_RECEIVER_APP_ID = "CC1AD845";
const CAST_SDK_URL =
    "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

declare global {
    interface Window {
        __onGCastApiAvailable?: (available: boolean) => void;
        chrome?: {
            cast?: {
                AutoJoinPolicy: { ORIGIN_SCOPED: string };
                media: {
                    MediaInfo: new (
                        contentId: string,
                        contentType: string
                    ) => MediaInfo;
                    LoadRequest: new (mediaInfo: MediaInfo) => LoadRequest;
                    MusicTrackMediaMetadata: new () => MusicTrackMediaMetadata;
                    StreamType: { BUFFERED: string };
                    DEFAULT_MEDIA_RECEIVER_APP_ID?: string;
                };
                Image: new (url: string) => { url: string };
            };
        };
        cast?: {
            framework: {
                CastContext: {
                    getInstance: () => CastContext;
                };
                CastContextEventType: { SESSION_STATE_CHANGED: string };
                SessionState: {
                    SESSION_STARTED: string;
                    SESSION_RESUMED: string;
                    SESSION_ENDED: string;
                };
                RemotePlayer: new () => RemotePlayer;
                RemotePlayerController: new (player: RemotePlayer) => RemotePlayerController;
                RemotePlayerEventType: {
                    ANY_CHANGE: string;
                    IS_CONNECTED_CHANGED: string;
                };
            };
        };
    }
}

interface MediaInfo {
    contentId: string;
    contentType: string;
    streamType?: string;
    duration?: number;
    metadata?: MusicTrackMediaMetadata;
}

interface LoadRequest {
    media: MediaInfo;
    autoplay?: boolean;
    currentTime?: number;
}

interface MusicTrackMediaMetadata {
    title?: string;
    artist?: string;
    albumName?: string;
    images?: { url: string }[];
}

interface CastContext {
    setOptions: (opts: { receiverApplicationId: string; autoJoinPolicy: string }) => void;
    getCurrentSession: () => CastSession | null;
    requestSession: () => Promise<CastSession>;
    addEventListener: (type: string, fn: (e: { sessionState: string }) => void) => void;
}

interface CastSession {
    loadMedia: (req: LoadRequest) => Promise<unknown>;
    getMediaSession: () => MediaSession | null;
    endSession: (stopCasting?: boolean) => void;
}

interface MediaSession {
    getMediaInformation: () => MediaInfo;
    getPlayerState: () => string;
    getCurrentTime: () => number;
    addUpdateListener: (fn: () => void) => void;
}

interface RemotePlayer {
    isConnected: boolean;
    isPaused: boolean;
    currentTime: number;
    duration: number;
    canPause: boolean;
    canControlVolume: boolean;
}

interface RemotePlayerController {
    playOrPause: () => void;
    seek: () => void;
    addEventListener: (type: string, fn: () => void) => void;
}

interface CastContextType {
    isAvailable: boolean;
    isCasting: boolean;
    castState: string;
    requestSession: () => Promise<void>;
    stopCasting: () => void;
    loadMedia: () => Promise<boolean>;
}

const CastContextContext = createContext<CastContextType | undefined>(undefined);

function loadCastScript(): Promise<boolean> {
    return new Promise((resolve) => {
        if (typeof window === "undefined") {
            resolve(false);
            return;
        }
        if (window.chrome?.cast) {
            resolve(true);
            return;
        }
        const existing = document.querySelector(
            `script[src="${CAST_SDK_URL}"]`
        );
        if (existing) {
            resolve(!!window.chrome?.cast);
            return;
        }
        window.__onGCastApiAvailable = (available) => {
            resolve(available);
        };
        const script = document.createElement("script");
        script.src = CAST_SDK_URL;
        script.async = true;
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
}

function initializeCast(): boolean {
    if (typeof window === "undefined" || !window.cast?.framework) {
        return false;
    }
    try {
        const context = window.cast.framework.CastContext.getInstance();
        context.setOptions({
            receiverApplicationId:
                window.chrome?.cast?.media?.DEFAULT_MEDIA_RECEIVER_APP_ID ??
                DEFAULT_RECEIVER_APP_ID,
            autoJoinPolicy:
                window.chrome?.cast?.AutoJoinPolicy?.ORIGIN_SCOPED ??
                "origin_scoped",
        });
        return true;
    } catch {
        return false;
    }
}

export function CastProvider({ children }: { children: ReactNode }) {
    const [isAvailable, setIsAvailable] = useState(false);
    const [isCasting, setIsCasting] = useState(false);
    const [castState, setCastState] = useState("NOT_CONNECTED");
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
    } = useAudioState();
    const {
        isPlaying,
        currentTime,
        setCurrentTime,
        setDuration,
        setIsPlaying,
    } = useAudioPlayback();
    const { pause, resume } = useAudioControls();
    const wasPlayingRef = useRef(false);
    const statusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        loadCastScript().then((loaded) => {
            if (loaded && initializeCast()) {
                setIsAvailable(true);
            }
        });
    }, []);

    const stopCasting = useCallback(() => {
        if (typeof window === "undefined" || !window.cast?.framework) return;
        const context = window.cast.framework.CastContext.getInstance();
        const session = context.getCurrentSession();
        if (session) {
            session.endSession(true);
        }
    }, []);

    const loadMedia = useCallback(async (): Promise<boolean> => {
        if (typeof window === "undefined" || !window.cast?.framework) return false;
        const context = window.cast.framework.CastContext.getInstance();
        const session = context.getCurrentSession();
        if (!session) return false;

        let streamUrl: string;
        let contentType = "audio/mpeg";
        let metadata: MusicTrackMediaMetadata | undefined;
        let duration: number | undefined;

        if (playbackType === "track" && currentTrack) {
            streamUrl = api.getStreamUrlForCast(currentTrack.id);
            duration = currentTrack.duration;
            const coverUrl =
                currentTrack.album?.coverArt
                    ? api.getCoverArtUrlForCast(currentTrack.album.coverArt)
                    : currentTrack.album?.id
                      ? api.getCoverArtUrlForCast(currentTrack.album.id)
                      : undefined;
            metadata = {
                title: currentTrack.title,
                artist: currentTrack.artist?.name ?? "Unknown Artist",
                albumName: currentTrack.album?.title ?? "Unknown Album",
                images: coverUrl
                    ? [{ url: coverUrl }]
                    : undefined,
            };
        } else if (playbackType === "audiobook" && currentAudiobook) {
            streamUrl = api.getAudiobookStreamUrlForCast(currentAudiobook.id);
            duration = currentAudiobook.duration;
            metadata = {
                title: currentAudiobook.title,
                artist: currentAudiobook.author ?? "Unknown Author",
                albumName: "Audiobook",
                images: currentAudiobook.coverUrl
                    ? [
                          {
                              url: api.getCoverArtUrlForCast(
                                  currentAudiobook.coverUrl
                              ),
                          },
                      ]
                    : undefined,
            };
        } else if (playbackType === "podcast" && currentPodcast) {
            const [podcastId, episodeId] = currentPodcast.id.split(":");
            streamUrl = api.getPodcastEpisodeStreamUrlForCast(
                podcastId,
                episodeId
            );
            duration = currentPodcast.duration;
            metadata = {
                title: currentPodcast.title,
                artist: currentPodcast.podcastTitle ?? "Podcast",
                albumName: "Podcast",
                images: currentPodcast.coverUrl
                    ? [
                          {
                              url: api.getCoverArtUrlForCast(
                                  currentPodcast.coverUrl
                              ),
                          },
                      ]
                    : undefined,
            };
        } else {
            return false;
        }

        try {
            const mediaInfo = new window.chrome!.cast!.media.MediaInfo(
                streamUrl,
                contentType
            ) as MediaInfo;
            if (metadata) mediaInfo.metadata = metadata;
            if (duration != null) mediaInfo.duration = duration;
            mediaInfo.streamType = window.chrome!.cast!.media.StreamType.BUFFERED;

            const loadRequest = new window.chrome!.cast!.media.LoadRequest(
                mediaInfo
            ) as LoadRequest;
            loadRequest.autoplay = isPlaying;
            loadRequest.currentTime = currentTime;

            await session.loadMedia(loadRequest);
            return true;
        } catch (err) {
            console.error("[Cast] loadMedia failed:", err);
            return false;
        }
    }, [
        playbackType,
        currentTrack,
        currentAudiobook,
        currentPodcast,
        isPlaying,
        currentTime,
    ]);

    const requestSession = useCallback(async () => {
        if (!isAvailable || typeof window === "undefined") return;
        const context = window.cast!.framework.CastContext.getInstance();
        wasPlayingRef.current = isPlaying;
        try {
            const session = await context.requestSession();
            if (session) {
                pause();
                const loaded = await loadMedia();
                if (!loaded) {
                    resume();
                }
            }
        } catch {
            resume();
        }
    }, [isAvailable, isPlaying, pause, resume, loadMedia]);

    useEffect(() => {
        if (!isAvailable || typeof window === "undefined") return;
        const context = window.cast!.framework.CastContext.getInstance();

        const onSessionStateChanged = (event: { sessionState: string }) => {
            if (
                event.sessionState === window.cast!.framework.SessionState.SESSION_STARTED ||
                event.sessionState === window.cast!.framework.SessionState.SESSION_RESUMED
            ) {
                setIsCasting(true);
                setCastState("CONNECTED");
                pause();
                loadMedia();
                statusIntervalRef.current = setInterval(() => {
                    const sess = context.getCurrentSession();
                    const mediaSession = sess?.getMediaSession();
                    if (mediaSession) {
                        setCurrentTime(mediaSession.getCurrentTime());
                        const info = mediaSession.getMediaInformation();
                        if (info.duration) setDuration(info.duration);
                        const state = mediaSession.getPlayerState();
                        setIsPlaying(state === "PLAYING");
                    }
                }, 500);
            } else if (
                event.sessionState === window.cast!.framework.SessionState.SESSION_ENDED
            ) {
                setIsCasting(false);
                setCastState("NOT_CONNECTED");
                if (statusIntervalRef.current) {
                    clearInterval(statusIntervalRef.current);
                    statusIntervalRef.current = null;
                }
                if (wasPlayingRef.current) {
                    resume();
                }
            }
        };

        context.addEventListener(
            window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
            onSessionStateChanged
        );

        const currentSession = context.getCurrentSession();
        if (currentSession) {
            setIsCasting(true);
            setCastState("CONNECTED");
        }

        return () => {
            if (statusIntervalRef.current) {
                clearInterval(statusIntervalRef.current);
            }
        };
    }, [isAvailable, pause, resume, loadMedia, setCurrentTime, setDuration, setIsPlaying]);

    const value: CastContextType = {
        isAvailable,
        isCasting,
        castState,
        requestSession,
        stopCasting,
        loadMedia,
    };

    return (
        <CastContextContext.Provider value={value}>
            {children}
        </CastContextContext.Provider>
    );
}

export function useCast() {
    const context = useContext(CastContextContext);
    if (context === undefined) {
        throw new Error("useCast must be used within a CastProvider");
    }
    return context;
}
