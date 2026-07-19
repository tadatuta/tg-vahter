import { Bot } from "grammy";
import { loadConfig } from "./config";
import { initDatabase } from "./db";
import { initHeuristics } from "./heuristics";
import { initLogger, logger, serializeError } from "./logger";
import { getContextLogFields, traceUpdate } from "./observability";
import { handleNewMember } from "./handlers/newMember";
import { handleMessage } from "./handlers/message";
import {
    handleSpam,
    handleUnspam,
    handleAddAdmin,
    handleStatus,
} from "./handlers/admin";

const config = loadConfig();

// Initialize subsystems
initLogger(config.logFile);
const initializationStartedAt = performance.now();

try {
    initDatabase(config.dbPath);
    initHeuristics(config.spamRegex);
} catch (error) {
    logger.error("Bot initialization failed", {
        event: "bot.initialization_failed",
        duration_ms: Math.round((performance.now() - initializationStartedAt) * 100) / 100,
        error: serializeError(error),
    });
    throw error;
}

// Create bot
export const bot = new Bot(config.botToken);

// --- Per-update tracing (registered first to wrap every handler) ---
bot.use(traceUpdate);

// --- Error handling ---
bot.catch((err) => {
    const ctx = err.ctx;
    logger.error("Long-polling update failed", {
        event: "long_polling.update_failed",
        ...getContextLogFields(ctx),
        error: serializeError(err.error),
    });
});

// --- Admin commands (registered BEFORE generic handlers) ---
bot.command("spam", handleSpam);
bot.command("unspam", handleUnspam);
bot.command("addadmin", handleAddAdmin);
bot.command("status", handleStatus);

// --- Chat member updates (user joins) ---
bot.on("chat_member", handleNewMember);
bot.on("message:new_chat_members", handleNewMember);

// --- Regular messages ---
bot.on("message", handleMessage);

logger.info("Bot instance created successfully", {
    event: "bot.initialized",
    mode: process.env.YCF_RUNTIME ? "webhook" : "long_polling",
    db_path: config.dbPath,
    log_file: config.logFile,
    duration_ms: Math.round((performance.now() - initializationStartedAt) * 100) / 100,
});
