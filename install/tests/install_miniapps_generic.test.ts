// MINI-APPS v2 GENERIC (CLAIMS L19473; box contract review-b L19490; receipt contract context L19498 / lead L19499):
// a new generic app is a cp-only change. The installer accepts an app in neither reviewed table when its operations
// are exactly the generic set (or the read alone), skills == [id], and the cp's offer carries its SKILL.md bytes
// hashing to the offered sha256. A refused generic app fails only itself (`refused: [{ id, code }]`); a reviewed
// app never does (it keeps today's whole-stage failure).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BUNDLE_MAX_CHARS, GENERIC_ID, GENERIC_OPERATIONS_ACCEPTED, GENERIC_STATE, PREVIOUS_REVIEWED_MINI_APPS, reconcileMiniApps, REFUSAL_CODES, REVIEWED_MINI_APPS, SKILL_MAX_BYTES, validateProjection } from "../install_miniapps";
import { EDGE_SKILL_NAMES, RETIRED_SKILL_DIRS } from "../paths";

const REPO = join(import.meta.dir, "..", "..");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "curated-miniapps-generic-"));
  roots.push(root);
  return root;
}
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
const OFFER = "cd".repeat(32);
const READ = "mini-app.read", CTX_READ = "mini-app.context.read", CTX_WRITE = "mini-app.context.write";
const GENERIC_OPS = [READ, CTX_READ, CTX_WRITE];
const TEXT = "---\nname: civic-board\nversion: 1.0.0\n---\n# Civic Board\nRead the board with mini-app.read.\n";
/** A generic app's SKILL.md answers to exactly its id (frontmatter `name:`, RA34 S1). */
const skillText = (id: string) => TEXT.replace("name: civic-board", `name: ${id}`);
type Entry = { id: string; sha256: string; bytes: string };
type Delivery = { offer?: string; skills?: string };
const entry = (id: string, text: string | Buffer, digest = sha(text)): Entry => ({ id, sha256: digest, bytes: Buffer.from(text).toString("base64") });
const bundle = (...skills: Entry[]) => ({ offer: OFFER, skills: JSON.stringify({ version: 1, skills }) });
/** The entry the cp projects for a generic app: exactly today's shape, {id, version, operations, skills}. */
const generic = (id = "civic-board", operations: unknown = GENERIC_OPS) => ({ id, version: "1.0.0", operations, skills: [id] });
const gold = () => ({ ...REVIEWED_MINI_APPS[0], operations: [...REVIEWED_MINI_APPS[0].operations], skills: [...REVIEWED_MINI_APPS[0].skills] });
const dizko = () => ({ ...REVIEWED_MINI_APPS[1], operations: [...REVIEWED_MINI_APPS[1].operations], skills: [...REVIEWED_MINI_APPS[1].skills] });
const onDisk = (root: string) => readFileSync(join(root, "mini-apps.json"), "utf8");
const skillPath = (root: string, id: string) => join(root, "skills", id, "SKILL.md");
type Receipt = ReturnType<typeof reconcileMiniApps> & { refused?: { id: string; code: string }[] };
const REVIEWED_IDS = new Set<string>([...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS].map(a => a.id));
/** The plugin's own installed() over the staged mini-apps.json (plugins/village-bridge/_mini_apps.py). */
function pluginInstalled(root: string, checks: [string, string][]): boolean[] {
  const code = "import importlib.util, json, pathlib, sys\n" +
    "spec = importlib.util.spec_from_file_location('mini', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n" +
    "print(json.dumps([m.installed(pathlib.Path(sys.argv[2]), a, o) for a, o in json.loads(sys.argv[3])]))";
  const run = spawnSync("python3", ["-I", "-c", code, join(REPO, "plugins", "village-bridge", "_mini_apps.py"), realpathSync(root), JSON.stringify(checks)], { encoding: "utf8" });
  expect([run.status, run.stderr]).toEqual([0, ""]);
  return JSON.parse(run.stdout);
}
/**
 * The receipt invariants the cp checks (context L19498): apps == projection minus refused ids, in projection order;
 * files == the skill paths of accepted apps plus the managed ZZZ files only when both ZZZ entries are projected;
 * refused ids a subset of the projection's, no duplicates, no overlap with
 * apps; never a reviewed id; codes from the closed set; `refused` omitted when empty; mini-apps.json and
 * projectionSha256 are the accepted subset; verify with the same delivery recomputes the same receipt.
 */
