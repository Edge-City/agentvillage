/**
 * ov#282: interrupted activation recovers on retry. The actual pinned plugin checkout and synthetic
 * verified releases, with controlled failures at each of activateMoralmod's atomic replacements.
 * A retry recognizes only the exact loader generated from the verified release it is handed (or the
 * loader active.json records, or the plugin's own file); the managed marker alone never authorizes
 * customized bytes.
 */
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { activateMoralmod, residentConfiguration } from "../moralmod_host";
import { INDEX_PLUGIN_REVISION, installMoralmodRelease } from "../moralmod_release";
import { NEGOTIATOR_SEED, negotiatorPath } from "../install_index_plugin";

// The pinned plugin checkout, as moralmod_arm_pin.test.ts finds it (CI: AV_INDEX_PLUGIN_TEST_DIR).
const plugin = resolve(process.env.AV_INDEX_PLUGIN_TEST_DIR ?? resolve(import.meta.dir, "../../../index-hermes-plugin"));
const havePlugin =
  fs.existsSync(plugin) && Bun.spawnSync(["git", "cat-file", "-e", `${INDEX_PLUGIN_REVISION}^{commit}`], { cwd: plugin }).exitCode === 0;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const rename = fs.renameSync;

function fixture() {
  const home = fs.mkdtempSync(join(tmpdir(), "mm-activation-"));
  try {
    fs.mkdirSync(join(home, "plugins"));
    const dest = join(home, "plugins", "index-network");
    for (const args of [["git", "clone", "--quiet", plugin, dest], ["git", "-C", dest, "checkout", "--quiet", INDEX_PLUGIN_REVISION]]) {
      if (Bun.spawnSync(args).exitCode) throw Error("Missing pinned Index plugin test checkout; set AV_INDEX_PLUGIN_TEST_DIR");
    }
    fs.mkdirSync(join(home, "index"));
    fs.writeFileSync(negotiatorPath(home), NEGOTIATOR_SEED);
    const configPath = join(home, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      DECISION_SERVICE_URL: "http://127.0.0.1:1", DECISION_EXPERIMENT_ID: crypto.randomUUID(),
      DECISION_INPUT_KIND: "synthetic", DECISION_RUNTIME_REVISION: "test-only",
      VILLAGE_CONTROL_PLANE_URL: "http://127.0.0.1:2", VILLAGE_SUBJECT_REF: "mm_" + "a".repeat(32),
      VILLAGE_INSTALLATION_CREDENTIAL: "test-only-resident-credential".repeat(2),
    }), { mode: 0o600 });
    const config = residentConfiguration(configPath);
    // A self-consistent synthetic release, installed under its own pin (the test seam).
    const release = (version: string) => {
      const source = join(home, "source-" + version);
      fs.mkdirSync(source);
      const files = Object.fromEntries(["negotiator-core.js", "negotiator-runtime.js", "INDEX-LICENSE"].map(name => {
        const body = `Synthetic activation fixture ${version}: ${name}\n`;
        fs.writeFileSync(join(source, name), body);
        return [name, hash(body)];
      }));
      const manifest = JSON.stringify({ schema: "moralmod-negotiator-release-1", hook_version: "moralmod-lifecycle-2",
        hermes_plugin_revision: INDEX_PLUGIN_REVISION, bun_version: "1.4.2", files });
      fs.writeFileSync(join(source, "release.json"), manifest);
      return installMoralmodRelease(home, source, hash(manifest));
    };
    return { home, config, release, paths: {
      config: join(home, "index", "moralmod", "resident.json"),
      runtime: join(dest, "runtime", "dist", "negotiator.js"),
      hook: negotiatorPath(home), receipt: join(home, "index", "moralmod", "active.json"),
    } };
  } catch (error) { fs.rmSync(home, { recursive: true, force: true }); throw error; }
}

for (const phase of ["before", "after"] as const) {
  for (const target of ["config", "runtime", "hook", "receipt"] as const) {
    test.skipIf(!havePlugin)(`first activation interrupted ${phase} the ${target} replacement completes on retry`, () => {
      const f = fixture(), release = f.release("one");
      const interrupted = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === f.paths[target] && phase === "before") throw Error("controlled activation interruption");
        rename(from, to);
        if (String(to) === f.paths[target] && phase === "after") throw Error("controlled activation interruption");
      });
      try {
        expect(() => activateMoralmod(f.home, release, f.config)).toThrow("controlled activation interruption");
        interrupted.mockRestore();
        activateMoralmod(f.home, release, f.config);
        activateMoralmod(f.home, release, f.config);
        const receipt = JSON.parse(fs.readFileSync(f.paths.receipt, "utf8"));
        expect(receipt).toMatchObject({ installed: true, ready: false, release_digest: release.releaseDigest,
          plugin_revision: INDEX_PLUGIN_REVISION, entry_sha256: hash(fs.readFileSync(f.paths.runtime)) });
        expect(fs.statSync(f.paths.config).mode & 0o777).toBe(0o600);
        expect(JSON.parse(fs.readFileSync(f.paths.config, "utf8"))).toEqual(f.config);
      } finally { interrupted.mockRestore(); fs.rmSync(f.home, { recursive: true, force: true }); }
    });
  }
}

test.skipIf(!havePlugin)("an interrupted verified release upgrade recovers with the previous ownership receipt", () => {
  const f = fixture(), first = f.release("one"), next = f.release("two");
  try {
    activateMoralmod(f.home, first, f.config);
    const interrupted = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === f.paths.runtime) throw Error("controlled upgrade interruption");
    });
    try { expect(() => activateMoralmod(f.home, next, f.config)).toThrow("controlled upgrade interruption"); }
    finally { interrupted.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(f.paths.receipt, "utf8")).release_digest).toBe(first.releaseDigest);
    activateMoralmod(f.home, next, f.config);
    const receipt = JSON.parse(fs.readFileSync(f.paths.receipt, "utf8"));
    expect(receipt.release_digest).toBe(next.releaseDigest);
    expect(receipt.entry_sha256).toBe(hash(fs.readFileSync(f.paths.runtime)));
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test.skipIf(!havePlugin)("the managed marker does not authorize modified loader bytes, with or without a receipt", () => {
  const f = fixture(), release = f.release("one");
  try {
    activateMoralmod(f.home, release, f.config);
    const customized = fs.readFileSync(f.paths.runtime, "utf8") + "\n// resident customization\n";
    fs.writeFileSync(f.paths.runtime, customized);
    expect(() => activateMoralmod(f.home, release, f.config)).toThrow("Managed plugin runtime was modified");
    fs.rmSync(f.paths.receipt);
    expect(() => activateMoralmod(f.home, release, f.config)).toThrow("Unowned plugin runtime was modified");
    expect(fs.readFileSync(f.paths.runtime, "utf8")).toBe(customized);
    expect(fs.existsSync(f.paths.receipt)).toBe(false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
