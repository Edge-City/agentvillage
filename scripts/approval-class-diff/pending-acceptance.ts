#!/usr/bin/env bun
/**
 * B-167N fold 1 S2 (review-b's refute, CLAIMS L18667; lead RULING L18671): an
 * acceptance Carter has not dated yet must never turn main red and halt Tag release
 * (tag-release.yml's tag job needs a green test.yml), and must never let a new
 * limitation ship unaccepted.
 *
 * The rule: on a pull request the check runs as written, so a pending accepted_at
 * fails and the PR shows red. On main's push run and on a Tag release call
 * (AV_NEW_CALLS_PENDING_ACCEPTANCE=warn, set by test.yml for every event but
 * pull_request) the run may pass with a warning ONLY when ALL of these hold:
 * - every new-calls finding is the "awaiting acceptance: accepted_at" line of a
 *   LIMITING entry (accepted_by, reason and every other check still bind);
 * - each such entry's call is UNCHANGED since the previous release: it already
 *   ships, so the pending date limits nothing that is not already live (half A,
 *   B-167's class-diff, still blocks any regression of it); a NEW or CHANGED call
 *   with a pending acceptance fails everywhere;
 * - the check complained about nothing else: its stderr holds the new-calls line
 *   alone, the class-diff blocked nothing, and no tools line is newly shadowed.
 * Anything this cannot read is no waiver (fail closed).
 *
 * Usage: bun scripts/approval-class-diff/pending-acceptance.ts --json <class-diff.json> --stderr <the check's stderr>
 * Exit: 0 waived (prints ::warning:: lines), 1 not waivable, 2 usage.
 */
import { readFileSync } from "node:fs";

/**
 * The exact message approval.md's acceptanceErrorsN gives an undated accepted_at, under the
 * LIMITING label limitingReasons builds (overlay-recipes-newcalls.mjs, ce36c9d9: 161-171, 463):
 * the label holds no parenthesis, the date is a JSON string without escapes or null, and the
 * line ends where approval.md's does. B-167N fold 2 N-D1 (review-b's DELTA L18777): the fold 1
 * pattern, `\(.*\)` and no end anchor, also matched a WRONG accepted_by message whose JSON value
 * carried this text, and waived it. Anything else fails closed (no waiver).
 */
const PENDING = /^LIMITING \([^()]*\): awaiting acceptance: accepted_at (?:"[^"\\]*"|null) is not a YYYY-MM-DD date \(Carter fills it\)$/u;
const NEW_CALLS_LINE = /^\d+ new-calls finding\(s\) \(B-167N\)/u;

type Row = { key?: unknown; status?: unknown; entry?: unknown; blocks?: unknown };
type Finding = { key?: unknown; message?: unknown };

/** approval.md's keyLabel: a recipe key's NUL separator shown as ": ". */
const label = (key: unknown): string => String(key).replace("\u0000", ": ");

export function pendingOnly(doc: unknown, stderr: string): { ok: boolean; waived: string[]; why: string[] } {
  const why: string[] = [];
  const d = (doc ?? {}) as { summary?: { blocking?: unknown }; shadowed?: unknown; newCalls?: { rows?: unknown; findings?: unknown } };
  const rows = Array.isArray(d.newCalls?.rows) ? (d.newCalls.rows as Row[]) : null;
  const findings = Array.isArray(d.newCalls?.findings) ? (d.newCalls.findings as Finding[]) : null;
  if (rows === null || findings === null) return { ok: false, waived: [], why: ["the report has no new-calls section"] };
  if (findings.length === 0) why.push("no new-calls finding to waive: the check failed for another reason");
  if (typeof d.summary?.blocking !== "number" || d.summary.blocking !== 0) why.push("the class-diff blocked a call (or its summary is missing)");
  if (!Array.isArray(d.shadowed) || d.shadowed.length > 0) why.push("a tools line is newly shadowed (or the list is missing)");
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length !== 1 || !NEW_CALLS_LINE.test(lines[0] ?? "")) why.push(`the check complained about more than its new-calls findings: ${lines.filter((l) => !NEW_CALLS_LINE.test(l)).join(" | ").slice(0, 300) || "(no new-calls line)"}`);
  const waived = new Set<string>();
  for (const f of findings) {
    const message = String(f.message ?? "");
    const key = String(f.key ?? "");
    if (!PENDING.test(message)) {
      why.push(`${key}: ${message.slice(0, 200)} (not a pending accepted_at)`);
      continue;
    }
    const row = rows.find((r) => r.entry === true && label(r.key) === key);
    if (row === undefined) {
      why.push(`${key}: no declared row carries this finding`);
      continue;
    }
    if (row.status !== "unchanged") {
      why.push(`${key}: the call is ${String(row.status)} since the previous release; a new limitation never ships unaccepted`);
      continue;
    }
    const blocks = Array.isArray(row.blocks) ? row.blocks.map(String) : [];
    if (!blocks.includes(message) || blocks.some((b) => !PENDING.test(b))) {
      why.push(`${key}: the row carries other blocks`);
      continue;
    }
    waived.add(key);
  }
  return { ok: why.length === 0 && waived.size > 0, waived: [...waived].sort(), why };
}

function main(): void {
  const args = process.argv.slice(2);
  const val = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const jsonPath = val("--json");
  const errPath = val("--stderr");
  if (jsonPath === undefined || errPath === undefined) {
    process.stderr.write("usage: bun scripts/approval-class-diff/pending-acceptance.ts --json <class-diff.json> --stderr <the check's stderr>\n");
    process.exit(2);
  }
  let doc: unknown;
  let err: string;
  try {
    doc = JSON.parse(readFileSync(jsonPath, "utf8"));
    err = readFileSync(errPath, "utf8");
  } catch (error) {
    process.stdout.write(`pending-acceptance: not waivable, an input could not be read: ${String(error)}\n`);
    process.exit(1);
  }
  const r = pendingOnly(doc, err);
  if (!r.ok) {
    process.stdout.write(`pending-acceptance: not waivable: ${r.why.join("; ")}\n`);
    process.exit(1);
  }
  process.stdout.write("NEW-CALLS ACCEPTANCE PENDING (fails pull requests only; B-167N fold 1 S2): the only findings are an undated acceptance on calls unchanged since the previous release.\n\n");
  for (const k of r.waived) {
    process.stdout.write(`::warning::NEW-CALLS acceptance pending on ${k}: Carter fills accepted_at in the overlay's expected.json and in approval.md's pinned copy (PIN_EXPECTED); pull requests stay red until he does\n`);
  }
  process.exit(0);
}

if (import.meta.main) main();