function staged(projection: { version: number; apps: { id: string }[] }, root: string, delivery: Delivery = {}): Receipt {
  const receipt = reconcileMiniApps(projection, root, undefined, false, delivery) as Receipt;
  const refusedIds = (receipt.refused ?? []).map(r => r.id);
  const ids = projection.apps.map(a => a.id);
  expect(receipt.version).toBe(1);
  expect(receipt.staged).toBe(true);
  if (receipt.refused) expect(receipt.refused.length).toBeGreaterThan(0);
  expect(new Set(refusedIds).size).toBe(refusedIds.length);
  for (const id of refusedIds) expect(ids).toContain(id);
  for (const id of refusedIds) expect(REVIEWED_IDS.has(id)).toBe(false);
  for (const r of receipt.refused ?? []) expect(Object.keys(r).sort()).toEqual(["code", "id"]);
  for (const r of receipt.refused ?? []) expect(REFUSAL_CODES).toContain(r.code as typeof REFUSAL_CODES[number]);
  const accepted = projection.apps.filter(a => !refusedIds.includes(a.id));
  expect(receipt.apps.map(a => a.id)).toEqual(accepted.map(a => a.id));
  const expectedFiles = accepted.filter(a => a.id !== "zzz-bridge").map(a => `skills/${a.id}/SKILL.md`);
  if (accepted.some(a => a.id === "zzzbot") && accepted.some(a => a.id === "zzz-bridge")) {
    expectedFiles.push("skills/zzzbot/scripts/zzz_managed_runner.py", "skills/zzzbot/prompts/participate.md");
  }
  expect(receipt.files.map(f => f.path)).toEqual(expectedFiles);
  const subset = JSON.stringify({ version: 1, apps: accepted });
  expect(receipt.projectionSha256).toBe(sha(subset));
  if (accepted.length || existsSync(join(root, "mini-apps.json"))) expect(onDisk(root)).toBe(subset);
  for (const f of receipt.files) expect(sha(readFileSync(join(root, f.path)))).toBe(f.sha256);
  expect(reconcileMiniApps(projection, root, undefined, true, delivery)).toEqual(receipt);
  return receipt;
}
/** The reviewed gold-stars + dizko still on the box and granted by the bridge, whatever happened to the generic app. */
function reviewedStaged(root: string) {
  expect(JSON.parse(onDisk(root)).apps.map((a: { id: string }) => a.id).slice(0, 2)).toEqual(["gold-stars", "dizko"]);
  expect(readFileSync(skillPath(root, "dizko"))).toEqual(readFileSync(join(REPO, "skills", "dizko", "SKILL.md")));
  expect(pluginInstalled(root, [["gold-stars", "rolodex.search"], ["dizko", CTX_WRITE]])).toEqual([true, true]);
}
function refusedAlone(app: unknown, delivery: Delivery, code: string) {
  const root = home();
  const receipt = staged({ version: 1, apps: [gold(), dizko(), app as { id: string }] }, root, delivery);
  expect(receipt.refused).toEqual([{ id: (app as { id: string }).id, code }]);
  expect(existsSync(skillPath(root, (app as { id: string }).id))).toBe(false);
  expect(receipt.skills.served).toEqual([]);
  reviewedStaged(root);
  return receipt;
}

test("the refusal codes are exactly the cp contract's six; the generic lists are exactly the bridge's APP_OPERATIONS_ACCEPTED", () => {
  expect([...REFUSAL_CODES]).toEqual(["offer_missing", "bundle_invalid", "sha_mismatch", "operations_not_generic", "shadows_reviewed", "budget"]);
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  const accepted = /^APP_OPERATIONS_ACCEPTED = \((.*)\)$/m.exec(plugin)![1];
  expect(JSON.parse("[" + accepted.replace(/\(/g, "[").replace(/,\)/g, "]").replace(/\)/g, "]") + "]")).toEqual(GENERIC_OPERATIONS_ACCEPTED.map(ops => [...ops]));
  // The box's id rule is inside the bridge's (re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name)).
  expect(plugin).toContain('re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name)');
});

test("a generic app whose offered SKILL.md hashes to the offered sha256 is staged with the cp's exact bytes; the bridge grants it", () => {
  for (const operations of GENERIC_OPERATIONS_ACCEPTED.map(ops => [...ops])) {
    const root = home();
    const projection = { version: 1, apps: [gold(), dizko(), generic("civic-board", operations)] };
    const delivery = bundle(entry("civic-board", TEXT));
    const receipt = staged(projection, root, delivery);
    expect(receipt).not.toHaveProperty("refused");
    // The authority file is the cp's projection byte for byte, so with nothing refused the hash is the cp's.
    expect(onDisk(root)).toBe(JSON.stringify(projection));
    expect(receipt.projectionSha256).toBe(sha(JSON.stringify(projection)));
    expect(readFileSync(skillPath(root, "civic-board"), "utf8")).toBe(TEXT);
    expect(statSync(skillPath(root, "civic-board")).mode & 0o777).toBe(0o600);
    expect(receipt.files.at(-1)).toEqual({ path: "skills/civic-board/SKILL.md", sha256: sha(TEXT) });
    expect(receipt.skills).toEqual({ offer: OFFER, served: ["civic-board"], fallback: [] });
    expect(validateProjection(projection, delivery)).toEqual(projection);
    const ops = [READ, CTX_READ, CTX_WRITE, "gold-stars.send"];
    expect(pluginInstalled(root, ops.map(op => ["civic-board", op] as [string, string]))).toEqual(ops.map(op => operations.includes(op)));
    reviewedStaged(root);
  }
});

test("sha_mismatch: bytes that do not hash to the offered sha256 refuse that app alone", () => {
  refusedAlone(generic(), bundle(entry("civic-board", TEXT + "planted", sha(TEXT))), "sha_mismatch");
  expect(() => validateProjection({ version: 1, apps: [generic()] }, bundle(entry("civic-board", TEXT, sha("x"))))).toThrow("sha_mismatch");
});

