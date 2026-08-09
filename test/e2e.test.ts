import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Bot } from "grammy";
import { flushLogger } from "../src/logger";

type DbModule = typeof import("../src/db");
type BotModule = typeof import("../src/bot");
type AlertsModule = typeof import("../src/alerts");
type ApiCall = { method: string; payload: Record<string, unknown> };

const sandboxDir = mkdtempSync(path.join(tmpdir(), "vahter-e2e-"));
const dbPath = path.join(sandboxDir, "e2e.db");

let bot: Bot;
let db: DbModule;
let alerts: AlertsModule;
let apiCalls: ApiCall[] = [];
let failingMethods = new Set<string>();

function user(id: number, username = `u${id}`): Record<string, unknown> {
    return { id, is_bot: false, first_name: `User${id}`, username };
}

function messageUpdate(
    updateId: number,
    from: Record<string, unknown>,
    message: Record<string, unknown>,
    chatId = -1000,
    edited = false
): Record<string, unknown> {
    return {
        update_id: updateId,
        [edited ? "edited_message" : "message"]: {
            message_id: message.message_id ?? updateId,
            date: 1_700_000_000 + updateId,
            chat: { id: chatId, type: "supergroup", title: `Chat ${chatId}` },
            from,
            ...message,
        },
    };
}

function joinUpdate(updateId: number, member: Record<string, unknown>, chatId = -1000) {
    return {
        update_id: updateId,
        chat_member: {
            chat: { id: chatId, type: "supergroup", title: `Chat ${chatId}` },
            from: user(9000),
            date: 1_700_000_000 + updateId,
            old_chat_member: { user: member, status: "left" },
            new_chat_member: { user: member, status: "member" },
        },
    };
}

function resetDatabase(): void {
    try { db.closeDatabase(); } catch { /* first run */ }
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    db.initDatabase(dbPath);
}

function calls(method: string): ApiCall[] {
    return apiCalls.filter((call) => call.method === method);
}

function installApiInterceptor(): void {
    bot.api.config.use(async (_prev, method, payload) => {
        apiCalls.push({ method, payload: payload as Record<string, unknown> });
        if (failingMethods.has(method)) throw new Error(`${method} failed`);
        if (method === "getMe") {
            return {
                ok: true,
                result: {
                    id: 999001,
                    is_bot: true,
                    first_name: "TestBot",
                    username: "test_antispam_bot",
                    can_join_groups: true,
                    can_read_all_group_messages: true,
                    supports_inline_queries: false,
                },
            };
        }
        if (method === "getChatMember") {
            return {
                ok: true,
                result: {
                    status: "member",
                    user: { id: payload.user_id as number, is_bot: false, first_name: "Member" },
                },
            };
        }
        if (method === "sendMessage") {
            return {
                ok: true,
                result: {
                    message_id: 999999,
                    date: 1_700_000_000,
                    chat: { id: payload.chat_id as number, type: "supergroup" },
                    text: payload.text as string,
                },
            };
        }
        return { ok: true, result: true };
    });
}

