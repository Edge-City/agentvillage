/**
 * Village Pulse installer — writes API config to `$HERMES_HOME/.env`.
 */

import { readFlag } from "./args";
import { upsertEnvVar } from "./env";

const FLAG_TO_ENV_VAR: ReadonlyArray<readonly [string, string]> = [
  ["--village-api-base-url", "VILLAGE_API_BASE_URL"],
  ["--village-human-id", "VILLAGE_HUMAN_ID"],
  ["--village-key", "X_VILLAGE_KEY"],
];

export function installVillagePulse(): void {
  const present: string[] = [];
  const missing: string[] = [];

  for (const [flag, envName] of FLAG_TO_ENV_VAR) {
    const value = readFlag(flag)?.trim() || process.env[envName]?.trim();
    if (value) {
      upsertEnvVar(envName, value);
      present.push(envName);
    } else {
      missing.push(envName);
    }
  }

  if (present.length === 0) {
    console.log(
      "→ village-pulse: no config provided; recipes will prompt the user at first use",
    );
    return;
  }

  console.log(`→ village-pulse: wired ${present.join(", ")} into .env`);
  if (missing.length > 0) {
    console.log(
      `  note: ${missing.join(", ")} not set — recipes that need them will prompt the user at first use`,
    );
  }
}
