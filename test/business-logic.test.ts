import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config";
import * as db from "../src/db";
import {
    getSpamHeuristic,
    hasLatinInsideCyrillicWord,
    hasNonAllowedCharacters,
    initHeuristics,
    isSpam,
} from "../src/heuristics";
import { extractContent } from "../src/handlers/message";
import { initLogger } from "../src/logger";

initLogger(undefined, "error");

function patchEnv(t: TestContext, values: Record<string, string | undefined>): void {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    t.after(() => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

function setupDb(t: TestContext): string {
    const dir = mkdtempSync(path.join(tmpdir(), "vahter-test-"));
    const dbPath = path.join(dir, "vahter.db");
    db.initDatabase(dbPath);
    t.after(() => {
        db.closeDatabase();
        rmSync(dir, { recursive: true, force: true });
    });
    return dbPath;
}

describe("configuration", () => {
    test("production requires an explicit Telegram API root", (t) => {
        patchEnv(t, {
            NODE_ENV: "production",
            BOT_TOKEN: "token",
            SUPER_ADMIN_IDS: "1",
            SPAM_REGEX: "spam",
            TELEGRAM_API_ROOT: undefined,
            TELEGRAM_PROXY_URL: undefined,
        });
        assert.throws(() => loadConfig(), /TELEGRAM_API_ROOT is required/);
    });

    test("safe IDs, empty regex, API root and alert chat are parsed exactly", (t) => {
        patchEnv(t, {
            NODE_ENV: "production",
            BOT_TOKEN: "token",
            SUPER_ADMIN_IDS: "1,2",
            ADMIN_IDS: undefined,
            SPAM_REGEX: "",
            TELEGRAM_API_ROOT: "https://proxy.example.com/telegram/",
            TELEGRAM_PROXY_URL: undefined,
            ALERT_CHAT_ID: "-100123",
        });
        const config = loadConfig();
        assert.deepEqual(config.superAdminIds, [1, 2]);
        assert.equal(config.spamRegex, "");
        assert.equal(config.alertChatId, -100123);
        assert.equal(config.telegramApiRoot, "https://proxy.example.com/telegram");
    });

    test("production rejects insecure or obsolete proxy configuration", (t) => {
        patchEnv(t, {
            NODE_ENV: "production",
            BOT_TOKEN: "token",
            SPAM_REGEX: "spam",
            TELEGRAM_API_ROOT: "http://proxy.example.com",
            TELEGRAM_PROXY_URL: undefined,
        });
        assert.throws(() => loadConfig(), /must use https:\/\/ in production/);

        process.env.TELEGRAM_API_ROOT = "";
        process.env.TELEGRAM_PROXY_URL = "http://proxy.example.com:8080";
        assert.throws(() => loadConfig(), /set TELEGRAM_API_ROOT instead/);
    });

    test("unsafe or fractional Telegram IDs are rejected", (t) => {
        patchEnv(t, {
            NODE_ENV: "test",
            BOT_TOKEN: "token",
            SUPER_ADMIN_IDS: "1.5",
            SPAM_REGEX: "spam",
        });
        assert.throws(() => loadConfig(), /safe positive integer/);
    });
});

describe("heuristics", () => {
    test("empty configured regex keeps built-in heuristics enabled", () => {
        initHeuristics("");
        assert.equal(isSpam("ordinary text"), false);
        assert.equal(isSpam("https://t.me/+InviteCode"), true);
    });

    test("invalid regex fails startup instead of silently disabling protection", () => {
        assert.throws(() => initHeuristics("["), /Invalid spam regex/);
    });

    test("configured regex and Unicode normalization report their source", () => {
        initHeuristics("spam");
        assert.equal(getSpamHeuristic("ＳＰＡＭ"), "configured_regex");
        assert.equal(getSpamHeuristic("zero\u200Bwidth"), "disallowed_unicode_control");
    });

    test("normal Unicode and emoji remain allowed while unsafe controls are rejected", () => {
        assert.equal(hasNonAllowedCharacters("Привет, мир 👨‍👩‍👧‍👦 — 100 ₽"), false);
        assert.equal(hasNonAllowedCharacters("Café, 中文, العربية"), false);
        assert.equal(hasNonAllowedCharacters("zero\u200Bwidth"), true);
        assert.equal(hasNonAllowedCharacters("bidi\u202Eoverride"), true);
        assert.equal(hasNonAllowedCharacters("private\uE000use"), true);
    });

    test("mixed Latin/Cyrillic words are detected without flagging separate words", () => {
        assert.equal(hasLatinInsideCyrillicWord("приветhello"), true);
        assert.equal(hasLatinInsideCyrillicWord("привéт"), true);
        assert.equal(hasLatinInsideCyrillicWord("Telegram-канал"), false);
        assert.equal(hasLatinInsideCyrillicWord("hello привет"), false);
    });
});

describe("content extraction", () => {
    test("caption and hidden text_link URLs are combined", () => {
        const content = extractContent({
            message_id: 1,
            date: 1,
            chat: { id: -1, type: "supergroup", title: "x" },
            caption: "Открыть",
            caption_entities: [{
                offset: 0,
                length: 7,
                type: "text_link",
                url: "https://t.me/+HiddenInvite",
            }],
        } as never);
        assert.equal(content.type, "caption");
        assert.match(content.text ?? "", /HiddenInvite/);
    });

    test("non-text content remains non-counting", () => {
        const content = extractContent({
            message_id: 1,
            date: 1,
            chat: { id: -1, type: "supergroup", title: "x" },
            photo: [],
        } as never);
        assert.deepEqual(content, { type: "non_text" });
    });
});

describe("database", () => {
    test("two unique approved messages grant permanent per-chat trust", (t) => {
        setupDb(t);
        const base = {
            userId: 10,
            chatId: -100,
            username: "u10",
            firstName: "User",
            text: "clean",
            contentType: "text",
        };

        const first = db.approveProbationMessage({ ...base, updateId: 1, messageId: 11 });
        const duplicate = db.approveProbationMessage({ ...base, updateId: 2, messageId: 11 });
        const second = db.approveProbationMessage({ ...base, updateId: 3, messageId: 12 });

        assert.deepEqual(first, {
            approvedMessages: 1,
            trusted: false,
            duplicateMessage: false,
            probationNumber: 1,
        });
        assert.equal(duplicate.duplicateMessage, true);
        assert.equal(duplicate.approvedMessages, 1);
        assert.equal(second.trusted, true);
        assert.equal(db.isTrustedUser(10, -100), true);
        assert.equal(db.isTrustedUser(10, -200), false);
    });

    test("global spammer and blacklist state survive database reopen", (t) => {
        const dbPath = setupDb(t);
        db.recordSpammer({
            updateId: 1,
            messageId: 1,
            userId: 20,
            chatId: -100,
            reason: "test",
            text: "spam",
            contentType: "text",
        });
        db.addToBlacklist(21, 1, "manual");
        db.closeDatabase();
        db.initDatabase(dbPath);
        assert.equal(db.isSpammer(20), true);
        assert.equal(db.isBlacklisted(21), true);
    });

    test("update IDs are claimed only once", (t) => {
        setupDb(t);
        assert.equal(db.claimUpdate(100), true);
        assert.equal(db.claimUpdate(100), false);
        db.releaseUpdate(100);
        assert.equal(db.claimUpdate(100), true);
    });

    test("legacy schema migrates transactionally without granting global DB-admin rights", (t) => {
        const dir = mkdtempSync(path.join(tmpdir(), "vahter-legacy-"));
        const dbPath = path.join(dir, "legacy.db");
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE new_users (
                user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
                username TEXT, first_name TEXT, joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
                PRIMARY KEY (user_id, chat_id)
            );
            CREATE TABLE spammers (
                user_id INTEGER PRIMARY KEY, username TEXT, reason TEXT,
                banned_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE TABLE blacklist (
                user_id INTEGER PRIMARY KEY, added_by INTEGER, reason TEXT,
                added_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE TABLE admins (user_id INTEGER PRIMARY KEY, added_at INTEGER NOT NULL DEFAULT (unixepoch()));
            CREATE TABLE message_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
                chat_id INTEGER NOT NULL, message_text TEXT,
                logged_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            INSERT INTO message_log (user_id, chat_id, message_text) VALUES (30, -300, 'legacy clean');
            INSERT INTO admins (user_id) VALUES (99);
        `);
        legacy.close();

        db.initDatabase(dbPath);
        t.after(() => {
            db.closeDatabase();
            rmSync(dir, { recursive: true, force: true });
        });

        assert.equal(db.getSchemaVersion(), 2);
        assert.deepEqual(db.getChatUserState(30, -300), {
            approvedMessages: 1,
            trusted: false,
        });
        assert.equal(db.isChatAdmin(99, -300), false);

        const check = new Database(dbPath, { readonly: true });
        try {
            const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
                .map((row) => (row as { name: string }).name);
            assert.ok(tables.includes("legacy_admins"));
            assert.ok(!tables.includes("admins"));
        } finally {
            check.close();
        }
    });
});
