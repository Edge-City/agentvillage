/**
 * What the proactive triggers (proactive.ts, DATA-314 brief-lite) do to every
 * piece of text before the model sees it.
 *
 * The model never receives third-party free text: the trigger hands it dates,
 * the resident's own data, sanitised schedule facts, organiser announcements,
 * Index counts and cleaned names. This module is the one place that text is
 * cleaned and scanned:
 *
 *   - cleanName(): a person's name as a plain display name, or null.
 *   - cleanText(): an organiser announcement or a fact the overlay computed
 *     (a time, the weather) as one plain line, or null.
 *   - cleanTitle(): text a non-organiser can write or that is read back from
 *     a store (event titles and venues, the resident's notes from memory
 *     files, signals from Index) as one plain line, stricter, or null.
 *   - cronScanHit(): the patterns Hermes's cron prompt scanner blocks a run on.
 *   - connectionsUrl(): the Connections link the brief always carries.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Hermes's cron prompt scanner (tools/cronjob_prompt_scan.py, v2026.9.24) ──

/** tools/threat_patterns.py INVISIBLE_CHARS: Hermes strips these before the scan. */
export const SCAN_INVISIBLE_CHARS = "\u200b\u200c\u200d\u2060\u2062\u2063\u2064\ufeff\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
/** Python's `\w` and `\s` for a str pattern. */
const W = "[\\p{L}\\p{N}_]";
const S = "[\\s\\u001c-\\u001f\\u0085]";

/**
 * `_CRON_SKILL_ASSEMBLED_PATTERNS` (the first four of `_CRON_THREAT_PATTERNS`):
 * what Hermes runs over a prompt that carries Script Output. A hit blocks the
 * whole run.
 */
export const CRON_SCAN_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  [`ignore${S}+(?:${W}+${S}+)*?(?:previous|all|above|prior)${S}+(?:${W}+${S}+)*?instructions`, "prompt_injection"],
  [`do${S}+not${S}+tell${S}+the${S}+user`, "deception_hide"],
  [`system${S}+prompt${S}+override`, "sys_prompt_override"],
  [`disregard${S}+(?:your|all|any)${S}+(?:instructions|rules|guidelines)`, "disregard_rules"],
];

function foldForScan(text: string): string {
  // Python's re.IGNORECASE folds these to ASCII i, k and s; JavaScript's does not.
  return [...text.slice(0, 40_000)]
    .filter((ch) => !SCAN_INVISIBLE_CHARS.includes(ch))
    .map((ch) => (ch === "\u0131" || ch === "\u0130" ? "i" : ch === "\u212a" ? "k" : ch === "\u017f" ? "s" : ch))
    .join("");
}

/** The pattern id Hermes's Script Output scan would block on, or null. */
export function cronScanHit(text: string): string | null {
  const cleaned = foldForScan(text);
  for (const [source, id] of CRON_SCAN_PATTERNS) if (new RegExp(source, "iu").test(cleaned)) return id;
  return null;
}

// ── Cleaning ─────────────────────────────────────────────────────────────────

/** Control, format, private-use and unpaired surrogate code points, and line/paragraph separators. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;
/**
 * Code points that render as nothing: Default_Ignorable_Code_Point, and the
 * Hangul fillers (U+115F, U+1160, U+3164, U+FFA0). Stripped after NFKC, which
 * turns U+3164 into U+1160.
 */
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\u115f\u1160\u3164\uffa0]/gu;
/** Python's splitlines separators that JSON.stringify does not escape, and tabs. */
const LINE_BREAKS = /[\r\n\t\u0085\u2028\u2029]/g;
/** Something that renders: not only combining marks and whitespace. */
const VISIBLE = /[^\p{M}\s]/u;
/**
 * A dot between a letter (or digit) and a letter (`R.Krishnan`, `evil.com`):
 * it gets a space after it, which reads as an initial and is no longer a link
 * shape Telegram turns into a link. A dot between digits (`7.30pm`) stays.
 */
const DOT_BETWEEN_LETTERS = /(?<=[\p{L}\p{M}\p{N}])\.(?=\p{L})/gu;
/**
 * OV-301 fix round 1 (refute S2): combining marks directly after a dot (`evil.\u0301com`). They
 * would hide the letter after the dot from DOT_BETWEEN_LETTERS, so they go before the dot repair.
 * Format characters around a dot (soft hyphen, zero-width space) are already gone (INVISIBLE).
 */