test("offer_missing: no offer, no entry for the app, or no well-formed offer digest; never a checkout copy", () => {
  const cases: Delivery[] = [
    {},
    bundle(entry("other-app", TEXT)),
    { skills: bundle(entry("civic-board", TEXT)).skills },
    { offer: OFFER.toUpperCase(), skills: bundle(entry("civic-board", TEXT)).skills },
    { offer: "not-a-digest", skills: bundle(entry("civic-board", TEXT)).skills },
  ];
  for (const delivery of cases) refusedAlone(generic(), delivery, "offer_missing");
  // A checkout copy is never used: an id with a skill directory in the checkout is another installer step's skill.
  const source = join(home(), "skills");
  cpSync(join(REPO, "skills"), source, { recursive: true });
  mkdirSync(join(source, "civic-board"));
  writeFileSync(join(source, "civic-board", "SKILL.md"), TEXT);
  const root = home();
  for (const delivery of [{}, bundle(entry("civic-board", TEXT))]) {
    const receipt = reconcileMiniApps({ version: 1, apps: [gold(), generic()] }, root, source, false, delivery) as Receipt;
    expect(receipt.refused).toEqual([{ id: "civic-board", code: "shadows_reviewed" }]);
    expect(existsSync(skillPath(root, "civic-board"))).toBe(false);
  }
});

test("bundle_invalid: bad base64, oversize, non-UTF-8 or a malformed bundle refuse a generic app (a reviewed app keeps its fallback)", () => {
  const cases: Delivery[] = [
    bundle({ id: "civic-board", sha256: sha(TEXT), bytes: "not base64!" }),
    bundle({ id: "civic-board", sha256: "NOT-HEX", bytes: Buffer.from(TEXT).toString("base64") }),
    bundle(entry("civic-board", Buffer.alloc(SKILL_MAX_BYTES + 1, "a"))),
    bundle(entry("civic-board", Buffer.from([0xff, 0xfe, 0x41]))),
    { offer: OFFER, skills: "{not json" },
    { offer: OFFER, skills: JSON.stringify({ version: 1, skills: [{ ...entry("civic-board", TEXT), path: "skills/civic-board/SKILL.md" }] }) },
    { offer: OFFER, skills: JSON.stringify({ version: 2, skills: [entry("civic-board", TEXT)] }) },
  ];
  for (const delivery of cases) {
    const receipt = refusedAlone(generic(), delivery, "bundle_invalid");
    for (const f of receipt.skills.fallback) expect(["gold-stars", "dizko"]).toContain(f.id);
  }
  // The same malformed bundle leaves a reviewed app's fallback exactly as before.
  expect(refusedAlone(generic(), { offer: OFFER, skills: "{not json" }, "bundle_invalid").skills.fallback)
    .toEqual([{ id: "gold-stars", code: "mini_apps_skill_bundle_invalid" }, { id: "dizko", code: "mini_apps_skill_bundle_invalid" }]);
  // Exactly at the size cap is served.
  const root = home();
  const atCap = TEXT + "a".repeat(SKILL_MAX_BYTES - Buffer.byteLength(TEXT));
  expect(staged({ version: 1, apps: [generic()] }, root, bundle(entry("civic-board", atCap))).skills.served).toEqual(["civic-board"]);
});

test("budget: a bundle over the box's caps (characters, entries) refuses a generic app with `budget`", () => {
  const big = { offer: OFFER, skills: JSON.stringify({ version: 1, skills: [entry("civic-board", TEXT), { id: "pad", sha256: sha("x"), bytes: "A".repeat(BUNDLE_MAX_CHARS) }] }) };
  const many = { offer: OFFER, skills: JSON.stringify({ version: 1, skills: [entry("civic-board", TEXT), ...Array.from({ length: 32 }, (_, i) => entry(`pad${i}`, "x"))] }) };
  for (const delivery of [big, many]) {
    const receipt = refusedAlone(generic(), delivery, "budget");
    expect(receipt.skills.fallback).toEqual([{ id: "gold-stars", code: "mini_apps_skill_bundle_invalid" }, { id: "dizko", code: "mini_apps_skill_bundle_invalid" }]);
  }
});

test("operations_not_generic: an unknown app that is not generic, or the generic set with any other operation, is refused alone", () => {
  const planted: unknown[] = [
    [...GENERIC_OPS, "mini-app.context.delete"], [READ, "gold-stars.send"], [...GENERIC_OPS, "gold-stars.send"], ["gold-stars.send"],
    [CTX_READ, READ, CTX_WRITE], [READ, CTX_WRITE, CTX_READ], [READ, READ], [READ, CTX_READ], [READ, CTX_WRITE], [CTX_READ, CTX_WRITE], [],
    [...REVIEWED_MINI_APPS[2].operations], [READ, "Mini-App.Context.Write"], [READ + " "], READ, null, { [READ]: true },
  ];
  for (const operations of planted) refusedAlone(generic("civic-board", operations), bundle(entry("civic-board", TEXT)), "operations_not_generic");
});

test("shadows_reviewed: an id the installer ships as a skill is refused alone and its baseline SKILL.md is untouched", () => {
  for (const id of EDGE_SKILL_NAMES.filter(name => !REVIEWED_IDS.has(name))) refusedAlone(generic(id), bundle(entry(id, TEXT)), "shadows_reviewed");
  // On a box that has the baseline file, it is left exactly as it is.
  const root = home(), id = EDGE_SKILL_NAMES.find(name => !REVIEWED_IDS.has(name))!;
  mkdirSync(join(root, "skills", id), { recursive: true });
  writeFileSync(skillPath(root, id), "baseline");
  expect(staged({ version: 1, apps: [gold(), generic(id)] }, root, bundle(entry(id, TEXT))).refused).toEqual([{ id, code: "shadows_reviewed" }]);
  expect(readFileSync(skillPath(root, id), "utf8")).toBe("baseline");
});

