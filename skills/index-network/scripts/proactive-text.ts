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
 *   - cleanText(): a schedule fact, announcement or note as one plain line, or null.
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

function codePointSlice(text: string, n: number): string {
  return [...text].slice(0, n).join("");
}

/** A name keeps letters, marks, digits, spaces and `' ’ . , -`; anything else becomes a space. */
const NAME_DISALLOWED = /[^\p{L}\p{M}\p{N}\p{Zs}'\u2019.,-]/gu;
/** Two letter runs joined by a dot (`ana.silva`, `example.com`): Telegram may link it. */
const DOTTED_WORD = /[\p{L}\p{N}-]\.\p{L}{2}/u;
/** A command-line flag (`-rf`, `--force`) or a leading `www`. */
const COMMAND_SHAPED = /(?:^|\s)-{1,2}\p{L}|(?:^|\s)www(?:\s|$)/iu;
export const NAME_MAX = 40;

/**
 * A person's name as a plain display name: NFKC-normalised; control and
 * format characters removed; only letters, marks, digits, spaces and
 * `' ’ . , -` kept (so no markup, no backtick, no `@`, `/`, `:` or brackets);
 * whitespace collapsed; at most NAME_MAX code points. Null when nothing is
 * left, or when what is left is link-shaped (two words joined by a dot) or
 * command-shaped (a flag), or would trip Hermes's scanner.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const plain = raw
    .normalize("NFKC")
    .replace(/[\r\n\t\u0085\u2028\u2029]/g, " ")
    .replace(INVISIBLE, "")
    .replace(NAME_DISALLOWED, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s'\u2019.,-]+|[\s,-]+$/gu, "")
    .trim();
  if (!plain || DOTTED_WORD.test(plain) || COMMAND_SHAPED.test(plain)) return null;
  const capped = codePointSlice(plain, NAME_MAX).trim();
  return capped && !cronScanHit(capped) ? capped : null;
}

/** Markup that could make a link, a fence or formatting in the delivered message. */
const MARKUP = /[`*_~|\\<>[\]{}#]/g;
/** A URL with a scheme, a `www.` address or an email address. */
const LINKS = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S*|\S+@\S+\.\S+/gi;

/**
 * Text from a schedule, an organiser or the resident's notes as one plain
 * line: NFKC-normalised; control and format characters removed; links,
 * addresses and markup characters (backticks included) removed; whitespace
 * collapsed; at most `max` code points (an ellipsis marks a cut). Null when
 * nothing is left or Hermes's scanner would block on it.
 */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const plain = raw
    .normalize("NFKC")
    .replace(/[\r\n\t\u0085\u2028\u2029]/g, " ")
    .replace(INVISIBLE, "")
    .replace(LINKS, " ")
    .replace(MARKUP, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  const cut = [...plain].length > max ? `${codePointSlice(plain, max - 1).trimEnd()}\u2026` : plain;
  return cronScanHit(cut) ? null : cut;
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