describe("production behavior", () => {
    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.BOT_TOKEN = "e2e-test-token";
        process.env.SUPER_ADMIN_IDS = "9001";
        process.env.SPAM_REGEX = "spam";
        process.env.DB_PATH = dbPath;
        process.env.LOG_LEVEL = "error";
        delete process.env.TELEGRAM_API_ROOT;
        delete process.env.TELEGRAM_PROXY_URL;
        delete process.env.ALERT_CHAT_ID;

        db = await import("../src/db");
        alerts = await import("../src/alerts");
        const botModule = await import("../src/bot") as BotModule;
        bot = botModule.bot;
        installApiInterceptor();
        await bot.init();
    });

    beforeEach(() => {
        apiCalls = [];
        failingMethods = new Set();
        resetDatabase();
        alerts.initAlerts(bot.api, undefined);
    });

    after(async () => {
        await flushLogger();
        db.closeDatabase();
        rmSync(sandboxDir, { recursive: true, force: true });
    });

    test("first clean message keeps probation; spam in second message is blocked", async () => {
        const newcomer = user(101);
        await bot.handleUpdate(messageUpdate(1, newcomer, { text: "hello" }) as never);
        assert.deepEqual(db.getChatUserState(101, -1000), { approvedMessages: 1, trusted: false });

        await bot.handleUpdate(messageUpdate(2, newcomer, { text: "buy spam now" }) as never);
        assert.equal(db.isSpammer(101), true);
        assert.equal(calls("banChatMember").length, 1);
        assert.equal(calls("deleteMessage").length, 1);
    });

    test("successful spam ban sends an alert with its reason and message quote", async () => {
        alerts.initAlerts(bot.api, -9999);

        await bot.handleUpdate(messageUpdate(5, user(120), { text: "buy spam now" }) as never);

        const alertCall = calls("sendMessage").find((call) => call.payload.chat_id === -9999);
        assert.ok(alertCall);
        assert.match(String(alertCall.payload.text), /^✅ VahterBot/);
        assert.match(String(alertCall.payload.text), /Пользователь @u120 \(120\) успешно забанен/);
        assert.match(String(alertCall.payload.text), /Причина: Сработала антиспам-эвристика/);
        assert.match(String(alertCall.payload.text), /Цитата сообщения:\n«buy spam now»/);
    });

    test("manual reply ban alert uses the administrator reason and replied message", async () => {
        alerts.initAlerts(bot.api, -9999);
        const repliedMessage = {
            message_id: 600,
            date: 1_700_000_000,
            chat: { id: -1000, type: "supergroup", title: "Chat -1000" },
            from: user(121),
            text: "manual spam sample",
        };

        await bot.handleUpdate(messageUpdate(6, user(9001), {
            text: "/spam реклама",
            entities: [{ offset: 0, length: 5, type: "bot_command" }],
            reply_to_message: repliedMessage,
        }) as never);

        const alertCall = calls("sendMessage").find((call) => call.payload.chat_id === -9999);
        assert.ok(alertCall);
        assert.match(String(alertCall.payload.text), /Пользователь @u121 \(121\) успешно забанен/);
        assert.match(String(alertCall.payload.text), /Причина: реклама/);
        assert.match(String(alertCall.payload.text), /Цитата сообщения:\n«manual spam sample»/);
    });

    test("two clean messages grant trust and third message is ignored", async () => {
        const newcomer = user(102);
        await bot.handleUpdate(messageUpdate(10, newcomer, { text: "hello" }) as never);
        await bot.handleUpdate(messageUpdate(11, newcomer, { text: "nice to meet you" }) as never);
        await bot.handleUpdate(messageUpdate(12, newcomer, { text: "spam after trust" }) as never);

        assert.equal(db.isTrustedUser(102, -1000), true);
        assert.equal(db.isSpammer(102), false);
        assert.equal(calls("banChatMember").length, 0);
    });

    test("non-text message does not count, caption does", async () => {
        const newcomer = user(103);
        await bot.handleUpdate(messageUpdate(20, newcomer, { photo: [] }) as never);
        assert.equal(db.getChatUserState(103, -1000).approvedMessages, 0);

        await bot.handleUpdate(messageUpdate(21, newcomer, { caption: "clean caption", photo: [] }) as never);
        assert.equal(db.getChatUserState(103, -1000).approvedMessages, 1);
    });

    test("hidden text_link URL is checked", async () => {
        const newcomer = user(104);
        await bot.handleUpdate(messageUpdate(30, newcomer, {
            text: "Открыть",
            entities: [{
                offset: 0,
                length: 7,
                type: "text_link",
                url: "https://t.me/+HiddenInvite",
            }],
        }) as never);
        assert.equal(db.isSpammer(104), true);
    });

    test("editing either probation message is rechecked after trust", async () => {
        const newcomer = user(105);
        await bot.handleUpdate(messageUpdate(40, newcomer, { message_id: 400, text: "clean one" }) as never);
        await bot.handleUpdate(messageUpdate(41, newcomer, { message_id: 401, text: "clean two" }) as never);
        assert.equal(db.isTrustedUser(105, -1000), true);

        await bot.handleUpdate(messageUpdate(
            42, newcomer, { message_id: 400, text: "edited into spam" }, -1000, true
        ) as never);
        assert.equal(db.isSpammer(105), true);
        assert.equal(calls("banChatMember").length, 1);
    });

    test("sender_chat messages are exempt", async () => {
        await bot.handleUpdate(messageUpdate(50, user(106), {
            text: "spam",
            sender_chat: { id: -9000, type: "channel", title: "Channel" },
        }) as never);
        assert.equal(db.isSpammer(106), false);
        assert.equal(calls("banChatMember").length, 0);
    });

    test("rejoin does not reset trust", async () => {
        const newcomer = user(107);
        await bot.handleUpdate(messageUpdate(60, newcomer, { text: "one" }) as never);
        await bot.handleUpdate(messageUpdate(61, newcomer, { text: "two" }) as never);
        await bot.handleUpdate(joinUpdate(62, newcomer) as never);
        assert.equal(db.isTrustedUser(107, -1000), true);
        assert.equal(db.getChatUserState(107, -1000).approvedMessages, 2);
    });

    test("spammer status is global across chats", async () => {
        const spammer = user(108);
        await bot.handleUpdate(messageUpdate(70, spammer, { text: "spam" }, -1000) as never);
        apiCalls = [];
        await bot.handleUpdate(messageUpdate(71, spammer, { text: "hello" }, -2000) as never);
        assert.equal(calls("banChatMember").length, 1);
        assert.equal(calls("banChatMember")[0].payload.chat_id, -2000);
    });

    test("custom administrators are local to their chat", async () => {
        await bot.handleUpdate(messageUpdate(80, user(9001), {
            text: "/addadmin 2001",
            entities: [{ offset: 0, length: 9, type: "bot_command" }],
        }) as never);
        assert.equal(db.isChatAdmin(2001, -1000), true);
        assert.equal(db.isChatAdmin(2001, -2000), false);

        apiCalls = [];
        await bot.handleUpdate(messageUpdate(81, user(2001), {
            text: "/status",
            entities: [{ offset: 0, length: 7, type: "bot_command" }],
        }) as never);
        assert.equal(calls("sendMessage").length, 1);

        apiCalls = [];
        await bot.handleUpdate(messageUpdate(82, user(2001), {
            text: "/status",
            entities: [{ offset: 0, length: 7, type: "bot_command" }],
        }, -2000) as never);
        assert.equal(calls("sendMessage").length, 0);
        assert.equal(db.getChatUserState(2001, -2000).approvedMessages, 1);
    });

    test("a local administrator can add a global blacklist entry without managing another chat", async () => {
        await bot.handleUpdate(messageUpdate(85, user(9001), {
            text: "/addadmin 2101",
            entities: [{ offset: 0, length: 9, type: "bot_command" }],
        }) as never);
        await bot.handleUpdate(messageUpdate(86, user(2101), {
            text: "/spam 3101 cross-chat abuse",
            entities: [{ offset: 0, length: 5, type: "bot_command" }],
        }) as never);
        assert.equal(db.isBlacklisted(3101), true);

        apiCalls = [];
        await bot.handleUpdate(messageUpdate(87, user(3101), { text: "hello" }, -2000) as never);
        assert.equal(calls("banChatMember").length, 1);
        assert.equal(calls("banChatMember")[0].payload.chat_id, -2000);
    });

    test("unauthorized commands continue through anti-spam", async () => {
        await bot.handleUpdate(messageUpdate(90, user(109), {
            text: "/status spam",
            entities: [{ offset: 0, length: 7, type: "bot_command" }],
        }) as never);
        assert.equal(db.isSpammer(109), true);
        assert.equal(calls("banChatMember").length, 1);
    });

    test("duplicate update_id is processed only once", async () => {
        const update = messageUpdate(100, user(110), { text: "clean" });
        await bot.handleUpdate(update as never);
        await bot.handleUpdate(update as never);
        assert.equal(db.getChatUserState(110, -1000).approvedMessages, 1);
    });

    test("Telegram ban/delete failures are logged without losing the spam decision", async () => {
        failingMethods.add("banChatMember");
        failingMethods.add("deleteMessage");
        await assert.doesNotReject(() => bot.handleUpdate(
            messageUpdate(110, user(111), { text: "spam" }) as never
        ));
        assert.equal(db.isSpammer(111), true);
    });
});
