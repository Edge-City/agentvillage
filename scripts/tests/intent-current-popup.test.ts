/**
 * V1-LEAK (B): every prompt that files an Index intent says an intent is for THIS popup.
 *
 * A resident's agent filed an intent whose content was a preference from an earlier popup. The fix is a
 * short positive rule in every prompt path that files an intent: an intent is what the resident wants now,
 * at Edge City India (its place and dates), from what they said in this popup's conversations or their
 * current profile; never a plan, place or preference carried over from an earlier popup, older memory or an
 * earlier year; when unsure, ask (in conversation) or drop it (a background pass, which cannot ask).
 *
 * The rule never names an earlier popup or its town: naming one plants it (lanes-context BUG-esmeralda).
 * This file names none either: the denylist below is sha256 digests of lower-cased words.
 *
 * Pinned here:
 *   - each filing prompt (FILING) carries the popup, the source, the carry-over ban and the current-want
 *     example (OV499 S2: a want they have now that only mentions the past or runs past the popup still
 *     counts), the conversational ones the ask, the background one the drop; the record-intention skill
 *     also its background tail (OV499 N3);
 *   - the rule's sentences (from the one naming this popup to the end of the ask or drop sentence) use
 *     only RULE_VOCAB, case-insensitively, so no other word, a place or a popup, can slip in (OV499 N1);
 *   - no filing prompt, nor the record_intention module, holds a denylisted word anywhere, in any case
 *     (OFF_POPUP_WORD_SHA256: the previous popup's event, town and county, and its state) (OV499 N1);
 *   - discovery: every Markdown file the agent reads under skills/, workspace/ and mini-apps/ that names
 *     an intent filing tool is either in FILING or in NOT_FILING with its reason, so a new filing prompt
 *     fails here until it carries the rule;
 *   - every Index cron spec (and job template) whose prompt names an intent filing tool is in FILING.
 * The record_intention tool description (plugins/av-events/_record_intention.py CURRENT_POPUP_SHORT,
 * inside the 500 characters tool_search shows, and CURRENT_POPUP_RULE) is pinned word for word in
 * plugins/av-events/tests/test_intention_source.py.
 *
 * Limit (OV499 N2): discovery reads Markdown only. Plugin tool descriptions are Python strings and are
 * not scanned here; today the only one that files an intent is record_intention's, pinned in pytest. A
 * new plugin tool that files an intent must add its own pin.
 *
 *   bun test scripts/tests/intent-current-popup.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { DIGEST_CRON_SPECS, templateCronSpec } from "../../install/install_index";
import { RETIRED_SKILL_DIRS } from "../../install/paths";
import { TEMPLATE_NAMES } from "../../skills/index-network/scripts/job-settings";

const REPO = join(import.meta.dir, "..", "..");

/** The popup, word for word. */
export const POPUP = "Edge City India (Mandrem, Goa, October 11 to November 1, 2026)";
/** Never carry anything over, word for word (case-insensitive: a sentence may open with it). */
export const CARRY = "never carry over a plan, place or preference from an earlier popup, older memory or an earlier year";
/** Where the want comes from. */
export const FROM = "this popup's conversations";
/** In conversation: ask when unsure. */
export const ASK = "if you are not sure it is current, ask them before you record it";
/** In a background pass: drop when unsure. */
export const DROP = "if you are not sure it is current, drop it";
/** OV499 S2: a current want that mentions the past or runs past the popup still counts. */
export const EXAMPLE =
  "a want they have now still counts when it only mentions something from before or runs past the popup's end, " +
  "such as help finishing a project they began earlier or company for a trip after the popup";
/** OV499 N3: the skill's background tail. */
export const BACKGROUND_TAIL = "a background pass, which cannot ask, records nothing it is not sure of";

/**
 * Every word the rule's sentences may use, lower-cased (OV499 N1). A word outside it (a place, a popup,
 * anything) fails, whatever its case. Grow it only with words that name no place or popup.
 */
const RULE_VOCAB = new Set(
  `1 11 2026 a after an are as ask at background before began cannot carry city company conversations counts
  current did drop earlier edge either end even finishing for from goa goals have help hold if in india intention
  is it mandrem memory mentions never not notes nothing november now october of older only or over pass past place
  plan popup popup's preference profile project record records resident runs said signal something state stated
  still such sure that the their them they this to trip want wants way what when which year you your`.split(/\s+/),
);

