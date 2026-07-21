import assert from "node:assert/strict";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import type { TestContext } from "node:test";
import Database from "better-sqlite3";

import { loadConfig } from "../src/config";
import {
    getSpamHeuristic,
    hasLatinInsideCyrillicWord,
    hasNonAllowedCharacters,
    initHeuristics,
    isSpam,
} from "../src/heuristics";
import * as db from "../src/db";
import { handleNewMember } from "../src/handlers/newMember";
import { handleMessage } from "../src/handlers/message";
import {
    handleAddAdmin,
    handleSpam,
    handleStatus,
    handleUnspam,
} from "../src/handlers/admin";
import {
    flushLogger,
    initLogger,
    logger,
} from "../src/logger";
import {
    traceUpdate,
    wrapWebhookHandler,
} from "../src/observability";

type LogEntry = Record<string, unknown> & {
    event?: string;
    decision?: string;
    reason?: string;
    outcome?: string;
};

function setupDb(t: TestContext): string {
    const dir = mkdtempSync(path.join(tmpdir(), "vahter-test-"));
    const dbPath = path.join(dir, "vahter.db");
    db.initDatabase(dbPath);

    t.after(() => {
        try {
            db.closeDatabase();
        } catch {
            // ignore cleanup errors
        }
        rmSync(dir, { recursive: true, force: true });
    });

    return dbPath;
}

function patchEnv(t: TestContext, vars: Record<string, string | undefined>): void {
    const previous = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(vars)) {
        previous.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    t.after(() => {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });
}

type CallLog = {
    bans: Array<{ chatId: number; userId: number }>;
    unbans: Array<{ chatId: number; userId: number }>;
    deletes: Array<{ chatId: number; messageId: number }>;
    getChatMember: Array<{ chatId: number; userId: number }>;
    replies: string[];
};

type CtxBehavior = {
    failBan?: boolean;
    failDelete?: boolean;
    failGetChatMember?: boolean;
    getChatMemberStatus?: string;
};

function createMockContext(
    overrides: Record<string, unknown> = {},
    behavior: CtxBehavior = {}
): { ctx: Record<string, unknown>; calls: CallLog } {
    const calls: CallLog = {
        bans: [],
        unbans: [],
        deletes: [],
        getChatMember: [],
        replies: [],
    };

    const api = {
        banChatMember: async (chatId: number, userId: number) => {
            calls.bans.push({ chatId, userId });
            if (behavior.failBan) {
                throw new Error("ban failed");
            }
        },
        deleteMessage: async (chatId: number, messageId: number) => {
            calls.deletes.push({ chatId, messageId });
            if (behavior.failDelete) {
                throw new Error("delete failed");
            }
        },
        unbanChatMember: async (chatId: number, userId: number) => {
            calls.unbans.push({ chatId, userId });
        },
        getChatMember: async (chatId: number, userId: number) => {
            calls.getChatMember.push({ chatId, userId });
            if (behavior.failGetChatMember) {
                throw new Error("chat member lookup failed");
            }
            return { status: behavior.getChatMemberStatus ?? "member" };
        },
    };

    const ctx: Record<string, unknown> = {
        from: {
            id: 100,
            is_bot: false,
            username: "user100",
            first_name: "User",
        },
        chat: {
            id: -500,
            type: "supergroup",
        },
        message: {
            message_id: 10,
            text: "hello",
        },
        api,
        reply: async (text: string) => {
            calls.replies.push(text);
        },
        deleteMessage: async () => {
            const cId = (ctx.chat as { id: number })?.id ?? -500;
            const mId = (ctx.message as { message_id: number })?.message_id ?? 10;
            calls.deletes.push({ chatId: cId, messageId: mId });
            if (behavior.failDelete) {
                throw new Error("delete failed");
            }
        },
        ...overrides,
    };

    return { ctx, calls };
}

function readCount(dbPath: string, sql: string): number {
    const conn = new Database(dbPath, { readonly: true });
    try {
        const row = conn.prepare(sql).get() as { cnt: number };
        return row.cnt;
    } finally {
        conn.close();
    }
}

function setupLogCapture(t: TestContext): string {
    const dir = mkdtempSync(path.join(tmpdir(), "vahter-log-test-"));
    const logPath = path.join(dir, "vahter.log");
    initLogger(logPath);

    t.after(async () => {
        await flushLogger();
        initLogger("/tmp/vahter.log");
        rmSync(dir, { recursive: true, force: true });
    });

    return logPath;
}

