import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PREVIOUS_REVIEWED_MINI_APPS, reconcileMiniApps, REVIEWED_MINI_APPS, SHIPPED_SKILLS, validateProjection } from "../install_miniapps";
import { EDGE_SKILL_NAMES } from "../paths";

const REPO = join(import.meta.dir, "..", "..");
/** Every file under `root` with its bytes and mode, for "nothing changed" proofs. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) { out[relative(root, path) + "/"] = String(st.mode); walk(path); }
      else out[relative(root, path)] = `${st.mode}:${readFileSync(path, "base64")}`;
    }
  };
  walk(root);
  return out;
}
/** A box as the installer leaves it: every installer-shipped skill copied from this checkout. */
function installedBox(): string {
  const root = home();
  for (const name of EDGE_SKILL_NAMES) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), readFileSync(join(REPO, "skills", name, "SKILL.md")));
  }
  writeFileSync(join(root, "config.yaml"), "plugins:\n  enabled: [village-bridge]\n");
  return root;
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "curated-miniapps-"));
  roots.push(root);
  return root;
}
const all = { version: 1, apps: [...REVIEWED_MINI_APPS] };

test("reviewed skills are optional, disk-only staging has deterministic receipts and verify", () => {
  const root = home();
  // gold-stars is a baseline skill the installer ships to every box; dizko only ever arrives this way.
  expect(EDGE_SKILL_NAMES).toContain("gold-stars");
  expect(EDGE_SKILL_NAMES).not.toContain("dizko");
  const receipt = reconcileMiniApps(all, root);
  expect(receipt).toEqual(reconcileMiniApps(all, root));
  expect(receipt).toEqual(reconcileMiniApps(all, root, undefined, true));
  expect(receipt.projectionSha256).toBe(createHash("sha256").update(JSON.stringify(all)).digest("hex"));
  expect(receipt.files.map(x => x.path)).toEqual(["skills/gold-stars/SKILL.md", "skills/dizko/SKILL.md"]);
  expect(receipt).not.toHaveProperty("active");
  writeFileSync(join(root, "skills", "gold-stars", "SKILL.md"), "tampered");
  expect(() => reconcileMiniApps(all, root, undefined, true)).toThrow("mini_apps_skill_mismatch");
});

test("uninstall revokes the projection and removes only exact managed files, never a shipped skill", () => {
  const root = home();
  reconcileMiniApps(all, root);
  writeFileSync(join(root, "village-bridge.json"), "managed bearer fixture");
  writeFileSync(join(root, "skills", "gold-stars", "resident-note.txt"), "keep");
  const one = { version: 1, apps: [REVIEWED_MINI_APPS[1]] };
  reconcileMiniApps(one, root);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(true);
  // gold-stars left `desired`: its permission is gone from mini-apps.json, its baseline SKILL.md stays.
  expect(JSON.parse(readFileSync(join(root, "mini-apps.json"), "utf8")).apps.map((a: { id: string }) => a.id)).toEqual(["dizko"]);
  expect(readFileSync(join(root, "skills", "gold-stars", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "gold-stars", "SKILL.md")));
  expect(readFileSync(join(root, "skills", "gold-stars", "resident-note.txt"), "utf8")).toBe("keep");
  expect(reconcileMiniApps(one, root, undefined, true).apps).toEqual([{ id: "dizko", version: "1.0.0" }]);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, "mini-apps.json"), "utf8"))).toEqual({ version: 1, apps: [] });
  expect(existsSync(join(root, "skills", "dizko", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "gold-stars", "SKILL.md"))).toBe(true);
  expect(reconcileMiniApps({ version: 1, apps: [] }, root, undefined, true).apps).toEqual([]);
});

