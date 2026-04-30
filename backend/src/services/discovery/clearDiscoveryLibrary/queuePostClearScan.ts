import { logger } from "../../../utils/logger";
import { config } from "../../../config";
import { scanQueue } from "../../../workers/queues";

export async function queuePostClearLibraryScan(userId: string): Promise<void> {
    logger.debug(`\n[SCAN] Triggering library scan to sync database...`);
    try {
        await scanQueue.add("scan", {
            userId,
            musicPath: config.music.musicPath,
        });
        logger.debug(`   Library scan queued successfully`);
    } catch (scanError: unknown) {
        const msg =
            scanError instanceof Error
                ? scanError.message
                : String(scanError);
        logger.debug(`   Library scan queue failed: ${msg}`);
    }
}
