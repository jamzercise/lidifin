import { prisma } from "../../utils/db";
import {
    getJellyfinConfig,
    getJellyfinPlaylistItems,
} from "../../services/jellyfin";

/**
 * Sync Jellyfin playlist items to DB in background (Option D).
 */
export async function syncJellyfinPlaylistToDb(
    playlistId: string,
    jellyfinPlaylistId: string,
): Promise<void> {
    const cfg = await getJellyfinConfig();
    if (!cfg) return;
    const items = await getJellyfinPlaylistItems(cfg, jellyfinPlaylistId);
    for (let i = 0; i < items.length; i++) {
        const trackId = `jellyfin:${items[i].itemId}`;
        await prisma.playlistItem.upsert({
            where: {
                playlistId_trackId: { playlistId, trackId },
            },
            create: { playlistId, trackId, sort: i },
            update: { sort: i },
        });
    }
    const currentTrackIds = new Set(items.map((it) => `jellyfin:${it.itemId}`));
    await prisma.playlistItem.deleteMany({
        where: {
            playlistId,
            trackId: { notIn: Array.from(currentTrackIds) },
        },
    });
}
