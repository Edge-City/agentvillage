/**
 * OV-300 S2: every tool a plugin in `plugins/` can register has a gate decision.
 *
 * ov#300 shipped `village`, a write tool, in neither `APPROVAL_GATED_TOOLS` nor
 * av-approval's `GATED_MATCHERS`, and CI passed: no test walked the plugins. This
 * one does. A tool name is anything a plugin declares (`provides_tools` in its
 * `plugin.yaml`) or registers (`register_tool(...)` in its Python outside
 * `tests/`, the name resolved from the literal, the module constant or, for
 * `_share_vote.py`, the `wanted` table). Each name must either full-match a
 * pattern in `APPROVAL_GATED_TOOLS` (Hermes matchers are full-match regexes) or
 * sit in `NOT_GATED` below with its plugin and a reason, never both. A stale
 * `NOT_GATED` entry, a plugin directory without `plugin.yaml`, or a
 * registration whose name this file cannot resolve fails the test.
 *
 * The scan also reads, or fails on, the registration forms the OV-304 review
 * (S2, E1-E5) showed it could miss. Each failure names file:line and the form.
 * - E1: `getattr(ctx, "register_tool")(...)` called inline is read as a
 *   registration. Any other `"register_tool"` string literal fails, outside the
 *   honest `register_tool = getattr(ctx, "register_tool", None)` binding whose
 *   calls the scan reads. So does a literal or f-string piece of three or more
 *   characters that can spell it (`"register_" + "tool"`; `"register"` alone is
 *   the Hermes entrypoint name and is allowed).
 * - E2: `registry.register(...)` (Hermes `tools/registry.py`) is read as a
 *   registration. Any other reach into `tools.registry` fails: an aliased or
 *   dynamic import, or `registry` used other than in such a call.
 * - E3: rows added to a `NAME_TABLES` table with `append`, `extend`, `insert`
 *   or `+=` are read as names. Any other use of the table fails: rebinding,
 *   item assignment, a registration loop over more than the table, or the loop
 *   variable rebound before the call.
 * - E4: a name constant bound anywhere but at module level (function-local,
 *   augmented, walrus, `global`, `as`, a loop target or parameter, set by name
 *   through `globals()`/`setattr`) fails: the name at the call cannot be read.
 * - E5: `register_tool` passed or kept as a value (`functools.partial`, an
 *   alias, a list) fails.
 * What a source scan cannot see (computed names, `chr`/codec tricks, Hermes
 * internals reached through `ctx`) waits for BRIDGE-1's runtime inventory.
 *
 * This file does not change the gated list (`APPROVAL_ROUTED_SHA256` pins it on
 * the control plane). A tool is put in `NOT_GATED` with an honest reason, and a
 * side-effecting one is raised with the lead.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import YAML from "yaml";

import { APPROVAL_GATED_TOOLS, NOT_STAGED_PLUGINS } from "../install_approval";

const PLUGINS = join(import.meta.dir, "..", "..", "plugins");

/** The reason every tool of a plugin in `NOT_STAGED_PLUGINS` carries, and only those. */
const NOT_STAGED_REASON = "not staged: OV-300 M1 / BRIDGE-1";

interface NotGated {
  name: string;
  plugin: string;
  reason: string;
}