test("a reviewed id is never refused alone and never staged as a generic app: a mismatch fails the whole stage as today", () => {
  const all = { version: 1, apps: REVIEWED_MINI_APPS };
  const root = home();
  const receipt = staged(all as unknown as { version: number; apps: { id: string }[] }, root);
  expect(receipt).not.toHaveProperty("refused");
  expect(onDisk(root)).toBe(JSON.stringify(all));
  for (const id of [...REVIEWED_IDS]) {
    for (const operations of [GENERIC_OPS, [READ], [...GENERIC_OPS, "mini-app.context.delete"]]) {
      if ([...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS].some(a => a.id === id && JSON.stringify(a.operations) === JSON.stringify(operations))) continue;
      const box = home();
      reconcileMiniApps({ version: 1, apps: [gold()] }, box);
      const before = snapshot(box);
      const others = id === "gold-stars" ? [dizko()] : [gold()];
      expect(() => reconcileMiniApps({ version: 1, apps: [...others, generic(id, operations)] }, box, undefined, false, bundle(entry(id, TEXT)))).toThrow("mini_apps_unreviewed_bundle");
      expect(snapshot(box)).toEqual(before);
    }
  }
  // dizko / mosaic carry exactly the generic set, but as reviewed apps: their checkout copy, today's fallback codes, never `refused`.
  const box = home();
  const r = staged({ version: 1, apps: [gold(), dizko()] }, box, bundle(entry("dizko", TEXT, sha("x"))));
  expect(r.skills.fallback).toEqual([{ id: "dizko", code: "mini_apps_skill_hash_mismatch" }]);
  expect(readFileSync(skillPath(box, "dizko"))).toEqual(readFileSync(join(REPO, "skills", "dizko", "SKILL.md")));
});

test("an unsafe id or a malformed projection fails the whole stage, nothing written; a malformed generic entry is refused alone", () => {
  const delivery = bundle(entry("civic-board", TEXT));
  const fatal: [unknown, string][] = [
    [{ version: 2, apps: [gold()] }, "mini_apps_invalid_projection"],
    [{ version: 1, apps: [gold()], mcp: {} }, "mini_apps_invalid_projection"],
    [{ version: 1, apps: {} }, "mini_apps_invalid_projection"],
    [null, "mini_apps_invalid_projection"],
    [{ version: 1, apps: [gold(), "dizko"] }, "mini_apps_invalid_entry"],
    [{ version: 1, apps: [gold(), null] }, "mini_apps_invalid_entry"],
    [{ version: 1, apps: [gold(), [dizko()]] }, "mini_apps_invalid_entry"],
    [{ version: 1, apps: [gold(), { ...generic(), id: 7 }] }, "mini_apps_invalid_entry"],
    [{ version: 1, apps: [gold(), generic(), generic()] }, "mini_apps_unreviewed_bundle"],
    [{ version: 1, apps: [gold(), dizko(), { ...dizko(), operations: [READ] }] }, "mini_apps_unreviewed_bundle"],
    ...["../escape", "../../escape", "a/b", "civic/../board", ".hidden", "-lead", "Civic", "civic_board", "civic board", "", "a".repeat(41), "9lives"]
      .map(id => [{ version: 1, apps: [gold(), generic(id)] }, "mini_apps_invalid_entry"] as [unknown, string]),
  ];
  for (const [value, code] of fatal) {
    const parent = home(), root = join(parent, "box");
    mkdirSync(root);
    reconcileMiniApps({ version: 1, apps: [gold()] }, root);
    const before = snapshot(parent);
    expect(() => reconcileMiniApps(value, root, undefined, false, delivery)).toThrow(code);
    expect(snapshot(parent)).toEqual(before);
  }
  // A malformed generic entry (rule 5) is refused alone, never the whole stage (RA36 M2): Gold Stars and dizko still stage.
  for (const app of [{ ...generic(), version: "1.0.0-beta.1" }, { ...generic(), version: "1" }, { ...generic(), version: 1 }, { ...generic(), skills: ["other"] },
    { ...generic(), skills: [] }, { ...generic(), skills: ["civic-board", "civic-board"] }, { ...generic(), hooks: ["sh"] }, { ...generic(), skillSha256: sha(TEXT) },
    { id: "civic-board", operations: GENERIC_OPS, skills: ["civic-board"] }]) {
    refusedAlone(app, delivery, "bundle_invalid");
  }
  // The longest safe id is 40 characters.
  const root = home(), id = "a".repeat(40);
  expect(staged({ version: 1, apps: [generic(id)] }, root, bundle(entry(id, skillText(id)))).refused).toBeUndefined();
});

test("the old fail-the-whole-reconcile case now stages the good apps, in projection order (library and CLI)", () => {
  const unknown = { id: "unreviewed", version: "1.0.0", operations: ["unreviewed.do"], skills: ["unreviewed"] };
  const projection = { version: 1, apps: [gold(), unknown, dizko(), generic("civic-board"), generic("no-offer"), generic("pinned-wrong")] };
  const delivery = bundle(entry("civic-board", TEXT), entry("pinned-wrong", TEXT + "x", sha(TEXT)));
  const root = home();
  const receipt = staged(projection, root, delivery);
  expect(receipt.apps.map(a => a.id)).toEqual(["gold-stars", "dizko", "civic-board"]);
  expect(receipt.refused).toEqual([{ id: "unreviewed", code: "operations_not_generic" }, { id: "no-offer", code: "offer_missing" }, { id: "pinned-wrong", code: "sha_mismatch" }]);
  expect(onDisk(root)).toBe(JSON.stringify({ version: 1, apps: [gold(), dizko(), generic("civic-board")] }));
  reviewedStaged(root);
  // The strict check keeps its all-or-nothing contract.
  expect(() => validateProjection(projection, delivery)).toThrow("operations_not_generic");
  // The exact command the cp runs, with the two delivery variables.
  const box = home();
  for (const args of [[], ["--verify"]]) {
    const run = spawnSync("bun", ["--no-env-file", "--no-install", "install/install_miniapps.ts", ...args], {
      cwd: REPO, input: JSON.stringify(projection), encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: box, HERMES_HOME: box, MINI_APPS_SKILLS_OFFER: delivery.offer, MINI_APPS_SKILLS: delivery.skills },
    });
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(JSON.parse(run.stdout)).toEqual(receipt);
  }
});

