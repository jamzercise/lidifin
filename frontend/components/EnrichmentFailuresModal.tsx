"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { enrichmentApi } from "@/lib/enrichmentApi";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
    RefreshCw,
    SkipForward,
    Trash2,
    AlertCircle,
} from "lucide-react";

interface EnrichmentFailuresModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function EnrichmentFailuresModal({
    isOpen,
    onClose,
}: EnrichmentFailuresModalProps) {
    const [selectedType, setSelectedType] = useState<
        "all" | "artist" | "track" | "audio"
    >("all");
    const [selectedFailures, setSelectedFailures] = useState<Set<string>>(
        new Set()
    );
    const [currentPage, setCurrentPage] = useState(1);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const pageSize = 20;
    const queryClient = useQueryClient();

    // Fetch failures
    const {
        data: failures,
        isLoading,
    } = useQuery({
        queryKey: ["enrichment-failures", selectedType, currentPage],
        queryFn: async () => {
            const params: Record<string, string | number | boolean> = {
                limit: pageSize,
                offset: (currentPage - 1) * pageSize,
                resolved: false,
            };
            if (selectedType !== "all") {
                params.entityType = selectedType;
            }
            return enrichmentApi.getFailures(params);
        },
        enabled: isOpen,
    });

    // Fetch counts
    const { data: counts } = useQuery({
        queryKey: ["enrichment-failure-counts"],
        queryFn: () => enrichmentApi.getFailureCounts(),
        enabled: isOpen,
    });

    // Retry mutation
    const retryMutation = useMutation({
        mutationFn: (failureIds: string[]) =>
            enrichmentApi.retryFailures(failureIds),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failures"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failure-counts"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-progress"],
            });
            setSelectedFailures(new Set());
        },
    });

    // Skip mutation
    const skipMutation = useMutation({
        mutationFn: (failureIds: string[]) =>
            enrichmentApi.skipFailures(failureIds),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failures"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failure-counts"],
            });
            setSelectedFailures(new Set());
        },
    });

    // Delete mutation
    const deleteMutation = useMutation({
        mutationFn: (failureId: string) =>
            enrichmentApi.deleteFailure(failureId),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failures"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failure-counts"],
            });
        },
    });

    // Clear all mutation
    const clearAllMutation = useMutation({
        mutationFn: (entityType?: "artist" | "track" | "audio") =>
            enrichmentApi.clearAllFailures(entityType),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failures"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failure-counts"],
            });
            setSelectedFailures(new Set());
        },
    });

    const toggleFailureSelection = (id: string) => {
        const newSelected = new Set(selectedFailures);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedFailures(newSelected);
    };

    const handleSelectAll = () => {
        if (selectedFailures.size === failures?.failures.length) {
            setSelectedFailures(new Set());
        } else {
            setSelectedFailures(
                new Set(failures?.failures.map((f) => f.id) || [])
            );
        }
    };

    const handleRetrySelected = () => {
        if (selectedFailures.size > 0) {
            retryMutation.mutate(Array.from(selectedFailures));
        }
    };

    const handleSkipSelected = () => {
        if (selectedFailures.size > 0) {
            skipMutation.mutate(Array.from(selectedFailures));
        }
    };

    if (!isOpen) return null;

    const totalFailures = counts?.total || 0;
    const totalPages = Math.ceil((failures?.total || 0) / pageSize);
    const clearFailureCount =
        selectedType === "all"
            ? totalFailures
            : (counts?.[selectedType] ?? 0);
    const clearMessage = `This will permanently delete ${
        selectedType === "all" ? "all" : selectedType
    } ${clearFailureCount} failure${
        clearFailureCount !== 1 ? "s" : ""
    }. This action cannot be undone.`;

    return (
        <>
            <Modal
                isOpen={isOpen}
                onClose={onClose}
                title="Enrichment Failures"
                subtitle={`${totalFailures} total failure${
                    totalFailures !== 1 ? "s" : ""
                } to review`}
                headerActions={
                    totalFailures > 0 ? (
                        <button
                            type="button"
                            onClick={() => setShowClearConfirm(true)}
                            disabled={clearAllMutation.isPending}
                            className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg
                                    hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {clearAllMutation.isPending
                                ? "Clearing..."
                                : "Clear All"}
                        </button>
                    ) : null
                }
                backdropClassName="bg-black/80"
                className="max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden rounded-lg border-white/10 bg-[#1a1a1a] bg-none shadow-2xl"
                contentClassName="flex flex-1 flex-col min-h-0 overflow-hidden mb-0 p-0"
            >
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {/* Filter Tabs */}
                <div className="flex gap-3 px-6 py-4 border-b border-white/10 overflow-x-auto shrink-0">
                    {(
                        [
                            { key: "all" as const, label: "All", count: counts?.total || 0 },
                            {
                                key: "artist" as const,
                                label: "Artists",
                                count: counts?.artist || 0,
                            },
                            {
                                key: "track" as const,
                                label: "Tracks",
                                count: counts?.track || 0,
                            },
                            {
                                key: "audio" as const,
                                label: "Audio Analysis",
                                count: counts?.audio || 0,
                            },
                        ]
                    ).map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => {
                                setSelectedType(tab.key);
                                setCurrentPage(1);
                                setSelectedFailures(new Set());
                            }}
                            className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                                selectedType === tab.key
                                    ? "bg-[#B1D2C3] text-black"
                                    : "bg-white/5 text-white/70 hover:bg-white/10"
                            }`}
                        >
                            {tab.label} ({tab.count})
                        </button>
                    ))}
                </div>

                {/* Action Bar */}
                {selectedFailures.size > 0 && (
                    <div className="flex items-center gap-2 p-4 bg-white/5 border-b border-white/10">
                        <span className="text-sm text-white/70">
                            {selectedFailures.size} selected
                        </span>
                        <div className="flex gap-2 ml-auto">
                            <button
                                onClick={handleRetrySelected}
                                disabled={retryMutation.isPending}
                                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg
                                    hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <RefreshCw className="w-3.5 h-3.5" />
                                Retry
                            </button>
                            <button
                                onClick={handleSkipSelected}
                                disabled={skipMutation.isPending}
                                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                    hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <SkipForward className="w-3.5 h-3.5" />
                                Skip
                            </button>
                        </div>
                    </div>
                )}

                {/* Failures List */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-64">
                            <div className="text-white/50">
                                Loading failures...
                            </div>
                        </div>
                    ) : failures?.failures.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-white/50">
                            <AlertCircle className="w-12 h-12 mb-3 opacity-50" />
                            <p className="text-lg font-medium">
                                No failures found
                            </p>
                            <p className="text-sm mt-1">
                                All items enriched successfully
                            </p>
                        </div>
                    ) : (
                        <div
                            role="group"
                            aria-label="Enrichment failures (selectable)"
                            className="space-y-2"
                        >
                            {/* Select All */}
                            <div className="flex items-center gap-3 px-3 py-2">
                                <input
                                    type="checkbox"
                                    checked={
                                        selectedFailures.size ===
                                        failures?.failures.length
                                    }
                                    onChange={handleSelectAll}
                                    aria-label="Select all failures"
                                    className="w-4 h-4 rounded border-white/20 bg-white/10"
                                />
                                <span className="text-sm text-white/50">
                                    Select all
                                </span>
                            </div>

                            {failures?.failures.map((failure) => (
                                <div
                                    key={failure.id}
                                    className="flex items-start gap-3 p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedFailures.has(
                                            failure.id
                                        )}
                                        onChange={() =>
                                            toggleFailureSelection(failure.id)
                                        }
                                        aria-labelledby={`failure-${failure.id}-label`}
                                        className="w-4 h-4 mt-1 rounded border-white/20 bg-white/10"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span
                                                id={`failure-${failure.id}-label`}
                                                className="text-sm font-medium text-white truncate"
                                            >
                                                {failure.entityName ||
                                                    failure.entityId}
                                            </span>
                                            <span className="text-xs px-2 py-0.5 bg-white/10 text-white/50 rounded uppercase">
                                                {failure.entityType}
                                            </span>
                                        </div>
                                        <p className="text-xs text-red-400 mt-1">
                                            {failure.errorMessage ||
                                                "Unknown error"}
                                        </p>
                                        <div className="flex items-center gap-3 mt-2 text-[10px] text-white/30">
                                            <span>
                                                Retry {failure.retryCount}/
                                                {failure.maxRetries}
                                            </span>
                                            <span>•</span>
                                            <span>
                                                Last:{" "}
                                                {new Date(
                                                    failure.lastFailedAt
                                                ).toLocaleString()}
                                            </span>
                                            {failure.errorCode && (
                                                <>
                                                    <span>•</span>
                                                    <span>
                                                        {failure.errorCode}
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() =>
                                            deleteMutation.mutate(failure.id)
                                        }
                                        disabled={deleteMutation.isPending}
                                        className="p-2 hover:bg-red-500/20 rounded-lg transition-colors"
                                        title="Delete failure record"
                                    >
                                        <Trash2 className="w-4 h-4 text-red-400" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="flex shrink-0 items-center justify-between p-4 border-t border-white/10">
                        <button
                            onClick={() =>
                                setCurrentPage((p) => Math.max(1, p - 1))
                            }
                            disabled={currentPage === 1}
                            className="px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Previous
                        </button>
                        <span className="text-sm text-white/50">
                            Page {currentPage} of {totalPages}
                        </span>
                        <button
                            onClick={() =>
                                setCurrentPage((p) =>
                                    Math.min(totalPages, p + 1)
                                )
                            }
                            disabled={currentPage === totalPages}
                            className="px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Next
                        </button>
                    </div>
                )}
                </div>
            </Modal>

            <ConfirmDialog
                isOpen={showClearConfirm}
                onClose={() => setShowClearConfirm(false)}
                onConfirm={() => {
                    clearAllMutation.mutate(
                        selectedType === "all" ? undefined : selectedType
                    );
                }}
                title="Clear All Failures?"
                message={clearMessage}
                confirmText="Clear All"
                variant="danger"
                overlayClassName="z-[60]"
            />
        </>
    );
}
