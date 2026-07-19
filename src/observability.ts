import type { Context, NextFunction } from "grammy";
import {
    logger,
    serializeError,
    type LogFields,
} from "./logger";

type UpdateRecord = Record<string, unknown> & { update_id?: unknown };

export interface WebhookEvent {
    body?: string;
    headers: Record<string, string | undefined>;
    httpMethod?: string;
}

export interface FunctionContext {
    requestId?: string;
}

const contextsWithDecision = new WeakSet<object>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function getUpdateType(update: UpdateRecord | undefined): string {
    if (!update) return "unknown";
    return Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
}

function getRawUpdate(event: WebhookEvent): UpdateRecord | undefined {
    if (typeof event.body === "string") {
        try {
            return asRecord(JSON.parse(event.body)) as UpdateRecord | undefined;
        } catch {
            return undefined;
        }
    }

    return undefined;
}

function getRawMessage(update: UpdateRecord | undefined): Record<string, unknown> | undefined {
    if (!update) return undefined;

    const messageKeys = [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "business_message",
        "edited_business_message",
    ];

    for (const key of messageKeys) {
        const message = asRecord(update[key]);
        if (message) return message;
    }

    return undefined;
}

export function getContextLogFields(ctx: Context): LogFields {
    const update = asRecord(ctx.update) as UpdateRecord | undefined;
    const message = ctx.msg ?? ctx.message;

    return {
        update_id: asNumber(update?.update_id),
        update_type: getUpdateType(update),
        message_id: message?.message_id,
        media_group_id: message?.media_group_id,
        chat_id: ctx.chat?.id,
        chat_type: ctx.chat?.type,
        user_id: ctx.from?.id,
        username: ctx.from?.username,
    };
}

export function getWebhookLogFields(
    event: WebhookEvent,
    context: FunctionContext
): LogFields {
    const update = getRawUpdate(event);
    const message = getRawMessage(update);
    const chatMember = asRecord(update?.chat_member);
    const chat = asRecord(message?.chat) ?? asRecord(chatMember?.chat);
    const from = asRecord(message?.from) ?? asRecord(chatMember?.from);

    return {
        request_id: context.requestId,
        http_method: event.httpMethod,
        update_id: asNumber(update?.update_id),
        update_type: getUpdateType(update),
        message_id: asNumber(message?.message_id),
        media_group_id: message?.media_group_id,
        chat_id: asNumber(chat?.id),
        user_id: asNumber(from?.id),
        body_bytes: typeof event.body === "string"
            ? Buffer.byteLength(event.body, "utf-8")
            : undefined,
        body_parseable: update !== undefined,
    };
}

export function logDecision(
    ctx: Context,
    decision: string,
    reason: string,
    fields: LogFields = {},
    level: "info" | "warn" | "error" = "info"
): void {
    contextsWithDecision.add(ctx);
    logger[level]("Update decision", {
        event: "update.decision",
        ...getContextLogFields(ctx),
        ...fields,
        decision,
        reason,
    });
}

export async function traceUpdate(
    ctx: Context,
    next: NextFunction
): Promise<void> {
    const startedAt = performance.now();
    const fields = getContextLogFields(ctx);

    logger.info("Update received", {
        event: "update.received",
        ...fields,
    });

    try {
        await next();

        if (!contextsWithDecision.has(ctx)) {
            logDecision(ctx, "skip", "no_matching_handler");
        }

        logger.info("Update processing completed", {
            event: "update.completed",
            ...fields,
            duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        });
    } catch (error) {
        if (!contextsWithDecision.has(ctx)) {
            logDecision(ctx, "error", "handler_threw", {}, "error");
        }

        logger.error("Update processing failed", {
            event: "update.failed",
            ...fields,
            duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
            error: serializeError(error),
        });
        throw error;
    }
}

export function wrapWebhookHandler<
    Event extends WebhookEvent,
    Ctx extends FunctionContext,
    Result,
>(
    handler: (event: Event, context: Ctx) => Promise<Result>
): (event: Event, context: Ctx) => Promise<Result> {
    return async (event: Event, context: Ctx): Promise<Result> => {
        const startedAt = performance.now();
        const fields = getWebhookLogFields(event, context);

        logger.info("Webhook request received", {
            event: "webhook.received",
            ...fields,
        });

        try {
            const result = await handler(event, context);
            const response = asRecord(result);

            logger.info("Webhook request completed", {
                event: "webhook.completed",
                ...fields,
                status_code: response?.statusCode,
                duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
            });

            return result;
        } catch (error) {
            logger.error("Webhook request failed", {
                event: "webhook.failed",
                ...fields,
                duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
                error: serializeError(error),
            });

            // Preserve a non-2xx response so Telegram retries the update.
            throw error;
        }
    };
}
