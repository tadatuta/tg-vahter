import type { Context } from "grammy";
import * as db from "../db";
import { sendAlert, sendSuccessfulBanAlert } from "../alerts";
import { getSpamHeuristic, type SpamHeuristic } from "../heuristics";
import { logger, serializeError } from "../logger";
import { getContextLogFields, logDecision } from "../observability";

interface ExtractedContent {
    text?: string;
    type: "text" | "caption" | "non_text";
}

const SPAM_HEURISTIC_REASONS: Record<SpamHeuristic, string> = {
    telegram_private_invite_link: "приватная ссылка-приглашение Telegram",
    disallowed_unicode_control: "недопустимые управляющие Unicode-символы",
    mixed_latin_cyrillic_word: "смешение латиницы и кириллицы в одном слове",
    configured_regex: "совпадение с настроенным spam-регулярным выражением",
};

export function extractContent(message: NonNullable<Context["msg"]>): ExtractedContent {
    const visibleText = message.text ?? message.caption;
    const entities = message.text ? message.entities : message.caption_entities;
    const hiddenUrls = (entities ?? [])
        .filter((entity) => entity.type === "text_link" && "url" in entity)
        .map((entity) => (entity as { url: string }).url)
        .filter(Boolean);

    const parts = [visibleText, ...hiddenUrls].filter(
        (part): part is string => typeof part === "string" && part.length > 0
    );
    if (parts.length === 0) return { type: "non_text" };

    return {
        text: [...new Set(parts)].join("\n"),
        type: message.text ? "text" : "caption",
    };
}

export async function handleMessage(ctx: Context): Promise<void> {
    const user = ctx.from;
    const chat = ctx.chat;
    const message = ctx.msg;

    if (!user || !chat || !message) {
        logDecision(ctx, "skip", "missing_message_context");
        return;
    }
    if (message.sender_chat) {
        logDecision(ctx, "skip", "sender_chat_is_exempt", {
            sender_chat_id: message.sender_chat.id,
        });
        return;
    }
    if (user.is_bot) {
        logDecision(ctx, "skip", "sender_is_bot");
        return;
    }
    if (chat.type !== "group" && chat.type !== "supergroup") {
        logDecision(ctx, "skip", "unsupported_chat_type");
        return;
    }
    if ("new_chat_members" in message || "left_chat_member" in message) {
        logDecision(ctx, "skip", "membership_service_message");
        return;
    }

    const userId = user.id;
    const chatId = chat.id;
    const messageId = message.message_id;
    const displayName = user.username ? `@${user.username}` : user.first_name;
    const edited = ctx.update.edited_message !== undefined;
    const content = extractContent(message);

    if (db.isBlacklisted(userId)) {
        logDecision(ctx, "ban", "blacklisted_user", { display_name: displayName }, "warn");
        const banReason = db.getGlobalBanReason(userId);
        await banAndDeleteMessage(ctx, userId, chatId, messageId, {
            displayName,
            reason: banReason?.reason ?? "Пользователь находится в глобальном чёрном списке.",
            quote: content.text,
        });
        return;
    }
    if (db.isSpammer(userId)) {
        logDecision(ctx, "ban", "known_global_spammer", { display_name: displayName }, "warn");
        const banReason = db.getGlobalBanReason(userId);
        await banAndDeleteMessage(ctx, userId, chatId, messageId, {
            displayName,
            reason: banReason?.reason ?? "Пользователь ранее распознан как спамер.",
            quote: content.text,
        });
        return;
    }

    db.ensureChatUser(userId, chatId, user.username, user.first_name);
    const existingProbationNumber = db.getProbationMessageNumber(userId, chatId, messageId);
    const state = db.getChatUserState(userId, chatId);

    if (state.trusted && existingProbationNumber === undefined) {
        logDecision(ctx, "skip", edited ? "trusted_user_non_probation_edit" : "trusted_user", {
            display_name: displayName,
        });
        return;
    }

    if (!content.text) {
        logDecision(ctx, "skip", "non_text_does_not_count", {
            display_name: displayName,
            approved_messages: state.approvedMessages,
        });
        return;
    }

    const spamHeuristic = getSpamHeuristic(content.text);
    if (spamHeuristic) {
        const reason = `Сработала антиспам-эвристика: ${SPAM_HEURISTIC_REASONS[spamHeuristic]}.`;
        db.recordSpammer({
            updateId: ctx.update.update_id,
            messageId,
            userId,
            chatId,
            username: user.username,
            reason,
            text: content.text,
            contentType: content.type,
            probationNumber: existingProbationNumber ?? state.approvedMessages + 1,
        });

        logDecision(ctx, "ban", edited ? "edited_probation_message_became_spam" : "spam_heuristic_match", {
            display_name: displayName,
            spam_heuristic: spamHeuristic,
            text_preview: content.text.slice(0, 200),
        }, "warn");
        await banAndDeleteMessage(ctx, userId, chatId, messageId, {
            displayName,
            reason,
            quote: content.text,
        });
        return;
    }

    if (existingProbationNumber !== undefined) {
        db.updateApprovedMessage(chatId, messageId, content.text, content.type);
        logDecision(ctx, "approve", "probation_message_edit_clean", {
            display_name: displayName,
            probation_number: existingProbationNumber,
        });
        return;
    }

    const result = db.approveProbationMessage({
        updateId: ctx.update.update_id,
        messageId,
        userId,
        chatId,
        username: user.username,
        firstName: user.first_name,
        text: content.text,
        contentType: content.type,
    });

    logDecision(ctx, "approve", result.trusted ? "probation_completed" : "probation_message_clean", {
        display_name: displayName,
        content_type: content.type,
        probation_number: result.probationNumber,
        approved_messages: result.approvedMessages,
        trusted: result.trusted,
        text_preview: content.text.slice(0, 200),
    });
}

async function banAndDeleteMessage(
    ctx: Context,
    userId: number,
    chatId: number,
    messageId: number,
    alert: { displayName?: string; reason: string; quote?: string }
): Promise<void> {
    let banSucceeded = false;
    try {
        await ctx.api.banChatMember(chatId, userId);
        banSucceeded = true;
        logger.info("User ban succeeded", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: userId,
            outcome: "success",
        });
    } catch (error) {
        logger.error("User ban failed", {
            event: "telegram_api.ban_chat_member",
            ...getContextLogFields(ctx),
            target_user_id: userId,
            outcome: "failure",
            error: serializeError(error),
        });
        await sendAlert(`Не удалось забанить ${userId} в чате ${chatId}.`);
    }

    try {
        await ctx.api.deleteMessage(chatId, messageId);
        logger.info("Message deletion succeeded", {
            event: "telegram_api.delete_message",
            ...getContextLogFields(ctx),
            outcome: "success",
        });
    } catch (error) {
        logger.error("Message deletion failed", {
            event: "telegram_api.delete_message",
            ...getContextLogFields(ctx),
            outcome: "failure",
            error: serializeError(error),
        });
        await sendAlert(`Не удалось удалить сообщение ${ctx.msg?.message_id} в чате ${chatId}.`);
    }

    if (banSucceeded) {
        await sendSuccessfulBanAlert({ userId, chatId, ...alert });
    }
}
