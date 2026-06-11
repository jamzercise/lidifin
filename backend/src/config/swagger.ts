import swaggerJsdoc from "swagger-jsdoc";
import { config } from "../config";

const options: swaggerJsdoc.Options = {
    definition: {
        openapi: "3.0.0",
        info: {
            title: "Lidifin API",
            version: "1.0.0",
            description:
                "Self-hosted music streaming server with Discover Weekly and full-text search. All documented paths are relative to /api. Username/password with JWT access + refresh tokens is the primary mobile authentication flow.",
            contact: {
                name: "Lidifin",
                url: "https://github.com/jamzercise/lidifin",
            },
        },
        servers: [
            {
                url: `http://localhost:${config.port}/api`,
                description: "Development API base path",
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    bearerFormat: "JWT",
                    description:
                        "Primary mobile authentication. Obtain with POST /auth/login and refresh with POST /auth/refresh.",
                },
                sessionAuth: {
                    type: "apiKey",
                    in: "cookie",
                    name: "connect.sid",
                    description: "Session cookie authentication (web UI)",
                },
                apiKeyAuth: {
                    type: "apiKey",
                    in: "header",
                    name: "X-API-Key",
                    description:
                        "Secondary device authentication for paired clients. Prefer bearerAuth for primary username/password login.",
                },
                streamTokenAuth: {
                    type: "apiKey",
                    in: "query",
                    name: "token",
                    description:
                        "Optional query-token auth for media URLs when attaching a Bearer header is inconvenient.",
                },
            },
            schemas: {
                User: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        username: { type: "string" },
                        role: { type: "string", enum: ["user", "admin"] },
                        createdAt: { type: "string", format: "date-time" },
                    },
                },
                Artist: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        mbid: { type: "string" },
                        name: { type: "string" },
                        heroUrl: { type: "string", nullable: true },
                        summary: { type: "string", nullable: true },
                    },
                },
                Album: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        rgMbid: { type: "string" },
                        artistId: { type: "string" },
                        title: { type: "string" },
                        year: { type: "integer", nullable: true },
                        coverUrl: { type: "string", nullable: true },
                        primaryType: { type: "string" },
                    },
                },
                Track: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        albumId: { type: "string" },
                        title: { type: "string" },
                        trackNo: { type: "integer" },
                        duration: { type: "integer" },
                        filePath: { type: "string" },
                    },
                },
                ApiKey: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        lastUsed: { type: "string", format: "date-time" },
                        createdAt: { type: "string", format: "date-time" },
                    },
                },
                Error: {
                    type: "object",
                    properties: {
                        error: { type: "string" },
                        message: { type: "string" },
                        details: {},
                    },
                },
                AuthTokens: {
                    type: "object",
                    required: ["token", "refreshToken", "user"],
                    properties: {
                        token: {
                            type: "string",
                            description: "Short-lived JWT access token",
                        },
                        refreshToken: {
                            type: "string",
                            description: "Longer-lived JWT refresh token",
                        },
                        user: {
                            $ref: "#/components/schemas/User",
                        },
                    },
                },
                Requires2FA: {
                    type: "object",
                    required: ["requires2FA", "message"],
                    properties: {
                        requires2FA: {
                            type: "boolean",
                            example: true,
                        },
                        message: {
                            type: "string",
                            example: "2FA token required",
                        },
                    },
                },
            },
        },
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }, { sessionAuth: [] }],
    },
    apis: ["./src/routes/**/*.ts", "./src/config/swaggerSchemas.ts"],
};

export const swaggerSpec = swaggerJsdoc(options);
