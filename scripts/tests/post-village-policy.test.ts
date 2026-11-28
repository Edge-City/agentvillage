import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtures from "./fixtures/post-village-policy.json";
import { INDIA_END_MS, parsePostVillagePolicy, POST_VILLAGE_KEYS, postVillageAllowed, postVillagePolicyPath, readPostVillagePolicy } from "../../skills/index-network/scripts/post-village-policy";
import { setPostVillageOptIn } from "../../install/post_village_policy";
const homes: string[] = [];
function home() { const path = mkdtempSync(join(tmpdir(), "av-test-post-village-")); homes.push(path); mkdirSync(join(path, "av-events")); return path; }
afterEach(() => { for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true }); });
test("shared closed keys and cutoff", () => { expect(POST_VILLAGE_KEYS).toEqual(fixtures.keys); expect(INDIA_END_MS).toBe(Date.parse(fixtures.cutoff)); });
for (const fixture of fixtures.cases) test(fixture.name, () => {
  const h = home(); writeFileSync(postVillagePolicyPath(h), fixture.raw);
  if (fixture.valid) expect(parsePostVillagePolicy(fixture.raw).enabled).toEqual(fixture.enabled);
  else expect(() => parsePostVillagePolicy(fixture.raw)).toThrow();
  for (const key of POST_VILLAGE_KEYS) expect(postVillageAllowed(h, key, new Date(INDIA_END_MS))).toBe(fixture.enabled.includes(key));
});
test("missing/invalid file is OFF at and after cutoff, legacy operation before it", () => {
  const h = home();
  for (const key of POST_VILLAGE_KEYS) {
    expect(postVillageAllowed(h, key, new Date(INDIA_END_MS - 1))).toBe(true);
    expect(postVillageAllowed(h, key, new Date(INDIA_END_MS))).toBe(false);
    expect(postVillageAllowed(h, key, new Date(INDIA_END_MS + 1))).toBe(false);
  }
  mkdirSync(postVillagePolicyPath(h)); expect(readPostVillagePolicy(h).status).toBe("invalid");
});
test("symlink policy and invalid clocks fail closed", () => {
  const h = home(); const other = join(h, "other"); writeFileSync(other, '{"version":1,"enabled":["daily_digest"]}'); symlinkSync(other, postVillagePolicyPath(h));
  expect(postVillageAllowed(h, "daily_digest")).toBe(false); expect(postVillageAllowed(h, "daily_digest", new Date(NaN))).toBe(false);
});
test("explicit operator edit preserves other opt-ins and refuses malformed policy without mutation", async () => {
  const h = home(); await setPostVillageOptIn(h, "daily_digest", true); await setPostVillageOptIn(h, "welcome_seed", true); await setPostVillageOptIn(h, "daily_digest", false);
  expect(readPostVillagePolicy(h)).toEqual({ status: "ok", policy: { version: 1, enabled: ["welcome_seed"] } });
  const raw = '{"version":1,"enabled":["unknown"]}'; writeFileSync(postVillagePolicyPath(h), raw);
  await expect(setPostVillageOptIn(h, "daily_digest", true)).rejects.toThrow(); expect(readFileSync(postVillagePolicyPath(h), "utf8")).toBe(raw);
});
