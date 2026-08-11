import { applyTrackEdits, type EditableTrack } from "../trackEdits";

function track(overrides: Partial<EditableTrack> = {}): EditableTrack {
    return {
        spotifyId: "t1",
        artist: "Nirvana",
        title: "Smells Like Teen Spirit",
        album: "Nevermind",
        albumId: "spotify-album-1",
        ...overrides,
    };
}

describe("applyTrackEdits", () => {
    it("corrects the fields it is given and leaves the rest alone", () => {
        const tracks = [track()];

        const applied = applyTrackEdits(tracks, [
            { spotifyId: "t1", artist: "Nirvana feat. Nobody" },
        ]);

        expect(applied).toBe(1);
        expect(tracks[0].artist).toBe("Nirvana feat. Nobody");
        expect(tracks[0].title).toBe("Smells Like Teen Spirit");
        expect(tracks[0].album).toBe("Nevermind");
    });

    it("only touches the track the edit names", () => {
        const tracks = [track(), track({ spotifyId: "t2", title: "Lithium" })];

        applyTrackEdits(tracks, [{ spotifyId: "t2", title: "In Bloom" }]);

        expect(tracks[0].title).toBe("Smells Like Teen Spirit");
        expect(tracks[1].title).toBe("In Bloom");
    });

    it("clears albumId when the album changes so acquisition can't follow the old release", () => {
        const tracks = [track({ albumId: "mbid:abc-123" })];

        applyTrackEdits(tracks, [{ spotifyId: "t1", album: "Nevermind (Deluxe)" }]);

        expect(tracks[0].album).toBe("Nevermind (Deluxe)");
        expect(tracks[0].albumId).toBe("");
    });

    it("keeps albumId when the album is unchanged", () => {
        const tracks = [track({ albumId: "mbid:abc-123" })];

        applyTrackEdits(tracks, [
            { spotifyId: "t1", album: "Nevermind", title: "Polly" },
        ]);

        expect(tracks[0].albumId).toBe("mbid:abc-123");
    });

    it("trims surrounding whitespace before comparing and applying", () => {
        const tracks = [track()];

        const applied = applyTrackEdits(tracks, [
            { spotifyId: "t1", artist: "  Nirvana  ", title: "  Polly  " },
        ]);

        // Artist is unchanged once trimmed, so only the title counts as an edit.
        expect(applied).toBe(1);
        expect(tracks[0].artist).toBe("Nirvana");
        expect(tracks[0].title).toBe("Polly");
    });

    it("ignores blank values rather than wiping metadata", () => {
        const tracks = [track()];

        const applied = applyTrackEdits(tracks, [
            { spotifyId: "t1", artist: "", title: "   ", album: "" },
        ]);

        expect(applied).toBe(0);
        expect(tracks[0]).toEqual(track());
    });

    it("reports no edits when values match what is already there", () => {
        const tracks = [track()];

        const applied = applyTrackEdits(tracks, [
            {
                spotifyId: "t1",
                artist: "Nirvana",
                title: "Smells Like Teen Spirit",
                album: "Nevermind",
            },
        ]);

        expect(applied).toBe(0);
    });

    it("counts a track once even when several fields change", () => {
        const tracks = [track()];

        const applied = applyTrackEdits(tracks, [
            { spotifyId: "t1", artist: "Foo Fighters", title: "Everlong", album: "The Colour and the Shape" },
        ]);

        expect(applied).toBe(1);
    });

    it("ignores edits for tracks that are no longer in the playlist", () => {
        const tracks = [track()];

        const applied = applyTrackEdits(tracks, [
            { spotifyId: "removed-track", title: "Whatever" },
        ]);

        expect(applied).toBe(0);
        expect(tracks[0]).toEqual(track());
    });

    it("is a no-op for an empty edit list", () => {
        const tracks = [track()];

        expect(applyTrackEdits(tracks, [])).toBe(0);
        expect(tracks[0]).toEqual(track());
    });

    it("lets the last edit win when a track is listed twice", () => {
        const tracks = [track()];

        applyTrackEdits(tracks, [
            { spotifyId: "t1", title: "First" },
            { spotifyId: "t1", title: "Second" },
        ]);

        expect(tracks[0].title).toBe("Second");
    });
});
