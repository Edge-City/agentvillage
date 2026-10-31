import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as installMiniApps from "../install_miniapps";
import { PREVIOUS_REVIEWED_MINI_APPS, reconcileMiniApps, REVIEWED_MINI_APPS, SHIPPED_SKILLS, validateProjection, ZZZ_BRIDGE_ID, zzzParticipation } from "../install_miniapps";
import * as zzzManagedJob from "../zzz_managed_job";
import { AUTONOMY_FILES, AUTONOMY_GATE } from "../zzz_autonomy_job";
import { EDGE_SKILL_NAMES } from "../paths";
import { createRequire } from "node:module";

const REPO = join(import.meta.dir, "..", "..");
// P0-1: mini-apps/<id>/manifest.json is a v2 manifest; what the cp serves from it (and what these tests
// hold the installer's reviewed tables to) is its v1 entry (scripts/mini-apps-manifests.cjs).
const manifests = createRequire(import.meta.url)("../../scripts/mini-apps-manifests.cjs");
const reviewedManifest = (id: string, opts: { person?: boolean; context?: boolean } = {}) =>
  manifests.v1Entry(JSON.parse(readFileSync(join(REPO, "mini-apps", id, "manifest.json"), "utf8")), opts);
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
const all = { version: 1, apps: REVIEWED_MINI_APPS };

test("reviewed skills are optional, disk-only staging has deterministic receipts and verify", () => {
  const root = home();
  // gold-stars is a baseline skill the installer ships to every box; dizko only ever arrives this way.
  expect(EDGE_SKILL_NAMES).toContain("gold-stars");
  expect(EDGE_SKILL_NAMES).not.toContain("dizko");
  expect(EDGE_SKILL_NAMES).not.toContain("forkicks");
  const receipt = reconcileMiniApps(all, root);
  expect(receipt).toEqual(reconcileMiniApps(all, root));
  expect(receipt).toEqual(reconcileMiniApps(all, root, undefined, true));
  expect(receipt.projectionSha256).toBe(createHash("sha256").update(JSON.stringify(all)).digest("hex"));
  expect(receipt.files.map(x => x.path)).toEqual(["skills/gold-stars/SKILL.md", "skills/dizko/SKILL.md", "skills/forkicks/SKILL.md", "skills/zzzbot/SKILL.md", "skills/slopfolio/SKILL.md", "skills/mosaic/SKILL.md", "skills/dreamstarter/SKILL.md", "skills/kismet/SKILL.md", "skills/library/SKILL.md", "skills/favorloop/SKILL.md", "skills/zzzbot/scripts/zzz_managed_runner.py", "skills/zzzbot/prompts/participate.md", "skills/zzzbot/scripts/zzz_autonomy_runner.py", "skills/zzzbot/prompts/autonomy.md"]);
  expect(receipt).not.toHaveProperty("active");
  writeFileSync(join(root, "skills", "gold-stars", "SKILL.md"), "tampered");
  expect(() => reconcileMiniApps(all, root, undefined, true)).toThrow("mini_apps_skill_mismatch");
});

// cp#467 (runner SEV1 28 Oct 2026): the control plane holds these receipt paths by hand and fails EVERY mini-app on a
// box whose receipt differs. A change here lands in cp control-plane/src/mini-apps-skills.js ZZZ_STAGE_FILE_LISTS /
// ZZZ_AUTONOMY_FILE_LISTS FIRST (as a new list, the old one kept for the roll), deployed before the tag that ships it.
test("zzz managed receipt files are the cp's mirrored lists (change the cp first: mini-apps-skills.js ZZZ_*_FILE_LISTS)", () => {
  const root = installedBox();
  const projection = { version: 1, apps: REVIEWED_MINI_APPS.filter(app => ["zzzbot", ZZZ_BRIDGE_ID, AUTONOMY_GATE].includes(app.id)) };
  expect(projection.apps.map(app => app.id).sort()).toEqual([AUTONOMY_GATE, ZZZ_BRIDGE_ID, "zzzbot"].sort());
  const managed = reconcileMiniApps(projection, root).files.map(file => file.path).filter(path => path !== "skills/zzzbot/SKILL.md");
  expect(managed).toEqual([
    "skills/zzzbot/scripts/zzz_managed_runner.py", "skills/zzzbot/prompts/participate.md", // cp ZZZ_STAGE_FILE_LISTS[0]
    "skills/zzzbot/scripts/zzz_autonomy_runner.py", "skills/zzzbot/prompts/autonomy.md", // cp ZZZ_AUTONOMY_FILE_LISTS[0]
  ]);
  expect(AUTONOMY_FILES).toEqual(["scripts/zzz_autonomy_runner.py", "prompts/autonomy.md"]);
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
  expect(existsSync(join(root, "skills", "forkicks", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "zzzbot", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "slopfolio", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "mosaic", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "dreamstarter", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "kismet", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "library", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "gold-stars", "SKILL.md"))).toBe(true);
  expect(reconcileMiniApps({ version: 1, apps: [] }, root, undefined, true).apps).toEqual([]);
});

test("the helper never removes an installer-shipped skill, for any desired set", () => {
  // The reviewed ids the installer also ships (today: gold-stars) are exactly the protected ones.
  expect(REVIEWED_MINI_APPS.filter((a) => SHIPPED_SKILLS.has(a.id)).map((a) => a.id)).toEqual(["gold-stars"]);
  expect([...SHIPPED_SKILLS].sort()).toEqual([...EDGE_SKILL_NAMES].sort());
  const sets = [[], ...REVIEWED_MINI_APPS.map(app => [app]), [...REVIEWED_MINI_APPS]];
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
    expect(existsSync(join(root, "skills", "forkicks", "SKILL.md"))).toBe(second.some((a) => a.id === "forkicks"));
    expect(existsSync(join(root, "skills", "zzzbot", "SKILL.md"))).toBe(second.some((a) => a.id === "zzzbot"));
    expect(existsSync(join(root, "skills", "slopfolio", "SKILL.md"))).toBe(second.some((a) => a.id === "slopfolio"));
    expect(existsSync(join(root, "skills", "mosaic", "SKILL.md"))).toBe(second.some((a) => a.id === "mosaic"));
    expect(existsSync(join(root, "skills", "dreamstarter", "SKILL.md"))).toBe(second.some((a) => a.id === "dreamstarter"));
    expect(existsSync(join(root, "skills", "kismet", "SKILL.md"))).toBe(second.some((a) => a.id === "kismet"));
    expect(existsSync(join(root, "skills", "library", "SKILL.md"))).toBe(second.some((a) => a.id === "library"));
  }
});

