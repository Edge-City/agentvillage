import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  INDEX_PLUGIN,
  INDEX_PLUGIN_SOURCE,
  NEGOTIATOR_SEED,
  installIndexPlugin,
  negotiatorPath,
} from "../install_index_plugin";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "av-index-plugin-"));
  roots.push(root);
  return root;
}

test("a home without the plugin installs it, enables it, and seeds the negotiator", () => {
  const dir = home();
  const calls: string[][] = [];
  installIndexPlugin((args) => calls.push(args), dir);
  expect(calls).toEqual([
    ["plugins", "install", INDEX_PLUGIN_SOURCE, "--enable"],
    ["plugins", "enable", INDEX_PLUGIN],
  ]);
  expect(readFileSync(negotiatorPath(dir), "utf8")).toBe(NEGOTIATOR_SEED);
});

test("an installed plugin is updated, and an existing negotiator file is kept", () => {
  const dir = home();
  mkdirSync(join(dir, "plugins", INDEX_PLUGIN), { recursive: true });
  writeFileSync(join(dir, "plugins", INDEX_PLUGIN, "plugin.yaml"), "name: index-network\n");
  mkdirSync(join(dir, "index"), { recursive: true });
  writeFileSync(negotiatorPath(dir), "export default async function negotiate() { return { turn: { action: \"counter\", message: \"ours\" } }; }\n");
  const calls: string[][] = [];
  installIndexPlugin((args) => calls.push(args), dir);
  expect(calls[0]).toEqual(["plugins", "update", INDEX_PLUGIN]);
  expect(readFileSync(negotiatorPath(dir), "utf8")).toContain("ours");
});
