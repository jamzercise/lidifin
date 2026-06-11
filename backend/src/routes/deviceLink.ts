import { Router } from "express";
import { logger } from "../utils/logger";
import { requirePrimaryAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import crypto from "crypto";

const router = Router();

// Generate a random 6-character alphanumeric code
function generateLinkCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude similar looking chars
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Generate API key
function generateApiKey(): string {
    return crypto.randomBytes(32).toString("hex");
}

/**
 * @openapi
 * /device-link/generate:
 *   post:
 *     summary: Generate a short-lived device link code
 *     description: Secondary mobile pairing flow. Use bearerAuth or sessionAuth from an already signed-in user to mint a one-time code that another device can verify.
 *     tags: [Device Link]
 *     security:
 *       - bearerAuth: []
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Device code created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: string
 *                   example: AB12CD
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 expiresIn:
 *                   type: integer
 *                   example: 300
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /device-link/generate - Generate a new device link code (requires auth)
router.post("/generate", requirePrimaryAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        // Delete any existing unused codes for this user
        await prisma.deviceLinkCode.deleteMany({
            where: {
                userId,
                usedAt: null,
            },
        });

        // Generate a unique code
        let code: string;
        let attempts = 0;
        do {
            code = generateLinkCode();
            attempts++;
            if (attempts > 10) {
                return res.status(500).json({ error: "Failed to generate unique code" });
            }
        } while (
            await prisma.deviceLinkCode.findUnique({
                where: { code },
            })
        );

        // Create the code with 5-minute expiry
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        const linkCode = await prisma.deviceLinkCode.create({
            data: {
                code,
                userId,
                expiresAt,
            },
        });

        res.json({
            code: linkCode.code,
            expiresAt: linkCode.expiresAt,
            expiresIn: 300, // 5 minutes in seconds
        });
    } catch (error) {
        logger.error("Generate device link code error:", error);
        res.status(500).json({ error: "Failed to generate device link code" });
    }
});

/**
 * @openapi
 * /device-link/verify:
 *   post:
 *     summary: Exchange a device link code for an API key
 *     description: Optional paired-device flow for clients that should keep using an API key after the interactive login completes elsewhere.
 *     tags: [Device Link]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *             properties:
 *               code:
 *                 type: string
 *                 example: AB12CD
 *               deviceName:
 *                 type: string
 *                 example: Pixel 9
 *     responses:
 *       200:
 *         description: Device linked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 apiKey:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 username:
 *                   type: string
 *       400:
 *         description: Invalid, expired, or already used code
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Code not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /device-link/verify - Verify a code and get API key (no auth required)
router.post("/verify", async (req, res) => {
    try {
        const { code, deviceName } = req.body;

        if (!code || typeof code !== "string") {
            return res.status(400).json({ error: "Code is required" });
        }

        // Find the code
        const linkCode = await prisma.deviceLinkCode.findUnique({
            where: { code: code.toUpperCase() },
            include: { user: true },
        });

        if (!linkCode) {
            return res.status(404).json({ error: "Invalid code" });
        }

        if (linkCode.usedAt) {
            return res.status(400).json({ error: "Code already used" });
        }

        if (new Date() > linkCode.expiresAt) {
            return res.status(400).json({ error: "Code expired" });
        }

        // Generate API key for this device
        const apiKey = generateApiKey();
        const createdApiKey = await prisma.apiKey.create({
            data: {
                userId: linkCode.userId,
                key: apiKey,
                name: deviceName || "Mobile Device",
            },
        });

        // Mark the link code as used
        await prisma.deviceLinkCode.update({
            where: { id: linkCode.id },
            data: {
                usedAt: new Date(),
                deviceName: deviceName || "Mobile Device",
                apiKeyId: createdApiKey.id,
            },
        });

        res.json({
            success: true,
            apiKey,
            userId: linkCode.userId,
            username: linkCode.user.username,
        });
    } catch (error) {
        logger.error("Verify device link code error:", error);
        res.status(500).json({ error: "Failed to verify device link code" });
    }
});

/**
 * @openapi
 * /device-link/status/{code}:
 *   get:
 *     summary: Poll the status of a device link code
 *     tags: [Device Link]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Current status for the device link code
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [pending, used, expired]
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 usedAt:
 *                   type: string
 *                   format: date-time
 *                 deviceName:
 *                   type: string
 *       404:
 *         description: Code not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /device-link/status/:code - Poll for code usage status (no auth required)
router.get("/status/:code", async (req, res) => {
    try {
        const { code } = req.params;

        const linkCode = await prisma.deviceLinkCode.findUnique({
            where: { code: code.toUpperCase() },
        });

        if (!linkCode) {
            return res.status(404).json({ error: "Invalid code" });
        }

        if (new Date() > linkCode.expiresAt && !linkCode.usedAt) {
            return res.json({
                status: "expired",
                expiresAt: linkCode.expiresAt,
            });
        }

        if (linkCode.usedAt) {
            return res.json({
                status: "used",
                usedAt: linkCode.usedAt,
                deviceName: linkCode.deviceName,
            });
        }

        res.json({
            status: "pending",
            expiresAt: linkCode.expiresAt,
        });
    } catch (error) {
        logger.error("Check device link status error:", error);
        res.status(500).json({ error: "Failed to check status" });
    }
});

/**
 * @openapi
 * /device-link/devices:
 *   get:
 *     summary: List linked devices for the current user
 *     tags: [Device Link]
 *     security:
 *       - bearerAuth: []
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Linked devices
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ApiKey'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /device-link/devices - List linked devices (requires auth)
router.get("/devices", requirePrimaryAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        const apiKeys = await prisma.apiKey.findMany({
            where: { userId },
            orderBy: { lastUsed: "desc" },
            select: {
                id: true,
                name: true,
                lastUsed: true,
                createdAt: true,
            },
        });

        res.json(apiKeys);
    } catch (error) {
        logger.error("Get devices error:", error);
        res.status(500).json({ error: "Failed to get devices" });
    }
});

/**
 * @openapi
 * /device-link/devices/{id}:
 *   delete:
 *     summary: Revoke a linked device
 *     tags: [Device Link]
 *     security:
 *       - bearerAuth: []
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Device revoked successfully
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Device not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// DELETE /device-link/devices/:id - Revoke a device (requires auth)
router.delete("/devices/:id", requirePrimaryAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id } = req.params;

        const apiKey = await prisma.apiKey.findFirst({
            where: { id, userId },
        });

        if (!apiKey) {
            return res.status(404).json({ error: "Device not found" });
        }

        await prisma.apiKey.delete({
            where: { id },
        });

        res.json({ success: true });
    } catch (error) {
        logger.error("Revoke device error:", error);
        res.status(500).json({ error: "Failed to revoke device" });
    }
});

export default router;















