import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { DIGEST_CRON_SPECS } from "../install_index";
import { removeWipeUserState, resetSteps } from "../reset";

const SEED = join(import.meta.dir, "..", "..", "plugins", "av-events", "cron_job_names.json");

test("the av-events cron job-name seed is exactly the installer's cron names", () => {
  // cron.run reports a job's name only if it is in this seed; a drift either
  // way loses a name or lets through one the installer never creates.
  const seed = JSON.parse(readFileSync(SEED, "utf8")) as { names: string[] };
  expect([...seed.names].sort()).toEqual(DIGEST_CRON_SPECS.map((spec) => spec.name).sort());
});

test("reset --wipe-user removes av-events state (snapshot state included) and the memory tool's files", () => {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-avstate-"));
  const state = join(home, "av-events");
  mkdirSync(join(state, "buffer"), { recursive: true });
  mkdirSync(join(home, "memories"), { recursive: true });
  writeFileSync(join(state, "hash.key"), "0".repeat(64));
  writeFileSync(join(state, "edgeos_actions.json"), "{}");
  writeFileSync(join(state, "backup.json"), "{}");
  writeFileSync(join(state, "restore.json"), '{"status":"restored"}');
  writeFileSync(join(home, "memories", "USER.md"), "previous user");
  writeFileSync(join(home, "memories", "MEMORY.md"), "agent memory");
  writeFileSync(join(home, "config.yaml"), "keep: true\n");

  expect(removeWipeUserState(home)).toEqual([
    state,
    join(home, "memories", "USER.md"),
    join(home, "memories", "MEMORY.md"),
  ]);
  expect(existsSync(state)).toBe(false);
  expect(existsSync(join(home, "memories", "USER.md"))).toBe(false);
  expect(existsSync(join(home, "memories", "MEMORY.md"))).toBe(false);
  expect(existsSync(join(home, "config.yaml"))).toBe(true);
  expect(removeWipeUserState(home)).toEqual([]);
});

test("reset --wipe-user removes user state only after the gateway stops", () => {
  const names = resetSteps(true).map(([name]) => name);
  expect(names.indexOf("stopGateway")).toBeGreaterThan(-1);
  expect(names.indexOf("removeWipeUserState")).toBeGreaterThan(names.indexOf("stopGateway"));
  expect(names.indexOf("removeWipeUserState")).toBeGreaterThan(names.indexOf("resetRecall"));
  expect(names[names.length - 1]).toBe("restartGateway");
});

test("a plain reset keeps user state and never stops the gateway", () => {
  const names = resetSteps(false).map(([name]) => name);
  expect(names).not.toContain("removeWipeUserState");
  expect(names).not.toContain("stopGateway");
  expect(names[names.length - 1]).toBe("restartGateway");
});
