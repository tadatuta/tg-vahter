import type { Context } from "grammy";
import * as db from "../db";
import { logger, serializeError } from "../logger";
import { loadConfig } from "../config";
import {
    getContextLogFields,
    logDecision,
} from "../observability";

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

    return false;
}

/**
 * /spam command — adds a user to the blacklist.
 * Usage: `/spam <user_id>` or reply to a message with `/spam`
 */
export async function handleSpam(ctx: Context): Promise<void> {
    if (!(await isAuthorized(ctx))) {
        logDecision(ctx, "skip", "unauthorized_admin_command", {
            command: "spam",
        }, "warn");
        return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
        logDecision(ctx, "skip", "missing_chat", {
            command: "spam",
        });
        return;
    }

    const adminId = ctx.from?.id;
    if (!adminId) {
        logDecision(ctx, "skip", "missing_admin_user", {
            command: "spam",
        });
        return;
    }
    let targetUserId: number | undefined;
    let reason = "Manual ban by admin";

    // Try to get user from reply
    const reply = ctx.message?.reply_to_message;
    if (reply?.from) {
        targetUserId = reply.from.id;

        // Log and delete the message
        const messageText = reply.text || reply.caption || "[Non-text message]";
        logger.info("Admin selected a replied-to message for banning", {
            event: "admin.spam_target_selected",
            ...getContextLogFields(ctx),
            target_user_id: targetUserId,
            target_message_id: reply.message_id,
            text_preview: messageText.slice(0, 200),
        });

        try {
            await ctx.api.deleteMessage(chatId, reply.message_id);
            logger.info("Replied-to message deletion succeeded", {
                event: "telegram_api.delete_message",
                ...getContextLogFields(ctx),
                target_user_id: targetUserId,
                target_message_id: reply.message_id,
                outcome: "success",
                flow: "admin_spam_reply",
            });
        } catch (error) {
            logger.error("Replied-to message deletion failed", {
                event: "telegram_api.delete_message",
                ...getContextLogFields(ctx),
                target_user_id: targetUserId,
                target_message_id: reply.message_id,
                outcome: "failure",
                flow: "admin_spam_reply",
                error: serializeError(error),
            });
        }
    }

    // Try to get user from command arguments
    const text = ctx.message?.text ?? "";
    const parts = text.split(/\s+/);

    if (!targetUserId) {
        if (parts.length >= 2) {
            const parsed = Number(parts[1]);
            if (!Number.isNaN(parsed)) {
                targetUserId = parsed;
            }
        }
        if (parts.length >= 3) {
            reason = parts.slice(2).join(" ");
        }
    } else {
        // If we got targetUserId from reply, the rest of the text is the reason
        if (parts.length >= 2) {
            reason = parts.slice(1).join(" ");
        }
    }

    if (!targetUserId) {
        logDecision(ctx, "skip", "invalid_command_arguments", {
            command: "spam",
        });
        await ctx.reply("Использование: /spam <user_id> [причина] или ответом на сообщение");
        return;
    }

    db.addToBlacklist(targetUserId, adminId, reason);
    logDecision(ctx, "ban", "manual_admin_blacklist", {
        command: "spam",
        target_user_id: targetUserId,
        admin_user_id: adminId,
        ban_reason: reason,
    }, "warn");

    // Try to ban in current chat
    try {
        await ctx.api.banChatMember(chatId, targetUserId);
        logger.info("Admin-requested user ban succeeded", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: targetUserId,
            outcome: "success",
            flow: "admin_spam",
        });
    } catch (error) {
        logger.error("Admin-requested user ban failed", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: targetUserId,
            outcome: "failure",
            flow: "admin_spam",
            error: serializeError(error),
        });
    }

    try {
        await ctx.deleteMessage();
        logger.info("Admin command deletion succeeded", {
            event: "telegram_api.delete_message",
            ...getContextLogFields(ctx),
            outcome: "success",
            flow: "admin_spam_command",
        });
    } catch (error) {
        logger.error("Admin command deletion failed", {
            event: "telegram_api.delete_message",
            ...getContextLogFields(ctx),
            outcome: "failure",
            flow: "admin_spam_command",
            error: serializeError(error),
        });
    }
}

