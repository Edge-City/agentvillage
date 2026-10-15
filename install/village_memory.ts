import { existsSync } from "node:fs";
import { join } from "node:path";

import { readConfig, writeConfig } from "./config";
import { hermesHome } from "./paths";

/** D3: the Agent Village memory provider (`plugins/village-memory/`). */
export const VILLAGE_MEMORY_PROVIDER = "village-memory";

const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * D3: `memory.provider: village-memory` on every run, so Hermes activates the provider at agent init
 * (v2026.9.24 `agent/agent_init.py:1298-1331`; one external provider beside the built-in USER.md /
 * MEMORY.md store, which `memory.provider` leaves on, :1275-1296). Every other `memory` key (the
 * cp's char limits) is kept. The plugin is a memory provider (`kind: exclusive`): it is found by
 * name under `$HERMES_HOME/plugins/` and never listed in `plugins.enabled`. A `plugins.disabled`
 * entry for it is removed, because Hermes refuses a disabled provider
 * (`plugins/memory/__init__.py:205-210`, `_explicitly_disabled`). Its kill switch is
 * `AV_VILLAGE_MEMORY=0` in `.env`, read by the plugin per call.
 *
 * Left alone, with a warning, when the staged plugin is missing: Hermes would then try to fetch a
 * provider of that name from its plugin catalog (`hermes_cli/memory_provider_migration.py:110-125`).
 * Also left alone when config.yaml, `memory` or `plugins` has an unusable shape. Writes only on a
 * change. Returns what it did, for the log line and the tests.
 */
export function configureVillageMemory(): "set" | "kept" | "skipped" {
  const staged = join(hermesHome(), "plugins", VILLAGE_MEMORY_PROVIDER, "__init__.py");
  if (!existsSync(staged)) {
    console.log(`→ warning: ${staged} is missing; memory.provider not set`);
    return "skipped";
  }
  const doc: unknown = readConfig();
  if (!isMapping(doc)) {
    console.log(`→ warning: the top level of config.yaml is not a mapping; memory.provider not set`);
    return "skipped";
  }
  const memory = doc.memory ?? {};
  const plugins = doc.plugins ?? {};
  if (!isMapping(memory) || !isMapping(plugins)) {
    console.log(`→ warning: memory or plugins in config.yaml is not a mapping; memory.provider not set`);
    return "skipped";
  }
  let changed = false;
  const previous = memory.provider;
  if (previous !== VILLAGE_MEMORY_PROVIDER) {
    doc.memory = { ...memory, provider: VILLAGE_MEMORY_PROVIDER };
    changed = true;
    const was = previous === undefined || previous === null || previous === "" ? "" : " (replaced another provider)";
    console.log(`→ set memory.provider: ${VILLAGE_MEMORY_PROVIDER}${was}`);
  }
  if (Array.isArray(plugins.disabled) && plugins.disabled.includes(VILLAGE_MEMORY_PROVIDER)) {
    doc.plugins = { ...plugins, disabled: plugins.disabled.filter((n) => n !== VILLAGE_MEMORY_PROVIDER) };
    changed = true;
    console.log(`→ removed ${VILLAGE_MEMORY_PROVIDER} from plugins.disabled (a memory provider; AV_VILLAGE_MEMORY=0 is its off switch)`);
  }
  if (!changed) {
    console.log(`→ memory.provider already ${VILLAGE_MEMORY_PROVIDER}`);
    return "kept";
  }
  writeConfig(doc);
  return "set";
}

/** `configureVillageMemory`, but a failure is logged and never stops the install. */
export function safeConfigureVillageMemory(): boolean {
  try {
    configureVillageMemory();
    return true;
  } catch (err) {
    const kind = err instanceof Error ? err.name : typeof err;
    console.warn(`  warning: village-memory step failed (${kind}); core install continues`);
    return false;
  }
}
