import { ApiClient, ApiData } from "./client";

declare module "./client" {
    interface ApiClient {
        getNotifications(): Promise<Array<{
            id: string;
            type: string;
            title: string;
            message: string | null;
            metadata: ApiData | null;
            read: boolean;
            cleared: boolean;
            createdAt: string;
        }>>;
        getUnreadNotificationCount(): Promise<{ count: number }>;
        markNotificationAsRead(id: string): Promise<{ success: boolean }>;
        markAllNotificationsAsRead(): Promise<{ success: boolean }>;
        clearNotification(id: string): Promise<{ success: boolean }>;
        clearAllNotifications(): Promise<{ success: boolean }>;
        getActiveDownloads(): Promise<Array<{
            id: string;
            subject: string;
            type: string;
            status: string;
            createdAt: string;
            error?: string;
        }>>;
        getDownloadHistory(): Promise<Array<{
            id: string;
            subject: string;
            type: string;
            status: string;
            error?: string;
            createdAt: string;
            completedAt?: string;
        }>>;
        clearDownloadFromHistory(id: string): Promise<{ success: boolean }>;
        clearAllDownloadHistory(): Promise<{ success: boolean }>;
        retryFailedDownload(id: string): Promise<{ success: boolean; newJobId?: string }>;
        getHomepageGenres(limit?: number): Promise<ApiData[]>;
    }
}

ApiClient.prototype.getNotifications = async function (this: ApiClient) {
    return this.get("/notifications");
};

ApiClient.prototype.getUnreadNotificationCount = async function (this: ApiClient) {
    return this.get("/notifications/unread-count");
};

ApiClient.prototype.markNotificationAsRead = async function (this: ApiClient, id: string) {
    return this.post(`/notifications/${id}/read`);
};

ApiClient.prototype.markAllNotificationsAsRead = async function (this: ApiClient) {
    return this.post("/notifications/read-all");
};

ApiClient.prototype.clearNotification = async function (this: ApiClient, id: string) {
    return this.post(`/notifications/${id}/clear`);
};

ApiClient.prototype.clearAllNotifications = async function (this: ApiClient) {
    return this.post("/notifications/clear-all");
};

ApiClient.prototype.getActiveDownloads = async function (this: ApiClient) {
    return this.get("/notifications/downloads/active");
};

ApiClient.prototype.getDownloadHistory = async function (this: ApiClient) {
    return this.get("/notifications/downloads/history");
};

ApiClient.prototype.clearDownloadFromHistory = async function (this: ApiClient, id: string) {
    return this.post(`/notifications/downloads/${id}/clear`);
};

ApiClient.prototype.clearAllDownloadHistory = async function (this: ApiClient) {
    return this.post("/notifications/downloads/clear-all");
};

ApiClient.prototype.retryFailedDownload = async function (this: ApiClient, id: string) {
    return this.post(`/notifications/downloads/${id}/retry`);
};

ApiClient.prototype.getHomepageGenres = async function (this: ApiClient, limit = 4) {
    return this.request(`/homepage/genres?limit=${limit}`);
};
