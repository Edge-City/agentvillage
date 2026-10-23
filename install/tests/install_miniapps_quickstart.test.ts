// MINI-APPS v2 QUICKSTART proof (installer: ov#455, product/miniapps-generic).
// The partner example in docs/examples/mini-apps/hello-village is run through the box installer exactly as the cp
// would offer it: the projection entry is the one the cp derives from the example's manifest (the shared validator's
// v1Entry, so only id, version, operations, skills reach the box), and the offer carries the example's SKILL.md bytes
// under the manifest's own skills[0].sha256 pin. Every byte comes from the example files, so the quickstart doc, the
// example and this proof cannot drift apart. Invented data only.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileMiniApps, REVIEWED_MINI_APPS } from "../install_miniapps";

const REPO = join(import.meta.dir, "..", "..");
const EXAMPLE = join(REPO, "docs", "examples", "mini-apps", "hello-village");
const validator = createRequire(import.meta.url)(join(REPO, "scripts", "mini-apps-manifests.cjs"));
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const MANIFEST_TEXT = readFileSync(join(EXAMPLE, "manifest.json"), "utf8");
const MANIFEST = JSON.parse(MANIFEST_TEXT);
const ID: string = MANIFEST.id;
const PIN: string = MANIFEST.skills[0].sha256;
const SKILL = readFileSync(join(EXAMPLE, MANIFEST.skills[0].path));
// The receipt contract's closed refusal set (CLAIMS L19498; the cp's REFUSED_CODES, mini-apps-skills.js).
const CODES = ["offer_missing", "bundle_invalid", "sha_mismatch", "operations_not_generic", "shadows_reviewed", "budget"];
const GENERIC = [["mini-app.read", "mini-app.context.read", "mini-app.context.write"], ["mini-app.read"]];

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "miniapps-quickstart-"));
  roots.push(root);
  return root;
}
type Entry = { id: string; sha256: string; bytes: string };
type Delivery = { offer?: string; skills?: string };
type Receipt = ReturnType<typeof reconcileMiniApps> & { refused?: { id: string; code: string }[] };
/** The cp's offer (mini-apps-skills.js build()): MINI_APPS_SKILLS and MINI_APPS_SKILLS_OFFER for these entries. */
function offer(entries: Entry[]): Delivery {
  return { offer: sha(JSON.stringify(entries.map(e => [e.id, e.sha256]))), skills: JSON.stringify({ version: 1, skills: entries }) };
}
const exampleEntry = (pin = PIN): Entry => ({ id: ID, sha256: pin, bytes: SKILL.toString("base64") });
/** The box entry the cp projects from a manifest: its v1 entry, keys id, version, operations, skills. */
function projected(manifest: unknown, context: boolean) {
  const result = validator.validateManifest(manifest);
  expect(result.ok).toBe(true);
  const { id, version, operations, skills } = validator.v1Entry(result.manifest, { context });
  return { id, version, operations, skills };
}
const gold = () => ({ ...REVIEWED_MINI_APPS[0], operations: [...REVIEWED_MINI_APPS[0].operations], skills: [...REVIEWED_MINI_APPS[0].skills] });
const skillPath = (root: string) => join(root, "skills", ID, "SKILL.md");
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
 * (d) The receipt contract the cp checks (mini-apps-skills.js receiptRefused / receiptValid, context L19498): exactly
 * these keys; `refused` omitted when empty, else [{ id, code }] of projected non-reviewed ids from the closed six;
 * apps / files / mini-apps.json / projectionSha256 cover exactly the projection minus the refused ids, in order;
 * skills echoes the offer, a served id has exactly the offered sha on disk, a generic id never falls back; and
 * --verify with the same delivery recomputes the same receipt.
 */
