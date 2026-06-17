import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import YAML from "yaml";

import { capModelMaxTokens, disableAutoStt } from "../config";

const ORIGINAL_ENV = {
  HERMES_HOME: process.env.HERMES_HOME,
  HERMES_MAX_TOKENS: process.env.HERMES_MAX_TOKENS,
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

test("disableAutoStt sets stt.enabled to false on a fresh config", () => {
  const configPath = withConfig({ model: { default: "google/gemini-3.5-flash" } });

  disableAutoStt();

  expect(readConfig(configPath).stt).toEqual({ enabled: false });
});

test("disableAutoStt preserves other stt fields", () => {
  const configPath = withConfig({ stt: { enabled: true, provider: "local" } });

  disableAutoStt();

  expect(readConfig(configPath).stt).toEqual({ enabled: false, provider: "local" });
});

test("disableAutoStt is idempotent", () => {
  const configPath = withConfig({ stt: { enabled: false } });

  disableAutoStt();

  expect(readConfig(configPath).stt).toEqual({ enabled: false });
});