const MARKS_AFTER_DOT = /\.\p{M}+/gu;
/**
 * OV-301 fix round 1 (refute S2): a bare IPv4 address (`203.0.113.7`), removed: four runs of one
 * to three digits joined by dots, no digit or dotted digit on either side. A decimal (`3.0`), a
 * version (`1.2.3`) and a time (`7.30pm`) stay.
 */
const BARE_IPV4 = /(?<![\p{Nd}.])\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3}(?!\p{Nd}|\.\p{Nd})/gu;

/** The domain repair cleanName and cleanTitle share: no IPv4 address, no mark hiding a dot, a space after a dot between letters. */
function withoutDomains(text: string): string {
  return text.replace(BARE_IPV4, " ").replace(MARKS_AFTER_DOT, ".").replace(DOT_BETWEEN_LETTERS, ". ");
}
/**
 * Full stops a browser or Telegram can read as a domain dot: the ideographic
 * full stop U+3002 (NFKC turns U+FF61 into it) and U+FF0E (NFKC turns it into
 * `.`). Folded to `.` before the dot repair, so `evil<U+3002>com` is repaired
 * like `evil.com`.
 */
const DOMAIN_DOTS = /[\u3002\uff0e\uff61]/g;
/** A `$` directly before a letter makes a cashtag (`$TON`); before a digit it is a price and stays. */
const CASHTAG = /\$(?=\p{L})/gu;
/**
 * A digit run that could be a phone number: digits with spaces, dashes, dots
 * or parentheses between them, an optional leading `+` or `(`. It never
 * touches another digit. A `:` ends a run. withoutPhoneRuns decides which
 * runs go, and sets real clock times aside first.
 */