/**
 * sha256 of each lower-cased word no filing prompt may hold, in any case, anywhere (OV499 N1): the
 * previous popup's event name, town and county, and its state. Digests, so this file names none of them.
 */
const OFF_POPUP_WORD_SHA256 = new Set([
  "978125aadb6c44cc1d9d43e5fd4f233e74b9e4832f9bcf9d0dd5af88e4473bb5",
  "c9f8e1dfb618233c251ab26fe8f022116500d95a5d4e6c12119aecbe97a5dd53",
  "434f6b0459e27050efa9be131947164566dccd3da72c9b958c2e714d8c3d382d",
  "7e8eea5cc60980270c9ceb75ce8c087d48d726110fd3d17921f774eefd8e18d8",
]);
/** Files beyond FILING that carry the rule and are scanned whole against the denylist. */
const ALSO_SCANNED = ["plugins/av-events/_record_intention.py"];

type Kind = "chat" | "background";

/** Every prompt path that files an intent, by repo path; `extra`: phrases that file must also carry. */
const FILING: Array<{ path: string; kind: Kind; why: string; extra?: string[] }> = [
  { path: "skills/index-network/tools.md", kind: "chat", why: "Capturing new signal: create_intent / record_intention in chat" },
  {
    path: "skills/record-intention/SKILL.md",
    kind: "chat",
    why: "the record_intention skill (chat, onboarding, background)",
    extra: [BACKGROUND_TAIL],
  },
  { path: "workspace/SOUL.md", kind: "chat", why: "the persona's create_intent / record_intention bullet, every session" },
  { path: "skills/index-network/prompts/memory-signals.md", kind: "background", why: "the 01:00 memory signal sync cron (DATA-361/470)" },
];

/** Files that name an intent filing tool without being a filing prompt, each with its reason. */
const NOT_FILING: Record<string, string> = {
  "workspace/AGENTS.md":
    "Carter edits it (the lane brief): its Intentions bullet and REFUSED_SEEDS line file intents; the proposed diff is in the V1-LEAK (B) report",
  "skills/approval/templates/APPROVAL.md": "a routing table the approval daemon reads, not a prompt",
  "skills/approval/README.md": "describes that routing table for humans",
  "skills/README.md": "the skills index for humans",
};

/** A filing tool named in prose or code. */
const FILING_TOOL = /create_intent|record_intention|update_intent/;

function flat(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function read(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

/** Every Markdown file under `dir` (repo-relative), the synced references and retired skills excluded. */
function markdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (name === "node_modules" || name === "tests") continue;
      const child = join(abs, name);
      const rel = relative(REPO, child);
      if (rel.split("/").includes("references")) continue;
      if (RETIRED_SKILL_DIRS.some((d) => rel === `skills/${d}` || rel.startsWith(`skills/${d}/`))) continue;
      if (statSync(child).isDirectory()) walk(child);
      else if (name.endsWith(".md")) out.push(rel);
    }
  };
  if (existsSync(join(REPO, dir))) walk(join(REPO, dir));
  return out.sort();
}

