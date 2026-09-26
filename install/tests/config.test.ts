import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { capModelMaxTokens, configureAvEvents, configureHostedGateway, configureStt } from "../config";

const ORIGINAL_ENV = {
  HERMES_HOME: process.env.HERMES_HOME,
  HERMES_MAX_TOKENS: process.env.HERMES_MAX_TOKENS,
  STT_PROVIDER: process.env.STT_PROVIDER,
  AV_EVENTS_TOKEN: process.env.AV_EVENTS_TOKEN,
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

test("configureStt enables groq by default on a fresh config", () => {
  delete process.env.STT_PROVIDER;
  const configPath = withConfig({ model: { default: "google/gemini-3.5-flash" } });

  configureStt();

  expect(readConfig(configPath).stt).toEqual({ enabled: true, provider: "groq" });
});

test("configureStt flips a disabled stt block to enabled groq", () => {
  delete process.env.STT_PROVIDER;
  const configPath = withConfig({ stt: { enabled: false } });

  configureStt();

  expect(readConfig(configPath).stt).toEqual({ enabled: true, provider: "groq" });
});

test("configureStt honors the STT_PROVIDER override", () => {
  process.env.STT_PROVIDER = "openai";
  const configPath = withConfig({});

  configureStt();

  expect(readConfig(configPath).stt).toEqual({ enabled: true, provider: "openai" });
});

test("configureStt is idempotent", () => {
  delete process.env.STT_PROVIDER;
  const configPath = withConfig({ stt: { enabled: true, provider: "groq" } });

  configureStt();

  expect(readConfig(configPath).stt).toEqual({ enabled: true, provider: "groq" });
});

test("configureHostedGateway sets pairing, approvals, and telegram restart flag", () => {
  const configPath = withConfig({});

  configureHostedGateway();

  const doc = readConfig(configPath);
  expect((doc.gateway as Record<string, Record<string, unknown>>).pairing.global_mode).toBe("pair");
  expect((doc.approvals as Record<string, unknown>).mode).toBe(false);
  expect(
    (doc.platforms as Record<string, Record<string, unknown>>).telegram.gateway_restart_notification,
  ).toBe(false);
});

test("configureHostedGateway is idempotent and preserves other platform keys", () => {
  const configPath = withConfig({
    platforms: { telegram: { extra: { disable_link_previews: false } } },
  });

  configureHostedGateway();
  configureHostedGateway();

  const telegram = (readConfig(configPath).platforms as Record<string, Record<string, unknown>>).telegram;
  expect(telegram.gateway_restart_notification).toBe(false);
  expect((telegram.extra as Record<string, unknown>).disable_link_previews).toBe(false);
});

// DATA-160: av-events is enabled on every tenant, token or not. The old
// behaviour (skip the enable without AV_EVENTS_TOKEN in the process env) left
// the plugin off every control-plane tenant, because the control plane writes
// the token into $HERMES_HOME/.env only after the installer has run. The old
// "no-op without a token" and "blank token leaves plugins unset" tests are
// replaced by the enabled-without-a-token tests below.

const IDLE_NOTE = "(no AV_EVENTS_TOKEN yet; the plugin idles until the control plane writes one)";

/** Run `configureAvEvents` and return what it logged. */
function configureAvEventsLogged(): string[] {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    configureAvEvents();
    return log.mock.calls.map((args) => args.map(String).join(" "));
  } finally {
    log.mockRestore();
  }
}

function writeDotenv(configPath: string, body: string): string {
  const path = join(configPath, "..", ".env");
  writeFileSync(path, body);
  return path;
}

test("configureAvEvents enables the plugin when a token is present", () => {
  process.env.AV_EVENTS_TOKEN = "tenant-scoped-token";
  const configPath = withConfig({ plugins: { enabled: ["dashboard-auth-edgecity"] } });

  const logged = configureAvEventsLogged();

  const plugins = readConfig(configPath).plugins as Record<string, unknown>;
  expect(plugins.enabled).toEqual(["dashboard-auth-edgecity", "av-events"]);
  expect(logged).toEqual(["→ enabled plugin av-events"]);
});

test("configureAvEvents enables the plugin for a tenant without a token, and says it idles", () => {
  delete process.env.AV_EVENTS_TOKEN;
  const configPath = withConfig({ plugins: { enabled: ["dashboard-auth-edgecity"] } });

  const logged = configureAvEventsLogged();

  const plugins = readConfig(configPath).plugins as Record<string, unknown>;
  expect(plugins.enabled).toEqual(["dashboard-auth-edgecity", "av-events"]);
  expect(logged).toEqual([`→ enabled plugin av-events ${IDLE_NOTE}`]);
});

test("configureAvEvents enables the plugin on a config with no plugins block or no config at all", () => {
  delete process.env.AV_EVENTS_TOKEN;
  const configPath = withConfig({ model: { default: "google/gemini-3.5-flash" } });

  configureAvEventsLogged();

  const doc = readConfig(configPath);
  expect((doc.plugins as Record<string, unknown>).enabled).toEqual(["av-events"]);
  expect(doc.model).toEqual({ default: "google/gemini-3.5-flash" });

  const bare = mkdtempSync(join(tmpdir(), "agentvillage-config-"));
  process.env.HERMES_HOME = bare;
  configureAvEventsLogged();
  expect((readConfig(join(bare, "config.yaml")).plugins as Record<string, unknown>).enabled).toEqual(["av-events"]);
});

