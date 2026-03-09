/**
 * Mix Cover Service
 *
 * Generates cover images for Made For You mixes using:
 * - Option 2 (Primary): Deterministic gradient & abstract art from mix metadata
 * - Option 3 (Fallback): Color extraction from album art when coverUrls exist
 */

import { logger } from "../utils/logger";
import { extractColorsFromImage } from "../utils/colorExtractor";

export interface MixCoverInput {
    id: string;
    type: string;
    name: string;
    color: string;
    coverUrls: string[];
}

/** Parse rgba(...) from gradient string, return hex */
function parseRgbaFromGradient(gradientStr: string): string[] {
    const hexColors: string[] = [];
    const rgbaMatches = gradientStr.matchAll(
        /rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/g
    );
    for (const m of rgbaMatches) {
        const r = parseInt(m[1], 10);
        const g = parseInt(m[2], 10);
        const b = parseInt(m[3], 10);
        hexColors.push(
            "#" +
                [r, g, b]
                    .map((x) => {
                        const hex = Math.min(255, Math.max(0, x)).toString(16);
                        return hex.length === 1 ? "0" + hex : hex;
                    })
                    .join("")
        );
    }
    return hexColors;
}

/** Hash string to deterministic number */
function hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/** Get deterministic colors from mix id/name when gradient parse fails */
function getDeterministicColors(mix: MixCoverInput): [string, string, string] {
    const seed = hashString(mix.id + mix.name);
    const palettes: [string, string, string][] = [
        ["#1e3a5f", "#3b82f6", "#1e293b"],
        ["#115e59", "#165f63", "#0f172a"],
        ["#991b1b", "#7c2d12", "#44403c"],
        ["#d97706", "#a16207", "#44403c"],
        ["#6366f1", "#581c87", "#0f172a"],
        ["#a21caf", "#831843", "#3b0764"],
        ["#047857", "#115e59", "#0f172a"],
        ["#7c2d12", "#44403c", "#262626"],
    ];
    const idx = seed % palettes.length;
    return palettes[idx];
}

/** Extract 2-3 colors for gradient from mix metadata */
function getColorsFromMix(mix: MixCoverInput): [string, string, string] {
    const parsed = parseRgbaFromGradient(mix.color);
    if (parsed.length >= 2) {
        return [
            parsed[0],
            parsed[Math.min(1, parsed.length - 1)],
            parsed[parsed.length - 1],
        ];
    }
    return getDeterministicColors(mix);
}

/** Generate abstract blob path from seed for variety */
function getBlobPath(seed: number, size: number): string {
    const r = size / 2;
    const points = 6;
    const angleStep = (Math.PI * 2) / points;
    const pathParts: string[] = [];
    for (let i = 0; i <= points; i++) {
        const angle = i * angleStep + (seed % 100) * 0.01;
        const radius = r * (0.6 + ((seed + i * 17) % 40) / 100);
        const x = size / 2 + Math.cos(angle) * radius;
        const y = size / 2 + Math.sin(angle) * radius;
        pathParts.push(`${i === 0 ? "M" : "L"} ${x} ${y}`);
    }
    return pathParts.join(" ") + " Z";
}

/** Build SVG with gradient and abstract shapes */
function buildSvg(
    colors: [string, string, string],
    mix: MixCoverInput,
    size: number
): string {
    const [c1, c2, c3] = colors;
    const seed = hashString(mix.id);
    const blobPath = getBlobPath(seed, size);

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${c1};stop-opacity:1" />
      <stop offset="50%" style="stop-color:${c2};stop-opacity:0.9" />
      <stop offset="100%" style="stop-color:${c3};stop-opacity:1" />
    </linearGradient>
    <linearGradient id="blob" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${c2};stop-opacity:0.4" />
      <stop offset="100%" style="stop-color:${c1};stop-opacity:0.2" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <path d="${blobPath}" fill="url(#blob)"/>
  <circle cx="${size * 0.2}" cy="${size * 0.8}" r="${size * 0.15}" fill="${c1}" opacity="0.3"/>
  <circle cx="${size * 0.85}" cy="${size * 0.2}" r="${size * 0.12}" fill="${c2}" opacity="0.25"/>
</svg>`;
}

/** Fetch image buffer from URL (handles http/https) */
async function fetchImageBuffer(url: string): Promise<Buffer | null> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": "Lidify/1.0" },
        });
        clearTimeout(timeout);
        if (!res.ok) return null;
        const arr = await res.arrayBuffer();
        return Buffer.from(arr);
    } catch (err) {
        logger.debug(`[MixCover] Failed to fetch image: ${url.substring(0, 60)}...`, err);
        return null;
    }
}

/** Resolve cover URL to fetchable URL (for relative IDs, use API base) */
function resolveCoverUrl(coverUrl: string, apiBaseUrl?: string): string {
    if (coverUrl.startsWith("http://") || coverUrl.startsWith("https://")) {
        return coverUrl;
    }
    if (apiBaseUrl) {
        const encoded = encodeURIComponent(coverUrl);
        return `${apiBaseUrl.replace(/\/$/, "")}/api/library/cover-art/${encoded}?size=200`;
    }
    return "";
}

/**
 * Try to extract colors from first available cover image (Option 3)
 */
async function tryExtractColorsFromCovers(
    coverUrls: string[],
    apiBaseUrl?: string
): Promise<[string, string, string] | null> {
    for (const rawUrl of coverUrls.slice(0, 2)) {
        const url = resolveCoverUrl(rawUrl, apiBaseUrl);
        if (!url) continue;
        const buffer = await fetchImageBuffer(url);
        if (!buffer) continue;
        try {
            const palette = await extractColorsFromImage(buffer);
            return [
                palette.vibrant,
                palette.darkVibrant,
                palette.muted,
            ];
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * Generate mix cover as SVG data URL
 *
 * @param mix - Mix metadata
 * @param size - Output size (default 400)
 * @param apiBaseUrl - Optional base URL for resolving relative cover IDs (e.g. http://localhost:3001)
 */
export async function generateMixCoverSvg(
    mix: MixCoverInput,
    size = 400,
    apiBaseUrl?: string
): Promise<string> {
    let colors: [string, string, string];

    if (mix.coverUrls.length > 0) {
        const extracted = await tryExtractColorsFromCovers(
            mix.coverUrls,
            apiBaseUrl
        );
        colors = extracted ?? getColorsFromMix(mix);
    } else {
        colors = getColorsFromMix(mix);
    }

    const svg = buildSvg(colors, mix, size);
    const base64 = Buffer.from(svg).toString("base64");
    return `data:image/svg+xml;base64,${base64}`;
}
