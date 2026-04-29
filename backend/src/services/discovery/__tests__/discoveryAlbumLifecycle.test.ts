import { DiscoveryAlbumLifecycle, DiscoveryAlbumInfo, LidarrSettings } from '../discoveryAlbumLifecycle';
import { prisma } from '../../../utils/db';
import axios from 'axios';

jest.mock('../../../utils/db', () => ({
    prisma: {
        album: {
            findFirst: jest.fn(),
            delete: jest.fn(),
        },
        discoveryAlbum: {
            findMany: jest.fn(),
            update: jest.fn(),
        },
        track: {
            deleteMany: jest.fn(),
        },
        discoveryTrack: {
            deleteMany: jest.fn(),
        },
        unavailableAlbum: {
            deleteMany: jest.fn(),
        },
    },
}));

jest.mock('axios');

const mockAxios = axios as jest.Mocked<typeof axios>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

describe('DiscoveryAlbumLifecycle', () => {
    let lifecycle: DiscoveryAlbumLifecycle;

    beforeEach(() => {
        jest.clearAllMocks();
        lifecycle = new DiscoveryAlbumLifecycle();
    });

    describe('moveLikedAlbumToLibrary', () => {
        const mockAlbum: DiscoveryAlbumInfo = {
            id: 'discovery-album-1',
            rgMbid: 'rg-mbid-123',
            artistName: 'Test Artist',
            albumTitle: 'Test Album',
            lidarrAlbumId: 456,
        };

        // Post Arch-X.d: ownership lives in Jellyfin, not Album.location +
        // OwnedAlbum. The lifecycle no longer flips Album rows or upserts
        // ownership facts — it only marks the DiscoveryAlbum as MOVED so
        // the discover-weekly UI knows the user kept it.
        it('marks the discovery album as MOVED', async () => {
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'discovery-album-1' },
                data: { status: 'MOVED' },
            });
        });

        it('does not touch the Album table', async () => {
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.album.findFirst).not.toHaveBeenCalled();
            expect(mockPrisma.album.delete).not.toHaveBeenCalled();
        });

        it('propagates errors from the discoveryAlbum update', async () => {
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockRejectedValue(
                new Error('DB Error')
            );

            await expect(
                lifecycle.moveLikedAlbumToLibrary(mockAlbum)
            ).rejects.toThrow('DB Error');
        });
    });

    describe('deleteRejectedAlbum', () => {
        const mockAlbum: DiscoveryAlbumInfo = {
            id: 'discovery-album-1',
            rgMbid: 'rg-mbid-123',
            artistName: 'Test Artist',
            albumTitle: 'Test Album',
            lidarrAlbumId: 456,
        };

        const mockSettings: LidarrSettings = {
            lidarrEnabled: true,
            lidarrUrl: 'http://lidarr:8686',
            lidarrApiKey: 'test-api-key',
        };

        it('should delete from Lidarr when enabled', async () => {
            mockAxios.delete.mockResolvedValue({ status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockAxios.delete).toHaveBeenCalledWith(
                'http://lidarr:8686/api/v1/album/456',
                {
                    params: { deleteFiles: true },
                    headers: { 'X-Api-Key': 'test-api-key' },
                    timeout: 10000,
                }
            );
        });

        it('should skip Lidarr deletion when disabled', async () => {
            const disabledSettings: LidarrSettings = { lidarrEnabled: false };
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum, disabledSettings);

            expect(mockAxios.delete).not.toHaveBeenCalled();
        });

        it('should skip Lidarr deletion when album has no lidarrAlbumId', async () => {
            const albumWithoutLidarr: DiscoveryAlbumInfo = {
                ...mockAlbum,
                lidarrAlbumId: null,
            };
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumWithoutLidarr, mockSettings);

            expect(mockAxios.delete).not.toHaveBeenCalled();
        });

        it('should ignore Lidarr 404 errors', async () => {
            const error = { response: { status: 404 }, message: 'Not Found' };
            mockAxios.delete.mockRejectedValue(error);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await expect(
                lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings)
            ).resolves.not.toThrow();
        });

        it('should delete tracks and album from database', async () => {
            const dbAlbum = { id: 'album-db-1' };
            mockAxios.delete.mockResolvedValue({ status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.track.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.album.delete as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockPrisma.track.deleteMany).toHaveBeenCalledWith({
                where: { albumId: 'album-db-1' },
            });
            expect(mockPrisma.album.delete).toHaveBeenCalledWith({
                where: { id: 'album-db-1' },
            });
        });

        it('should delete discovery track records', async () => {
            mockAxios.delete.mockResolvedValue({ status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalledWith({
                where: { discoveryAlbumId: 'discovery-album-1' },
            });
        });

        it('should mark discovery album as DELETED', async () => {
            mockAxios.delete.mockResolvedValue({ status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings);

            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'discovery-album-1' },
                data: { status: 'DELETED' },
            });
        });

        it('should throw error when database operation fails', async () => {
            mockAxios.delete.mockResolvedValue({ status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockRejectedValue(new Error('DB Error'));

            await expect(
                lifecycle.deleteRejectedAlbum(mockAlbum, mockSettings)
            ).rejects.toThrow('DB Error');
        });
    });

    describe('processBeforeGeneration', () => {
        const userId = 'user-123';
        const mockSettings: LidarrSettings = {
            lidarrEnabled: true,
            lidarrUrl: 'http://lidarr:8686',
            lidarrApiKey: 'test-api-key',
        };

        it('should return early when no discovery albums exist', async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            const result = await lifecycle.processBeforeGeneration(userId, mockSettings);

            expect(result).toEqual({ moved: 0, deleted: 0 });
        });

        it('should process liked albums and mark them as MOVED', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'LIKED',
                    lidarrAlbumId: 100,
                },
            ];

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            const result = await lifecycle.processBeforeGeneration(userId, mockSettings);

            expect(result.moved).toBe(1);
            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'da-1' },
                data: { status: 'MOVED' },
            });
        });

        it('should process active albums and delete them', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'ACTIVE',
                    lidarrAlbumId: 100,
                },
            ];

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            mockAxios.delete.mockResolvedValue({ status: 200 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            const result = await lifecycle.processBeforeGeneration(userId, mockSettings);

            expect(result.deleted).toBe(1);
            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'da-1' },
                data: { status: 'DELETED' },
            });
        });

        it('should clean up unavailable albums for user', async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.processBeforeGeneration(userId, mockSettings);

            expect(mockPrisma.unavailableAlbum.deleteMany).toHaveBeenCalledWith({
                where: { userId },
            });
        });

        it('should continue processing even when individual album fails', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'LIKED',
                    lidarrAlbumId: 100,
                },
                {
                    id: 'da-2',
                    rgMbid: 'rg-2',
                    artistName: 'Artist 2',
                    albumTitle: 'Album 2',
                    status: 'LIKED',
                    lidarrAlbumId: 101,
                },
            ];

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            (mockPrisma.discoveryAlbum.update as jest.Mock)
                .mockRejectedValueOnce(new Error('DB Error'))
                .mockResolvedValueOnce({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            const result = await lifecycle.processBeforeGeneration(userId, mockSettings);

            expect(result.moved).toBe(1);
        });
    });
});
