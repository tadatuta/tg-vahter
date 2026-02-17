import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Bot } from "grammy";
import Database from "better-sqlite3";

type DbModule = typeof import("../src/db");
type HeuristicsModule = typeof import("../src/heuristics");
type BotModule = typeof import("../src/bot");

type ApiCall = {
    method: string;
    payload: Record<string, unknown>;
};

const sandboxDir = mkdtempSync(path.join(tmpdir(), "vahter-e2e-"));
const dbPath = path.join(sandboxDir, "e2e.db");
const logPath = path.join(sandboxDir, "e2e.log");

let bot: Bot;
let db: DbModule;
let heuristics: HeuristicsModule;
let apiCalls: ApiCall[] = [];

function messageUpdate(
    updateId: number,
    message: Record<string, unknown>,
    chatId = -1000
): Record<string, unknown> {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: 1_700_000_000 + updateId,
            chat: {
                id: chatId,
                type: "supergroup",
                title: "E2E Chat",
            },
            ...message,
        },
    };
}

function user(id: number, username = `u${id}`): Record<string, unknown> {
    return {
        id,
        is_bot: false,
        first_name: `User${id}`,
        username,
    };
}

function countRows(sql: string): number {
    const conn = new Database(dbPath, { readonly: true });
    try {
        const row = conn.prepare(sql).get() as { cnt: number };
        return row.cnt;
    } finally {
        conn.close();
    }
}

function resetDatabase(): void {
    try {
        db.closeDatabase();
    } catch {
        // ignore first-run cleanup errors
    }

    rmSync(dbPath, { force: true });
    db.initDatabase(dbPath);
}

function installApiInterceptor(): void {
    (bot.api as unknown as {
        config: {
            use: (
                middleware: (
                    prev: unknown,
                    method: string,
                    payload: Record<string, unknown>
                ) => Promise<unknown>
            ) => void;
        };
    }).config.use(async (_prev, method: string, payload: Record<string, unknown>) => {
        apiCalls.push({ method, payload });

        if (method === "sendMessage") {
            return {
                ok: true,
                result: {
                    message_id: 999_999,
                    date: Math.floor(Date.now() / 1000),
                    chat: {
                        id: payload.chat_id as number,
                        type: "supergroup",
                    },
                    text: payload.text as string,
                },
            };
        }

        if (method === "getChatMember") {
            return {
                ok: true,
                result: {
                    status: "member",
                    user: {
                        id: payload.user_id as number,
                        is_bot: false,
                        first_name: "Member",
                    },
                },
            };
        }

        if (method === "getMe") {
            return {
                ok: true,
                result: {
                    id: 999_001,
                    is_bot: true,
                    first_name: "TestBot",
                    username: "test_antispam_bot",
                    can_join_groups: true,
                    can_read_all_group_messages: false,
                    supports_inline_queries: false,
                },
            };
        }

        return {
            ok: true,
            result: true,
        };
    });
}