test("the helper never removes an installer-shipped skill, for any desired set", () => {
  // The reviewed ids the installer also ships (today: gold-stars) are exactly the protected ones.
  expect(REVIEWED_MINI_APPS.filter((a) => SHIPPED_SKILLS.has(a.id)).map((a) => a.id)).toEqual(["gold-stars"]);
  expect([...SHIPPED_SKILLS].sort()).toEqual([...EDGE_SKILL_NAMES].sort());
  const sets = [[], [REVIEWED_MINI_APPS[0]], [REVIEWED_MINI_APPS[1]], [...REVIEWED_MINI_APPS]];
  for (const first of sets) for (const second of sets) {
    const root = installedBox();
    const shipped = () => Object.fromEntries(EDGE_SKILL_NAMES.map((n) => [n, readFileSync(join(root, "skills", n, "SKILL.md"), "base64")]));
    const before = shipped();
    for (const apps of [first, second]) {
      const receipt = reconcileMiniApps({ version: 1, apps }, root);
      expect(shipped()).toEqual(before);
      expect(reconcileMiniApps({ version: 1, apps }, root, undefined, true)).toEqual(receipt);
    }
    expect(existsSync(join(root, "skills", "dizko", "SKILL.md"))).toBe(second.some((a) => a.id === "dizko"));
  }
});

test("non-cohort box: an empty projection on a box with no mini-app state writes nothing (library and CLI)", () => {
  const empty = { version: 1, apps: [] };
  const root = installedBox();
  const before = snapshot(root);
  const receipt = reconcileMiniApps(empty, root);
  expect(receipt).toEqual({ version: 1, projectionSha256: createHash("sha256").update(JSON.stringify(empty)).digest("hex"), files: [], apps: [], staged: true });
  expect(reconcileMiniApps(empty, root, undefined, true)).toEqual(receipt);
  expect(snapshot(root)).toEqual(before);
  // The exact command the control plane runs (stdin JSON, `bun install/install_miniapps.ts`), with and without --verify.
  for (const args of [[], ["--verify"]]) {
    const run = spawnSync("bun", ["--no-env-file", "--no-install", "install/install_miniapps.ts", ...args], {
      cwd: REPO, input: JSON.stringify(empty), env: { ...process.env, HERMES_HOME: root }, encoding: "utf8",
    });
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(JSON.parse(run.stdout)).toEqual(receipt);
  }
  expect(snapshot(root)).toEqual(before);
  // Once a box has mini-app state, an empty projection is a real revocation (fails closed).
  writeFileSync(join(root, "village-bridge.json"), "managed bearer fixture");
  expect(() => reconcileMiniApps(empty, root, undefined, true)).toThrow("mini_apps_projection_mismatch");
  reconcileMiniApps(empty, root);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, "mini-apps.json"), "utf8"))).toEqual(empty);
});

test("unknown bundles, versions, extra fields, permissions and duplicate ids are refused", () => {
  const gold = REVIEWED_MINI_APPS[0];
  for (const app of [{ ...gold, id: "../../escape" }, { ...gold, version: "9" }, { ...gold, hooks: ["sh"] }, { ...gold, skills: ["../../other"] }, { ...gold, operations: [...gold.operations, "rolodex.delete"] }, { ...gold, operations: gold.operations.filter((op) => op !== "skylight.status") }, { ...gold, operations: [...gold.operations].reverse() }]) {
    expect(() => validateProjection({ version: 1, apps: [app] })).toThrow();
  }
  expect(() => validateProjection({ version: 1, apps: [gold, gold] })).toThrow();
  expect(() => validateProjection({ version: 1, apps: [], mcp: { url: "https://unreviewed.invalid" } })).toThrow();
});

