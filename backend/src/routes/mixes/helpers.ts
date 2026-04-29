import { resolveTrackReferences } from "../../services/jellyfin";

export function getRequestUserId(req: {
    user?: { id?: string };
}): string | null {
    return req.user?.id ?? null;
}

/** Format resolved Jellyfin tracks for AudioMuse API responses */
export async function resolveAndFormatTracks(itemIds: string[]) {
    const trackIds = itemIds.map((id) => `jellyfin:${id}`);
    const resolved = await resolveTrackReferences(trackIds);
    return resolved
        .map((t) =>
            t
                ? {
                      id: t.id,
                      title: t.title,
                      duration: t.duration,
                      artist: t.artist,
                      album: {
                          id: t.album.id,
                          title: t.album.title,
                          coverUrl: t.album.coverArt,
                          coverArt: t.album.coverArt,
                      },
                  }
                : null,
        )
        .filter(Boolean);
}
