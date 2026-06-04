import { ApiClient } from "./client";

export interface ReleaseRadarItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: "lidarr" | "similar";
    status: "upcoming" | "released" | "available";
    inLibrary: boolean;
    canDownload: boolean;
}

export interface ReleaseRadarResponse {
    upcoming: ReleaseRadarItem[];
    recent: ReleaseRadarItem[];
    monitoredArtistCount: number;
    similarArtistCount: number;
}

declare module "./client" {
    interface ApiClient {
        getReleaseRadar(params?: {
            daysBack?: number;
            daysAhead?: number;
        }): Promise<ReleaseRadarResponse>;
        downloadRelease(
            albumMbid: string,
            body: {
                artistName?: string;
                albumTitle?: string;
                artistMbid?: string;
            }
        ): Promise<{ message?: string; error?: string }>;
    }
}

ApiClient.prototype.getReleaseRadar = async function (
    this: ApiClient,
    params?: { daysBack?: number; daysAhead?: number }
) {
    const query = new URLSearchParams();
    if (params?.daysBack != null) query.set("daysBack", String(params.daysBack));
    if (params?.daysAhead != null) query.set("daysAhead", String(params.daysAhead));
    const qs = query.toString();
    return this.request(`/releases/radar${qs ? `?${qs}` : ""}`);
};

ApiClient.prototype.downloadRelease = async function (
    this: ApiClient,
    albumMbid: string,
    body: { artistName?: string; albumTitle?: string; artistMbid?: string }
) {
    return this.request(`/releases/download/${albumMbid}`, {
        method: "POST",
        body: JSON.stringify(body),
    });
};
