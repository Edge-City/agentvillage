import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import YAML from "yaml";

import { capModelMaxTokens, exposeEnzymeOnTerminalPath, setTerminalCwd } from "../config";
import { hermesExecEnv } from "../hermes_cli";

const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  HERMES_HOME: process.env.HERMES_HOME,
  HERMES_MAX_TOKENS: process.env.HERMES_MAX_TOKENS,
  PATH: process.env.PATH,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withConfig(doc: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-config-"));
  process.env.HERMES_HOME = home;
  writeFileSync(join(home, "config.yaml"), YAML.stringify(doc));
  return join(home, "config.yaml");
}

function readConfig(path: string): Record<string, unknown> {
  return YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("setTerminalCwd adds local bin paths to terminal env PATH", () => {
  const configPath = withConfig({ terminal: { env: { PATH: "/usr/bin", KEEP: "yes" } } });

  setTerminalCwd();

  const terminal = readConfig(configPath).terminal as Record<string, unknown>;
  const env = terminal.env as Record<string, string>;
  expect(terminal.cwd).toBe(process.env.HERMES_HOME);
  expect(env.KEEP).toBe("yes");
  expect(env.PATH.split(":")).toContain(`${process.env.HERMES_HOME}/.local/bin`);
  expect(env.PATH.split(":")).toContain("${HERMES_HOME}/.local/bin");
  expect(env.PATH.split(":")).toContain("/opt/data/.local/bin");
  expect(env.PATH.split(":")).toContain("$HOME/.local/bin");
  expect(env.PATH.split(":")).toContain("/usr/bin");
});

test("exposeEnzymeOnTerminalPath registers Hermes shell init file", () => {
  const configPath = withConfig({ terminal: { shell_init_files: ["/existing/init.sh"] } });

  exposeEnzymeOnTerminalPath();
  exposeEnzymeOnTerminalPath();

  const home = process.env.HERMES_HOME!;
  const initPath = join(home, "memory", "hermes-terminal-path.sh");
  const terminal = readConfig(configPath).terminal as Record<string, unknown>;
  const shellInitFiles = terminal.shell_init_files as string[];

  expect(existsSync(initPath)).toBe(true);
  expect(readFileSync(initPath, "utf8")).toContain(`${home}/.local/bin`);
  expect(readFileSync(initPath, "utf8")).toContain("/opt/data/.local/bin");
  expect(shellInitFiles.filter((path) => path === initPath)).toHaveLength(1);
  expect(shellInitFiles).toContain("/existing/init.sh");
});

test("hermesExecEnv includes hosted local bin paths", () => {
  process.env.HERMES_HOME = "/opt/data";
  process.env.HOME = "/opt/data";
  process.env.PATH = "/usr/bin";

  const env = hermesExecEnv();
  const path = String(env.PATH).split(":");

  expect(path).toContain("/opt/data/.local/bin");
  expect(path).toContain("/opt/hermes/.venv/bin");
  expect(path).toContain("/usr/bin");
});

test("capModelMaxTokens adds a safe default cap when missing", () => {
  const configPath = withConfig({
    model: { provider: "openrouter", default: "qwen/qwen3-coder", model: "qwen/qwen3-coder" },
  });

  capModelMaxTokens();

  expect(readConfig(configPath).model).toEqual({
    provider: "openrouter",
    default: "qwen/qwen3-coder",
    model: "qwen/qwen3-coder",
    max_tokens: 4096,
  });
});

test("capModelMaxTokens lowers oversized provider defaults", () => {
  const configPath = withConfig({ model: { default: "qwen/qwen3-coder", max_tokens: 65536 } });

  capModelMaxTokens();

  expect((readConfig(configPath).model as Record<string, unknown>).max_tokens).toBe(4096);
});

test("capModelMaxTokens preserves an explicit lower cap", () => {
  const configPath = withConfig({ model: { default: "google/gemini-3.5-flash", max_tokens: 2048 } });

  capModelMaxTokens();

  expect((readConfig(configPath).model as Record<string, unknown>).max_tokens).toBe(2048);
});

test("capModelMaxTokens honors the operator cap override", () => {
  process.env.HERMES_MAX_TOKENS = "8192";
  const configPath = withConfig({ model: { default: "qwen/qwen3-coder", max_tokens: 65536 } });

  capModelMaxTokens();

  expect((readConfig(configPath).model as Record<string, unknown>).max_tokens).toBe(8192);
});
