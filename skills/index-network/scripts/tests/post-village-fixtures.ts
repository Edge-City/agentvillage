/** Explicit intended-enabled fixtures. Production has no test switch; every invocation grants only its own job key. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProactive, type ProactiveAction, type ProactiveOptions } from "../proactive";
import { postVillageKeyForAction, postVillagePolicyPath, readPostVillagePolicy, type PostVillageKey } from "../post-village-policy";
export function allowPostVillageFixture(home: string, ...keys: PostVillageKey[]): void {
  if (!home) throw new Error("fixture-home-required");
  mkdirSync(join(home, "av-events"), { recursive: true });
  const before = readPostVillagePolicy(home);
  if (before.status === "invalid") throw new Error("fixture-policy-invalid");
  const enabled = new Set(before.status === "ok" ? before.policy.enabled : []);
  for (const key of keys) enabled.add(key);
  writeFileSync(postVillagePolicyPath(home), JSON.stringify({ version: 1, enabled: [...enabled] }));
}
export function runAllowedProactive(action: ProactiveAction, options: ProactiveOptions): ReturnType<typeof runProactive> {
  const key = postVillageKeyForAction(action);
  if (key) {
    if (!options.home) throw new Error("fixture-home-required");
    allowPostVillageFixture(options.home, key);
  }
  return runProactive(action, options);
}
