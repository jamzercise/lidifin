import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast-context';
import type { DiscoverPlaylist, DiscoverConfig } from '../types';

export interface BatchAlbum {
  id?: string;
  artist: string;
  album: string;
  status: string;
  error: string | null;
}

export interface BatchStatus {
  active: boolean;
  status: "downloading" | "scanning" | null;
  batchId?: string;
  progress?: number;
  completed?: number;
  failed?: number;
  total?: number;
  albums?: BatchAlbum[];
}

// If generation is requested but no active batch ever appears within this
// window, stop waiting and surface an error instead of polling forever.
const GENERATION_WATCHDOG_MS = 60_000;

export function useDiscoverData() {
  const { toast } = useToast();
  const [playlist, setPlaylist] = useState<DiscoverPlaylist | null>(null);
  const [config, setConfig] = useState<DiscoverConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [pendingGeneration, setPendingGeneration] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const wasActiveRef = useRef(false);
  const pendingRef = useRef(false); // Track pending state for polling callback
  const pendingSinceRef = useRef<number | null>(null); // When generation was requested

  // Keep pendingRef in sync with pendingGeneration + track when it began
  useEffect(() => {
    pendingRef.current = pendingGeneration;
    if (pendingGeneration) {
      if (pendingSinceRef.current == null) pendingSinceRef.current = Date.now();
    } else {
      pendingSinceRef.current = null;
    }
  }, [pendingGeneration]);

  const loadData = useCallback(async () => {
    try {
      const [playlistData, configData] = await Promise.all([
        api.getCurrentDiscoverWeekly().catch(() => null),
        api.getDiscoverConfig().catch(() => null),
      ]);

      setPlaylist(playlistData);
      setConfig(configData);
    } catch (error) {
      console.error('Failed to load discover data:', error);
    }
  }, []);

  const checkBatchStatus = useCallback(async () => {
    try {
      const status = await api.getDiscoverBatchStatus();
      setBatchStatus(status);

      // Clear pending state once batch is confirmed active
      if (status.active) {
        setPendingGeneration(false);
      }

      // If batch was active and now isn't, reload data
      if (wasActiveRef.current && !status.active) {
        wasActiveRef.current = false;
        setPendingGeneration(false);
        await loadData();
      }
      
      // Track if batch is currently active
      if (status.active) {
        wasActiveRef.current = true;
      }

      return status;
    } catch (error) {
      console.error('Failed to check batch status:', error);
      setPendingGeneration(false);
      return null;
    }
  }, [loadData]);

  // Start polling for batch status
  const startPolling = useCallback(() => {
    if (pollingRef.current) return; // Already polling

    let errorCount = 0;
    pollingRef.current = setInterval(async () => {
      const status = await checkBatchStatus();

      // Stop polling on repeated API failures
      if (!status) {
        errorCount++;
        if (errorCount >= 5) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          setPendingGeneration(false);
          toast.error(
            "Lost connection to Discover Weekly status. Refresh the page to retry."
          );
        }
        return;
      }
      errorCount = 0;

      // Watchdog: generation was requested but no active batch ever appeared
      if (
        !status.active &&
        pendingRef.current &&
        pendingSinceRef.current != null &&
        Date.now() - pendingSinceRef.current > GENERATION_WATCHDOG_MS
      ) {
        setPendingGeneration(false);
        pendingSinceRef.current = null;
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
        toast.error("Generation didn't start. Please try again.");
        return;
      }

      // Stop polling when batch is not active and we're not waiting for generation
      if (!status.active && !pendingRef.current) {
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    }, 3000); // Poll every 3 seconds
  }, [checkBatchStatus, toast]);

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      
      // Check batch status first
      const status = await checkBatchStatus();
      
      // Load playlist data
      await loadData();
      
      // Start polling if batch is active
      if (status?.active) {
        startPolling();
      }

      setTimeout(() => {
        setLoading(false);
      }, 100);
    };

    init();

    return () => {
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: initial data load and polling setup should not re-trigger on callback identity changes
  }, []);

  // Start polling when batch becomes active OR when generation is pending
  // This ensures we catch the batch as soon as it's created
  useEffect(() => {
    if ((batchStatus?.active || pendingGeneration) && !pollingRef.current) {
      startPolling();
    }
  }, [batchStatus?.active, pendingGeneration, startPolling]);

  // Optimistically update a track's liked status
  const updateTrackLiked = useCallback((albumId: string, isLiked: boolean) => {
    setPlaylist(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        tracks: prev.tracks.map(track => 
          track.albumId === albumId 
            ? { ...track, isLiked, likedAt: isLiked ? new Date().toISOString() : null }
            : track
        ),
      };
    });
  }, []);

  const handleRebuild = useCallback(async () => {
    try {
      await api.rebuildDiscoverWeekly();
      setPendingGeneration(true);
      startPolling();
    } catch (error) {
      console.error('Failed to rebuild:', error);
      toast.error("Couldn't rebuild the playlist. Please try again.");
    }
  }, [startPolling, toast]);

  const handleCancel = useCallback(async () => {
    try {
      await api.cancelDiscoverGeneration();
      setPendingGeneration(false);
      stopPolling();
      await checkBatchStatus();
      await loadData();
      toast.success('Generation cancelled');
    } catch (error) {
      console.error('Failed to cancel generation:', error);
      toast.error("Couldn't cancel generation. Please try again.");
    }
  }, [checkBatchStatus, loadData, stopPolling, toast]);

  const handleRetryAlbum = useCallback(async (jobId: string) => {
    try {
      await api.retryDiscoverAlbum(jobId);
      setPendingGeneration(true);
      startPolling();
      await checkBatchStatus();
      toast.success('Retrying download…');
    } catch (error) {
      console.error('Failed to retry album:', error);
      toast.error("Couldn't retry that album. Please try again.");
    }
  }, [checkBatchStatus, startPolling, toast]);

  return {
    playlist,
    config,
    setConfig,
    loading,
    reloadData: loadData,
    batchStatus,
    refreshBatchStatus: checkBatchStatus,
    setPendingGeneration,
    updateTrackLiked,
    isGenerating: pendingGeneration || batchStatus?.active || false,
    handleRebuild,
    handleCancel,
    handleRetryAlbum,
  };
}
