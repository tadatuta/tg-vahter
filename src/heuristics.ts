import { logger } from "./logger";

let spamPattern: RegExp | null = null;

// Telegram private invite links must always be treated as spam, regardless of SPAM_REGEX.
const telegramInviteLinkRegex = /t\.me\/\+/i;

const unicodeOtherRegex = /\p{C}/u;
const unicodeWordRegex = /[\p{L}\p{M}]+/gu;
const unicodeLetterRegex = /\p{L}/u;
const unicodeMarkRegex = /\p{M}/u;
const unicodeLetterNumberSymbolRegex = /[\p{L}\p{N}\p{S}]/u;
const latinCharacterRegex = /\p{Script_Extensions=Latin}/u;
const cyrillicCharacterRegex = /\p{Script_Extensions=Cyrillic}/u;
const extendedPictographicRegex = /\p{Extended_Pictographic}/u;
const emojiModifierRegex = /\p{Emoji_Modifier}/u;

const ZERO_WIDTH_JOINER = 0x200D;
const COMBINING_ENCLOSING_KEYCAP = 0x20E3;
const VARIATION_SELECTOR_START = 0xFE00;
const VARIATION_SELECTOR_16 = 0xFE0F;
const VARIATION_SELECTOR_SUPPLEMENT_START = 0xE0100;
const VARIATION_SELECTOR_SUPPLEMENT_END = 0xE01EF;
const BLACK_FLAG = 0x1F3F4;
const TAG_START = 0xE0020;
const TAG_END = 0xE007E;
const CANCEL_TAG = 0xE007F;

export type SpamHeuristic =
    | "telegram_private_invite_link"
    | "disallowed_unicode_control"
    | "mixed_latin_cyrillic_word"
    | "configured_regex";

function codePointOf(char: string): number {
    return char.codePointAt(0) ?? 0;
}

function isEmojiModifier(char: string): boolean {
    return emojiModifierRegex.test(char);
}

function isValidEmojiJoiner(chars: string[], index: number): boolean {
    let previousIndex = index - 1;
    while (
        previousIndex >= 0 &&
        (codePointOf(chars[previousIndex]) === VARIATION_SELECTOR_16 ||
            isEmojiModifier(chars[previousIndex]))
    ) {
        previousIndex -= 1;
    }

    const previous = chars[previousIndex];
    const next = chars[index + 1];
    return previous !== undefined &&
        next !== undefined &&
        extendedPictographicRegex.test(previous) &&
        extendedPictographicRegex.test(next);
}

function isTagSpec(codePoint: number): boolean {
    return codePoint >= TAG_START && codePoint <= TAG_END;
}

function isValidEmojiTagCharacter(chars: string[], index: number): boolean {
    let firstTagIndex = index;
    if (codePointOf(chars[firstTagIndex]) === CANCEL_TAG) {
        firstTagIndex -= 1;
    }
    while (
        firstTagIndex >= 0 &&
        isTagSpec(codePointOf(chars[firstTagIndex]))
    ) {
        firstTagIndex -= 1;
    }

    if (firstTagIndex < 0 || codePointOf(chars[firstTagIndex]) !== BLACK_FLAG) {
        return false;
    }

    let tagEndIndex = firstTagIndex + 1;
    while (
        tagEndIndex < chars.length &&
        isTagSpec(codePointOf(chars[tagEndIndex]))
    ) {
        tagEndIndex += 1;
    }

    return tagEndIndex > firstTagIndex + 1 &&
        codePointOf(chars[tagEndIndex] ?? "") === CANCEL_TAG &&
        index <= tagEndIndex;
}

function isAllowedControlCharacter(chars: string[], index: number): boolean {
    const codePoint = codePointOf(chars[index]);

    // Telegram text may contain tabs and line breaks.
    if (codePoint === 0x09 || codePoint === 0x0A || codePoint === 0x0D) {
        return true;
    }

    // ZWJ is valid only as a connector inside an emoji sequence.
    if (codePoint === ZERO_WIDTH_JOINER) {
        return isValidEmojiJoiner(chars, index);
    }

    // Emoji subdivision flags use otherwise invisible tag characters.
    if (isTagSpec(codePoint) || codePoint === CANCEL_TAG) {
        return isValidEmojiTagCharacter(chars, index);
    }

    return false;
}

