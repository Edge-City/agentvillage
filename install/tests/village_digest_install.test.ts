import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { EDGE_SKILL_NAMES } from "../paths";
import { copySkillBundles } from "../skill_copy";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
test("the normal installer auto-discovers and copies the Village Digest bundle", () => {
  expect(EDGE_SKILL_NAMES).toContain("village-digest");
  const target = mkdtempSync(join(tmpdir(), "av-village-digest-install-")); roots.push(target);
  copySkillBundles(join(import.meta.dir, "..", "..", "skills"), target);
  expect(readFileSync(join(target, "village-digest", "SKILL.md"), "utf8")).toContain("name: village-digest");
  expect(readFileSync(join(target, "village-digest", "scripts", "read.ts"), "utf8")).toContain("VILLAGE_DIGEST_READ_SECRET");
});
