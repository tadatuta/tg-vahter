import type { Context } from "grammy";
import * as db from "../db";
import { logger } from "../logger";
import { loadConfig } from "../config";

/**
 * Checks if the sender is authorized to use admin commands.
 * Authorization: super-admins from config, admins from DB, or chat administrators.
 */
async function isAuthorized(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId) return false;

    // Check super-admin list from env
    const config = loadConfig();
    if (config.adminIds.includes(userId)) return true;

    // Check DB admin table
    if (db.isAdmin(userId)) return true;

    // Check Telegram chat admin status
    if (ctx.chat) {
        try {
            const member = await ctx.api.getChatMember(ctx.chat.id, userId);
            return member.status === "administrator" || member.status === "creator";
        } catch {
            return false;
        }
    }

    return false;
}

/**
 * /ban command — adds a user to the blacklist.
 * Usage: `/ban <user_id>` or reply to a message with `/ban`
 */
export async function handleBan(ctx: Context): Promise<void> {
    if (!(await isAuthorized(ctx))) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const adminId = ctx.from?.id;
    if (!adminId) return;
    let targetUserId: number | undefined;
    let reason = "Manual ban by admin";

    // Try to get user from reply
    if (ctx.message?.reply_to_message?.from) {
        targetUserId = ctx.message.reply_to_message.from.id;
    }

    // Try to get user from command arguments
    if (!targetUserId) {
        const text = ctx.message?.text ?? "";
        const parts = text.split(/\s+/);
        if (parts.length >= 2) {
            const parsed = Number(parts[1]);
            if (!Number.isNaN(parsed)) {
                targetUserId = parsed;
            }
        }
        if (parts.length >= 3) {
            reason = parts.slice(2).join(" ");
        }
    }

    if (!targetUserId) {
        await ctx.reply("Использование: /ban <user_id> [причина] или ответом на сообщение");
        return;
    }

    db.addToBlacklist(targetUserId, adminId, reason);
    logger.info(`Admin ${adminId} banned user ${targetUserId}: ${reason}`);

    // Try to ban in current chat
    try {
        await ctx.api.banChatMember(chatId, targetUserId);
    } catch {
        // User might not be in this chat
    }

    await ctx.reply(`Пользователь ${targetUserId} добавлен в чёрный список.`);
}

/**
 * /unban command — removes a user from the blacklist.
 * Usage: `/unban <user_id>`
 */
export async function handleUnban(ctx: Context): Promise<void> {
    if (!(await isAuthorized(ctx))) return;

    const text = ctx.message?.text ?? "";
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
        await ctx.reply("Использование: /unban <user_id>");
        return;
    }

    const targetUserId = Number(parts[1]);
    if (Number.isNaN(targetUserId)) {
        await ctx.reply("Некорректный user_id.");
        return;
    }

    db.removeFromBlacklist(targetUserId);
    logger.info(`Admin ${ctx.from?.id ?? "unknown"} unbanned user ${targetUserId}`);

    await ctx.reply(`Пользователь ${targetUserId} удалён из чёрного списка.`);
}

/**
 * /addadmin command — adds a bot super-admin.
 * Only existing super-admins (from ADMIN_IDS env) can use this.
 */
export async function handleAddAdmin(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Only super-admins from config can add new admins
    const config = loadConfig();
    if (!config.adminIds.includes(userId)) {
        return;
    }

    const text = ctx.message?.text ?? "";
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
        await ctx.reply("Использование: /addadmin <user_id>");
        return;
    }

    const targetUserId = Number(parts[1]);
    if (Number.isNaN(targetUserId)) {
        await ctx.reply("Некорректный user_id.");
        return;
    }

    db.addAdmin(targetUserId);
    logger.info(`Super-admin ${userId} added admin ${targetUserId}`);

    await ctx.reply(`Пользователь ${targetUserId} добавлен как администратор бота.`);
}

/**
 * /status command — shows bot statistics.
 */
export async function handleStatus(ctx: Context): Promise<void> {
    if (!(await isAuthorized(ctx))) return;

    const stats = db.getStats();

    const text = [
        "📊 Статистика VahterBot:",
        `• Новых пользователей: ${stats.newUsers}`,
        `• Спамеров: ${stats.spammers}`,
        `• В чёрном списке: ${stats.blacklist}`,
    ].join("\n");

    await ctx.reply(text);
}