/** Tools no `pre_tool_call` entry routes, each with why. */
const NOT_GATED: readonly NotGated[] = [
  {
    name: "consent_status",
    plugin: "av-events",
    reason: "read: one GET of the tenant's own consent row from ingest (_consent.py); writes nothing, emits nothing",
  },
  {
    name: "record_intention",
    plugin: "av-events",
    reason:
      "SIDE EFFECT, raised with the lead (FIX-A finding): creates, updates and archives intents on Index over REST " +
      "(_record_intention.py), the same act as the gated mcp__index__create_intent; not shim-routed. Its own controls: " +
      "registered only with AV_RECORD_INTENTION on, a session-lineage allowlist for explicit publishes, ambient intents " +
      "held local, and the plugin's own approval.md propose/poll/start when AV_APPROVAL_ENABLED and AV_APPROVAL_URL are set",
  },
  {
    name: "share_digest",
    plugin: "av-events",
    reason:
      "SIDE EFFECT, raised with the lead (FIX-A finding): shares a digest; registered only with AV_DIGEST_SHARE on AND the " +
      "resident's approval channel configured, and acts only on the resident's approval through the plugin's own " +
      "approval.md propose/poll path (_share_vote.py), not through the pre_tool_call shim",
  },
  {
    name: "village_vote",
    plugin: "av-events",
    reason:
      "SIDE EFFECT, raised with the lead (FIX-A finding): casts the weekly vote; registered only with AV_VILLAGE_VOTE on " +
      "AND the resident's approval channel configured, and acts only on the resident's approval through the plugin's own " +
      "approval.md propose/poll path (_share_vote.py), not through the pre_tool_call shim",
  },
  {
    name: "ask_village",
    plugin: "av-events",
    reason:
      "SIDE EFFECT, raised with the lead (same reasoning as pray): sends one ≤500-char question to the cp, which asks the " +
      "app's god-agent runner over the main group's store and returns its answer; reads only, writes and grants nothing; " +
      "registered only with AV_ASK_VILLAGE on; refused in group sessions; per-tenant limits on the cp",
  },
  {
    name: "ask_odin",
    plugin: "av-events",
    reason:
      "SIDE EFFECT, raised with the lead (ask_village's wire, same reasoning): sends one ≤500-char question with a " +
      "kind (question, explain, proposal) to the cp, which runs one tool-free completion on ODIN's box over the " +
      "voted constitution and returns the answer; a proposal is only checked and, when the pool is in intake, " +
      "forwarded to the app's intake for review, never merged; reads no resident data, grants nothing; registered " +
      "only with AV_ASK_ODIN on; refused in group sessions; per-tenant and fleet limits on the cp",
  },
  {
    name: "search_village",
    plugin: "av-events",
    reason:
      "SIDE EFFECT, raised with the lead (same reasoning as ask_village): sends one ≤200-char query to the cp, which " +
      "returns at most 30 of the main group's messages, contact details scrubbed by the app; reads only, writes and " +
      "grants nothing; registered only with AV_SEARCH_VILLAGE on; refused in group sessions; per-tenant limits on the cp",
  },
  {
    name: "query_village",
    plugin: "av-events",
    reason:
      "SIDE EFFECT, raised with the lead (same reasoning as search_village): sends one ≤3000-char SQL statement to the " +
      "cp, whose app runs it read-only (SELECT only, about 2 s, at most 500 rows) over an in-memory SQLite copy of the " +
      "main group's scrubbed messages; reads only, writes and grants nothing; registered only with AV_SEARCH_VILLAGE " +
      "on; refused in group sessions; per-tenant limits on the cp shared with search_village",
  },
  {
    name: "pray",
    plugin: "av-events",
    reason:
      "SIDE EFFECT, raised with the lead: sends one request with a ≤600-char reason to the cp for human review; nothing is " +
      "granted without an admin's approval on /admin/prayers; registered only with AV_PRAY on; refused in group sessions; " +
      "per-tenant limits on the cp",
  },
  {
    name: "resident_context",
    plugin: "village-memory",
    reason:
      "read: a local keyword scan of knowledge/agentvillage/*.md (what the cp wrote for the resident); writes nothing, " +
      "no network; a memory-provider tool (get_tool_schemas), offered and answered only in private sessions",
  },
  {
    name: "resident_profile",
    plugin: "village-memory",
    reason:
      "read: re-reads knowledge/agentvillage/_profile.md (the cp's render); writes nothing, no network; a memory-provider " +
      "tool (get_tool_schemas), offered and answered only in private sessions",
  },
  {
    name: "recall",
    plugin: "recall",
    reason: "read: local SQLite FTS5 search over the agent's own notes and the owner's private sessions; no network, refuses in groups; opt-in (AV_RECALL_ENABLED)",
  },
  {
    name: "elicitation_record",
    plugin: "av-elicit",
    reason: "writes a local 0600 record file only; no network; refused outside the resident's Telegram DM and outside an open window",
  },
];

/**
 * Registrations whose `name=` is a loop variable: the file, the expression, the list the loop runs
 * over, and where that list is written (the first element of each tuple, a literal or a module constant).
 */
interface NameTable {
  file: string;
  expr: string;
  variable: string;
  table: RegExp;
}

const NAME_TABLES: readonly NameTable[] = [
  { file: "av-events/_share_vote.py", expr: "name", variable: "wanted", table: /\n {4}wanted = \[([\s\S]*?)\]\n/ },
];

const matcher = (patterns: readonly string[]) => (tool: string) => patterns.some((pattern) => new RegExp(`^(?:${pattern})$`).test(tool));
const gated = matcher(APPROVAL_GATED_TOOLS);

function pluginDirs(root: string): string[] {
  return readdirSync(root)
    .filter((name) => !name.startsWith(".") && statSync(join(root, name)).isDirectory())
    .sort();
}

/** Every `*.py` under `dir`, skipping `tests/` and caches: what is staged onto a box. */
function pythonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "tests" || entry === "__pycache__" || entry.startsWith(".")) continue;
      out.push(...pythonFiles(path));
    } else if (entry.endsWith(".py")) {
      out.push(path);
    }
  }
  return out;
}