test("verify recomputes the same subset: a generic app verified without its offer fails closed, never a checkout copy", () => {
  const root = home();
  const projection = { version: 1, apps: [gold(), generic()] };
  staged(projection, root, bundle(entry("civic-board", TEXT)));
  expect(() => reconcileMiniApps(projection, root, undefined, true)).toThrow("mini_apps_projection_mismatch");
  // Other offered bytes for the same app are drift on the staged file.
  expect(() => reconcileMiniApps(projection, root, undefined, true, bundle(entry("civic-board", TEXT + "x")))).toThrow("mini_apps_skill_mismatch");
  // A box-side edit of the staged SKILL.md: the file is no longer ours, so the app is refused again and the
  // authority file no longer matches the recomputed subset.
  writeFileSync(skillPath(root, "civic-board"), "edited on the box");
  expect(() => reconcileMiniApps(projection, root, undefined, true, bundle(entry("civic-board", TEXT)))).toThrow("mini_apps_projection_mismatch");
});

test("a box that refuses every desired app keeps its bridge credential; only an empty desired set revokes it", () => {
  const root = home();
  reconcileMiniApps({ version: 1, apps: [dizko()] }, root);
  writeFileSync(join(root, "village-bridge.json"), "managed bearer fixture");
  const receipt = staged({ version: 1, apps: [generic()] }, root);
  expect(receipt.refused).toEqual([{ id: "civic-board", code: "offer_missing" }]);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(true);
  expect(JSON.parse(onDisk(root))).toEqual({ version: 1, apps: [] });
  expect(existsSync(skillPath(root, "dizko"))).toBe(false);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(false);
});

test("review-b N1 (box side): a symlinked skill directory or file for a generic app never gets a write through it", () => {
  const delivery = bundle(entry("civic-board", TEXT));
  // A symlinked skills/ is fatal before anything is written.
  {
    const root = home(), outside = home();
    symlinkSync(outside, join(root, "skills"));
    expect(() => reconcileMiniApps({ version: 1, apps: [generic()] }, root, undefined, false, delivery)).toThrow("mini_apps_symlink_refused");
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(root, "mini-apps.json"))).toBe(false);
  }
  // A planted skills/<id> (a link, or a directory holding a link) is not ours: that app alone is refused.
  for (const target of ["skills/civic-board", "skills/civic-board/SKILL.md"]) {
    const root = home(), outside = home();
    mkdirSync(join(root, target, ".."), { recursive: true });
    symlinkSync(target.endsWith("SKILL.md") ? join(outside, "SKILL.md") : outside, join(root, target));
    expect(staged({ version: 1, apps: [gold(), generic()] }, root, delivery).refused).toEqual([{ id: "civic-board", code: "shadows_reviewed" }]);
    expect(readdirSync(outside)).toEqual([]);
  }
  // Our own staged SKILL.md replaced by a link: no longer our file, so that app is refused and the link left alone.
  const root = home(), outside = home();
  staged({ version: 1, apps: [generic()] }, root, delivery);
  rmSync(skillPath(root, "civic-board"));
  symlinkSync(join(outside, "SKILL.md"), skillPath(root, "civic-board"));
  expect(staged({ version: 1, apps: [gold(), generic()] }, root, delivery).refused).toEqual([{ id: "civic-board", code: "shadows_reviewed" }]);
  expect(readdirSync(outside)).toEqual([]);
  expect(statSync(join(root, "skills", "civic-board")).isDirectory()).toBe(true);
});

