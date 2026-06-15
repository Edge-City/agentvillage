import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanImports } from "../imports-inbox";

let dir = "";
let previousCwd = "";

beforeEach(() => {
  previousCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "imports-inbox-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

test("scanImports detects new imports without printing content", () => {
  mkdirSync("imports", { recursive: true });
  writeFileSync("imports/edge-esmeralda-intro.md", "# Intro\n\nHello\n");

  const result = scanImports({ now: "2026-06-15T00:00:00.000Z" });

  expect(result.applied).toBe(false);
  expect(result.newOrChanged).toBe(1);
  expect(result.items[0].path).toBe("imports/edge-esmeralda-intro.md");
  expect(JSON.stringify(result)).not.toContain("Hello");
});

test("scanImports apply records hashes and later returns unchanged", () => {
  mkdirSync("imports", { recursive: true });
  writeFileSync("imports/a.md", "A\n");

  const first = scanImports({ apply: true, now: "2026-06-15T00:00:00.000Z" });
  const second = scanImports({ apply: true, now: "2026-06-15T01:00:00.000Z" });
  const state = JSON.parse(readFileSync("memory/imports-state.json", "utf8"));

  expect(first.newOrChanged).toBe(1);
  expect(second.unchanged).toBe(1);
  expect(state.imports["imports/a.md"].firstSeenAt).toBe("2026-06-15T00:00:00.000Z");
  expect(state.imports["imports/a.md"].lastSeenAt).toBe("2026-06-15T01:00:00.000Z");
});

test("scanImports skips hidden paths and oversized files", () => {
  mkdirSync("imports/.hidden", { recursive: true });
  mkdirSync("imports/nested", { recursive: true });
  writeFileSync("imports/.hidden/secret.md", "secret");
  writeFileSync("imports/nested/large.md", "x".repeat(256 * 1024 + 1));

  const result = scanImports();

  expect(result.scanned).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.items[0].reason).toBe("too large");
});
