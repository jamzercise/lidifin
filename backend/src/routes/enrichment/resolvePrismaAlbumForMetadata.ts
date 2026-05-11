import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    getJellyfinConfig,
    getJellyfinItem,
    extractRgMbid,
    isJellyfinMusicSource,
} from "../../services/jellyfin";
import { normalizeArtistName } from "../../utils/artistNormalization";
import {
    getAlbumArtistsFromJellyfinItem,
    type JellyfinAlbumItemShape,
} from "../library/albumDetailHelpers";
import { resolvePrismaArtistIdForMetadataWrite } from "./resolvePrismaArtistForMetadata";

/**
 * Album pages use `jellyfin:UUID` while Prisma `Album.id` is a cuid cache key.
 * Metadata routes resolve to the Prisma row (creating a minimal cache row if needed).
 */
export async function resolvePrismaAlbumIdForMetadataWrite(
    idParam: string
): Promise<string | null> {
    const id = decodeURIComponent(idParam);

    const byPk = await prisma.album.findUnique({
        where: { id },
        select: { id: true },
    });
    if (byPk) return byPk.id;

    if (!id.startsWith("jellyfin:")) {
        return null;
    }

    if (!(await isJellyfinMusicSource())) {
        logger.warn(
            `[Metadata] Cannot resolve Jellyfin album ${id}: not Jellyfin music source`
        );
        return null;
    }

    const cfg = await getJellyfinConfig();
    if (!cfg) {
        logger.warn(
            `[Metadata] Cannot resolve Jellyfin album ${id}: no Jellyfin config`
        );
        return null;
    }

    const rawUuid = id.slice("jellyfin:".length);
    const item = await getJellyfinItem(cfg, rawUuid);
    if (!item || (item.Type !== "MusicAlbum" && item.Type !== "BoxSet")) {
        logger.warn(
            `[Metadata] Jellyfin item missing or not MusicAlbum/BoxSet: ${rawUuid}`
        );
        return null;
    }

    const shape = item as unknown as JellyfinAlbumItemShape;
    const rgFromProvider = extractRgMbid(shape.ProviderIds ?? undefined);
    const rgMbid =
        rgFromProvider && rgFromProvider.length > 0
            ? rgFromProvider
            : `temp-jellyfin-${rawUuid}`;

    const existingByRg = await prisma.album.findUnique({
        where: { rgMbid },
        select: { id: true },
    });
    if (existingByRg) return existingByRg.id;

    const credits = getAlbumArtistsFromJellyfinItem(shape);
    let artistId: string | null = null;
    if (credits.length > 0) {
        artistId = await resolvePrismaArtistIdForMetadataWrite(credits[0].id);
    }
    if (!artistId) {
        const placeholderMbid = `temp-jellyfin-album-${rawUuid}-artist`;
        try {
            const createdArtist = await prisma.artist.create({
                data: {
                    mbid: placeholderMbid,
                    name: "Unknown Artist",
                    normalizedName: normalizeArtistName("Unknown Artist"),
                },
                select: { id: true },
            });
            artistId = createdArtist.id;
        } catch (e: unknown) {
            const code =
                typeof e === "object" && e !== null && "code" in e
                    ? (e as { code?: string }).code
                    : undefined;
            if (code === "P2002") {
                const row = await prisma.artist.findUnique({
                    where: { mbid: placeholderMbid },
                    select: { id: true },
                });
                artistId = row?.id ?? null;
            }
            if (!artistId) {
                logger.error(
                    "[Metadata] Failed to create placeholder artist for album cache:",
                    e
                );
                return null;
            }
        }
    }

    const title =
        String(shape.Name ?? "").trim() && String(shape.Name ?? "").trim() !== rawUuid
            ? String(shape.Name).trim()
            : "Unknown Album";

    try {
        const created = await prisma.album.create({
            data: {
                rgMbid,
                artistId,
                title,
                year: shape.ProductionYear ?? null,
                primaryType: "Album",
            },
            select: { id: true },
        });
        logger.info(
            `[Metadata] Created Prisma album cache ${created.id} for library id ${id}`
        );
        return created.id;
    } catch (e: unknown) {
        const code =
            typeof e === "object" && e !== null && "code" in e
                ? (e as { code?: string }).code
                : undefined;
        if (code === "P2002") {
            const row = await prisma.album.findUnique({
                where: { rgMbid },
                select: { id: true },
            });
            if (row) return row.id;
        }
        logger.error("[Metadata] Failed to create Prisma album cache row:", e);
        return null;
    }
}
