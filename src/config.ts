import fs from "node:fs";
import path from "node:path";

export type RuntimeEnvironment = "development" | "test" | "production";

export interface Config {
    botToken: string;
    superAdminIds: number[];
    spamRegex: string;
    dbPath: string;
    logFile?: string;
    alertChatId?: number;
    telegramApiRoot?: string;
    environment: RuntimeEnvironment;
    logLevel: "info" | "warn" | "error";
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
    if (value === "production" || value === "test") return value;
    return "development";
}

function parseInteger(value: string, name: string, allowNegative = false): number {
    const parsed = Number(value.trim());
    const validSign = allowNegative ? parsed !== 0 : parsed > 0;
    if (!Number.isSafeInteger(parsed) || !validSign) {
        throw new Error(`${name} must contain a safe ${allowNegative ? "non-zero" : "positive"} integer`);
    }
    return parsed;
}

function parseSuperAdminIds(raw: string | undefined): number[] {
    if (!raw?.trim()) return [];
    return raw.split(",").map((value) => parseInteger(value, "SUPER_ADMIN_IDS"));
}

function loadSpamRegex(): string {
    if (process.env.SPAM_REGEX !== undefined) return process.env.SPAM_REGEX;

    const regexFile = process.env.SPAM_REGEX_FILE ?? "voyahchat-antispam-encoded.txt";
    const absolutePath = path.resolve(regexFile);
    try {
        return fs.readFileSync(absolutePath, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read SPAM_REGEX_FILE at ${absolutePath}: ${message}`, {
            cause: error,
        });
    }
}

function parseTelegramApiRoot(
    value: string | undefined,
    environment: RuntimeEnvironment
): string | undefined {
    if (!value?.trim()) return undefined;

    const normalized = value.trim().replace(/\/+$/, "");
    let url: URL;
    try {
        url = new URL(normalized);
    } catch {
        throw new Error("TELEGRAM_API_ROOT must be a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("TELEGRAM_API_ROOT must use http:// or https://");
    }
    if (url.username || url.password) {
        throw new Error("TELEGRAM_API_ROOT must not contain credentials");
    }
    if (url.search || url.hash) {
        throw new Error("TELEGRAM_API_ROOT must not contain query parameters or a fragment");
    }
    if (environment === "production" && url.protocol !== "https:") {
        throw new Error("TELEGRAM_API_ROOT must use https:// in production");
    }

    return normalized;
}

export function loadConfig(): Config {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) throw new Error("BOT_TOKEN environment variable is required");

    const environment = parseEnvironment(process.env.NODE_ENV);
    const superAdminIds = parseSuperAdminIds(
        process.env.SUPER_ADMIN_IDS ?? process.env.ADMIN_IDS
    );
    const telegramApiRoot = parseTelegramApiRoot(
        process.env.TELEGRAM_API_ROOT,
        environment
    );
    if (environment === "production" && !telegramApiRoot) {
        if (process.env.TELEGRAM_PROXY_URL) {
            throw new Error(
                "TELEGRAM_PROXY_URL is not supported for the configured reverse proxy; " +
                "set TELEGRAM_API_ROOT instead"
            );
        }
        throw new Error("TELEGRAM_API_ROOT is required in production");
    }

    const alertChatId = process.env.ALERT_CHAT_ID
        ? parseInteger(process.env.ALERT_CHAT_ID, "ALERT_CHAT_ID", true)
        : undefined;
    const rawLogLevel = process.env.LOG_LEVEL ?? "info";
    if (!(["info", "warn", "error"] as const).includes(rawLogLevel as "info")) {
        throw new Error("LOG_LEVEL must be info, warn, or error");
    }

    return {
        botToken,
        superAdminIds,
        spamRegex: loadSpamRegex(),
        dbPath: process.env.DB_PATH ?? "/data/vahter.db",
        logFile: process.env.LOG_FILE || undefined,
        alertChatId,
        telegramApiRoot,
        environment,
        logLevel: rawLogLevel as Config["logLevel"],
    };
}
