import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import { hermesHome } from "./paths";

const DEFAULT_MODEL_MAX_TOKENS = 4096;

function readConfig(): Record<string, unknown> {
  const configPath = join(hermesHome(), "config.yaml");
  if (!existsSync(configPath)) return {};
  return YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function writeConfig(doc: Record<string, unknown>): void {
  writeFileSync(join(hermesHome(), "config.yaml"), YAML.stringify(doc));
}

function configuredMaxTokens(): number {
  const parsed = Number.parseInt(process.env.HERMES_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODEL_MAX_TOKENS;
}

/** Point gateway / messaging CWD at `$HERMES_HOME` so `AGENTS.md` loads. */
export function setTerminalCwd(): void {
  const home = hermesHome();

  const doc = readConfig();

  const terminal = { ...((doc.terminal as Record<string, unknown>) ?? {}) };
  terminal.cwd = home;
  doc.terminal = terminal;

  writeConfig(doc);
  console.log(`→ set terminal.cwd to ${home}`);
}

/**
 * Configure Hermes speech-to-text so inbound voice notes are auto-transcribed
 * to text before reaching the agent.
 *
 * Default is `openrouter-whisper`: a `command`-type STT provider that shells out
 * to install/stt/openrouter_transcribe.py, which transcribes the cached audio
 * via OpenRouter's /audio/transcriptions endpoint using the tenant's own
 * OPENROUTER_API_KEY (already in $HERMES_HOME/.env). This reuses the per-tenant
 * OpenRouter key — no extra vendor key to provision fleet-wide.
 *
 * Override with `STT_PROVIDER` (e.g. `groq`, `openai`, `local`) to use a
 * built-in provider instead; the command block is only written for the
 * openrouter-whisper default.
 *
 * Note: Hermes v2026.5.16 does NOT hand the agent a raw audio file path when
 * STT is disabled (it just refuses), so a real STT provider is required for
 * voice notes to work. Idempotent.
 *
 * @param scriptPath absolute path to openrouter_transcribe.py on disk (passed
 *   by the installer; defaults to the cloned edge-src location at runtime).
 */
export function configureStt(scriptPath?: string): void {
  const provider = process.env.STT_PROVIDER?.trim() || "openrouter-whisper";
  const doc = readConfig();
  const stt = { ...((doc.stt as Record<string, unknown>) ?? {}) };
  stt.enabled = true;
  stt.provider = provider;

  if (provider === "openrouter-whisper") {
    const script =
      scriptPath || join(hermesHome(), "edge-src", "install", "stt", "openrouter_transcribe.py");
    const providers = { ...((stt.providers as Record<string, unknown>) ?? {}) };
    providers["openrouter-whisper"] = {
      type: "command",
      command: `python3 ${script} {input_path} {output_path}`,
      format: "txt",
      timeout: 120,
    };
    stt.providers = providers;
  }

  doc.stt = stt;
  writeConfig(doc);
  console.log(`→ enabled stt with provider "${provider}" (voice notes auto-transcribed)`);
}

/** Ensure hosted cron turns never inherit a provider's enormous output-token default. */
export function capModelMaxTokens(): void {
  const cap = configuredMaxTokens();
  const doc = readConfig();
  const rawModel = doc.model;
  let model: Record<string, unknown>;

  if (typeof rawModel === "string" && rawModel.trim()) {
    model = { default: rawModel.trim(), model: rawModel.trim() };
  } else if (rawModel && typeof rawModel === "object" && !Array.isArray(rawModel)) {
    model = { ...(rawModel as Record<string, unknown>) };
  } else {
    model = {};
  }

  const existing = Number.parseInt(String(model.max_tokens ?? ""), 10);
  if (!Number.isFinite(existing) || existing <= 0 || existing > cap) {
    model.max_tokens = cap;
  }

  doc.model = model;
  writeConfig(doc);
  console.log(`→ capped model.max_tokens at ${model.max_tokens}`);
}
