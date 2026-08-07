import { statfs } from "node:fs/promises";
import path from "node:path";
import { sendAlert } from "./alerts";
import { logger, serializeError } from "./logger";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MINIMUM_FREE_RATIO = 0.1;

export function startDiskMonitor(
    dbPath: string,
    intervalMs = DEFAULT_INTERVAL_MS
): () => void {
    const directory = path.dirname(dbPath);

    const check = async () => {
        try {
            const stats = await statfs(directory);
            const total = Number(stats.blocks) * Number(stats.bsize);
            const available = Number(stats.bavail) * Number(stats.bsize);
            const freeRatio = total > 0 ? available / total : 0;

            if (freeRatio < MINIMUM_FREE_RATIO) {
                const freeMegabytes = Math.round(available / 1024 / 1024);
                logger.error("Low database disk space", {
                    event: "disk.low_space",
                    db_directory: directory,
                    free_ratio: Math.round(freeRatio * 10_000) / 10_000,
                    free_megabytes: freeMegabytes,
                });
                await sendAlert(`На диске SQLite осталось ${freeMegabytes} MiB.`);
            }
        } catch (error) {
            logger.error("Disk space check failed", {
                event: "disk.check_failed",
                db_directory: directory,
                error: serializeError(error),
            });
        }
    };

    void check();
    const timer = setInterval(() => void check(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
