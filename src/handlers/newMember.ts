import type { Context } from "grammy";
import * as db from "../db";
import { sendAlert, sendSuccessfulBanAlert } from "../alerts";
import { logger, serializeError } from "../logger";
import {
    getContextLogFields,
    logDecision,
} from "../observability";

/**
 * Handles `chat_member` updates and `message:new_chat_members` events.
 *
 * 1. If user is globally blacklisted or a known spammer → ban immediately.
 * 2. Otherwise ensure per-chat probation state without resetting existing trust.
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

        // React only to an actual transition from outside the chat to an active status.
        const joinStatuses = new Set(["member", "restricted", "administrator"]);
        const previousStatus = ctx.chatMember.old_chat_member.status;
        const wasOutside = previousStatus === "left" || previousStatus === "kicked";
        if (!joinStatuses.has(member.status) || !wasOutside) {
            logDecision(ctx, "skip", "not_a_join_transition", {
                previous_member_status: previousStatus,
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

    // Global lists always win, including when the user joins another chat.
    const blacklisted = db.isBlacklisted(userId);
    const knownSpammer = db.isSpammer(userId);
    if (blacklisted || knownSpammer) {
        logDecision(ctx, "ban", blacklisted
            ? "blacklisted_user_joined"
            : "known_spammer_joined", {
            target_user_id: userId,
            display_name: displayName,
        }, "warn");
        const banReason = db.getGlobalBanReason(userId);
        await banAndCleanup(ctx, userId, chatId, displayName,
            banReason?.reason ?? (blacklisted
                ? "Пользователь находится в глобальном чёрном списке."
                : "Пользователь ранее распознан как спамер."));
        return;
    }

    // Ensure the per-chat state exists. ON CONFLICT only refreshes profile data,
    // so a trusted user's rejoin deliberately does not reset trust.
    db.ensureChatUser(userId, chatId, username, firstName);
    const state = db.getChatUserState(userId, chatId);
    logDecision(ctx, "register", state.trusted ? "trusted_user_rejoined" : "new_user_joined", {
        target_user_id: userId,
        display_name: displayName,
        approved_messages: state.approvedMessages,
        trusted: state.trusted,
    });
}

async function banAndCleanup(
    ctx: Context,
    userId: number,
    chatId: number,
    displayName: string,
    reason: string
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
        await sendSuccessfulBanAlert({
            userId,
            chatId,
            displayName,
            reason,
            quote: "[бан при входе; пользователь ещё не отправлял сообщение]",
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
        await sendAlert(`Не удалось забанить ${userId} при входе в чат ${chatId}.`);
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