async function readLogEntries(logPath: string): Promise<LogEntry[]> {
    await flushLogger();
    return readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogEntry);
}

describe("observability", () => {
    test("LOG-01: logger writes structured JSON to stdout and the configured file", async (t) => {
        await flushLogger();
        const logPath = setupLogCapture(t);
        const originalWrite = process.stdout.write;
        let stdout = "";

        process.stdout.write = ((chunk: string | Uint8Array) => {
            stdout += chunk.toString();
            return true;
        }) as typeof process.stdout.write;

        try {
            logger.info("Structured test entry", {
                event: "test.structured_log",
                update_id: 123,
            });
        } finally {
            process.stdout.write = originalWrite;
        }

        const stdoutEntry = JSON.parse(stdout.trim()) as LogEntry;
        const fileEntries = await readLogEntries(logPath);

        assert.equal(stdoutEntry.event, "test.structured_log");
        assert.equal(stdoutEntry.update_id, 123);
        assert.equal(stdoutEntry.level, "INFO");
        assert.equal(fileEntries.at(-1)?.event, "test.structured_log");
    });

    test("LOG-02: webhook wrapper logs metadata and rethrows failures", async (t) => {
        const logPath = setupLogCapture(t);
        const wrapped = wrapWebhookHandler(async () => {
            throw new Error("webhook exploded");
        });

        await assert.rejects(
            wrapped(
                {
                    body: JSON.stringify({
                        update_id: 456,
                        message: {
                            message_id: 789,
                            chat: { id: -500 },
                            from: { id: 42 },
                        },
                    }),
                    headers: {},
                    httpMethod: "POST",
                },
                { requestId: "request-1" }
            ),
            /webhook exploded/
        );

        const entries = await readLogEntries(logPath);
        const received = entries.find((entry) => entry.event === "webhook.received");
        const failed = entries.find((entry) => entry.event === "webhook.failed");

        assert.equal(received?.request_id, "request-1");
        assert.equal(received?.update_id, 456);
        assert.equal(received?.message_id, 789);
        assert.equal(failed?.update_id, 456);
        assert.equal((failed?.error as { name?: string })?.name, "Error");
        assert.equal(
            (failed?.error as { message?: string })?.message,
            "webhook exploded"
        );
    });

    test("LOG-03: tracing records a fallback decision and duration", async (t) => {
        const logPath = setupLogCapture(t);
        const ctx = {
            update: {
                update_id: 654,
                edited_message: {
                    message_id: 321,
                    chat: { id: -700, type: "supergroup" },
                    from: { id: 77, is_bot: false, first_name: "User" },
                },
            },
            msg: {
                message_id: 321,
            },
            chat: {
                id: -700,
                type: "supergroup",
            },
            from: {
                id: 77,
                is_bot: false,
                first_name: "User",
            },
        };

        await traceUpdate(ctx as never, async () => undefined);

        const entries = await readLogEntries(logPath);
        const decision = entries.find(
            (entry) =>
                entry.event === "update.decision" &&
                entry.update_id === 654
        );
        const completed = entries.find(
            (entry) =>
                entry.event === "update.completed" &&
                entry.update_id === 654
        );

        assert.equal(decision?.decision, "skip");
        assert.equal(decision?.reason, "no_matching_handler");
        assert.equal(typeof completed?.duration_ms, "number");
    });
});

describe("config", () => {
    test("CFG-01: loadConfig throws when BOT_TOKEN is missing", (t) => {
        patchEnv(t, {
            BOT_TOKEN: undefined,
            ADMIN_IDS: "1,2",
            SPAM_REGEX: "spam",
        });

        assert.throws(() => loadConfig(), /BOT_TOKEN environment variable is required/);
    });

    test("CFG-02/03: loadConfig parses ADMIN_IDS and applies defaults", (t) => {
        patchEnv(t, {
            BOT_TOKEN: "test-token",
            ADMIN_IDS: "1, 2,foo,3",
            SPAM_REGEX: "spam",
            DB_PATH: undefined,
            LOG_FILE: undefined,
        });

        const config = loadConfig();
        assert.equal(config.botToken, "test-token");
        assert.deepEqual(config.adminIds, [1, 2, 3]);
        assert.equal(config.spamRegex, "spam");
        assert.equal(config.dbPath, "/tmp/vahter.db");
        assert.equal(config.logFile, "/tmp/vahter.log");
    });
});

