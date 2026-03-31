export interface PaginatedResponse<T> {
    total: number;
    offset: number;
    limit: number;
    nextCursor?: string | null;
    data: T[];
}

export interface ApiError {
    error: string;
    message?: string;
    details?: unknown;
}
