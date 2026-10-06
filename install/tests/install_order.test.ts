/**
 * N3 (R3 fix round 2): the av-approval plugin is staged only after the approval
 * step wrote the hooks block its matcher list checks, so a failed step on an
 * upgrade never leaves a newer plugin (more matchers) against an older block
 * (fewer entries): `hook-missing` at the next gateway start would block every
 * gated call. A fresh install still stages it first, so a later failure leaves
 * the backstop in place (fail closed).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { APPROVAL_GATED_TOOLS, APPROVAL_PLUGIN, stagePlugins } from "../install_approval";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function plugin(root: string, name: string, marker: string): void {
  mkdirSync(join(root, name, "tests"), { recursive: true });
  writeFileSync(join(root, name, "__init__.py"), `MARKER = ${JSON.stringify(marker)}\n`);
  writeFileSync(join(root, name, "plugin.yaml"), `name: ${name}\n`);
  writeFileSync(join(root, name, "tests", "test_x.py"), "# not staged\n");
}
function world() {
  const root = mkdtempSync(join(tmpdir(), "av-install-order-"));
  roots.push(root);
  const source = join(root, "src");
  const target = join(root, "home", "plugins");
  plugin(source, APPROVAL_PLUGIN, "new: 35 matchers");
  plugin(source, "av-events", "new events");
  writeFileSync(join(source, "README.md"), "# not a plugin\n");
  return { source, target };
}
const marker = (target: string, name: string) => readFileSync(join(target, name, "__init__.py"), "utf8");

describe("stagePlugins: av-approval waits for the approval step on an upgrade", () => {
  test("upgrade: before the step every other plugin is staged and the installed av-approval is kept; after it, av-approval is staged", () => {
    const { source, target } = world();
    plugin(target, APPROVAL_PLUGIN, "old: 13 matchers");
    plugin(target, "av-events", "old events");
    expect(stagePlugins(source, target, "before-approval")).toBe(2);
    expect(marker(target, "av-events")).toContain("new events");
    expect(marker(target, APPROVAL_PLUGIN)).toContain("old: 13 matchers");
    // The step succeeded: av-approval now, and nothing else again.
    expect(stagePlugins(source, target, "after-approval")).toBe(2);
    expect(marker(target, APPROVAL_PLUGIN)).toContain("new: 35 matchers");
  });

  test("upgrade whose approval step fails: the installed av-approval stays the one its hooks block was written for", () => {
    const { source, target } = world();
    plugin(target, APPROVAL_PLUGIN, "old: 13 matchers");
    stagePlugins(source, target, "before-approval");
    // runApprovalStep returned false: install.ts exits before the after-approval stage.
    expect(marker(target, APPROVAL_PLUGIN)).toContain("old: 13 matchers");
  });

  test("fresh install: av-approval is staged before the step too (a later failure still leaves the backstop, fail closed); staging again is idempotent", () => {
    const { source, target } = world();
    expect(stagePlugins(source, target, "before-approval")).toBe(4);
    expect(marker(target, APPROVAL_PLUGIN)).toContain("new: 35 matchers");
    expect(marker(target, "av-events")).toContain("new events");
    expect(stagePlugins(source, target, "after-approval")).toBe(2);
    expect(marker(target, APPROVAL_PLUGIN)).toContain("new: 35 matchers");
  });

  test("a missing source stages nothing", () => {
    const { target } = world();
    expect(stagePlugins(join(target, "absent"), target, "before-approval")).toBe(0);
  });
});

describe("install.ts runs the stages in that order", () => {
  const text = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  const main = text.slice(text.indexOf("function main(): void {"));

  test("before-approval, then the approval step (exit on failure), then after-approval, then the restart; no other plugin copy", () => {
    const at = (needle: string) => {
      const i = main.indexOf(needle);
      expect([needle, i >= 0]).toEqual([needle, true]);
      expect([needle, main.indexOf(needle, i + 1)]).toEqual([needle, -1]);
      return i;
    };
    const before = at('copyPluginFiles("before-approval");');
    const step = at("if (!runApprovalStep(SOURCE_SKILLS)) {");
    const exit = at("process.exit(1);");
    const after = at('copyPluginFiles("after-approval");');
    const restart = at("restartGateway();");
    expect(before < step && step < exit && exit < after && after < restart).toBe(true);
    // The only plugin copy is stagePlugins: no direct copyPluginTree in the installer.
    expect(text).not.toContain("copyPluginTree(");
    expect(text).toContain("stagePlugins(SOURCE_PLUGINS, target, phase)");
  });

  test("the plugin's matcher list is the installer's (what the order protects)", () => {
    const py = readFileSync(join(import.meta.dir, "..", "..", "plugins", APPROVAL_PLUGIN, "__init__.py"), "utf8");
    const block = py.slice(py.indexOf("GATED_MATCHERS: tuple[str, ...] = ("), py.indexOf("\n)\n", py.indexOf("GATED_MATCHERS")));
    const listed = [...block.matchAll(/^ {4}"([^"]+)",$/gm)].map((m) => m[1]);
    expect(listed).toEqual([...APPROVAL_GATED_TOOLS]);
    expect(listed).toHaveLength(35);
  });
});
