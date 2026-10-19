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
  expect(receipt.files.map(x => x.path)).toEqual(["skills/gold-stars/SKILL.md", "skills/dizko/SKILL.md", "skills/forkicks/SKILL.md", "skills/zzzbot/SKILL.md", "skills/slopfolio/SKILL.md", "skills/mosaic/SKILL.md", "skills/kismet/SKILL.md"]);
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
  expect(existsSync(join(root, "skills", "forkicks", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "zzzbot", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "slopfolio", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "mosaic", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "kismet", "SKILL.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "gold-stars", "SKILL.md"))).toBe(true);
  expect(reconcileMiniApps({ version: 1, apps: [] }, root, undefined, true).apps).toEqual([]);
});

test("the helper never removes an installer-shipped skill, for any desired set", () => {
  // The reviewed ids the installer also ships (today: gold-stars) are exactly the protected ones.
  expect(REVIEWED_MINI_APPS.filter((a) => SHIPPED_SKILLS.has(a.id)).map((a) => a.id)).toEqual(["gold-stars"]);
  expect([...SHIPPED_SKILLS].sort()).toEqual([...EDGE_SKILL_NAMES].sort());
  const sets = [[], ...REVIEWED_MINI_APPS.map((app) => [app]), [...REVIEWED_MINI_APPS]];
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
    expect(existsSync(join(root, "skills", "kismet", "SKILL.md"))).toBe(second.some((a) => a.id === "kismet"));
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
  // NEW-03: the third previous entry is dizko's public read alone, the fourth mosaic's, the fifth kismet's (each asserted in its own test below).
  expect(PREVIOUS_REVIEWED_MINI_APPS.length).toBe(5);
  expect(PREVIOUS_REVIEWED_MINI_APPS.filter((x) => x.id === "gold-stars").length).toBe(2);
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

test("zzz.bot manifest and native allowlist pin exactly its five named operations and stage the author skill", () => {
  const app = REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!;
  const ops = ["zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread"];
  const manifest = JSON.parse(readFileSync(join(REPO, "mini-apps", "zzzbot", "manifest.json"), "utf8"));
  expect(app).toEqual({ id: "zzzbot", version: "1.0.0", operations: ops, skills: ["zzzbot"] });
  expect(manifest).toMatchObject({ ...app, homepage: "https://zzz.bot" });
  expect(Object.keys(manifest).sort()).toEqual(["description", "homepage", "id", "name", "operations", "permissions", "skills", "version"]);
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
  const root = installedBox();
  const receipt = reconcileMiniApps(projection, root);
  expect(receipt.files.map(file => file.path)).toEqual(["skills/zzzbot/SKILL.md"]);
  expect(readFileSync(join(root, "skills", "zzzbot", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "zzzbot", "SKILL.md")));
  expect(statSync(join(root, "skills", "zzzbot", "SKILL.md")).mode & 0o777).toBe(0o600);
  expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
  // The skill asks the agent to fetch no third-party prompt or instruction file (ov#382 owner read M2).
  const skill = readFileSync(join(REPO, "skills", "zzzbot", "SKILL.md"), "utf8");
  expect(skill).not.toMatch(/prompt\.txt|\.well-known|\/mcp\b|curl|wget/);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "skills", "zzzbot", "SKILL.md"))).toBe(false);
});

