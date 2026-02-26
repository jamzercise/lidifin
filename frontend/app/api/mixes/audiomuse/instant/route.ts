/**
 * Proxy for /api/mixes/audiomuse/instant with extended timeout.
 * Next.js rewrites have a hardcoded 30s proxy timeout, causing "socket hang up"
 * when AudioMuse-AI takes longer. This route handler proxies with 120s timeout.
 */

import { NextRequest, NextResponse } from "next/server";

const PROXY_TIMEOUT_MS = 120_000; // 2 minutes for AudioMuse MCP workflow

export async function POST(request: NextRequest) {
    const backendUrl =
        process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL || "http://127.0.0.1:3006";
    const url = `${backendUrl}/api/mixes/audiomuse/instant`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

    try {
        const body = await request.text();
        const headers = new Headers();
        request.headers.forEach((value, key) => {
            if (
                key.toLowerCase() !== "host" &&
                key.toLowerCase() !== "connection"
            ) {
                headers.set(key, value);
            }
        });

        const res = await fetch(url, {
            method: "POST",
            headers,
            body: body || undefined,
            signal: controller.signal,
            credentials: "include",
        });

        clearTimeout(timeoutId);

        const resBody = await res.text();
        return new NextResponse(resBody, {
            status: res.status,
            statusText: res.statusText,
            headers: {
                "Content-Type": res.headers.get("Content-Type") || "application/json",
            },
        });
    } catch (err) {
        clearTimeout(timeoutId);
        const message =
            err instanceof Error ? err.message : "Proxy request failed";
        const isTimeout = message.includes("abort") || message.includes("timeout");
        return NextResponse.json(
            {
                error: isTimeout
                    ? "AudioMuse-AI request timed out. Try again or check AudioMuse-AI is running and has analyzed your library."
                    : message,
            },
            { status: 502 }
        );
    }
}
