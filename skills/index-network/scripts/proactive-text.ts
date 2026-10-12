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
 * The domain repair cleanName and cleanTitle share: no mark hiding a dot, a space after a dot
 * between letters. A dotted number (`1.2.3.4`) stays, as before OV-301: fix round 2 (recheck N3)
 * scopes the IPv4 rule to the match fields, which withhold any `.` (cleanMatchField).
 */
function withoutDomains(text: string): string {
  return text.replace(MARKS_AFTER_DOT, ".").replace(DOT_BETWEEN_LETTERS, ". ");
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
 * dot is dropped (withoutDomains); whitespace collapsed; at most NAME_MAX code
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
 * stays), after a combining mark directly after a dot is dropped
 * (withoutDomains). At most `max` code points: cut at the cap with an ellipsis, or,
 * with `cut` "word" (the welcome's intent titles, DATA-374), at a word
 * boundary before it (cutAtWord). Null only when nothing visible is left or Hermes's scanner would
 * block on it. Words that read as an instruction cannot be cleaned away; the
 * prompts say the Script Output is data. A match field (Index's headline, the
 * resident's intent) does not come through here: cleanMatchField withholds it
 * whole unless it is shaped like a short topic label.
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


// ── A match field (INDEX-COMMS A; OV-301 fix round 1, refute M1 and S3; fix round 2, recheck M1, M2, S1, N1-N3; fix round 3, recheck fab55b9 M1, M2, N1-N3) ──
//
// A match field (Index's `headline` for a card, the resident's own intent text) reaches the model
// only when it is shaped like a short topic label. The gate is a closed allow-shape, not a deny
// list (fix round 2): every word is letters of one allowed script, digits and `' ’ - & /`, and the
// text that is checked is the text that is sent (cleanMatchField).

/**
 * Strong signals that a match field is an address to someone, an instruction, a contact lure or a
 * payment ask rather than a topic label. A field holding one as a whole word, read through
 * lookalikeFold (and the other check readings, matchFieldReadings), is withheld whole: the second
 * gate, after the allow-shape. Whole words only (`systems`, `youth`, `payments`, `phonetics`,
 * `nowcasting` pass). Fix round 2 (recheck S2) dropped `open`, `call`, `text`, `us`, `i`, `we`,
 * `message` and `system`, which withheld about a third of real topics. Fix round 3 (recheck fab55b9
 * M1) restores the contact, ask and role words round 2 also dropped (`telegram`, `whatsapp`,
 * `email`, `phone`, `handle`, `sms`, `u`, `ur`, `please`, `pls`, `plz`, `must`, `should`, `now`,
 * `mode`): none of the 50 sampled topics holds one. A first-person possessive (`my project on
 * memory`) is withheld too.
 */
export const MATCH_FIELD_STOP_WORDS: readonly string[] = Object.freeze([
  // address: second person, and the first person as the object of an ask
  "you", "your", "yours", "yourself", "me", "my", "mine", "myself", "u", "ur",
  // asks to act or to get in touch
  "reply", "respond", "send", "dm", "dms", "click", "tap", "visit", "urgent",
  "please", "pls", "plz", "must", "should", "now",
  // contact channels and details
  "telegram", "whatsapp", "email", "phone", "handle", "sms",
  // instructions to the model
  "ignore", "forget", "disregard", "override", "instruction", "instructions", "rule", "rules", "assistant", "admin", "mode",
  // secrets and money
  "password", "otp", "wallet", "pay", "transfer",
]);

/**
 * Phrases a match field may not hold (whole words, after the same fold): the padding sentences the
 * prompts ban, the names of the delivery labels and their tail, the words the cron prompts ban
 * (the prompts use the headline's words as the topic, so a headline holding one would set two
 * rules against each other: refute S3), and `system` as a role or a prompt (fix round 2: `system`
 * alone is a topic word, as in `food system`).
 */
export const MATCH_FIELD_STOP_PHRASES: readonly string[] = Object.freeze([
  // padding sentences
  "nothing has gone out yet", "nothing has gone out", "say so",
  // delivery labels: "(<Label> message - you can ask me to stop or manage it)"
  "extra introduction drops", "evening questions", "conversation update", "pending opportunity",
  "daily digest", "token usage", "usage report", "ask me to stop", "manage it",
  // banned words of the cron prompts
  "leverage", "unlock", "optimize", "scale", "disrupt", "ai powered", "maximize value", "act fast", "networking", "match",
  // a role or a prompt
  "system prompt", "system message", "system note", "system notice", "system alert", "system update", "system mode",
]);

/** The most words (space-separated runs holding a letter or digit) a match field may have. */
export const MATCH_FIELD_MAX_WORDS = 6;
/** The longest match field (code points, after cleaning) that is checked at all; a longer one is no label and is withheld. */
export const MATCH_FIELD_MAX_LENGTH = 4000;

/**
 * The closed set of scripts a match field's letters may come from, one per word (fix round 2,
 * recheck M1). Within each, only the main blocks: Latin is Basic Latin, Latin-1, Latin
 * Extended-A and -B (not the click letters U+01C0-01C3) and Latin Extended Additional, so no IPA,
 * small capitals or other phonetic letters; CJK is Han, Hiragana and Katakana. Anything else
 * (Armenian, Cherokee, Georgian, braille, symbols, emoji, maths or enclosed letters NFKC leaves,
 * a combining mark NFKC cannot compose onto its letter) withholds the field.
 *
 * Fix round 3 (recheck fab55b9 M2): a Latin letter outside ASCII is allowed only when it reads as
 * ASCII letters to the check: its NFD with every mark removed is ASCII (`é`, `ǐ`, `ơ`), or the
 * look-alike fold maps it (`ı`, `ø`, `ł`, `đ`, `ħ`), or it is one of MATCH_FIELD_LATIN_KEPT. Any
 * other (`Ɨ`, `ǥ`, `Ƥ`, `ƚ`, `ɇ`, `ƴ`, `ǝ`, ...) withholds the field.
 */
export const MATCH_FIELD_SCRIPTS = Object.freeze(["Latin", "Cyrillic", "Greek", "Devanagari", "Arabic", "Hebrew", "CJK", "Thai", "Hangul"] as const);
type FieldScript = (typeof MATCH_FIELD_SCRIPTS)[number];
/** The Latin blocks a match field's letters may come from (code point ranges; the click letters U+01C0-01C3 are not letters of a word). */
export const MATCH_FIELD_LATIN_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze([[0x0000, 0x01bf], [0x01c4, 0x024f], [0x1e00, 0x1eff]] as const);
/** Non-ASCII Latin letters NFD cannot take apart and the fold does not map, kept as letters of a real word (fix round 3, recheck M2). */
export const MATCH_FIELD_LATIN_KEPT: readonly string[] = Object.freeze(["æ", "Æ", "œ", "Œ", "ß", "ẞ", "ð", "Ð", "þ", "Þ", "ŋ", "Ŋ"]);

const IS_LETTER = /\p{L}/u;
const IS_LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const IS_LETTER_MARK_OR_DIGIT = /[\p{L}\p{M}\p{Nd}]/u;
const inRange = (cp: number, from: number, to: number) => cp >= from && cp <= to;
/** A non-ASCII Latin letter reads as ASCII letters to the check (MATCH_FIELD_SCRIPTS, fix round 3). */
function latinReadsPlain(ch: string, cp: number): boolean {
  return cp < 0x80 || /^[A-Za-z]+$/.test(ch.normalize("NFD").replace(/\p{M}+/gu, "")) || ch in LOOKALIKES || MATCH_FIELD_LATIN_KEPT.includes(ch);
}
const SCRIPT_OF: ReadonlyArray<readonly [FieldScript, (ch: string, cp: number) => boolean]> = [
  ["Latin", (ch, cp) => MATCH_FIELD_LATIN_RANGES.some(([from, to]) => inRange(cp, from, to)) && IS_LETTER.test(ch) && /\p{Script=Latin}/u.test(ch) && latinReadsPlain(ch, cp)],
  ["Cyrillic", (ch, cp) => inRange(cp, 0x400, 0x52f) && IS_LETTER.test(ch) && /\p{Script=Cyrillic}/u.test(ch)],
  ["Greek", (ch, cp) => (inRange(cp, 0x370, 0x3ff) || inRange(cp, 0x1f00, 0x1fff)) && IS_LETTER.test(ch) && /\p{Script=Greek}/u.test(ch)],
  ["Devanagari", (ch, cp) => inRange(cp, 0x900, 0x97f) && IS_LETTER_MARK_OR_DIGIT.test(ch) && /\p{Script=Devanagari}/u.test(ch)],
  // The Arabic vowel marks (harakat, superscript alef) are Script=Inherited.
  ["Arabic", (ch, cp) => inRange(cp, 0x64b, 0x65f) || cp === 0x670 || ((inRange(cp, 0x600, 0x6ff) || inRange(cp, 0x750, 0x77f) || inRange(cp, 0x8a0, 0x8ff)) && IS_LETTER_MARK_OR_DIGIT.test(ch) && /\p{Script=Arabic}/u.test(ch))],
  ["Hebrew", (ch, cp) => inRange(cp, 0x590, 0x5ff) && IS_LETTER_OR_MARK.test(ch) && /\p{Script=Hebrew}/u.test(ch)],
  // The prolonged sound mark U+30FC is Script=Common.
  ["CJK", (ch, cp) =>
    ((inRange(cp, 0x3005, 0x3007) || inRange(cp, 0x3400, 0x4dbf) || inRange(cp, 0x4e00, 0x9fff) || inRange(cp, 0x20000, 0x3134f)) && /\p{Script=Han}/u.test(ch)) ||
    inRange(cp, 0x3041, 0x3096) || inRange(cp, 0x309d, 0x309f) || inRange(cp, 0x30a1, 0x30fa) || inRange(cp, 0x30fc, 0x30ff) || inRange(cp, 0x31f0, 0x31ff)],
  ["Thai", (ch, cp) => inRange(cp, 0xe01, 0xe59) && IS_LETTER_MARK_OR_DIGIT.test(ch) && /\p{Script=Thai}/u.test(ch)],
  ["Hangul", (_ch, cp) => inRange(cp, 0xac00, 0xd7a3) || (inRange(cp, 0x1100, 0x11ff) && cp !== 0x115f && cp !== 0x1160)],
];
/**
 * The punctuation a match field may hold: inside a word (between two letters or digits), and
 * `/ & -` alone as a word. Fix round 3 (recheck fab55b9 N1): the typographic apostrophe `’`
 * (phones type it) is allowed where `'` is; the check reads it as `'`.
 */
const JOINERS = "'’-&/";
const LONE_JOINERS = "/&-";
const JOINER_RUNS = /['’\-&/]+/g;

type CharKind = FieldScript | "digit" | "joiner";
function charKind(ch: string): CharKind | null {
  if (ch >= "0" && ch <= "9") return "digit";
  if (JOINERS.includes(ch)) return "joiner";
  const cp = ch.codePointAt(0) ?? 0;
  for (const [script, test] of SCRIPT_OF) if (test(ch, cp)) return script;
  return null;
}

/** Why one word is not an allowed word, or null. */
function wordShapeHit(word: string): string | null {
  const chars = [...word];
  if (chars.length === 1 && LONE_JOINERS.includes(chars[0])) return null;
  const kinds = chars.map(charKind);
  let script: FieldScript | null = null;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    if (kind === null) return "character";
    if (kind === "joiner") {
      const before = kinds[i - 1];
      const after = kinds[i + 1];
      if (!before || before === "joiner" || !after || after === "joiner") return "punctuation";
    } else if (kind !== "digit") {
      if (script && script !== kind) return "mixed_script";
      script = kind;
    }
  }
  return null;
}

/**
 * Characters that withhold a match field whole rather than being stripped (fix round 2): tag
 * characters, variation selectors, private-use characters, lone surrogates and the bidi controls
 * (a reversed text stays reversed once the override is stripped). Fix round 3 (recheck fab55b9
 * N2): the zero-width characters too (ZERO_WIDTH). Other format characters (soft hyphen) are
 * removed before the check, so the check reads the joined word.
 */
const HIDDEN_CARRIERS = /[\u{E0000}-\u{E007F}︀-️\u{E0100}-\u{E01EF}᠋-᠍᠏\p{Co}\p{Cs}؜‎‏‪-‮⁦-⁩]/u;

/**
 * Zero-width characters withhold a match field whole (fix round 3, recheck fab55b9 N2): removing
 * them would join two words the reader sees apart (`memory​systems`). U+200B, U+2060-2064, U+FEFF,
 * U+180E anywhere; the zero-width non-joiner and joiner (U+200C, U+200D) unless both neighbours are
 * Arabic or Devanagari, where they shape real words (Persian, Hindi half forms); there they are
 * removed as before.
 */
export const ZERO_WIDTH = /[​⁠-⁤﻿᠎]|(?<![\p{Script=Arabic}\p{Script=Devanagari}ً-ٰٟ])[‌‍]|[‌‍](?![\p{Script=Arabic}\p{Script=Devanagari}])/u;

/**
 * Letters that look like Latin ones, folded to the Latin letter for the check only (the text sent
 * is never folded): Cyrillic and Greek (an all-Greek `ΡΑΥ` reads as `pay`; a word mixing scripts is
 * withheld by the allow-shape already) and the Latin letters with a stroke NFD cannot take apart.
 * Fix round 3 (recheck fab55b9 M2): Cyrillic `м п г ԍ`, Greek `γ`, and the kept Latin letters
 * (MATCH_FIELD_LATIN_KEPT) by what they look like. Fix round 4 (recheck af3ef6ae M1): Cyrillic
 * `т ҽ Ԁ` and Greek `η ω` (`отр`, `ѕҽпԁ`, `ԀМ`, `ηοω`).
 */
const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic lower case
  "а": "a", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j",
  "ӏ": "l", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "ԝ": "w", "х": "x",
  "у": "y", "ү": "y", "ɡ": "g", "м": "m", "п": "n", "г": "r", "ԍ": "g",
  "т": "t", "ҽ": "e",
  // Cyrillic upper case
  "А": "a", "В": "b", "С": "c", "Е": "e", "Н": "h", "І": "i", "Ј": "j",
  "К": "k", "М": "m", "О": "o", "Р": "p", "Ѕ": "s", "Т": "t", "Х": "x",
  "У": "y", "Ү": "y", "Ԛ": "q", "Ԝ": "w", "Ӏ": "i", "Ԁ": "d",
  // Greek lower case
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p",
  "τ": "t", "υ": "u", "χ": "x", "ϲ": "c", "ϳ": "j", "γ": "y", "η": "n", "ω": "w",
  // Greek upper case
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k",
  "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  // Latin letters NFKC and NFD keep: dotless, stroked
  "ı": "i", "ȷ": "j", "ĸ": "k", "ø": "o", "Ø": "o", "ł": "l", "Ł": "l", "đ": "d", "Đ": "d",
  "ħ": "h", "Ħ": "h", "ŧ": "t", "Ŧ": "t", "ƀ": "b", "Ƀ": "b",
  // the kept Latin letters (MATCH_FIELD_LATIN_KEPT)
  "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ß": "ss", "ẞ": "ss", "ð": "d", "Ð": "d", "þ": "p", "Þ": "p", "ŋ": "n", "Ŋ": "n",
});

