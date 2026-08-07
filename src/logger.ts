import fs from "node:fs";
import path from "node:path";

type LogLevel = "INFO" | "WARN" | "ERROR";
export type LogFields = Record<string, unknown>;

let logFilePath: string | undefined;
let pendingFileWrite: Promise<void> = Promise.resolve();
let minimumLevel: LogLevel = "INFO";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
    INFO: 10,
    WARN: 20,
    ERROR: 30,
};

export function initLogger(filePath?: string, level: "info" | "warn" | "error" = "info"): void {
    logFilePath = filePath;
    minimumLevel = level.toUpperCase() as LogLevel;
    if (!logFilePath) return;
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function serializeError(error: unknown): LogFields {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    return {
        name: "NonError",
        message: String(error),
    };
}

function stringify(entry: LogFields): string {
    try {
        return JSON.stringify(entry, (_key, value: unknown) => {
            if (typeof value === "bigint") return value.toString();
            if (value instanceof Error) return serializeError(value);
            return value;
        });
    } catch {
        return JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "ERROR",
            event: "logger.serialization_failed",
            message: "Failed to serialize a log entry",
        });
    }
}

function writeToConsole(level: LogLevel, line: string): void {
    try {
        const stream = level === "ERROR" ? process.stderr : process.stdout;
        stream.write(line);
    } catch {
        // Logging must never break update processing.
    }
}

function queueFileWrite(line: string): void {
    const targetPath = logFilePath;
    if (!targetPath) return;

    pendingFileWrite = pendingFileWrite
        .then(() => fs.promises.appendFile(targetPath, line, "utf-8"))
        .catch((error: unknown) => {
            const fallback = stringify({
                timestamp: new Date().toISOString(),
                level: "ERROR",
                event: "logger.file_write_failed",
                message: "Failed to append log entry to file",
                log_file: targetPath,
                error: serializeError(error),
            }) + "\n";
            writeToConsole("ERROR", fallback);
        });
}

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minimumLevel]) return;
    const line = stringify({
        ...fields,
        timestamp: new Date().toISOString(),
        level,
        message,
    }) + "\n";

    // stdout/stderr is the canonical production sink.
    writeToConsole(level, line);

    // Optional file output is kept for local diagnostics and tests only.
    queueFileWrite(line);
}

export async function flushLogger(): Promise<void> {
    await pendingFileWrite;
}

export const logger = {
    info: (msg: string, fields?: LogFields) => write("INFO", msg, fields),
    warn: (msg: string, fields?: LogFields) => write("WARN", msg, fields),
    error: (msg: string, fields?: LogFields) => write("ERROR", msg, fields),
};
