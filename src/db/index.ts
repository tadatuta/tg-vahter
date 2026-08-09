import Database from "better-sqlite3";
import { logger } from "../logger";

const MAX_LOG_TEXT_LENGTH = 4096;
const REQUIRED_APPROVED_MESSAGES = 2;

export interface ChatUserState {
    approvedMessages: number;
    trusted: boolean;
}

export interface ApprovalResult extends ChatUserState {
    duplicateMessage: boolean;
    probationNumber?: number;
}

export interface Stats {
    probationUsers: number;
    trustedUsers: number;
    spammers: number;
    blacklist: number;
}

export interface GlobalBanReason {
    source: "blacklist" | "spammer";
    reason: string;
}

let db: Database.Database | undefined;
let statements: ReturnType<typeof prepareStatements> | undefined;

function connection(): Database.Database {
    if (!db) throw new Error("Database is not initialized");
    return db;
}

function tableExists(name: string): boolean {
    const row = connection()
        .prepare<[string], { count: number }>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(name);
    return (row?.count ?? 0) > 0;
}

function columnExists(table: string, column: string): boolean {
    const rows = connection().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
}

function addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!columnExists(table, column)) {
        connection().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

export function initDatabase(dbPath: string): void {
    if (db?.open) db.close();

    db = new Database(dbPath, { timeout: 5000 });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    runMigrations();
    assertDatabaseIntegrity();
    statements = prepareStatements();

    logger.info("Database initialized", {
        event: "database.initialized",
        db_path: dbPath,
        journal_mode: "WAL",
        synchronous: "FULL",
        schema_version: getSchemaVersion(),
    });
}

function runMigrations(): void {
    const database = connection();
    database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
    `);

    const applied = database
        .prepare<[], { version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get()?.version ?? 0;

    if (applied < 1) migrateToVersion1();
    if (applied < 2) migrateToVersion2();
}

function migrateToVersion1(): void {
    const database = connection();
    const hadLegacyMessageLog = tableExists("message_log");
    const hadLegacyNewUsers = tableExists("new_users");
    const hadLegacyAdmins = tableExists("admins");

    database.exec("BEGIN IMMEDIATE");
    try {
        database.exec(`
            CREATE TABLE IF NOT EXISTS chat_users (
                chat_id           INTEGER NOT NULL,
                user_id           INTEGER NOT NULL,
                username          TEXT,
                first_name        TEXT,
                approved_messages INTEGER NOT NULL DEFAULT 0
                    CHECK (approved_messages BETWEEN 0 AND ${REQUIRED_APPROVED_MESSAGES}),
                trusted_at        INTEGER,
                first_seen_at     INTEGER NOT NULL DEFAULT (unixepoch()),
                last_seen_at      INTEGER NOT NULL DEFAULT (unixepoch()),
                PRIMARY KEY (chat_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS spammers (
                user_id           INTEGER PRIMARY KEY,
                username          TEXT,
                reason            TEXT NOT NULL,
                source_chat_id    INTEGER,
                source_message_id INTEGER,
                banned_at         INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS blacklist (
                user_id  INTEGER PRIMARY KEY,
                added_by INTEGER NOT NULL,
                reason   TEXT NOT NULL,
                added_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS chat_admins (
                chat_id  INTEGER NOT NULL,
                user_id  INTEGER NOT NULL,
                added_by INTEGER NOT NULL,
                added_at INTEGER NOT NULL DEFAULT (unixepoch()),
                PRIMARY KEY (chat_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS processed_updates (
                update_id    INTEGER PRIMARY KEY,
                processed_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
        `);

        if (!hadLegacyMessageLog) {
            database.exec(`
                CREATE TABLE message_log (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    update_id        INTEGER,
                    message_id       INTEGER,
                    user_id          INTEGER NOT NULL,
                    chat_id          INTEGER NOT NULL,
                    message_text     TEXT,
                    content_type     TEXT NOT NULL DEFAULT 'text',
                    decision         TEXT NOT NULL DEFAULT 'approved',
                    probation_number INTEGER,
                    logged_at        INTEGER NOT NULL DEFAULT (unixepoch())
                );
            `);
        } else {
            addColumnIfMissing("message_log", "update_id", "INTEGER");
            addColumnIfMissing("message_log", "message_id", "INTEGER");
            addColumnIfMissing("message_log", "content_type", "TEXT NOT NULL DEFAULT 'text'");
            addColumnIfMissing("message_log", "decision", "TEXT NOT NULL DEFAULT 'approved'");
            addColumnIfMissing("message_log", "probation_number", "INTEGER");
        }

        addColumnIfMissing("spammers", "source_chat_id", "INTEGER");
        addColumnIfMissing("spammers", "source_message_id", "INTEGER");

        if (hadLegacyNewUsers) {
            database.exec(`
                INSERT INTO chat_users (chat_id, user_id, username, first_name, approved_messages)
                SELECT chat_id, user_id, username, first_name, 0 FROM new_users WHERE true
                ON CONFLICT(chat_id, user_id) DO UPDATE SET
                    username = COALESCE(excluded.username, chat_users.username),
                    first_name = COALESCE(excluded.first_name, chat_users.first_name),
                    last_seen_at = unixepoch();
            `);
        }

        if (hadLegacyMessageLog) {
            database.exec(`
                INSERT INTO chat_users (chat_id, user_id, approved_messages)
                SELECT chat_id, user_id, 1 FROM message_log WHERE true GROUP BY chat_id, user_id
                ON CONFLICT(chat_id, user_id) DO UPDATE SET
                    approved_messages = MAX(chat_users.approved_messages, 1),
                    last_seen_at = unixepoch();
            `);
        }

        if (hadLegacyNewUsers) database.exec("DROP TABLE new_users");
        if (hadLegacyAdmins && !tableExists("legacy_admins")) {
            database.exec("ALTER TABLE admins RENAME TO legacy_admins");
        }

        database.exec(`
            CREATE INDEX IF NOT EXISTS idx_chat_users_state
                ON chat_users (chat_id, trusted_at, approved_messages);
            CREATE INDEX IF NOT EXISTS idx_message_log_user_chat
                ON message_log (user_id, chat_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_message_log_chat_message
                ON message_log (chat_id, message_id);
            INSERT INTO schema_migrations (version) VALUES (1);
            COMMIT;
        `);
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

function migrateToVersion2(): void {
    connection().exec(`
        BEGIN IMMEDIATE;
        DROP INDEX IF EXISTS idx_message_log_chat_message;
        CREATE UNIQUE INDEX idx_message_log_chat_message
            ON message_log (chat_id, message_id);
        INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);
        COMMIT;
    `);
}

function prepareStatements() {
    const database = connection();
    return {
        isBlacklisted: database.prepare<[number], { found: number }>(
            "SELECT 1 AS found FROM blacklist WHERE user_id = ? LIMIT 1"
        ),
        isSpammer: database.prepare<[number], { found: number }>(
            "SELECT 1 AS found FROM spammers WHERE user_id = ? LIMIT 1"
        ),
        getBlacklistReason: database.prepare<[number], { reason: string }>(
            "SELECT reason FROM blacklist WHERE user_id = ?"
        ),
        getSpammerReason: database.prepare<[number], { reason: string }>(
            "SELECT reason FROM spammers WHERE user_id = ?"
        ),
        getChatUser: database.prepare<[number, number], {
            approved_messages: number;
            trusted_at: number | null;
        }>(
            "SELECT approved_messages, trusted_at FROM chat_users WHERE chat_id = ? AND user_id = ?"
        ),
        ensureChatUser: database.prepare(`
            INSERT INTO chat_users (chat_id, user_id, username, first_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(chat_id, user_id) DO UPDATE SET
                username = COALESCE(excluded.username, chat_users.username),
                first_name = COALESCE(excluded.first_name, chat_users.first_name),
                last_seen_at = unixepoch()
        `),
        getLoggedMessage: database.prepare<[number, number], {
            user_id: number;
            probation_number: number | null;
        }>(
            "SELECT user_id, probation_number FROM message_log WHERE chat_id = ? AND message_id = ?"
        ),
        insertApprovedMessage: database.prepare(`
            INSERT INTO message_log (
                update_id, message_id, user_id, chat_id, message_text,
                content_type, decision, probation_number
            ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)
        `),
        updateLoggedMessage: database.prepare(`
            UPDATE message_log
            SET message_text = ?, content_type = ?, decision = ?
            WHERE chat_id = ? AND message_id = ?
        `),
        updateChatUserApproval: database.prepare(`
            UPDATE chat_users
            SET approved_messages = ?,
                trusted_at = CASE
                    WHEN ? >= ${REQUIRED_APPROVED_MESSAGES} THEN COALESCE(trusted_at, unixepoch())
                    ELSE trusted_at
                END,
                last_seen_at = unixepoch()
            WHERE chat_id = ? AND user_id = ?
        `),
        insertSpamDecision: database.prepare(`
            INSERT INTO message_log (
                update_id, message_id, user_id, chat_id, message_text,
                content_type, decision, probation_number
            ) VALUES (?, ?, ?, ?, ?, ?, 'spam', ?)
            ON CONFLICT(chat_id, message_id) DO UPDATE SET
                message_text = excluded.message_text,
                content_type = excluded.content_type,
                decision = 'spam'
        `),
        addSpammer: database.prepare(`
            INSERT INTO spammers (
                user_id, username, reason, source_chat_id, source_message_id
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                username = COALESCE(excluded.username, spammers.username),
                reason = excluded.reason,
                source_chat_id = excluded.source_chat_id,
                source_message_id = excluded.source_message_id,
                banned_at = unixepoch()
        `),
        removeSpammer: database.prepare("DELETE FROM spammers WHERE user_id = ?"),
        addToBlacklist: database.prepare(`
            INSERT INTO blacklist (user_id, added_by, reason)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                added_by = excluded.added_by,
                reason = excluded.reason,
                added_at = unixepoch()
        `),
        removeFromBlacklist: database.prepare("DELETE FROM blacklist WHERE user_id = ?"),
        isChatAdmin: database.prepare<[number, number], { found: number }>(
            "SELECT 1 AS found FROM chat_admins WHERE chat_id = ? AND user_id = ? LIMIT 1"
        ),
        addChatAdmin: database.prepare(`
            INSERT INTO chat_admins (chat_id, user_id, added_by)
            VALUES (?, ?, ?)
            ON CONFLICT(chat_id, user_id) DO UPDATE SET added_by = excluded.added_by
        `),
        claimUpdate: database.prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)"),
        releaseUpdate: database.prepare("DELETE FROM processed_updates WHERE update_id = ?"),
        countProbation: database.prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM chat_users WHERE trusted_at IS NULL"
        ),
        countTrusted: database.prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM chat_users WHERE trusted_at IS NOT NULL"
        ),
        countSpammers: database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM spammers"),
        countBlacklist: database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM blacklist"),
    };
}

function stmts(): NonNullable<typeof statements> {
    if (!statements) throw new Error("Database statements are not initialized");
    return statements;
}

function safeText(text: string | undefined): string | null {
    return text ? text.slice(0, MAX_LOG_TEXT_LENGTH) : null;
}

export function getSchemaVersion(): number {
    return connection()
        .prepare<[], { version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get()?.version ?? 0;
}

export function assertDatabaseIntegrity(): void {
    const result = connection().pragma("quick_check", { simple: true });
    if (result !== "ok") throw new Error(`SQLite quick_check failed: ${String(result)}`);
}

export function checkpointDatabase(): void {
    connection().pragma("wal_checkpoint(TRUNCATE)");
}

export function isBlacklisted(userId: number): boolean {
    return stmts().isBlacklisted.get(userId)?.found === 1;
}

export function isSpammer(userId: number): boolean {
    return stmts().isSpammer.get(userId)?.found === 1;
}

export function getGlobalBanReason(userId: number): GlobalBanReason | undefined {
    const blacklist = stmts().getBlacklistReason.get(userId);
    if (blacklist) return { source: "blacklist", reason: blacklist.reason };

    const spammer = stmts().getSpammerReason.get(userId);
    if (spammer) return { source: "spammer", reason: spammer.reason };
    return undefined;
}

export function ensureChatUser(
    userId: number,
    chatId: number,
    username?: string,
    firstName?: string
): void {
    stmts().ensureChatUser.run(chatId, userId, username ?? null, firstName ?? null);
}

export function getChatUserState(userId: number, chatId: number): ChatUserState {
    const row = stmts().getChatUser.get(chatId, userId);
    return {
        approvedMessages: row?.approved_messages ?? 0,
        trusted: row?.trusted_at !== null && row?.trusted_at !== undefined,
    };
}

export function isTrustedUser(userId: number, chatId: number): boolean {
    return getChatUserState(userId, chatId).trusted;
}

export function getProbationMessageNumber(
    userId: number,
    chatId: number,
    messageId: number
): number | undefined {
    const row = stmts().getLoggedMessage.get(chatId, messageId);
    if (!row || row.user_id !== userId || row.probation_number === null) return undefined;
    return row.probation_number;
}

export function approveProbationMessage(input: {
    updateId?: number;
    messageId: number;
    userId: number;
    chatId: number;
    username?: string;
    firstName?: string;
    text?: string;
    contentType: string;
}): ApprovalResult {
    const database = connection();
    return database.transaction(() => {
        ensureChatUser(input.userId, input.chatId, input.username, input.firstName);

        const existing = stmts().getLoggedMessage.get(input.chatId, input.messageId);
        if (existing) {
            stmts().updateLoggedMessage.run(
                safeText(input.text), input.contentType, "approved", input.chatId, input.messageId
            );
            const state = getChatUserState(input.userId, input.chatId);
            return {
                ...state,
                duplicateMessage: true,
                probationNumber: existing.probation_number ?? undefined,
            };
        }

        const current = getChatUserState(input.userId, input.chatId);
        if (current.trusted) return { ...current, duplicateMessage: false };

        const probationNumber = Math.min(
            REQUIRED_APPROVED_MESSAGES,
            current.approvedMessages + 1
        );
        stmts().insertApprovedMessage.run(
            input.updateId ?? null,
            input.messageId,
            input.userId,
            input.chatId,
            safeText(input.text),
            input.contentType,
            probationNumber
        );
        stmts().updateChatUserApproval.run(
            probationNumber,
            probationNumber,
            input.chatId,
            input.userId
        );

        return {
            approvedMessages: probationNumber,
            trusted: probationNumber >= REQUIRED_APPROVED_MESSAGES,
            duplicateMessage: false,
            probationNumber,
        };
    })();
}

export function updateApprovedMessage(
    chatId: number,
    messageId: number,
    text: string | undefined,
    contentType: string
): void {
    stmts().updateLoggedMessage.run(safeText(text), contentType, "approved", chatId, messageId);
}

export function recordSpammer(input: {
    updateId?: number;
    messageId: number;
    userId: number;
    chatId: number;
    username?: string;
    reason: string;
    text?: string;
    contentType: string;
    probationNumber?: number;
}): void {
    connection().transaction(() => {
        stmts().addSpammer.run(
            input.userId,
            input.username ?? null,
            input.reason,
            input.chatId,
            input.messageId
        );
        stmts().insertSpamDecision.run(
            input.updateId ?? null,
            input.messageId,
            input.userId,
            input.chatId,
            safeText(input.text),
            input.contentType,
            input.probationNumber ?? null
        );
    })();
}

export function removeSpammer(userId: number): void {
    stmts().removeSpammer.run(userId);
}

export function addToBlacklist(userId: number, addedBy: number, reason: string): void {
    stmts().addToBlacklist.run(userId, addedBy, reason.slice(0, 1000));
}

export function removeFromBlacklist(userId: number): void {
    stmts().removeFromBlacklist.run(userId);
}

export function isChatAdmin(userId: number, chatId: number): boolean {
    return stmts().isChatAdmin.get(chatId, userId)?.found === 1;
}

export function addChatAdmin(userId: number, chatId: number, addedBy: number): void {
    stmts().addChatAdmin.run(chatId, userId, addedBy);
}

export function claimUpdate(updateId: number): boolean {
    return stmts().claimUpdate.run(updateId).changes === 1;
}

export function releaseUpdate(updateId: number): void {
    stmts().releaseUpdate.run(updateId);
}

export function getStats(): Stats {
    const s = stmts();
    return {
        probationUsers: s.countProbation.get()?.count ?? 0,
        trustedUsers: s.countTrusted.get()?.count ?? 0,
        spammers: s.countSpammers.get()?.count ?? 0,
        blacklist: s.countBlacklist.get()?.count ?? 0,
    };
}

export function closeDatabase(): void {
    if (!db?.open) return;
    checkpointDatabase();
    db.close();
    statements = undefined;
    db = undefined;
}