test("ROLODEX.PERSON: gold-stars carries rolodex.person last; the 8-op and 6-op entries stay stageable byte for byte", () => {
  const gold = REVIEWED_MINI_APPS[0];
  const [restored, previous] = PREVIOUS_REVIEWED_MINI_APPS;
  expect(gold.operations).toEqual(["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status", "rolodex.person"]);
  expect(restored.operations).toEqual(gold.operations.slice(0, 8));
  expect(previous.operations).toEqual(gold.operations.slice(0, 6));
  expect(PREVIOUS_REVIEWED_MINI_APPS.length).toBe(2);
  for (const entry of [gold, restored, previous]) expect([entry.id, entry.version, [...entry.skills]]).toEqual(["gold-stars", "1.1.0", ["gold-stars"]]);
  // Parity: the plugin's reviewed lists and the reviewed manifest carry exactly the same operations, in order.
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  const list = (name: string) => JSON.parse(new RegExp(`^${name} = \\{"version": "1\\.1\\.0", "skills": \\["gold-stars"\\], "operations": (\\[[^\\]]*\\])\\}$`, "m").exec(plugin)![1]);
  expect(list("GOLD_STARS")).toEqual([...gold.operations]);
  expect(list("GOLD_STARS_RESTORED")).toEqual([...restored.operations]);
  expect(list("GOLD_STARS_PREVIOUS")).toEqual([...previous.operations]);
  expect(/^GOLD_STARS_ACCEPTED = \(GOLD_STARS, GOLD_STARS_RESTORED, GOLD_STARS_PREVIOUS\)$/m.test(plugin)).toBe(true);
  expect(JSON.parse(readFileSync(join(REPO, "mini-apps", "gold-stars", "manifest.json"), "utf8")).operations).toEqual([...gold.operations]);
  // The exact entry the CP projects for release ({id, version, operations, skills}, catalog.projection()).
  expect(JSON.stringify({ id: gold.id, version: gold.version, operations: gold.operations, skills: gold.skills })).toBe(
    '{"id":"gold-stars","version":"1.1.0","operations":["rolodex.search","gold-stars.quota","gold-stars.prepare","gold-stars.send","gold-stars.status","gold-stars.cancel","rolodex.meeting","skylight.status","rolodex.person"],"skills":["gold-stars"]}');
  // Any catalog entry (CP before or after this overlay) stages, and the receipt hashes the CP's exact bytes.
  for (const entry of [gold, restored, previous]) {
    const projection = { version: 1, apps: [{ id: entry.id, version: entry.version, operations: [...entry.operations], skills: [...entry.skills] }] };
    const root = installedBox();
    const receipt = reconcileMiniApps(projection, root);
    expect(receipt.projectionSha256).toBe(createHash("sha256").update(JSON.stringify(projection)).digest("hex"));
    expect(readFileSync(join(root, "mini-apps.json"), "utf8")).toBe(JSON.stringify(projection));
    expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
  }
  // Never two gold-stars entries at once; rolodex.person only ever last, only after the restore.
  for (const apps of [[gold, restored], [gold, previous], [restored, previous]]) expect(() => validateProjection({ version: 1, apps })).toThrow("mini_apps_unreviewed_bundle");
  const eight = [...restored.operations], six = [...previous.operations];
  for (const operations of [["rolodex.person", ...eight], [...eight.slice(0, 6), "rolodex.person", ...eight.slice(6)], [...six, "rolodex.person"], [...gold.operations, "rolodex.person"], [...eight, "rolodex.profile"]]) {
    expect(() => validateProjection({ version: 1, apps: [{ ...gold, operations }] })).toThrow("mini_apps_unreviewed_bundle");
  }
});

test("symlink targets and ancestors cannot escape managed paths", () => {
  for (const target of ["mini-apps.json", "skills", "skills/gold-stars", "skills/gold-stars/SKILL.md"]) {
    const root = home();
    const outside = home();
    const path = join(root, target);
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(outside, path);
    expect(() => reconcileMiniApps(all, root)).toThrow("mini_apps_symlink_refused");
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
  }
});

test("verify is read-only and refuses an absent or removed projection", () => {
  const root = home();
  expect(() => reconcileMiniApps(all, root, undefined, true)).toThrow();
  expect(existsSync(join(root, "mini-apps.json"))).toBe(false);
  reconcileMiniApps(all, root);
  expect(() => reconcileMiniApps({ version: 1, apps: [] }, root, undefined, true)).toThrow("mini_apps_projection_mismatch");
  expect(existsSync(join(root, "skills", "gold-stars", "SKILL.md"))).toBe(true);
});
