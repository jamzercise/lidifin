import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { registerEnrichmentProgressStatusRoutes } from "./enrichment/progressStatus";
import { registerEnrichmentControlRoutes } from "./enrichment/control";
import { registerEnrichmentUserSettingsRoutes } from "./enrichment/userSettings";
import { registerEnrichmentEntityRoutes } from "./enrichment/entities";
import { registerEnrichmentFailureRoutes } from "./enrichment/failures";
import { registerEnrichmentMetadataRoutes } from "./enrichment/metadata";
import { registerEnrichmentConcurrencyRoutes } from "./enrichment/concurrency";

/**
 * Enrichment controls, failures, and metadata overrides. Mount order matches the
 * previous monolith for identical Express matching.
 */
const router = Router();

router.use(requireAuth);

registerEnrichmentProgressStatusRoutes(router);
registerEnrichmentControlRoutes(router);
registerEnrichmentUserSettingsRoutes(router);
registerEnrichmentEntityRoutes(router);
registerEnrichmentFailureRoutes(router);
registerEnrichmentMetadataRoutes(router);
registerEnrichmentConcurrencyRoutes(router);

export default router;