/**
 * /unspam command — removes a user from the blacklist.
 * Usage: `/unspam <user_id>`
 */
export async function handleUnspam(ctx: Context): Promise<void> {
    if (!(await isAuthorized(ctx))) {
        logDecision(ctx, "skip", "unauthorized_admin_command", {
            command: "unspam",
        }, "warn");
        return;
    }

    const text = ctx.message?.text ?? "";
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
        logDecision(ctx, "skip", "invalid_command_arguments", {
            command: "unspam",
        });
        await ctx.reply("Использование: /unspam <user_id>");
        return;
    }

    const targetUserId = Number(parts[1]);
    if (Number.isNaN(targetUserId)) {
        logDecision(ctx, "skip", "invalid_target_user_id", {
            command: "unspam",
            provided_value: parts[1],
        });
        await ctx.reply("Некорректный user_id.");
        return;
    }

    db.removeFromBlacklist(targetUserId);
    db.removeSpammer(targetUserId);
    logDecision(ctx, "unban", "manual_admin_unblacklist", {
        command: "unspam",
        target_user_id: targetUserId,
        admin_user_id: ctx.from?.id,
    });

    // Unban in the current chat
    const chatId = ctx.chat?.id;
    if (chatId) {
        try {
            await ctx.api.unbanChatMember(chatId, targetUserId, { only_if_banned: true });
            logger.info("Admin-requested user unban succeeded", {
                event: "telegram_api.unban_chat_member",
                ...getContextLogFields(ctx),
                target_user_id: targetUserId,
                outcome: "success",
                flow: "admin_unspam",
            });
        } catch (error) {
            logger.error("Admin-requested user unban failed", {
                event: "telegram_api.unban_chat_member",
                ...getContextLogFields(ctx),
                target_user_id: targetUserId,
                outcome: "failure",
                flow: "admin_unspam",
                error: serializeError(error),
            });
        }
    }

    await ctx.reply(`Пользователь ${targetUserId} удалён из чёрного списка.`);
}

/**
 * /addadmin command — adds a bot super-admin.
 * Only existing super-admins (from ADMIN_IDS env) can use this.
 */
export async function handleAddAdmin(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) {
        logDecision(ctx, "skip", "missing_admin_user", {
            command: "addadmin",
        });
        return;
    }

    // Only super-admins from config can add new admins
    const config = loadConfig();
    if (!config.adminIds.includes(userId)) {
        logDecision(ctx, "skip", "unauthorized_super_admin_command", {
            command: "addadmin",
        }, "warn");
        return;
    }

    const text = ctx.message?.text ?? "";
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
        logDecision(ctx, "skip", "invalid_command_arguments", {
            command: "addadmin",
        });
        await ctx.reply("Использование: /addadmin <user_id>");
        return;
    }

    const targetUserId = Number(parts[1]);
    if (Number.isNaN(targetUserId)) {
        logDecision(ctx, "skip", "invalid_target_user_id", {
            command: "addadmin",
            provided_value: parts[1],
        });
        await ctx.reply("Некорректный user_id.");
        return;
    }

    db.addAdmin(targetUserId);
    logDecision(ctx, "grant_admin", "super_admin_added_bot_admin", {
        command: "addadmin",
        target_user_id: targetUserId,
        admin_user_id: userId,
    });

    await ctx.reply(`Пользователь ${targetUserId} добавлен как администратор бота.`);
}

/**
 * /status command — shows bot statistics.
 */
export async function handleStatus(ctx: Context): Promise<void> {
    if (!(await isAuthorized(ctx))) {
        logDecision(ctx, "skip", "unauthorized_admin_command", {
            command: "status",
        }, "warn");
        return;
    }

    const stats = db.getStats();
    logDecision(ctx, "respond", "status_requested", {
        command: "status",
        stats,
    });

    const text = [
        "📊 Статистика VahterBot:",
        `• Новых пользователей: ${stats.newUsers}`,
        `• Спамеров: ${stats.spammers}`,
        `• В чёрном списке: ${stats.blacklist}`,
    ].join("\n");

    await ctx.reply(text);
}
