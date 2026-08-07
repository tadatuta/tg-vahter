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
    telegramProxyUrl?: string;
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

function parseProxyUrl(value: string | undefined): string | undefined {
    if (!value?.trim()) return undefined;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("TELEGRAM_PROXY_URL must be a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("TELEGRAM_PROXY_URL must use http:// or https://");
    }
    return url.toString();
}

export function loadConfig(): Config {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) throw new Error("BOT_TOKEN environment variable is required");

    const environment = parseEnvironment(process.env.NODE_ENV);
    const superAdminIds = parseSuperAdminIds(
        process.env.SUPER_ADMIN_IDS ?? process.env.ADMIN_IDS
    );
    const telegramProxyUrl = parseProxyUrl(process.env.TELEGRAM_PROXY_URL);
    if (environment === "production" && !telegramProxyUrl) {
        throw new Error("TELEGRAM_PROXY_URL is required in production");
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
        telegramProxyUrl,
        environment,
        logLevel: rawLogLevel as Config["logLevel"],
    };
}
