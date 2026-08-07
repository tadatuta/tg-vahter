import { Bot, GrammyError, HttpError } from "grammy";
import { initAlerts, markConnectivityFailure, notifyConnectivityRestored, sendAlert } from "./alerts";
import { loadConfig } from "./config";
import * as db from "./db";
import { initHeuristics } from "./heuristics";
import { initLogger, logger, serializeError } from "./logger";
import { getContextLogFields, logDecision, traceUpdate } from "./observability";
import { handleNewMember } from "./handlers/newMember";
import { handleMessage } from "./handlers/message";
import {
    handleSpam,
    handleUnspam,
    handleAddAdmin,
    handleStatus,
    initAdminConfig,
} from "./handlers/admin";

export const config = loadConfig();
initLogger(config.logFile, config.logLevel);

const initializationStartedAt = performance.now();
try {
    db.initDatabase(config.dbPath);
    initHeuristics(config.spamRegex);
    initAdminConfig(config.superAdminIds);
} catch (error) {
    logger.error("Bot initialization failed", {
        event: "bot.initialization_failed",
        duration_ms: Math.round((performance.now() - initializationStartedAt) * 100) / 100,
        error: serializeError(error),
    });
    throw error;
}

export const bot = new Bot(config.botToken, {
    client: {
        apiRoot: config.telegramApiRoot,
        timeoutSeconds: 40,
    },
});

initAlerts(bot.api, config.alertChatId);

bot.use(traceUpdate);
bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    if (!db.claimUpdate(updateId)) {
        logDecision(ctx, "skip", "duplicate_update");
        return;
    }

    try {
        await notifyConnectivityRestored();
        await next();
    } catch (error) {
        db.releaseUpdate(updateId);
        throw error;
    }
});

bot.catch(async (err) => {
    const error = err.error;
    const networkFailure = error instanceof HttpError;
    if (networkFailure) markConnectivityFailure();

    logger.error("Long-polling update failed", {
        event: "long_polling.update_failed",
        ...getContextLogFields(err.ctx),
        error_type: error instanceof GrammyError
            ? "telegram_api"
            : networkFailure
                ? "network"
                : "application",
        error: serializeError(error),
    });
    await sendAlert(`Ошибка обработки update ${err.ctx.update.update_id}.`);
});

bot.command("spam", handleSpam);
bot.command("unspam", handleUnspam);
bot.command("addadmin", handleAddAdmin);
bot.command("status", handleStatus);

bot.on("chat_member", handleNewMember);
bot.on("message:new_chat_members", handleNewMember);
bot.on("message", handleMessage);
bot.on("edited_message", handleMessage);

logger.info("Bot instance created successfully", {
    event: "bot.initialized",
    mode: "long_polling",
    db_path: config.dbPath,
    api_root_configured: config.telegramApiRoot !== undefined,
    alert_chat_configured: config.alertChatId !== undefined,
    duration_ms: Math.round((performance.now() - initializationStartedAt) * 100) / 100,
});
