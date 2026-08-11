/**
 * User corrections to playlist tracks during import.
 *
 * A playlist's metadata is often wrong or formatted differently from what the
 * library and the acquisition sources expect, which leaves tracks unmatched or
 * pulls the wrong release. These corrections are applied to the fetched
 * tracklist before matching and grouping so they flow through to library
 * matching, MusicBrainz lookup, and the Soulseek and Lidarr queries alike.
 */

/**
 * A correction to one track, keyed by the source track id. Omitted or blank
 * fields leave the source value alone.
 */
export interface TrackEdit {
    spotifyId: string;
    artist?: string;
    title?: string;
    album?: string;
}

/**
 * The parts of a source track a correction can touch. Structural so the import
 * service's SpotifyTrack satisfies it without this module depending on it.
 */
export interface EditableTrack {
    spotifyId: string;
    artist: string;
    title: string;
    album: string;
    albumId: string;
}

/**
 * Overlay corrections onto a tracklist, in place, and report how many tracks
 * changed.
 */
export function applyTrackEdits<T extends EditableTrack>(
    tracks: T[],
    edits: TrackEdit[]
): number {
    const editsById = new Map(edits.map((edit) => [edit.spotifyId, edit]));
    let applied = 0;

    for (const track of tracks) {
        const edit = editsById.get(track.spotifyId);
        if (!edit) continue;

        const artist = edit.artist?.trim();
        const title = edit.title?.trim();
        const album = edit.album?.trim();
        let changed = false;

        if (artist && artist !== track.artist) {
            track.artist = artist;
            changed = true;
        }
        if (title && title !== track.title) {
            track.title = title;
            changed = true;
        }
        if (album && album !== track.album) {
            track.album = album;
            // albumId identifies the source album, and once enrichment has run
            // it carries a resolved "mbid:" release group. Either way it now
            // describes the album the user rejected, and leaving it would point
            // acquisition at that release instead of the corrected one.
            track.albumId = "";
            changed = true;
        }

        if (changed) applied++;
    }

    return applied;
}
