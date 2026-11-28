import { expect, test } from "bun:test";
import * as Welcome from "../welcome";
import { runScenario, SCENARIOS } from "./welcome-seed-tag-scenarios";

for (const name of ["seedThree", "seedOneDefaultMode", "seedPaused", "reseed", "reseedDryRun"] as const) {
  test(`post-village OFF: ${name} has zero intent writes and claims no seed/refusal marker`, async () => {
    const scenario = SCENARIOS[name]!;
    const result = await runScenario(Welcome, scenario, {}, undefined, false);
    expect(result.requests.filter((request) => new URL(request.url).pathname === "/api/intents")).toEqual([]);
    expect(result.requests.some((request) => request.body.includes('"name":"pause_intent"'))).toBe(false);
    for (const [path, bytes] of Object.entries(result.files)) {
      if (/welcome-(?:seed|reseed)|refused/.test(path)) expect(bytes).toBe(scenario.files?.[path]);
    }
    if (!scenario.argv.includes("--reseed")) {
      expect(result.stdout).toContain("Welcome to Agent Village");
      expect(result.stdout).not.toContain("these intents are active");
    }
  });
}
