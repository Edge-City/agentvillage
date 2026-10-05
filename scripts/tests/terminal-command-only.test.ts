/**
 * DATA-312: every agent-facing instruction that has the agent run a script or
 * a recipe through Hermes's `terminal` tool says, next to the command, to pass
 * `command` only, and the standing instructions (AGENTS.md, SOUL.md) carry the
 * same rule.
 *
 * Why: Hermes (v0.21.5, release 2026.9.24) rejects a foreground `terminal`
 * call that carries `notify`, `heartbeat`, `watch_patterns`,
 * `notify_on_complete` or `pty` ("notify/heartbeat only apply to background
 * commands ..."). Since 2026-10-02 the fleet model fills those optional
 * arguments on every script run, so every script-driven scheduled job failed.
 *
 * The list of files is derived from the files themselves: every agent-facing
 * Markdown file under skills/ and workspace/, plus the inline cron prompt
 * bodies in install/install_index.ts. A fenced code block that runs a script
 * (`bun ….ts`, `python3 ….py`) must have the rule within WINDOW lines of the
 * fence; a fenced `curl` or `npx` recipe needs the rule somewhere in its file.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { DIGEST_CRON_SPECS } from "../../install/install_index";

const REPO = join(import.meta.dir, "..", "..");
/** How far (in lines) the rule may sit from a script's code fence. */
const WINDOW = 5;
const BACKGROUND_ONLY = ["notify", "heartbeat", "background", "watch_patterns", "notify_on_complete", "pty"];
/** Files under skills/ that document the overlay for people, not for the agent. */
const NOT_AGENT_FACING = new Set(["README.md", "CLAUDE.md"]);

interface Doc {
  /** Repo-relative path, or `install/install_index.ts#<cron name>` for an inline prompt. */
  name: string;
  text: string;
}

interface Fence {
  /** 0-based line of the opening and closing ``` lines. */
  open: number;
  close: number;
  body: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "references" || entry === "tests" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".md") && !NOT_AGENT_FACING.has(entry)) out.push(path);
  }
  return out;
}

/** Every instruction text an agent reads: skill and prompt Markdown, workspace files, inline cron prompts. */
function agentFacingDocs(root = REPO): Doc[] {
  const files = [...walk(join(root, "skills")), ...walk(join(root, "workspace"))];
  const docs: Doc[] = files.map((path) => ({ name: relative(root, path), text: readFileSync(path, "utf8") }));
  for (const spec of DIGEST_CRON_SPECS) {
    if (spec.promptBody !== undefined) docs.push({ name: `install/install_index.ts#${spec.name}`, text: spec.promptBody });
  }
  return docs;
}

function fences(text: string): Fence[] {
  const lines = text.split("\n");
  const out: Fence[] = [];
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

/** A script the agent runs through `terminal`: `bun x.ts`, `python3 x.py`, also after a pipe. */
const SCRIPT_RUN = /(?:^|[|&;]\s*|\s)(?:bun|python3?)\s+\S+\.(?:ts|py)\b/m;
/** A CLI recipe the agent runs through `terminal`. */
const CLI_RUN = /^\s*(?:curl|npx)\s/m;

/** Language that would let the agent pass a background-only argument. */
const PERMITS_BACKGROUND_ARG = new RegExp(
  String.raw`\b(?:may|can|could|should|feel free to)\s+(?:also\s+)?(?:pass|add|set|use|include)\s+` +
    String.raw`\x60?(?:${BACKGROUND_ONLY.join("|")})\b`,
  "i",
);

/**
 * The rule, in any document's voice: `terminal` with `command` only; a
 * "Never pass" list naming all six background-only arguments; and the single
 * retry after an error about background commands. Nothing may permit one of
 * those arguments.
 */
function carriesRule(text: string): boolean {
  const flat = text.replace(/\s+/g, " ");
  if (!flat.includes("`terminal`") || !flat.includes("`command` only")) return false;
  const never = flat.match(/Never pass ([^.:;]*)/);
  if (!never || !BACKGROUND_ONLY.every((arg) => never[1].includes(`\x60${arg}\x60`))) return false;
  if (!/error about background commands.{0,80}once more without those arguments/.test(flat)) return false;
  return !PERMITS_BACKGROUND_ARG.test(flat);
}

function windowAround(text: string, fence: Fence): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, fence.open - WINDOW), fence.close + WINDOW + 1).join("\n");
}

/** Each fenced script run, with whether the rule sits next to it. */
function scriptRuns(docs: Doc[]): { doc: string; line: number; ruled: boolean }[] {
  const out: { doc: string; line: number; ruled: boolean }[] = [];
  for (const doc of docs) {
    for (const fence of fences(doc.text)) {
      if (!SCRIPT_RUN.test(fence.body)) continue;
      out.push({ doc: doc.name, line: fence.open + 1, ruled: carriesRule(windowAround(doc.text, fence)) });
    }
  }
  return out;
}

