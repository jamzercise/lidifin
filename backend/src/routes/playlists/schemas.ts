import { z } from "zod";

export const createPlaylistSchema = z.object({
    name: z.string().min(1).max(200),
    isPublic: z.boolean().optional().default(false),
});

export const updatePlaylistSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        isPublic: z.boolean().optional(),
    })
    .refine(
        (value) => value.name !== undefined || value.isPublic !== undefined,
        {
            message: "At least one field is required",
        },
    );

export const addTrackSchema = z.object({
    trackId: z.string(),
});
