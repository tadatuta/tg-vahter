import type { Context, NextFunction } from "grammy";
import * as db from "../db";
import { sendAlert } from "../alerts";
import { logger, serializeError } from "../logger";
import { getContextLogFields, logDecision } from "../observability";

let superAdminIds: ReadonlySet<number> = new Set();

export function initAdminConfig(ids: readonly number[]): void {
    superAdminIds = new Set(ids);
}

function parseUserId(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function isAuthorized(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return false;

    if (superAdminIds.has(userId)) return true;
    if (db.isChatAdmin(userId, chatId)) return true;

    try {
        const member = await ctx.api.getChatMember(chatId, userId);
        return member.status === "administrator" || member.status === "creator";
    } catch (error) {
        logger.warn("Admin authorization lookup failed", {
            event: "telegram_api.get_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: userId,
            outcome: "failure",
            flow: "admin_authorization",
            error: serializeError(error),
        });
        return false;
    }
}

async function passUnauthorizedCommand(
    ctx: Context,
    next: NextFunction | undefined,
    command: string
): Promise<void> {
    logger.warn("Unauthorized admin command will be processed as a regular message", {
        event: "admin.command_unauthorized",
        ...getContextLogFields(ctx),
        command,
    });
    if (next) await next();
}

export async function handleSpam(ctx: Context, next?: NextFunction): Promise<void> {
    if (!(await isAuthorized(ctx))) {
        await passUnauthorizedCommand(ctx, next, "spam");
        return;
    }

    const chatId = ctx.chat?.id;
    const adminId = ctx.from?.id;
    if (!chatId || !adminId) return;

    const reply = ctx.msg?.reply_to_message;
    const parts = (ctx.msg?.text ?? "").trim().split(/\s+/);
    const targetUserId = reply?.from?.id ?? parseUserId(parts[1]);
    const reasonStart = reply?.from ? 1 : 2;
    const reason = parts.slice(reasonStart).join(" ") || "Manual global ban by chat admin";

    if (!targetUserId) {
        logDecision(ctx, "skip", "invalid_command_arguments", { command: "spam" });
        await ctx.reply("Использование: /spam <user_id> [причина] или ответом на сообщение");
        return;
    }

    db.addToBlacklist(targetUserId, adminId, reason);
    logDecision(ctx, "ban", "manual_global_blacklist", {
        command: "spam",
        target_user_id: targetUserId,
        admin_user_id: adminId,
        ban_reason: reason,
    }, "warn");

    if (reply) {
        try {
            await ctx.api.deleteMessage(chatId, reply.message_id);
        } catch (error) {
            logger.error("Replied-to message deletion failed", {
                event: "telegram_api.delete_message",
                ...getContextLogFields(ctx),
                target_user_id: targetUserId,
                error: serializeError(error),
            });
        }
    }

    try {
        await ctx.api.banChatMember(chatId, targetUserId);
    } catch (error) {
        logger.error("Admin-requested user ban failed", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: targetUserId,
            error: serializeError(error),
        });
        await sendAlert(`Не удалось забанить ${targetUserId} в чате ${chatId}.`);
    }

    try {
        await ctx.deleteMessage();
    } catch (error) {
        logger.warn("Admin command deletion failed", {
            event: "telegram_api.delete_message",
            ...getContextLogFields(ctx),
            error: serializeError(error),
        });
    }
}

export async function handleUnspam(ctx: Context, next?: NextFunction): Promise<void> {
    if (!(await isAuthorized(ctx))) {
        await passUnauthorizedCommand(ctx, next, "unspam");
        return;
    }

    const targetUserId = parseUserId((ctx.msg?.text ?? "").trim().split(/\s+/)[1]);
    if (!targetUserId) {
        logDecision(ctx, "skip", "invalid_command_arguments", { command: "unspam" });
        await ctx.reply("Использование: /unspam <user_id>");
        return;
    }

    db.removeFromBlacklist(targetUserId);
    db.removeSpammer(targetUserId);
    logDecision(ctx, "unban", "manual_global_unblacklist", {
        command: "unspam",
        target_user_id: targetUserId,
        admin_user_id: ctx.from?.id,
    });

    if (ctx.chat) {
        try {
            await ctx.api.unbanChatMember(ctx.chat.id, targetUserId, { only_if_banned: true });
        } catch (error) {
            logger.error("Admin-requested user unban failed", {
                event: "telegram_api.unban_chat_member",
                ...getContextLogFields(ctx),
                target_user_id: targetUserId,
                error: serializeError(error),
            });
        }
    }

    await ctx.reply(`Глобальная блокировка ${targetUserId} снята. В других чатах разбан выполняется локально.`);
}

export async function handleAddAdmin(ctx: Context, next?: NextFunction): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    if (!superAdminIds.has(userId)) {
        await passUnauthorizedCommand(ctx, next, "addadmin");
        return;
    }

    const targetUserId = parseUserId((ctx.msg?.text ?? "").trim().split(/\s+/)[1]);
    if (!targetUserId) {
        logDecision(ctx, "skip", "invalid_command_arguments", { command: "addadmin" });
        await ctx.reply("Использование: /addadmin <user_id>");
        return;
    }

    db.addChatAdmin(targetUserId, chatId, userId);
    logDecision(ctx, "grant_admin", "super_admin_added_chat_admin", {
        command: "addadmin",
        target_user_id: targetUserId,
        admin_user_id: userId,
        target_chat_id: chatId,
    });
    await ctx.reply(`Пользователь ${targetUserId} добавлен как администратор бота в этом чате.`);
}

export async function handleStatus(ctx: Context, next?: NextFunction): Promise<void> {
    if (!(await isAuthorized(ctx))) {
        await passUnauthorizedCommand(ctx, next, "status");
        return;
    }

    const stats = db.getStats();
    logDecision(ctx, "respond", "status_requested", { command: "status", stats });
    await ctx.reply([
        "📊 Статистика VahterBot:",
        `• На проверке: ${stats.probationUsers}`,
        `• Доверенных: ${stats.trustedUsers}`,
        `• Спамеров: ${stats.spammers}`,
        `• В глобальном чёрном списке: ${stats.blacklist}`,
    ].join("\n"));
}
