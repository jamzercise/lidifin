import { prisma } from "@/utils/db";
import { resolveTrackReferences } from "@/services/jellyfin";

const JF_PREFIX = "jellyfin:";

/**
 * Load tracks for a programmatic mix, preserving `trackIds` order.
 * Supports native Prisma `Track` ids and `jellyfin:` prefixed ids.
 */
export async function loadOrderedMixTracks(
    trackIds: string[]
): Promise<unknown[]> {
    if (trackIds.length === 0) return [];

    const jellyfinIds = trackIds.filter((id) => id.startsWith(JF_PREFIX));
    const nativeIds = trackIds.filter((id) => !id.startsWith(JF_PREFIX));

    const resolved =
        jellyfinIds.length > 0
            ? await resolveTrackReferences(jellyfinIds)
            : [];
    const jellyfinMap = new Map(
        jellyfinIds.map((id, i) => [id, resolved[i] ?? null])
    );

    const nativeRows =
        nativeIds.length > 0
            ? await prisma.track.findMany({
                  where: { id: { in: nativeIds } },
                  include: {
                      album: {
                          include: {
                              artist: {
                                  select: {
                                      id: true,
                                      name: true,
                                      mbid: true,
                                  },
                              },
                          },
                      },
                  },
              })
            : [];
    const nativeById = new Map(nativeRows.map((t) => [t.id, t]));

    return trackIds
        .map((id) => {
            if (id.startsWith(JF_PREFIX)) {
                const t = jellyfinMap.get(id);
                if (!t) return null;
                return {
                    id: t.id,
                    title: t.title,
                    duration: t.duration,
                    albumId: t.album.id,
                    album: {
                        title: t.album.title,
                        coverUrl: t.album.coverArt,
                        artist: t.artist,
                    },
                };
            }
            return nativeById.get(id) ?? null;
        })
        .filter(Boolean);
}