describe("heuristics", () => {
    test("H-01: empty regex disables spam checks", () => {
        initHeuristics("");
        assert.equal(isSpam("buy now"), false);
    });

    test("H-02: invalid regex disables spam checks", () => {
        initHeuristics("[");
        assert.equal(isSpam("anything"), false);
    });

    test("H-03/H-04: valid regex works in unicode + case-insensitive mode", () => {
        initHeuristics("спам");
        assert.equal(isSpam("Это СПАМ сообщение"), true);
        assert.equal(isSpam("чистый текст"), false);
        assert.equal(isSpam(undefined), false);
    });

    test("H-05: visible Unicode is allowed and unsafe controls are rejected", () => {
        assert.equal(hasNonAllowedCharacters("hello world"), false);
        assert.equal(hasNonAllowedCharacters("Привет мир"), false);
        assert.equal(hasNonAllowedCharacters("hello \u{1F680}"), false);
        assert.equal(
            hasNonAllowedCharacters("«Цена — 100 ₽… № 1; 20 °C; x ≥ y → z»"),
            false
        );
        assert.equal(hasNonAllowedCharacters("Café Łódź, зво\u0301нит"), false);
        assert.equal(hasNonAllowedCharacters("китайские 中文 символы"), false);
        assert.equal(hasNonAllowedCharacters("арабский العربية текст"), false);
        assert.equal(hasNonAllowedCharacters("семья 👨‍👩‍👧‍👦"), false);
        assert.equal(hasNonAllowedCharacters("keycap 1️⃣"), false);
        assert.equal(
            hasNonAllowedCharacters("England 🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"),
            false
        );
        assert.equal(hasNonAllowedCharacters("line one\n\tline two"), false);
        assert.equal(hasNonAllowedCharacters("zero\u200Bwidth"), true);
        assert.equal(hasNonAllowedCharacters("bidi\u202Eoverride"), true);
        assert.equal(hasNonAllowedCharacters("isolated\u200Djoiner"), true);
        assert.equal(hasNonAllowedCharacters("\u0301leading mark"), true);
        assert.equal(hasNonAllowedCharacters("isolated \uFE0F selector"), true);
        assert.equal(hasNonAllowedCharacters("private \uE000 use"), true);
        assert.equal(hasNonAllowedCharacters("nul\u0000char"), true);
        assert.equal(hasNonAllowedCharacters(""), false);
    });

    test("H-06: mixed Latin/Cyrillic words are detected across Unicode", () => {
        assert.equal(hasLatinInsideCyrillicWord("привет"), false);
        assert.equal(hasLatinInsideCyrillicWord("hello"), false);
        assert.equal(hasLatinInsideCyrillicWord("преведmedведед"), true);
        assert.equal(hasLatinInsideCyrillicWord("helloпривет"), true);
        assert.equal(hasLatinInsideCyrillicWord("приветhello"), true);
        assert.equal(hasLatinInsideCyrillicWord("привéт"), true);
        assert.equal(hasLatinInsideCyrillicWord("приветｘ"), true);
        assert.equal(hasLatinInsideCyrillicWord("привет123"), false);
        assert.equal(hasLatinInsideCyrillicWord("зво\u0301нит"), false);
        assert.equal(hasLatinInsideCyrillicWord("Telegram-канал"), false);
        assert.equal(hasLatinInsideCyrillicWord(""), false);
    });

    test("H-07: unsafe controls and mixed-script words are spam signals", () => {
        initHeuristics("");
        assert.equal(isSpam("китайские 中文 символы"), false);
        assert.equal(isSpam("арабский العربية текст"), false);
        assert.equal(isSpam("zero\u200Bwidth"), true);
        assert.equal(isSpam("преведmedведед"), true);
        assert.equal(isSpam("чистый текст"), false);

        initHeuristics("spam");
        assert.equal(isSpam("про сингулярность, свободу воли, цель жизни…"), false);
    });

    test("H-08: Telegram private invite links are spam before other checks", () => {
        initHeuristics("");
        assert.equal(isSpam("Вступайте: https://t.me/+AbCdEf123"), true);
        assert.equal(isSpam("T.ME/+AbCdEf123"), true);
        assert.equal(isSpam("https://t.me/example_channel"), false);
    });

    test("H-09: matching uses NFKC normalization and reports the exact heuristic", () => {
        initHeuristics("spam");
        assert.equal(isSpam("ｓｐａｍ"), true);
        assert.equal(getSpamHeuristic("ｓｐａｍ"), "configured_regex");
        assert.equal(
            getSpamHeuristic("https://t.me/+AbCdEf123"),
            "telegram_private_invite_link"
        );
        assert.equal(
            getSpamHeuristic("zero\u200Bwidth"),
            "disallowed_unicode_control"
        );
        assert.equal(
            getSpamHeuristic("привéт"),
            "mixed_latin_cyrillic_word"
        );
    });
});

