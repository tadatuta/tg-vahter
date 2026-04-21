import { webhookCallback } from "grammy";
import { bot } from "./bot";
import { logger } from "./logger";

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
    logger.info("Running in Yandex Cloud Functions (webhook) mode");
} else {
    // Local development mode (long polling)
    logger.info("Running in local development (long polling) mode");
    bot.start({
        allowed_updates: [
            "message",
            "chat_member",
        ],
        onStart: (info) => {
            logger.info(`Bot @${info.username} started in polling mode`);
            console.log(`Bot @${info.username} started in polling mode`);
        },
    });
}

// Export handler for Yandex Cloud Functions
export const handler = isServerless
    ? webhookCallback(bot, "aws-lambda-async")
    : async () => {
        return {
            statusCode: 200,
            body: "Bot is running in local development mode (long polling). Webhook is disabled.",
        };
    };
