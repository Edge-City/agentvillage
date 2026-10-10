import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { installIndexPlugin, NEGOTIATOR_SEED, installMetadataPath } from "../install_index_plugin";
import { INDEX_PLUGIN_REVISION } from "../moralmod_release";
const plugin = resolve(import.meta.dir, "../../../index-hermes-plugin");
const bundle = resolve(
  import.meta.dir,
  "../../../decision-studio/custom-negotiator/dist/village",
);
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "moralmod-host-"));
  mkdirSync(join(home, "index"));
  mkdirSync(join(home, "plugins"));
  const config = join(home, "scoped.json");
  writeFileSync(
    config,
    JSON.stringify({
      DECISION_SERVICE_URL: "http://127.0.0.1:1",
      DECISION_EXPERIMENT_ID: crypto.randomUUID(),
      DECISION_INPUT_KIND: "synthetic",
      DECISION_RUNTIME_REVISION: "release-1",
      VILLAGE_CONTROL_PLANE_URL: "http://127.0.0.1:2",
      VILLAGE_SUBJECT_REF: "mm_" + "a".repeat(32),
      VILLAGE_INSTALLATION_CREDENTIAL: "r".repeat(32),
    }),
    { mode: 0o600 },
  );
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === "install") {
      const r = Bun.spawnSync([
        "git",
        "clone",
        "--quiet",
        plugin,
        join(home, "plugins", "index-network"),
      ]);
      if (r.exitCode) throw Error("Local pinned plugin fixture clone failed");
      writeFileSync(installMetadataPath(home), JSON.stringify({ "index-network": { pinned: true, revision: INDEX_PLUGIN_REVISION } }));
    }
  };
  return { home, config, calls, run };
}
function use(f: ReturnType<typeof fixture>, work: () => void) {
  const previous = {
    release: process.env.MORALMOD_RELEASE_DIR,
    config: process.env.MORALMOD_RESIDENT_CONFIG,
    home: process.env.HERMES_HOME,
    key: process.env.INDEX_API_KEY,
    arm: process.env.AV_MORALMOD_ARM,
  };
  // The managed lifecycle is for ON residents only (OV-249 post-hoc M1); OFF is in moralmod_arm_pin.test.ts.
  process.env.AV_MORALMOD_ARM = "on";
  process.env.HERMES_HOME = f.home;
  process.env.INDEX_API_KEY = "synthetic-key";
  process.env.MORALMOD_RELEASE_DIR = bundle;
  process.env.MORALMOD_RESIDENT_CONFIG = f.config;
  try {
    work();
  } finally {
    for (const [name, v] of [
      ["HERMES_HOME", previous.home],
      ["INDEX_API_KEY", previous.key],
      ["AV_MORALMOD_ARM", previous.arm],
      ["MORALMOD_RELEASE_DIR", previous.release],
      ["MORALMOD_RESIDENT_CONFIG", previous.config],
    ] as const) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
    rmSync(f.home, { recursive: true, force: true });
  }
}
// This connected check consumes the reviewed release and pinned plugin checkout.
// A standalone Village checkout still runs the independent installer safety tests.
test.skipIf(
  !existsSync(join(plugin, ".git")) ||
    !existsSync(join(bundle, "release.json")),
)(
  "actual installer pins plugin, replaces only its seed, rotates scoped config and rejects modified runtime",
  () => {
    const f = fixture();
    // The sibling build stands in for the reviewed release: pin its own release.json (post-hoc M2).
    const pin = createHash("sha256").update(readFileSync(join(bundle, "release.json"))).digest("hex");
    use(f, () => {
      writeFileSync(join(f.home, "index", "negotiator.ts"), NEGOTIATOR_SEED);
      installIndexPlugin(f.run, ["bun", "install"], true, pin);
      expect(f.calls[0]).toEqual([
        "plugins",
        "install",
        "indexnetwork/hermes-plugin",
        "--ref",
        INDEX_PLUGIN_REVISION,
        "--no-enable",
      ]);
      const runtime = join(
        f.home,
        "plugins",
        "index-network",
        "runtime",
        "dist",
        "negotiator.js",
      );
      expect(readFileSync(runtime, "utf8")).toContain("startResident");
      expect(
        JSON.parse(
          readFileSync(
            join(f.home, "index", "moralmod", "active.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        installed: true,
        ready: false,
        selected: "unverified",
      });
      expect(
        statSync(join(f.home, "index", "moralmod", "resident.json")).mode &
          0o777,
      ).toBe(0o600);
      const config = JSON.parse(readFileSync(f.config, "utf8"));
      config.VILLAGE_INSTALLATION_CREDENTIAL = "new-credential".repeat(4);
      writeFileSync(f.config, JSON.stringify(config));
      installIndexPlugin(f.run, ["bun", "install"], true, pin);
      expect(f.calls.filter((a) => a[1] === "install")).toHaveLength(1);
      expect(
        JSON.parse(
          readFileSync(
            join(f.home, "index", "moralmod", "resident.json"),
            "utf8",
          ),
        ).VILLAGE_INSTALLATION_CREDENTIAL,
      ).toBe(config.VILLAGE_INSTALLATION_CREDENTIAL);
      writeFileSync(runtime, "resident modification");
      expect(installIndexPlugin(f.run, ["bun", "install"], true, pin).state).toBe("failed");
      expect(readFileSync(runtime, "utf8")).toBe("resident modification");
    });
  },
);
test("unowned custom hook and fleet credentials are rejected before plugin installation", () => {
  const f = fixture();
  use(f, () => {
    writeFileSync(
      join(f.home, "index", "negotiator.ts"),
      "custom resident hook",
    );
    expect(installIndexPlugin(f.run, ["bun", "install"], true).state).toBe("failed");
    expect(f.calls).toHaveLength(0);
    writeFileSync(join(f.home, "index", "negotiator.ts"), NEGOTIATOR_SEED);
    const c = JSON.parse(readFileSync(f.config, "utf8"));
    c.OPENAI_API_KEY = "not-allowed";
    writeFileSync(f.config, JSON.stringify(c));
    expect(installIndexPlugin(f.run, ["bun", "install"], true).state).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });
});