describe("database", () => {
    test("DB-01: migrations create required tables and indexes", (t) => {
        const dbPath = setupDb(t);
        const conn = new Database(dbPath, { readonly: true });

        try {
            const tables = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map((row) => (row as { name: string }).name);
            const indexes = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
                .all()
                .map((row) => (row as { name: string }).name);

            assert.ok(tables.includes("new_users"));
            assert.ok(tables.includes("spammers"));
            assert.ok(tables.includes("blacklist"));
            assert.ok(tables.includes("admins"));
            assert.ok(tables.includes("message_log"));
            assert.ok(indexes.includes("idx_new_users_lookup"));
            assert.ok(indexes.includes("idx_message_log_user_chat"));
        } finally {
            conn.close();
        }
    });

    test("DB-02/03: addNewUser is idempotent and removeNewUser removes only target pair", (t) => {
        const dbPath = setupDb(t);

        db.addNewUser(10, 1000, "u10", "User10");
        db.addNewUser(10, 1000, "u10", "User10");
        db.addNewUser(10, 2000, "u10", "User10");

        assert.equal(
            readCount(dbPath, "SELECT COUNT(*) AS cnt FROM new_users WHERE user_id = 10 AND chat_id = 1000"),
            1
        );
        assert.equal(
            readCount(dbPath, "SELECT COUNT(*) AS cnt FROM new_users WHERE user_id = 10 AND chat_id = 2000"),
            1
        );

        db.removeNewUser(10, 1000);
        assert.equal(db.isNewUser(10, 1000), false);
        assert.equal(db.isNewUser(10, 2000), true);
    });

    test("DB-04/05/06/08: blacklist, spammers, admins and stats are updated correctly", (t) => {
        setupDb(t);

        db.addToBlacklist(11, 999, "manual ban");
        db.addSpammer(12, "spam12", "heuristic");
        db.addAdmin(13);

        assert.equal(db.isBlacklisted(11), true);
        assert.equal(db.isSpammer(12), true);
        assert.equal(db.isAdmin(13), true);

        db.removeFromBlacklist(11);
        assert.equal(db.isBlacklisted(11), false);

        const stats = db.getStats();
        assert.equal(stats.blacklist, 0);
        assert.equal(stats.spammers, 1);
    });

    test("DB-07: logMessage truncates text to 4096 chars", (t) => {
        const dbPath = setupDb(t);
        const longText = "x".repeat(5000);

        db.logMessage(20, 777, longText);

        const conn = new Database(dbPath, { readonly: true });
        try {
            const row = conn
                .prepare("SELECT message_text FROM message_log WHERE user_id = 20 AND chat_id = 777")
                .get() as { message_text: string };

            assert.equal(row.message_text.length, 4096);
        } finally {
            conn.close();
        }
    });

    test("DB-09: isKnownUser matrix — known only when message_log exists", (t) => {
        setupDb(t);

        // User absent everywhere is NOT known (no approved message in log)
        assert.equal(db.isKnownUser(30, 100), false);

        // User in new_users but no message_log — not known
        db.addNewUser(30, 100, "u30", "User30");
        assert.equal(db.isKnownUser(30, 100), false);

        // User with a logged message — known
        db.removeNewUser(30, 100);
        db.logMessage(30, 100, "approved message");
        assert.equal(db.isKnownUser(30, 100), true);

        // Spammer with logged message — still known (message_log check only)
        db.addSpammer(30, "u30", "spam");
        assert.equal(db.isKnownUser(30, 100), true);
    });

    test("DB-10: hasLoggedMessage returns correct state", (t) => {
        setupDb(t);

        assert.equal(db.hasLoggedMessage(40, 100), false);

        db.logMessage(40, 100, "first message");
        assert.equal(db.hasLoggedMessage(40, 100), true);

        // Different chat — no message logged
        assert.equal(db.hasLoggedMessage(40, 200), false);
    });
});