/** Each document with a fenced curl/npx recipe, with whether the document carries the rule. */
function recipeDocs(docs: Doc[]): { doc: string; ruled: boolean }[] {
  return docs
    .filter((doc) => fences(doc.text).some((fence) => CLI_RUN.test(fence.body)))
    .map((doc) => ({ doc: doc.name, ruled: carriesRule(doc.text) }));
}

/** An example call that would teach the agent to pass a background-only argument. */
const EXAMPLE_CALL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`terminal\s*\([^)]*\b(?:${BACKGROUND_ONLY.join("|")})\s*=`),
  new RegExp(String.raw`["'](?:${BACKGROUND_ONLY.join("|")})["']\s*:`),
  /\b(?:background|notify|notify_on_complete|pty)\s*[=:]\s*(?:true|True)\b/,
  /\bheartbeat\s*[=:]\s*\d/,
  /\bnotify\s*[=:]\s*\[/,
];

function exampleCalls(docs: Doc[]): { doc: string; match: string }[] {
  const out: { doc: string; match: string }[] = [];
  for (const doc of docs) {
    for (const pattern of EXAMPLE_CALL_PATTERNS) {
      const m = doc.text.match(pattern);
      if (m) out.push({ doc: doc.name, match: m[0] });
    }
  }
  return out;
}

const docs = agentFacingDocs();
const byName = (name: string) => docs.find((doc) => doc.name === name);

describe("terminal: command only (DATA-312)", () => {
  test("the enumeration is derived from the files and finds every cron prompt that runs a script", () => {
    const runs = scriptRuns(docs);
    const files = new Set(runs.map((run) => run.doc));
    const cronPrompts = DIGEST_CRON_SPECS.flatMap((spec) => (spec.promptFile ? [`skills/${spec.promptFile}`] : []));
    const cronPromptsWithScripts = [...new Set(cronPrompts)].filter((name) => {
      const doc = byName(name);
      expect(doc).toBeDefined();
      return fences(doc!.text).some((fence) => SCRIPT_RUN.test(fence.body));
    });
    // The digest prepare/send, negotiation summary, evening questions and the
    // opportunity drop all run a Bun script from their prompt.
    expect(cronPromptsWithScripts.length).toBeGreaterThanOrEqual(5);
    for (const name of cronPromptsWithScripts) expect(files.has(name)).toBe(true);
    expect(runs.length).toBeGreaterThanOrEqual(cronPromptsWithScripts.length);
  });

  test("every fenced script run has the call-with-command-only rule next to it", () => {
    const missing = scriptRuns(docs).filter((run) => !run.ruled).map((run) => `${run.doc}:${run.line}`);
    expect(missing).toEqual([]);
  });

  test("every file with a curl or npx recipe carries the rule", () => {
    const recipes = recipeDocs(docs);
    expect(recipes.map((r) => r.doc)).toContain("skills/edgeos/SKILL.md");
    expect(recipes.filter((r) => !r.ruled).map((r) => r.doc)).toEqual([]);
  });

  test("the standing instructions carry the rule and leave a resident's background job allowed", () => {
    for (const name of ["workspace/AGENTS.md", "workspace/SOUL.md"]) {
      const doc = byName(name);
      expect(doc).toBeDefined();
      expect(carriesRule(doc!.text)).toBe(true);
      // One sentence keeps the background route open for a long job the resident asks for.
      const sentences = doc!.text.replace(/\s+/g, " ").split(/(?<=[.:;])\s/);
      expect(sentences.some((s) => /\bresident\b/.test(s) && /\blong job\b/.test(s) && /\bbackground\b/.test(s))).toBe(true);
    }
  });

  test("no instruction shows an example terminal call with a background-only argument", () => {
    expect(exampleCalls(docs)).toEqual([]);
  });

  test("the rule check rejects weakened wording", () => {
    const rule =
      "Call `terminal` with `command` only. Never pass `notify`, `heartbeat`, `background`, `watch_patterns`, " +
      "`notify_on_complete` or `pty`: it finishes in seconds. If the call returns an error about background " +
      "commands, it did not run; call it once more without those arguments.";
    expect(carriesRule(rule)).toBe(true);
    expect(carriesRule(rule.replace("`notify`, ", ""))).toBe(false);
    expect(carriesRule(rule.replace("`command` only", "`command`"))).toBe(false);
    expect(carriesRule(rule.replace(" once more without those arguments", " again"))).toBe(false);
    expect(carriesRule(`${rule} You may pass \x60notify\x60 when it helps.`)).toBe(false);
  });
});