/** The text between the bracket at `open` and its match, skipping string literals. */
function bracketed(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${source[open]} this test cannot read`);
}

/** The name argument: `name=<expr>`, else the first positional argument. */
function nameExpr(args: string): string {
  const kw = /(?:^|[,\s(])name\s*=\s*("[^"]*"|'[^']*'|[A-Za-z_][\w.]*)/.exec(args);
  if (kw) return kw[1]!;
  const first = args.split(",")[0]!.trim();
  if (/^("[^"]*"|'[^']*'|[A-Za-z_][\w.]*)$/.test(first) && !first.includes("=")) return first;
  throw new Error(`(${args.slice(0, 80)}...) has no name argument this test can read`);
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
const lineAt = (text: string, index: number) => {
  const end = text.indexOf("\n", index);
  return text.slice(text.lastIndexOf("\n", index - 1) + 1, end === -1 ? text.length : end).trim();
};

/** Augmented assignment operators. */
const AUG = "(?:[-+*/%&|^@]|//|\\*\\*|<<|>>)=";

/**
 * E4: a binding of `name` other than the module-level `NAME = ...` that `resolve` reads. Any of
 * these can change the value at the call, so the name there cannot be read.
 */
function rebinding(name: string): RegExp {
  const n = name;
  return new RegExp(
    [
      `^[ \\t]+${n}[ \\t]*(?::[^=\\n]+)?=(?!=)`, // function-local, class or block assignment
      `^[ \\t]*${n}[ \\t]*${AUG}`, // augmented, at any level
      `\\b${n}[ \\t]*:=`, // walrus
      `^[ \\t]*(?:global|nonlocal)\\b[^\\n]*\\b${n}\\b`,
      `\\bas[ \\t]+${n}\\b`, // import / with / except ... as
      `\\bfor[ \\t]+(?:[\\w \\t,()*\\[\\]]*[ \\t,(*\\[])?${n}\\b[\\w \\t,()*\\[\\]]*\\bin\\b`, // loop or comprehension target
      `\\bdef[ \\t]+\\w+[ \\t]*\\([^)]*\\b${n}\\b`, // a parameter
      `\\blambda\\b[^:\\n]*\\b${n}\\b[^:\\n]*:`,
      `^[ \\t]*(?:[\\w.*]+[ \\t]*,[ \\t]*)+${n}[ \\t]*(?:,[ \\t]*[\\w.*]+[ \\t]*)*=(?!=)`, // tuple target
      `^[ \\t]*${n}[ \\t]*(?:,[ \\t]*[\\w.*]+[ \\t]*)+=(?!=)`,
      `\\.[ \\t]*${n}[ \\t]*(?:${AUG}|=(?!=))`, // module attribute
      `(?:\\bglobals\\(\\s*\\)|\\bvars\\([^)\\n]*\\)|__dict__)\\s*\\[\\s*["']${n}["']`, // by name
      `\\bsetattr\\([^,\\n]*,\\s*["']${n}["']`,
    ].join("|"),
    "gm",
  );
}

function checkRebinding(name: string, file: string, files: Map<string, string>) {
  const text = files.get(file)!;
  const m = rebinding(name).exec(text);
  if (m) throw new Error(`${name} is rebound at ${file}:${lineOf(text, m.index)} (\`${lineAt(text, m.index)}\`), so the name at the call cannot be read`);
}

/**
 * A string literal, or a module-level constant followed through other constants: defined in `file`
 * itself, else (an import) in exactly one other file of the plugin. A constant bound anywhere but at
 * module level (E4) is not read.
 */
function resolve(expr: string, file: string, files: Map<string, string>, depth = 0): string {
  const literal = /^"([^"]*)"$|^'([^']*)'$/.exec(expr);
  if (literal) return literal[1] ?? literal[2]!;
  if (depth > 5 || !/^[A-Za-z_]\w*$/.test(expr)) throw new Error(`cannot resolve tool name expression ${expr} (in ${file})`);
  checkRebinding(expr, file, files);
  const assign = new RegExp(`^${expr}\\s*(?::[^=\\n]+)?=(?!=)\\s*([^\\n#]+?)\\s*(?:#.*)?$`, "gm");
  const defs = (text: string) => [...text.matchAll(assign)].map((m) => m[1]!);
  const local = defs(files.get(file)!);
  if (local.length === 1) return resolve(local[0]!, file, files, depth + 1);
  if (local.length > 1) throw new Error(`${expr} is defined ${local.length} times in ${file}`);
  const elsewhere = [...files].filter(([other]) => other !== file).flatMap(([other, text]) => defs(text).map((value) => [other, value] as const));
  if (elsewhere.length !== 1) throw new Error(`${expr} has ${elsewhere.length} module-level definitions in the plugin's other files`);
  checkRebinding(expr, elsewhere[0]![0], files);
  return resolve(elsewhere[0]![1], elsewhere[0]![0], files, depth + 1);
}