describe("new member handler", () => {
    test("NM-04: blacklisted user is banned on join", async (t) => {
        setupDb(t);
        db.addToBlacklist(200, 1, "blacklisted");

        const { ctx, calls } = createMockContext({
            chatMember: {
                new_chat_member: {
                    status: "member",
                    user: {
                        id: 200,
                        is_bot: false,
                        username: "bad",
                        first_name: "Bad",
                    },
                },
            },
            message: { message_id: 99 },
        });

        await handleNewMember(ctx as never);

        assert.equal(calls.bans.length, 1);
        assert.equal(calls.deletes.length, 1);
        assert.equal(db.isNewUser(200, -500), false);
    });

    test("NM-06: regular join is stored in new_users", async (t) => {
        setupDb(t);

        const { ctx, calls } = createMockContext({
            chatMember: {
                new_chat_member: {
                    status: "member",
                    user: {
                        id: 201,
                        is_bot: false,
                        username: "newuser",
                        first_name: "New",
                    },
                },
            },
        });

        await handleNewMember(ctx as never);

        assert.equal(calls.bans.length, 0);
        assert.equal(db.isNewUser(201, -500), true);
    });

    test("NM-02/NM-03: non-join statuses and bot accounts are ignored", async (t) => {
        setupDb(t);

        const leftCtx = createMockContext({
            chatMember: {
                new_chat_member: {
                    status: "left",
                    user: {
                        id: 202,
                        is_bot: false,
                        username: "left",
                        first_name: "Left",
                    },
                },
            },
        });

        await handleNewMember(leftCtx.ctx as never);
        assert.equal(db.isNewUser(202, -500), false);

        const botCtx = createMockContext({
            chatMember: {
                new_chat_member: {
                    status: "member",
                    user: {
                        id: 203,
                        is_bot: true,
                        username: "bot",
                        first_name: "Bot",
                    },
                },
            },
        });

        await handleNewMember(botCtx.ctx as never);
        assert.equal(db.isNewUser(203, -500), false);
    });

    test("NM-07: fallback new_chat_members processes all non-bot users", async (t) => {
        setupDb(t);

        const { ctx } = createMockContext({
            chatMember: undefined,
            message: {
                message_id: 101,
                new_chat_members: [
                    { id: 210, is_bot: false, username: "u210", first_name: "U210" },
                    { id: 211, is_bot: true, username: "b211", first_name: "B211" },
                    { id: 212, is_bot: false, username: "u212", first_name: "U212" },
                ],
            },
        });

        await handleNewMember(ctx as never);

        assert.equal(db.isNewUser(210, -500), true);
        assert.equal(db.isNewUser(211, -500), false);
        assert.equal(db.isNewUser(212, -500), true);
    });
});

