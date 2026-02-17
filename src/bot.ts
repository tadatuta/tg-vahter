import { Bot } from "grammy";
import { loadConfig } from "./config";
import { initDatabase } from "./db";
import { initHeuristics } from "./heuristics";
import { initLogger, logger } from "./logger";
import { handleNewMember } from "./handlers/newMember";
import { handleMessage } from "./handlers/message";
import {
    handleBan,
    handleUnban,
    handleAddAdmin,
    handleStatus,
} from "./handlers/admin";

const config = loadConfig();

// Initialize subsystems
initLogger(config.logFile);
initDatabase(config.dbPath);
initHeuristics(config.spamRegex);

// Create bot
export const bot = new Bot(config.botToken);

// --- Error handling ---
bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Error handling update ${ctx.update.update_id}: ${msg}`);
});

// --- Admin commands (registered BEFORE generic handlers) ---
bot.command("ban", handleBan);
bot.command("unban", handleUnban);
bot.command("addadmin", handleAddAdmin);
bot.command("status", handleStatus);

// --- Chat member updates (user joins) ---
bot.on("chat_member", handleNewMember);
bot.on("message:new_chat_members", handleNewMember);

// --- Regular messages ---
bot.on("message", handleMessage);

logger.info("Bot instance created successfully");
