/**
 * DATA-312: every agent-facing instruction that has the agent run a script or
 * a recipe through Hermes's `terminal` tool says, next to the command, to call
 * it with exactly `command` and nothing else, and the standing instructions
 * (AGENTS.md, SOUL.md) carry the same rule.
 *
 * Why: Hermes (v0.21.5, release 2026.9.24) rejects a foreground `terminal`
 * call that carries `notify`, `heartbeat`, `watch_patterns`,
 * `notify_on_complete` or `pty` ("notify/heartbeat only apply to background
 * commands ..."), before anything runs. Since 2026-10-02 the fleet model fills
 * `notify`/`heartbeat` on every script run, so every script-driven scheduled
 * job failed.
 *
 * The list of files is derived from the files themselves: every Markdown file
 * an agent reads under skills/ (references included) and workspace/, plus the
 * inline cron prompt bodies in install/install_index.ts, which are checked as
 * plain text. A script run (a fenced block, or an inline imperative such as
 * "Run `bun skills/…`") must have the rule within WINDOW lines; a scheduled
 * job's rule must also end the turn silently when the retry fails. A fenced
 * `curl` or `npx` recipe needs the rule somewhere in its file.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { DIGEST_CRON_SPECS } from "../../install/install_index";

const REPO = join(import.meta.dir, "..", "..");
/** How far (in lines) the rule may sit from a script run. */
const WINDOW = 5;
/** The arguments the rule names everywhere (the ones the schema advertises). */
const NAMED = ["notify", "heartbeat", "background"];
/** All of Hermes's background-only arguments; the AGENTS.md standing paragraph names every one. */
const BACKGROUND_ONLY = ["notify", "heartbeat", "background", "watch_patterns", "notify_on_complete", "pty"];
/** Files under skills/ that document the overlay for people, not for the agent. */
const NOT_AGENT_FACING = new Set(["README.md", "CLAUDE.md"]);

interface Doc {
  /** Repo-relative path, or `install/install_index.ts#<cron name>` for an inline prompt. */
  name: string;
  text: string;
  /** A scheduled job's prompt (a cron promptFile or promptBody). */
  cron: boolean;
  /** An inline promptBody: checked as plain text, any named script run counts. */
  plain: boolean;
}

interface Run {
  /** 0-based first and last line of the run (a fence, or the one line of an inline run). */
  from: number;
  to: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "tests" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".md") && !NOT_AGENT_FACING.has(entry)) out.push(path);
  }
  return out;
}

/** Every instruction text an agent reads: skill, prompt and reference Markdown, workspace files, inline cron prompts. */
function agentFacingDocs(root = REPO): Doc[] {
  const cronFiles = new Set(DIGEST_CRON_SPECS.flatMap((spec) => (spec.promptFile ? [`skills/${spec.promptFile}`] : [])));
  const files = [...walk(join(root, "skills")), ...walk(join(root, "workspace"))];
  const docs: Doc[] = files.map((path) => {
    const name = relative(root, path);
    return { name, text: readFileSync(path, "utf8"), cron: cronFiles.has(name), plain: false };
  });
  for (const spec of DIGEST_CRON_SPECS) {
    if (spec.promptBody !== undefined) {
      docs.push({ name: `install/install_index.ts#${spec.name}`, text: spec.promptBody, cron: true, plain: true });
    }
  }
  return docs;
}

