import { prisma } from "../../utils/db";
import {
    countSavedDiscoveryAlbums,
    isDiscoveryAlbumSaved,
    listSavedDiscoveryAlbums,
    pickSavedRgMbids,
    saveDiscoveryAlbum,
    unsaveDiscoveryAlbum,
} from "../savedDiscoveryAlbumService";

jest.mock("../../utils/db", () => ({
    prisma: {
        savedDiscoveryAlbum: {
            upsert: jest.fn(),
            deleteMany: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            count: jest.fn(),
        },
    },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const ops = mockPrisma.savedDiscoveryAlbum as unknown as {
    upsert: jest.Mock;
    deleteMany: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
};

const USER = "user_abc123";
const ALBUM_MBID = "11111111-2222-3333-4444-555555555555";
const ALBUM_MBID_2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeEach(() => {
    jest.clearAllMocks();
});

describe("saveDiscoveryAlbum", () => {
    it("validates that userId is a non-empty string", async () => {
        await expect(
            saveDiscoveryAlbum({
                userId: "",
                rgMbid: ALBUM_MBID,
                artistName: "X",
                albumTitle: "Y",
            })
        ).rejects.toThrow(/userId/);

        expect(ops.upsert).not.toHaveBeenCalled();
    });

    it("validates that rgMbid is a non-empty string", async () => {
        await expect(
            saveDiscoveryAlbum({
                userId: USER,
                rgMbid: "   ",
                artistName: "X",
                albumTitle: "Y",
            })
        ).rejects.toThrow(/rgMbid/);

        expect(ops.upsert).not.toHaveBeenCalled();
    });

    it("upserts with the unique (userId, rgMbid) key", async () => {
        ops.upsert.mockResolvedValue({ id: "saved_1" });

        await saveDiscoveryAlbum({
            userId: USER,
            rgMbid: ALBUM_MBID,
            artistName: "Hold Steady",
            albumTitle: "Boys and Girls in America",
            artistMbid: "artist-mbid",
            coverUrl: "https://cdn.example/x.jpg",
            source: "artist-page",
        });

        expect(ops.upsert).toHaveBeenCalledTimes(1);
        const call = ops.upsert.mock.calls[0][0];
        expect(call.where).toEqual({
            userId_rgMbid: { userId: USER, rgMbid: ALBUM_MBID },
        });
        expect(call.create).toMatchObject({
            userId: USER,
            rgMbid: ALBUM_MBID,
            artistName: "Hold Steady",
            albumTitle: "Boys and Girls in America",
            artistMbid: "artist-mbid",
            coverUrl: "https://cdn.example/x.jpg",
            source: "artist-page",
        });
        expect(call.create.savedAt).toBeInstanceOf(Date);
    });

    it("normalizes optional fields to null when omitted", async () => {
        ops.upsert.mockResolvedValue({ id: "saved_2" });

        await saveDiscoveryAlbum({
            userId: USER,
            rgMbid: ALBUM_MBID,
            artistName: "Hold Steady",
            albumTitle: "Stay Positive",
        });

        const call = ops.upsert.mock.calls[0][0];
        expect(call.create.artistMbid).toBeNull();
        expect(call.create.coverUrl).toBeNull();
        expect(call.create.source).toBeNull();
        expect(call.update.artistMbid).toBeNull();
        expect(call.update.coverUrl).toBeNull();
        expect(call.update.source).toBeNull();
    });

    it("refreshes savedAt and snapshot fields on re-save (update path)", async () => {
        ops.upsert.mockResolvedValue({ id: "saved_3" });

        await saveDiscoveryAlbum({
            userId: USER,
            rgMbid: ALBUM_MBID,
            artistName: "New Display Name",
            albumTitle: "New Title",
            coverUrl: "new.jpg",
        });

        const call = ops.upsert.mock.calls[0][0];
        expect(call.update).toMatchObject({
            artistName: "New Display Name",
            albumTitle: "New Title",
            coverUrl: "new.jpg",
        });
        expect(call.update.savedAt).toBeInstanceOf(Date);
    });

    it("returns the persisted row from the upsert", async () => {
        const row = { id: "saved_4", userId: USER, rgMbid: ALBUM_MBID };
        ops.upsert.mockResolvedValue(row);

        const result = await saveDiscoveryAlbum({
            userId: USER,
            rgMbid: ALBUM_MBID,
            artistName: "X",
            albumTitle: "Y",
        });

        expect(result).toBe(row);
    });
});

describe("unsaveDiscoveryAlbum", () => {
    it("validates inputs before hitting Prisma", async () => {
        await expect(unsaveDiscoveryAlbum("", ALBUM_MBID)).rejects.toThrow(/userId/);
        await expect(unsaveDiscoveryAlbum(USER, "")).rejects.toThrow(/rgMbid/);
        expect(ops.deleteMany).not.toHaveBeenCalled();
    });

    it("returns true when a row was deleted", async () => {
        ops.deleteMany.mockResolvedValue({ count: 1 });

        const result = await unsaveDiscoveryAlbum(USER, ALBUM_MBID);

        expect(result).toBe(true);
        expect(ops.deleteMany).toHaveBeenCalledWith({
            where: { userId: USER, rgMbid: ALBUM_MBID },
        });
    });

    it("returns false when no row matched (idempotent)", async () => {
        ops.deleteMany.mockResolvedValue({ count: 0 });

        const result = await unsaveDiscoveryAlbum(USER, ALBUM_MBID);

        expect(result).toBe(false);
    });
});

describe("listSavedDiscoveryAlbums", () => {
    it("returns rows ordered by savedAt desc", async () => {
        const rows = [
            { id: "a", savedAt: new Date("2026-04-29") },
            { id: "b", savedAt: new Date("2026-04-28") },
        ];
        ops.findMany.mockResolvedValue(rows);

        const result = await listSavedDiscoveryAlbums(USER);

        expect(result).toBe(rows);
        expect(ops.findMany).toHaveBeenCalledWith({
            where: { userId: USER },
            orderBy: { savedAt: "desc" },
            skip: 0,
            take: 100,
        });
    });

    it("clamps take to a reasonable upper bound", async () => {
        ops.findMany.mockResolvedValue([]);

        await listSavedDiscoveryAlbums(USER, { take: 9999 });

        expect(ops.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 500 })
        );
    });

    it("clamps take to at least 1 when given non-positive values", async () => {
        ops.findMany.mockResolvedValue([]);

        await listSavedDiscoveryAlbums(USER, { take: 0 });

        expect(ops.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 1 })
        );
    });

    it("clamps skip to zero when given negative values", async () => {
        ops.findMany.mockResolvedValue([]);

        await listSavedDiscoveryAlbums(USER, { skip: -5 });

        expect(ops.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ skip: 0 })
        );
    });
});

