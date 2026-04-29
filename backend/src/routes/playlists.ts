import { Router } from "express";
import { requireAuthOrToken } from "../middleware/auth";
import { registerPlaylistListRoute } from "./playlists/list";
import { registerPlaylistCrudRoutes } from "./playlists/crud";
import { registerPlaylistItemRoutes } from "./playlists/items";
import { registerPlaylistPendingRoutes } from "./playlists/pending";

/**
 * User playlists + Jellyfin sync + pending Spotify import tracks.
 * Decomposed from a single file; mount order preserves Express path matching.
 */
const router = Router();

router.use(requireAuthOrToken);

registerPlaylistListRoute(router);
registerPlaylistCrudRoutes(router);
registerPlaylistItemRoutes(router);
registerPlaylistPendingRoutes(router);

export default router;
