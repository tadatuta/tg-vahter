import { logger } from "./logger";

let spamPattern: RegExp | null = null;

export function initHeuristics(regexSource: string): void {
    if (!regexSource) {
        logger.warn("SPAM_REGEX is empty — heuristic checks are disabled");
        spamPattern = null;
        return;
    }

    try {
        spamPattern = new RegExp(regexSource, "i");
        logger.info(`Spam regex compiled: /${regexSource}/i`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Invalid SPAM_REGEX: ${message} — heuristic checks disabled`);
        spamPattern = null;
    }
}

export function isSpam(text: string | undefined): boolean {
    if (!spamPattern || !text) return false;
    return spamPattern.test(text);
}
