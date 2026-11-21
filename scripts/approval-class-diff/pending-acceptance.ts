#!/usr/bin/env bun
/**
 * B-167N fold 1 S2 (the review's refute and its ruling): an
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
 * Review S1 (approval.md 412365ad): a propose-only entry declares a daemon propose behind no hooked
 * call; its row key is `propose#<file>:<line>#<class>`. The check calls such a row unchanged when a
 * site in that file with that class existed at the previous release, and does not compare the answers
 * the code goes on with. So for these rows the waiver asks the same question of the site itself: in
 * this tree's corpus and in the previous release's, the file holds the same number of propose sites
 * of that class going on with the same accepted answers, and the row's own line is one of them. Without
 * both corpora, or with any difference, a propose-only row is no waiver (fail closed).
 *
 * Review S1b (approval.md dc37d7c3): which class a held entry gets is decided by its class writers, the
 * corpus's `class_writers` (file, function, class; line only reported). The site is unchanged only if
 * the writers of its class are too: the same file and function filing that class in both corpora, and
 * no writer of the site's plugin unread in either. A corpus with no class_writers list is no waiver.
 *
 * Usage: bun scripts/approval-class-diff/pending-acceptance.ts --json <class-diff.json> --stderr <the check's stderr>
 *          [--head-corpus <this tree's corpus.json> --tag-corpus <the previous release's corpus.json>]
 * Exit: 0 waived (prints ::warning:: lines), 1 not waivable, 2 usage.
 */
import { readFileSync } from "node:fs";

/**
 * The exact message approval.md's acceptanceErrorsN gives an undated accepted_at, under the
 * LIMITING label limitingReasons builds (overlay-recipes-newcalls.mjs, ce36c9d9: 161-171, 463):
 * the label holds no parenthesis, the date is a JSON string without escapes or null, and the
 * line ends where approval.md's does. B-167N fold 2 N-D1 (the review's delta): the fold 1
 * pattern, `\(.*\)` and no end anchor, also matched a WRONG accepted_by message whose JSON value
 * carried this text, and waived it. Anything else fails closed (no waiver).
 */
const PENDING = /^LIMITING \([^()]*\): awaiting acceptance: accepted_at (?:"[^"\\]*"|null) is not a YYYY-MM-DD date \(Carter fills it\)$/u;
const NEW_CALLS_LINE = /^\d+ new-calls finding\(s\) \(B-167N\)/u;

type Row = { key?: unknown; kind?: unknown; status?: unknown; entry?: unknown; blocks?: unknown };
type Site = { plugin?: unknown; file?: unknown; line?: unknown; class?: unknown; classes?: unknown; accepts?: unknown };
type Writer = { plugin?: unknown; file?: unknown; function?: unknown; class?: unknown };
/** The two corpora (each extractor output's `proposes`), for a propose-only row. */
export type Corpora = { head: unknown; tag: unknown } | null;

const sitesOf = (corpus: unknown): Site[] | null => {
  const p = (corpus as { proposes?: unknown } | null)?.proposes;
  return Array.isArray(p) ? (p as Site[]) : null;
};
const writersOf = (corpus: unknown): Writer[] | null => {
  const w = (corpus as { class_writers?: unknown } | null)?.class_writers;
  return Array.isArray(w) ? (w as Writer[]) : null;
};
const carries = (s: Site, cls: string): boolean => s.class === cls || (Array.isArray(s.classes) && (s.classes as unknown[]).includes(cls));
const answers = (s: Site): string | null => (Array.isArray(s.accepts) && (s.accepts as unknown[]).every((a) => typeof a === "string") ? JSON.stringify([...(s.accepts as string[])].sort()) : null);

/**
 * A propose-only row's site is unchanged since the previous release: its own line holds a propose of
 * its class whose answers can be read, and the file holds as many sites of that class with those
 * answers at the release as now. Returns the reason it is not, or null.
 */