function stage(projection: { version: 1; apps: { id: string; version: string }[] }, root: string, delivery: Delivery): Receipt {
  const receipt = reconcileMiniApps(projection, root, undefined, false, delivery) as Receipt;
  expect(Object.keys(receipt).sort()).toEqual(["apps", "files", "projectionSha256", "skills", "staged", "version", ...(receipt.refused ? ["refused"] : [])].sort());
  expect([receipt.version, receipt.staged]).toEqual([1, true]);
  const refusedIds = (receipt.refused ?? []).map(r => r.id);
  if (receipt.refused) expect(receipt.refused.length).toBeGreaterThan(0);
  for (const r of receipt.refused ?? []) {
    expect(Object.keys(r).sort()).toEqual(["code", "id"]);
    expect(CODES).toContain(r.code);
    expect(projection.apps.map(a => a.id)).toContain(r.id);
    expect(REVIEWED_MINI_APPS.map(a => a.id as string)).not.toContain(r.id);
  }
  expect(new Set(refusedIds).size).toBe(refusedIds.length);
  const accepted = projection.apps.filter(a => !refusedIds.includes(a.id));
  const authority = JSON.stringify({ version: 1, apps: accepted });
  expect(receipt.apps).toEqual(accepted.map(({ id, version }) => ({ id, version })));
  expect(receipt.files.map(f => f.path)).toEqual(accepted.map(a => `skills/${a.id}/SKILL.md`));
  for (const f of receipt.files) expect(sha(readFileSync(join(root, f.path)))).toBe(f.sha256);
  expect(readFileSync(join(root, "mini-apps.json"), "utf8")).toBe(authority);
  expect(receipt.projectionSha256).toBe(sha(authority));
  expect(Object.keys(receipt.skills).sort()).toEqual(["fallback", "offer", "served"]);
  expect(receipt.skills.offer).toBe(delivery.offer ?? null);
  expect(receipt.skills.fallback.map(f => f.id)).not.toContain(ID);
  expect(reconcileMiniApps(projection, root, undefined, true, delivery)).toEqual(receipt);
  return receipt;
}

test("the example is a valid v2 manifest the cp serves as a GENERIC app: public MCP read relay, pinned UTF-8 skill under the cap", () => {
  const result = validator.validateManifest(MANIFEST);
  expect([result.ok, result.errors]).toEqual([true, undefined]);
  // Canonical bytes (the cp's vendored-manifest rule), the pin is the SKILL.md bytes, the skill is UTF-8 and <= 32 KiB.
  expect(MANIFEST_TEXT).toBe(JSON.stringify(MANIFEST, null, 2) + "\n");
  expect(MANIFEST.skills[0]).toEqual({ name: ID, version: MANIFEST.version, sha256: sha(SKILL), path: `skills/${ID}/SKILL.md` });
  expect(SKILL.length).toBeLessThanOrEqual(32768);
  expect(new TextDecoder("utf-8", { fatal: true }).decode(SKILL).startsWith(`---\nname: ${ID}\n`)).toBe(true);
  expect(validator.RESERVED_IDS).not.toContain(ID);
  // The id the box accepts for a generic app (install_miniapps.ts GENERIC_ID), not a reviewed one.
  expect(ID).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
  expect(REVIEWED_MINI_APPS.map(a => a.id as string)).not.toContain(ID);
  // What the cp projects to a box: exactly one of the two generic lists, in the box's order.
  expect([projected(MANIFEST, false).operations, projected(MANIFEST, true).operations]).toEqual([GENERIC[1], GENERIC[0]]);
  const built = validator.buildCatalog({ catalog: 2, apps: [ID] }, { [ID]: MANIFEST });
  expect([built.ok, built.dropped]).toEqual([true, []]);
});

test("(a) the box accepts the example from the cp's offer: SKILL.md written with the example's bytes, served, granted by the bridge", () => {
  for (const context of [true, false]) {
    const root = home();
    const app = projected(MANIFEST, context);
    const projection = { version: 1 as const, apps: [gold(), app] };
    const delivery = offer([exampleEntry()]);
    const receipt = stage(projection, root, delivery);
    expect(receipt).not.toHaveProperty("refused");
    expect(readFileSync(skillPath(root)).equals(SKILL)).toBe(true);
    expect(receipt.files.at(-1)).toEqual({ path: `skills/${ID}/SKILL.md`, sha256: PIN });
    expect(receipt.skills).toEqual({ offer: delivery.offer, served: [ID], fallback: [] });
    expect(receipt.apps).toEqual([{ id: "gold-stars", version: REVIEWED_MINI_APPS[0].version }, { id: ID, version: MANIFEST.version }]);
    const ops = [...GENERIC[0], "gold-stars.send"];
    expect(pluginInstalled(root, ops.map(op => [ID, op] as [string, string]))).toEqual(ops.map(op => app.operations.includes(op)));
  }
});

