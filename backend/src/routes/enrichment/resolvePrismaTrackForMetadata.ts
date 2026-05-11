import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    getJellyfinConfig,
    getJellyfinItem,
    isJellyfinMusicSource,
} from "../../services/jellyfin";
import { resolvePrismaAlbumIdForMetadataWrite } from "./resolvePrismaAlbumForMetadata";

/**
 * Library track ids may be `jellyfin:UUID` while Prisma `Track.id` is a cuid.
 * Metadata routes resolve via a stable synthetic `filePath` (`jellyfin:UUID`),
 * creating a minimal cache row when needed (Jellyfin-first libraries often have
 * no file-backed `Track` rows until overrides exist).
 */
export async function resolvePrismaTrackIdForMetadataWrite(
    idParam: string
): Promise<string | null> {
    const id = decodeURIComponent(idParam);

    const byPk = await prisma.track.findUnique({
        where: { id },
        select: { id: true },
    });
    if (byPk) return byPk.id;

    if (!id.startsWith("jellyfin:")) {
        return null;
    }

    if (!(await isJellyfinMusicSource())) {
        logger.warn(
            `[Metadata] Cannot resolve Jellyfin track ${id}: not Jellyfin music source`
        );
        return null;
    }

    const cfg = await getJellyfinConfig();
    if (!cfg) {
        logger.warn(
            `[Metadata] Cannot resolve Jellyfin track ${id}: no Jellyfin config`
        );
        return null;
    }

    const rawUuid = id.slice("jellyfin:".length);
    const filePath = `jellyfin:${rawUuid}`;

    const byPath = await prisma.track.findUnique({
        where: { filePath },
        select: { id: true },
    });
    if (byPath) return byPath.id;

    const item = await getJellyfinItem(cfg, rawUuid, "Audio");
    if (!item || item.Type !== "Audio") {
        logger.warn(
            `[Metadata] Jellyfin item missing or not Audio: ${rawUuid}`
        );
        return null;
    }

    if (!item.AlbumId) {
        logger.warn(`[Metadata] Jellyfin track has no AlbumId: ${rawUuid}`);
        return null;
    }

    const prismaAlbumId = await resolvePrismaAlbumIdForMetadataWrite(
        `jellyfin:${item.AlbumId}`
    );
    if (!prismaAlbumId) {
        return null;
    }

    const indexRaw = (item as { IndexNumber?: number }).IndexNumber;
    const trackNo =
        typeof indexRaw === "number" && indexRaw > 0 ? indexRaw : 1;
    const duration =
        item.RunTimeTicks != null
            ? Math.floor(item.RunTimeTicks / 10_000_000)
            : 0;
    const title =
        String(item.Name ?? "").trim() && String(item.Name ?? "").trim() !== rawUuid
            ? String(item.Name).trim()
            : "Unknown Track";

    try {
        const created = await prisma.track.create({
            data: {
                albumId: prismaAlbumId,
                title,
                trackNo,
                duration,
                filePath,
                fileModified: new Date(0),
                fileSize: 0,
            },
            select: { id: true },
        });
        logger.info(
            `[Metadata] Created Prisma track cache ${created.id} for library id ${id}`
        );
        return created.id;
    } catch (e: unknown) {
        const code =
            typeof e === "object" && e !== null && "code" in e
                ? (e as { code?: string }).code
                : undefined;
        if (code === "P2002") {
            const row = await prisma.track.findUnique({
                where: { filePath },
                select: { id: true },
            });
            if (row) return row.id;
        }
        logger.error("[Metadata] Failed to create Prisma track cache row:", e);
        return null;
    }
}