test("non-cohort box: an empty projection on a box with no mini-app state writes nothing (library and CLI)", () => {
  const empty = { version: 1, apps: [] };
  const root = installedBox();
  const before = snapshot(root);
  const receipt = reconcileMiniApps(empty, root);
  expect(receipt).toEqual({ version: 1, projectionSha256: createHash("sha256").update(JSON.stringify(empty)).digest("hex"), files: [], apps: [], staged: true, skills: { offer: null, served: [], fallback: [] } });
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
  expect(gold.operations.slice(0, 8)).toEqual([...restored.operations]);
  expect(gold.operations.slice(0, 6)).toEqual([...previous.operations]);
  // NEW-03: the third previous entry is dizko's public read alone, the fourth mosaic's, the fifth zzzbot's five (1.0.0), the sixth kismet's Part 1 read
  // (each asserted in its own test below).
  expect(PREVIOUS_REVIEWED_MINI_APPS.length).toBe(6);
  expect(PREVIOUS_REVIEWED_MINI_APPS.filter((x) => x.id === "gold-stars").length).toBe(2);
  for (const entry of [gold, restored, previous]) expect([entry.id, entry.version, [...entry.skills]]).toEqual(["gold-stars", "1.1.0", ["gold-stars"]]);
  // Parity: the plugin's reviewed lists and the reviewed manifest carry exactly the same operations, in order.
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  const list = (name: string) => JSON.parse(new RegExp(`^${name} = \\{"version": "1\\.1\\.0", "skills": \\["gold-stars"\\], "operations": (\\[[^\\]]*\\])\\}$`, "m").exec(plugin)![1]);
  expect(list("GOLD_STARS")).toEqual([...gold.operations]);
  expect(list("GOLD_STARS_RESTORED")).toEqual([...restored.operations]);
  expect(list("GOLD_STARS_PREVIOUS")).toEqual([...previous.operations]);
  expect(/^GOLD_STARS_ACCEPTED = \(GOLD_STARS, GOLD_STARS_RESTORED, GOLD_STARS_PREVIOUS\)$/m.test(plugin)).toBe(true);
  expect(reviewedManifest("gold-stars", { person: true }).operations).toEqual([...gold.operations]);
  expect(reviewedManifest("gold-stars").operations).toEqual([...restored.operations]);
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

test("NEW-03: dizko carries its context read/write after mini-app.read; the read-only entry stays stageable byte for byte", () => {
  const dizko = REVIEWED_MINI_APPS[1];
  const previous = PREVIOUS_REVIEWED_MINI_APPS[2];
  const read = "mini-app.read", ctxRead = "mini-app.context.read", ctxWrite = "mini-app.context.write";
  expect([dizko.id, dizko.version, [...dizko.skills], [...dizko.operations]]).toEqual(["dizko", "1.0.0", ["dizko"], [read, ctxRead, ctxWrite]]);
  expect([previous.id, previous.version, [...previous.skills], [...previous.operations]]).toEqual(["dizko", "1.0.0", ["dizko"], [read]]);
  // Parity: the plugin's closed allow-list for a non-Gold-Stars app is exactly these two lists, newest first.
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  const accepted = /^APP_OPERATIONS_ACCEPTED = \((.*)\)$/m.exec(plugin)![1];
  expect(JSON.parse("[" + accepted.replace(/\(/g, "[").replace(/,\)/g, "]").replace(/\)/g, "]") + "]")).toEqual([[...dizko.operations], [...previous.operations]]);
  for (const entry of [dizko, previous]) {
    const projection = { version: 1, apps: [REVIEWED_MINI_APPS[0], { id: entry.id, version: entry.version, operations: [...entry.operations], skills: [...entry.skills] }] };
    const root = installedBox();
    const receipt = reconcileMiniApps(projection, root);
    expect(receipt.projectionSha256).toBe(createHash("sha256").update(JSON.stringify(projection)).digest("hex"));
    expect(readFileSync(join(root, "mini-apps.json"), "utf8")).toBe(JSON.stringify(projection));
    expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
  }
  expect(() => validateProjection({ version: 1, apps: [dizko, previous] })).toThrow("mini_apps_unreviewed_bundle");
  const planted = [
    [read, ctxRead, ctxWrite, "mini-app.context.delete"], [read, "mini-app.context.delete"], [read, "mini-app.admin"],
    [read, "gold-stars.send"], [read, ctxRead, ctxWrite, "gold-stars.send"], [ctxRead, read, ctxWrite], [read, ctxWrite, ctxRead],
    [read, read], [read, ctxRead, ctxRead, ctxWrite], [read, ctxRead], [read, ctxWrite], [ctxRead, ctxWrite], [],
  ];
  for (const operations of planted) expect(() => validateProjection({ version: 1, apps: [{ ...dizko, operations }] })).toThrow("mini_apps_unreviewed_bundle");
  // A gold-stars entry never carries a context operation.
  for (const gold of [REVIEWED_MINI_APPS[0], PREVIOUS_REVIEWED_MINI_APPS[0], PREVIOUS_REVIEWED_MINI_APPS[1]]) {
    for (const operations of [[...gold.operations, ctxRead, ctxWrite], [...gold.operations, ctxWrite], [read, ctxRead, ctxWrite]]) {
      expect(() => validateProjection({ version: 1, apps: [{ ...gold, operations }] })).toThrow("mini_apps_unreviewed_bundle");
    }
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

test("zzz.bot manifest and native allowlist pin exactly its named operations (1.1.0: seven; 1.0.0: five) and stage the author skill", () => {
  const app = REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!;
  const five = ["zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread"];
  const ops = [...five, "zzz.tag_thread", "zzz.edit_post"];
  const manifest = reviewedManifest("zzzbot");
  expect(app).toEqual({ id: "zzzbot", version: "1.1.0", operations: ops, skills: ["zzzbot"] });
  // 1.0.0 (the five alone) stays stageable, so this overlay rolls out before the CP catalog serves 1.1.0.
  const previous = PREVIOUS_REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!;
  expect(previous).toEqual({ id: "zzzbot", version: "1.0.0", operations: five, skills: ["zzzbot"] });
  for (const entry of [app, previous]) {
    const staged = { version: 1, apps: [{ id: entry.id, version: entry.version, operations: [...entry.operations], skills: [...entry.skills] }] };
    expect(validateProjection(staged)).toEqual(staged);
    const box = installedBox();
    const receipt = reconcileMiniApps(staged, box);
    expect(receipt.projectionSha256).toBe(createHash("sha256").update(JSON.stringify(staged)).digest("hex"));
    expect(receipt.files.map(file => file.path)).toEqual(["skills/zzzbot/SKILL.md"]);
  }
  // Neither version with the other's list, and no edit alone, is reviewed.
  for (const changed of [{ ...app, version: "1.0.0" }, { ...previous, version: "1.1.0" }, { ...app, operations: [...five, "zzz.edit_post"] },
    { ...app, operations: [...five, "zzz.edit_post", "zzz.tag_thread"] }])
    expect(() => validateProjection({ version: 1, apps: [changed] })).toThrow("mini_apps_unreviewed_bundle");
  expect(manifest).toMatchObject({ ...app, homepage: "https://zzz.bot" });
  expect(Object.keys(manifest).sort()).toEqual(["auth", "description", "homepage", "id", "name", "operations", "permissions", "provenance", "restricted", "skills", "version"]);
  expect(manifest.permissions.map((permission: { kind: string }) => permission.kind)).toEqual(["read", "action"]);
  expect(manifest).not.toHaveProperty("mcp");
  expect(EDGE_SKILL_NAMES).not.toContain("zzzbot");
  const projection = { version: 1, apps: [app] };
  expect(validateProjection(projection)).toEqual(projection);
  for (const changed of [
    { ...app, operations: [...app.operations, "zzz.set_thread_state"] },
    { ...app, operations: [...app.operations].reverse() },
    { ...app, operations: ["mini-app.read"] },
    { ...app, operations: app.operations.slice(0, 3) },
    { ...app, skills: ["other"] },
    { ...app, version: "1.0.1" },
  ]) expect(() => validateProjection({ version: 1, apps: [changed] })).toThrow("mini_apps_unreviewed_bundle");
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  expect(plugin).toContain('ZZZ_READ_OPERATIONS = ("zzz.list_rooms", "zzz.read_thread", "zzz.changes")');
  expect(plugin).toContain('ZZZ_WRITE_OPERATIONS = ("zzz.reply", "zzz.create_thread")');
  expect(plugin).toContain('ZZZ_EDIT_OPERATIONS = ("zzz.tag_thread", "zzz.edit_post")');
  expect(plugin).toContain('ZZZBOT = {"version": "1.1.0", "skills": ["zzzbot"], "operations": [*ZZZ_READ_OPERATIONS, *ZZZ_WRITE_OPERATIONS, *ZZZ_EDIT_OPERATIONS]}');
  expect(plugin).toContain('ZZZBOT_PREVIOUS = {"version": "1.0.0", "skills": ["zzzbot"], "operations": [*ZZZ_READ_OPERATIONS, *ZZZ_WRITE_OPERATIONS]}');
  expect(plugin).toContain('ZZZBOT_ACCEPTED = (ZZZBOT, ZZZBOT_PREVIOUS)');
  const root = installedBox();
  const receipt = reconcileMiniApps(projection, root);
  expect(receipt.files.map(file => file.path)).toEqual(["skills/zzzbot/SKILL.md"]);
  expect(existsSync(join(root, "skills", "zzzbot", "scripts", "agentvillage_zzz_pairs.sh"))).toBe(false);
  const bridge = REVIEWED_MINI_APPS.find(app => app.id === "zzz-bridge")!;
  const enabled = { version: 1, apps: [app, bridge] };
  const enabledReceipt = reconcileMiniApps(enabled, root);
  expect(enabledReceipt.files.map(file => file.path)).toEqual(["skills/zzzbot/SKILL.md", "skills/zzzbot/scripts/zzz_managed_runner.py", "skills/zzzbot/prompts/participate.md"]);
  expect(readFileSync(join(root, "skills", "zzzbot", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "zzzbot", "SKILL.md")));
  expect(statSync(join(root, "skills", "zzzbot", "SKILL.md")).mode & 0o777).toBe(0o600);
  expect(reconcileMiniApps(enabled, root, undefined, true)).toEqual(enabledReceipt);
  // The skill asks the agent to fetch no third-party prompt or instruction file (ov#382 owner read M2).
  const skill = readFileSync(join(REPO, "skills", "zzzbot", "SKILL.md"), "utf8");
  expect(skill).not.toMatch(/prompt\.txt|\.well-known|\/mcp\b|curl|wget/);
  reconcileMiniApps(projection, root);
  expect(existsSync(join(root, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "skills", "zzzbot", "SKILL.md"))).toBe(false);
});

test("Edge Library 1.0.0 manifest and native allowlist pin exactly its eight reads (no write) and stage the skill", () => {
  const app = REVIEWED_MINI_APPS.find(app => app.id === "library")!;
  const reads = ["library.initialize", "library.search", "library.get", "library.source", "library.schema", "library.history", "library.changes_since", "library.proposals"];
  const manifest = reviewedManifest("library");
  expect(app).toEqual({ id: "library", version: "1.0.0", operations: reads, skills: ["library"] });
  expect(manifest).toMatchObject({ ...app, homepage: "https://library.positivesumexperiments.com/" });
  // app-token: no per-resident OAuth (`auth`), no relay (`mcp`); sandbox, so restricted.
  expect(Object.keys(manifest).sort()).toEqual(["credit", "description", "homepage", "id", "name", "operations", "permissions", "restricted", "skills", "version"]);
  expect(manifest.credit.role).toBe("product");
  expect(manifest.permissions.map((permission: { kind: string }) => permission.kind)).toEqual(["read"]);
  // Lead L31582 (Q5/Q6): the app's private per-app subject, never a Telegram id or username; a read creates no entry.
  expect(manifest.permissions[0].description).toContain("by a private, stable reference, never your Telegram id or username");
  expect(manifest.permissions[0].description).toContain("Reading does not create a member entry");
  expect(manifest.permissions[0].description).not.toMatch(/Telegram user id|creates your member entry/);
  expect(manifest).not.toHaveProperty("mcp");
  expect(manifest).not.toHaveProperty("auth");
  const v2 = JSON.parse(readFileSync(join(REPO, "mini-apps", "library", "manifest.json"), "utf8"));
  expect(v2.service).toEqual({ kind: "mcp", baseUrl: "https://library.positivesumexperiments.com/api/mcp", auth: { mode: "app-token", secretRef: "MINI_APP_LIBRARY_KEY" } });
  expect(v2.operations.map((op: { class: string }) => op.class)).toEqual(reads.map(() => "read"));
  expect(v2.operations.map((op: { target: { tool: string } }) => op.target.tool)).toEqual(reads.map(name => name.replace(".", "_")));
  expect(JSON.stringify(v2)).not.toMatch(/library_(submit_source|write|propose|jobs_|queries)/);
  expect(EDGE_SKILL_NAMES).not.toContain("library");
  const projection = { version: 1, apps: [app] };
  expect(validateProjection(projection)).toEqual(projection);
  for (const changed of [
    { ...app, operations: [...app.operations, "library.jobs_claim"] },
    { ...app, operations: [...app.operations].reverse() },
    { ...app, operations: ["mini-app.read"] },
    { ...app, operations: [...reads, "library.submit_source", "library.write", "library.propose"] },
    { ...app, operations: reads.slice(1) },
    { ...app, skills: ["other"] },
    { ...app, version: "1.0.1" },
  ]) expect(() => validateProjection({ version: 1, apps: [changed] })).toThrow("mini_apps_unreviewed_bundle");
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  expect(plugin).not.toContain("LIBRARY_WRITE_OPERATIONS");
  const root = installedBox();
  const receipt = reconcileMiniApps(projection, root);
  expect(receipt.files.map(file => file.path)).toEqual(["skills/library/SKILL.md"]);
  expect(readFileSync(join(root, "skills", "library", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "library", "SKILL.md")));
  expect(statSync(join(root, "skills", "library", "SKILL.md")).mode & 0o777).toBe(0o600);
  expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
  // The skill fetches nothing remote and never asks for a token.
  const skill = readFileSync(join(REPO, "skills", "library", "SKILL.md"), "utf8");
  expect(skill).not.toMatch(/prompt\.txt|\.well-known|\/api\/mcp|curl|wget/);
  expect(skill).toMatch(/^name: library$/m);
  expect(skill).not.toMatch(/library\.(submit_source|write|propose)\b/);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "skills", "library", "SKILL.md"))).toBe(false);
});

test("Favor Loop 1.0.0 (ov#556): the manifest and native allowlist pin exactly its eight operations (no relay read) and stage the skill", () => {
  const app = REVIEWED_MINI_APPS.find(app => app.id === "favorloop")!;
  const ops = ["favorloop.how_it_works", "favorloop.menu", "favorloop.board", "favorloop.join", "favorloop.my_loops", "favorloop.answer", "favorloop.confirm", "favorloop.leave"];
  const manifest = reviewedManifest("favorloop");
  expect(app).toEqual({ id: "favorloop", version: "1.0.0", operations: ops, skills: ["favorloop"] });
  expect(manifest).toMatchObject({ ...app, homepage: "https://favorloop.fly.dev/" });
  // app-token: no per-resident OAuth (`auth`), no relay (`mcp`); sandbox, so restricted.
  // Builder credit (role "app"), the cp's bytes (cp#521); display only, the installer never reads it.
  expect(Object.keys(manifest).sort()).toEqual(["credit", "description", "homepage", "id", "name", "operations", "permissions", "restricted", "skills", "version"]);
  expect(manifest.credit.role).toBe("app");
  expect(manifest).not.toHaveProperty("mcp");
  expect(manifest).not.toHaveProperty("auth");
  const v2 = JSON.parse(readFileSync(join(REPO, "mini-apps", "favorloop", "manifest.json"), "utf8"));
  expect(v2.service).toEqual({ kind: "mcp", baseUrl: "https://favorloop.fly.dev/mcp", auth: { mode: "app-token", secretRef: "MINI_APP_FAVORLOOP_KEY" } });
  expect(v2.operations.map((op: { name: string }) => op.name)).toEqual(ops);
  expect(v2.operations.map((op: { class: string }) => op.class)).toEqual(["read", "read", "read", "write", "read", "write", "write", "write"]);
  expect(v2.operations.map((op: { target: { tool: string } }) => op.target.tool)).toEqual(ops.map(name => name.replace("favorloop.", "")));
  expect(EDGE_SKILL_NAMES).not.toContain("favorloop");
  const projection = { version: 1, apps: [app] };
  expect(validateProjection(projection)).toEqual(projection);
  for (const changed of [
    { ...app, operations: [...app.operations, "mini-app.read"] },
    { ...app, operations: ["mini-app.read"] },
    { ...app, operations: [...app.operations].reverse() },
    { ...app, operations: ops.slice(1) },
    { ...app, skills: ["other"] },
    { ...app, version: "1.0.1" },
  ]) expect(() => validateProjection({ version: 1, apps: [changed] })).toThrow("mini_apps_unreviewed_bundle");
  const root = installedBox();
  const receipt = reconcileMiniApps(projection, root);
  expect(receipt.files.map(file => file.path)).toEqual(["skills/favorloop/SKILL.md"]);
  expect(readFileSync(join(root, "skills", "favorloop", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "favorloop", "SKILL.md")));
  expect(statSync(join(root, "skills", "favorloop", "SKILL.md")).mode & 0o777).toBe(0o600);
  expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
  const skill = readFileSync(join(REPO, "skills", "favorloop", "SKILL.md"), "utf8");
  expect(skill).not.toMatch(/prompt\.txt|\.well-known|\/mcp\b|curl|wget/);
  expect(skill).toMatch(/^name: favorloop$/m);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "skills", "favorloop", "SKILL.md"))).toBe(false);
});

