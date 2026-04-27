import type { NextConfig } from "next";
import bundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = bundleAnalyzer({
    enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
    // Proxy timeout: default 30s causes "socket hang up" when backend is slow (e.g. Jellyfin
    // resolution, event loop blocked). 60s gives more headroom without excessive resource hogging.
    experimental: {
        proxyTimeout: 60 * 1000,
        // Enable per-icon imports for tree-shaking. lucide-react ships ~1k icons;
        // without this Next can pull the whole barrel into a route's bundle.
        optimizePackageImports: ["lucide-react", "framer-motion", "recharts"],
    },
    // Allow dev origins for local network testing
    allowedDevOrigins: [
        "http://127.0.0.1:3030",
        "http://127.0.0.1",
        "127.0.0.1",
        "http://localhost:3030",
        "http://localhost",
        "localhost",
    ],
    
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "cdn-images.dzcdn.net",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "e-cdns-images.dzcdn.net",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "lastfm.freetls.fastly.net",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "lastfm-img2.akamaized.net",
                pathname: "/**",
            },
            {
                protocol: "http",
                hostname: "localhost",
                port: "3006",
                pathname: "/**",
            },
            {
                protocol: "http",
                hostname: "127.0.0.1",
                port: "3006",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "assets.pippa.io",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "assets.fanart.tv",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "is1-ssl.mzstatic.com",
                pathname: "/**",
            },
        ],
        formats: ["image/avif", "image/webp"],
        deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
        imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
        minimumCacheTTL: 60 * 60 * 24 * 7, // Cache for 7 days
        dangerouslyAllowSVG: true,
    },
    reactStrictMode: true,
    async headers() {
        return [
            {
                source: "/(.*)",
                headers: [
                    {
                        key: "Permissions-Policy",
                        value: "camera=(), microphone=(), geolocation=()",
                    },
                ],
            },
        ];
    },
    // Proxy API requests to backend (for Docker all-in-one container)
    // Use NEXT_PUBLIC_BACKEND_URL if set (build-time), otherwise default to localhost:3006
    // At runtime, Next.js will proxy /api/* requests to the backend
    async rewrites() {
        const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:3006";
        
        return [
            {
                source: "/api/:path*",
                destination: `${backendUrl}/api/:path*`,
            },
            {
                source: "/health",
                destination: `${backendUrl}/health`,
            },
        ];
    },
};

export default withBundleAnalyzer(nextConfig);
