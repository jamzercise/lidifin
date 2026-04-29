/**
 * Service wrapper around the `SavedDiscoveryAlbum` table introduced in
 * Arch-X.c.
 *
 * Purpose:
 *   - Replace the historical pattern of writing `Album.location =
 *     DISCOVER` rows during artist enrichment, which conflated owned
 *     content with transient browse-state in a single table.
 *   - Provide a tiny, intention-revealing API for the upcoming "save for
 *     later" UI so route handlers don't construct ad-hoc Prisma queries
 *     and accidentally drift on uniqueness or snapshot-field semantics.
 *
 * Identity contract:
 *   `(userId, rgMbid)` is unique. `rgMbid` is the MusicBrainz release
 *   group MBID — the same identifier the artist enrichment endpoint
 *   passes back to the frontend for discovery items, so callers don't
 *   have to translate ids when wiring a save button.
 *
 * Snapshot fields:
 *   `artistName`, `albumTitle`, `coverUrl`, and `artistMbid` are
 *   intentionally denormalized at save time so the saved-list view
 *   renders without round-tripping to MusicBrainz/Last.fm. They are
 *   refreshed when the same album is re-saved (upsert path) but are
 *   otherwise treated as immutable display snapshots.
 */

import { prisma } from "../utils/db";
import type { SavedDiscoveryAlbum } from "@prisma/client";

export interface SaveDiscoveryAlbumInput {
    userId: string;
    rgMbid: string;
    artistName: string;
    albumTitle: string;
    artistMbid?: string | null;
    coverUrl?: string | null;
    /**
     * Where the user saved from — e.g. "artist-page", "search",
     * "discover". Stringly-typed on purpose so new entry points don't
     * require schema migrations. Optional; absent means "unspecified".
     */
    source?: string | null;
}

/**
 * Validates the rgMbid shape. We accept any non-empty string here rather
 * than enforcing the canonical 36-char UUID with hyphens because some
 * upstream feeds (Last.fm in particular) hand back lowercase / unhyphened
 * variants and the Album table tolerates the same set today. The unique
 * index handles dedupe across whichever variant the caller persisted.
 */
function assertRgMbid(rgMbid: string): void {
    if (typeof rgMbid !== "string" || rgMbid.trim().length === 0) {
        throw new Error(
            `[SavedDiscoveryAlbum] rgMbid must be a non-empty string, got ${JSON.stringify(rgMbid)}`
        );
    }
}

function assertUserId(userId: string): void {
    if (typeof userId !== "string" || userId.trim().length === 0) {
        throw new Error(
            `[SavedDiscoveryAlbum] userId must be a non-empty string`
        );
    }
}

/**
 * Persist a "save for later" bookmark. Idempotent: re-saving the same
 * album for the same user refreshes the snapshot fields and the
 * `savedAt` timestamp, treating each save as a deliberate user action.
 *
 * Returns the persisted row (post-upsert), so the caller can surface
 * `savedAt` immediately in the response without a second query.
 */
export async function saveDiscoveryAlbum(
    input: SaveDiscoveryAlbumInput
): Promise<SavedDiscoveryAlbum> {
    assertUserId(input.userId);
    assertRgMbid(input.rgMbid);

    const now = new Date();

    return prisma.savedDiscoveryAlbum.upsert({
        where: {
            userId_rgMbid: {
                userId: input.userId,
                rgMbid: input.rgMbid,
            },
        },
        create: {
            userId: input.userId,
            rgMbid: input.rgMbid,
            artistName: input.artistName,
            albumTitle: input.albumTitle,
            artistMbid: input.artistMbid ?? null,
            coverUrl: input.coverUrl ?? null,
            source: input.source ?? null,
            savedAt: now,
        },
        update: {
            artistName: input.artistName,
            albumTitle: input.albumTitle,
            artistMbid: input.artistMbid ?? null,
            coverUrl: input.coverUrl ?? null,
            source: input.source ?? null,
            savedAt: now,
        },
    });
}

/**
 * Remove a saved bookmark. Returns true when a row was deleted, false
 * when no matching row existed (so the caller can render an idempotent
 * unsave UI without fetching first).
 */
export async function unsaveDiscoveryAlbum(
    userId: string,
    rgMbid: string
): Promise<boolean> {
    assertUserId(userId);
    assertRgMbid(rgMbid);

    const result = await prisma.savedDiscoveryAlbum.deleteMany({
        where: { userId, rgMbid },
    });
    return result.count > 0;
}

/**
 * List a user's saved discovery albums, newest-saved first. The
 * `@@index([userId, savedAt])` index makes this a single index scan; we
 * page with `skip` / `take` rather than cursor pagination because the
 * surface is bounded (a user's bookmarks, not a full library scan) and
 * cursor semantics over a re-saveable list are surprising.
 */
export async function listSavedDiscoveryAlbums(
    userId: string,
    options: { skip?: number; take?: number } = {}
): Promise<SavedDiscoveryAlbum[]> {
    assertUserId(userId);
    const skip = Math.max(0, options.skip ?? 0);
    const take = Math.max(1, Math.min(500, options.take ?? 100));

    return prisma.savedDiscoveryAlbum.findMany({
        where: { userId },
        orderBy: { savedAt: "desc" },
        skip,
        take,
    });
}

/**
 * Returns true when the user has saved the album. Cheap point-lookup on
 * the unique `(userId, rgMbid)` index — used by the artist + album
 * detail handlers to decide whether to render "Save" vs. "Saved".
 */
export async function isDiscoveryAlbumSaved(
    userId: string,
    rgMbid: string
): Promise<boolean> {
    assertUserId(userId);
    assertRgMbid(rgMbid);

    const found = await prisma.savedDiscoveryAlbum.findUnique({
        where: { userId_rgMbid: { userId, rgMbid } },
        select: { id: true },
    });
    return found !== null;
}

/**
 * Bulk membership check for an artist-detail or search-results view that
 * needs to decorate many albums at once. Returns the set of `rgMbid`
 * values the user has saved among the input list, so the caller can do
 * an O(N) scan instead of N point queries. Empty input short-circuits
 * to an empty Set without hitting Prisma.
 */
export async function pickSavedRgMbids(
    userId: string,
    rgMbids: string[]
): Promise<Set<string>> {
    assertUserId(userId);
    if (rgMbids.length === 0) {
        return new Set<string>();
    }

    const rows = await prisma.savedDiscoveryAlbum.findMany({
        where: {
            userId,
            rgMbid: { in: rgMbids },
        },
        select: { rgMbid: true },
    });

    return new Set(rows.map((r) => r.rgMbid));
}

/**
 * Total saved count for a user — used by the dashboard / nav badge.
 * Kept as a dedicated function (rather than `list().length`) so callers
 * don't accidentally pay the snapshot-field read cost when all they
 * needed was the count.
 */
export async function countSavedDiscoveryAlbums(userId: string): Promise<number> {
    assertUserId(userId);
    return prisma.savedDiscoveryAlbum.count({ where: { userId } });
}