/**
 * The text the word list and the scanner read (never sent): NFKC; control, format and
 * default-ignorable characters removed; decomposed and every combining mark removed (`réply` is
 * `reply`); look-alike letters folded; lower case.
 */
export function lookalikeFold(text: string): string {
  const plain = text.normalize("NFKC").replace(INVISIBLE, "").replace(IGNORABLE, "").normalize("NFD").replace(/\p{M}+/gu, "");
  return [...plain].map((ch) => LOOKALIKES[ch] ?? ch).join("").toLowerCase().normalize("NFKC");
}

/** An IPv4-shaped run (four dotted digit runs). */
const IPV4_SHAPE = /\p{Nd}+\.\p{Nd}+\.\p{Nd}+\.\p{Nd}+/u;
/** A phone-shaped run: a digit and six or more digits, spaces or dashes after it. */
const PHONE_SHAPE = /\+?\p{Nd}[\p{Nd}\s-]{6,}/u;
/** The shortest word that reads as a wallet address (destinationShapeHit). */
const DESTINATION_WORD_MIN = 20;
/** The fewest digits in one word or one joined digit run that read as a phone or account number (destinationShapeHit). */
const DESTINATION_DIGITS_MIN = 9;
/** A run of digits joined by spaces, `-`, `/`, `&`, `'` or `’` (`0171/123/4567`, `9876&543&210`). */
const JOINED_DIGIT_RUN = /\p{Nd}+(?:[\s'’\-&/]+\p{Nd}+)*/gu;
/** A lower-case letter followed by a capital (`dC`); a word of DESTINATION_WORD_MIN or more with two of them reads as an address. */
const LOWER_THEN_CAPITAL = /\p{Ll}\p{Lu}/gu;

const countDigits = (text: string) => (text.match(/\p{Nd}/gu) ?? []).length;
/**
 * Letters typed for digits (`O` or `o` for 0, `I` or `l` for 1), read as digits in a part of a word
 * (between joiners) made of digits and those letters only, with two or more digits (`O171/I23/4567`;
 * `GPT-4o` stays).
 */
const digitLettersRead = (text: string) =>
  text.replace(/[\p{L}\p{Nd}]+/gu, (part) => (/^[\p{Nd}OoIl]+$/u.test(part) && countDigits(part) >= 2 ? part.replace(/[Oo]/g, "0").replace(/[Il]/g, "1") : part));

/**
 * A payment or contact destination in a shape the IPv4 and phone checks miss (fix round 5, recheck
 * 4dadc91d M2). The check only: nothing is rewritten, and a date (`12/10/2026`, 8 digits) is not one.
 *   - a wallet address: a word of DESTINATION_WORD_MIN or more code points that mixes letters and
 *     digits (ETH `0x…`, BTC `bc1…`, Solana, TON), or that turns from lower case to a capital twice
 *     or more (a Solana or TON address ground to hold no digit; `McDonald's-sponsored` stays);
 *   - a phone or account number: DESTINATION_DIGITS_MIN or more digits in one word (`0171x123x4567`)
 *     or in one run of digits joined by a space, `-`, `/`, `&`, `'` or `’` (`0171/123/4567`,
 *     `9876&543&210`), reading `O o` as 0 and `I l` as 1 in a part of a word made of digits and
 *     those letters, with two or more digits (`O171/I23/4567`).
 */
export function destinationShapeHit(text: string): boolean {
  for (const word of text.split(/\s+/)) {
    if ([...word].length < DESTINATION_WORD_MIN || !/\p{L}/u.test(word)) continue;
    if (/\p{Nd}/u.test(word) || (word.match(LOWER_THEN_CAPITAL) ?? []).length >= 2) return true;
  }
  const read = digitLettersRead(text.replace(/\s+/g, " "));
  if (read.split(" ").some((word) => countDigits(word) >= DESTINATION_DIGITS_MIN)) return true;
  return (read.match(JOINED_DIGIT_RUN) ?? []).some((run) => countDigits(run) >= DESTINATION_DIGITS_MIN);
}
/** Straight and typographic double quotes: a match field sits inside a quoted template (refute N5). */
const DOUBLE_QUOTES = /["“”„‟«»″‶❝❞⹂〝〞〟＂]/g;

/** A match field's raw text with every double quote replaced by a space (refute N5); NFKC first, so `＂` is caught. */
export function withoutDoubleQuotes(raw: string): string {
  return raw.normalize("NFKC").replace(DOUBLE_QUOTES, " ");
}

/**
 * Why `text` (a match field as cleanMatchField sends it: NFKC, one line, single spaces) is not a
 * short topic label, or null when it is one. In order:
 *   1. the allow-shape: every space-separated word is letters of one script of
 *      MATCH_FIELD_SCRIPTS, ASCII digits and `' - & /` between two letters or digits (`/`, `&`
 *      and `-` may also stand alone); any other character, a mixed-script word or a stray mark
 *      withholds it;
 *   2. at most MATCH_FIELD_MAX_WORDS words, at most MATCH_FIELD_MAX_LENGTH code points;
 *   3. no IPv4- or phone-shaped digit run, and no wallet-address-shaped word or joined run of 9 or
 *      more digits (destinationShapeHit, fix round 5);
 *   4. Hermes's scanner, on the text, then on every check reading of it (matchFieldReadings);
 *   5. in every reading: no word of MATCH_FIELD_STOP_WORDS and no phrase of
 *      MATCH_FIELD_STOP_PHRASES, also when two or more adjacent words are read as one
 *      (`igno re`, `u r`); and the scanner's phrases not in the reading with every space and
 *      joiner removed (`ignoreallpreviousinstructions`).
 * The reason is an id only: nothing of the text is returned or logged.
 */
export function matchFieldShapeHit(text: string): string | null {
  if (!text || [...text].length > MATCH_FIELD_MAX_LENGTH) return "length";
  if (HIDDEN_CARRIERS.test(text) || ZERO_WIDTH.test(text)) return "hidden";
  let words = 0;
  for (const word of text.split(" ")) {
    if (!word) return "spacing";
    const hit = wordShapeHit(word);
    if (hit) return hit;
    if (/[\p{L}\p{N}]/u.test(word)) words++;
  }
  if (words > MATCH_FIELD_MAX_WORDS) return "too_many_words";
  if (IPV4_SHAPE.test(text) || PHONE_SHAPE.test(text)) return "digits";
  if (destinationShapeHit(text)) return "destination";
  if (cronScanHit(text)) return "scanner";
  for (const form of matchFieldReadings(text)) {
    if (cronScanHit(form) || joinedScanHit(form.replace(/[\s'\-&/]+/g, ""))) return "scanner";
    const tokens = form.split(/\s+/).filter(Boolean);
    if (tokens.some((t) => MATCH_FIELD_STOP_WORDS.includes(t))) return "address_or_instruction";
    const padded = ` ${tokens.join(" ")} `;
    if (MATCH_FIELD_STOP_PHRASES.some((phrase) => padded.includes(` ${phrase} `))) return "banned_phrase";
    if (adjacentJoinHit(tokens)) return "joined_words";
  }
  return null;
}

/** Leetspeak digits (and `@ $`) read as letters, in a check copy of a word that mixes letters and digits (fix round 3, recheck fab55b9 M2). */
const LEET: Readonly<Record<string, string>> = Object.freeze({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" });
/** `1` also reads as `l` (`ru1es`). */
const LEET_L: Readonly<Record<string, string>> = Object.freeze({ ...LEET, "1": "l" });

function leetFold(folded: string, map: Readonly<Record<string, string>>): string {
  return folded
    .split(" ")
    .map((word) => (/\p{L}/u.test(word) && /[0-9@$]/.test(word) ? [...word].map((ch) => map[ch] ?? ch).join("") : word))
    .join(" ");
}

/** A word split where its case changes (`IgnoreAllPrevious` is `Ignore All Previous`, `XMLParser` is `XML Parser`). */
function camelSplit(text: string): string {
  return text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
}

/**
 * A capital I beside a lower-case letter read as `l` (`teIegram`, `waIIet`, `emaiI`, `Iink`): in most
 * sans-serif fonts, Telegram's included, the two look the same (fix round 4, recheck af3ef6ae M1).
 * Latin `I`, Cyrillic `І Ӏ` and Greek `Ι`; not after another capital (`PIs` stays). And the mirror:
 * a small `l` in an upper-case word read as `I` (`lGNORE`, `PREVlOUS`).
 */
function capitalIAsL(text: string): string {
  return text.replace(/(?<=\p{Ll})[IІӀΙ]+|(?<![\p{L}\p{N}])[IІӀΙ]+(?=\p{Ll})/gu, (run) => "l".repeat([...run].length));
}
function smallLAsI(text: string): string {
  return text.replace(/(?<=\p{Lu})l+(?!\p{Ll})|(?<![\p{L}\p{N}])l+(?=\p{Lu})/gu, (run) => "I".repeat(run.length));
}

/** Letter pairs that read as one letter (fix round 4, recheck af3ef6ae M1): `rn` as `m` (`adrnin rnode`), `vv` as `w` (`vvallet`). */
function pairsJoined(folded: string): string {
  return folded.replace(/rn/g, "m").replace(/vv/g, "w");
}

/** `n't` read as ` not` (`don't` is `do not`, which the scanner reads), and `dont` as `do not`. */
function notExpanded(folded: string): string {
  return folded
    .replace(/n't(?![\p{L}\p{N}])/gu, " not")
    .replace(/(?<![\p{L}\p{N}])dont(?![\p{L}\p{N}])/gu, "do not")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * The check copies of a match field (never sent), fix round 3 (recheck fab55b9 M2) and fix round 4
 * (recheck af3ef6ae M1), in this order:
 *   1. the text with `’` read as `'`; as is, with a capital I beside a lower-case letter read as `l`,
 *      and with a small `l` in an upper-case word read as `I`;
 *   2. each as is and split where its case changes;
 *   3. each through lookalikeFold;
 *   4. each as is and with leetspeak digits read as letters (`1` as `i`, then as `l`);
 *   5. each as is and with `rn` read as `m`, `vv` as `w`;
 *   6. each as is, with `' - & /` read as a space and with them removed;
 *   7. last, each with `n't` read as ` not` and `dont` as `do not`, so the `not` reading sees the
 *      digits and joiners already read (`d0nt`, `don'7`, `do'nt`).
 */
export function matchFieldReadings(text: string): string[] {
  const plain = text.replace(/’/g, "'");
  const readings = new Set<string>();
  for (const cased of new Set([plain, capitalIAsL(plain), smallLAsI(plain)])) {
    for (const base of new Set([cased, camelSplit(cased)])) {
      const folded = lookalikeFold(base);
      for (const digits of new Set([folded, leetFold(folded, LEET), leetFold(folded, LEET_L)])) {
        for (const form of new Set([digits, pairsJoined(digits)])) {
          readings.add(notExpanded(form));
          readings.add(notExpanded(form.replace(JOINER_RUNS, " ").replace(/ +/g, " ").trim()));
          readings.add(notExpanded(form.replace(JOINER_RUNS, "")));
        }
      }
    }
  }
  return [...readings];
}

/** A stop word or stop phrase with its spaces removed: what two or more adjacent words may not join to. */
const JOINED_STOPS: ReadonlySet<string> = new Set([...MATCH_FIELD_STOP_WORDS, ...MATCH_FIELD_STOP_PHRASES.map((phrase) => phrase.replace(/ /g, ""))]);
const JOINED_STOP_MAX = Math.max(...[...JOINED_STOPS].map((s) => s.length));

/** Two or more adjacent words that read as one stop word or phrase (`igno re`, `u r`, `ask meto stop`). */
function adjacentJoinHit(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    let joined = tokens[i];
    for (let j = i + 1; j < tokens.length; j++) {
      joined += tokens[j];
      if (joined.length > JOINED_STOP_MAX) break;
      if (JOINED_STOPS.has(joined)) return true;
    }
  }
  return false;
}

/** The scanner's four phrases in a reading with every space and joiner removed. */
function joinedScanHit(joined: string): boolean {
  const ignore = joined.indexOf("ignore");
  if (ignore >= 0) {
    const end = joined.lastIndexOf("instructions");
    if (end > ignore && /previous|all|above|prior/.test(joined.slice(ignore + "ignore".length, end))) return true;
  }
  // `do nt tell the user` joins to `donttelltheuser` (fix round 4, recheck af3ef6ae M1).
  return /dono?ttelltheuser/.test(joined) || joined.includes("systempromptoverride") || /disregard(?:your|all|any)(?:instructions|rules|guidelines)/.test(joined);
}

/**
 * Why a match field was withheld, for the detection event (DATA-487): a code and the gate, never any
 * text. `length_capped` is reserved (in the closed set data registered) and not emitted: the whole
 * cleaned text is checked before the cut, so a cut carries no lure signal (fix round 4, recheck
 * af3ef6ae S2).
 */
export type MatchFieldReason = "cleaner_withheld" | "scanner_flagged" | "shape_withheld" | "length_capped";
export type MatchFieldStage = "cleaner" | "scanner" | "shape";
export interface MatchFieldVerdict {
  /** The field as the model may see it, or null (withheld whole). */
  text: string | null;
  /** Set when the field was withheld or flagged; null when it went out (whole or cut) or was absent. */
  flag: { reason: MatchFieldReason; stage: MatchFieldStage } | null;
}

const shapeReason = (hit: string): MatchFieldReason => (hit === "scanner" ? "scanner_flagged" : "shape_withheld");

/**
 * A match field as the model may see it, or null (withheld whole), and why it was withheld.
 * The pipeline (fix round 2):
 *   1. Hermes's scanner on the raw text (`scanner_flagged`, stage `scanner`);
 *   2. NFKC; a tag character, variation selector, private-use character, bidi control or
 *      zero-width character withholds it (HIDDEN_CARRIERS, ZERO_WIDTH; `cleaner_withheld`, stage
 *      `cleaner`);
 *   3. double quotes to a space (refute N5), line breaks to a space, the other control, format
 *      and default-ignorable characters removed, whitespace collapsed; nothing left is
 *      `cleaner_withheld`, stage `cleaner`;
 *   4. matchFieldShapeHit on that text (stage `shape`: `scanner_flagged` for a scanner phrase in
 *      any reading, else `shape_withheld`); nothing is rewritten after this point except the cut;
 *   5. cut at a word to `max` code points (cutAtWord), and matchFieldShapeHit (stage `shape`) and
 *      the scanner (stage `scanner`) run again on what is sent (the cut can end on a listed word:
 *      recheck N1). A cut that passes has no flag (fix round 4: `length_capped` is reserved).
 * The string checked is the string sent: NFKC, never folded, no markup or link removed (a field
 * holding one is withheld, not repaired). An absent field (undefined, null, "") has no flag; any
 * other value that is not a string is `cleaner_withheld`.
 */
export function matchFieldVerdict(raw: unknown, max: number): MatchFieldVerdict {
  const withheld = (reason: MatchFieldReason, stage: MatchFieldStage): MatchFieldVerdict => ({ text: null, flag: { reason, stage } });
  if (raw === undefined || raw === null || raw === "") return { text: null, flag: null };
  if (typeof raw !== "string") return withheld("cleaner_withheld", "cleaner");
  if (cronScanHit(raw)) return withheld("scanner_flagged", "scanner");
  const nfkc = raw.normalize("NFKC");
  if (HIDDEN_CARRIERS.test(nfkc) || ZERO_WIDTH.test(nfkc)) return withheld("cleaner_withheld", "cleaner");
  const text = withoutDoubleQuotes(nfkc).replace(LINE_BREAKS, " ").replace(INVISIBLE, "").replace(IGNORABLE, "").replace(/\s+/g, " ").trim();
  if (!text) return withheld("cleaner_withheld", "cleaner");
  const hit = matchFieldShapeHit(text);
  if (hit) return withheld(shapeReason(hit), "shape");
  const out = cutAtWord(text, max);
  const sent = out === text ? out : out.replace(/…$/u, "");
  const sentHit = matchFieldShapeHit(sent);
  if (sentHit) return withheld(shapeReason(sentHit), "shape");
  if (cronScanHit(out)) return withheld("scanner_flagged", "scanner");
  return { text: out, flag: null };
}

/** A match field as the model may see it, or null (withheld whole): matchFieldVerdict's text. */
export function cleanMatchField(raw: unknown, max: number): string | null {
  return matchFieldVerdict(raw, max).text;
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
