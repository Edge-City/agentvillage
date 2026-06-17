import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import { hermesHome } from "./paths";

const DEFAULT_MODEL_MAX_TOKENS = 4096;
const TERMINAL_PATH_INIT_RELATIVE_PATH = join("memory", "hermes-terminal-path.sh");
const STANDARD_ENZYME_LINK_CANDIDATES = ["/usr/local/bin/enzyme", "/opt/hermes/.venv/bin/enzyme"];

function readConfig(): Record<string, unknown> {
  const configPath = join(hermesHome(), "config.yaml");
  if (!existsSync(configPath)) return {};
  return YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function writeConfig(doc: Record<string, unknown>): void {
  writeFileSync(join(hermesHome(), "config.yaml"), YAML.stringify(doc));
}

function terminalPathEntries(home: string): string[] {
  return [
    join(home, ".local", "bin"),
    "${HERMES_HOME}/.local/bin",
    "/opt/data/.local/bin",
    "$HOME/.local/bin",
  ];
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
  const existingEnv = (terminal.env && typeof terminal.env === "object" && !Array.isArray(terminal.env))
    ? terminal.env as Record<string, unknown>
    : {};
  const existingPath = typeof existingEnv.PATH === "string" ? existingEnv.PATH : process.env.PATH ?? "";
  const pathParts = [...terminalPathEntries(home), existingPath].filter(Boolean);
  terminal.env = {
    ...existingEnv,
    PATH: [...new Set(pathParts)].join(":"),
  };
  doc.terminal = terminal;

  writeConfig(doc);
  console.log(`→ set terminal.cwd/PATH to ${home}`);
}

function writeTerminalPathInit(home: string): string {
  const scriptPath = join(home, TERMINAL_PATH_INIT_RELATIVE_PATH);
  mkdirSync(join(home, "memory"), { recursive: true });
  const pathPrefix = terminalPathEntries(home).join(":");
  writeFileSync(
    scriptPath,
    [
      "# AgentVillage-managed Hermes terminal PATH.",
      "# Non-secret: makes user-local binaries such as Enzyme visible to terminal tools.",
      `export PATH="${pathPrefix}:$PATH"`,
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  return scriptPath;
}

function ensurePathInitInConfig(scriptPath: string): void {
  const doc = readConfig();
  const terminal = { ...((doc.terminal as Record<string, unknown>) ?? {}) };
  const existing = Array.isArray(terminal.shell_init_files)
    ? terminal.shell_init_files.map(String).filter(Boolean)
    : [];
  terminal.shell_init_files = [...new Set([scriptPath, ...existing])];
  doc.terminal = terminal;
  writeConfig(doc);
}

function linkExecutable(source: string, target: string): boolean {
  try {
    mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        unlinkSync(target);
      } else {
        return false;
      }
    } catch {
      // Target does not exist.
    }
    symlinkSync(source, target);
    return true;
  } catch {
    return false;
  }
}

/** Configure the Hermes terminal backend so `enzyme` itself resolves on PATH. */
export function exposeEnzymeOnTerminalPath(): void {
  const home = hermesHome();
  const scriptPath = writeTerminalPathInit(home);
  ensurePathInitInConfig(scriptPath);

  const source = join(home, ".local", "bin", "enzyme");
  const linked = existsSync(source)
    ? STANDARD_ENZYME_LINK_CANDIDATES.filter((target) => target !== source)
      .some((target) => linkExecutable(source, target))
    : false;

  console.log(`→ configured Hermes terminal PATH via ${scriptPath}${linked ? " and standard enzyme symlink" : ""}`);
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
