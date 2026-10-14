import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileMiniApps, REVIEWED_MINI_APPS, validateProjection } from "../install_miniapps";
import { EDGE_SKILL_NAMES } from "../paths";

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
  expect(EDGE_SKILL_NAMES).not.toContain("gold-stars");
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

test("uninstall revokes the projection and removes only exact managed files", () => {
  const root = home();
  reconcileMiniApps(all, root);
  writeFileSync(join(root, "village-bridge.json"), "managed bearer fixture");
  writeFileSync(join(root, "skills", "gold-stars", "resident-note.txt"), "keep");
  const one = { version: 1, apps: [REVIEWED_MINI_APPS[1]] };
  reconcileMiniApps(one, root);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(true);
  expect(existsSync(join(root, "skills", "gold-stars", "SKILL.md"))).toBe(false);
  expect(readFileSync(join(root, "skills", "gold-stars", "resident-note.txt"), "utf8")).toBe("keep");
  expect(reconcileMiniApps(one, root, undefined, true).apps).toEqual([{ id: "dizko", version: "1.0.0" }]);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, "mini-apps.json"), "utf8"))).toEqual({ version: 1, apps: [] });
  expect(existsSync(join(root, "skills", "dizko", "SKILL.md"))).toBe(false);
});

test("unknown bundles, versions, extra fields, permissions and duplicate ids are refused", () => {
  const gold = REVIEWED_MINI_APPS[0];
  for (const app of [{ ...gold, id: "../../escape" }, { ...gold, version: "9" }, { ...gold, hooks: ["sh"] }, { ...gold, skills: ["../../other"] }, { ...gold, operations: [...gold.operations, "rolodex.meeting"] }]) {
    expect(() => validateProjection({ version: 1, apps: [app] })).toThrow();
  }
  expect(() => validateProjection({ version: 1, apps: [gold, gold] })).toThrow();
  expect(() => validateProjection({ version: 1, apps: [], mcp: { url: "https://unreviewed.invalid" } })).toThrow();
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
