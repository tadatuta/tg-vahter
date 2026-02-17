import Database from "better-sqlite3";
import { logger } from "../logger";

const MAX_LOG_TEXT_LENGTH = 4096;

let db: Database.Database;

export function initDatabase(dbPath: string): void {
    db = new Database(dbPath);

    // Performance & safety pragmas
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    runMigrations();
    logger.info(`Database initialized at ${dbPath}`);
}

function runMigrations(): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS new_users (
      user_id   INTEGER NOT NULL,
      chat_id   INTEGER NOT NULL,
      username  TEXT,
      first_name TEXT,
      joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS spammers (
      user_id   INTEGER PRIMARY KEY,
      username  TEXT,
      reason    TEXT,
      banned_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      user_id   INTEGER PRIMARY KEY,
      added_by  INTEGER,
      reason    TEXT,
      added_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS admins (
      user_id   INTEGER PRIMARY KEY,
      added_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS message_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      chat_id      INTEGER NOT NULL,
      message_text TEXT,
      logged_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_new_users_lookup
      ON new_users (user_id, chat_id);

    CREATE INDEX IF NOT EXISTS idx_message_log_user_chat
      ON message_log (user_id, chat_id);
  `);
}

// --- Prepared statements (lazy-initialized) ---

function stmts() {
    return {
        isBlacklisted: db.prepare<[number], { cnt: number }>(
            "SELECT COUNT(*) as cnt FROM blacklist WHERE user_id = ?"
        ),
        isNewUser: db.prepare<[number, number], { cnt: number }>(
            "SELECT COUNT(*) as cnt FROM new_users WHERE user_id = ? AND chat_id = ?"
        ),
        isSpammer: db.prepare<[number], { cnt: number }>(
            "SELECT COUNT(*) as cnt FROM spammers WHERE user_id = ?"
        ),
        isAdmin: db.prepare<[number], { cnt: number }>(
            "SELECT COUNT(*) as cnt FROM admins WHERE user_id = ?"
        ),
        addNewUser: db.prepare(
            "INSERT OR IGNORE INTO new_users (user_id, chat_id, username, first_name) VALUES (?, ?, ?, ?)"
        ),
        removeNewUser: db.prepare(
            "DELETE FROM new_users WHERE user_id = ? AND chat_id = ?"
        ),
        addSpammer: db.prepare(
            "INSERT OR REPLACE INTO spammers (user_id, username, reason) VALUES (?, ?, ?)"
        ),
        addToBlacklist: db.prepare(
            "INSERT OR REPLACE INTO blacklist (user_id, added_by, reason) VALUES (?, ?, ?)"
        ),
        removeFromBlacklist: db.prepare(
            "DELETE FROM blacklist WHERE user_id = ?"
        ),
        logMessage: db.prepare(
            "INSERT INTO message_log (user_id, chat_id, message_text) VALUES (?, ?, ?)"
        ),
        addAdmin: db.prepare(
            "INSERT OR IGNORE INTO admins (user_id) VALUES (?)"
        ),
        countNewUsers: db.prepare<[], { cnt: number }>(
            "SELECT COUNT(*) as cnt FROM new_users"
        ),
        countSpammers: db.prepare<[], { cnt: number }>(
            "SELECT COUNT(*) as cnt FROM spammers"
        ),
        countBlacklist: db.prepare<[], { cnt: number }>(
            "SELECT COUNT(*) as cnt FROM blacklist"
        ),
    };
}

// --- Public API ---

export function isBlacklisted(userId: number): boolean {
    return (stmts().isBlacklisted.get(userId)?.cnt ?? 0) > 0;
}

export function isNewUser(userId: number, chatId: number): boolean {
    return (stmts().isNewUser.get(userId, chatId)?.cnt ?? 0) > 0;
}

export function isKnownUser(userId: number, chatId: number): boolean {
    // A user is "known" if they are neither in new_users nor in spammers
    return !isNewUser(userId, chatId) && !isSpammer(userId);
}

export function isSpammer(userId: number): boolean {
    return (stmts().isSpammer.get(userId)?.cnt ?? 0) > 0;
}

export function isAdmin(userId: number): boolean {
    return (stmts().isAdmin.get(userId)?.cnt ?? 0) > 0;
}

export function addNewUser(
    userId: number,
    chatId: number,
    username: string | undefined,
    firstName: string | undefined
): void {
    stmts().addNewUser.run(userId, chatId, username ?? null, firstName ?? null);
}

export function removeNewUser(userId: number, chatId: number): void {
    stmts().removeNewUser.run(userId, chatId);
}

export function addSpammer(
    userId: number,
    username: string | undefined,
    reason: string
): void {
    stmts().addSpammer.run(userId, username ?? null, reason);
}

export function addToBlacklist(
    userId: number,
    addedBy: number,
    reason: string
): void {
    stmts().addToBlacklist.run(userId, addedBy, reason);
}

export function removeFromBlacklist(userId: number): void {
    stmts().removeFromBlacklist.run(userId);
}

export function logMessage(
    userId: number,
    chatId: number,
    text: string | undefined
): void {
    const truncated = text ? text.slice(0, MAX_LOG_TEXT_LENGTH) : null;
    stmts().logMessage.run(userId, chatId, truncated);
}

export function addAdmin(userId: number): void {
    stmts().addAdmin.run(userId);
}

export function getStats(): { newUsers: number; spammers: number; blacklist: number } {
    const s = stmts();
    return {
        newUsers: s.countNewUsers.get()?.cnt ?? 0,
        spammers: s.countSpammers.get()?.cnt ?? 0,
        blacklist: s.countBlacklist.get()?.cnt ?? 0,
    };
}

export function closeDatabase(): void {
    db?.close();
}
