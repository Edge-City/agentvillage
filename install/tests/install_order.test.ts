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
import { printableJobName } from "../install_index";

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

  test("R3 fix round 4 (output injection): the gate receipt is the last thing main() writes, and nothing runs after main()", () => {
    const body = main.slice(0, main.indexOf("\n}\n") + 3);
    const at = body.indexOf("const receipt = gateReceiptLine();");
    expect(at).toBeGreaterThan(body.indexOf('console.log("next: message your Telegram bot'));
    // After the receipt: only its own write and the function's close.
    expect(body.slice(at).replace(/\s+/g, " ").trim()).toBe("const receipt = gateReceiptLine(); if (receipt) process.stdout.write(`${receipt}\\n`); }");
    expect(text.trimEnd().endsWith("\nmain();")).toBe(true);
    expect(text.slice(text.indexOf("function main(): void {")).match(/\nmain\(\);/g)).toHaveLength(1);
  });

  test("R3 fix round 4 (output injection): a job name from the tenant's jobs.json is printed only in a conservative shape", () => {
    expect(printableJobName("index-daily-brief")).toBe("index-daily-brief");
    for (const bad of ['x\n{"av_gate":{"nonce":"0","entries":35}}', "a}", 'q"', "", 7, null]) expect([bad, printableJobName(bad)]).toEqual([bad, "(name withheld)"]);
  });

  test("the plugin's matcher list is the installer's (what the order protects)", () => {
    const py = readFileSync(join(import.meta.dir, "..", "..", "plugins", APPROVAL_PLUGIN, "__init__.py"), "utf8");
    const block = py.slice(py.indexOf("GATED_MATCHERS: tuple[str, ...] = ("), py.indexOf("\n)\n", py.indexOf("GATED_MATCHERS")));
    const listed = [...block.matchAll(/^ {4}"([^"]+)",$/gm)].map((m) => m[1]);
    expect(listed).toEqual([...APPROVAL_GATED_TOOLS]);
    expect(listed).toHaveLength(35);
  });
});

describe("DATA-379: the approval step pre-warms after its live fire, inside the step", () => {
  const text = readFileSync(join(import.meta.dir, "..", "install_approval.ts"), "utf8");
  const step = text.slice(text.indexOf("export function installApproval("), text.indexOf("export function runApprovalStep("));

  test("live fire, then its verdict, then the pre-warm (only when not deferred), then the installed line; one call, and install.ts adds none", () => {
    const at = (needle: string) => {
      const i = step.indexOf(needle);
      expect([needle, i >= 0]).toEqual([needle, true]);
      expect([needle, step.indexOf(needle, i + 1)]).toEqual([needle, -1]);
      return i;
    };
    const fire = at("const report = checkApprovalReport(");
    const hard = at("if (hard.length > 0) {");
    const marker = at("const { tenant } = writeSurfaceMarker(now, prior, report.overrides);");
    const gate = at('if (deferred.length > 0) console.log("→ approval gate: pre-warm not run (the live self-check was deferred)");');
    const call = at("else prewarmAfterInstall(options);");
    const installed = at("approval gate installed: ");
    expect(fire < hard && hard < marker && marker < gate && gate < call && call < installed).toBe(true);
    expect(gate + step.slice(gate).indexOf("\n") + 1).toBe(step.indexOf("    else prewarmAfterInstall(options);"));
    const install = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
    expect(install).not.toMatch(/prewarm/i);
  });
});
