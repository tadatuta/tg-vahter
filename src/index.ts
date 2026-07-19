import { webhookCallback } from "grammy";
import { bot } from "./bot";
import { logger } from "./logger";
import {
    wrapWebhookHandler,
    type FunctionContext,
    type WebhookEvent,
} from "./observability";

/**
 * Entry point for Yandex Cloud Functions.
 *
 * The function receives HTTP requests from Telegram's webhook.
 * grammY's webhookCallback with "std/http" adapter handles
 * the request/response cycle.
 *
 * For local development, the bot starts in long-polling mode
 * when YCF_RUNTIME environment variable is not set.
 */

const isServerless = !!process.env.YCF_RUNTIME;

if (isServerless) {
    // Yandex Cloud Functions mode (webhook)
    logger.info("Running in Yandex Cloud Functions (webhook) mode", {
        event: "runtime.started",
        mode: "webhook",
    });
} else {
    // Local development mode (long polling)
    logger.info("Running in local development (long polling) mode", {
        event: "runtime.started",
        mode: "long_polling",
    });
    bot.start({
        allowed_updates: [
            "message",
            "chat_member",
        ],
        onStart: (info) => {
            logger.info(`Bot @${info.username} started in polling mode`, {
                event: "long_polling.started",
                bot_id: info.id,
                bot_username: info.username,
            });
        },
    });
}

const webhookHandler = isServerless
    ? wrapWebhookHandler(
        webhookCallback(bot, "aws-lambda-async") as unknown as (
            event: WebhookEvent,
            context: FunctionContext
        ) => Promise<{ statusCode: number; body?: string }>
    )
    : undefined;

// Export handler for Yandex Cloud Functions
export async function handler(
    event: WebhookEvent,
    context: FunctionContext
): Promise<{ statusCode: number; body?: string }> {
    if (webhookHandler) {
        return webhookHandler(event, context);
    }

    return {
        statusCode: 200,
        body: "Bot is running in local development mode (long polling). Webhook is disabled.",
    };
}