const DIGIT_RUN = /(?<!\p{Nd})\+?\(?\p{Nd}(?:[ .()-]{0,3}\p{Nd})*(?!\p{Nd})/gu;
/** A clock time (`7:30`, `10:00`): one or two digits, a colon, exactly two digits, no digit on either side. */
const CLOCK_TIME = /(?<!\p{Nd})\p{Nd}{1,2}:\p{Nd}{2}(?!\p{Nd})/gu;
/** Stands in for a clock time while phone runs are removed. Private use: the cleaners strip it from input first. */
const TIME_MARK = "\ue000";
/** A `/` that is not between two digits (`10/12` keeps its slash). */
const SLASH_NOT_BETWEEN_DIGITS = /(?<!\p{Nd})\/|\/(?!\p{Nd})/gu;
/** Slashes at the very start or end of the text. */
const EDGE_SLASHES = /^(?:\/\s*)+|(?:\s*\/)+$/g;

function codePointSlice(text: string, n: number): string {
  return [...text].slice(0, n).join("");
}

/**
 * A phone-shaped run removed: one holding 10 to 15 digits, or one starting
 * with `+` and holding at least 7. Shorter runs stay (`2026-2027 cohort`,
 * `1000000 trees`, `Rs 2500 3000`, `2026-10-12`).
 */
function withoutPhoneRuns(text: string): string {
  // Clock times are set aside so `10:00-11:30` is not read as a digit run; nothing else shields a run, so a
  // number with `:1` glued on (`+919876543210:1`) still goes.
  const times: string[] = [];
  const masked = text.replaceAll(TIME_MARK, "").replace(CLOCK_TIME, (time) => {
    times.push(time);
    return TIME_MARK;
  });
  const cut = masked.replace(DIGIT_RUN, (run) => {
    const digits = (run.match(/\p{Nd}/gu) ?? []).length;
    return (digits >= 10 && digits <= 15) || (run.startsWith("+") && digits >= 7) ? " " : run;
  });
  let next = 0;
  return cut.replaceAll(TIME_MARK, () => times[next++] ?? "");
}

/** A name keeps letters, marks, digits, spaces and `' ’ . , -`; anything else becomes a space. */
const NAME_DISALLOWED = /[^\p{L}\p{M}\p{N}\p{Zs}'\u2019.,-]/gu;
/** A command-line flag (`-rf`, `--force`) or a leading `www`. */
const COMMAND_SHAPED = /(?:^|\s)-{1,2}\p{L}|(?:^|\s)www(?:\s|$)/iu;
export const NAME_MAX = 40;

/**
 * A person's name as a plain display name, repaired rather than refused:
 * NFKC-normalised; control, format and default-ignorable characters removed;
 * only letters, marks, digits, spaces and `' ’ . , -` kept (so no markup, no
 * backtick, no `@`, `/`, `:` or brackets); a phone-shaped digit run removed;
 * the full stops that act as a domain dot (U+3002, U+FF0E, U+FF61) read as
 * `.`, and a dot between letters followed by a space (`R.Krishnan` is `R. Krishnan`, and
 * `evil.com` is no longer a link), after a combining mark directly after a
 * dot is dropped, and a bare IPv4 address removed (withoutDomains); whitespace collapsed; at most NAME_MAX code
 * points. Null only when no letter or digit is left, when what is left is
 * command-shaped (a flag), or when it would trip Hermes's scanner.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Phone runs go before the disallowed characters (so a leading `+` and
  // parentheses count) and once more after them (a run they split, now joined by spaces).
  const spaced = withoutPhoneRuns(
    withoutPhoneRuns(
      raw
        .normalize("NFKC")
        .replace(DOMAIN_DOTS, ".")
        .replace(LINE_BREAKS, " ")
        .replace(INVISIBLE, "")
        .replace(IGNORABLE, ""),
    )
      .replace(NAME_DISALLOWED, " ")
      .replace(/\s+/g, " "),
  )
    .replace(/\s+/g, " ");
  const plain = withoutDomains(spaced)
    .replace(/\s+/g, " ")
    .replace(/^[\s'\u2019.,-]+|[\s,-]+$/gu, "")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(plain) || COMMAND_SHAPED.test(plain)) return null;
  const capped = codePointSlice(plain, NAME_MAX).trim();
  return capped && !cronScanHit(capped) ? capped : null;
}

/** Markup that could make a link, a fence or formatting in the delivered message. */
const MARKUP = /[`*_~|\\<>[\]{}#]/g;
/** A URL with a scheme, a `www.` address or an email address. */
const LINKS = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S*|\S+@\S+\.\S+/gi;

/** How a line over its cap is cut: at the cap itself, or at a word boundary before it (cutAtWord). */
export type TitleCut = "codepoint" | "word";

function capped(plain: string, max: number, cut: TitleCut = "codepoint"): string | null {
  if (!VISIBLE.test(plain)) return null;
  const out =
    [...plain].length <= max ? plain : cut === "word" ? cutAtWord(plain, max) : `${codePointSlice(plain, max - 1).trimEnd()}\u2026`;
  return cronScanHit(out) ? null : out;
}

/** Spaces and the punctuation a cut should not leave dangling before its ellipsis (`AI /…` too). */
const CUT_TAIL = /[\s,;:/\u2013\u2014-]+$/u;

/**
 * The kept part of a cut, cleaned again: a cut inside a spaced digit run too
 * long to be a phone number (16 or more digits, which withoutPhoneRuns keeps)
 * can leave a phone-shaped one, so the phone pass runs once more; then the
 * dangling tail goes. Only ever shortens.
 */
function cutClean(kept: string): string {
  return withoutPhoneRuns(kept).replace(/\s+/g, " ").trim().replace(CUT_TAIL, "");
}

/**
 * DATA-374: `plain` (one line, whitespace already collapsed) at most `max`
 * long with an ellipsis marking the cut, cut at the last space before the
 * cap so no word is split; a run with no space in the second half of the
 * room (a single word longer than half the cap) is cut at the cap itself, so
 * one very long word never leaves only the words before it. A phone-shaped
 * digit run the cut leaves is removed (cutClean), and spaces, commas,
 * semicolons, colons, slashes and dashes before the ellipsis are dropped. `unit`
 * measures the length: code points, or UTF-16 code units (JavaScript's
 * `.length`, what Telegram and the control plane count); a surrogate pair is
 * never split either way. Unchanged when it already fits. Pure.
 */
export function cutAtWord(plain: string, max: number, unit: "codepoint" | "utf16" = "codepoint"): string {
  const size = (ch: string) => (unit === "utf16" ? ch.length : 1);
  const chars = [...plain];
  let total = 0;
  for (const ch of chars) total += size(ch);
  if (total <= max) return plain;
  const room = Math.max(0, max - 1); // the ellipsis is one code point and one code unit
  let used = 0;
  let n = 0;
  while (n < chars.length && used + size(chars[n]) <= room) used += size(chars[n++]);
  const atBoundary = n < chars.length && /\s/u.test(chars[n]);
  const space = n > 0 ? chars.lastIndexOf(" ", n - 1) : -1;
  const keep = atBoundary || space < n / 2 ? n : space;
  return `${cutClean(chars.slice(0, keep).join("")) || cutClean(chars.slice(0, n).join(""))}\u2026`;
}

/**
 * Text from an organiser, the overlay's own code, a fixed list or the
 * resident about themself (their notes and signals) as one plain line:
 * NFKC-normalised; control, format and default-ignorable characters removed;
 * links, addresses and markup characters (backticks included) removed;
 * whitespace collapsed; at most `max` code points (an ellipsis marks a cut).
 * Null when nothing visible is left or Hermes's scanner would block on it.
 * Third-party text anyone else can write goes through cleanTitle.
 */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const plain = raw
    .normalize("NFKC")
    .replace(LINE_BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(IGNORABLE, "")
    .replace(LINKS, " ")
    .replace(MARKUP, " ")
    .replace(/\s+/g, " ")
    .trim();
  return capped(plain, max);
}

/**
 * Third-party text a non-organiser can write (an event title or venue a
 * resident host set) as one plain line, stricter than cleanText and repaired
 * rather than refused: everything cleanText removes; `@` removed; a `/` gets
 * a space on both sides (`AI / ML`) unless it is between two digits (`10/12`,
 * `24/7`), and one at the very start or end is dropped, so no `/command`
 * Telegram makes tappable (a slash followed by a space is none) and no
 * handle; a `$` before a letter removed (no cashtag; `$20` stays); a
 * phone-shaped digit run removed (10 to 15 digits, or `+` and 7 or more:
 * withoutPhoneRuns); the full stops that act
 * as a domain dot (U+3002, U+FF0E, U+FF61) read as `.`, and a dot between
 * letters followed by a space, so no domain survives as a link (`7.30pm`
 * stays), after a combining mark directly after a dot is dropped, and a bare
 * IPv4 address removed (withoutDomains). At most `max` code points: cut at the cap with an ellipsis, or,
 * with `cut` "word" (the welcome's intent titles, DATA-374), at a word
 * boundary before it (cutAtWord). Null only when nothing visible is left or Hermes's scanner would
 * block on it. Words that read as an instruction cannot be cleaned away; the
 * prompts say the Script Output is data, and a match field (Index's headline,
 * the resident's intent) that holds them is withheld whole (matchFieldShapeHit).
 */
export function cleanTitle(raw: unknown, max: number, cut: TitleCut = "codepoint"): string | null {
  if (typeof raw !== "string") return null;
  const spaced = withoutPhoneRuns(
    raw
      .normalize("NFKC")
      .replace(DOMAIN_DOTS, ".")
      .replace(LINE_BREAKS, " ")
      .replace(INVISIBLE, "")
      .replace(IGNORABLE, "")
      .replace(LINKS, " ")
      .replace(MARKUP, " ")
      .replace(CASHTAG, "")
      .replace(/@/g, " ")
      .replace(SLASH_NOT_BETWEEN_DIGITS, " / ")
      .replace(/\s+/g, " "),
  );
  const plain = withoutDomains(spaced)
    .replace(/\s+/g, " ")
    .trim()
    .replace(EDGE_SLASHES, "")
    .trim();
  return capped(plain, max, cut);
}


// ── The shape of a match field (INDEX-COMMS A; OV-301 fix round 1, refute M1 and S3) ──

/**
 * Words that make a match field (Index's `headline` for a card, the resident's own intent text)
 * read as an address to someone or an instruction rather than a short topic label. A field that
 * holds any of them as a whole word, after NFKC, the look-alike fold (lookalikeFold) and
 * lower-casing, is withheld whole (matchFieldShapeHit): the cleaner cannot clean away words that
 * read as an instruction, and the prompts use the headline's words as the topic. Whole words only:
 * `systems`, `phonetics`, `opening` and `youth` pass. Deliberately conservative: a topic label that
 * holds one (`open source`, `food system`, an intent in the first person) is withheld too, and
 * the message then says nothing about the topic.
 */
export const MATCH_FIELD_STOP_WORDS: readonly string[] = Object.freeze([
  // address: second and first person
  "you", "your", "yours", "yourself", "yourselves", "u", "ur",
  "me", "my", "mine", "myself", "i", "we", "us", "our", "ours", "ourselves",
  // asks to act or to get in touch
  "reply", "respond", "send", "dm", "dms", "message", "call", "text", "sms", "click", "tap", "open", "visit",
  "please", "pls", "plz", "now", "must", "should", "urgent",
  // instructions to the model
  "ignore", "forget", "disregard", "override", "instruction", "instructions", "rule", "rules",
  "system", "assistant", "admin", "mode",
  // contact details and secrets
  "password", "otp", "phone", "handle", "telegram", "whatsapp", "email",
]);

/**
 * Phrases a match field may not hold (matched as whole words after the same fold): the padding
 * sentences the prompts ban, the names of the delivery labels and their tail, and the words the
 * cron prompts ban. The prompts use the headline's words as the topic, so a headline that holds
 * one would set two rules against each other (refute S3): it is withheld instead.
 */
export const MATCH_FIELD_STOP_PHRASES: readonly string[] = Object.freeze([
  // padding sentences
  "nothing has gone out yet", "nothing has gone out", "say so",
  // delivery labels: "(<Label> message - you can ask me to stop or manage it)"
  "extra introduction drops", "evening questions", "conversation update", "pending opportunity",
  "daily digest", "token usage", "usage report", "ask me to stop", "manage it",
  // banned words of the cron prompts
  "leverage", "unlock", "optimize", "scale", "disrupt", "ai powered", "maximize value", "act fast", "networking", "match",
]);

/** The most words (whitespace-separated runs holding a letter or digit) a match field may have. */
export const MATCH_FIELD_MAX_WORDS = 8;

/**
 * Cyrillic and Greek letters that look like Latin ones, folded to the Latin letter for the shape
 * check only (never for the text that is sent): `іgnore` (Cyrillic і) is read as `ignore`.
 */
const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic lower case
  "а": "a", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j",
  "ӏ": "l", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "ԝ": "w", "х": "x",
  "у": "y", "ү": "y", "ɡ": "g",
  // Cyrillic upper case
  "А": "a", "В": "b", "С": "c", "Е": "e", "Н": "h", "І": "i", "Ј": "j",
  "К": "k", "М": "m", "О": "o", "Р": "p", "Ѕ": "s", "Т": "t", "Х": "x",
  "У": "y", "Ү": "y", "Ԛ": "q", "Ԝ": "w", "Ӏ": "i",
  // Greek lower case
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p",
  "τ": "t", "υ": "u", "χ": "x", "ϲ": "c", "ϳ": "j",
  // Greek upper case
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k",
  "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  // Latin look-alikes NFKC keeps
  "ı": "i", "ȷ": "j",
});

/**
 * The text the shape check reads: NFKC; control, format and default-ignorable characters removed;
 * decomposed and every combining mark removed (`réply` is `reply`); look-alike letters folded;
 * lower case.
 */
export function lookalikeFold(text: string): string {
  const plain = text.normalize("NFKC").replace(INVISIBLE, "").replace(IGNORABLE, "").normalize("NFD").replace(/\p{M}+/gu, "");
  return [...plain].map((ch) => LOOKALIKES[ch] ?? ch).join("").toLowerCase().normalize("NFKC");
}

/** A word mixing Latin with Cyrillic or Greek letters (`pаyments` with a Cyrillic а). */
const MIXED_SCRIPT_WORD = /[\p{L}\p{M}]*(?:\p{Script=Latin}[\p{L}\p{M}]*[\p{Script=Cyrillic}\p{Script=Greek}]|[\p{Script=Cyrillic}\p{Script=Greek}][\p{L}\p{M}]*\p{Script=Latin})/u;
/** An IPv4-shaped run (four dotted digit runs). */
const IPV4_SHAPE = /\p{Nd}+\.\p{Nd}+\.\p{Nd}+\.\p{Nd}+/u;
/** A phone-shaped run: a digit and six or more digits, spaces or dashes after it. */
const PHONE_SHAPE = /\+?\p{Nd}[\p{Nd}\s-]{6,}/u;
/** Marks that end a sentence or a clause (`.`, `!`, `?`, `:`, `;`, `…`, the Devanagari danda). */
const SENTENCE_MARK = /[.!?:;…।॥]/gu;
/** Straight and typographic double quotes: a match field sits inside a quoted template (refute N5). */
const DOUBLE_QUOTES = /["“”„‟«»″‶❝❞⹂〝〞〟＂]/g;

/** A match field's raw text with every double quote replaced by a space (refute N5); NFKC first, so `＂` is caught. */
export function withoutDoubleQuotes(raw: string): string {
  return raw.normalize("NFKC").replace(DOUBLE_QUOTES, " ");
}

/**
 * A sentence mark with more text after it, or a colon or semicolon anywhere (a role marker or a
 * key: `system:`, `messageUrl :`); a dot or a colon between two digits (`3.0`, `7:30`) is not one.
 */
function sentenceMarkInside(text: string): boolean {
  for (const m of text.matchAll(SENTENCE_MARK)) {
    const i = m.index ?? 0;
    if (m[0] !== ":" && m[0] !== ";" && !/[\p{L}\p{N}]/u.test(text.slice(i + 1))) continue;
    if ((m[0] === "." || m[0] === ":") && /\p{Nd}/u.test(text[i - 1] ?? "") && /\p{Nd}/u.test(text[i + 1] ?? "")) continue;
    return true;
  }
  return false;
}

/**
 * Why a match field is not a short topic label, or null when it is one. `raw` is the field as
 * Index or the store gave it, `cleaned` the whole cleaned text (cleanTitle, before any cut). The
 * field is withheld whole when either text, read through lookalikeFold:
 *   - holds a word of MATCH_FIELD_STOP_WORDS or a phrase of MATCH_FIELD_STOP_PHRASES;
 *   - holds a word mixing Latin with Cyrillic or Greek letters;
 *   - would trip Hermes's scanner once the look-alikes are folded;
 *   - holds an IPv4- or phone-shaped digit run;
 * or when the cleaned text has more than MATCH_FIELD_MAX_WORDS words, a sentence mark (`.`,
 * `!`, `?`, `…`) with more text after it, or a `:` or `;` anywhere (not a clock time). The reason is an id only: nothing of the text is
 * returned or logged.
 */
export function matchFieldShapeHit(raw: string, cleaned: string): string | null {
  const words = cleaned.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length > MATCH_FIELD_MAX_WORDS) return "too_many_words";
  if (sentenceMarkInside(cleaned)) return "sentence";
  for (const text of [raw, cleaned]) {
    const unhidden = text.normalize("NFKC").replace(INVISIBLE, "").replace(IGNORABLE, "");
    if (MIXED_SCRIPT_WORD.test(unhidden)) return "mixed_script";
    const folded = lookalikeFold(text);
    if (cronScanHit(folded)) return "scanner";
    const flat = folded.replace(/\s+/g, " ");
    if (IPV4_SHAPE.test(flat) || PHONE_SHAPE.test(flat)) return "digits";
    const tokens = folded.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.some((t) => MATCH_FIELD_STOP_WORDS.includes(t))) return "address_or_instruction";
    const joined = ` ${tokens.join(" ")} `;
    if (MATCH_FIELD_STOP_PHRASES.some((phrase) => joined.includes(` ${phrase} `))) return "banned_phrase";
  }
  return null;
}

// ── The Connections link ─────────────────────────────────────────────────────

export const DEFAULT_CONNECTIONS_URL = "https://agents.edgecity.live/insights";

/** A variable from the process environment, else `$HERMES_HOME/.env` (cron scripts may not inherit it). */
export function envOrDotenv(name: string, home: string): string {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) return fromEnv.trim();
  const file = join(home, ".env");
  if (!existsSync(file)) return "";
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match && match[1] === name) return match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // unreadable .env: unset
  }
  return "";
}

/**
 * The Connections link: `AV_CONNECTIONS_URL` when it parses as an `https` URL
 * with no user name or password (and no character that could break a
 * message: whitespace, quotes, backticks, angle or round or square brackets),
 * else DEFAULT_CONNECTIONS_URL.
 */
export function connectionsUrl(home: string): string {
  const raw = envOrDotenv("AV_CONNECTIONS_URL", home);
  if (!raw) return DEFAULT_CONNECTIONS_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return DEFAULT_CONNECTIONS_URL;
    return /^https:\/\/[^\s"'`<>()[\]]+$/.test(url.href) && !cronScanHit(url.href) ? url.href : DEFAULT_CONNECTIONS_URL;
  } catch {
    return DEFAULT_CONNECTIONS_URL;
  }
}