describe("e2e bot flow", () => {
    before(async () => {
        process.env.BOT_TOKEN = "e2e-test-token";
        process.env.ADMIN_IDS = "9001";
        process.env.SPAM_REGEX = "spam";
        process.env.DB_PATH = dbPath;
        process.env.LOG_FILE = logPath;

        const dbModule = await import("../src/db");
        const heuristicsModule = await import("../src/heuristics");
        const botModule = (await import("../src/bot")) as BotModule;

        db = dbModule;
        heuristics = heuristicsModule;
        bot = botModule.bot;

        installApiInterceptor();
        await bot.init();
        resetDatabase();
    });

    beforeEach(() => {
        apiCalls = [];
        resetDatabase();
        heuristics.initHeuristics("spam");
    });

    after(() => {
        try {
            db.closeDatabase();
        } catch {
            // ignore cleanup errors
        }

        rmSync(sandboxDir, { recursive: true, force: true });
    });

    test("E2E-01: join -> clean first message -> second message ignored", async () => {
        const newcomer = user(1001);

        await bot.handleUpdate(messageUpdate(1, {
            from: user(9000, "inviter"),
            new_chat_members: [newcomer],
        }) as never);

        await bot.handleUpdate(messageUpdate(2, {
            from: newcomer,
            text: "hello everyone",
        }) as never);

        await bot.handleUpdate(messageUpdate(3, {
            from: newcomer,
            text: "second message",
        }) as never);

        assert.equal(db.isNewUser(1001, -1000), false);
        assert.equal(db.isSpammer(1001), false);
        assert.equal(
            countRows("SELECT COUNT(*) AS cnt FROM message_log WHERE user_id = 1001 AND chat_id = -1000"),
            1
        );
        assert.equal(apiCalls.filter((x) => x.method === "banChatMember").length, 0);
        assert.equal(apiCalls.filter((x) => x.method === "deleteMessage").length, 0);
    });

    test("E2E-02: join -> spam first message -> ban and delete", async () => {
        const spammer = user(1002);

        await bot.handleUpdate(messageUpdate(10, {
            from: user(9000, "inviter"),
            new_chat_members: [spammer],
        }) as never);

        await bot.handleUpdate(messageUpdate(11, {
            from: spammer,
            text: "BUY SPAM right now",
        }) as never);

        assert.equal(db.isSpammer(1002), true);
        assert.equal(db.isNewUser(1002, -1000), false);
        assert.equal(apiCalls.filter((x) => x.method === "banChatMember").length, 1);
        assert.equal(apiCalls.filter((x) => x.method === "deleteMessage").length, 1);
    });

    test("E2E-03: /ban command blacklists user and next message is blocked", async () => {
        await bot.handleUpdate(messageUpdate(20, {
            from: user(9001, "superadmin"),
            text: "/ban 1003 repeated spam links",
            entities: [
                {
                    offset: 0,
                    length: 4,
                    type: "bot_command",
                },
            ],
        }) as never);

        assert.equal(db.isBlacklisted(1003), true);

        const conn = new Database(dbPath, { readonly: true });
        try {
            const row = conn
                .prepare("SELECT reason FROM blacklist WHERE user_id = 1003")
                .get() as { reason: string };
            assert.equal(row.reason, "repeated spam links");
        } finally {
            conn.close();
        }

        await bot.handleUpdate(messageUpdate(21, {
            from: user(1003),
            text: "why i am banned?",
        }) as never);

        assert.equal(apiCalls.filter((x) => x.method === "sendMessage").length, 1);
        assert.equal(apiCalls.filter((x) => x.method === "banChatMember").length, 2);
        assert.equal(apiCalls.filter((x) => x.method === "deleteMessage").length, 1);
    });

    test("E2E-04: state persists after db reinit on same file (restart simulation)", async () => {
        const member = user(1004);

        await bot.handleUpdate(messageUpdate(30, {
            from: user(9000, "inviter"),
            new_chat_members: [member],
        }) as never);
        await bot.handleUpdate(messageUpdate(31, {
            from: member,
            text: "clean message",
        }) as never);

        db.closeDatabase();
        db.initDatabase(dbPath);

        await bot.handleUpdate(messageUpdate(32, {
            from: member,
            text: "message after restart",
        }) as never);

        assert.equal(
            countRows("SELECT COUNT(*) AS cnt FROM message_log WHERE user_id = 1004 AND chat_id = -1000"),
            1
        );
        assert.equal(apiCalls.filter((x) => x.method === "banChatMember").length, 0);
    });

    test("E2E-05: implicit join — first message from unknown user is checked, second is skipped", async () => {
        // User 1005 never sent a join event (bot joined after them)
        await bot.handleUpdate(messageUpdate(40, {
            from: user(1005),
            text: "hi from existing member",
        }) as never);

        // Should register as implicit join and approve clean message
        assert.equal(db.isNewUser(1005, -1000), false);
        assert.equal(db.isSpammer(1005), false);
        assert.equal(
            countRows("SELECT COUNT(*) AS cnt FROM message_log WHERE user_id = 1005 AND chat_id = -1000"),
            1
        );

        // Second message should be skipped entirely
        await bot.handleUpdate(messageUpdate(41, {
            from: user(1005),
            text: "second message",
        }) as never);

        assert.equal(
            countRows("SELECT COUNT(*) AS cnt FROM message_log WHERE user_id = 1005 AND chat_id = -1000"),
            1
        );
        assert.equal(apiCalls.filter((x) => x.method === "banChatMember").length, 0);
    });
});
