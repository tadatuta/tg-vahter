import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH ?? "/data/vahter.db";

try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const result = db.pragma("quick_check", { simple: true });
        if (result !== "ok") throw new Error(`SQLite quick_check returned ${String(result)}`);
    } finally {
        db.close();
    }
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
