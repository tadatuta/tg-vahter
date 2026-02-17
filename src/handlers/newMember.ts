import type { Context } from "grammy";
import * as db from "../db";
import { logger } from "../logger";

/**
 * Handles `chat_member` updates and `message:new_chat_members` events.
 *
 * 1. If user is blacklisted → ban immediately
 * 2. Otherwise → register in new_users table
 */
export async function handleNewMember(ctx: Context): Promise<void> {
    // Determine user and chat from chat_member update or new_chat_members message
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Handle ChatMemberUpdated (preferred, requires chat_member update type in allowed_updates)
    if (ctx.chatMember) {
        const { new_chat_member: member } = ctx.chatMember;
        if (!member) return;

        // Only react when someone joins (member, restricted, or administrator)
        const joinStatuses = new Set(["member", "restricted", "administrator"]);
        if (!joinStatuses.has(member.status)) return;

        const user = member.user;
        if (user.is_bot) return;

        await processJoin(ctx, user.id, chatId, user.username, user.first_name);
        return;
    }

    // Fallback: handle new_chat_members from the message
    const newMembers = ctx.message?.new_chat_members;
    if (!newMembers) return;

    for (const user of newMembers) {
        if (user.is_bot) continue;
        await processJoin(ctx, user.id, chatId, user.username, user.first_name);
    }
}

async function processJoin(
    ctx: Context,
    userId: number,
    chatId: number,
    username: string | undefined,
    firstName: string | undefined
): Promise<void> {
    const displayName = username ? `@${username}` : firstName ?? String(userId);

    // Check blacklist first
    if (db.isBlacklisted(userId)) {
        logger.info(`Blacklisted user ${displayName} (${userId}) joined chat ${chatId} — banning`);
        await banAndCleanup(ctx, userId, chatId);
        return;
    }

    // Register as a new user
    db.addNewUser(userId, chatId, username, firstName);
    logger.info(`New user ${displayName} (${userId}) registered in chat ${chatId}`);
}

async function banAndCleanup(
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

    // Delete the join message itself if present
    if (ctx.message?.message_id) {
        try {
            await ctx.api.deleteMessage(chatId, ctx.message.message_id);
        } catch {
            // may fail if message is already deleted or bot lacks perms
        }
    }
}
