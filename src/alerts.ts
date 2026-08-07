import type { Api } from "grammy";
import { logger, serializeError } from "./logger";

let api: Api | undefined;
let alertChatId: number | undefined;
let connectivityFailure = false;
let lastAlertAt = 0;

const ALERT_COOLDOWN_MS = 60_000;

export function initAlerts(botApi: Api, chatId: number | undefined): void {
    api = botApi;
    alertChatId = chatId;
}

export async function sendAlert(message: string, force = false): Promise<void> {
    if (!api || alertChatId === undefined) return;
    const now = Date.now();
    if (!force && now - lastAlertAt < ALERT_COOLDOWN_MS) return;

    lastAlertAt = now;
    try {
        const signal = AbortSignal.timeout(5_000) as unknown as Parameters<Api["sendMessage"]>[3];
        await api.sendMessage(
            alertChatId,
            `⚠️ VahterBot\n${message}`,
            {},
            signal
        );
    } catch (error) {
        logger.error("Failed to send operational alert", {
            event: "alert.send_failed",
            error: serializeError(error),
        });
    }
}

export function markConnectivityFailure(): void {
    connectivityFailure = true;
}

export async function notifyConnectivityRestored(): Promise<void> {
    if (!connectivityFailure) return;
    connectivityFailure = false;
    await sendAlert("Связь с Telegram восстановлена.", true);
}
