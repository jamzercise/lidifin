"use client";

import { useEffect, useId, useState } from "react";
import { api, MoodType, MoodBucketPreset } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { useQueryClient } from "@tanstack/react-query";
import {
    Play,
    Loader2,
    AudioWaveform,
    X,
    Smile,
    Frown,
    Coffee,
    Zap,
    PartyPopper,
    Brain,
    CloudRain,
    Flame,
    Guitar,
} from "lucide-react";
import { toast } from "sonner";

interface MoodMixerProps {
    isOpen: boolean;
    onClose: () => void;
}

// Mood configuration with icons and colors
const MOOD_CONFIG: Record<
    MoodType,
    {
        icon: React.ComponentType<{ className?: string }>;
        color: string;
        label: string;
        description: string;
    }
> = {
    happy: {
        icon: Smile,
        color: "from-yellow-500 to-orange-500",
        label: "Happy",
        description: "Uplifting & joyful",
    },
    sad: {
        icon: Frown,
        color: "from-blue-600 to-indigo-700",
        label: "Sad",
        description: "Melancholic & emotional",
    },
    chill: {
        icon: Coffee,
        color: "from-teal-500 to-cyan-600",
        label: "Chill",
        description: "Relaxed & mellow",
    },
    energetic: {
        icon: Zap,
        color: "from-orange-500 to-red-500",
        label: "Energetic",
        description: "High energy & pumped",
    },
    party: {
        icon: PartyPopper,
        color: "from-pink-500 to-purple-600",
        label: "Party",
        description: "Dance & celebrate",
    },
    focus: {
        icon: Brain,
        color: "from-emerald-500 to-green-600",
        label: "Focus",
        description: "Concentration & flow",
    },
    melancholy: {
        icon: CloudRain,
        color: "from-slate-500 to-gray-600",
        label: "Melancholy",
        description: "Bittersweet & reflective",
    },
    aggressive: {
        icon: Flame,
        color: "from-red-600 to-rose-700",
        label: "Aggressive",
        description: "Intense & powerful",
    },
    acoustic: {
        icon: Guitar,
        color: "from-amber-600 to-yellow-700",
        label: "Acoustic",
        description: "Organic & unplugged",
    },
};

// Order for display in 3x3 grid
const MOOD_ORDER: MoodType[] = [
    "happy",
    "energetic",
    "party",
    "chill",
    "focus",
    "acoustic",
    "melancholy",
    "sad",
    "aggressive",
];

