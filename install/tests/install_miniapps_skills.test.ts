// MINIAPPS v2 Phase 2, skill delivery (lanes-context/MINIAPPS-V2-SKILL-DELIVERY-design.md): the cp hands
// the installer reviewed SKILL.md bytes beside the projection. Served bytes are used only when they verify;
// every failure falls back to the pinned checkout copy for that app alone and never fails the stage.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_MAX_CHARS, parseSkillDelivery, reconcileMiniApps, REVIEWED_MINI_APPS, SKILL_FALLBACK_CODES, SKILL_MAX_BYTES } from "../install_miniapps";

const REPO = join(import.meta.dir, "..", "..");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "curated-miniapps-skills-"));
  roots.push(root);
  return root;
}
const all = { version: 1, apps: REVIEWED_MINI_APPS };
const checkout = (id: string) => readFileSync(join(REPO, "skills", id, "SKILL.md"));
const onDisk = (root: string, id: string) => readFileSync(join(root, "skills", id, "SKILL.md"));
const OFFER = "ab".repeat(32);
type Entry = { id: string; sha256: string; bytes: string };
const entry = (id: string, text: string | Buffer, digest = sha(text)): Entry => ({ id, sha256: digest, bytes: Buffer.from(text).toString("base64") });
const bundle = (...skills: Entry[]) => ({ offer: OFFER, skills: JSON.stringify({ version: 1, skills }) });
const servedText = (id: string) => `${checkout(id).toString("utf8")}\n<!-- served v-next for ${id} -->\n`;
const goldStarsKept = (root: string) => {
  expect(JSON.parse(readFileSync(join(root, "mini-apps.json"), "utf8")).apps.map((a: { id: string }) => a.id)).toEqual(REVIEWED_MINI_APPS.map(a => a.id));
  expect(onDisk(root, "gold-stars")).toEqual(checkout("gold-stars"));
};

test("served bytes that hash to the offer are installed; mini-apps.json and the projection hash are unchanged", () => {
  const plain = home(), root = home();
  const before = reconcileMiniApps(all, plain);
  const delivery = bundle(entry("dizko", servedText("dizko")), entry("forkicks", servedText("forkicks")));
  const receipt = reconcileMiniApps(all, root, undefined, false, delivery);
  expect(onDisk(root, "dizko").toString("utf8")).toBe(servedText("dizko"));
  expect(onDisk(root, "forkicks").toString("utf8")).toBe(servedText("forkicks"));
  for (const id of ["gold-stars", "zzzbot", "slopfolio"]) expect(onDisk(root, id)).toEqual(checkout(id));
  // The authority file is byte for byte today's (the plugin's installed() reads only this).
  expect(readFileSync(join(root, "mini-apps.json"))).toEqual(readFileSync(join(plain, "mini-apps.json")));
  expect(receipt.projectionSha256).toBe(before.projectionSha256);
  expect(receipt.files.map(f => f.path)).toEqual(before.files.map(f => f.path));
  expect(receipt.files.find(f => f.path === "skills/dizko/SKILL.md")?.sha256).toBe(sha(servedText("dizko")));
  expect(receipt.skills).toEqual({ offer: OFFER, served: ["dizko", "forkicks"], fallback: [] });
  expect(before.skills).toEqual({ offer: null, served: [], fallback: [] });
  // Verify recomputes the same choice from the same delivery; without it the served bytes read as drift.
  expect(reconcileMiniApps(all, root, undefined, true, delivery)).toEqual(receipt);
  expect(() => reconcileMiniApps(all, root, undefined, true)).toThrow("mini_apps_skill_mismatch");
  // A later stage with no delivery restores the pinned checkout copy (the switch-off path).
  reconcileMiniApps(all, root);
  expect(onDisk(root, "dizko")).toEqual(checkout("dizko"));
});

test("served bytes do not need the checkout copy: an app whose checkout SKILL.md is missing still stages", () => {
  const source = join(home(), "skills");
  cpSync(join(REPO, "skills"), source, { recursive: true });
  unlinkSync(join(source, "dizko", "SKILL.md"));
  const root = home();
  expect(() => reconcileMiniApps(all, root, source)).toThrow();
  const receipt = reconcileMiniApps(all, root, source, false, bundle(entry("dizko", servedText("dizko"))));
  expect(receipt.skills.served).toEqual(["dizko"]);
  expect(onDisk(root, "dizko").toString("utf8")).toBe(servedText("dizko"));
  goldStarsKept(root);
});