describe("message handler", () => {
    test("MSG-02: blacklisted user is banned when sending message", async (t) => {
        setupDb(t);
        initHeuristics("spam");
        db.addToBlacklist(300, 1, "manual");

        const { ctx, calls } = createMockContext({
            from: { id: 300, is_bot: false, username: "u300", first_name: "U300" },
            message: { message_id: 50, text: "hello" },
        });

        await handleMessage(ctx as never);

        assert.equal(calls.bans.length, 1);
        assert.equal(calls.deletes.length, 1);
    });

    test("MSG-04: spam first message adds spammer and removes new_user", async (t) => {
        const logPath = setupLogCapture(t);
        const dbPath = setupDb(t);
        initHeuristics("spam");
        db.addNewUser(301, -500, "u301", "U301");

        const { ctx, calls } = createMockContext({
            from: { id: 301, is_bot: false, username: "u301", first_name: "U301" },
            message: { message_id: 51, text: "this is spam" },
        });

        await handleMessage(ctx as never);

        assert.equal(db.isSpammer(301), true);
        assert.equal(db.isNewUser(301, -500), false);
        assert.equal(calls.bans.length, 1);

        const conn = new Database(dbPath, { readonly: true });
        try {
            const row = conn
                .prepare("SELECT reason FROM spammers WHERE user_id = 301")
                .get() as { reason: string };
            assert.match(row.reason, /\(configured_regex\)/);
        } finally {
            conn.close();
        }

        const entries = await readLogEntries(logPath);
        const decision = entries.find(
            (entry) =>
                entry.event === "update.decision" &&
                entry.decision === "ban" &&
                entry.reason === "spam_heuristic_match" &&
                entry.user_id === 301
        );
        assert.equal(decision?.spam_heuristic, "configured_regex");
    });

    test("MSG-05/09: clean first message is logged, later messages are skipped", async (t) => {
        const logPath = setupLogCapture(t);
        const dbPath = setupDb(t);
        initHeuristics("spam");
        db.addNewUser(302, -500, "u302", "U302");

        const first = createMockContext({
            from: { id: 302, is_bot: false, username: "u302", first_name: "U302" },
            message: { message_id: 52, text: "hello" },
        });

        await handleMessage(first.ctx as never);

        assert.equal(db.isNewUser(302, -500), false);
        assert.equal(
            readCount(dbPath, "SELECT COUNT(*) AS cnt FROM message_log WHERE user_id = 302 AND chat_id = -500"),
            1
        );

        const second = createMockContext({
            from: { id: 302, is_bot: false, username: "u302", first_name: "U302" },
            message: { message_id: 53, text: "second" },
        });

        await handleMessage(second.ctx as never);

        assert.equal(
            readCount(dbPath, "SELECT COUNT(*) AS cnt FROM message_log WHERE user_id = 302 AND chat_id = -500"),
            1
        );
        assert.equal(second.calls.bans.length, 0);

        const entries = await readLogEntries(logPath);
        const knownUserDecision = entries.find(
            (entry) =>
                entry.event === "update.decision" &&
                entry.decision === "skip" &&
                entry.reason === "known_user" &&
                entry.user_id === 302
        );
        assert.ok(knownUserDecision);
    });

    test("MSG-10 (P0): implicit join — user without join event gets heuristic check", async (t) => {
        setupDb(t);
        initHeuristics("spam");

        // User has no new_users record and no message_log — implicit join
        const { ctx, calls } = createMockContext({
            from: { id: 350, is_bot: false, username: "u350", first_name: "U350" },
            message: { message_id: 80, text: "hello" },
        });

        await handleMessage(ctx as never);

        // Should be registered as new user, checked by heuristics, and approved
        assert.equal(db.isNewUser(350, -500), false);
        assert.equal(db.isSpammer(350), false);
        assert.equal(calls.bans.length, 0);

        // The message should have been logged
        assert.equal(db.hasLoggedMessage(350, -500), true);
    });

    test("MSG-10b (P0): implicit join with spam is caught", async (t) => {
        setupDb(t);
        initHeuristics("spam");

        // User has no new_users record, no message_log — sends spam
        const { ctx, calls } = createMockContext({
            from: { id: 351, is_bot: false, username: "u351", first_name: "U351" },
            message: { message_id: 81, text: "buy spam now" },
        });

        await handleMessage(ctx as never);

        assert.equal(db.isSpammer(351), true);
        assert.equal(calls.bans.length, 1);
    });

    test("MSG-11 (P1): spam adds to spammers but NOT to blacklist", async (t) => {
        setupDb(t);
        initHeuristics("spam");
        db.addNewUser(360, -500, "u360", "U360");

        const { ctx } = createMockContext({
            from: { id: 360, is_bot: false, username: "u360", first_name: "U360" },
            message: { message_id: 82, text: "this is spam" },
        });

        await handleMessage(ctx as never);

        assert.equal(db.isSpammer(360), true);
        assert.equal(db.isBlacklisted(360), false);
    });

    test("MSG-06/07: caption is checked, empty text/caption logs null", async (t) => {
        const dbPath = setupDb(t);
        initHeuristics("spam");

        db.addNewUser(303, -500, "u303", "U303");
        const withCaption = createMockContext({
            from: { id: 303, is_bot: false, username: "u303", first_name: "U303" },
            message: { message_id: 54, caption: "SPAM offer" },
        });

        await handleMessage(withCaption.ctx as never);
        assert.equal(db.isSpammer(303), true);

        db.addNewUser(304, -500, "u304", "U304");
        const withoutText = createMockContext({
            from: { id: 304, is_bot: false, username: "u304", first_name: "U304" },
            message: { message_id: 55 },
        });

        await handleMessage(withoutText.ctx as never);

        const conn = new Database(dbPath, { readonly: true });
        try {
            const row = conn
                .prepare("SELECT message_text FROM message_log WHERE user_id = 304 AND chat_id = -500")
                .get() as { message_text: string | null };

            assert.equal(row.message_text, null);
        } finally {
            conn.close();
        }
    });

    test("MSG-01: non-group and service messages are ignored", async (t) => {
        setupDb(t);
        initHeuristics("spam");

        const privateCtx = createMockContext({
            chat: { id: 1, type: "private" },
            from: { id: 305, is_bot: false, username: "u305", first_name: "U305" },
        });

        await handleMessage(privateCtx.ctx as never);
        assert.equal(privateCtx.calls.bans.length, 0);

        const serviceCtx = createMockContext({
            from: { id: 306, is_bot: false, username: "u306", first_name: "U306" },
            message: {
                message_id: 60,
                new_chat_members: [{ id: 999, is_bot: false, username: "x", first_name: "X" }],
            },
        });

        await handleMessage(serviceCtx.ctx as never);
        assert.equal(serviceCtx.calls.bans.length, 0);
    });

    test("MSG-08: delete failure does not break processing", async (t) => {
        const logPath = setupLogCapture(t);
        setupDb(t);
        initHeuristics("spam");
        db.addToBlacklist(307, 1, "manual");

        const { ctx } = createMockContext(
            {
                from: { id: 307, is_bot: false, username: "u307", first_name: "U307" },
                message: { message_id: 61, text: "msg" },
            },
            { failDelete: true }
        );

        await assert.doesNotReject(async () => handleMessage(ctx as never));

        const entries = await readLogEntries(logPath);
        const deleteFailure = entries.find(
            (entry) =>
                entry.event === "telegram_api.delete_message" &&
                entry.outcome === "failure" &&
                entry.user_id === 307
        );
        assert.ok(deleteFailure);
        assert.equal(
            (deleteFailure.error as { message?: string })?.message,
            "delete failed"
        );
    });
});

