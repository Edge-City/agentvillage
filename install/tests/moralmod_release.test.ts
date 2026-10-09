import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installMoralmodRelease, INDEX_PLUGIN_REVISION, MORALMOD_HOOK_VERSION } from "../moralmod_release";

function fixture() {
  const source = mkdtempSync(join(tmpdir(), "av-release-")), home = mkdtempSync(join(tmpdir(), "av-resident-"));
  const content = { "negotiator-core.js": "export const hookVersion='moralmod-lifecycle-2';", "INDEX-LICENSE": "fixture MIT license" };
  for (const [name, value] of Object.entries(content)) writeFileSync(join(source, name), value);
  const manifest = { schema: "moralmod-negotiator-release-1", hook_version: MORALMOD_HOOK_VERSION, hermes_plugin_revision: INDEX_PLUGIN_REVISION,
    bun_version: "1.3.6", files: Object.fromEntries(Object.entries(content).map(([name, value]) => [name, createHash("sha256").update(value).digest("hex")])) };
  writeFileSync(join(source, "release.json"), JSON.stringify(manifest));
  return { source, home, manifest, cleanup: () => { rmSync(source, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}
test("content addressed install is idempotent and preserves custom resident hook", () => {
  const f = fixture(); try {
    const first = installMoralmodRelease(f.home, f.source);
    writeFileSync(join(f.home, "index", "negotiator.ts"), "custom resident code");
    const again = installMoralmodRelease(f.home, f.source);
    expect(first.changed).toBe(true); expect(again.changed).toBe(false);
    expect(first.directory).toBe(again.directory);
    expect(readFileSync(join(f.home, "index", "negotiator.ts"), "utf8")).toBe("custom resident code");
  } finally { f.cleanup(); }
});
test("tampered source and installed files cannot be activated or overwritten", () => {
  const f = fixture(); try {
    writeFileSync(join(f.source, "negotiator-core.js"), "tampered");
    expect(() => installMoralmodRelease(f.home, f.source)).toThrow("digest mismatch");
  } finally { f.cleanup(); }
  const other = fixture(); try {
    const installed = installMoralmodRelease(other.home, other.source);
    writeFileSync(join(installed.directory, "negotiator-core.js"), "resident edit");
    expect(() => installMoralmodRelease(other.home, other.source)).toThrow("modified");
    expect(readFileSync(join(installed.directory, "negotiator-core.js"), "utf8")).toBe("resident edit");
  } finally { other.cleanup(); }
});
test("old hook, wrong plugin and additional release files fail before install", () => {
  for (const change of [{ hook_version: "old" }, { hermes_plugin_revision: "unreviewed" }, { files: { "../secret": "abc" } }]) {
    const f = fixture(); try {
      writeFileSync(join(f.source, "release.json"), JSON.stringify({ ...f.manifest, ...change }));
      expect(() => installMoralmodRelease(f.home, f.source)).toThrow("Incompatible");
    } finally { f.cleanup(); }
  }
});
