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
 *   - cleanText(): an organiser announcement, a fact the overlay computed (a
 *     time, the weather) or the resident's own words about themself (their
 *     notes and signals) as one plain line, or null.
 *   - cleanTitle(): third-party text a non-organiser can write (event titles
 *     and venues) as one plain line, stricter, or null.
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
 * touches a digit, and never takes in a digit beside a `:` and a digit (a time
 * like `10:00` is not part of one). withoutPhoneRuns decides which runs go.
 */
const DIGIT_RUN = /(?<!\p{Nd})(?<!\p{Nd}:)\+?\(?\p{Nd}(?:[ .()-]{0,3}\p{Nd})*(?!\p{Nd})(?!:\p{Nd})/gu;
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
  return text.replace(DIGIT_RUN, (run) => {
    const digits = (run.match(/\p{Nd}/gu) ?? []).length;
    return (digits >= 10 && digits <= 15) || (run.startsWith("+") && digits >= 7) ? " " : run;
  });
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
 * `evil.com` is no longer a link); whitespace collapsed; at most NAME_MAX code
 * points. Null only when no letter or digit is left, when what is left is
 * command-shaped (a flag), or when it would trip Hermes's scanner.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Phone runs go before the disallowed characters (so a leading `+` and
  // parentheses count) and once more after them (a run they split, now joined by spaces).
  const plain = withoutPhoneRuns(
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
    .replace(DOT_BETWEEN_LETTERS, ". ")
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

function capped(plain: string, max: number): string | null {
  if (!VISIBLE.test(plain)) return null;
  const cut = [...plain].length > max ? `${codePointSlice(plain, max - 1).trimEnd()}\u2026` : plain;
  return cronScanHit(cut) ? null : cut;
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
 * stays). Null only when nothing visible is left or Hermes's scanner would
 * block on it. Words that read as an instruction cannot be cleaned away; the
 * prompts say the Script Output is data.
 */
export function cleanTitle(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const plain = withoutPhoneRuns(
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
  )
    .replace(DOT_BETWEEN_LETTERS, ". ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(EDGE_SLASHES, "")
    .trim();
  return capped(plain, max);
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
