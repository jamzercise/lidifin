import type { Metadata, Viewport } from "next";
import { Montserrat, Archivo_Black } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { FeaturesProvider } from "@/lib/features-context";
import { ToastProvider } from "@/lib/toast-context";
import { DownloadProvider } from "@/lib/download-context";
import { ConditionalAudioProvider } from "@/components/providers/ConditionalAudioProvider";
import { AuthenticatedLayout } from "@/components/layout/AuthenticatedLayout";
import { QueryProvider } from "@/lib/query-client";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { GlobalErrorBoundary } from "@/components/providers/GlobalErrorBoundary";

const montserrat = Montserrat({
    weight: ["300", "400", "500", "600", "700", "800"],
    subsets: ["latin"],
    display: "swap",
    variable: "--font-montserrat",
});

const archivoBlack = Archivo_Black({
    weight: "400",
    subsets: ["latin"],
    display: "swap",
    variable: "--font-archivo-black",
});

// Viewport configuration - separate export for Next.js 14+
export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: "cover",
    themeColor: "#081917",
};

export const metadata: Metadata = {
    title: "Lidifin - Your Music",
    description: "Self-hosted music streaming platform",
    manifest: "/manifest.webmanifest",
    icons: {
        icon: "/assets/images/favicon-192.png",
        apple: [
            { url: "/assets/icons/icon-192.png", sizes: "192x192" },
            { url: "/assets/icons/icon-512.png", sizes: "512x512" },
        ],
    },
    appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: "Lidifin",
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <script
                    dangerouslySetInnerHTML={{
                        __html: `(function(){var t=localStorage.getItem("lidify-theme");var v=["dark","light","warm","cool","high-contrast"];if(t&&v.indexOf(t)!==-1){document.documentElement.setAttribute("data-theme",t)}else{var d=window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.setAttribute("data-theme",d?"dark":"light")}})();`,
                    }}
                />
            </head>
            <body
                className={`${montserrat.variable} ${archivoBlack.variable} antialiased`}
                style={{ fontFamily: "var(--font-montserrat)" }}
            >
                <GlobalErrorBoundary>
                    <ServiceWorkerRegistration />
                    <ThemeProvider>
                    <AuthProvider>
                        <FeaturesProvider>
                            <QueryProvider>
                                <DownloadProvider>
                                    <ConditionalAudioProvider>
                                        <ToastProvider>
                                            <AuthenticatedLayout>
                                                {children}
                                            </AuthenticatedLayout>
                                        </ToastProvider>
                                    </ConditionalAudioProvider>
                                </DownloadProvider>
                            </QueryProvider>
                        </FeaturesProvider>
                    </AuthProvider>
                    </ThemeProvider>
                </GlobalErrorBoundary>
            </body>
        </html>
    );
}