test("configureAvEvents treats a blank token as absent: enabled, with the idle note", () => {
  process.env.AV_EVENTS_TOKEN = "   ";
  const configPath = withConfig({});

  const logged = configureAvEventsLogged();

  expect((readConfig(configPath).plugins as Record<string, unknown>).enabled).toEqual(["av-events"]);
  expect(logged).toEqual([`→ enabled plugin av-events ${IDLE_NOTE}`]);
});

test("configureAvEvents reads the token's presence from $HERMES_HOME/.env when the process env lacks it", () => {
  delete process.env.AV_EVENTS_TOKEN;
  const configPath = withConfig({});
  const dotenv = writeDotenv(configPath, "OTHER=1\nexport AV_EVENTS_TOKEN='dotenv-token' # issued\n");

  const logged = configureAvEventsLogged();

  expect((readConfig(configPath).plugins as Record<string, unknown>).enabled).toEqual(["av-events"]);
  expect(logged).toEqual(["→ enabled plugin av-events"]);
  expect(readFileSync(configPath, "utf8")).not.toContain("dotenv-token");
  expect(readFileSync(dotenv, "utf8")).toBe("OTHER=1\nexport AV_EVENTS_TOKEN='dotenv-token' # issued\n");
});

test("configureAvEvents: a blank token in the process env is authoritative over .env (revoked)", () => {
  process.env.AV_EVENTS_TOKEN = "";
  const configPath = withConfig({});
  writeDotenv(configPath, "AV_EVENTS_TOKEN=stale-token\n");

  const logged = configureAvEventsLogged();

  expect((readConfig(configPath).plugins as Record<string, unknown>).enabled).toEqual(["av-events"]);
  expect(logged).toEqual([`→ enabled plugin av-events ${IDLE_NOTE}`]);
});

test("configureAvEvents: a blank .env token gets the idle note", () => {
  delete process.env.AV_EVENTS_TOKEN;
  const configPath = withConfig({});
  writeDotenv(configPath, "AV_EVENTS_TOKEN=\n");

  expect(configureAvEventsLogged()).toEqual([`→ enabled plugin av-events ${IDLE_NOTE}`]);
});

test("configureAvEvents is idempotent on a config that already lists it, keeping every entry in order", () => {
  delete process.env.AV_EVENTS_TOKEN;
  const configPath = withConfig({
    plugins: { enabled: ["dashboard-auth-edgecity", "av-events", "recall"], extra: { keep: true } },
  });

  configureAvEventsLogged();
  configureAvEventsLogged();

  const plugins = readConfig(configPath).plugins as Record<string, unknown>;
  expect(plugins.enabled).toEqual(["dashboard-auth-edgecity", "av-events", "recall"]);
  expect(plugins.extra).toEqual({ keep: true });
});

test("configureAvEvents is idempotent and never writes the token into config.yaml or .env", () => {
  process.env.AV_EVENTS_TOKEN = "tenant-scoped-token";
  const configPath = withConfig({});
  const dotenv = join(configPath, "..", ".env");

  configureAvEventsLogged();
  configureAvEventsLogged();

  const plugins = readConfig(configPath).plugins as Record<string, unknown>;
  expect(plugins.enabled).toEqual(["av-events"]);
  expect(readFileSync(configPath, "utf8")).not.toContain("tenant-scoped-token");
  expect(existsSync(dotenv)).toBe(false);
});

test("configureAvEvents: an unreadable .env (a directory) never stops the install", () => {
  delete process.env.AV_EVENTS_TOKEN;
  const configPath = withConfig({ plugins: { enabled: ["dashboard-auth-edgecity"] } });
  mkdirSync(join(configPath, "..", ".env"));

  let logged: string[] = [];
  expect(() => {
    logged = configureAvEventsLogged();
  }).not.toThrow();

  const plugins = readConfig(configPath).plugins as Record<string, unknown>;
  expect(plugins.enabled).toEqual(["dashboard-auth-edgecity", "av-events"]);
  expect(logged).toEqual([`→ enabled plugin av-events ${IDLE_NOTE}`]);
});

test("configureAvEvents warns when av-events is in plugins.disabled, and still lists it (idempotent)", () => {
  process.env.AV_EVENTS_TOKEN = "tenant-scoped-token";
  const configPath = withConfig({ plugins: { enabled: ["dashboard-auth-edgecity"], disabled: ["av-events"] } });

  const first = configureAvEventsLogged();
  const second = configureAvEventsLogged();

  const plugins = readConfig(configPath).plugins as Record<string, unknown>;
  expect(plugins.enabled).toEqual(["dashboard-auth-edgecity", "av-events"]);
  expect(plugins.disabled).toEqual(["av-events"]);
  const expected = [
    "→ enabled plugin av-events",
    "→ warning: av-events is in plugins.disabled; Hermes will not load it",
  ];
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
});

test("configureAvEvents does not warn when plugins.disabled lists only other plugins", () => {
  process.env.AV_EVENTS_TOKEN = "tenant-scoped-token";
  withConfig({ plugins: { disabled: ["recall"] } });

  expect(configureAvEventsLogged()).toEqual(["→ enabled plugin av-events"]);
});