/** A table row: a `(` not preceded by a name (so not a call), then a literal or a constant, then `,`. */
const ROW = /(?<![\w.\])])\(\s*("[^"]*"|'[^']*'|[A-Za-z_]\w*)\s*,/g;

const TARGET = "register_tool";

/** E1: a literal that is a piece of `register_tool`, three characters or more (`"register"` is the entrypoint name). */
const fragment = (piece: string, text = "") =>
  piece.length >= 3 && piece !== "register" && TARGET.includes(piece) && (piece !== "tool" || REGISTER_LITERAL.test(text));
/** E1 (ov#312): a `"register"` literal in the file, beside which `"tool"` can complete the name. */
const REGISTER_LITERAL = /(["'])register\1/;

/**
 * E1, f-strings: one that could equal `register_tool`, every literal piece between the `{...}` a piece of
 * it, three characters or more in all (`f"register_{x}"`, `f"{x}_tool"`; not `f"tool_{status}"`).
 */
function fStringSpells(content: string): boolean {
  const pieces = content.split(/\{[^{}]*\}/).filter((piece) => piece.length > 0);
  return pieces.length > 0 && pieces.every((piece) => TARGET.includes(piece)) && pieces.join("").length >= 3;
}

/** E1: `register_tool` as a whole word in a literal (`"ctx.register_tool"`; not the log word `no_register_tool`). */
const SPELLS = /(?<![A-Za-z0-9_])register_tool(?![A-Za-z0-9_])/;

/** Python escapes in a non-raw literal, so `"\x72egister_tool"` reads as what it spells. */
function decode(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|[\s\S])/g, (_, e: string) => {
    if (/^[xuU]./.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCodePoint(parseInt(e, 8));
    return e;
  });
}

/** Every quoted run on one line, overlapping, so a misaligned quote cannot hide a literal. */
const QUOTED = /(?=(?<![A-Za-z0-9_])([rRbBuUfF]{0,2})(["'])((?:(?!\2)[^\\\n]|\\.){0,80})\2)/g;

/** The honest binding: calls through it are `register_tool(` calls the scan reads. */
const HONEST_GETATTR = /^[ \t]*register_tool[ \t]*=[ \t]*getattr\([ \t]*[A-Za-z_]\w*[ \t]*,[ \t]*(["'])register_tool\1[ \t]*(?:,[ \t]*None[ \t]*)?\)[ \t]*(?:#[^\n]*)?$/gm;
/** E1, read: `getattr(<obj>, "register_tool"[, default])(` called inline. */
const INLINE_GETATTR = /\bgetattr\(\s*[A-Za-z_][\w.]*\s*,\s*(["'])register_tool\1\s*(?:,[^()\n]*)?\)\s*\(/g;
/** E5: `register_tool` in a value position (an argument, an element, an assigned value, a return), not called or assigned to. */
const VALUE_USE = /(?<!\bcallable\(\s*)(?<=(?:[(\[{,:=]|\breturn|\byield|\bawait|\blambda\b[^:\n]*:)\s*)(?:[A-Za-z_]\w*\s*\.\s*)*register_tool\b(?!\s*\(|\s*=(?!=))/g;
/** E2: the one import of Hermes's registry the scan accepts. */
const REGISTRY_IMPORT = /^[ \t]*from[ \t]+tools\.registry[ \t]+import[ \t]+registry[ \t]*(?:#[^\n]*)?$/gm;
/** E2: every other reach into it. */
const REGISTRY_OTHER = /\btools\s*\.\s*registry\b|\bfrom[ \t]+tools[ \t]+import\b[^\n]*\bregistry\b|\bregistry\s*\.\s*register\b(?!\s*\()/g;
/** E2, read: a `registry.register(` call. */
const REGISTRY_CALL = /\b(?:[A-Za-z_]\w*\s*\.\s*)*registry\s*\.\s*register\s*\(/g;

type Span = readonly [number, number];
const spans = (text: string, re: RegExp): Span[] => [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length] as const);
const inside = (all: Span[], i: number) => all.some(([a, b]) => i >= a && i < b);

interface Inventory {
  /** tool name -> plugins that declare or register it */
  tools: Map<string, Set<string>>;
  /** what was found, for the failure messages and the report */
  found: string[];
  missingYaml: string[];
  problems: string[];
}

interface ScanOptions {
  /** the plugins/ directory to scan (a fixture root in the evasion tests) */
  root?: string;
  nameTables?: readonly NameTable[];
}

function inventory({ root = PLUGINS, nameTables = NAME_TABLES }: ScanOptions = {}): Inventory {
  const tools = new Map<string, Set<string>>();
  const found: string[] = [];
  const missingYaml: string[] = [];
  const problems: string[] = [];
  const add = (name: string, plugin: string, where: string) => {
    if (!tools.has(name)) tools.set(name, new Set());
    tools.get(name)!.add(plugin);
    found.push(`${plugin}: ${name} (${where})`);
  };
  for (const plugin of pluginDirs(root)) {
    const dir = join(root, plugin);
    let manifest: Record<string, unknown> | null = null;
    try {
      manifest = (YAML.parse(readFileSync(join(dir, "plugin.yaml"), "utf8")) ?? {}) as Record<string, unknown>;
    } catch {
      missingYaml.push(plugin);
    }
    const provides = manifest?.provides_tools;
    if (provides !== undefined && provides !== null) {
      if (!Array.isArray(provides) || provides.some((n) => typeof n !== "string")) problems.push(`${plugin}: provides_tools is not a list of names`);
      else for (const name of provides as string[]) add(name, plugin, "plugin.yaml provides_tools");
    }
    const files = new Map(pythonFiles(dir).map((path) => [relative(root, path), readFileSync(path, "utf8")]));
    for (const [file, text] of files) {
      const at = (i: number) => `${file}:${lineOf(text, i)}`;
      const unreadable = (i: number, form: string) => problems.push(`${at(i)}: a registration this test cannot read: ${form} (\`${lineAt(text, i)}\`)`);

      // E3: the rows of each name table in this file: the literal block plus what is added to it.
      const tables = new Map<string, { rows: { expr: string; where: string }[]; header: RegExpExecArray | null }>();
      for (const t of nameTables.filter((t) => t.file === file)) {
        const rows: { expr: string; where: string }[] = [];
        const block = t.table.exec(text);
        const header = new RegExp(`^[ \\t]*for[ \\t]+${t.expr}[ \\t]*,[^\\n]*\\bin[ \\t]+${t.variable}[ \\t]*:`, "m").exec(text);
        tables.set(t.expr, { rows, header });
        if (!block) {
          problems.push(`${file}: the name table ${t.variable} for ${t.expr} is gone`);
          continue;
        }
        for (const r of block[1]!.matchAll(ROW)) rows.push({ expr: r[1]!, where: `${r[1]} in the ${t.variable} table` });
        const blockSpan: Span = [block.index, block.index + block[0].length];
        for (const m of text.matchAll(new RegExp(`\\b${t.variable}\\b`, "g"))) {
          const i = m.index!;
          if (inside([blockSpan], i)) continue;
          const after = text.slice(i + t.variable.length);
          if (/\bin\s+$/.test(text.slice(Math.max(0, i - 8), i)) && /^\s*[:)\],]/.test(after)) continue; // iterated as it is
          const call = /^\s*\.\s*(?:append|extend|insert)\s*\(/.exec(after);
          const plus = /^\s*\+=\s*(?=[[(])/.exec(after);
          if (!call && !plus) {
            unreadable(i, `the name table \`${t.variable}\` rebound or used other than by append/extend/insert/+=`);
            continue;
          }
          // The bracket that holds the added row(s): the call's `(`, or the `[`/`(` after `+=`.
          const open = i + t.variable.length + (call ? call[0].length - 1 : plus![0].length);
          try {
            const added = [...bracketed(text, open).matchAll(ROW)].map((r) => r[1]!);
            if (added.length === 0) unreadable(i, `a row added to \`${t.variable}\` with no name this test can read`);
            for (const expr of added) rows.push({ expr, where: `${expr} added to the ${t.variable} table at line ${lineOf(text, i)}` });
          } catch (err) {
            problems.push(`${at(i)}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      const register = (open: number, where: string) => {
        try {
          const expr = nameExpr(bracketed(text, open));
          const table = tables.get(expr);
          if (table) {
            if (!table.header) throw new Error(`the registration loop \`for ${expr}, ... in <table>:\` over the name table is gone`);
            const between = text.slice(table.header.index + table.header[0].length, open);
            const rebound = new RegExp(
              `^[ \\t]*(?:[\\w.*]+[ \\t]*,[ \\t]*)*${expr}[ \\t]*(?:,[ \\t]*[\\w.*]+[ \\t]*)*(?:${AUG}|=(?!=))|\\b${expr}[ \\t]*:=|\\bfor[ \\t]+[^\\n]*\\b${expr}\\b[^\\n]*\\bin\\b|\\bas[ \\t]+${expr}\\b`,
              "m",
            ).exec(between);
            if (rebound) throw new Error(`the loop variable ${expr} is rebound before the call (\`${rebound[0].trim()}\`), so the name cannot be read`);
            if (table.rows.length === 0) throw new Error(`the name table for ${expr} lists no names`);
            for (const row of table.rows) add(resolve(row.expr, file, files), plugin, `${where}, ${row.where}`);
          } else {
            add(resolve(expr, file, files), plugin, `${where}, name=${expr}`);
          }
        } catch (err) {
          problems.push(`${at(open)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // The honest form, and E1 read: `register_tool(` and `getattr(ctx, "register_tool")(`.
      for (const m of text.matchAll(/\bregister_tool\s*\(/g)) register(m.index! + m[0].length - 1, `${file} register_tool`);
      const inline = spans(text, INLINE_GETATTR);
      for (const [, end] of inline) register(end - 1, `${file} getattr register_tool`);

      // E1: any other literal that is, or can spell, "register_tool".
      const honest = spans(text, HONEST_GETATTR);
      for (const m of text.matchAll(QUOTED)) {
        const [, prefix, quote, body] = m;
        const i = m.index!;
        const content = /[rR]/.test(prefix!) ? body! : decode(body!);
        if (SPELLS.test(content)) {
          if (!inside(honest, i) && !inside(inline, i)) unreadable(i, `"register_tool" string literal outside \`register_tool = getattr(ctx, "register_tool", None)\``);
        } else if (/[fF]/.test(prefix!) ? fStringSpells(content) : fragment(content, text)) {
          unreadable(i, `string literal ${prefix}${quote}${body}${quote} can spell register_tool`);
        }
      }

      // E5: register_tool kept or passed as a value (functools.partial, an alias, a list).
      for (const m of text.matchAll(VALUE_USE)) {
        const lineStart = text.lastIndexOf("\n", m.index! - 1) + 1;
        if (/^[ \t]*register_tool[ \t]*=[ \t]*$/.test(text.slice(lineStart, m.index!))) continue; // a same-name binding keeps its calls visible
        unreadable(m.index!, `register_tool used as a value (\`${m[0]}\`)`);
      }

      // E2: Hermes's tool registry, bypassing ctx.
      const imports = spans(text, REGISTRY_IMPORT);
      for (const m of text.matchAll(REGISTRY_OTHER)) {
        if (!inside(imports, m.index!)) unreadable(m.index!, "Hermes tools.registry reached other than by `from tools.registry import registry` and `registry.register(...)`");
      }
      const calls = spans(text, REGISTRY_CALL);
      for (const [, end] of calls) register(end - 1, `${file} registry.register`);
      if (imports.length > 0) {
        for (const m of text.matchAll(/\bregistry\b/g)) {
          const i = m.index!;
          if (inside(imports, i) || inside(calls, i)) continue;
          unreadable(i, "`registry` (Hermes tools.registry) used other than in a `registry.register(...)` call");
        }
      }
    }
  }
  return { tools, found, missingYaml, problems };
}

/** Each tool's gate decision against a NOT_GATED list and a gated matcher; the failures. */
function decisions(inv: Inventory, notGated: readonly NotGated[] = NOT_GATED, isGated: (tool: string) => boolean = gated): string[] {
  const bad: string[] = [];
  for (const [name, plugins] of [...inv.tools].sort()) {
    const entries = notGated.filter((e) => e.name === name);
    if (isGated(name)) {
      if (entries.length > 0) bad.push(`${name}: gated AND listed in NOT_GATED`);
      continue;
    }
    if (entries.length === 0) {
      bad.push(`${name} (${[...plugins].join(", ")}): not gated and not in NOT_GATED`);
      continue;
    }
    for (const plugin of plugins) {
      if (!entries.some((e) => e.plugin === plugin)) bad.push(`${name}: registered by ${plugin}, NOT_GATED names ${entries.map((e) => e.plugin).join(", ")}`);
    }
  }
  return bad;
}

describe("OV-300 S2: every plugin tool is gated or explicitly NOT_GATED", () => {
  const inv = inventory();

  test("every plugin directory has a plugin.yaml, and every registration's name resolves", () => {
    expect(inv.missingYaml).toEqual([]);
    expect(inv.problems).toEqual([]);
  });

  test("the scan finds the tools it should (a scan that finds nothing proves nothing)", () => {
    // Resolved by reading the source: consent_status (_consent.py TOOL_NAME), record_intention
    // (_record_intention.py TOOL_NAME = RECORD_INTENTION_TOOL, _intentions.py), share_digest and
    // village_vote (_share_vote.py wanted table: SHARE_TOOL, VOTE_TOOL), pray (_pray.py TOOL_NAME),
    // ask_village (_ask_village.py TOOL_NAME), ask_odin (_ask_odin.py TOOL_NAME), search_village
    // (_search_village.py TOOL_NAME), query_village (_query_village.py TOOL_NAME), recall (recall TOOL_NAME),
    // village (village-bridge literal), resident_context
    // and resident_profile (village-memory plugin.yaml provides_tools: a memory provider's tools come from
    // get_tool_schemas, which no register_tool scan sees), elicitation_record (av-elicit, GC-ELICIT).
    expect([...inv.tools.keys()].sort()).toEqual([
      "ask_odin", "ask_village", "consent_status", "elicitation_record", "pray", "query_village", "recall", "record_intention",
      "resident_context", "resident_profile", "search_village", "share_digest", "village", "village_vote",
    ]);
    expect(inv.found.filter((f) => f.includes("register_tool")).length).toBeGreaterThanOrEqual(10);
  });

  test("each tool full-matches an APPROVAL_GATED_TOOLS pattern or has a NOT_GATED entry for its plugin, not both", () => {
    expect(decisions(inv)).toEqual([]);
  });

  test("no stale NOT_GATED entry: each names a tool its plugin declares or registers, once, with a reason", () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const e of NOT_GATED) {
      const key = `${e.plugin}/${e.name}`;
      if (seen.has(key)) bad.push(`${key}: listed twice`);
      seen.add(key);
      if (!inv.tools.get(e.name)?.has(e.plugin)) bad.push(`${key}: no plugin ${e.plugin} declares or registers ${e.name}`);
      if (e.reason.trim().length < 10) bad.push(`${key}: no reason`);
    }
    expect(bad).toEqual([]);
  });

  test("the not-staged reason belongs to exactly the tools of NOT_STAGED_PLUGINS, and each such plugin exists", () => {
    const bad: string[] = [];
    const dirs = new Set(pluginDirs(PLUGINS));
    for (const plugin of NOT_STAGED_PLUGINS) if (!dirs.has(plugin)) bad.push(`NOT_STAGED_PLUGINS names ${plugin}, which is not in plugins/`);
    for (const e of NOT_GATED) {
      const notStaged = NOT_STAGED_PLUGINS.has(e.plugin);
      if (e.reason === NOT_STAGED_REASON && !notStaged) bad.push(`${e.plugin}/${e.name}: reason says not staged, but ${e.plugin} is not in NOT_STAGED_PLUGINS (it would be staged ungated)`);
      if (notStaged && e.reason !== NOT_STAGED_REASON) bad.push(`${e.plugin}/${e.name}: ${e.plugin} is not staged; its reason must be "${NOT_STAGED_REASON}"`);
    }
    for (const [name, plugins] of inv.tools) {
      for (const plugin of plugins) {
        if (NOT_STAGED_PLUGINS.has(plugin) && !gated(name) && !NOT_GATED.some((e) => e.name === name && e.plugin === plugin)) {
          bad.push(`${plugin}/${name}: tool of a not-staged plugin with no NOT_GATED entry`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("OV-304 S2: the scan reads or fails on the evasion forms (fixture plugins in a temp dir)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** A temp plugins/ root holding one plugin, `fixture`, with these files (no provides_tools). */
  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "plugin-inventory-"));
    roots.push(root);
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, "fixture", path)), { recursive: true });
      writeFileSync(join(root, "fixture", path), text);
    };
    write("plugin.yaml", "name: fixture\nversion: 0.0.0\n");
    for (const [path, text] of Object.entries(files)) write(path, text);
    return root;
  }

  const HONEST = "honest_tool";
  const reason = "fixture: a reason long enough for the stale-entry rule";
  const honestEntry: NotGated = { name: HONEST, plugin: "fixture", reason };
  /** The recall shape: a module constant and `ctx.register_tool(name=TOOL_NAME, ...)`, then `body` in `register`. */
  const plugin = (body: string, top = "") =>
    `${top}TOOL_NAME = "${HONEST}"\n\n\ndef register(ctx):\n    ctx.register_tool(name=TOOL_NAME, toolset="t", schema={}, handler=print)\n${body}`;

  const TABLE_FILE = "fixture/_table.py";
  const tables: NameTable[] = [{ file: TABLE_FILE, expr: "name", variable: "wanted", table: /\n {4}wanted = \[([\s\S]*?)\]\n/ }];
  const SHARE = "fixture_share";
  const shareEntry: NotGated = { name: SHARE, plugin: "fixture", reason };
  /** The _share_vote.py shape: a `wanted` table, the getattr binding, a loop; `mutation` after the table. */
  const table = (mutation: string, loop = "for name, schema, answer, description, on in wanted:") =>
    `EVIL_TOOL = "evil_appended"\nSHARE = "${SHARE}"\n\n\ndef register_rows(ctx):\n    wanted = [(SHARE, {}, print, "d", True)]\n` +
    `${mutation}    register_tool = getattr(ctx, "register_tool", None)\n    ${loop}\n` +
    `        register_tool(name=name, toolset="t", schema=schema, handler=answer, description=description)\n`;

  test("the honest fixtures pass with no problems: a constant name, and a name table behind the getattr binding", () => {
    const inv = inventory({ root: fixture({ "__init__.py": plugin("") }) });
    expect(inv.problems).toEqual([]);
    expect([...inv.tools.keys()]).toEqual([HONEST]);
    expect(decisions(inv, [honestEntry])).toEqual([]);
    const tinv = inventory({ root: fixture({ "_table.py": table("") }), nameTables: tables });
    expect(tinv.problems).toEqual([]);
    expect([...tinv.tools.keys()]).toEqual([SHARE]);
    expect(decisions(tinv, [shareEntry])).toEqual([]);
  });

  /** Forms the scan now reads: unlisted fails; listed in NOT_GATED, or gated, passes. */
  const READ: { id: string; name: string; files: Record<string, string>; tables?: NameTable[]; base: NotGated }[] = [
    {
      id: 'E1 getattr(ctx, "register_tool")(...) inline',
      name: "evil_getattr",
      files: { "__init__.py": plugin(`    getattr(ctx, "register_tool")(name="evil_getattr", toolset="t", schema={}, handler=print)\n`) },
      base: honestEntry,
    },
    {
      id: "E2 from tools.registry import registry; registry.register(...)",
      name: "evil_registry",
      files: { "__init__.py": plugin(`    registry.register(name="evil_registry", toolset="t", schema={}, handler=print)\n`, "from tools.registry import registry\n") },
      base: honestEntry,
    },
    {
      id: "E3 wanted.append((NAME, ...))",
      name: "evil_appended",
      files: { "_table.py": table(`    wanted.append((EVIL_TOOL, {}, print, "d", True))\n`) },
      tables,
      base: shareEntry,
    },
    {
      id: "E3 wanted.extend([...])",
      name: "evil_extended",
      files: { "_table.py": table(`    wanted.extend([\n        ("evil_extended", {}, print, "d", True),\n    ])\n`) },
      tables,
      base: shareEntry,
    },
    {
      id: "E3 wanted.insert(0, (...))",
      name: "evil_inserted",
      files: { "_table.py": table(`    wanted.insert(0, ("evil_inserted", {}, print, "d", True))\n`) },
      tables,
      base: shareEntry,
    },
    {
      id: "E3 wanted += [...]",
      name: "evil_plus",
      files: { "_table.py": table(`    wanted += [("evil_plus", {}, print, "d", True)]\n`) },
      tables,
      base: shareEntry,
    },
  ];

  for (const c of READ) {
    test(`${c.id}: read as a registration; fails unlisted, passes when NOT_GATED or gated`, () => {
      const inv = inventory({ root: fixture(c.files), nameTables: c.tables ?? [] });
      expect(inv.problems).toEqual([]);
      expect(inv.tools.get(c.name)).toEqual(new Set(["fixture"]));
      expect(decisions(inv, [c.base])).toEqual([`${c.name} (fixture): not gated and not in NOT_GATED`]);
      expect(decisions(inv, [c.base, { name: c.name, plugin: "fixture", reason }])).toEqual([]);
      expect(decisions(inv, [c.base], matcher(["evil_.*"]))).toEqual([]);
    });
  }

  /**
   * Forms whose name the scan cannot read: each fails as a problem naming file:line and the form,
   * whatever the lists say (`marker` is a substring of the line the problem must name).
   */
  const FAIL: { id: string; files: Record<string, string>; tables?: NameTable[]; file: string; marker: string; form: RegExp }[] = [
    {
      id: 'E1 "register_tool" kept in a constant',
      files: { "__init__.py": plugin(`    getattr(ctx, REG)(name="evil_const_attr", toolset="t", schema={}, handler=print)\n`, `REG = "register_tool"\n`) },
      file: "fixture/__init__.py",
      marker: `REG = "register_tool"`,
      form: /"register_tool" string literal outside/,
    },
    {
      id: 'E1 "register_" + "tool"',
      files: { "__init__.py": plugin(`    getattr(ctx, "register_" + "tool")(name="evil_concat", toolset="t", schema={}, handler=print)\n`) },
      file: "fixture/__init__.py",
      marker: `"register_" + "tool"`,
      form: /string literal "register_" can spell register_tool/,
    },
    {
      id: 'E1 "register" + "_" + "tool" (ov#312: "tool" alone is allowed only without a "register" literal)',
      files: { "__init__.py": plugin(`    getattr(ctx, "register" + "_" + "tool")(name="evil_word", toolset="t", schema={}, handler=print)\n`) },
      file: "fixture/__init__.py",
      marker: `"register" + "_" + "tool"`,
      form: /string literal "tool" can spell register_tool/,
    },
    {
      id: "E1 f-string",
      files: { "__init__.py": plugin(`    part = "t" + "o" + "o" + "l"\n    getattr(ctx, f"register_{part}")(name="evil_f", toolset="t", schema={}, handler=print)\n`) },
      file: "fixture/__init__.py",
      marker: `f"register_{part}"`,
      form: /string literal f"register_\{part\}" can spell register_tool/,
    },
    {
      id: "E1 escaped literal",
      files: { "__init__.py": plugin(`    getattr(ctx, "\\x72egister_tool")(name="evil_escape", toolset="t", schema={}, handler=print)\n`) },
      file: "fixture/__init__.py",
      marker: `"\\x72egister_tool"`,
      form: /"register_tool" string literal outside/,
    },
    {
      id: "E2 aliased registry import",
      files: { "__init__.py": plugin(`    hermes_tools.register(name="evil_alias", toolset="t", schema={}, handler=print)\n`, "from tools.registry import registry as hermes_tools\n") },
      file: "fixture/__init__.py",
      marker: "import registry as hermes_tools",
      form: /Hermes tools\.registry reached other than/,
    },
    {
      id: "E2 dynamic import",
      files: { "__init__.py": plugin(`    importlib.import_module("tools.registry").registry.register(name="evil_dynamic", toolset="t", schema={}, handler=print)\n`, "import importlib\n") },
      file: "fixture/__init__.py",
      marker: "import_module(",
      form: /Hermes tools\.registry reached other than/,
    },
    {
      id: "E2 registry.register kept as a value",
      files: { "__init__.py": plugin(`    reg = registry.register\n    reg(name="evil_regval", toolset="t", schema={}, handler=print)\n`, "from tools.registry import registry\n") },
      file: "fixture/__init__.py",
      marker: "reg = registry.register",
      form: /Hermes tools\.registry reached other than/,
    },
    {
      id: "E3 wanted rebound",
      files: { "_table.py": table(`    wanted = wanted + [("evil_rebound", {}, print, "d", True)]\n`) },
      tables,
      file: TABLE_FILE,
      marker: "wanted = wanted +",
      form: /the name table `wanted` rebound or used other than/,
    },
    {
      id: "E3 wanted item assignment",
      files: { "_table.py": table(`    wanted[0] = ("evil_item", {}, print, "d", True)\n`) },
      tables,
      file: TABLE_FILE,
      marker: "wanted[0] =",
      form: /the name table `wanted` rebound or used other than/,
    },
    {
      id: "E3 the loop runs over more than the table",
      files: { "_table.py": table("", `for name, schema, answer, description, on in wanted + [("evil_loop", {}, print, "d", True)]:`) },
      tables,
      file: TABLE_FILE,
      marker: "in wanted + [",
      form: /the name table `wanted` rebound or used other than/,
    },
    {
      id: "E3 the loop variable rebound before the call",
      files: { "_table.py": table("", `for name, schema, answer, description, on in wanted:\n        name = "evil_loopvar"`) },
      tables,
      file: TABLE_FILE,
      marker: "register_tool(name=name",
      form: /the loop variable name is rebound before the call/,
    },
    {
      id: "E4 function-local constant shadowing the module one",
      files: { "__init__.py": `TOOL_NAME = "${HONEST}"\n\n\ndef register(ctx):\n    TOOL_NAME = "evil_shadow"\n    ctx.register_tool(name=TOOL_NAME, toolset="t", schema={}, handler=print)\n` },
      file: "fixture/__init__.py",
      marker: "ctx.register_tool(",
      form: /TOOL_NAME is rebound at fixture\/__init__\.py:5 \(`TOOL_NAME = "evil_shadow"`\)/,
    },
    {
      id: "E4 module constant changed by augmented assignment",
      files: { "__init__.py": `${plugin("")}TOOL_NAME += "_evil"\n` },
      file: "fixture/__init__.py",
      marker: "ctx.register_tool(",
      form: /TOOL_NAME is rebound at fixture\/__init__\.py:\d+ \(`TOOL_NAME \+= "_evil"`\)/,
    },
    {
      id: "E4 constant set by name through globals()",
      files: { "__init__.py": plugin(`    globals()["TOOL_NAME"] = "evil_globals"\n`) },
      file: "fixture/__init__.py",
      marker: "ctx.register_tool(",
      form: /TOOL_NAME is rebound at/,
    },
    {
      id: "E5 functools.partial(ctx.register_tool, ...)",
      files: { "__init__.py": plugin(`    functools.partial(ctx.register_tool, toolset="t")(name="evil_partial", schema={}, handler=print)\n`, "import functools\n") },
      file: "fixture/__init__.py",
      marker: "functools.partial(",
      form: /register_tool used as a value \(`ctx\.register_tool`\)/,
    },
    {
      id: "E5 alias under another name",
      files: { "__init__.py": plugin(`    reg = ctx.register_tool\n    reg(name="evil_alias_call", toolset="t", schema={}, handler=print)\n`) },
      file: "fixture/__init__.py",
      marker: "reg = ctx.register_tool",
      form: /register_tool used as a value/,
    },
    {
      id: "E5 kept in a list",
      files: { "__init__.py": plugin(`    for fn in [ctx.register_tool]:\n        fn(name="evil_list", toolset="t", schema={}, handler=print)\n`) },
      file: "fixture/__init__.py",
      marker: "[ctx.register_tool]",
      form: /register_tool used as a value/,
    },
  ];

  for (const c of FAIL) {
    test(`${c.id}: fails as a problem naming file:line and the form`, () => {
      const root = fixture(c.files);
      const inv = inventory({ root, nameTables: c.tables ?? [] });
      const text = readFileSync(join(root, c.file), "utf8");
      expect(text.includes(c.marker)).toBe(true);
      const line = lineOf(text, text.indexOf(c.marker));
      // The problems are in the failure message when no problem names this line and form.
      expect({ named: inv.problems.some((p) => p.startsWith(`${c.file}:${line}:`) && c.form.test(p)), problems: inv.problems }).toEqual({
        named: true,
        problems: inv.problems,
      });
    });
  }
});
