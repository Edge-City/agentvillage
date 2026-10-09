/**
 * CX1 T2: install/knowledge-index.ts, the regenerator of
 * `$HERMES_HOME/knowledge/index.md` (docs/design/context-sources.md §4).
 * Fixtures only: temp homes, no network.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMPTY_LINE, INDEX_HEADER, parseHomeArg, regenerateKnowledgeIndex } from "../knowledge-index";

const SCRIPT = join(import.meta.dir, "..", "knowledge-index.ts");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-knowledge-index-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function put(rel: string, body = "x\n", mtime?: string): void {
  const path = join(home, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  if (mtime) utimesSync(path, new Date(mtime), new Date(mtime));
}

function indexText(): string {
  return readFileSync(join(home, "knowledge", "index.md"), "utf8");
}

function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: ["bun", SCRIPT, ...args],
    env: { ...process.env, HERMES_HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("a missing knowledge/ creates nothing and exits 0 with one line", () => {
  expect(regenerateKnowledgeIndex(home)).toEqual({ status: "no-knowledge-dir", providers: 0 });
  expect(existsSync(join(home, "knowledge"))).toBe(false);

  const out = run([]);
  expect(out.exitCode).toBe(0);
  expect(out.stdout.toString().trim().split("\n")).toEqual(["knowledge-index: no knowledge/ directory; nothing written"]);
  expect(existsSync(join(home, "knowledge"))).toBe(false);
});

test("an empty knowledge/ gets the header and the nothing-yet line", () => {
  mkdirSync(join(home, "knowledge"));
  expect(regenerateKnowledgeIndex(home)).toEqual({ status: "written", providers: 0 });
  expect(indexText()).toBe(`${INDEX_HEADER}\n${EMPTY_LINE}\n`);
});

test("two providers with mixed files: only top-level, plain .md files count; dot, _, symlinks and non-dirs skipped", () => {
  // agentvillage: two counted files plus its own index.md; skipped: _draft.md, .hidden.md, a .json, a symlinked file, a subdirectory's file.
  put("knowledge/agentvillage/index.md", "| file |\n", "2026-10-01T10:00:00Z");
  put("knowledge/agentvillage/note-1.md", "a\n", "2026-10-03T23:30:00Z");
  put("knowledge/agentvillage/upload-2.md", "b\n", "2026-10-02T00:00:00Z");
  put("knowledge/agentvillage/_draft.md", "draft\n", "2026-10-09T00:00:00Z");
  put("knowledge/agentvillage/.hidden.md", "hidden\n", "2026-10-09T00:00:00Z");
  put("knowledge/agentvillage/_manifest.json", "{}\n", "2026-10-09T00:00:00Z");
  put("knowledge/agentvillage/notes.txt", "t\n", "2026-10-09T00:00:00Z");
  put("knowledge/agentvillage/sub/deep.md", "d\n", "2026-10-09T00:00:00Z");
  put("outside/target.md", "outside\n", "2026-10-09T00:00:00Z");
  symlinkSync(join(home, "outside", "target.md"), join(home, "knowledge", "agentvillage", "linked.md"));
  // edge-india: one file, no index.md.
  put("knowledge/edge-india/wiki-content.md", "w\n", "2026-09-30T12:00:00Z");
  put("knowledge/edge-india/_sync.json", "{}\n");
  // Skipped at the top: a symlinked dir, dot and _ dirs, a plain file, a name that is not a provider id.
  mkdirSync(join(home, "outside", "dir"), { recursive: true });
  put("outside/dir/a.md");
  symlinkSync(join(home, "outside", "dir"), join(home, "knowledge", "linked-provider"));
  put("knowledge/.edge-india.lock/x.md");
  put("knowledge/_staging/x.md");
  put("knowledge/stray.md");
  put("knowledge/Not A Provider/x.md");

  expect(regenerateKnowledgeIndex(home)).toEqual({ status: "written", providers: 2 });
  expect(indexText()).toBe([
    INDEX_HEADER,
    "- agentvillage: 3 files, newest 2026-10-03, start at knowledge/agentvillage/index.md",
    "- edge-india: 1 file, newest 2026-09-30",
    "",
  ].join("\n"));
});

test("a provider with no counted files is listed with 0 files and no date", () => {
  put("knowledge/goodreads/_draft.md");
  regenerateKnowledgeIndex(home);
  expect(indexText()).toBe(`${INDEX_HEADER}\n- goodreads: 0 files\n`);
});

test("idempotent: an unchanged tree leaves index.md (and its mtime) alone; a change rewrites it", () => {
  put("knowledge/agentvillage/note-1.md", "a\n", "2026-10-03T00:00:00Z");
  expect(regenerateKnowledgeIndex(home).status).toBe("written");
  const index = join(home, "knowledge", "index.md");
  const old = new Date("2026-01-01T00:00:00Z");
  utimesSync(index, old, old);

  expect(regenerateKnowledgeIndex(home)).toEqual({ status: "unchanged", providers: 1 });
  expect(statSync(index).mtimeMs).toBe(old.getTime());

  const out = run(["--home", home], { HERMES_HOME: join(home, "elsewhere") });
  expect(out.exitCode).toBe(0);
  expect(out.stdout.toString()).toContain("unchanged");
  expect(statSync(index).mtimeMs).toBe(old.getTime());

  put("knowledge/agentvillage/note-2.md", "b\n", "2026-10-05T00:00:00Z");
  expect(regenerateKnowledgeIndex(home).status).toBe("written");
  expect(indexText()).toContain("- agentvillage: 2 files, newest 2026-10-05");
});

test("the write is atomic: no temp file is left, and a symlinked index.md is replaced, not written through", () => {
  put("knowledge/agentvillage/note-1.md");
  put("outside/victim.md", "keep\n");
  symlinkSync(join(home, "outside", "victim.md"), join(home, "knowledge", "index.md"));
  expect(regenerateKnowledgeIndex(home).status).toBe("written");
  expect(readdirSync(join(home, "knowledge")).sort()).toEqual(["agentvillage", "index.md"]);
  expect(readFileSync(join(home, "outside", "victim.md"), "utf8")).toBe("keep\n");
  expect(indexText().startsWith(INDEX_HEADER)).toBe(true);
});

test("a failed write throws, leaves no temp file, and the CLI exits 1 with one stderr line", () => {
  put("knowledge/agentvillage/note-1.md");
  mkdirSync(join(home, "knowledge", "index.md")); // rename over a directory fails
  expect(() => regenerateKnowledgeIndex(home)).toThrow();
  expect(readdirSync(join(home, "knowledge")).filter((name) => name.includes(".tmp-"))).toEqual([]);

  const out = run([]);
  expect(out.exitCode).toBe(1);
  expect(out.stderr.toString().trim().split("\n")).toHaveLength(1);
  expect(out.stderr.toString()).toStartWith("knowledge-index: error ");
});

test("a symlinked knowledge/ is refused: nothing written through it, exit 0", () => {
  mkdirSync(join(home, "outside"));
  symlinkSync(join(home, "outside"), join(home, "knowledge"));
  expect(regenerateKnowledgeIndex(home)).toEqual({ status: "not-a-directory", providers: 0 });
  expect(readdirSync(join(home, "outside"))).toEqual([]);
  expect(run([]).exitCode).toBe(0);
});

test("--home parsing: the flag wins over HERMES_HOME; a bad flag is a usage error (exit 2)", () => {
  expect(parseHomeArg(["--home", "/h"])).toEqual({ home: "/h" });
  expect(parseHomeArg(["--home=/h2"])).toEqual({ home: "/h2" });
  expect(parseHomeArg(["--home"])).toHaveProperty("error");
  expect(parseHomeArg(["--bogus"])).toHaveProperty("error");
  expect(run(["--bogus"]).exitCode).toBe(2);
});
