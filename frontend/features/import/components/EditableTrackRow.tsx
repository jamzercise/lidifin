"use client";

import { useId, useState } from "react";
import { Pencil, RotateCcw, Check, X } from "lucide-react";
import { formatTime } from "@/utils/formatTime";

/**
 * A correction to one playlist track, sent to the backend so it can be applied
 * before matching and acquisition.
 */
export interface TrackEdit {
    spotifyId: string;
    artist?: string;
    title?: string;
    album?: string;
}

/**
 * The parts of a preview track this row shows. Structural so the import page's
 * SpotifyTrack satisfies it directly.
 */
export interface EditableTrack {
    spotifyId: string;
    title: string;
    artist: string;
    album: string;
    durationMs: number;
}

interface EditableTrackRowProps {
    track: EditableTrack;
    /** How many tracks are queued from the same album, for "apply to all". */
    albumTrackCount: number;
    isEdited: boolean;
    isEditing: boolean;
    onStartEdit: () => void;
    onCancelEdit: () => void;
    onSave: (
        values: { artist: string; title: string; album: string },
        applyAlbumToGroup: boolean
    ) => void;
    onRevert: () => void;
}

export function EditableTrackRow({
    track,
    albumTrackCount,
    isEdited,
    isEditing,
    onStartEdit,
    onCancelEdit,
    onSave,
    onRevert,
}: EditableTrackRowProps) {
    const fieldId = useId();
    const [artist, setArtist] = useState(track.artist);
    const [title, setTitle] = useState(track.title);
    const [album, setAlbum] = useState(track.album);
    const [applyAlbumToGroup, setApplyAlbumToGroup] = useState(false);

    const albumChanged = album.trim() !== track.album;
    const canSave = Boolean(artist.trim() && title.trim() && album.trim());

    if (!isEditing) {
        return (
            <div className="flex items-center gap-3 px-4 py-2 hover:bg-white/5 group">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-white truncate">
                            {track.title}
                        </span>
                        {isEdited && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#B1D2C3]/20 text-[#B1D2C3]">
                                edited
                            </span>
                        )}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                        {track.artist} · {track.album}
                    </div>
                </div>
                <span className="text-xs text-gray-600 shrink-0">
                    {formatTime(Math.round(track.durationMs / 1000))}
                </span>
                {isEdited && (
                    <button
                        onClick={onRevert}
                        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all shrink-0"
                        title="Undo this correction"
                    >
                        <RotateCcw className="w-3.5 h-3.5 text-gray-400" />
                    </button>
                )}
                <button
                    onClick={() => {
                        setArtist(track.artist);
                        setTitle(track.title);
                        setAlbum(track.album);
                        setApplyAlbumToGroup(false);
                        onStartEdit();
                    }}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all shrink-0"
                    title="Fix this track's details"
                >
                    <Pencil className="w-3.5 h-3.5 text-gray-400" />
                </button>
            </div>
        );
    }

    return (
        <div className="px-4 py-3 bg-black/20 border-y border-[#B1D2C3]/20 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
                <div>
                    <label
                        htmlFor={`${fieldId}-title`}
                        className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1"
                    >
                        Title
                    </label>
                    <input
                        id={`${fieldId}-title`}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#B1D2C3]"
                    />
                </div>
                <div>
                    <label
                        htmlFor={`${fieldId}-artist`}
                        className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1"
                    >
                        Artist
                    </label>
                    <input
                        id={`${fieldId}-artist`}
                        value={artist}
                        onChange={(e) => setArtist(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#B1D2C3]"
                    />
                </div>
                <div className="sm:col-span-2">
                    <label
                        htmlFor={`${fieldId}-album`}
                        className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1"
                    >
                        Album
                    </label>
                    <input
                        id={`${fieldId}-album`}
                        value={album}
                        onChange={(e) => setAlbum(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#B1D2C3]"
                    />
                </div>
            </div>

            {albumChanged && albumTrackCount > 1 && (
                <label className="flex items-center gap-2 text-xs text-gray-400">
                    <input
                        type="checkbox"
                        checked={applyAlbumToGroup}
                        onChange={(e) => setApplyAlbumToGroup(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-white/20 bg-transparent text-[#B1D2C3] focus:ring-[#B1D2C3] focus:ring-offset-0"
                    />
                    Use this album for all {albumTrackCount} tracks in the group
                </label>
            )}

            <div className="flex items-center gap-2 pt-1">
                <button
                    onClick={() =>
                        onSave({ artist, title, album }, applyAlbumToGroup)
                    }
                    disabled={!canSave}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-[#B1D2C3] text-black hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                    <Check className="w-3 h-3" />
                    Save
                </button>
                <button
                    onClick={onCancelEdit}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
                >
                    <X className="w-3 h-3" />
                    Cancel
                </button>
                <span className="text-xs text-gray-600">
                    Applied when you re-check or start the import
                </span>
            </div>
        </div>
    );
}