test("ov#441 S1: managed ZZZ participation is the cp projection's zzzbot + zzz-bridge pair and nothing else", () => {
  const zzzbot = REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!;
  const bridge = REVIEWED_MINI_APPS.find(app => app.id === ZZZ_BRIDGE_ID)!;
  // The cp entry, exactly (cp/app ids match ^[a-z0-9][a-z0-9-]{0,39}$: a hyphen, never the underscore spelling).
  expect(ZZZ_BRIDGE_ID).toBe("zzz-bridge");
  expect(bridge).toEqual({ id: "zzz-bridge", version: "1.0.0", operations: [], skills: [] });
  expect(REVIEWED_MINI_APPS.some(app => app.id === "zzz_bridge")).toBe(false);
  const both = { version: 1, apps: [zzzbot, bridge] };
  expect(validateProjection(both)).toEqual(both);
  // (c) Any other shape of the entry (the underscore id included) refuses the whole projection.
  for (const changed of [{ ...bridge, id: "zzz_bridge" }, { ...bridge, operations: ["zzz.pairs"] }, { ...bridge, skills: ["zzz-bridge"] },
    { ...bridge, version: "1.0.1" }, { ...bridge, extra: true }]) {
    expect(() => validateProjection({ version: 1, apps: [zzzbot, changed] })).toThrow();
  }
  expect(() => validateProjection({ version: 1, apps: [zzzbot, bridge, bridge] })).toThrow("mini_apps_unreviewed_bundle");
  // (a)/(b) On only for the pair.
  expect(zzzParticipation(validateProjection(both))).toBe(true);
  expect(zzzParticipation(validateProjection({ version: 1, apps: [bridge, zzzbot] }))).toBe(true);
  expect(zzzParticipation(validateProjection({ version: 1, apps: [zzzbot] }))).toBe(false);
  expect(zzzParticipation(validateProjection({ version: 1, apps: [bridge] }))).toBe(false);
  expect(zzzParticipation(validateProjection({ version: 1, apps: [] }))).toBe(false);
  expect(zzzParticipation(validateProjection(all))).toBe(true);
  // The gate itself, before validation: only the exact id counts (validateProjection also refuses the rest).
  for (const id of ["zzz_bridge", "ZZZ-BRIDGE", "zzz-bridge ", "zzz-bridge-v2", "zzzbridge"])
    expect([id, zzzParticipation({ apps: [zzzbot, { id }] })]).toEqual([id, false]);
  expect(zzzParticipation({ apps: [{ id: "zzzbot" }, { id: "zzz-bridge" }] })).toBe(true);
  // zzz-bridge alone stages nothing (no skill, no served bytes, no managed files).
  const root = installedBox();
  const offer = "a".repeat(64);
  const bundle = JSON.stringify({ version: 1, skills: [] });
  const receipt = reconcileMiniApps({ version: 1, apps: [bridge] }, root, undefined, false, { offer, skills: bundle });
  expect(receipt.files).toEqual([]);
  expect(receipt.apps).toEqual([{ id: "zzz-bridge", version: "1.0.0" }]);
  expect(existsSync(join(root, "skills", "zzzbot"))).toBe(false);
  expect(existsSync(join(root, "skills", "zzz-bridge"))).toBe(false);
  // (d) No overlay constant or environment variable can turn it on: zzzbot alone with every would-be switch set.
  const keys = ["ZZZ_BRIDGE", "AV_PAIR_ENABLED", "ZZZ_MANAGED_PARTICIPATION", "ZZZ_BRIDGE_ENABLED"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "1";
    const zzzOnly = reconcileMiniApps({ version: 1, apps: [zzzbot] }, root);
    expect(zzzOnly.files.map(file => file.path)).toEqual(["skills/zzzbot/SKILL.md"]);
    expect(existsSync(join(root, "skills", "zzzbot", "scripts", "agentvillage_zzz_pairs.sh"))).toBe(false);
    expect(existsSync(join(root, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
  } finally {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  // Neither module exports a boolean switch, and the gate reads only the projection it is given.
  for (const module of [installMiniApps, zzzManagedJob]) {
    expect(Object.entries(module).filter(([, value]) => typeof value === "boolean")).toEqual([]);
  }
  expect(zzzParticipation.toString()).not.toMatch(/process\.env|Bun\.env|import\.meta\.env/);
  const source = readFileSync(join(REPO, "install", "install_miniapps.ts"), "utf8");
  expect(source.match(/const zzzManaged = .*;/g)).toEqual(["const zzzManaged = zzzParticipation(projection);"]);
});

test("Slopfolio manifest and native allowlist pin only private draft operations and stage the author skill", () => {
  const app = REVIEWED_MINI_APPS.find(app => app.id === "slopfolio")!;
  const manifest = reviewedManifest("slopfolio");
  expect(app).toEqual({ id: "slopfolio", version: "1.0.0", operations: ["slopfolio.prepare", "slopfolio.status"], skills: ["slopfolio"] });
  expect(manifest).toMatchObject({ ...app, homepage: "https://slopfolio.com" });
  expect(manifest.permissions.map((permission: { kind: string }) => permission.kind)).toEqual(["read", "action"]);
  expect(manifest).not.toHaveProperty("mcp");
  expect(EDGE_SKILL_NAMES).not.toContain("slopfolio");
  const projection = { version: 1, apps: [app] };
  expect(validateProjection(projection)).toEqual(projection);
  for (const changed of [
    { ...app, operations: [...app.operations, "publish_slopfolio_post"] },
    { ...app, operations: [...app.operations].reverse() },
    { ...app, operations: ["mini-app.read"] },
    { ...app, skills: ["other"] },
    { ...app, version: "1.0.1" },
  ]) expect(() => validateProjection({ version: 1, apps: [changed] })).toThrow("mini_apps_unreviewed_bundle");
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  expect(plugin).toContain('SLOPFOLIO = {"version": "1.0.0", "skills": ["slopfolio"], "operations": ["slopfolio.prepare", "slopfolio.status"]}');
  const root = installedBox();
  reconcileMiniApps(all, root);
  const source = join(REPO, "skills", "slopfolio", "SKILL.md");
  const receipt = reconcileMiniApps(projection, root);
  expect(receipt.files.map(file => file.path)).toEqual(["skills/slopfolio/SKILL.md"]);
  expect(readFileSync(join(root, "skills", "slopfolio", "SKILL.md"))).toEqual(readFileSync(source));
  expect(statSync(join(root, "skills", "slopfolio", "SKILL.md")).mode & 0o777).toBe(0o600);
  expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
});

test("For Kicks stages its exact reviewed skill and revokes only its permission and managed file", () => {
  const app = REVIEWED_MINI_APPS[2];
  const manifest = reviewedManifest("forkicks");
  expect([app.id, app.version, [...app.skills], [...app.operations]]).toEqual([
    "forkicks", "1.0.0", ["forkicks"],
    ["forkicks.menu", "forkicks.schedule", "forkicks.order.prepare", "forkicks.order.confirm", "forkicks.order.status", "forkicks.order.cancel"],
  ]);
  expect(manifest.operations).toEqual(app.operations);
  expect(manifest.skills).toEqual(app.skills);
  expect(manifest).not.toHaveProperty("mcp");
  expect(manifest).not.toHaveProperty("credit");
  const root = home(), projection = { version: 1, apps: [app] };
  reconcileMiniApps(projection, root);
  const path = join(root, "skills/forkicks/SKILL.md");
  expect(readFileSync(path)).toEqual(readFileSync(join(REPO, "skills/forkicks/SKILL.md")));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(reconcileMiniApps(projection, root, undefined, true).apps).toEqual([{ id: "forkicks", version: "1.0.0" }]);
  writeFileSync(join(root, "skills/forkicks/resident-note.txt"), "keep");
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(path)).toBe(false);
  expect(readFileSync(join(root, "skills/forkicks/resident-note.txt"), "utf8")).toBe("keep");
  for (const operations of [app.operations.slice(0, -1), [...app.operations].reverse(), [...app.operations, "mini-app.read"]]) {
    expect(() => validateProjection({ version: 1, apps: [{ ...app, operations }] })).toThrow("mini_apps_unreviewed_bundle");
  }
});

test("MOSAIC (app#486): Dizko's shape, its context read/write after mini-app.read, the read-only entry stageable byte for byte", () => {
  const mosaic = REVIEWED_MINI_APPS.find((app) => app.id === "mosaic")!;
  const previous = PREVIOUS_REVIEWED_MINI_APPS.find((app) => app.id === "mosaic")!;
  const dizko = REVIEWED_MINI_APPS[1], dizkoPrevious = PREVIOUS_REVIEWED_MINI_APPS[2];
  const read = "mini-app.read", ctxRead = "mini-app.context.read", ctxWrite = "mini-app.context.write";
  expect([mosaic.id, mosaic.version, [...mosaic.skills], [...mosaic.operations]]).toEqual(["mosaic", "1.0.0", ["mosaic"], [read, ctxRead, ctxWrite]]);
  expect([previous.id, previous.version, [...previous.skills], [...previous.operations]]).toEqual(["mosaic", "1.0.0", ["mosaic"], [read]]);
  // Exactly Dizko's two operation lists, so the plugin's generic allow-list (APP_OPERATIONS_ACCEPTED, skills
  // exactly [appId]) grants it with no plugin change.
  expect([[...mosaic.operations], [...previous.operations]]).toEqual([[...dizko.operations], [...dizkoPrevious.operations]]);
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  expect(plugin).toContain('app["skills"] != [name] or not any(app["operations"] == list(ops) for ops in APP_OPERATIONS_ACCEPTED)');
  expect(plugin).not.toContain('"mosaic"');
  // The reviewed manifest (v2, service kind "none": a context-only app, the validator's grant to mosaic alone)
  // serves the CP's two entries: its base entry is the previous list, its context entry the current one,
  // restricted with the 12-line namespace declaration, and never an MCP block or a credit.
  const manifest = reviewedManifest("mosaic");
  expect(manifest).toMatchObject({ id: "mosaic", version: "1.0.0", skills: ["mosaic"], operations: [read], homepage: "https://agents.edgecity.live" });
  expect(Object.keys(manifest).sort()).toEqual(["data", "description", "homepage", "id", "name", "operations", "permissions", "restricted", "skills", "version"]);
  expect([manifest.restricted, manifest.data]).toEqual([true, { context: { maxEntries: 12 } }]);
  expect([[...manifest.operations], [...reviewedManifest("mosaic", { person: true, context: true }).operations]]).toEqual([[...previous.operations], [...mosaic.operations]]);
  expect(manifest.permissions.map((permission: { kind: string }) => permission.kind)).toEqual(["read"]);
  // Only ever staged on install: not shipped to every box, never a references path.
  expect(EDGE_SKILL_NAMES).not.toContain("mosaic");
  expect(SHIPPED_SKILLS.has("mosaic")).toBe(false);
  const skill = readFileSync(join(REPO, "skills", "mosaic", "SKILL.md"), "utf8");
  expect(skill).toMatch(/^---\nname: mosaic\n[\s\S]*\nversion: 1\.0\.1\n/);
  expect(skill).toContain('{"operation":"mini-app.context.read","appId":"mosaic","arguments":{}}');
  expect(skill).not.toMatch(/prompt\.txt|\.well-known|\/mcp\b|curl|wget|https?:\/\//);
  // review-b ov#551 S1: not_open is the gate that makes /mosaic a 404 for them, so no link then (app#914 drops `home` there too).
  expect(skill).toContain("`not_open` means Mosaic is not\n  open for them yet: say so plainly, without the link");
  for (const entry of [mosaic, previous]) {
    const projection = { version: 1, apps: [REVIEWED_MINI_APPS[0], { id: entry.id, version: entry.version, operations: [...entry.operations], skills: [...entry.skills] }] };
    const root = installedBox();
    const receipt = reconcileMiniApps(projection, root);
    expect(receipt.files.map((file) => file.path)).toEqual(["skills/gold-stars/SKILL.md", "skills/mosaic/SKILL.md"]);
    expect(receipt.projectionSha256).toBe(createHash("sha256").update(JSON.stringify(projection)).digest("hex"));
    expect(readFileSync(join(root, "mini-apps.json"), "utf8")).toBe(JSON.stringify(projection));
    expect(readFileSync(join(root, "skills", "mosaic", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "mosaic", "SKILL.md")));
    expect(statSync(join(root, "skills", "mosaic", "SKILL.md")).mode & 0o777).toBe(0o600);
    expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
    reconcileMiniApps({ version: 1, apps: [REVIEWED_MINI_APPS[0]] }, root);
    expect(existsSync(join(root, "skills", "mosaic", "SKILL.md"))).toBe(false);
  }
  expect(() => validateProjection({ version: 1, apps: [mosaic, previous] })).toThrow("mini_apps_unreviewed_bundle");
  // A skill that does not exist (or none) is not this review: refused before anything is written.
  for (const skills of [[], ["mosaic-box"], ["dizko"], ["mosaic", "mosaic"]]) {
    expect(() => validateProjection({ version: 1, apps: [{ ...mosaic, skills }] })).toThrow("mini_apps_unreviewed_bundle");
  }
  for (const changed of [{ ...mosaic, version: "1.0.1" }, { ...mosaic, data: { context: { maxEntries: 12 } } }, { ...mosaic, restricted: true }]) {
    expect(() => validateProjection({ version: 1, apps: [changed] })).toThrow("mini_apps_unreviewed_bundle");
  }
  // The helper stages skills/<appId>/SKILL.md for every desired app, so a reviewed app with no SKILL.md in the
  // source fails the reconcile (the box's whole mini-apps projection, Gold Stars included) and writes nothing.
  const empty = home(), box = installedBox(), before = snapshot(box);
  expect(() => reconcileMiniApps({ version: 1, apps: [REVIEWED_MINI_APPS[0], mosaic] }, box, empty)).toThrow();
  expect(snapshot(box)).toEqual(before);
  const planted = [
    [read, ctxRead, ctxWrite, "mini-app.context.delete"], [read, "gold-stars.send"], [ctxRead, read, ctxWrite],
    [read, ctxWrite, ctxRead], [read, read], [read, ctxRead], [read, ctxWrite], [ctxRead, ctxWrite], [],
  ];
  for (const operations of planted) expect(() => validateProjection({ version: 1, apps: [{ ...mosaic, operations }] })).toThrow("mini_apps_unreviewed_bundle");
});

test("DreamStarter (adapted from ov#393): the manifest and native allowlist pin its nine named operations, two of them writes, and stage the skill", () => {
  const app = REVIEWED_MINI_APPS.find(app => app.id === "dreamstarter")!;
  const ops = ["dreamstarter.discover", "dreamstarter.dream_status", "dreamstarter.workflows", "dreamstarter.grant_requirements", "dreamstarter.grant_prepare",
    "dreamstarter.grant_status", "dreamstarter.businesses", "dreamstarter.business_brief", "dreamstarter.business_status"];
  const writes = ["dreamstarter.discover", "dreamstarter.grant_prepare"];
  const manifest = reviewedManifest("dreamstarter");
  expect(app).toEqual({ id: "dreamstarter", version: "2.0.0", operations: ops, skills: ["dreamstarter"] });
  expect(manifest).toMatchObject({ ...app, homepage: "https://dreamstarter.xyz", restricted: true });
  // app-token: no per-resident OAuth (`auth`), no relay (`mcp`, never served as mini-app.read); sandbox, so restricted.
  expect(Object.keys(manifest).sort()).toEqual(["credit", "description", "homepage", "id", "name", "operations", "permissions", "restricted", "skills", "version"]);
  expect(manifest.credit.role).toBe("product");
  expect(manifest.permissions.map((permission: { kind: string }) => permission.kind)).toEqual(["action", "action", "read", "read", "read"]);
  expect(manifest).not.toHaveProperty("mcp");
  expect(manifest).not.toHaveProperty("auth");
  const v2 = JSON.parse(readFileSync(join(REPO, "mini-apps", "dreamstarter", "manifest.json"), "utf8"));
  expect(v2.service).toEqual({ kind: "mcp", baseUrl: "https://mcp.dreamstarter.xyz/mcp", auth: { mode: "app-token", secretRef: "MINI_APP_DREAMSTARTER_KEY" } });
  expect(v2.operations.map((op: { class: string }) => op.class)).toEqual(ops.map(op => writes.includes(op) ? "write" : "read"));
  expect(EDGE_SKILL_NAMES).not.toContain("dreamstarter");
  expect(SHIPPED_SKILLS.has("dreamstarter")).toBe(false);
  const projection = { version: 1, apps: [app] };
  expect(validateProjection(projection)).toEqual(projection);
  for (const changed of [
    { ...app, operations: [...app.operations, "dreamstarter.claim"] },
    { ...app, operations: [...app.operations].reverse() },
    { ...app, operations: ["mini-app.read"] },
    { ...app, operations: ops.filter(op => !writes.includes(op)) },
    { ...app, skills: ["other"] },
    { ...app, version: "1.1.0" },
  ]) expect(() => validateProjection({ version: 1, apps: [changed] })).toThrow("mini_apps_unreviewed_bundle");
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  expect(plugin).toContain('DS_WRITE_OPERATIONS = ("dreamstarter.discover", "dreamstarter.grant_prepare")');
  const root = installedBox();
  const receipt = reconcileMiniApps(projection, root);
  expect(receipt.files.map(file => file.path)).toEqual(["skills/dreamstarter/SKILL.md"]);
  expect(readFileSync(join(root, "skills", "dreamstarter", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "dreamstarter", "SKILL.md")));
  expect(statSync(join(root, "skills", "dreamstarter", "SKILL.md")).mode & 0o777).toBe(0o600);
  expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
  // The skill fetches nothing remote and never names the endpoint or a credential.
  const skill = readFileSync(join(REPO, "skills", "dreamstarter", "SKILL.md"), "utf8");
  expect(skill).not.toMatch(/mcp\.dreamstarter\.xyz|\.well-known|curl|wget|Authorization:/);
  expect(skill).toMatch(/^name: dreamstarter$/m);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "skills", "dreamstarter", "SKILL.md"))).toBe(false);
});

test("kismet 1.1.0: the eight named operations (Part 2) and Part 1's public read alone, staged and removed", () => {
  const kismet = REVIEWED_MINI_APPS.find((x) => x.id === "kismet")!;
  const previous = PREVIOUS_REVIEWED_MINI_APPS.find((x) => x.id === "kismet")!;
  const reads = ["kismet.how_it_works", "kismet.village_stats", "kismet.public_board", "kismet.summary"];
  const writes = ["kismet.signup", "kismet.go", "kismet.decide", "kismet.delete"];
  expect([kismet.id, kismet.version, [...kismet.skills], [...kismet.operations]]).toEqual(["kismet", "1.1.0", ["kismet"], [...reads, ...writes]]);
  expect([previous.id, previous.version, [...previous.skills], [...previous.operations]]).toEqual(["kismet", "1.0.0", ["kismet"], ["mini-app.read"]]);
  expect(EDGE_SKILL_NAMES).not.toContain("kismet");
  // The rename leaves no alias: the old id is neither reviewed nor stageable. Not being reviewed, it is a generic
  // candidate, and with no cp offer for it the installer refuses it alone (offer_missing) and stages nothing.
  expect(REVIEWED_MINI_APPS.some((x) => (x.id as string) === "agent-dates")).toBe(false);
  const oldId = { version: 1, apps: [{ ...previous, id: "agent-dates", skills: ["agent-dates"] }] };
  expect(() => validateProjection(oldId)).toThrow("offer_missing");
  const oldBox = installedBox();
  const oldReceipt = reconcileMiniApps(oldId, oldBox);
  expect([oldReceipt.refused, oldReceipt.apps, oldReceipt.files]).toEqual([[{ id: "agent-dates", code: "offer_missing" }], [], []]);
  expect(existsSync(join(oldBox, "skills", "agent-dates"))).toBe(false);
  expect(existsSync(join(REPO, "skills", "agent-dates"))).toBe(false);
  expect(existsSync(join(REPO, "mini-apps", "agent-dates"))).toBe(false);
  // The manifest and skill agree with the entry. App-token: no per-resident OAuth (`auth`) and no relay (`mcp`): the
  // app server holds the key and calls Kismet; the box names operations only.
  const manifest = reviewedManifest("kismet");
  expect([manifest.id, manifest.name, manifest.version, manifest.skills, manifest.operations]).toEqual([kismet.id, "Kismet", kismet.version, [...kismet.skills], [...kismet.operations]]);
  expect(manifest.permissions.map((p: { kind: string }) => p.kind)).toEqual(["read", "read", "action"]);
  expect(manifest).not.toHaveProperty("mcp");
  expect(manifest).not.toHaveProperty("auth");
  const v2 = JSON.parse(readFileSync(join(REPO, "mini-apps", "kismet", "manifest.json"), "utf8"));
  expect(v2.service).toEqual({ kind: "mcp", baseUrl: "https://kismet-village.vercel.app/mcp", auth: { mode: "app-token", secretRef: "MINI_APP_KISMET_KEY" } });
  expect(v2.operations.map((op: { class: string }) => op.class)).toEqual([...reads.map(() => "read"), ...writes.map(() => "write")]);
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  expect(plugin).toContain('KISMET_READ_OPERATIONS = ("kismet.how_it_works", "kismet.village_stats", "kismet.public_board", "kismet.summary")');
  expect(plugin).toContain('KISMET_WRITE_OPERATIONS = ("kismet.signup", "kismet.go", "kismet.decide", "kismet.delete")');
  const skill = readFileSync(join(REPO, "skills", "kismet", "SKILL.md"), "utf8");
  expect(skill).toMatch(/^---\r?\nname: kismet\r?\n[\s\S]*\r?\nversion: 1\.1\.0\r?\n/);
  expect(skill).not.toContain(v2.service.baseUrl); // the endpoint lives in the reviewed manifest only
  expect(skill).not.toContain("/api/"); // no service API: the app server owns every call
  expect(skill).not.toContain("MINI_APP_KISMET_KEY"); // the key is named only in the manifest, never valued anywhere
  for (const op of [...reads, ...writes]) expect(skill).toContain("`" + op + "`"); // the skill names each operation
  const root = installedBox();
  for (const entry of [kismet, previous]) {
    const projection = { version: 1, apps: [{ id: entry.id, version: entry.version, operations: [...entry.operations], skills: [...entry.skills] }] };
    expect(validateProjection(projection)).toEqual(projection);
    const receipt = reconcileMiniApps(projection, root);
    expect(receipt.files.map((x) => x.path)).toEqual(["skills/kismet/SKILL.md"]);
    expect(readFileSync(join(root, "skills", "kismet", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "kismet", "SKILL.md")));
    expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
  }
  // Any other list is refused: a planted or unknown op, a reorder, a duplicate, a subset or none.
  const all8 = [...kismet.operations];
  // kismet.notes (live on Kismet's /mcp, not reviewed for Part 2, lead L29967) is refused like any unreviewed op.
  for (const operations of [[...all8, "kismet.status"], [...all8, "kismet.notes"], ["mini-app.read", "kismet.notes"], [...all8, "mini-app.context.write"], [...all8, "mini-app.read"], [...all8].reverse(),
    [...all8, "kismet.delete"], all8.slice(0, 7), reads, writes, ["mini-app.read", "kismet.signup"], ["mini-app.read", "mini-app.context.read"],
    ["mini-app.read", "mini-app.read"], ["kismet.decide"], []]) {
    expect(() => validateProjection({ version: 1, apps: [{ ...kismet, operations }] })).toThrow("mini_apps_unreviewed_bundle");
  }
  for (const changed of [{ ...kismet, version: "1.0.0" }, { ...previous, version: "1.1.0" }, { ...kismet, version: "1.1.1" }, { ...kismet, skills: ["other"] }]) {
    expect(() => validateProjection({ version: 1, apps: [changed] })).toThrow("mini_apps_unreviewed_bundle");
  }
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "skills", "kismet", "SKILL.md"))).toBe(false);
});

