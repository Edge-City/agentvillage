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
 * This file does not change the gated list (`APPROVAL_ROUTED_SHA256` pins it on
 * the control plane). A tool is put in `NOT_GATED` with an honest reason, and a
 * side-effecting one is raised with the lead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "bun:test";
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
    name: "recall",
    plugin: "recall",
    reason: "read: local SQLite FTS5 search over the agent's own notes and the owner's private sessions; no network, refuses in groups; opt-in (AV_RECALL_ENABLED)",
  },
  { name: "village", plugin: "village-bridge", reason: NOT_STAGED_REASON },
];

/**
 * Registrations whose `name=` is a loop variable: the file, the expression, and where its values
 * come from (the first element of each tuple in the named list, each a module constant).
 */
const NAME_TABLES: readonly { file: string; expr: string; table: RegExp }[] = [
  { file: "av-events/_share_vote.py", expr: "name", table: /\n {4}wanted = \[([\s\S]*?)\]\n/ },
];

const gated = (tool: string) => APPROVAL_GATED_TOOLS.some((pattern) => new RegExp(`^(?:${pattern})$`).test(tool));

function pluginDirs(): string[] {
  return readdirSync(PLUGINS)
    .filter((name) => !name.startsWith(".") && statSync(join(PLUGINS, name)).isDirectory())
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

/** The text between the `(` at `open` and its matching `)`, skipping string literals. */
function callArgs(source: string, open: number): string {
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
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced register_tool( call at offset ${open}`);
}

/** The name argument: `name=<expr>`, else the first positional argument. */
function nameExpr(args: string): string {
  const kw = /(?:^|[,\s(])name\s*=\s*("[^"]*"|'[^']*'|[A-Za-z_][\w.]*)/.exec(args);
  if (kw) return kw[1]!;
  const first = args.split(",")[0]!.trim();
  if (/^("[^"]*"|'[^']*'|[A-Za-z_][\w.]*)$/.test(first) && !first.includes("=")) return first;
  throw new Error(`register_tool(${args.slice(0, 80)}...) has no name argument this test can read`);
}

/**
 * A string literal, or a module-level constant followed through other constants: defined in `file`
 * itself, else (an import) in exactly one other file of the plugin.
 */
function resolve(expr: string, file: string, files: Map<string, string>, depth = 0): string {
  const literal = /^"([^"]*)"$|^'([^']*)'$/.exec(expr);
  if (literal) return literal[1] ?? literal[2]!;
  if (depth > 5 || !/^[A-Za-z_]\w*$/.test(expr)) throw new Error(`${file}: cannot resolve tool name expression ${expr}`);
  const assign = new RegExp(`^${expr}\\s*(?::[^=\\n]+)?=(?!=)\\s*([^\\n#]+?)\\s*(?:#.*)?$`, "gm");
  const defs = (text: string) => [...text.matchAll(assign)].map((m) => m[1]!);
  const local = defs(files.get(file)!);
  if (local.length === 1) return resolve(local[0]!, file, files, depth + 1);
  if (local.length > 1) throw new Error(`${file}: ${expr} is defined ${local.length} times`);
  const elsewhere = [...files].filter(([other]) => other !== file).flatMap(([other, text]) => defs(text).map((value) => [other, value] as const));
  if (elsewhere.length !== 1) throw new Error(`${file}: ${expr} has ${elsewhere.length} module-level definitions in the plugin's other files`);
  return resolve(elsewhere[0]![1], elsewhere[0]![0], files, depth + 1);
}

interface Inventory {
  /** tool name -> plugins that declare or register it */
  tools: Map<string, Set<string>>;
  /** what was found, for the failure messages and the report */
  found: string[];
  missingYaml: string[];
  problems: string[];
}

function inventory(): Inventory {
  const tools = new Map<string, Set<string>>();
  const found: string[] = [];
  const missingYaml: string[] = [];
  const problems: string[] = [];
  const add = (name: string, plugin: string, where: string) => {
    if (!tools.has(name)) tools.set(name, new Set());
    tools.get(name)!.add(plugin);
    found.push(`${plugin}: ${name} (${where})`);
  };
  for (const plugin of pluginDirs()) {
    const dir = join(PLUGINS, plugin);
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
    const files = new Map(pythonFiles(dir).map((path) => [relative(PLUGINS, path), readFileSync(path, "utf8")]));
    for (const [file, text] of files) {
      // An alias under another name would hide a registration from the scan below.
      for (const m of text.matchAll(/^\s*(\w+)\s*=\s*(?:getattr\(\s*\w+\s*,\s*["']register_tool["']|[\w.]+\.register_tool\b)/gm)) {
        if (m[1] !== "register_tool") problems.push(`${file}: register_tool aliased as ${m[1]}`);
      }
      for (const m of text.matchAll(/\bregister_tool\s*\(/g)) {
        const where = `${file} register_tool`;
        try {
          const expr = nameExpr(callArgs(text, m.index! + m[0].length - 1));
          const table = NAME_TABLES.find((t) => t.file === file && t.expr === expr);
          if (table) {
            const block = table.table.exec(text);
            if (!block) throw new Error(`${file}: the name table for ${expr} is gone`);
            const constants = [...block[1]!.matchAll(/\(\s*([A-Za-z_]\w*)\s*,/g)].map((c) => c[1]!);
            if (constants.length === 0) throw new Error(`${file}: the name table for ${expr} lists no names`);
            for (const constant of constants) add(resolve(constant, file, files), plugin, `${where}, ${constant} in the wanted table`);
          } else {
            add(resolve(expr, file, files), plugin, `${where}, name=${expr}`);
          }
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
  }
  return { tools, found, missingYaml, problems };
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
    // village_vote (_share_vote.py wanted table: SHARE_TOOL, VOTE_TOOL), recall (recall TOOL_NAME),
    // village (village-bridge literal).
    expect([...inv.tools.keys()].sort()).toEqual(["consent_status", "recall", "record_intention", "share_digest", "village", "village_vote"]);
    expect(inv.found.filter((f) => f.includes("register_tool")).length).toBeGreaterThanOrEqual(6);
  });

  test("each tool full-matches an APPROVAL_GATED_TOOLS pattern or has a NOT_GATED entry for its plugin, not both", () => {
    const bad: string[] = [];
    for (const [name, plugins] of [...inv.tools].sort()) {
      const entries = NOT_GATED.filter((e) => e.name === name);
      if (gated(name)) {
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
    expect(bad).toEqual([]);
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
    const dirs = new Set(pluginDirs());
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