test("a hash mismatch, an oversize file, a bad entry or non-UTF-8 bytes fall back to the checkout for that app only, with a code; Gold Stars stays", () => {
  const big = Buffer.alloc(SKILL_MAX_BYTES + 1, "a");
  const cases: [Entry, string][] = [
    [entry("dizko", servedText("dizko"), sha("something else")), "mini_apps_skill_hash_mismatch"],
    [entry("dizko", big), "mini_apps_skill_oversize"],
    [{ id: "dizko", sha256: sha("x"), bytes: "A".repeat(Math.ceil(SKILL_MAX_BYTES / 3) * 4 + 4) }, "mini_apps_skill_oversize"],
    [entry("dizko", Buffer.from([0xff, 0xfe, 0x41])), "mini_apps_skill_not_utf8"],
    [{ id: "dizko", sha256: sha("x"), bytes: "not base64!" }, "mini_apps_skill_invalid_entry"],
    [{ id: "dizko", sha256: "NOT-HEX", bytes: Buffer.from("x").toString("base64") }, "mini_apps_skill_invalid_entry"],
    [{ id: "dizko", sha256: sha(""), bytes: "" }, "mini_apps_skill_invalid_entry"],
  ];
  for (const [bad, code] of cases) {
    const root = home();
    const receipt = reconcileMiniApps(all, root, undefined, false, bundle(bad, entry("forkicks", servedText("forkicks"))));
    expect(receipt.skills).toEqual({ offer: OFFER, served: ["forkicks"], fallback: [{ id: "dizko", code }] });
    expect(onDisk(root, "dizko")).toEqual(checkout("dizko"));
    expect(onDisk(root, "forkicks").toString("utf8")).toBe(servedText("forkicks"));
    goldStarsKept(root);
    expect(SKILL_FALLBACK_CODES).toContain(code as typeof SKILL_FALLBACK_CODES[number]);
  }
  // Exactly at the cap is served.
  const root = home();
  const edge = Buffer.alloc(SKILL_MAX_BYTES, "a");
  expect(reconcileMiniApps(all, root, undefined, false, bundle(entry("dizko", edge))).skills.served).toEqual(["dizko"]);
});

test("an app the cp did not offer (missing from the bundle, e.g. the baseline gold-stars) takes its checkout copy with no code", () => {
  const root = home();
  const receipt = reconcileMiniApps(all, root, undefined, false, bundle(entry("zzzbot", servedText("zzzbot"))));
  expect(receipt.skills).toEqual({ offer: OFFER, served: ["zzzbot"], fallback: [] });
  for (const id of ["gold-stars", "dizko", "forkicks", "slopfolio"]) expect(onDisk(root, id)).toEqual(checkout(id));
  // An entry for an app outside the projection is ignored; it never creates a file.
  const one = { version: 1, apps: [REVIEWED_MINI_APPS[0]] };
  const other = home();
  expect(reconcileMiniApps(one, other, undefined, false, bundle(entry("dizko", servedText("dizko")))).skills.served).toEqual([]);
  expect(existsSync(join(other, "skills", "dizko", "SKILL.md"))).toBe(false);
});

