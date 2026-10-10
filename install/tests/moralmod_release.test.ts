import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installMoralmodRelease, INDEX_PLUGIN_REVISION, MORALMOD_HOOK_VERSION, MORALMOD_RELEASE_SHA256, MoralmodReleaseUnpinned } from "../moralmod_release";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** The digest a reviewer would pin for the release.json now in `source`. */
const pinOf = (source: string) => sha256(readFileSync(join(source, "release.json")));

function fixture() {
  const source = mkdtempSync(join(tmpdir(), "av-release-")), home = mkdtempSync(join(tmpdir(), "av-resident-"));
  const content = { "negotiator-core.js": "export const hookVersion='moralmod-lifecycle-2';", "negotiator-runtime.js": "export async function startResident(){return {port:1,stop(){}}}", "INDEX-LICENSE": "fixture MIT license" };
  for (const [name, value] of Object.entries(content)) writeFileSync(join(source, name), value);
  const manifest = { schema: "moralmod-negotiator-release-1", hook_version: MORALMOD_HOOK_VERSION, hermes_plugin_revision: INDEX_PLUGIN_REVISION,
    bun_version: "1.4.2", files: Object.fromEntries(Object.entries(content).map(([name, value]) => [name, createHash("sha256").update(value).digest("hex")])) };
  writeFileSync(join(source, "release.json"), JSON.stringify(manifest));
  return { source, home, manifest, cleanup: () => { rmSync(source, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}
test("content addressed install is idempotent and preserves custom resident hook", () => {
  const f = fixture(); try {
    const first = installMoralmodRelease(f.home, f.source, pinOf(f.source));
    writeFileSync(join(f.home, "index", "negotiator.ts"), "custom resident code");
    const again = installMoralmodRelease(f.home, f.source, pinOf(f.source));
    expect(first.changed).toBe(true); expect(again.changed).toBe(false);
    expect(first.directory).toBe(again.directory);
    expect(readFileSync(join(f.home, "index", "negotiator.ts"), "utf8")).toBe("custom resident code");
  } finally { f.cleanup(); }
});
test("tampered source and installed files cannot be activated or overwritten", () => {
  const f = fixture(); try {
    writeFileSync(join(f.source, "negotiator-core.js"), "tampered");
    expect(() => installMoralmodRelease(f.home, f.source, pinOf(f.source))).toThrow("digest mismatch");
  } finally { f.cleanup(); }
  const other = fixture(); try {
    const installed = installMoralmodRelease(other.home, other.source, pinOf(other.source));
    writeFileSync(join(installed.directory, "negotiator-core.js"), "resident edit");
    expect(() => installMoralmodRelease(other.home, other.source, pinOf(other.source))).toThrow("modified");
    expect(readFileSync(join(installed.directory, "negotiator-core.js"), "utf8")).toBe("resident edit");
  } finally { other.cleanup(); }
});
test("old hook, wrong runtime/plugin and additional release files fail before install", () => {
  for (const change of [{ hook_version: "old" }, { bun_version: "1.3.6" }, { bun_version: "1.4.3" }, { hermes_plugin_revision: "unreviewed" }, { files: { "../secret": "abc" } }]) {
    const f = fixture(); try {
      writeFileSync(join(f.source, "release.json"), JSON.stringify({ ...f.manifest, ...change }));
      // Pinned as written, so the refusal is the manifest check's own, not the pin's.
      expect(() => installMoralmodRelease(f.home, f.source, pinOf(f.source))).toThrow("Incompatible");
    } finally { f.cleanup(); }
  }
});

describe("OV-249 post-hoc M2: the release must be the one pinned in MORALMOD_RELEASE_SHA256", () => {
  test("the shipped pin identifies the reviewed public release manifest", () => {
    expect(MORALMOD_RELEASE_SHA256).toBe("93eab95f9ed270e500c694b79f2c48b5950c30cd1553e0ce75383774f558d2a1");
  });

  test("a self-consistent bundle (every file matches its own release.json) is refused under the shipped pin; nothing is written", () => {
    const f = fixture(); try {
      expect(() => installMoralmodRelease(f.home, f.source)).toThrow(MoralmodReleaseUnpinned);
      expect(existsSync(join(f.home, "index"))).toBe(false);
    } finally { f.cleanup(); }
  });

  test("a pin that is a sha256 but not this release.json's is refused; a different but self-consistent release under another bundle's pin is refused", () => {
    const f = fixture(), other = fixture(); try {
      expect(() => installMoralmodRelease(f.home, f.source, "0".repeat(64))).toThrow(MoralmodReleaseUnpinned);
      expect(() => installMoralmodRelease(f.home, f.source, pinOf(f.source).toUpperCase())).toThrow(MoralmodReleaseUnpinned);
      // A rebuilt bundle with other bytes and a release.json that lists their own hashes.
      writeFileSync(join(other.source, "negotiator-runtime.js"), "export async function startResident(){ /* unreviewed */ }");
      writeFileSync(join(other.source, "release.json"), JSON.stringify({ ...other.manifest, files: { ...other.manifest.files, "negotiator-runtime.js": sha256(readFileSync(join(other.source, "negotiator-runtime.js"))) } }));
      expect(() => installMoralmodRelease(other.home, other.source, pinOf(f.source))).toThrow(MoralmodReleaseUnpinned);
      expect(existsSync(join(f.home, "index"))).toBe(false);
      expect(existsSync(join(other.home, "index"))).toBe(false);
    } finally { f.cleanup(); other.cleanup(); }
  });

  test("the pinned digest, computed from the fixture, installs under index/moralmod/<that digest>", () => {
    const f = fixture(); try {
      const pin = pinOf(f.source);
      const installed = installMoralmodRelease(f.home, f.source, pin);
      expect(installed.releaseDigest).toBe(pin);
      expect(installed.directory).toBe(join(f.home, "index", "moralmod", pin));
      expect(readFileSync(join(installed.directory, "release.json"), "utf8")).toBe(readFileSync(join(f.source, "release.json"), "utf8"));
    } finally { f.cleanup(); }
  });
});
