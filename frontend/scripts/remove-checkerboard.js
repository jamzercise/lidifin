/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Remove checkerboard background from icon and make it transparent.
 * Checkerboard is typically white + light gray - we replace those with alpha.
 */

const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const SOURCE_ICON = path.join(__dirname, "..", "assets", "icon-only.png");

function isCheckerboardColor(r, g, b, tolerance = 15) {
    // White: rgb(255, 255, 255)
    const isWhite = Math.abs(r - 255) <= tolerance && Math.abs(g - 255) <= tolerance && Math.abs(b - 255) <= tolerance;
    // Light gray checkerboard: rgb(192,192,192) or rgb(204,204,204) or rgb(220,220,220)
    const isGray = r === g && g === b && r >= 170 && r <= 240;
    return isWhite || isGray;
}

async function removeCheckerboard() {
    if (!fs.existsSync(SOURCE_ICON)) {
        console.error(`Source icon not found: ${SOURCE_ICON}`);
        process.exit(1);
    }

    const { data, info } = await sharp(SOURCE_ICON)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const pixels = new Uint8Array(data);

    let replaced = 0;
    for (let i = 0; i < pixels.length; i += channels) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        if (isCheckerboardColor(r, g, b)) {
            pixels[i + 3] = 0;
            replaced++;
        }
    }

    const outputPath = path.join(__dirname, "..", "assets", "icon-only.png");
    await sharp(pixels, { raw: { width, height, channels } })
        .png()
        .toFile(outputPath);

    console.log(`✓ Removed checkerboard (${replaced} pixels made transparent)`);
    console.log(`✓ Saved: ${outputPath}`);
}

removeCheckerboard().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});
