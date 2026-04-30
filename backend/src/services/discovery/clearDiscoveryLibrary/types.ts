import type { getSystemSettings } from "../../../utils/systemSettings";

export type ClearDiscoveryLibraryResult = {
    success: true;
    message: string;
    likedMoved: number;
    activeDeleted: number;
    orphanedAlbumsDeleted: number;
    lidarrArtistsRemoved: number;
};

/** System settings row after load; orchestrator requires non-null (same as prior behavior). */
export type ClearLibrarySettings = NonNullable<
    Awaited<ReturnType<typeof getSystemSettings>>
>;
