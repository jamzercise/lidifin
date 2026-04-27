import type { IAudioMetadata, IOptions } from "music-metadata";

// `music-metadata` v8+ is ESM-only, but this backend still compiles to
// CommonJS (`module: "commonjs"` in tsconfig). TypeScript would otherwise
// rewrite a literal `import("music-metadata")` into
// `Promise.resolve(require("music-metadata"))`, which throws
// `ERR_REQUIRE_ESM` at runtime.
//
// We smuggle a *real* dynamic `import()` past the TS compiler via `new
// Function`. TS doesn't analyse the body of `Function(...)`, so the eventual
// runtime call is a host `import()` evaluated by Node, which can load ESM
// packages from a CJS context.
//
// Types are still preserved by casting the Function result to the imported
// module's namespace type; this keeps strict-mode callsites honest without
// needing to ship the whole backend as ESM.
type MusicMetadataModule = typeof import("music-metadata");

const importMusicMetadata = new Function(
    "return import('music-metadata');"
) as () => Promise<MusicMetadataModule>;

let modulePromise: Promise<MusicMetadataModule> | null = null;

/**
 * Lazily load `music-metadata` exactly once. Subsequent callers share the
 * same promise so we never pay the import cost twice and never race two
 * simultaneous loads.
 */
function loadMusicMetadata(): Promise<MusicMetadataModule> {
    if (!modulePromise) {
        modulePromise = importMusicMetadata();
    }
    return modulePromise;
}

/**
 * Drop-in replacement for the `parseFile` import we used in v7. Async-only
 * (was already async in v7), accepts the same arguments, and returns the
 * same `IAudioMetadata` shape — `format`, `common`, `native`, etc.
 */
export async function parseFile(
    filePath: string,
    options?: IOptions,
): Promise<IAudioMetadata> {
    const mm = await loadMusicMetadata();
    return mm.parseFile(filePath, options);
}

export type { IAudioMetadata, IOptions } from "music-metadata";