export function MoodMixer({ isOpen, onClose }: MoodMixerProps) {
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [presets, setPresets] = useState<MoodBucketPreset[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState<MoodType | null>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [audioMuseAvailable, setAudioMuseAvailable] = useState(false);
    const titleId = useId();

    // Handle visibility animation
    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
            loadPresets();
            loadAudioMuseStatus();
        } else {
            // Delay hiding to allow exit animation
            const timeout = setTimeout(() => setIsVisible(false), 200);
            return () => clearTimeout(timeout);
        }
    }, [isOpen]);

    const loadPresets = async () => {
        try {
            const data = await api.getMoodBucketPresets();
            setPresets(data);
        } catch (error) {
            console.error("Failed to load mood presets:", error);
            toast.error("Failed to load mood presets");
        } finally {
            setLoading(false);
        }
    };

    const loadAudioMuseStatus = async () => {
        try {
            const status = await api.getAudioMuseStatus();
            setAudioMuseAvailable(
                Boolean(status?.enabled && status?.available)
            );
        } catch {
            setAudioMuseAvailable(false);
        }
    };

    const playTracksFromResult = (
        tracks: Array<{
            id: string;
            title: string;
            duration: number;
            album?: {
                id?: string;
                title?: string;
                coverUrl?: string | null;
                artist?: { id?: string; name: string };
            };
        }>,
        config: { label: string },
        saveMoodMix?: MoodType
    ) => {
        const mapped: Track[] = tracks.map((t) => ({
            id: t.id,
            title: t.title,
            artist: {
                name: t.album?.artist?.name || "Unknown Artist",
                id: t.album?.artist?.id,
            },
            album: {
                title: t.album?.title || "Unknown Album",
                coverArt: t.album?.coverUrl,
                id: t.album?.id,
            },
            duration: t.duration,
        }));
        playTracks(mapped, 0);
        toast.success(`${config.label} Mix`, {
            description: `Playing ${mapped.length} tracks`,
        });
        if (saveMoodMix) {
            api.saveMoodBucketMix(saveMoodMix).catch(() => {});
            queryClient.refetchQueries({ queryKey: ["mixes"] });
            window.dispatchEvent(new CustomEvent("mix-generated"));
            window.dispatchEvent(new CustomEvent("mixes-updated"));
        }
        onClose();
    };

    const generateMix = async (mood: MoodType) => {
        const config = MOOD_CONFIG[mood];
        setGenerating(mood);

        try {
            // Try AudioMuse-AI first when available (Jellyfin + AudioMuse)
            if (audioMuseAvailable) {
                try {
                    const result = await api.getAudioMuseInstantPlaylist({
                        mood,
                    });
                    if (result.tracks && result.tracks.length > 0) {
                        playTracksFromResult(result.tracks, config);
                        setGenerating(null);
                        return;
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : "AudioMuse-AI request failed";
                    toast.error("Instant Playlist unavailable", {
                        description: msg,
                    });
                    // Fall through to mood bucket
                }
            }

            // Fallback: pre-computed mood bucket
            const mix = await api.getMoodBucketMix(mood);

            if (mix.tracks && mix.tracks.length > 0) {
                playTracksFromResult(mix.tracks, config, mood);
            } else {
                toast.error("Not enough tracks for this mood", {
                    description:
                        "Try analyzing more music or choose a different mood",
                });
            }
        } catch (error: unknown) {
            console.error("Failed to generate mood mix:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Failed to generate mix";
            toast.error(errorMessage);
        } finally {
            setGenerating(null);
        }
    };

    // Get track count for a mood (only used when AudioMuse not available)
    const getTrackCount = (mood: MoodType): number => {
        const preset = presets.find((p) => p.id === mood);
        return preset?.trackCount || 0;
    };

    // When AudioMuse is available, all moods are tryable; otherwise need 5+ tracks
    const isMoodDisabled = (mood: MoodType) =>
        !audioMuseAvailable && getTrackCount(mood) < 5;

    if (!isVisible && !isOpen) return null;

    return (
        <div
            className={`fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 transition-opacity duration-200 ${
                isOpen ? "opacity-100" : "opacity-0"
            }`}
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className={`bg-gradient-to-b from-[#1a1a1a] to-[#0a0a0a] rounded-2xl max-w-lg w-full max-h-[85vh] overflow-hidden border border-white/10 shadow-2xl transition-all duration-200 ${
                    isOpen ? "scale-100 opacity-100" : "scale-95 opacity-0"
                }`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="p-6 border-b border-white/10 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#B1D2C3] to-amber-600 flex items-center justify-center">
                            <AudioWaveform
                                className="w-5 h-5 text-black"
                                aria-hidden="true"
                            />
                        </div>
                        <div>
                            <h2
                                id={titleId}
                                className="text-xl font-bold text-white"
                            >
                                Mood Mixer
                            </h2>
                            <p className="text-sm text-gray-400">
                                Pick your vibe
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close mood mixer"
                        className="p-2 rounded-full hover:bg-white/10 transition-colors"
                    >
                        <X className="w-5 h-5 text-gray-400" aria-hidden="true" />
                    </button>
                </div>

                {/* Generating indicator */}
                {generating && (
                    <div className="mx-4 mb-2 px-4 py-2 rounded-lg bg-[#B1D2C3]/20 border border-[#B1D2C3]/40 flex items-center gap-2 text-[#B1D2C3]">
                        <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                        <span className="text-sm font-medium">
                            Generating your mix… This may take up to a minute.
                        </span>
                    </div>
                )}

                {/* Content */}
                <div className="p-6 overflow-y-auto max-h-[calc(85vh-100px)]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-8 h-8 animate-spin text-[#B1D2C3]" />
                        </div>
                    ) : (
                        /* 3x3 Mood Grid */
                        <div className="grid grid-cols-3 gap-3">
                            {MOOD_ORDER.map((mood) => {
                                const config = MOOD_CONFIG[mood];
                                const Icon = config.icon;
                                const trackCount = getTrackCount(mood);
                                const isDisabled = isMoodDisabled(mood);
                                const isGenerating = generating === mood;

                                return (
                                    <button
                                        key={mood}
                                        onClick={() => generateMix(mood)}
                                        disabled={
                                            generating !== null || isDisabled
                                        }
                                        className={`
                                            relative group aspect-square rounded-xl overflow-hidden
                                            bg-gradient-to-br ${config.color}
                                            border border-white/10 hover:border-white/30
                                            transition-all duration-200 hover:scale-[1.03] active:scale-[0.97]
                                            disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100
                                            flex flex-col items-center justify-center gap-2 p-3
                                        `}
                                        title={
                                            isDisabled
                                                ? `Need at least 5 tracks (have ${trackCount}). Configure AudioMuse-AI for instant playlists.`
                                                : config.description
                                        }
                                    >
                                        {/* Icon */}
                                        <div className="relative z-10">
                                            {isGenerating ? (
                                                <Loader2 className="w-8 h-8 text-white animate-spin" />
                                            ) : (
                                                <Icon className="w-8 h-8 text-white drop-shadow-lg" />
                                            )}
                                        </div>

                                        {/* Label */}
                                        <span className="relative z-10 text-sm font-semibold text-white drop-shadow-lg">
                                            {config.label}
                                        </span>

                                        {/* Track count badge */}
                                        <span className="absolute top-2 right-2 text-[10px] font-medium text-white/70 bg-black/30 px-1.5 py-0.5 rounded-full">
                                            {trackCount}
                                        </span>

                                        {/* Hover overlay with play icon */}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                            {!isGenerating && !isDisabled && (
                                                <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                                                    <Play
                                                        className="w-6 h-6 text-white ml-0.5"
                                                        fill="currentColor"
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* Help text */}
                    <p className="text-center text-xs text-gray-500 mt-4">
                        Moods are based on audio analysis of your library
                    </p>
                </div>
            </div>
        </div>
    );
}