test("a bad bundle (unparseable, wrong shape, duplicate id, over the cap) falls back for every app and never fails the stage", () => {
  const good = entry("dizko", servedText("dizko"));
  const bad = [
    "{not json",
    JSON.stringify({ version: 2, skills: [good] }),
    JSON.stringify({ version: 1, skills: [good], extra: 1 }),
    JSON.stringify({ version: 1, skills: [good, good] }),
    JSON.stringify({ version: 1, skills: [{ ...good, path: "skills/dizko/SKILL.md" }] }),
    JSON.stringify({ version: 1, skills: [{ ...good, id: "../dizko" }] }),
    JSON.stringify({ version: 1, skills: Array.from({ length: 33 }, (_, i) => ({ ...good, id: `a${i}` })) }),
    // Every entry valid, the whole string one character over the cap.
    (() => {
      const big = (id: string, n: number) => entry(id, "#".repeat(n));
      const skills = [big("dizko", 24000), big("forkicks", 24000), big("zzzbot", 24000)];
      const used = JSON.stringify({ version: 1, skills }).length;
      const last = big("slopfolio", 1);
      const fixed = JSON.stringify({ version: 1, skills: [...skills, last] }).length - last.bytes.length;
      // Grow slopfolio's text until the string passes the cap by a few characters (base64 grows by 4).
      let n = Math.floor((BUNDLE_MAX_CHARS - fixed) / 4) * 3 + 3;
      const text = JSON.stringify({ version: 1, skills: [...skills, big("slopfolio", n)] });
      expect(used).toBeLessThan(BUNDLE_MAX_CHARS);
      expect(text.length).toBeGreaterThan(BUNDLE_MAX_CHARS);
      expect(text.length).toBeLessThan(BUNDLE_MAX_CHARS + 8);
      return text;
    })(),
  ];
  for (const skills of bad) {
    const root = home();
    const receipt = reconcileMiniApps(all, root, undefined, false, { offer: OFFER, skills });
    expect(receipt.skills.served).toEqual([]);
    expect(receipt.skills.fallback).toEqual(REVIEWED_MINI_APPS.map(a => ({ id: a.id, code: "mini_apps_skill_bundle_invalid" })));
    for (const app of REVIEWED_MINI_APPS) expect(onDisk(root, app.id)).toEqual(checkout(app.id));
    goldStarsKept(root);
  }
  // The offer is echoed only in its exact form.
  expect(parseSkillDelivery({ offer: OFFER.toUpperCase() }).offer).toBeNull();
  expect(parseSkillDelivery({ offer: OFFER + "0" }).offer).toBeNull();
  expect(parseSkillDelivery({}).offer).toBeNull();
});

test("the CLI reads the two variables; without them its output is the library's no-delivery receipt", () => {
  const delivery = bundle(entry("dizko", servedText("dizko")));
  for (const [env, served] of [[{}, []], [{ MINI_APPS_SKILLS_OFFER: delivery.offer, MINI_APPS_SKILLS: delivery.skills }, ["dizko"]]] as const) {
    const root = home();
    const run = spawnSync("bun", ["--no-env-file", "--no-install", "install/install_miniapps.ts"], {
      cwd: REPO, input: JSON.stringify(all), env: { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, ...env }, encoding: "utf8",
    });
    expect([run.status, run.stderr]).toEqual([0, ""]);
    const receipt = JSON.parse(run.stdout);
    expect(receipt.skills.served).toEqual(served);
    const verify = spawnSync("bun", ["--no-env-file", "--no-install", "install/install_miniapps.ts", "--verify"], {
      cwd: REPO, input: JSON.stringify(all), env: { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, ...env }, encoding: "utf8",
    });
    expect([verify.status, verify.stderr]).toEqual([0, ""]);
    expect(JSON.parse(verify.stdout)).toEqual(receipt);
  }
});

test("review-b S1: a served gold-stars entry, even one whose sha matches, never replaces the shipped baseline SKILL.md; owned apps are still served", () => {
  const root = home();
  const text = servedText("gold-stars");
  const receipt = reconcileMiniApps(all, root, undefined, false, bundle(entry("gold-stars", text), entry("dizko", servedText("dizko"))));
  expect(onDisk(root, "gold-stars")).toEqual(checkout("gold-stars"));
  expect(receipt.files.find(f => f.path === "skills/gold-stars/SKILL.md")?.sha256).toBe(sha(checkout("gold-stars")));
  expect(receipt.skills).toEqual({ offer: OFFER, served: ["dizko"], fallback: [{ id: "gold-stars", code: "mini_apps_skill_baseline" }] });
  expect(onDisk(root, "dizko").toString("utf8")).toBe(servedText("dizko"));
  goldStarsKept(root);
  expect(reconcileMiniApps(all, root, undefined, true, bundle(entry("gold-stars", text), entry("dizko", servedText("dizko"))))).toEqual(receipt);
  // An invalid gold-stars entry gets the baseline code too (the entry is never considered).
  const other = home();
  expect(reconcileMiniApps(all, other, undefined, false, bundle(entry("gold-stars", text, sha("x")))).skills.fallback).toEqual([{ id: "gold-stars", code: "mini_apps_skill_baseline" }]);
  expect(onDisk(other, "gold-stars")).toEqual(checkout("gold-stars"));
});
