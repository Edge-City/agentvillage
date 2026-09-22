import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { DIGEST_CRON_SPECS } from "../install_index";
import { removeAvEventsState } from "../reset";

const SEED = join(import.meta.dir, "..", "..", "plugins", "av-events", "cron_job_names.json");

test("the av-events cron job-name seed is exactly the installer's cron names", () => {
  // cron.run reports a job's name only if it is in this seed; a drift either
  // way loses a name or lets through one the installer never creates.
  const seed = JSON.parse(readFileSync(SEED, "utf8")) as { names: string[] };
  expect([...seed.names].sort()).toEqual(DIGEST_CRON_SPECS.map((spec) => spec.name).sort());
});

test("reset --wipe-user removes the av-events state directory", () => {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-avstate-"));
  const state = join(home, "av-events");
  mkdirSync(join(state, "buffer"), { recursive: true });
  writeFileSync(join(state, "hash.key"), "0".repeat(64));
  writeFileSync(join(state, "edgeos_actions.json"), "{}");
  writeFileSync(join(home, "config.yaml"), "keep: true\n");

  expect(removeAvEventsState(home)).toBe(true);
  expect(existsSync(state)).toBe(false);
  expect(existsSync(join(home, "config.yaml"))).toBe(true);
  expect(removeAvEventsState(home)).toBe(false);
});
