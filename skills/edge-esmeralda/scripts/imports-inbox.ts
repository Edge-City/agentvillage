#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export interface ImportRecord {
  sha256: string;
  bytes: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ImportsState {
  version: 1;
  lastScannedAt?: string;
  imports: Record<string, ImportRecord>;
}

export interface ImportScanItem {
  path: string;
  sha256: string;
  bytes: number;
  status: "new" | "changed" | "unchanged" | "skipped";
  reason?: string;
}

export interface ImportScanResult {
  applied: boolean;
  importsRoot: string;
  stateFile: string;
  scanned: number;
  newOrChanged: number;
  unchanged: number;
  skipped: number;
  items: ImportScanItem[];
}

export const DEFAULT_IMPORTS_ROOT = "imports";
export const DEFAULT_STATE_FILE = "memory/imports-state.json";
export const MAX_IMPORT_BYTES = 256 * 1024;

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function loadState(stateFile: string): ImportsState {
  if (!existsSync(stateFile)) return { version: 1, imports: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<ImportsState>;
    return {
      version: 1,
      lastScannedAt: typeof parsed.lastScannedAt === "string" ? parsed.lastScannedAt : undefined,
      imports: parsed.imports && typeof parsed.imports === "object" ? parsed.imports as Record<string, ImportRecord> : {},
    };
  } catch {
    return { version: 1, imports: {} };
  }
}

function writeState(stateFile: string, state: ImportsState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function isSafeImportPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith("..") || relPath.includes("\0")) return false;
  const parts = relPath.split(sep);
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  return relPath.endsWith(".md");
}

function walkMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out.sort();
}

export function scanImports({
  importsRoot = DEFAULT_IMPORTS_ROOT,
  stateFile = DEFAULT_STATE_FILE,
  apply = false,
  now = new Date().toISOString(),
}: {
  importsRoot?: string;
  stateFile?: string;
  apply?: boolean;
  now?: string;
} = {}): ImportScanResult {
  const state = loadState(stateFile);
  const items: ImportScanItem[] = [];

  for (const fullPath of walkMarkdownFiles(importsRoot)) {
    const relPath = relative(process.cwd(), fullPath);
    const importRel = relative(importsRoot, fullPath);
    if (!isSafeImportPath(importRel)) {
      items.push({ path: relPath, sha256: "", bytes: 0, status: "skipped", reason: "unsafe path" });
      continue;
    }
    const stat = statSync(fullPath);
    if (stat.size > MAX_IMPORT_BYTES) {
      items.push({ path: relPath, sha256: "", bytes: stat.size, status: "skipped", reason: "too large" });
      continue;
    }
    const content = readFileSync(fullPath);
    const sha256 = sha256Hex(content);
    const existing = state.imports[relPath];
    const status = !existing ? "new" : existing.sha256 === sha256 ? "unchanged" : "changed";
    items.push({ path: relPath, sha256, bytes: stat.size, status });
    if (apply && status !== "unchanged") {
      state.imports[relPath] = {
        sha256,
        bytes: stat.size,
        firstSeenAt: existing?.firstSeenAt || now,
        lastSeenAt: now,
      };
    } else if (apply && existing) {
      state.imports[relPath] = { ...existing, lastSeenAt: now };
    }
  }

  if (apply) {
    state.lastScannedAt = now;
    writeState(stateFile, state);
  }

  return {
    applied: apply,
    importsRoot,
    stateFile,
    scanned: items.filter((item) => item.status !== "skipped").length,
    newOrChanged: items.filter((item) => item.status === "new" || item.status === "changed").length,
    unchanged: items.filter((item) => item.status === "unchanged").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    items,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`Usage: bun skills/edge-esmeralda/scripts/imports-inbox.ts [--apply] [--imports-root imports] [--state-file memory/imports-state.json]\n\nScans Markdown imports and records content hashes. It never prints file contents.`);
    process.exit(0);
  }
  const result = scanImports({
    importsRoot: argValue(args, "--imports-root") || DEFAULT_IMPORTS_ROOT,
    stateFile: argValue(args, "--state-file") || DEFAULT_STATE_FILE,
    apply: hasFlag(args, "--apply"),
  });
  console.log(JSON.stringify(result, null, 2));
}
