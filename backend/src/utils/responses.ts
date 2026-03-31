import { Response } from "express";

export function sendSuccess(res: Response, data: unknown, status = 200): void {
    res.status(status).json(data);
}

export function sendError(
    res: Response,
    message: string,
    status = 500,
    extras?: Record<string, unknown>
): void {
    res.status(status).json({ error: message, ...extras });
}

export function sendBadRequest(res: Response, message: string): void {
    sendError(res, message, 400);
}

export function sendUnauthorized(res: Response, message = "Unauthorized"): void {
    sendError(res, message, 401);
}

export function sendNotFound(res: Response, entity = "Resource"): void {
    sendError(res, `${entity} not found`, 404);
}

export function sendConflict(res: Response, message: string, extras?: Record<string, unknown>): void {
    sendError(res, message, 409, extras);
}