function previousBaseCharacter(chars: string[], index: number): string | undefined {
    let previousIndex = index - 1;
    while (previousIndex >= 0 && unicodeMarkRegex.test(chars[previousIndex])) {
        previousIndex -= 1;
    }
    return chars[previousIndex];
}

function isVariationSelector(codePoint: number): boolean {
    return (codePoint >= VARIATION_SELECTOR_START &&
        codePoint <= VARIATION_SELECTOR_16) ||
        (codePoint >= VARIATION_SELECTOR_SUPPLEMENT_START &&
            codePoint <= VARIATION_SELECTOR_SUPPLEMENT_END);
}

function isAllowedCombiningMark(chars: string[], index: number): boolean {
    const codePoint = codePointOf(chars[index]);
    const previousBase = previousBaseCharacter(chars, index);
    if (previousBase === undefined) return false;

    if (codePoint === COMBINING_ENCLOSING_KEYCAP) {
        return /^[#*0-9]$/.test(previousBase);
    }

    if (isVariationSelector(codePoint)) {
        return unicodeLetterNumberSymbolRegex.test(previousBase);
    }

    return unicodeLetterRegex.test(previousBase);
}

function normalizeForMatching(text: string): string {
    return text.normalize("NFKC");
}

export function initHeuristics(regexSource: string): void {
    if (!regexSource) {
        logger.warn("Spam regex checks are disabled because the regex is empty", {
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
        logger.error("Spam regex checks are disabled because the regex is invalid", {
            event: "heuristics.disabled",
            reason: "invalid_regex",
            regex_length: regexSource.length,
            error_message: message,
        });
        spamPattern = null;
    }
}

/**
 * Detects control, format, private-use, surrogate and unassigned code points.
 * Visible Unicode letters, numbers, punctuation, separators and symbols are allowed.
 */
export function hasNonAllowedCharacters(text: string): boolean {
    const chars = Array.from(text);

    for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index];
        if (unicodeOtherRegex.test(char) && !isAllowedControlCharacter(chars, index)) {
            return true;
        }
        if (unicodeMarkRegex.test(char) && !isAllowedCombiningMark(chars, index)) {
            return true;
        }
    }

    return false;
}

/**
 * Detects a contiguous word containing both Latin and Cyrillic letters.
 */
export function hasLatinInsideCyrillicWord(text: string): boolean {
    const normalizedText = normalizeForMatching(text);

    for (const match of normalizedText.matchAll(unicodeWordRegex)) {
        const word = match[0];
        let hasLatinLetter = false;
        let hasCyrillicLetter = false;

        for (const char of word) {
            if (!unicodeLetterRegex.test(char)) continue;
            hasLatinLetter ||= latinCharacterRegex.test(char);
            hasCyrillicLetter ||= cyrillicCharacterRegex.test(char);
        }

        if (hasLatinLetter && hasCyrillicLetter) {
            return true;
        }
    }

    return false;
}

export function getSpamHeuristic(
    text: string | undefined
): SpamHeuristic | undefined {
    if (!text) return undefined;

    const normalizedText = normalizeForMatching(text);

    if (telegramInviteLinkRegex.test(normalizedText)) {
        return "telegram_private_invite_link";
    }

    if (hasNonAllowedCharacters(text)) {
        return "disallowed_unicode_control";
    }

    if (hasLatinInsideCyrillicWord(normalizedText)) {
        return "mixed_latin_cyrillic_word";
    }

    if (spamPattern?.test(text) ||
        (normalizedText !== text && spamPattern?.test(normalizedText))) {
        return "configured_regex";
    }

    return undefined;
}

export function isSpam(text: string | undefined): boolean {
    return getSpamHeuristic(text) !== undefined;
}
