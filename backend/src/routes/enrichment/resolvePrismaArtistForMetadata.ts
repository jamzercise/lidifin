import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    getJellyfinConfig,
    getJellyfinItem,
    extractArtistMbid,
    isJellyfinMusicSource,
} from "../../services/jellyfin";
import { normalizeArtistName } from "../../utils/artistNormalization";

/**
 * Artist pages use `jellyfin:UUID` while Prisma `Artist.id` is a cuid cache key.
 * Metadata routes must resolve to the Prisma row (creating a minimal cache row if needed).
 */
export async function resolvePrismaArtistIdForMetadataWrite(
    idParam: string
): Promise<string | null> {
    const id = decodeURIComponent(idParam);

    const byPk = await prisma.artist.findUnique({
        where: { id },
        select: { id: true },
    });
    if (byPk) return byPk.id;

    if (!id.startsWith("jellyfin:")) {
        return null;
    }

    if (!(await isJellyfinMusicSource())) {
        logger.warn(
            `[Metadata] Cannot resolve Jellyfin artist ${id}: not Jellyfin music source`
        );
        return null;
    }

    const cfg = await getJellyfinConfig();
    if (!cfg) {
        logger.warn(
            `[Metadata] Cannot resolve Jellyfin artist ${id}: no Jellyfin config`
        );
        return null;
    }

    const rawUuid = id.slice("jellyfin:".length);
    const item = await getJellyfinItem(cfg, rawUuid);
    if (!item || item.Type !== "MusicArtist") {
        logger.warn(
            `[Metadata] Jellyfin item missing or not MusicArtist: ${rawUuid}`
        );
        return null;
    }

    const jfMbid =
        extractArtistMbid(
            (item as { ProviderIds?: Record<string, string | null> })
                .ProviderIds
        ) ?? null;
    const rawName =
        (item as { Name?: string }).Name ??
        (item as { name?: string }).name ??
        "";
    const name =
        String(rawName).trim() && String(rawName).trim() !== rawUuid
            ? String(rawName).trim()
            : "Unknown Artist";
    const normalized = normalizeArtistName(name);

    const existing = await prisma.artist.findFirst({
        where: {
            OR: [
                ...(jfMbid ? [{ mbid: jfMbid }] : []),
                { normalizedName: normalized },
            ],
        },
        select: { id: true },
    });
    if (existing) return existing.id;

    const mbidForCreate =
        jfMbid && jfMbid.length > 0 ? jfMbid : `temp-jellyfin-${rawUuid}`;

    try {
        const created = await prisma.artist.create({
            data: {
                mbid: mbidForCreate,
                name,
                normalizedName: normalized,
            },
            select: { id: true },
        });
        logger.info(
            `[Metadata] Created Prisma artist cache ${created.id} for library id ${id}`
        );
        return created.id;
    } catch (e: unknown) {
        const code =
            typeof e === "object" && e !== null && "code" in e
                ? (e as { code?: string }).code
                : undefined;
        if (code === "P2002") {
            const row = await prisma.artist.findUnique({
                where: { mbid: mbidForCreate },
                select: { id: true },
            });
            if (row) return row.id;
        }
        logger.error("[Metadata] Failed to create Prisma artist cache row:", e);
        return null;
    }
}