test("Slopfolio manifest and native allowlist pin only private draft operations and stage the author skill", () => {
  const app = REVIEWED_MINI_APPS.find(app => app.id === "slopfolio")!;
  const manifest = JSON.parse(readFileSync(join(REPO, "mini-apps", "slopfolio", "manifest.json"), "utf8"));
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
  const manifest = JSON.parse(readFileSync(join(REPO, "mini-apps/forkicks/manifest.json"), "utf8"));
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
  // The reviewed manifest is the CP's base entry (no restricted marker, no data block, no MCP, no credit).
  const manifest = JSON.parse(readFileSync(join(REPO, "mini-apps", "mosaic", "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ id: "mosaic", version: "1.0.0", skills: ["mosaic"], operations: [read], homepage: "https://agents.edgecity.live" });
  expect(Object.keys(manifest).sort()).toEqual(["description", "homepage", "id", "name", "operations", "permissions", "skills", "version"]);
  expect(manifest.permissions.map((permission: { kind: string }) => permission.kind)).toEqual(["read"]);
  // Only ever staged on install: not shipped to every box, never a references path.
  expect(EDGE_SKILL_NAMES).not.toContain("mosaic");
  expect(SHIPPED_SKILLS.has("mosaic")).toBe(false);
  const skill = readFileSync(join(REPO, "skills", "mosaic", "SKILL.md"), "utf8");
  expect(skill).toMatch(/^---\nname: mosaic\n[\s\S]*\nversion: 1\.0\.0\n/);
  expect(skill).toContain('{"operation":"mini-app.context.read","appId":"mosaic","arguments":{}}');
  expect(skill).not.toMatch(/prompt\.txt|\.well-known|\/mcp\b|curl|wget|https?:\/\//);
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

test("kismet 1.1.0: its public read then the owner's account operations; the 1.0.0 public read stays stageable", () => {
  const kismet = REVIEWED_MINI_APPS.find((x) => x.id === "kismet")!;
  const pub = PREVIOUS_REVIEWED_MINI_APPS.find((x) => x.id === "kismet")!;
  const ops = ["mini-app.read", "kismet.status", "kismet.signup", "kismet.decide", "kismet.delete"];
  expect([kismet.id, kismet.version, [...kismet.skills], [...kismet.operations]]).toEqual(["kismet", "1.1.0", ["kismet"], ops]);
  expect([pub.id, pub.version, [...pub.skills], [...pub.operations]]).toEqual(["kismet", "1.0.0", ["kismet"], ["mini-app.read"]]);
  expect(EDGE_SKILL_NAMES).not.toContain("kismet");
  // The rename leaves no alias: the old id is neither reviewed nor stageable.
  expect([...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS].some((x) => (x.id as string) === "agent-dates")).toBe(false);
  expect(() => validateProjection({ version: 1, apps: [{ ...kismet, id: "agent-dates", skills: ["agent-dates"] }] })).toThrow("mini_apps_unreviewed_bundle");
  // Parity: the plugin's exact entries and the reviewed manifest carry the same operations, in order.
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  const entry = (name: string) => JSON.parse(new RegExp(`^${name} = (\\{.*\\})$`, "m").exec(plugin)![1]);
  expect(entry("KISMET")).toEqual({ version: kismet.version, skills: [...kismet.skills], operations: [...kismet.operations] });
  expect(entry("KISMET_PUBLIC")).toEqual({ version: pub.version, skills: [...pub.skills], operations: [...pub.operations] });
  const manifest = JSON.parse(readFileSync(join(REPO, "mini-apps", "kismet", "manifest.json"), "utf8"));
  expect([manifest.id, manifest.name, manifest.version, manifest.skills, manifest.operations]).toEqual(["kismet", "Kismet", kismet.version, [...kismet.skills], [...kismet.operations]]);
  expect(manifest.permissions.map((p: { kind: string }) => p.kind)).toEqual(["read", "read", "action"]);
  expect(manifest.mcp.url).toBe("https://kismet-village.vercel.app/mcp");
  expect(manifest.mcp.tools.map((t: { name: string }) => t.name)).toEqual(["how_it_works", "village_stats", "public_board"]);
  for (const t of manifest.mcp.tools) {
    expect(t.inputSchema.type).toBe("object");
    expect(t.inputSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(t.inputSchema)).not.toContain("$schema");
  }
  const skill = readFileSync(join(REPO, "skills", "kismet", "SKILL.md"), "utf8");
  expect(skill).toMatch(/^---\r?\nname: kismet\r?\n[\s\S]*\r?\nversion: 1\.1\.0\r?\n/);
  expect(skill).not.toContain(manifest.mcp.url); // the endpoint lives in the reviewed manifest only
  expect(skill).not.toContain("/api/"); // the app server owns every Kismet call
  expect(skill).not.toMatch(/residentId|VILLAGE_PARTNER_KEY/); // identity comes from the bearer, the key is the app server's
  for (const op of ops) expect(skill).toContain(op);
  // Both entries stage the same reviewed skill, and the receipt hashes the CP's exact bytes.
  for (const app of [kismet, pub]) {
    const projection = { version: 1, apps: [{ id: app.id, version: app.version, operations: [...app.operations], skills: [...app.skills] }] };
    const root = installedBox();
    const receipt = reconcileMiniApps(projection, root);
    expect(receipt.files.map((x) => x.path)).toEqual(["skills/kismet/SKILL.md"]);
    expect(receipt.projectionSha256).toBe(createHash("sha256").update(JSON.stringify(projection)).digest("hex"));
    expect(readFileSync(join(root, "skills", "kismet", "SKILL.md"))).toEqual(readFileSync(join(REPO, "skills", "kismet", "SKILL.md")));
    expect(statSync(join(root, "skills", "kismet", "SKILL.md")).mode & 0o777).toBe(0o600);
    expect(reconcileMiniApps(projection, root, undefined, true)).toEqual(receipt);
    reconcileMiniApps({ version: 1, apps: [] }, root);
    expect(existsSync(join(root, "skills", "kismet", "SKILL.md"))).toBe(false);
  }
  expect(() => validateProjection({ version: 1, apps: [kismet, pub] })).toThrow("mini_apps_unreviewed_bundle");
  // A partial, reordered or planted list is refused, as is the 1.1.0 list at the old version.
  const planted = [ops.slice(0, -1), ops.slice(1), [...ops].reverse(), [...ops, "gold-stars.send"], [...ops, "mini-app.context.write"],
    ["mini-app.read", "mini-app.context.read", "mini-app.context.write"], ["mini-app.read", "kismet.status"], ["kismet.decide"], [...ops, "kismet.go"], []];
  for (const operations of planted) expect(() => validateProjection({ version: 1, apps: [{ ...kismet, operations }] })).toThrow("mini_apps_unreviewed_bundle");
  expect(() => validateProjection({ version: 1, apps: [{ ...kismet, version: "1.0.0" }] })).toThrow("mini_apps_unreviewed_bundle");
  expect(() => validateProjection({ version: 1, apps: [{ ...pub, version: "1.1.0" }] })).toThrow("mini_apps_unreviewed_bundle");
});