describe("admin handlers", () => {
    test("ADM-05/06: /ban by super-admin adds user to blacklist", async (t) => {
        const dbPath = setupDb(t);
        patchEnv(t, {
            BOT_TOKEN: "test-token",
            ADMIN_IDS: "777",
        });

        const { ctx, calls } = createMockContext({
            from: { id: 777, is_bot: false, username: "admin", first_name: "Admin" },
            message: { message_id: 70, text: "/ban 401 repeated spam" },
        });

        await handleSpam(ctx as never);

        assert.equal(db.isBlacklisted(401), true);
        assert.equal(calls.bans.length, 1);
        assert.equal(calls.replies.length, 0);
        assert.equal(calls.deletes.length, 1);

        const conn = new Database(dbPath, { readonly: true });
        try {
            const row = conn
                .prepare("SELECT reason, added_by FROM blacklist WHERE user_id = 401")
                .get() as { reason: string; added_by: number };
            assert.equal(row.reason, "repeated spam");
            assert.equal(row.added_by, 777);
        } finally {
            conn.close();
        }
    });

    test("ADM-07: /ban without target replies with usage", async (t) => {
        setupDb(t);
        patchEnv(t, {
            BOT_TOKEN: "test-token",
            ADMIN_IDS: "777",
        });

        const { ctx, calls } = createMockContext({
            from: { id: 777, is_bot: false, username: "admin", first_name: "Admin" },
            message: { message_id: 71, text: "/ban" },
        });

        await handleSpam(ctx as never);

        assert.equal(calls.replies.length, 1);
        assert.match(calls.replies[0], /Использование: \/spam/);
    });

    test("ADM-08/09: /unban removes blacklist and validates input", async (t) => {
        setupDb(t);
        patchEnv(t, {
            BOT_TOKEN: "test-token",
            ADMIN_IDS: "777",
        });

        db.addToBlacklist(402, 777, "manual");

        const valid = createMockContext({
            from: { id: 777, is_bot: false, username: "admin", first_name: "Admin" },
            message: { message_id: 72, text: "/unban 402" },
        });

        await handleUnspam(valid.ctx as never);
        assert.equal(db.isBlacklisted(402), false);
        // Should call unbanChatMember
        assert.equal(valid.calls.unbans.length, 1);
        assert.equal(valid.calls.unbans[0].userId, 402);

        const invalid = createMockContext({
            from: { id: 777, is_bot: false, username: "admin", first_name: "Admin" },
            message: { message_id: 73, text: "/unban abc" },
        });

        await handleUnspam(invalid.ctx as never);
        assert.equal(invalid.calls.replies.length, 1);
        assert.match(invalid.calls.replies[0], /Некорректный user_id/);
    });

    test("ADM-12 (P1): /unban also removes spammer record", async (t) => {
        setupDb(t);
        patchEnv(t, {
            BOT_TOKEN: "test-token",
            ADMIN_IDS: "777",
        });

        db.addToBlacklist(403, 777, "manual");
        db.addSpammer(403, "u403", "heuristic");

        const { ctx, calls } = createMockContext({
            from: { id: 777, is_bot: false, username: "admin", first_name: "Admin" },
            message: { message_id: 74, text: "/unban 403" },
        });

        await handleUnspam(ctx as never);

        assert.equal(db.isBlacklisted(403), false);
        assert.equal(db.isSpammer(403), false);
        assert.equal(calls.unbans.length, 1);
    });

    test("ADM-10: /addadmin is allowed only for super-admins", async (t) => {
        setupDb(t);
        patchEnv(t, {
            BOT_TOKEN: "test-token",
            ADMIN_IDS: "777",
        });

        const denied = createMockContext({
            from: { id: 778, is_bot: false, username: "user", first_name: "User" },
            message: { message_id: 74, text: "/addadmin 450" },
        });

        await handleAddAdmin(denied.ctx as never);
        assert.equal(db.isAdmin(450), false);

        const allowed = createMockContext({
            from: { id: 777, is_bot: false, username: "admin", first_name: "Admin" },
            message: { message_id: 75, text: "/addadmin 450" },
        });

        await handleAddAdmin(allowed.ctx as never);
        assert.equal(db.isAdmin(450), true);
    });

    test("ADM-01/02/03/11: /status works for super-admin, db-admin and chat admin", async (t) => {
        setupDb(t);
        patchEnv(t, {
            BOT_TOKEN: "test-token",
            ADMIN_IDS: "777",
        });

        db.addNewUser(500, -500, "u500", "U500");
        db.addSpammer(501, "u501", "spam");
        db.addToBlacklist(502, 777, "manual");
        db.addAdmin(780);

        const superAdmin = createMockContext({
            from: { id: 777, is_bot: false, username: "super", first_name: "Super" },
            message: { message_id: 76, text: "/status" },
        });
        await handleStatus(superAdmin.ctx as never);
        assert.equal(superAdmin.calls.replies.length, 1);
        assert.match(superAdmin.calls.replies[0], /Новых пользователей: 1/);
        assert.match(superAdmin.calls.replies[0], /Спамеров: 1/);
        assert.match(superAdmin.calls.replies[0], /В чёрном списке: 1/);

        const dbAdmin = createMockContext({
            from: { id: 780, is_bot: false, username: "dbadmin", first_name: "DbAdmin" },
            message: { message_id: 77, text: "/status" },
        });
        await handleStatus(dbAdmin.ctx as never);
        assert.equal(dbAdmin.calls.replies.length, 1);

        const chatAdmin = createMockContext(
            {
                from: { id: 781, is_bot: false, username: "chatadmin", first_name: "ChatAdmin" },
                message: { message_id: 78, text: "/status" },
            },
            { getChatMemberStatus: "administrator" }
        );
        await handleStatus(chatAdmin.ctx as never);
        assert.equal(chatAdmin.calls.replies.length, 1);

        const unauthorized = createMockContext(
            {
                from: { id: 782, is_bot: false, username: "user", first_name: "User" },
                message: { message_id: 79, text: "/status" },
            },
            { failGetChatMember: true }
        );
        await handleStatus(unauthorized.ctx as never);
        assert.equal(unauthorized.calls.replies.length, 0);
    });
});