test("(b) the example's bytes under a wrong pin are refused sha_mismatch; the app alone, nothing written for it", () => {
  const wrong = (PIN[0] === "0" ? "1" : "0") + PIN.slice(1);
  const root = home();
  const projection = { version: 1 as const, apps: [gold(), projected(MANIFEST, true)] };
  const receipt = stage(projection, root, offer([exampleEntry(wrong)]));
  expect(receipt.refused).toEqual([{ id: ID, code: "sha_mismatch" }]);
  expect(existsSync(skillPath(root))).toBe(false);
  expect(receipt.skills.served).toEqual([]);
  expect(receipt.apps.map(a => a.id)).toEqual(["gold-stars"]);
});

test("(c) one extra operation is refused operations_not_generic: on the projected list, or from a manifest that is not a public read relay", () => {
  const delivery = offer([exampleEntry()]);
  const refusedAlone = (app: { id: string; version: string }) => {
    const root = home();
    const receipt = stage({ version: 1, apps: [gold(), app] }, root, delivery);
    expect(receipt.refused).toEqual([{ id: ID, code: "operations_not_generic" }]);
    expect(existsSync(skillPath(root))).toBe(false);
    expect(receipt.apps.map(a => a.id)).toEqual(["gold-stars"]);
  };
  // The projected generic list plus one more operation (its own op name, or a context op the box never grants).
  for (const extra of [`${ID}.read`, "mini-app.context.delete"]) {
    const app = projected(MANIFEST, true);
    refusedAlone({ ...app, operations: [...app.operations, extra] });
  }
  // A manifest behind an app token is not the relay: the cp projects its own op names, which no box takes as generic.
  const token = JSON.parse(MANIFEST_TEXT);
  token.service.auth = { mode: "app-token", secretRef: "MINI_APP_HELLO_VILLAGE_TOKEN" };
  expect(projected(token, true).operations).toEqual([`${ID}.read`, "mini-app.context.read", "mini-app.context.write"]);
  refusedAlone(projected(token, true));
  // A manifest with one extra WRITE op validates but has no v1 form: the cp drops it and never projects it at all.
  const write = JSON.parse(MANIFEST_TEXT);
  write.operations.push({ name: `${ID}.save`, class: "write", target: { tool: "save_greeting" }, input: { type: "object", additionalProperties: false } });
  expect(validator.validateManifest(write).ok).toBe(true);
  expect(() => validator.v1Entry(validator.validateManifest(write).manifest, { context: true })).toThrow("mini_apps_manifest_v1_unrepresentable");
});

test("(d) the receipt has the contract's shape whether the example is staged or refused, and the codes are the closed six", () => {
  const root = home();
  const projection = { version: 1 as const, apps: [gold(), projected(MANIFEST, true)] };
  // No offer at all: refused offer_missing (a generic app never takes a checkout copy), then staged once offered.
  expect(stage(projection, root, {}).refused).toEqual([{ id: ID, code: "offer_missing" }]);
  const receipt = stage(projection, root, offer([exampleEntry()]));
  expect(Object.keys(receipt)).toEqual(["version", "projectionSha256", "files", "apps", "staged", "skills"]);
  expect(receipt.projectionSha256).toBe(sha(JSON.stringify(projection)));
  expect(CODES.length).toBe(6);
});

test("the quickstart doc inlines the example byte for byte and names the box's lists and every refusal code", () => {
  const doc = readFileSync(join(REPO, "docs", "MINI-APPS-QUICKSTART.md"), "utf8");
  expect(doc.includes("````markdown\n" + SKILL.toString("utf8") + "````\n")).toBe(true);
  expect(doc.includes("```json\n" + MANIFEST_TEXT + "```\n")).toBe(true);
  for (const ops of GENERIC) expect(doc).toContain("`" + JSON.stringify(ops) + "`");
  for (const code of CODES) expect(doc).toContain("| `" + code + "` |");
  for (const id of REVIEWED_MINI_APPS.map(a => a.id as string)) expect(doc).toContain("`" + id + "`");
  for (const id of validator.RESERVED_IDS) expect(doc).toContain("`" + id + "`");
  expect(doc.split("\n").length).toBeLessThan(170);
  // The developer guide links it.
  expect(readFileSync(join(REPO, "docs", "MINI-APPS-DEVELOPER.md"), "utf8")).toContain("](MINI-APPS-QUICKSTART.md)");
});
