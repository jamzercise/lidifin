"use client";

import { useState } from "react";
import { Edit, Save } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { GradientSpinner } from "./ui/GradientSpinner";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import Image from "next/image";

interface MetadataEditorProps {
    type: "artist" | "album" | "track";
    id: string;
    currentData: {
        // API responses use `null` to mean "no value" while local form state
        // uses `undefined`. Accept both so callers don't have to coerce.
        name?: string | null;
        title?: string | null;
        bio?: string | null;
        genres?: string[];
        year?: number | null;
        mbid?: string | null;
        rgMbid?: string | null;
        coverUrl?: string | null;
        heroUrl?: string | null;
        // Original values for comparison (when user overrides exist)
        _originalName?: string;
        _originalBio?: string | null;
        _originalGenres?: string[];
        _originalHeroUrl?: string | null;
        _originalTitle?: string;
        _originalYear?: number | null;
        _originalCoverUrl?: string | null;
        _hasUserOverrides?: boolean;
    };
    onSave?: (updatedData: Record<string, unknown> | null) => void;
}

/**
 * Metadata Editor Component
 * Plex/Kavita-style metadata editor with pencil icon
 * Opens a modal for editing artist/album/track metadata
 */
export function MetadataEditor({
    type,
    id,
    currentData,
    onSave,
}: MetadataEditorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [formData, setFormData] = useState(currentData);
    const hasOverrides = currentData._hasUserOverrides ?? false;
    const editKind =
        type === "artist" ? "Artist" : type === "album" ? "Album" : "Track";

    const handleOpen = () => {
        setFormData(currentData);
        setIsOpen(true);
    };

    const handleClose = () => {
        setIsOpen(false);
        setFormData(currentData);
    };

    const executeReset = async () => {
        setIsResetting(true);
        try {
            if (type === "artist") {
                await api.resetArtistMetadata(id);
            } else if (type === "album") {
                await api.resetAlbumMetadata(id);
            } else {
                await api.resetTrackMetadata(id);
            }

            toast.success("Metadata reset to original values");
            onSave?.(null);
            setIsOpen(false);
        } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to reset metadata");
        } finally {
            setIsResetting(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            // The form accepts `null` for "no value" coming from the API, but
            // the update endpoints want `undefined` (omit) instead of `null`.
            // Strip nulls before sending so we don't accidentally try to clear
            // fields the user didn't touch.
            const stripNulls = <T extends Record<string, unknown>>(obj: T) => {
                const out: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(obj)) {
                    if (v !== null) out[k] = v;
                }
                return out;
            };

            // Call API to update metadata
            let response;
            if (type === "artist") {
                response = await api.updateArtistMetadata(
                    id,
                    stripNulls(formData) as Parameters<
                        typeof api.updateArtistMetadata
                    >[1],
                );
            } else if (type === "album") {
                response = await api.updateAlbumMetadata(
                    id,
                    stripNulls(formData) as Parameters<
                        typeof api.updateAlbumMetadata
                    >[1],
                );
            } else {
                response = await api.updateTrackMetadata(id, stripNulls(formData));
            }

            toast.success(
                `${
                    type === "artist"
                        ? "Artist"
                        : type === "album"
                        ? "Album"
                        : "Track"
                } metadata updated`
            );
            onSave?.(response);
            setIsOpen(false);
        } catch (error: unknown) {
            console.error("Failed to update metadata:", error);
            toast.error(error instanceof Error ? error.message : "Failed to update metadata");
        } finally {
            setIsSaving(false);
        }
    };

    const handleChange = (field: string, value: string | number | string[] | null) => {
        setFormData((prev) => ({ ...prev, [field]: value }));
    };

    return (
        <>
            {/* Pencil Icon Button */}
            <button
                onClick={handleOpen}
                className="p-2 rounded-full bg-black/40 hover:bg-black/60 transition-all opacity-0 group-hover:opacity-100"
                title={`Edit ${type} metadata`}
            >
                <Edit className="w-4 h-4 text-white" />
            </button>

            <Modal
                isOpen={isOpen}
                onClose={handleClose}
                title={`Edit ${editKind} Metadata`}
                backdropClassName="bg-black/80"
                className="max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden rounded-lg border-white/10 bg-[#121212] bg-none shadow-2xl"
                contentClassName="flex-1 min-h-0 overflow-y-auto space-y-4"
                footer={
                    <div className="flex w-full flex-wrap items-center justify-end gap-3 border-t border-white/10 pt-4 mt-2">
                        {hasOverrides ? (
                            <Button
                                variant="danger"
                                onClick={() => setShowResetConfirm(true)}
                                disabled={isSaving || isResetting}
                                className="rounded-full"
                            >
                                {isResetting
                                    ? "Resetting..."
                                    : "Reset to Original"}
                            </Button>
                        ) : null}
                        <Button
                            variant="secondary"
                            onClick={handleClose}
                            disabled={isSaving}
                            className="rounded-full"
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSave}
                            disabled={isSaving}
                            className="rounded-full inline-flex items-center gap-2 !bg-[#B1D2C3] !text-black hover:!bg-[#9bc4b3] hover:!text-black shadow-md shadow-black/20 focus-visible:ring-offset-[#121212]"
                        >
                            {isSaving ? (
                                <>
                                    <GradientSpinner size="sm" />
                                    Saving...
                                </>
                            ) : (
                                <>
                                    <Save className="w-4 h-4" />
                                    Save Changes
                                </>
                            )}
                        </Button>
                    </div>
                }
            >
                            {/* Name/Title */}
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    {type === "artist"
                                        ? "Artist Name"
                                        : type === "album"
                                        ? "Album Title"
                                        : "Track Title"}
                                </label>
                                <input
                                    type="text"
                                    value={
                                        formData.name || formData.title || ""
                                    }
                                    onChange={(e) =>
                                        handleChange(
                                            type === "artist"
                                                ? "name"
                                                : "title",
                                            e.target.value
                                        )
                                    }
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                />
                                {type === "artist" &&
                                    currentData._originalName &&
                                    currentData._originalName !==
                                        (formData.name || "") && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            Original:{" "}
                                            {currentData._originalName}
                                        </p>
                                    )}
                                {type !== "artist" &&
                                    currentData._originalTitle &&
                                    currentData._originalTitle !==
                                        (formData.title || "") && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            Original:{" "}
                                            {currentData._originalTitle}
                                        </p>
                                    )}
                            </div>

                            {/* Bio (Artist only) */}
                            {type === "artist" && (
                                <div>
                                    <label className="block text-sm font-bold text-white mb-2">
                                        Biography
                                    </label>
                                    <textarea
                                        value={formData.bio || ""}
                                        onChange={(e) =>
                                            handleChange("bio", e.target.value)
                                        }
                                        rows={6}
                                        className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none resize-none"
                                    />
                                    {currentData._originalBio &&
                                        currentData._originalBio !==
                                            (formData.bio || "") && (
                                            <p className="mt-1 text-xs text-gray-500">
                                                Original:{" "}
                                                {currentData._originalBio.substring(
                                                    0,
                                                    100
                                                )}
                                                ...
                                            </p>
                                        )}
                                </div>
                            )}

                            {/* Year (Album only) */}
                            {type === "album" && (
                                <div>
                                    <label className="block text-sm font-bold text-white mb-2">
                                        Release Year
                                    </label>
                                    <input
                                        type="number"
                                        value={formData.year || ""}
                                        onChange={(e) =>
                                            handleChange(
                                                "year",
                                                parseInt(e.target.value)
                                            )
                                        }
                                        className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                    />
                                    {currentData._originalYear &&
                                        currentData._originalYear !==
                                            (formData.year || null) && (
                                            <p className="mt-1 text-xs text-gray-500">
                                                Original:{" "}
                                                {currentData._originalYear}
                                            </p>
                                        )}
                                </div>
                            )}

                            {/* Genres */}
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    Genres
                                    <span className="text-xs text-gray-400 ml-2">
                                        (comma-separated)
                                    </span>
                                </label>
                                <input
                                    type="text"
                                    value={formData.genres?.join(", ") || ""}
                                    onChange={(e) =>
                                        handleChange(
                                            "genres",
                                            e.target.value
                                                .split(",")
                                                .map((g) => g.trim())
                                                .filter(Boolean)
                                        )
                                    }
                                    placeholder="Rock, Alternative, Indie"
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                />
                                {currentData._originalGenres &&
                                    currentData._originalGenres.length > 0 &&
                                    JSON.stringify(
                                        currentData._originalGenres.sort()
                                    ) !==
                                        JSON.stringify(
                                            (formData.genres || []).sort()
                                        ) && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            Original:{" "}
                                            {currentData._originalGenres.join(
                                                ", "
                                            )}
                                        </p>
                                    )}
                            </div>

                            {/* MusicBrainz ID */}
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    MusicBrainz ID
                                    <span className="text-xs text-gray-400 ml-2">
                                        (leave empty to auto-fetch)
                                    </span>
                                </label>
                                <input
                                    type="text"
                                    value={
                                        type === "artist"
                                            ? formData.mbid || ""
                                            : type === "album"
                                            ? formData.rgMbid || ""
                                            : formData.mbid || ""
                                    }
                                    onChange={(e) =>
                                        handleChange(
                                            type === "artist"
                                                ? "mbid"
                                                : type === "album"
                                                ? "rgMbid"
                                                : "mbid",
                                            e.target.value
                                        )
                                    }
                                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none font-mono text-sm"
                                />
                            </div>

                            {/* Image URL */}
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    {type === "artist"
                                        ? "Artist Image URL"
                                        : "Cover Art URL"}
                                    <span className="text-xs text-gray-400 ml-2">
                                        (leave empty to auto-fetch)
                                    </span>
                                </label>
                                <input
                                    type="url"
                                    value={
                                        type === "artist"
                                            ? formData.heroUrl || ""
                                            : formData.coverUrl || ""
                                    }
                                    onChange={(e) =>
                                        handleChange(
                                            type === "artist"
                                                ? "heroUrl"
                                                : "coverUrl",
                                            e.target.value
                                        )
                                    }
                                    placeholder="https://..."
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none text-sm"
                                />
                                {type === "artist" &&
                                    currentData._originalHeroUrl &&
                                    currentData._originalHeroUrl !==
                                        (formData.heroUrl || "") && (
                                        <p className="mt-1 text-xs text-gray-500 truncate">
                                            Original:{" "}
                                            {currentData._originalHeroUrl}
                                        </p>
                                    )}
                                {type === "album" &&
                                    currentData._originalCoverUrl &&
                                    currentData._originalCoverUrl !==
                                        (formData.coverUrl || "") && (
                                        <p className="mt-1 text-xs text-gray-500 truncate">
                                            Original:{" "}
                                            {currentData._originalCoverUrl}
                                        </p>
                                    )}
                                {/* Image Preview */}
                                {(formData.heroUrl || formData.coverUrl) && (
                                    <div className="mt-2">
                                        <Image
                                            src={
                                                formData.heroUrl ||
                                                formData.coverUrl ||
                                                ""
                                            }
                                            alt="Preview"
                                            width={128}
                                            height={128}
                                            className="w-32 h-32 object-cover rounded"
                                            unoptimized
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Manual Override Warning */}
                            <div className="bg-yellow-600/10 border border-yellow-600/20 rounded p-4">
                                <p className="text-sm text-yellow-400">
                                    <strong>Note:</strong> Manually edited
                                    metadata will not be overwritten by
                                    automatic enrichment.
                                </p>
                            </div>
            </Modal>

            <ConfirmDialog
                isOpen={showResetConfirm}
                onClose={() => setShowResetConfirm(false)}
                onConfirm={() => {
                    void executeReset();
                }}
                title="Reset metadata?"
                message="Reset all metadata to original values? This cannot be undone."
                confirmText="Reset"
                cancelText="Cancel"
                variant="danger"
                overlayClassName="z-[60]"
            />

        </>
    );
}
