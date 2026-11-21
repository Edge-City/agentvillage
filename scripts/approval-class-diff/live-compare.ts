#!/usr/bin/env bun
/**
 * B-167N LIVE PROTOCOL (P7): compare the hook decision lines read on the
 * canary box with expected.json, mechanically.
 *
 * Before a tag that adds a capability, Carter's canary box runs the CANDIDATE
 * tag (onebox to the candidate first, never the fleet tag), and each new
 * capability runs once end to end. review-a reads the hook's decision for each
 * call and writes one line per call in the pinned format
 *
 *   class | decision | card_style | core version | tool/command key
 *
 * - class: the class the hook (or the daemon propose) named;
 * - decision: auto | sampled | card | human-only | refused;
 * - card_style: minimal | technical | none (no card);
 * - core version: the approval.md core the box runs (it must be the candidate's);
 * - key: the recipe's command, the envelope key (`village#forkicks.order.confirm`),
 *   or a propose's action key (`marketplace.app.action:forkicks.order.confirm:<draftId>`;
 *   the draft id is the live one, so a propose key is matched up to its last colon).
 *
 * Usage: bun scripts/approval-class-diff/live-compare.ts --lines <file> --core <version>
 *          [--expected <path>] [--report <class-diff.json>] [--require <key>]...
 * What the canary must cover is named, never assumed (B-167N fold 1 N4):
 * `--report` (the class-diff job's class-diff.json for the candidate) requires a
 * line for every NEW or CHANGED declared call and its propose; `--require` adds
 * a key. Naming neither is a usage error, and a lines file with no decision line
 * fails.
 * Exit: 0 every line matches its entry (and every required call has a line),
 *       1 a mismatch, an unknown key, a wrong core, a missing required line or no
 *       line at all, 2 usage or an unreadable input.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Layer = { class: string; decision: string; card_style?: string | null };
type Entry = Layer & { file?: string; command?: string; tool?: string; input?: Record<string, unknown>; propose?: Layer & { key: string } };

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * approval.md's envelopeKey (scripts/overlay-recipes-box.mjs `envelopeKey` /
 * `KEY_PARTS`), the same rule (B-167N fold 1 N4): each part a string of a closed
 * character set that excludes the separators after it, so no two calls share a
 * key; a part outside its set, or present but not a string, gives no key (null),
 * and an entry with no key never matches a line.
 */
const KEY_PARTS: [string, RegExp][] = [
  ["tool", /^[A-Za-z0-9_-]{1,128}$/u],
  ["operation", /^[A-Za-z0-9_.-]{1,128}$/u],
  ["appId", /^[A-Za-z0-9_-]{1,128}$/u],
  ["tool", /^[A-Za-z0-9_-]{1,128}$/u],
];
export function envelopeKey(tool: unknown, input: Record<string, unknown> = {}): string | null {
  const i = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  const values = [tool, i.operation, i.appId, i.tool];
  const bad = KEY_PARTS.some(([, re], n) => !(n > 0 && values[n] === undefined) && (typeof values[n] !== "string" || !re.test(values[n] as string)));
  if (bad) return null;
  let key = String(tool);
  if (i.operation !== undefined) key += `#${String(i.operation)}`;
  if (i.appId !== undefined) key += `:${String(i.appId)}`;
  if (i.tool !== undefined) key += `.${String(i.tool)}`;
  return key;
}

const proposeStem = (key: string): string => key.slice(0, key.lastIndexOf(":") + 1);

export interface LineResult {
  line: string;
  key: string;
  ok: boolean;
  why: string[];
}

/** Compare parsed lines with the entries. Pure. */
export function compare(entries: Entry[], text: string, core: string): LineResult[] {
  const out: LineResult[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 5) {
      out.push({ line, key: "", ok: false, why: ["not the pinned 5-field format: class | decision | card_style | core version | tool/command key"] });
      continue;
    }
    const [cls, decision, style, version, key] = parts as [string, string, string, string, string];
    const why: string[] = [];
    if (version !== core) why.push(`core ${version}, not the candidate's ${core} (the canary must run the candidate tag)`);
    let layer: Layer | undefined;
    for (const e of entries) {
      if (e.command !== undefined && norm(e.command) === norm(key)) layer = e;
      else if (e.tool !== undefined && envelopeKey(e.tool, e.input) !== null && envelopeKey(e.tool, e.input) === key) layer = e;
      else if (e.propose !== undefined && proposeStem(e.propose.key) !== "" && key.startsWith(proposeStem(e.propose.key)) && key.length > proposeStem(e.propose.key).length) layer = e.propose;
      if (layer !== undefined) break;
    }
    if (layer === undefined) {
      out.push({ line, key, ok: false, why: [...why, "no expected.json entry has this key (an undeclared call is a block)"] });
      continue;
    }
    if (cls !== layer.class) why.push(`class ${cls}, declared ${layer.class}`);
    const deny = layer.decision === "deny" && (decision === "human-only" || decision === "refused");
    if (decision !== layer.decision && !deny) why.push(`decision ${decision}, declared ${layer.decision}`);
    const carded = decision === "card" || decision === "sampled";
    if (carded && style !== "minimal") why.push(`card ${style}, not minimal`);
    if (!carded && style !== "none") why.push(`card_style ${style} on a call that showed no card`);
    out.push({ line, key, ok: why.length === 0, why });
  }
  return out;
}