function fences(text: string): { open: number; close: number; body: string }[] {
  const lines = text.split("\n");
  const out: { open: number; close: number; body: string }[] = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```/.test(lines[i])) continue;
    if (open < 0) {
      open = i;
    } else {
      out.push({ open, close: i, body: lines.slice(open + 1, i).join("\n") });
      open = -1;
    }
  }
  return out;
}

/**
 * A script the agent runs through `terminal`: `bun x.ts`, `bun run x.ts`,
 * `python3 x.py`, `node x.mjs`, `bash x.sh`, `sh x.sh`, also after a pipe.
 */
const SCRIPT_RUN =
  /(?:^|[|&;(]\s*|\s)(?:bun(?:\s+run)?|python3?|node|bash|sh|deno\s+run|npx\s+tsx|tsx)\s+(?:-\S+\s+)*\S+\.(?:ts|mts|js|mjs|cjs|py|sh)\b/m;
/** An inline imperative naming a script run: "Run `bun skills/…`", "Always call `python3 …`". */
const INLINE_RUN = /\b(?:run|call|execute|invoke|start)\b[^`\n]{0,60}`([^`\n]+)`/gi;
/** In plain prompt text: an imperative and a script file name in the same line. */
const PLAIN_IMPERATIVE = /\b(?:run|call|execute|invoke|start)\b/i;
const SCRIPT_FILE = /\S+\.(?:ts|mts|js|mjs|cjs|py|sh)\b/;
/** A CLI recipe the agent runs through `terminal`. */
const CLI_RUN = /^\s*(?:curl|npx)\s/m;

/** Every script run in a document, fenced or inline. */
function runsIn(doc: Doc): Run[] {
  const runs: Run[] = [];
  const lines = doc.text.split("\n");
  if (doc.plain) {
    lines.forEach((line, i) => {
      if (SCRIPT_RUN.test(line) || (PLAIN_IMPERATIVE.test(line) && SCRIPT_FILE.test(line))) runs.push({ from: i, to: i });
    });
    return runs;
  }
  const fenced = fences(doc.text);
  for (const fence of fenced) {
    if (SCRIPT_RUN.test(fence.body)) runs.push({ from: fence.open, to: fence.close });
  }
  const insideFence = (i: number) => fenced.some((f) => i >= f.open && i <= f.close);
  lines.forEach((line, i) => {
    if (insideFence(i)) return;
    for (const m of line.matchAll(INLINE_RUN)) {
      if (SCRIPT_RUN.test(` ${m[1]}`)) {
        runs.push({ from: i, to: i });
        break;
      }
    }
  });
  return runs;
}

const sentences = (text: string) => text.replace(/\s+/g, " ").split(/(?<=[.!?:;])\s/);

/**
 * A sentence that invites passing a background-only argument ("Pass `notify`
 * if…", "You may add `heartbeat`"). A sentence that negates it, or that pairs
 * it with `background=true` (the resident-requested background job), is fine.
 */
const INVITE = new RegExp(
  String.raw`\b(?:pass|add|set|use|include|supply|enable|turn on)\s+(?:the\s+|a\s+)?\x60?(?:` +
    BACKGROUND_ONLY.filter((a) => a !== "background").join("|") +
    String.raw`)\b`,
  "i",
);
const NEGATION = /\b(?:not|never|don't|without|no)\b/i;
const PAIRED_WITH_BACKGROUND = /\bbackground\x60?\s*[=:]\s*\x60?true\b/i;

function invitations(text: string): string[] {
  return sentences(text).filter((s) => INVITE.test(s) && !NEGATION.test(s) && !PAIRED_WITH_BACKGROUND.test(s));
}

/**
 * The rule, in any document's voice: `terminal` with exactly `command` and
 * nothing else; a "Do not add" list naming `notify`, `heartbeat` and
 * `background` (all six in `full` mode); the single retry after an error about
 * background commands (ending the turn silently when `silent`); and nothing
 * that invites one of those arguments.
 */
function carriesRule(text: string, { full = false, silent = false } = {}): boolean {
  const flat = text.replace(/\s+/g, " ");
  if (!flat.includes("`terminal`") || !/exactly `command`.{0,80}nothing else/.test(flat)) return false;
  const list = flat.match(/Do not add ([^.:;]*)/);
  const names = full ? BACKGROUND_ONLY : NAMED;
  if (!list || !names.every((arg) => list[1].includes(`\x60${arg}\x60`))) return false;
  if (!/error about background commands.{0,80}once more without those arguments/.test(flat)) return false;
  if (silent && !/once more without those arguments, and if that fails too, end your turn with /.test(flat)) return false;
  return invitations(flat).length === 0;
}

function windowAround(doc: Doc, run: Run): string {
  if (doc.plain) return doc.text;
  const lines = doc.text.split("\n");
  return lines.slice(Math.max(0, run.from - WINDOW), run.to + WINDOW + 1).join("\n");
}

/** Each script run, with whether the rule sits next to it. */
function scriptRuns(all: Doc[]): { doc: string; line: number; ruled: boolean }[] {
  return all.flatMap((doc) =>
    runsIn(doc).map((run) => ({
      doc: doc.name,
      line: run.from + 1,
      ruled: carriesRule(windowAround(doc, run), { silent: doc.cron }),
    })),
  );
}

/**
 * Each document with a fenced curl/npx recipe, with whether it carries the
 * rule. A file under a skill's references/ is reached through that skill's
 * SKILL.md, so the rule there covers it.
 */
function recipeDocs(all: Doc[]): { doc: string; ruled: boolean }[] {
  const skillOf = (name: string) => name.match(/^(skills\/[^/]+)\/references\//)?.[1];
  return all
    .filter((doc) => fences(doc.text).some((fence) => CLI_RUN.test(fence.body)))
    .map((doc) => {
      const skill = skillOf(doc.name);
      const parent = skill ? all.find((d) => d.name === `${skill}/SKILL.md`) : undefined;
      return { doc: doc.name, ruled: carriesRule(doc.text) || (parent !== undefined && carriesRule(parent.text)) };
    });
}

/**
 * An example call that would teach the agent a failing or harmful shape: a
 * `terminal(…)` call or a JSON argument object with a background-only argument
 * and no `background=true`, or one that runs a script in the background. A
 * documented background job (`background=true` with `notify`) is allowed.
 */
function exampleCalls(all: Doc[]): { doc: string; match: string }[] {
  const out: { doc: string; match: string }[] = [];
  const others = BACKGROUND_ONLY.filter((a) => a !== "background").join("|");
  const extra = new RegExp(String.raw`["']?\b(?:${others})\b["']?\s*[=:]`);
  const bgTrue = /["']?\bbackground\b["']?\s*[=:]\s*(?:true|True)\b/;
  for (const doc of all) {
    const spans = [
      ...doc.text.matchAll(/\bterminal\s*\(([^)]*)\)/g),
      ...doc.text.matchAll(/\{[^{}]*["']command["'][^{}]*\}/g),
    ].map((m) => m[0]);
    for (const span of spans) {
      const background = bgTrue.test(span);
      if ((extra.test(span) && !background) || (background && SCRIPT_RUN.test(span.replace(/["'=:,]/g, " ")))) {
        out.push({ doc: doc.name, match: span });
      }
    }
  }
  return out;
}

const docs = agentFacingDocs();
const byName = (name: string) => docs.find((doc) => doc.name === name);

describe("terminal: exactly the command (DATA-312)", () => {
  test("the enumeration is derived from the files and finds every cron prompt that runs a script", () => {
    const files = new Set(scriptRuns(docs).map((run) => run.doc));
    const cronPromptsWithScripts = docs.filter(
      (doc) => doc.cron && !doc.plain && fences(doc.text).some((f) => SCRIPT_RUN.test(f.body)),
    );
    // The digest prepare/send, negotiation summary, evening questions and the
    // opportunity drop all run a Bun script from their prompt.
    expect(cronPromptsWithScripts.length).toBeGreaterThanOrEqual(5);
    for (const doc of cronPromptsWithScripts) expect(files.has(doc.name)).toBe(true);
    // The inline cron prompts and the references are scanned too.
    expect(docs.some((doc) => doc.plain)).toBe(true);
    expect(docs.some((doc) => doc.name.includes("/references/"))).toBe(true);
  });

  test("every script run has the rule next to it, and a scheduled job's rule ends the turn silently", () => {
    const missing = scriptRuns(docs).filter((run) => !run.ruled).map((run) => `${run.doc}:${run.line}`);
    expect(missing).toEqual([]);
  });

  test("every file with a curl or npx recipe carries the rule", () => {
    const recipes = recipeDocs(docs);
    expect(recipes.map((r) => r.doc)).toContain("skills/edgeos/SKILL.md");
    expect(recipes.filter((r) => !r.ruled).map((r) => r.doc)).toEqual([]);
  });

  test("the standing instructions carry the rule, agree on timeout, and leave a resident's background job allowed", () => {
    for (const name of ["workspace/AGENTS.md", "workspace/SOUL.md"]) {
      const doc = byName(name);
      expect(doc).toBeDefined();
      expect(carriesRule(doc!.text, { full: name === "workspace/AGENTS.md" })).toBe(true);
      expect(doc!.text.replace(/\s+/g, " ")).toContain("a `timeout` where a prompt gives one");
      // One sentence keeps the background route open for a long job the resident asks for.
      expect(
        sentences(doc!.text).some((s) => /\bresident\b/.test(s) && /\blong job\b/.test(s) && /\bbackground\b/.test(s)),
      ).toBe(true);
    }
  });

  test("nothing an agent reads invites passing a background-only argument", () => {
    const found = docs.flatMap((doc) => invitations(doc.text).map((s) => `${doc.name}: ${s}`));
    expect(found).toEqual([]);
  });

  test("no instruction shows an example terminal call that a foreground run would fail on", () => {
    expect(exampleCalls(docs)).toEqual([]);
  });

  test("the checks catch weakened wording and new shapes, and allow a documented background job", () => {
    const rule =
      "Call `terminal` with exactly `command` and nothing else. Do not add `notify`, `heartbeat` or `background`: " +
      "it finishes in seconds. If the call returns an error about background commands, it did not run; " +
      "call it once more without those arguments, and if that fails too, end your turn with `[SILENT]`.";
    expect(carriesRule(rule, { silent: true })).toBe(true);
    expect(carriesRule(rule.replace("`notify`, ", ""))).toBe(false);
    expect(carriesRule(rule.replace("exactly `command`", "`command`"))).toBe(false);
    expect(carriesRule(rule.replace(" once more without those arguments", " again"))).toBe(false);
    expect(carriesRule(rule.replace(", and if that fails too, end your turn with `[SILENT]`", ""), { silent: true })).toBe(false);
    expect(carriesRule(`${rule} You may pass \x60notify\x60 when it helps.`)).toBe(false);
    expect(carriesRule(rule, { full: true })).toBe(false);

    const doc = (text: string, plain = false): Doc => ({ name: "x.md", text, cron: plain, plain });
    for (const cmd of [
      "bun run skills/x/scripts/a.ts",
      "bash skills/x/scripts/a.sh",
      "sh scripts/a.sh",
      "node skills/x/a.mjs",
      "python3 skills/x/a.py",
      "cat <<'B' | bun skills/x/a.ts --body-stdin",
    ]) {
      expect(runsIn(doc("```\n" + cmd + "\n```\n")).length).toBe(1);
    }
    expect(runsIn(doc("1. Run `bun skills/index-network/scripts/x.ts` once.\n")).length).toBe(1);
    expect(runsIn(doc("Run bun skills/index-network/scripts/x.ts and format its output.", true)).length).toBe(1);
    expect(runsIn(doc("Run skills/x/scripts/a.py and format its output.", true)).length).toBe(1);
    expect(runsIn(doc("The script `memory_signal_gate.py` runs before this prompt.\n")).length).toBe(0);

    expect(invitations("Pass `notify` if the script is slow.")).toHaveLength(1);
    expect(invitations("Do not add `notify`, `heartbeat` or `background`.")).toHaveLength(0);
    expect(invitations("For a long build, use `background=true` and set `notify` to true.")).toHaveLength(0);
    expect(exampleCalls([doc('terminal(command="make build", background=true, notify=true)')])).toEqual([]);
    expect(exampleCalls([doc('terminal(command="bun skills/x/a.ts", notify=true)')])).toHaveLength(1);
    expect(exampleCalls([doc('terminal(command="bun skills/x/a.ts", background=true)')])).toHaveLength(1);
    expect(exampleCalls([doc('`{"command": "python3 x.py", "heartbeat": 60}`')])).toHaveLength(1);
  });
});