/** A file's paragraphs and list items, each flattened (a list item ends where the next one starts). */
function items(raw: string): string[] {
  const out: string[] = [];
  for (const block of raw.split(/\n[ \t]*\n/)) {
    let current: string[] = [];
    for (const line of block.split("\n")) {
      if (/^\s*(?:- |\d+\. )/.test(line) && current.length) {
        out.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    if (current.length) out.push(current.join("\n"));
  }
  return out.map(flat);
}

/**
 * The rule's sentences in `raw`: in the paragraph or list item that carries the carry-over ban, from the
 * sentence that first names this popup to the end of the sentence holding the ask (or the drop), its tail
 * included. Empty when there is none.
 */
function ruleSpan(raw: string, kind: Kind): string {
  const item = items(raw).find((i) => i.toLowerCase().includes(CARRY)) ?? "";
  const lower = item.toLowerCase();
  const at = lower.indexOf("this popup");
  const tail = lower.indexOf(kind === "chat" ? ASK : DROP);
  if (at < 0 || tail < 0) return "";
  const openers = [". ", ": ", "- "].map((m) => item.lastIndexOf(m, at)).filter((i) => i >= 0);
  const start = openers.length ? Math.max(...openers) + 2 : 0;
  const stop = item.indexOf(".", tail);
  return item.slice(start, stop < 0 ? item.length : stop + 1);
}

const sha256 = (word: string) => createHash("sha256").update(word, "utf8").digest("hex");

/** Every word of `text`, lower-cased with accents folded. */
function wordsOf(text: string): string[] {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

describe("V1-LEAK (B): every intent-filing prompt says an intent is for this popup", () => {
  for (const { path, kind, why } of FILING) {
    test(`${path} (${why}) carries the rule`, () => {
      const text = flat(read(path));
      const lower = text.toLowerCase();
      expect({ path, popup: text.includes(POPUP) }).toEqual({ path, popup: true });
      expect({ path, carry: lower.includes(CARRY) }).toEqual({ path, carry: true });
      expect({ path, from: lower.includes(FROM) }).toEqual({ path, from: true });
      const tail = kind === "chat" ? ASK : DROP;
      expect({ path, tail: lower.includes(tail) }).toEqual({ path, tail: true });
      expect({ path, example: lower.includes(EXAMPLE) }).toEqual({ path, example: true });
      for (const phrase of FILING.find((f) => f.path === path)?.extra ?? []) {
        expect({ path, phrase, found: lower.includes(phrase) }).toEqual({ path, phrase, found: true });
      }
      // A background pass never messages the resident: it drops, it never asks.
      if (kind === "background") expect(lower).not.toContain(ASK);
      // Once per file: a second copy is drift waiting to happen.
      expect({ path, copies: lower.split(CARRY).length - 1 }).toEqual({ path, copies: 1 });
    });
  }

  test("the rule's sentences use only the rule's own words, in any case (no place, no popup)", () => {
    for (const { path, kind } of FILING) {
      const span = ruleSpan(read(path), kind);
      expect({ path, found: span.length > 0 }).toEqual({ path, found: true });
      const stray = wordsOf(span).filter((w) => !RULE_VOCAB.has(w));
      expect({ path, stray }).toEqual({ path, stray: [] });
    }
  });

  test("no filing prompt, nor the record_intention module, holds a denylisted word anywhere, in any case", () => {
    for (const path of [...FILING.map((f) => f.path), ...ALSO_SCANNED]) {
      const hits = wordsOf(read(path)).filter((w) => OFF_POPUP_WORD_SHA256.has(sha256(w))).length;
      expect({ path, hits }).toEqual({ path, hits: 0 });
    }
    // The denylist is live: four distinct digests, each of a lower-case word (64 hex characters).
    expect(OFF_POPUP_WORD_SHA256.size).toBe(4);
    for (const d of OFF_POPUP_WORD_SHA256) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  test("discovery: every Markdown prompt naming a filing tool is a filing prompt or listed with its reason", () => {
    const filing = new Set(FILING.map((f) => f.path));
    const unlisted: string[] = [];
    const seen = new Set<string>();
    for (const path of [...markdown("skills"), ...markdown("workspace"), ...markdown("mini-apps")]) {
      if (!FILING_TOOL.test(read(path))) continue;
      seen.add(path);
      if (!filing.has(path) && !(path in NOT_FILING)) unlisted.push(path);
    }
    expect(unlisted).toEqual([]);
    // No stale entries: each listed file exists and still names a filing tool.
    for (const path of [...filing, ...Object.keys(NOT_FILING)]) expect({ path, seen: seen.has(path) }).toEqual({ path, seen: true });
  });

  test("every Index cron (and job template) whose prompt names a filing tool is a filing prompt", () => {
    const filing = new Set(FILING.map((f) => f.path));
    const specs = [...DIGEST_CRON_SPECS, ...TEMPLATE_NAMES.map((t) => templateCronSpec(t, "0 9 * * *"))];
    const filers: string[] = [];
    for (const spec of specs) {
      const body = spec.promptFile ? read(join("skills", spec.promptFile)) : (spec.promptBody ?? "");
      if (!FILING_TOOL.test(body)) continue;
      const path = spec.promptFile ? `skills/${spec.promptFile}` : `${spec.name} (inline promptBody)`;
      filers.push(path);
      expect({ path, filing: filing.has(path) }).toEqual({ path, filing: true });
    }
    // Today exactly one cron files intents: the nightly memory signal sync.
    expect([...new Set(filers)]).toEqual(["skills/index-network/prompts/memory-signals.md"]);
  });
});