/** A call the canary must have run: a label, and the test a live line's key must pass. */
export interface Required {
  label: string;
  covers: (key: string) => boolean;
}

/**
 * The calls a class-diff report says are NEW or CHANGED and declared (its
 * newCalls rows), each with its propose when the entry has one (N4).
 */
export function requiredFromReport(entries: Entry[], report: unknown): Required[] {
  const rows = (report as { newCalls?: { rows?: unknown } })?.newCalls?.rows;
  if (!Array.isArray(rows)) throw new Error("the report has no newCalls rows");
  const out: Required[] = [];
  for (const r of rows as { key?: unknown; kind?: unknown; status?: unknown; entry?: unknown }[]) {
    if (r.entry !== true || r.status === "unchanged") continue;
    const key = String(r.key);
    if (r.kind === "recipe") {
      const command = key.slice(key.indexOf("\u0000") + 1);
      out.push({ label: command, covers: (k) => norm(k) === norm(command) });
      continue;
    }
    out.push({ label: key, covers: (k) => k === key });
    const entry = entries.find((e) => e.tool !== undefined && envelopeKey(e.tool, e.input) === key);
    if (entry?.propose !== undefined) {
      const stem = proposeStem(entry.propose.key);
      out.push({ label: `${stem}<draft>`, covers: (k) => stem !== "" && k.startsWith(stem) && k.length > stem.length });
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const val = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const linesPath = val("--lines");
  const core = val("--core");
  const reportPath = val("--report");
  const requiredKeys = args.flatMap((a, i) => (a === "--require" && args[i + 1] !== undefined ? [args[i + 1]!] : []));
  if (linesPath === undefined || core === undefined || (reportPath === undefined && requiredKeys.length === 0)) {
    process.stderr.write(
      "usage: bun scripts/approval-class-diff/live-compare.ts --lines <file> --core <version> [--expected <path>] (--report <class-diff.json> | --require <key>)...\n" +
        "  name what the canary must cover: --report requires every NEW or CHANGED declared call, --require adds a key\n",
    );
    process.exit(2);
  }
  let entries: Entry[];
  let text: string;
  let required: Required[];
  try {
    entries = (JSON.parse(readFileSync(val("--expected") ?? join(import.meta.dir, "expected.json"), "utf8")) as { entries: Entry[] }).entries;
    text = readFileSync(linesPath, "utf8");
    required = [
      ...(reportPath === undefined ? [] : requiredFromReport(entries, JSON.parse(readFileSync(reportPath, "utf8")))),
      ...requiredKeys.map((k) => ({ label: k, covers: (key: string) => key === k })),
    ];
  } catch (error) {
    process.stderr.write(`live-compare: ${String(error)}\n`);
    process.exit(2);
  }
  const results = compare(entries, text, core);
  let bad = results.some((r) => !r.ok);
  for (const r of results) process.stdout.write(`${r.ok ? "MATCH " : "BLOCK "} ${r.line}${r.ok ? "" : `\n        ${r.why.join("; ")}`}\n`);
  if (results.length === 0) {
    bad = true;
    process.stdout.write("BLOCK  (no live line) the lines file holds no decision line: nothing was read from the canary\n");
  }
  for (const q of required) {
    if (!results.some((r) => q.covers(r.key))) {
      bad = true;
      process.stdout.write(`BLOCK  (no live line) ${q.label}: the canary did not run this new capability\n`);
    }
  }
  process.stdout.write(`live-compare: ${String(results.filter((r) => r.ok).length)} of ${String(results.length)} line(s) match expected.json at core ${core}; ${String(required.length)} call(s) required\n`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.main) main();
