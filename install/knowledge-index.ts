#!/usr/bin/env bun
/**
 * Regenerates `$HERMES_HOME/knowledge/index.md`, the one-line-per-provider
 * list the agent starts from (docs/design/context-sources.md §2, §4; CX1 T2).
 *
 *   bun install/knowledge-index.ts [--home <dir>]
 *
 * `--home` defaults to `$HERMES_HOME`, then `~/.hermes`, as the other install
 * scripts do. Callers: the control plane's renderer after it writes
 * `knowledge/agentvillage/` (it tolerates this file being absent), the
 * edge-india knowledge sync after a swap (`regenerateKnowledgeIndex`, below),
 * and `install.ts` / `reset.ts` after `--wipe-user`.
 *
 * Output format (the whole file; no timestamp, so an unchanged tree renders
 * byte-identical text):
 *
 *   # Knowledge by provider (generated; do not edit)
 *   - agentvillage: 3 files, newest 2026-10-08, start at knowledge/agentvillage/index.md
 *   - edge-india: 1 file, newest 2026-10-07, start at knowledge/edge-india/index.md
 *   - goodreads: 0 files
 *
 * With no provider, the header and then one line:
 *
 *   Nothing here yet: no service has written anything for you.
 *
 * A provider is a directory directly under `knowledge/` whose name is a
 * provider id (`^[a-z0-9][a-z0-9-]{1,40}$`, the design's rule); lines are
 * sorted by name. Skipped, never followed and never read: dot-prefixed and
 * `_`-prefixed entries, symlinks, and anything that is not a directory (a name
 * that is not a provider id is skipped too, so no directory name can add text
 * of its own to a file the agent reads). "files" counts the provider's `.md`
 * files at its top level only, regular files (lstat), skipping `_`- and
 * dot-prefixed names; "newest" is the newest counted file's mtime as a UTC
 * date (absent with 0 files). "start at" appears when the provider has its
 * own `index.md` as a regular file. No file content is read, only the
 * previous `knowledge/index.md` to compare.
 *
 * Writes: a temp file in `knowledge/` (`.index.md.tmp-<pid>-<hex>`, mode 0600)
 * renamed over `index.md`, and only when the text changed (no mtime churn).
 * `knowledge/` missing: creates nothing (the renderer creates the directory),
 * one line, exit 0. `knowledge/` a symlink or not a directory: nothing
 * written, one line, exit 0. Exit 1 only on an unexpected error, with one
 * line on stderr; exit 2 on a usage error. Runs as the agent user; no network.
 */

import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";

import { hermesHome } from "./paths";

export const INDEX_FILE = "index.md";
export const INDEX_HEADER = "# Knowledge by provider (generated; do not edit)";
export const EMPTY_LINE = "Nothing here yet: no service has written anything for you.";
/** The design's provider id rule (§2). */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export interface ProviderEntry {
  name: string;
  files: number;
  /** Newest counted file's mtime (ms), or null with no files. */
  newestMs: number | null;
  hasIndex: boolean;
}

export type KnowledgeIndexStatus = "written" | "unchanged" | "no-knowledge-dir" | "not-a-directory";

export interface KnowledgeIndexResult {
  status: KnowledgeIndexStatus;
  providers: number;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function skippedName(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_");
}

/** The provider directories under `knowledgeDir`, sorted by name; lstat only. */
export function listProviders(knowledgeDir: string): ProviderEntry[] {
  const out: ProviderEntry[] = [];
  for (const name of readdirSync(knowledgeDir).sort()) {
    if (skippedName(name) || !PROVIDER_ID_RE.test(name)) continue;
    const dir = join(knowledgeDir, name);
    const st = lstatOrNull(dir);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    let files = 0;
    let newestMs: number | null = null;
    for (const file of readdirSync(dir)) {
      if (skippedName(file) || !file.endsWith(".md")) continue;
      const fst = lstatOrNull(join(dir, file));
      if (!fst || fst.isSymbolicLink() || !fst.isFile()) continue;
      files++;
      if (newestMs === null || fst.mtimeMs > newestMs) newestMs = fst.mtimeMs;
    }
    const index = lstatOrNull(join(dir, INDEX_FILE));
    out.push({ name, files, newestMs, hasIndex: index !== null && index.isFile() && !index.isSymbolicLink() });
  }
  return out;
}

/** The text of `knowledge/index.md` for these providers (see the file header). */
export function renderKnowledgeIndex(providers: ProviderEntry[]): string {
  const lines = [INDEX_HEADER];
  if (providers.length === 0) lines.push(EMPTY_LINE);
  for (const p of providers) {
    let line = `- ${p.name}: ${p.files} ${p.files === 1 ? "file" : "files"}`;
    if (p.newestMs !== null) line += `, newest ${new Date(p.newestMs).toISOString().slice(0, 10)}`;
    if (p.hasIndex) line += `, start at knowledge/${p.name}/${INDEX_FILE}`;
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Regenerate `<home>/knowledge/index.md`. Handled cases return a status;
 * an unexpected error (an unreadable directory, a failed write) throws, and
 * leaves no temp file behind.
 */
export function regenerateKnowledgeIndex(home: string = hermesHome()): KnowledgeIndexResult {
  const dir = join(home, "knowledge");
  const st = lstatOrNull(dir);
  if (!st) return { status: "no-knowledge-dir", providers: 0 };
  if (st.isSymbolicLink() || !st.isDirectory()) return { status: "not-a-directory", providers: 0 };

  const providers = listProviders(dir);
  const text = renderKnowledgeIndex(providers);
  const target = join(dir, INDEX_FILE);
  const existing = lstatOrNull(target);
  if (existing && existing.isFile() && !existing.isSymbolicLink()) {
    if (readFileSync(target, "utf8") === text) return { status: "unchanged", providers: providers.length };
  }
  const tmp = join(dir, `.${INDEX_FILE}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { status: "written", providers: providers.length };
}

/** One line describing a result, for the CLI and the installer logs. */
export function describeResult(result: KnowledgeIndexResult): string {
  switch (result.status) {
    case "written":
      return `knowledge-index: wrote knowledge/${INDEX_FILE} (${result.providers} provider(s))`;
    case "unchanged":
      return `knowledge-index: knowledge/${INDEX_FILE} unchanged (${result.providers} provider(s))`;
    case "no-knowledge-dir":
      return "knowledge-index: no knowledge/ directory; nothing written";
    case "not-a-directory":
      return "knowledge-index: knowledge/ is not a plain directory; nothing written";
  }
}

/** `--home <dir>` / `--home=<dir>`; anything else is a usage error. */
export function parseHomeArg(argv: string[]): { home: string } | { error: string } {
  let home: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--home") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--") || next.trim() === "") return { error: "--home requires a directory" };
      home = next;
      i++;
    } else if (arg.startsWith("--home=") && arg.length > "--home=".length) {
      home = arg.slice("--home=".length);
    } else {
      return { error: "usage: bun install/knowledge-index.ts [--home <dir>]" };
    }
  }
  return { home: resolve(home ?? hermesHome()) };
}

export function main(argv: string[]): number {
  const parsed = parseHomeArg(argv);
  if ("error" in parsed) {
    process.stderr.write(`knowledge-index: ${parsed.error}\n`);
    return 2;
  }
  try {
    console.log(describeResult(regenerateKnowledgeIndex(parsed.home)));
    return 0;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    process.stderr.write(`knowledge-index: error ${typeof code === "string" ? code : "unexpected"}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
