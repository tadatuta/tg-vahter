import type { Context, NextFunction } from "grammy";
import {
    logger,
    serializeError,
    type LogFields,
} from "./logger";

type UpdateRecord = Record<string, unknown> & { update_id?: unknown };

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
