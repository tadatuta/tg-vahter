import { sendAlert } from "./alerts";
import { bot, config } from "./bot";
import { closeDatabase } from "./db";
import { flushLogger, logger, serializeError } from "./logger";
import { startDiskMonitor } from "./monitoring";

let shuttingDown = false;
const stopDiskMonitor = startDiskMonitor(config.dbPath);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    stopDiskMonitor();

    logger.info("Graceful shutdown started", {
        event: "runtime.shutdown_started",
        signal,
    });

    try {
        await sendAlert(`Контейнер останавливается по сигналу ${signal}.`, true);
        if (bot.isRunning()) await bot.stop();
        await pollingPromise;
        closeDatabase();
        logger.info("Graceful shutdown completed", {
            event: "runtime.shutdown_completed",
            signal,
        });
        await flushLogger();
    } catch (error) {
        logger.error("Graceful shutdown failed", {
            event: "runtime.shutdown_failed",
            signal,
            error: serializeError(error),
        });
        process.exitCode = 1;
    }
}

logger.info("Starting long polling", {
    event: "runtime.started",
    environment: config.environment,
});

const pollingPromise = bot.start({
    allowed_updates: ["message", "edited_message", "chat_member"],
    timeout: 30,
    onStart: (info) => {
        logger.info(`Bot @${info.username} started`, {
            event: "long_polling.started",
            bot_id: info.id,
            bot_username: info.username,
        });
        void sendAlert(`Контейнер запущен. Бот @${info.username} получает updates через long polling.`, true);
    },
}).catch(async (error: unknown) => {
    logger.error("Long polling stopped unexpectedly", {
        event: "long_polling.stopped_unexpectedly",
        error: serializeError(error),
    });
    await sendAlert("Long polling остановлен из-за ошибки.", true);
    process.exitCode = 1;
    if (!shuttingDown) {
        try {
            closeDatabase();
        } catch (closeError) {
            logger.error("Database close after polling failure failed", {
                event: "database.close_failed",
                error: serializeError(closeError),
            });
        }
    }
});

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
