import fs from "node:fs";
import path from "node:path";

type LogLevel = "INFO" | "WARN" | "ERROR";

let logFilePath = "/tmp/vahter.log";

export function initLogger(filePath: string): void {
    logFilePath = filePath;
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function write(level: LogLevel, message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}\n`;
    try {
        fs.appendFileSync(logFilePath, line, "utf-8");
    } catch {
        // Fallback to stderr if file write fails
        process.stderr.write(line);
    }
}

export const logger = {
    info: (msg: string) => write("INFO", msg),
    warn: (msg: string) => write("WARN", msg),
    error: (msg: string) => write("ERROR", msg),
};
