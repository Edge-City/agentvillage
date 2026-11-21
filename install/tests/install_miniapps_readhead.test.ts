// Security review of overlay main 7b754357 (data L20072): the skills/** walk and ownedFile read a SKILL.md from ONE
// open handle, bounded, never through a link, and never block on a FIFO or device swapped in after readdir.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHead, reconcileMiniApps } from "../install_miniapps";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const home = () => { const root = mkdtempSync(join(tmpdir(), "curated-miniapps-readhead-")); roots.push(root); return root; };

test("readHead: a FIFO or a directory is not a regular file (null, no hang); a link is never followed", () => {
  const root = home();
  const fifo = join(root, "fifo");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  const started = Date.now();
  expect(readHead(fifo, 65536)).toBeNull();
  expect(Date.now() - started).toBeLessThan(2000);
  mkdirSync(join(root, "dir"));
  expect(readHead(join(root, "dir"), 65536)).toBeNull();
  writeFileSync(join(root, "real"), "x");
  symlinkSync(join(root, "real"), join(root, "link"));
  expect(() => readHead(join(root, "link"), 65536)).toThrow();
});

test("readHead: at most max bytes, with the real size from the same handle", () => {
  const root = home();
  const path = join(root, "big");
  writeFileSync(path, Buffer.alloc(200000, 0x61));
  const file = readHead(path, 65536)!;
  expect(file.bytes.length).toBe(65536);
  expect(file.size).toBe(200000);
  writeFileSync(join(root, "small"), "---\nname: x\n---\n");
  expect(readHead(join(root, "small"), 65536)!.bytes.toString("utf8")).toBe("---\nname: x\n---\n");
});

test("a FIFO SKILL.md under skills/** never stalls the reconcile, and Gold Stars still stages", () => {
  const root = home();
  mkdirSync(join(root, "skills", "cat", "odd"), { recursive: true });
  expect(spawnSync("mkfifo", [join(root, "skills", "cat", "odd", "SKILL.md")]).status).toBe(0);
  const gold = { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status", "rolodex.person"], skills: ["gold-stars"] };
  const generic = { id: "civic-board", version: "1.0.0", operations: ["mini-app.read"], skills: ["civic-board"] };
  const started = Date.now();
  const receipt = reconcileMiniApps({ version: 1, apps: [gold, generic] }, root) as { apps: { id: string }[] };
  expect(Date.now() - started).toBeLessThan(5000);
  expect(receipt.apps.map(a => a.id)).toEqual(["gold-stars"]);
});
