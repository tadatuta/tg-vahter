import { logger } from "./logger";

let spamPattern: RegExp | null = null;

// Telegram private invite links must always be treated as spam, regardless of SPAM_REGEX.
const telegramInviteLinkRegex = /t\.me\/\+/i;

// Latin characters inside a word that starts and ends with Cyrillic
const latinInsideCyrillicRegex = /[а-яёА-ЯЁ][а-яёА-ЯЁa-zA-Z]*[a-zA-Z][а-яёА-ЯЁa-zA-Z]*[а-яёА-ЯЁ]/;

function isAllowedCodePoint(codePoint: number): boolean {
    if (codePoint <= 0x7F) return true; // ASCII

    // Cyrillic
    if (codePoint >= 0x0400 && codePoint <= 0x04FF) return true;
    if (codePoint >= 0x0500 && codePoint <= 0x052F) return true;
    if (codePoint >= 0x2DE0 && codePoint <= 0x2DFF) return true;
    if (codePoint >= 0xA640 && codePoint <= 0xA69F) return true;

    // Emoji
    if (codePoint >= 0x2600 && codePoint <= 0x27BF) return true;
    if (codePoint >= 0x231A && codePoint <= 0x231B) return true;
    if (codePoint >= 0x23E9 && codePoint <= 0x23F3) return true;
    if (codePoint >= 0x23F8 && codePoint <= 0x23FA) return true;
    if (codePoint >= 0x25AA && codePoint <= 0x25AB) return true;
    if (codePoint === 0x25B6 || codePoint === 0x25C0) return true;
    if (codePoint >= 0x25FB && codePoint <= 0x25FE) return true;
    if (codePoint >= 0x2934 && codePoint <= 0x2935) return true;
    if (codePoint >= 0x2B05 && codePoint <= 0x2B07) return true;
    if (codePoint >= 0x2B1B && codePoint <= 0x2B1C) return true;
    if (codePoint === 0x2B50 || codePoint === 0x2B55) return true;
    if (codePoint === 0x3030 || codePoint === 0x303D) return true;
    if (codePoint === 0x3297 || codePoint === 0x3299) return true;
    if (codePoint === 0x200D || codePoint === 0x20E3) return true; // ZWJ, keycap
    if (codePoint >= 0xFE00 && codePoint <= 0xFE0F) return true; // Variation selectors
    if (codePoint === 0x00A9 || codePoint === 0x00AE || codePoint === 0x2122) return true; // © ® ™
    if (codePoint >= 0x1F000 && codePoint <= 0x1F02F) return true; // Mahjong
    if (codePoint >= 0x1F0A0 && codePoint <= 0x1F0FF) return true; // Playing Cards
    if (codePoint >= 0x1F1E6 && codePoint <= 0x1F1FF) return true; // Regional indicators
    if (codePoint >= 0x1F300 && codePoint <= 0x1F9FF) return true;
    if (codePoint >= 0x1FA00 && codePoint <= 0x1FA6F) return true;

    return false;
}

export function initHeuristics(regexSource: string): void {
    if (!regexSource) {
        logger.warn("Spam heuristic checks are disabled because the regex is empty", {
            event: "heuristics.disabled",
            reason: "empty_regex",
        });
        spamPattern = null;
        return;
    }

    try {
        spamPattern = new RegExp(regexSource, "i");
        logger.info("Spam regex compiled", {
            event: "heuristics.initialized",
            regex_length: regexSource.length,
            flags: "i",
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Spam heuristic checks are disabled because the regex is invalid", {
            event: "heuristics.disabled",
            reason: "invalid_regex",
            regex_length: regexSource.length,
            error_message: message,
        });
        spamPattern = null;
    }
}

export function hasNonAllowedCharacters(text: string): boolean {
    for (const char of text) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) continue;
        if (!isAllowedCodePoint(codePoint)) return true;
    }
    return false;
}

export function hasLatinInsideCyrillicWord(text: string): boolean {
    return latinInsideCyrillicRegex.test(text);
}

export function isSpam(text: string | undefined): boolean {
    if (!text) return false;

    // Preliminary check 1: Telegram private invite links
    if (telegramInviteLinkRegex.test(text)) return true;

    // Preliminary check 2: characters outside allowed ranges
    if (hasNonAllowedCharacters(text)) return true;

    // Preliminary check 3: Latin inside Cyrillic word
    if (hasLatinInsideCyrillicWord(text)) return true;

    // Existing regex-based check
    if (!spamPattern) return false;
    return spamPattern.test(text);
}
