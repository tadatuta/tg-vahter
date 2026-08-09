import type { Api } from "grammy";
import { logger, serializeError } from "./logger";

let api: Api | undefined;
let alertChatId: number | undefined;
let connectivityFailure = false;
let lastAlertAt = 0;

const ALERT_COOLDOWN_MS = 60_000;
const BAN_REASON_MAX_LENGTH = 800;
const BAN_QUOTE_MAX_LENGTH = 2_400;

export interface SuccessfulBanAlert {
    userId: number;
    chatId: number;
    displayName?: string;
    reason: string;
    quote?: string;
}

function makeInvisibleCharactersVisible(value: string): string {
    return Array.from(value, (character) => {
        if (character === "\n" || character === "\r" || character === "\t") {
            return character;
        }
        if (!/\p{C}/u.test(character)) return character;
        return `\\u{${character.codePointAt(0)?.toString(16).toUpperCase()}}`;
    }).join("");
}

function truncateAlertField(value: string, maximumLength: number): string {
    const safeValue = makeInvisibleCharactersVisible(value).trim();
    if (safeValue.length <= maximumLength) return safeValue;
    return `${safeValue.slice(0, maximumLength - 1)}…`;
}

export function formatSuccessfulBanAlert(input: SuccessfulBanAlert): string {
    const displayName = input.displayName
        ? `${truncateAlertField(input.displayName, 200)} (${input.userId})`
        : String(input.userId);
    const reason = truncateAlertField(input.reason, BAN_REASON_MAX_LENGTH) || "Причина не указана";
    const quote = input.quote
        ? truncateAlertField(input.quote, BAN_QUOTE_MAX_LENGTH)
        : "[сообщение недоступно]";

    return [
        `Пользователь ${displayName} успешно забанен в чате ${input.chatId}.`,
        `Причина: ${reason}`,
        "Цитата сообщения:",
        `«${quote}»`,
    ].join("\n");
}

export function initAlerts(botApi: Api, chatId: number | undefined): void {
    api = botApi;
    alertChatId = chatId;
}

async function sendAlertMessage(message: string, force: boolean, icon: string): Promise<void> {
    if (!api || alertChatId === undefined) return;
    const now = Date.now();
    if (!force && now - lastAlertAt < ALERT_COOLDOWN_MS) return;

    lastAlertAt = now;
    try {
        const signal = AbortSignal.timeout(5_000) as unknown as Parameters<Api["sendMessage"]>[3];
        await api.sendMessage(
            alertChatId,
            `${icon} VahterBot\n${message}`,
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

export async function sendAlert(message: string, force = false): Promise<void> {
    await sendAlertMessage(message, force, "⚠️");
}

export async function sendSuccessfulBanAlert(input: SuccessfulBanAlert): Promise<void> {
    await sendAlertMessage(formatSuccessfulBanAlert(input), true, "✅");
}

export function markConnectivityFailure(): void {
    connectivityFailure = true;
}

export async function notifyConnectivityRestored(): Promise<void> {
    if (!connectivityFailure) return;
    connectivityFailure = false;
    await sendAlert("Связь с Telegram восстановлена.", true);
}