test("security fold (1): a generic id never shadows a skill something else owns", () => {
  const delivery = (id: string) => bundle(entry(id, TEXT));
  // Every skill another installer step stages (each skill directory in this checkout: approval, recall, ...), every
  // retired skill, and every shipped one.
  // (A dot directory such as .claude-plugin fails GENERIC_ID, which is fatal, tested above.)
  const checkoutDirs = readdirSync(join(REPO, "skills"), { withFileTypes: true }).filter(d => d.isDirectory() && GENERIC_ID.test(d.name)).map(d => d.name);
  expect(checkoutDirs).toContain("approval");
  expect(checkoutDirs).toContain("recall");
  for (const id of [...checkoutDirs, ...RETIRED_SKILL_DIRS, ...EDGE_SKILL_NAMES].filter(id => !REVIEWED_IDS.has(id))) {
    refusedAlone(generic(id), delivery(id), "shadows_reviewed");
  }
  // A skill directory already on the box that this installer did not stage (a Hermes bundled skill, a resident's own):
  // refused, left byte for byte.
  for (const files of [["SKILL.md"], ["notes.txt"], []]) {
    const root = home();
    mkdirSync(join(root, "skills", "my-notes"), { recursive: true });
    for (const f of files) writeFileSync(join(root, "skills", "my-notes", f), "resident's own");
    const before = snapshot(root);
    expect(staged({ version: 1, apps: [gold(), generic("my-notes")] }, root, delivery("my-notes")).refused).toEqual([{ id: "my-notes", code: "shadows_reviewed" }]);
    const after = snapshot(root);
    for (const key of Object.keys(before).filter(k => k.startsWith("skills/my-notes"))) expect(after[key]).toBe(before[key]);
    expect(existsSync(join(root, GENERIC_STATE))).toBe(false);
  }
  // A directory this installer staged as a generic app stays ours across stages (a re-stage, a new SKILL.md).
  const root = home();
  staged({ version: 1, apps: [generic()] }, root, delivery("civic-board"));
  expect(JSON.parse(readFileSync(join(root, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: { "civic-board": [sha(TEXT)] } });
  const next = "---\nname: civic-board\nversion: 1.0.1\n---\n# Civic Board v-next\n";
  expect(staged({ version: 1, apps: [generic()] }, root, bundle(entry("civic-board", next))).refused).toBeUndefined();
  expect(readFileSync(skillPath(root, "civic-board"), "utf8")).toBe(next);
  expect(JSON.parse(readFileSync(join(root, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: { "civic-board": [sha(next)] } });
});

test("security fold (3): ownership is per file: a SKILL.md this installer did not write is never overwritten or unlinked", () => {
  const delivery = bundle(entry("civic-board", TEXT));
  // A resident (or agent) replaces our SKILL.md with their own: the id is refused, their file is never overwritten.
  const root = home();
  staged({ version: 1, apps: [gold(), generic()] }, root, delivery);
  writeFileSync(skillPath(root, "civic-board"), "resident's own");
  expect(staged({ version: 1, apps: [gold(), generic()] }, root, delivery).refused).toEqual([{ id: "civic-board", code: "shadows_reviewed" }]);
  expect(readFileSync(skillPath(root, "civic-board"), "utf8")).toBe("resident's own");
  // Ownership ended with our file: the state no longer names it, and leaving the projection never unlinks theirs.
  expect(JSON.parse(readFileSync(join(root, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: {} });
  staged({ version: 1, apps: [gold()] }, root);
  expect(readFileSync(skillPath(root, "civic-board"), "utf8")).toBe("resident's own");
  // Same while the id is still recorded (a foreign file put there between stages): never unlinked, ownership dropped.
  const other = home();
  staged({ version: 1, apps: [generic()] }, other, delivery);
  writeFileSync(skillPath(other, "civic-board"), "agent's own");
  staged({ version: 1, apps: [gold()] }, other);
  expect(readFileSync(skillPath(other, "civic-board"), "utf8")).toBe("agent's own");
  expect(JSON.parse(readFileSync(join(other, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: {} });
  expect(reconcileMiniApps({ version: 1, apps: [gold()] }, other, undefined, true).apps).toEqual([{ id: "gold-stars", version: "1.1.0" }]);
  // Our file removed while the directory stays: ownership is dropped, and the id is not ours to write into again.
  const third = home();
  staged({ version: 1, apps: [generic()] }, third, delivery);
  rmSync(skillPath(third, "civic-board"));
  expect(staged({ version: 1, apps: [generic()] }, third, delivery).refused).toEqual([{ id: "civic-board", code: "shadows_reviewed" }]);
  expect(existsSync(skillPath(third, "civic-board"))).toBe(false);
  expect(JSON.parse(readFileSync(join(third, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: {} });
});

test("security fold (2): a generic app that leaves the projection or is refused later loses its SKILL.md; verify fails while one remains", () => {
  const delivery = bundle(entry("civic-board", TEXT));
  for (const later of [
    { projection: { version: 1, apps: [gold()] }, delivery: {} as Delivery },
    { projection: { version: 1, apps: [gold(), generic()] }, delivery: {} as Delivery },
    { projection: { version: 1, apps: [gold(), generic()] }, delivery: bundle(entry("civic-board", TEXT + "x", sha(TEXT))) },
    { projection: { version: 1, apps: [] }, delivery: {} as Delivery },
  ]) {
    const root = home();
    staged({ version: 1, apps: [gold(), generic()] }, root, delivery);
    staged(later.projection, root, later.delivery);
    expect(existsSync(join(root, "skills", "civic-board"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: {} });
    expect(pluginInstalled(root, [["civic-board", READ]])).toEqual([false]);
    // Re-added later: staged again (the directory is gone, so nothing shadows it).
    expect(staged({ version: 1, apps: [gold(), generic()] }, root, delivery).refused).toBeUndefined();
    expect(readFileSync(skillPath(root, "civic-board"), "utf8")).toBe(TEXT);
  }
  // A resident's file in the directory keeps the directory; only our SKILL.md goes, and with it our ownership
  // (the directory is then not ours: a later re-add is refused rather than written into a resident's directory).
  const root = home();
  staged({ version: 1, apps: [generic()] }, root, delivery);
  writeFileSync(join(root, "skills", "civic-board", "notes.txt"), "keep");
  staged({ version: 1, apps: [gold()] }, root);
  expect(existsSync(skillPath(root, "civic-board"))).toBe(false);
  expect(readFileSync(join(root, "skills", "civic-board", "notes.txt"), "utf8")).toBe("keep");
  expect(JSON.parse(readFileSync(join(root, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: {} });
  expect(staged({ version: 1, apps: [gold(), generic()] }, root, delivery).refused).toEqual([{ id: "civic-board", code: "shadows_reviewed" }]);
  // An interrupted removal (our SKILL.md still there, still recorded): verify says removal pending.
  const left = home();
  staged({ version: 1, apps: [gold(), generic()] }, left, delivery);
  staged({ version: 1, apps: [gold()] }, left);
  writeFileSync(join(left, GENERIC_STATE), JSON.stringify({ version: 1, skills: { "civic-board": [sha(TEXT)] } }));
  mkdirSync(join(left, "skills", "civic-board"));
  writeFileSync(skillPath(left, "civic-board"), TEXT);
  expect(() => reconcileMiniApps({ version: 1, apps: [gold()] }, left, undefined, true)).toThrow("mini_apps_removal_pending");
  reconcileMiniApps({ version: 1, apps: [gold()] }, left);
  expect(existsSync(skillPath(left, "civic-board"))).toBe(false);
  expect(reconcileMiniApps({ version: 1, apps: [gold()] }, left, undefined, true).apps).toEqual([{ id: "gold-stars", version: "1.1.0" }]);
});

test("security fold: the ownership file is the installer's own; a malformed or linked one is fatal", () => {
  const one = [sha(TEXT)];
  for (const bad of ["{not json", JSON.stringify({ version: 2, skills: {} }), JSON.stringify({ version: 1, ids: ["civic-board"] }), JSON.stringify({ version: 1, skills: [] }),
    JSON.stringify({ version: 1, skills: { "../x": one } }), JSON.stringify({ version: 1, skills: { "9lives": one } }),
    JSON.stringify({ version: 1, skills: { a: [] } }), JSON.stringify({ version: 1, skills: { a: ["NOT-HEX"] } }), JSON.stringify({ version: 1, skills: { a: [one[0], one[0]] } }),
    JSON.stringify({ version: 1, skills: { a: [sha("1"), sha("2"), sha("3")] } }), JSON.stringify({ version: 1, skills: {}, extra: 1 })]) {
    const root = home();
    writeFileSync(join(root, GENERIC_STATE), bad);
    const before = snapshot(root);
    expect(() => reconcileMiniApps({ version: 1, apps: [gold()] }, root)).toThrow("mini_apps_generic_state_invalid");
    expect(snapshot(root)).toEqual(before);
  }
  const root = home(), outside = home();
  writeFileSync(join(outside, "state.json"), JSON.stringify({ version: 1, skills: {} }));
  symlinkSync(join(outside, "state.json"), join(root, GENERIC_STATE));
  expect(() => reconcileMiniApps({ version: 1, apps: [gold()] }, root)).toThrow("mini_apps_symlink_refused");
  // A box that never had a generic app gets no ownership file.
  const plain = home();
  staged({ version: 1, apps: [gold(), dizko()] }, plain);
  expect(existsSync(join(plain, GENERIC_STATE))).toBe(false);
});

test("RA34 S1: the offered SKILL.md must answer to exactly its id (frontmatter name:), else bundle_invalid", () => {
  for (const text of ["# Civic Board\nno frontmatter\n", "---\nname: approval\n---\n# x\n", "---\nname: civic-board-x\n---\n", "---\nversion: 1.0.0\n---\n# x\n",
    "---\nversion: 1.0.0\n---\nname: civic-board\n", "---\nname: civic-board\n# never closed\n", "---\nname: Civic-Board\n---\n",
    // YAML forms a first-match reader and Hermes's yaml load could read differently: all fail closed.
    "---\nname: civic-board\nname: approval\n---\n", "---\nname: civic-board\n\"name\": approval\n---\n", "---\nname: civic-board\n<<: {name: approval}\n---\n",
    "---\n{name: civic-board}\n---\n", "---\n? name\n: civic-board\n---\n", "---\nname: civic-board\nmeta:\n  name: approval\n---\n", "---\nname: civic-board # c\n---\n"]) {
    refusedAlone(generic(), bundle(entry("civic-board", text)), "bundle_invalid");
  }
  // RA38: Unicode differentials vs Hermes's yaml load / strip() fallback, a BOM, and a fence that is not exactly ---.
  for (const text of ["---\nname: civic-board\n---\ufeff\nname: approval\n---\n", "---\nname: civic-board\ndescription: x\u0085name: approval\n---\n",
    "---\nname: civic-board\n \u00a0name: approval\n---\n", "---\nname: civic-board\n\u000bname: approval\n---\n", "---\nname: civic-board\n\u001fname: approval\n---\n",
    "---\nname: civic-board\n\u2003name: approval\n---\n", "---\nname: civic-board\r---\n", "\ufeff---\nname: civic-board\n---\n", "---\nname: civic-board\n--- \n"]) {
    refusedAlone(generic(), bundle(entry("civic-board", text)), "bundle_invalid");
  }
  for (const text of [TEXT, "---\nname: \"civic-board\"\n---\n", "---\nname: 'civic-board'\ndescription: Oct 11 \u2013 Nov 1\n---\nbody\n"]) {
    const root = home();
    expect(staged({ version: 1, apps: [gold(), generic()] }, root, bundle(entry("civic-board", text))).refused).toBeUndefined();
  }
});

test("RA34 S1: an id any other skill under skills/** answers to (category dir name, frontmatter name, flat .md, a link) is refused, its skill untouched", () => {
  const delivery = bundle(entry("civic-board", TEXT));
  const plant: ((root: string) => void)[] = [
    root => { mkdirSync(join(root, "skills", "productivity", "civic-board"), { recursive: true }); writeFileSync(join(root, "skills", "productivity", "civic-board", "SKILL.md"), "---\nname: civic-board\n---\n"); },
    root => { mkdirSync(join(root, "skills", "productivity", "helper"), { recursive: true }); writeFileSync(join(root, "skills", "productivity", "helper", "SKILL.md"), "---\nname: civic-board\n---\n"); },
    root => { mkdirSync(join(root, "skills", "my-notes"), { recursive: true }); writeFileSync(join(root, "skills", "my-notes", "SKILL.md"), "---\nname: \"civic-board\"\n---\n"); },
    root => { mkdirSync(join(root, "skills", "a", "b"), { recursive: true }); writeFileSync(join(root, "skills", "a", "b", "SKILL.md"), "---\nname: b\n\"name\": civic-board # last wins\n---\n"); },
    // Closed by a fence only Python's \s accepts (\x1c): still read.
    root => { mkdirSync(join(root, "skills", "a", "c"), { recursive: true }); writeFileSync(join(root, "skills", "a", "c", "SKILL.md"), "---\nname: civic-board\n---\x1c\n"); },
    // A name this reader cannot read as one plain line: unknown, so every generic app is refused.
    ...["name: |\n  civic-board", "name: >-\n  other", "name: *anchor", "name: !!str other", "name:\n  civic-board"].map(fm => (root: string) => {
      mkdirSync(join(root, "skills", "a", "d"), { recursive: true }); writeFileSync(join(root, "skills", "a", "d", "SKILL.md"), `---\n${fm}\n---\n`);
    }),
    // Over the read cap with its frontmatter never closed inside the head: unknown.
    ...["", "﻿"].map(bom => (root: string) => { mkdirSync(join(root, "skills", "a", "e"), { recursive: true }); writeFileSync(join(root, "skills", "a", "e", "SKILL.md"), bom + "---\ndescription: " + "x".repeat(70000) + "\nname: civic-board\n---\n"); }),
    root => { mkdirSync(join(root, "skills", "legacy"), { recursive: true }); writeFileSync(join(root, "skills", "legacy", "civic-board.md"), "# flat\n"); },
    root => { const outside = home(); mkdirSync(join(root, "skills", "cat"), { recursive: true }); symlinkSync(outside, join(root, "skills", "cat", "civic-board")); },
  ];
  for (const p of plant) {
    const root = home();
    p(root);
    const before = snapshot(join(root, "skills"));
    expect(staged({ version: 1, apps: [gold(), generic()] }, root, delivery).refused).toEqual([{ id: "civic-board", code: "shadows_reviewed" }]);
    const after = snapshot(join(root, "skills"));
    for (const key of Object.keys(before)) expect(after[key]).toBe(before[key]);
    expect(existsSync(skillPath(root, "civic-board"))).toBe(false);
  }
  // Hermes skips dot directories (.hub, .archive): a copy there shadows nothing.
  const root = home();
  mkdirSync(join(root, "skills", ".archive", "civic-board"), { recursive: true });
  writeFileSync(join(root, "skills", ".archive", "civic-board", "SKILL.md"), TEXT);
  expect(staged({ version: 1, apps: [gold(), generic()] }, root, delivery).refused).toBeUndefined();
  // Our own staged skill never shadows itself on a re-stage.
  expect(staged({ version: 1, apps: [gold(), generic()] }, root, delivery).refused).toBeUndefined();
});

test("RA34 S2: a recorded generic id a later overlay made something else's is dropped (no unlink, no throw); Gold Stars still stages", () => {
  const delivery = bundle(entry("civic-board", TEXT));
  // A later overlay ships a checkout skill directory with that name.
  const source = join(home(), "skills");
  cpSync(join(REPO, "skills"), source, { recursive: true });
  const root = home();
  reconcileMiniApps({ version: 1, apps: [gold(), generic()] }, root, source, false, delivery);
  mkdirSync(join(source, "civic-board"));
  writeFileSync(join(source, "civic-board", "SKILL.md"), "---\nname: civic-board\n---\npromoted\n");
  const receipt = reconcileMiniApps({ version: 1, apps: [gold()] }, root, source);
  expect(receipt.apps).toEqual([{ id: "gold-stars", version: "1.1.0" }]);
  expect(readFileSync(skillPath(root, "civic-board"), "utf8")).toBe(TEXT);
  expect(JSON.parse(readFileSync(join(root, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: {} });
  expect(reconcileMiniApps({ version: 1, apps: [gold()] }, root, source, true)).toEqual(receipt);
  // A recorded reviewed, shipped or retired id: dropped the same way, the file rewritten without it.
  for (const id of ["dizko", "approval", EDGE_SKILL_NAMES.find(n => !REVIEWED_IDS.has(n))!, ...RETIRED_SKILL_DIRS]) {
    const box = home();
    writeFileSync(join(box, GENERIC_STATE), JSON.stringify({ version: 1, skills: { [id]: [sha(TEXT)] } }));
    expect(staged({ version: 1, apps: [gold()] }, box).apps).toEqual([{ id: "gold-stars", version: "1.1.0" }]);
    expect(JSON.parse(readFileSync(join(box, GENERIC_STATE), "utf8"))).toEqual({ version: 1, skills: {} });
  }
});
