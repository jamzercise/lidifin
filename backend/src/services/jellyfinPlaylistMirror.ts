/**
 * Mirroring generated playlists into Jellyfin.
 *
 * A playlist Lidifin builds for itself — from a playlist import, or a Discovery
 * batch — is only rows in Lidifin's database pointing at Jellyfin items. That
 * plays fine here but is invisible in every other Jellyfin client, and it dies
 * with Lidifin's database. Playlists created by hand are already pushed across
 * by the playlist routes; this gives the generated ones the same treatment.
 *
 * Every step is best effort. A playlist that Jellyfin refuses is still a
 * perfectly good Lidifin playlist, and the next sync will try again.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    addToJellyfinPlaylist,
    createJellyfinPlaylist,
    getJellyfinConfig,
    getJellyfinPlaylistItems,
} from "./jellyfin";

const JELLYFIN_ID_PREFIX = "jellyfin:";

/** The Jellyfin item ids among a mix of Lidifin and Jellyfin track ids. */
function toJellyfinItemIds(trackIds: string[]): string[] {
    return trackIds
        .filter((id) => id.startsWith(JELLYFIN_ID_PREFIX))
        .map((id) => id.slice(JELLYFIN_ID_PREFIX.length));
}

/**
 * Bring the Jellyfin copy of a playlist in line with Lidifin's, creating it if
 * it doesn't exist yet.
 *
 * Safe to call repeatedly and at any point in a playlist's life. Tracks that
 * only resolve later — a download that lands days after the import — reach
 * Jellyfin by calling this again, including when the playlist matched nothing
 * at first and so has no Jellyfin copy yet.
 */
export async function syncPlaylistToJellyfin(playlistId: string): Promise<void> {
    try {
        const cfg = await getJellyfinConfig();
        if (!cfg) return;

        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
            select: {
                name: true,
                jellyfinPlaylistId: true,
                items: {
                    select: { trackId: true },
                    orderBy: { sort: "asc" },
                },
            },
        });
        if (!playlist) return;

        const itemIds = toJellyfinItemIds(
            playlist.items.map((item) => item.trackId)
        );
        // Nothing Jellyfin can hold. True for a native library, where track ids
        // are Lidifin's own, and for a playlist whose songs are all still
        // pending.
        if (itemIds.length === 0) return;

        if (!playlist.jellyfinPlaylistId) {
            const created = await createJellyfinPlaylist(
                cfg,
                playlist.name,
                itemIds
            );
            if (!created) return;

            await prisma.playlist.update({
                where: { id: playlistId },
                data: { jellyfinPlaylistId: created },
            });
            logger.debug(
                `[JellyfinPlaylist] Mirrored "${playlist.name}" to Jellyfin with ${itemIds.length} track(s)`
            );
            return;
        }

        // Add only what Jellyfin is missing, so repeat calls don't duplicate
        // entries in a playlist the user may also have edited over there.
        const existing = await getJellyfinPlaylistItems(
            cfg,
            playlist.jellyfinPlaylistId
        );
        const alreadyThere = new Set(existing.map((item) => item.itemId));
        const missing = itemIds.filter((id) => !alreadyThere.has(id));
        if (missing.length === 0) return;

        await addToJellyfinPlaylist(
            cfg,
            playlist.jellyfinPlaylistId,
            missing
        );
        logger.debug(
            `[JellyfinPlaylist] Added ${missing.length} track(s) to "${playlist.name}" in Jellyfin`
        );
    } catch (err: any) {
        logger.warn(
            `[JellyfinPlaylist] Sync failed for playlist ${playlistId} (non-fatal):`,
            err?.message
        );
    }
}
