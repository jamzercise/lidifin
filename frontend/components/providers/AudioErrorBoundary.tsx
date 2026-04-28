"use client";

import React, { Component, ReactNode } from "react";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

/**
 * Error boundary specifically for audio-related errors.
 * Catches errors in the audio provider hierarchy and allows the rest of the app to continue.
 * Shows a dismissible banner then falls through gracefully.
 */
export class AudioErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error("[AudioErrorBoundary] Audio system error:", error);
        console.error("[AudioErrorBoundary] Component stack:", errorInfo.componentStack);
    }

    private handleDismiss = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <>
                    <div
                        role="alert"
                        aria-live="assertive"
                        aria-atomic="true"
                        className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-red-900/90 text-white text-sm px-4 py-2 rounded-lg shadow-lg backdrop-blur-sm max-w-md"
                    >
                        <span className="flex-1">Audio playback encountered an error. Playback may be unavailable.</span>
                        <button
                            onClick={this.handleDismiss}
                            className="shrink-0 text-xs font-medium px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
                        >
                            Retry
                        </button>
                    </div>
                    {this.props.children}
                </>
            );
        }

        return this.props.children;
    }
}

