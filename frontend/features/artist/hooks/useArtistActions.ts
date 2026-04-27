import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useAudioControls } from '@/lib/audio-context';
import { Artist, Album, Track } from '../types';
import { shuffleArray } from '@/utils/shuffle';

interface FormattedTrack {
  id: string;
  title: string;
  trackNumber: number;
  artist: { name: string; id: string };
  album: { title: string; coverArt?: string; id: string; year?: number };
  duration: number;
}

export function useArtistActions() {
  // Use controls-only hook to avoid re-renders from playback state changes
  const { playTrack: playTrackFromContext, playTracks } = useAudioControls();

  // Helper to load all tracks from owned albums
  const loadAllOwnedTracks = async (artist: Artist, albums: Album[]) => {
    // Get owned albums sorted by year (newest first)
    const ownedAlbums = albums
      .filter((album) => album.owned)
      .sort((a, b) => (b.year || 0) - (a.year || 0));

    if (ownedAlbums.length === 0) {
      return [];
    }

    // Load tracks from all owned albums in parallel
    const albumDataPromises = ownedAlbums.map((album) =>
      api.getAlbum(album.id).catch(() => null)
    );

    const albumsData = await Promise.all(albumDataPromises);

    // Combine all tracks, maintaining album order (newest first)
    const allTracks: FormattedTrack[] = [];

    albumsData.forEach((albumData, index) => {
      if (!albumData || !albumData.tracks) return;

      const album = ownedAlbums[index];
      const formattedTracks: FormattedTrack[] = albumData.tracks.map(
        (track: Record<string, unknown>): FormattedTrack => ({
          id: String(track.id ?? ""),
          title: String(track.title ?? ""),
          trackNumber: Number(track.trackNumber) || 0,
          artist: { name: artist.name, id: artist.id },
          album: {
            title: album.title,
            coverArt: album.coverArt,
            id: album.id,
            year: album.year,
          },
          duration: typeof track.duration === "number" ? track.duration : 0,
        }),
      );

      // Sort tracks within album by track number
      formattedTracks.sort(
        (a: FormattedTrack, b: FormattedTrack) =>
          a.trackNumber - b.trackNumber,
      );
      allTracks.push(...formattedTracks);
    });

    return allTracks;
  };

  const playAll = useCallback(
    async (artist: Artist | null, albums: Album[]) => {
      if (!artist) {
        return;
      }

      try {
        const allTracks = await loadAllOwnedTracks(artist, albums);

        if (allTracks.length === 0) {
          return;
        }

        // Play tracks in order (newest album first, track 1 to end, then next album)
        playTracks(allTracks);
      } catch (error) {
        console.error('Failed to play artist:', error);
      }
    },
    [playTracks]
  );

  const shufflePlay = useCallback(
    async (artist: Artist | null, albums: Album[]) => {
      if (!artist) {
        return;
      }

      try {
        const allTracks = await loadAllOwnedTracks(artist, albums);

        if (allTracks.length === 0) {
          return;
        }

        // Shuffle all tracks randomly
        const shuffledTracks = shuffleArray(allTracks);

        playTracks(shuffledTracks);
      } catch (error) {
        console.error('Failed to shuffle play artist:', error);
      }
    },
    [playTracks]
  );

  const playTrack = useCallback(
    (track: Track, artist: Artist) => {
      try {
        // Format track for audio context
        const formattedTrack = {
          id: track.id,
          title: track.title,
          artist: { name: artist.name, id: artist.id },
          album: {
            title: track.album?.title || 'Unknown Album',
            coverArt: track.album?.coverArt,
            id: track.album?.id,
          },
          duration: track.duration,
        };

        playTrackFromContext(formattedTrack);
      } catch (error) {
        console.error('Failed to play track:', error);
      }
    },
    [playTrackFromContext]
  );

  return {
    playAll,
    shufflePlay,
    playTrack,
  };
}