test("ov#441 S1 (d): every projection this installer writes is accepted WHOLE by the plugin's strict reader", () => {
  // The regression class nonav flagged (L17033): the WIP wrote `zzz_bridge`, which the plugin's reader refused,
  // and its whole-projection refusal silently took Gold Stars and zzzbot down with it. The reader's refusal is
  // pinned (plugins/village-bridge/tests/test_zzz_managed.py); this pins the other half: the installer never
  // writes a file that reader refuses, for every reviewed entry and every earlier entry it still stages.
  const zzzbot = REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!;
  const bridge = REVIEWED_MINI_APPS.find(app => app.id === ZZZ_BRIDGE_ID)!;
  const projections: { version: 1; apps: readonly { id: string }[] }[] = [
    all, { version: 1, apps: [zzzbot, bridge] }, { version: 1, apps: [bridge, zzzbot] }, { version: 1, apps: [zzzbot] }, { version: 1, apps: [bridge] },
    ...PREVIOUS_REVIEWED_MINI_APPS.map(previous => ({ version: 1 as const, apps: REVIEWED_MINI_APPS.map(app => app.id === previous.id ? previous : app) })),
  ];
  const homes = projections.map(projection => {
    const root = installedBox();
    reconcileMiniApps(projection, root);
    return root;
  });
  const which = Bun.which("python3");
  expect(which).not.toBeNull();
  const python = spawnSync(which!, ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  const probe = home();
  writeFileSync(join(probe, "probe.py"), [
    "import importlib.util, json, sys",
    "from pathlib import Path",
    'spec = importlib.util.spec_from_file_location("mini_apps_probe", sys.argv[1])',
    "mini = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mini)",
    "out = []",
    "for home in sys.argv[2:]:",
    "    apps = mini.projection(Path(home))",
    "    out.append([None if apps is None else [app['id'] for app in apps], mini.zzz_participation(Path(home))])",
    "print(json.dumps(out))",
    "",
  ].join("\n"));
  const run = spawnSync(python, ["-I", join(probe, "probe.py"), join(REPO, "plugins", "village-bridge", "_mini_apps.py"), ...homes],
    { cwd: probe, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual(projections.map(projection => [projection.apps.map(app => app.id), zzzParticipation(projection)]));
});
