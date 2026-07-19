import type { Context } from "grammy";
import * as db from "../db";
import { isSpam } from "../heuristics";
import { logger, serializeError } from "../logger";
import {
    getContextLogFields,
    logDecision,
} from "../observability";

/**
 * Handles regular messages in group chats.
 * Only processes each user's first message per chat.
 *
 * Flow:
 * 1. Skip bots, private chats, service messages without text
 * 2. Blacklist check → ban
 * 3. Already verified user → skip
 * 4. New user (in new_users table or implicit join) → run heuristics
 *    - Spam → ban, delete, log
 *    - Not spam → remove from new_users, log message
 */
export async function handleMessage(ctx: Context): Promise<void> {
    const user = ctx.from;
    const chat = ctx.chat;
    const message = ctx.message;

    if (!user || !chat || !message) {
        logDecision(ctx, "skip", "missing_message_context", {
            has_user: user !== undefined,
            has_chat: chat !== undefined,
            has_message: message !== undefined,
        });
        return;
    }
    if (user.is_bot) {
        logDecision(ctx, "skip", "sender_is_bot");
        return;
    }

    // Only process group/supergroup messages
    if (chat.type !== "group" && chat.type !== "supergroup") {
        logDecision(ctx, "skip", "unsupported_chat_type");
        return;
    }

    // Skip service messages that don't carry user content
    // (new_chat_members is handled separately)
    if (message.new_chat_members || message.left_chat_member) {
        logDecision(ctx, "skip", "membership_service_message");
        return;
    }

    const userId = user.id;
    const chatId = chat.id;
    const displayName = user.username ? `@${user.username}` : user.first_name;

    // 1. Blacklist check
    if (db.isBlacklisted(userId)) {
        logDecision(ctx, "ban", "blacklisted_user", {
            display_name: displayName,
        }, "warn");
        await banAndDeleteMessages(ctx, userId, chatId);
        return;
    }

    // 2. Already verified — do nothing
    if (db.isKnownUser(userId, chatId)) {
        logDecision(ctx, "skip", "known_user", {
            display_name: displayName,
        });
        return;
    }

    // 3. If user isn't in new_users, they might have joined without a join message
    //    (e.g., the bot was added after the user joined). Register them now.
    if (!db.isNewUser(userId, chatId)) {
        db.addNewUser(userId, chatId, user.username, user.first_name);
        logger.info("Implicit join registered", {
            event: "user.implicit_join_registered",
            ...getContextLogFields(ctx),
            display_name: displayName,
        });
    }

    // 4. First message from a new user — run heuristics
    const messageText = extractText(message);

    if (isSpam(messageText)) {
        // SPAM detected
        const reason = `Spam heuristic match: "${messageText?.slice(0, 200)}"`;
        db.addSpammer(userId, user.username, reason);
        db.removeNewUser(userId, chatId);

        logDecision(ctx, "ban", "spam_heuristic_match", {
            display_name: displayName,
            text_preview: messageText?.slice(0, 200),
        }, "warn");

        await banAndDeleteMessages(ctx, userId, chatId);
    } else {
        // Clean first message
        db.removeNewUser(userId, chatId);
        db.logMessage(userId, chatId, messageText);

        logDecision(ctx, "approve", "first_message_clean", {
            display_name: displayName,
            content_type: messageText === undefined ? "non_text" : "text",
            text_preview: messageText?.slice(0, 200),
        });
    }
}

/**
 * Extracts text content from a message, including captions.
 */
function extractText(
    message: NonNullable<Context["message"]>
): string | undefined {
    return message.text ?? message.caption ?? undefined;
}

/**
 * Bans a user and attempts to delete their message.
 */
async function banAndDeleteMessages(
    ctx: Context,
    userId: number,
    chatId: number
): Promise<void> {
    try {
        await ctx.api.banChatMember(chatId, userId);
        logger.info("User ban succeeded", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: userId,
            outcome: "success",
        });
    } catch (err) {
        logger.error("User ban failed", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: userId,
            outcome: "failure",
            error: serializeError(err),
        });
    }

    if (ctx.message?.message_id) {
        try {
            await ctx.api.deleteMessage(chatId, ctx.message.message_id);
            logger.info("Message deletion succeeded", {
                event: "telegram_api.delete_message",
                ...getContextLogFields(ctx),
                outcome: "success",
            });
        } catch (err) {
            logger.error("Message deletion failed", {
                event: "telegram_api.delete_message",
                ...getContextLogFields(ctx),
                outcome: "failure",
                error: serializeError(err),
            });
        }
    } else {
        logger.warn("Message deletion skipped because message_id is missing", {
            event: "telegram_api.delete_message",
            ...getContextLogFields(ctx),
            outcome: "skipped",
            reason: "missing_message_id",
        });
    }
}