export function proposeSiteChanged(key: string, corpora: Corpora): string | null {
  const m = key.match(/^propose#(.+):(\d+)#([^#]+)$/u);
  if (m === null) return `a propose row key not of the form propose#<file>:<line>#<class>: ${key}`;
  const [, file, line, cls] = m as unknown as [string, string, string, string];
  if (corpora === null) return "a propose-only row is judged unchanged only against both corpora, and none was given (fail closed)";
  const head = sitesOf(corpora.head);
  const tag = sitesOf(corpora.tag);
  if (head === null || tag === null) return "a corpus without its proposes list (fail closed)";
  const own = head.filter((s) => s.file === file && Number(s.line) === Number(line) && carries(s, cls));
  if (own.length !== 1) return `${file}:${line} holds ${String(own.length)} propose site(s) of ${cls} in this tree's corpus, not one`;
  const want = answers(own[0]!);
  if (want === null) return `the answers the code goes on with after ${file}:${line} cannot be read (fail closed)`;
  const like = (sites: Site[]) => sites.filter((s) => s.file === file && carries(s, cls) && answers(s) === want).length;
  if (like(tag) === 0 || like(tag) !== like(head)) {
    return `${file} has ${String(like(head))} propose site(s) of ${cls} going on with ${want} now and ${String(like(tag))} at the previous release: the site changed (file, class or accepted answers)`;
  }
  const headWriters = writersOf(corpora.head);
  const tagWriters = writersOf(corpora.tag);
  if (headWriters === null || tagWriters === null) return "a corpus without its class_writers list, so the class this site's entries get cannot be judged unchanged (fail closed)";
  const plugin = own[0]!.plugin;
  const unread = (ws: Writer[]) => ws.some((w) => w.plugin === plugin && typeof w.class !== "string");
  if (unread(headWriters) || unread(tagWriters)) return `a class writer of plugin ${String(plugin)} cannot be read in ${unread(headWriters) ? "this tree" : "the previous release"} (fail closed)`;
  const filing = (ws: Writer[]) => [...new Set(ws.filter((w) => w.class === cls).map((w) => `${String(w.file)} ${String(w.function)}`))].sort();
  const now = filing(headWriters);
  const then = filing(tagWriters);
  if (JSON.stringify(now) !== JSON.stringify(then)) {
    return `the class writers of ${cls} changed since the previous release (now ${now.join(", ") || "none"}; then ${then.join(", ") || "none"})`;
  }
  return null;
}
type Finding = { key?: unknown; message?: unknown };

/** approval.md's keyLabel: a recipe key's NUL separator shown as ": ". */
const label = (key: unknown): string => String(key).replace("\u0000", ": ");

export function pendingOnly(doc: unknown, stderr: string, corpora: Corpora = null): { ok: boolean; waived: string[]; why: string[] } {
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
    if (row.kind === "propose" || key.startsWith("propose#")) {
      const changed = proposeSiteChanged(key, corpora);
      if (changed !== null) {
        why.push(`${key}: ${changed}`);
        continue;
      }
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
  const headCorpus = val("--head-corpus");
  const tagCorpus = val("--tag-corpus");
  if (jsonPath === undefined || errPath === undefined) {
    process.stderr.write("usage: bun scripts/approval-class-diff/pending-acceptance.ts --json <class-diff.json> --stderr <the check's stderr>\n");
    process.exit(2);
  }
  let doc: unknown;
  let err: string;
  let corpora: Corpora = null;
  try {
    doc = JSON.parse(readFileSync(jsonPath, "utf8"));
    err = readFileSync(errPath, "utf8");
    if (headCorpus !== undefined && tagCorpus !== undefined) corpora = { head: JSON.parse(readFileSync(headCorpus, "utf8")), tag: JSON.parse(readFileSync(tagCorpus, "utf8")) };
  } catch (error) {
    process.stdout.write(`pending-acceptance: not waivable, an input could not be read: ${String(error)}\n`);
    process.exit(1);
  }
  const r = pendingOnly(doc, err, corpora);
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
