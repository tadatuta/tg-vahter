import type { Context } from "grammy";
import * as db from "../db";
import { isSpam } from "../heuristics";
import { logger } from "../logger";

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

    if (!user || !chat || !message) return;
    if (user.is_bot) return;

    // Only process group/supergroup messages
    if (chat.type !== "group" && chat.type !== "supergroup") return;

    // Skip service messages that don't carry user content
    // (new_chat_members is handled separately)
    if (message.new_chat_members || message.left_chat_member) return;

    const userId = user.id;
    const chatId = chat.id;
    const displayName = user.username ? `@${user.username}` : user.first_name;

    // 1. Blacklist check
    if (db.isBlacklisted(userId)) {
        logger.info(`Blacklisted user ${displayName} (${userId}) sent message in ${chatId} — banning`);
        await banAndDeleteMessages(ctx, userId, chatId);
        return;
    }

    // 2. Already verified — do nothing
    if (db.isKnownUser(userId, chatId)) return;

    // 3. If user isn't in new_users, they might have joined without a join message
    //    (e.g., the bot was added after the user joined). Register them now.
    if (!db.isNewUser(userId, chatId)) {
        db.addNewUser(userId, chatId, user.username, user.first_name);
        logger.info(`Implicit join: ${displayName} (${userId}) registered in chat ${chatId}`);
    }

    // 4. First message from a new user — run heuristics
    const messageText = extractText(message);

    if (isSpam(messageText)) {
        // SPAM detected
        const reason = `Spam heuristic match: "${messageText?.slice(0, 200)}"`;
        db.addSpammer(userId, user.username, reason);
        db.removeNewUser(userId, chatId);

        logger.warn(`SPAM from ${displayName} (${userId}) in ${chatId}: ${messageText?.slice(0, 200)}`);

        await banAndDeleteMessages(ctx, userId, chatId);
    } else {
        // Clean first message
        db.removeNewUser(userId, chatId);
        db.logMessage(userId, chatId, messageText);

        logger.info(`Approved first message from ${displayName} (${userId}) in ${chatId}`);
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
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to ban user ${userId} in chat ${chatId}: ${msg}`);
    }

    if (ctx.message?.message_id) {
        try {
            await ctx.api.deleteMessage(chatId, ctx.message.message_id);
        } catch {
            // may fail if message is already deleted or bot lacks perms
        }
    }
}