describe("isDiscoveryAlbumSaved", () => {
    it("returns true when the unique row exists", async () => {
        ops.findUnique.mockResolvedValue({ id: "saved_x" });

        await expect(isDiscoveryAlbumSaved(USER, ALBUM_MBID)).resolves.toBe(true);

        expect(ops.findUnique).toHaveBeenCalledWith({
            where: { userId_rgMbid: { userId: USER, rgMbid: ALBUM_MBID } },
            select: { id: true },
        });
    });

    it("returns false when no row exists", async () => {
        ops.findUnique.mockResolvedValue(null);

        await expect(isDiscoveryAlbumSaved(USER, ALBUM_MBID)).resolves.toBe(false);
    });
});

describe("pickSavedRgMbids", () => {
    it("short-circuits without hitting Prisma when input is empty", async () => {
        const result = await pickSavedRgMbids(USER, []);

        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(0);
        expect(ops.findMany).not.toHaveBeenCalled();
    });

    it("returns the saved subset of input rgMbids", async () => {
        ops.findMany.mockResolvedValue([
            { rgMbid: ALBUM_MBID },
            { rgMbid: ALBUM_MBID_2 },
        ]);

        const result = await pickSavedRgMbids(USER, [
            ALBUM_MBID,
            ALBUM_MBID_2,
            "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb",
        ]);

        expect(result.has(ALBUM_MBID)).toBe(true);
        expect(result.has(ALBUM_MBID_2)).toBe(true);
        expect(result.has("ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb")).toBe(false);
        expect(ops.findMany).toHaveBeenCalledWith({
            where: {
                userId: USER,
                rgMbid: {
                    in: [
                        ALBUM_MBID,
                        ALBUM_MBID_2,
                        "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb",
                    ],
                },
            },
            select: { rgMbid: true },
        });
    });
});

describe("countSavedDiscoveryAlbums", () => {
    it("delegates to prisma.count with the userId filter", async () => {
        ops.count.mockResolvedValue(7);

        await expect(countSavedDiscoveryAlbums(USER)).resolves.toBe(7);

        expect(ops.count).toHaveBeenCalledWith({ where: { userId: USER } });
    });

    it("validates the userId argument", async () => {
        await expect(countSavedDiscoveryAlbums("")).rejects.toThrow(/userId/);
    });
});
