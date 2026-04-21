import * as fs from "fs";

export interface Config {
    botToken: string;
    adminIds: number[];
    spamRegex: string;
    dbPath: string;
    logFile: string;
}

export function loadConfig(): Config {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
        throw new Error("BOT_TOKEN environment variable is required");
    }

    const adminIds = (process.env.ADMIN_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map(Number)
        .filter((id) => !Number.isNaN(id));

    const spamRegex = process.env.SPAM_REGEX || fs.readFileSync("voyahchat-antispam-encoded.txt", "utf8");
    const dbPath = process.env.DB_PATH ?? "/tmp/vahter.db";
    const logFile = process.env.LOG_FILE ?? "/tmp/vahter.log";

    return { botToken, adminIds, spamRegex, dbPath, logFile };
}
