import type { Context } from "grammy";
import * as db from "../db";
import { logger, serializeError } from "../logger";
import {
    getContextLogFields,
    logDecision,
} from "../observability";

/**
 * Handles `chat_member` updates and `message:new_chat_members` events.
 *
 * 1. If user is blacklisted → ban immediately
 * 2. Otherwise → register in new_users table
 */
export async function handleNewMember(ctx: Context): Promise<void> {
    // Determine user and chat from chat_member update or new_chat_members message
    const chatId = ctx.chat?.id;
    if (!chatId) {
        logDecision(ctx, "skip", "missing_chat");
        return;
    }

    // Handle ChatMemberUpdated (preferred, requires chat_member update type in allowed_updates)
    if (ctx.chatMember) {
        const { new_chat_member: member } = ctx.chatMember;
        if (!member) {
            logDecision(ctx, "skip", "missing_new_chat_member");
            return;
        }

        // Only react when someone joins (member, restricted, or administrator)
        const joinStatuses = new Set(["member", "restricted", "administrator"]);
        if (!joinStatuses.has(member.status)) {
            logDecision(ctx, "skip", "not_a_join_transition", {
                member_status: member.status,
            });
            return;
        }

        const user = member.user;
        if (user.is_bot) {
            logDecision(ctx, "skip", "joined_member_is_bot", {
                target_user_id: user.id,
            });
            return;
        }

        await processJoin(ctx, user.id, chatId, user.username, user.first_name);
        return;
    }

    // Fallback: handle new_chat_members from the message
    const newMembers = ctx.message?.new_chat_members;
    if (!newMembers) {
        logDecision(ctx, "skip", "missing_new_chat_members");
        return;
    }

    // Delete the "user joined" service message
    try {
        await ctx.deleteMessage();
        logger.info("Join service message deletion succeeded", {
            event: "telegram_api.delete_message",
            ...getContextLogFields(ctx),
            outcome: "success",
            flow: "new_member_service_message",
        });
    } catch (error) {
        logger.error("Join service message deletion failed", {
            event: "telegram_api.delete_message",
            ...getContextLogFields(ctx),
            outcome: "failure",
            flow: "new_member_service_message",
            error: serializeError(error),
        });
    }

    for (const user of newMembers) {
        if (user.is_bot) {
            logDecision(ctx, "skip", "joined_member_is_bot", {
                target_user_id: user.id,
            });
            continue;
        }
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
        logDecision(ctx, "ban", "blacklisted_user_joined", {
            target_user_id: userId,
            display_name: displayName,
        }, "warn");
        await banAndCleanup(ctx, userId, chatId);
        return;
    }

    // Register as a new user
    db.addNewUser(userId, chatId, username, firstName);
    logDecision(ctx, "register", "new_user_joined", {
        target_user_id: userId,
        display_name: displayName,
    });
}

async function banAndCleanup(
    ctx: Context,
    userId: number,
    chatId: number
): Promise<void> {
    try {
        await ctx.api.banChatMember(chatId, userId);
        logger.info("Joined user ban succeeded", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: userId,
            outcome: "success",
            flow: "new_member",
        });
    } catch (err) {
        logger.error("Joined user ban failed", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: userId,
            outcome: "failure",
            flow: "new_member",
            error: serializeError(err),
        });
    }

    // Delete the join message itself if present
    if (ctx.message?.message_id) {
        try {
            await ctx.api.deleteMessage(chatId, ctx.message.message_id);
            logger.info("Join message deletion succeeded", {
                event: "telegram_api.delete_message",
                ...getContextLogFields(ctx),
                outcome: "success",
                flow: "blacklisted_new_member",
            });
        } catch (error) {
            logger.error("Join message deletion failed", {
                event: "telegram_api.delete_message",
                ...getContextLogFields(ctx),
                outcome: "failure",
                flow: "blacklisted_new_member",
                error: serializeError(error),
            });
        }
    }
}
