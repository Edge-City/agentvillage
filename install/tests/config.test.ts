import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import {
  capModelMaxTokens,
  configureAvApproval,
  configureAvEvents,
  configureVillageBridge,
  configureHostedGateway,
  configureIndexLinks,
  configureModelFallback,
  configureStt,
  disableTelegramLinkPreviews,
  dumpConfig,
  setTerminalCwd,
  unlistPlugins,
} from "../config";
import { NOT_STAGED_PLUGINS } from "../install_approval";

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

test("OV-300 M1: unlistPlugins drops a not-staged plugin from plugins.enabled, keeps everything else, and is idempotent", () => {
  const path = withConfig({
    plugins: { enabled: ["existing", "village-bridge", "av-approval", "village-bridge"], disabled: ["village-bridge"], hook_callback_timeout: 30 },
  });
  expect(unlistPlugins(NOT_STAGED_PLUGINS)).toEqual(["village-bridge"]);
  expect(readConfig(path).plugins).toEqual({ enabled: ["existing", "av-approval"], disabled: ["village-bridge"], hook_callback_timeout: 30 });
  const first = readFileSync(path, "utf8");
  expect(unlistPlugins(NOT_STAGED_PLUGINS)).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(first);
});

test("OV-300 M1: unlistPlugins writes nothing when no listed plugin is enabled, or there is no plugins block", () => {
  const raw = "# operator comment\nplugins:\n  enabled: [existing]\n";
  const path = withConfig({});
  writeFileSync(path, raw);
  expect(unlistPlugins(NOT_STAGED_PLUGINS)).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(raw);
  writeFileSync(path, "model: {}\n");
  expect(unlistPlugins(NOT_STAGED_PLUGINS)).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("model: {}\n");
});

test("village bridge is listed without overriding an operator disable", () => {
  const path = withConfig({ plugins: { enabled: ["existing"], disabled: ["village-bridge"] } });
  configureVillageBridge();
  configureVillageBridge();
  expect(readConfig(path).plugins).toEqual({ enabled: ["existing", "village-bridge"], disabled: ["village-bridge"] });
  const install = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  expect(install).toContain("configureVillageBridge();");
  // The plugin config step still runs the NOT_STAGED_PLUGINS strip once, after the bridge is listed,
  // so a name the release list holds back is never left enabled.
  const main = install.slice(install.indexOf("function main(): void {"));
  const approval = main.indexOf("configureAvApproval();");
  const bridge = main.indexOf("configureVillageBridge();");
  const strip = main.indexOf("unlistPlugins(NOT_STAGED_PLUGINS)");
  expect(approval).toBeGreaterThan(0);
  expect(bridge).toBeGreaterThan(approval);
  expect(strip).toBeGreaterThan(bridge);
  expect(main.indexOf("unlistPlugins(", strip + 1)).toBe(-1);
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

// AGENT-DATE: every resident message reaches the model stamped with the time it was sent, so a
// continuing session's frozen "today's date" line is never the agent's only clock.
const stampsOf = (path: string): unknown => (readConfig(path).gateway as Record<string, unknown>).message_timestamps;

test("configureHostedGateway turns message timestamps on for a fresh config", () => {
  const configPath = withConfig({});

  logged(configureHostedGateway);

  expect(stampsOf(configPath)).toEqual({ enabled: true });
  // Written as a real YAML boolean, which Hermes's PyYAML reader takes as True.
  expect(readFileSync(configPath, "utf8")).toMatch(/message_timestamps:\n\s+enabled: true\n/);
});

test("configureHostedGateway keeps every other gateway key and the timestamp block's own keys", () => {
  const configPath = withConfig({
    gateway: {
      pairing: { global_mode: "open", code_ttl: 600 },
      max_inbound_media_bytes: 1024,
      message_timestamps: { enabled: true, note: "kept" },
    },
  });

  logged(configureHostedGateway);

  const gateway = readConfig(configPath).gateway as Record<string, unknown>;
  expect(gateway.pairing).toEqual({ global_mode: "pair", code_ttl: 600 });
  expect(gateway.max_inbound_media_bytes).toBe(1024);
  expect(gateway.message_timestamps).toEqual({ enabled: true, note: "kept" });
});

test("configureHostedGateway pins timestamps on over a false or a non-mapping value, and says so", () => {
  for (const [value, line] of [
    [{ enabled: false }, "gateway.message_timestamps.enabled was not true; set to true"],
    [{ enabled: "yes" }, "gateway.message_timestamps.enabled was not true; set to true"],
    [false, "gateway.message_timestamps was not a mapping; replaced with { enabled: true }"],
    ["on", "gateway.message_timestamps was not a mapping; replaced with { enabled: true }"],
    [[1], "gateway.message_timestamps was not a mapping; replaced with { enabled: true }"],
  ] as const) {
    const configPath = withConfig({ gateway: { message_timestamps: value } });
    const out = logged(configureHostedGateway).join("\n");
    expect({ value, stamps: stampsOf(configPath) }).toEqual({ value, stamps: { enabled: true } });
    expect(out).toContain(line);
  }
  // The bare `true` shorthand Hermes reads is normalised without a warning; null counts as unset.
  for (const value of [true, null]) {
    const configPath = withConfig({ gateway: { message_timestamps: value } });
    const out = logged(configureHostedGateway).join("\n");
    expect(stampsOf(configPath)).toEqual({ enabled: true });
    expect(out).not.toContain("was not");
  }
});

test("configureHostedGateway: timestamps survive a roll and a re-run writes the same bytes", () => {
  const configPath = withConfig({ gateway: { pairing: { global_mode: "pair" } }, timezone: "Asia/Kolkata" });

  logged(configureHostedGateway);
  const first = readFileSync(configPath, "utf8");
  logged(configureHostedGateway);
  logged(configureHostedGateway);

  expect(readFileSync(configPath, "utf8")).toBe(first);
  expect(stampsOf(configPath)).toEqual({ enabled: true });
  expect(readConfig(configPath).timezone).toBe("Asia/Kolkata");
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

function logged(step: () => void): string[] {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    step();
    return log.mock.calls.map((args) => args.map(String).join(" "));
  } finally {
    log.mockRestore();
  }
}

// SEREF-OVERLAY refute N11: configureIndexLinks had no test.
test("configureIndexLinks run twice lists index-links once and keeps enabled, hook_callback_timeout and disabled", () => {
  const configPath = withConfig({
    plugins: { enabled: ["dashboard-auth-edgecity", "av-events"], hook_callback_timeout: 600, disabled: ["recall"] },
  });

  const first = logged(configureIndexLinks);
  const second = logged(configureIndexLinks);

  const plugins = readConfig(configPath).plugins as Record<string, unknown>;
  expect(plugins.enabled).toEqual(["dashboard-auth-edgecity", "av-events", "index-links"]);
  expect(plugins.hook_callback_timeout).toBe(600);
  expect(plugins.disabled).toEqual(["recall"]);
  expect(first).toEqual(["→ enabled plugin index-links"]);
  expect(second).toEqual(first);
});

test("configureIndexLinks keeps index-links in plugins.disabled and warns (the rollback switch)", () => {
  const configPath = withConfig({ plugins: { enabled: ["av-events"], disabled: ["index-links"] } });

  const out = logged(configureIndexLinks);

  const plugins = readConfig(configPath).plugins as Record<string, unknown>;
  expect(plugins.disabled).toEqual(["index-links"]);
  expect(out).toContain("→ warning: index-links is in plugins.disabled; Hermes will not load it");
});

// SEREF-OVERLAY refute F1: Telegram's preview crawler must never fetch a signed accept link.
test("disableTelegramLinkPreviews sets platforms.telegram.extra.disable_link_previews and keeps sibling keys", () => {
  const configPath = withConfig({
    model: { default: "m" },
    platforms: { telegram: { gateway_restart_notification: false, extra: { drop_pending_on_cold_boot: false } } },
  });

  disableTelegramLinkPreviews();

  const doc = readConfig(configPath);
  expect(doc.model).toEqual({ default: "m" });
  expect((doc.platforms as Record<string, unknown>).telegram).toEqual({
    gateway_restart_notification: false,
    extra: { drop_pending_on_cold_boot: false, disable_link_previews: true },
  });
});

test("disableTelegramLinkPreviews on an empty config and on re-run: written once, then byte-identical", () => {
  const configPath = withConfig({});

  const first = logged(disableTelegramLinkPreviews);
  const after = readFileSync(configPath, "utf8");
  const second = logged(disableTelegramLinkPreviews);

  expect(readConfig(configPath)).toEqual({ platforms: { telegram: { extra: { disable_link_previews: true } } } });
  expect(readFileSync(configPath, "utf8")).toBe(after);
  expect(first).toEqual(["→ set platforms.telegram.extra.disable_link_previews: true (no link previews on signed links)"]);
  expect(second).toEqual(["→ telegram disable_link_previews already true"]);
});

test("disableTelegramLinkPreviews overrides a hand-set false, under extra and at the top of the telegram block", () => {
  const configPath = withConfig({ platforms: { telegram: { disable_link_previews: false, extra: { disable_link_previews: false } } } });

  const out = logged(disableTelegramLinkPreviews);

  const telegram = (readConfig(configPath).platforms as Record<string, Record<string, unknown>>).telegram;
  expect(telegram.disable_link_previews).toBe(true);
  expect((telegram.extra as Record<string, unknown>).disable_link_previews).toBe(true);
  expect(out[0]).toContain("overrode platforms.telegram.extra.disable_link_previews, platforms.telegram.disable_link_previews");
});

test("disableTelegramLinkPreviews leaves a YAML merge key alone and warns; warns on a top-level telegram false", () => {
  const merged = ["tg: &tg", "  enabled: true", "platforms:", "  telegram:", "    <<: *tg", ""].join("\n");
  const home = mkdtempSync(join(tmpdir(), "agentvillage-config-"));
  process.env.HERMES_HOME = home;
  const mergedPath = join(home, "config.yaml");
  writeFileSync(mergedPath, merged);

  const out = logged(disableTelegramLinkPreviews);

  expect(readFileSync(mergedPath, "utf8")).toBe(merged);
  expect(out.join("\n")).toContain('warning: YAML merge key "<<" under platforms.telegram');

  withConfig({ telegram: { disable_link_previews: false } });
  const top = logged(disableTelegramLinkPreviews);
  expect(top.join("\n")).toContain("warning: telegram.disable_link_previews is false");
});

test("configureHostedGateway then disableTelegramLinkPreviews: both keys, idempotent across two passes", () => {
  const configPath = withConfig({ platforms: { telegram: { extra: { dm_topics: [] } } } });
  const pass = (): void => {
    configureHostedGateway();
    disableTelegramLinkPreviews();
  };

  logged(pass);
  const first = readFileSync(configPath, "utf8");
  logged(pass);

  expect(readFileSync(configPath, "utf8")).toBe(first);
  const telegram = (readConfig(configPath).platforms as Record<string, Record<string, unknown>>).telegram;
  expect(telegram.gateway_restart_notification).toBe(false);
  expect(telegram.extra).toEqual({ dm_topics: [], disable_link_previews: true });
});

// DATA-434: Hermes reads config.yaml with PyYAML (YAML 1.1), where a bare off/on/yes/no is a
// boolean; the `yaml` package's YAML 1.1 parse stands in for PyYAML below (`python3` with PyYAML
// checks the real reader when it is installed).
const YAML11_WORDS = [
  "y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO", "on", "On", "ON", "off", "Off", "OFF",
  "true", "True", "TRUE", "false", "False", "FALSE", "null", "Null", "NULL", "~",
  "0b101", "0755", "1_000", "22:00", "8:30", "1.", "2026-10-08", "2026-10-08T12:00:00Z",
];
const PLAIN_STRINGS = ["new", "all", "verbose", "log", "accumulate", "Asia/Kolkata", "/data/.hermes", "oFf", "0o755", "1e3", "a: b", "multi\nline\n"];
// Strings the `yaml` package's 1.1 schema reads as strings but PyYAML does not (refuter M1): a tab
// in a single-line scalar (PyYAML and ruamel refuse the file), a time zone PyYAML refuses as an
// offset, and a fraction with no digits (a datetime to PyYAML). A tab in a multi-line string needs
// nothing: the package emits a block scalar, which both readers accept.
const PYYAML_ONLY = ["a\tb", "2026-10-08T10:00:00+35", "2026-10-08T10:00:00."];
const PYYAML = Bun.spawnSync(["python3", "-c", "import yaml"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (process.env.CI && !PYYAML) throw new Error("DATA-434: CI must have PyYAML (python3 -c 'import yaml' failed), or the Hermes read-back test is skipped silently");

test("DATA-434: a resident's /verbose 'off' survives an installer rewrite of config.yaml as the string, and a re-run rewrites nothing new", () => {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-config-"));
  process.env.HERMES_HOME = home;
  const configPath = join(home, "config.yaml");
  // As Hermes's own writer leaves it after /verbose (utils.py `_rt_value` double-quotes the word).
  writeFileSync(configPath, 'display:\n  platforms:\n    telegram:\n      tool_progress: "off"\n');

  logged(setTerminalCwd);
  const first = readFileSync(configPath, "utf8");
  logged(setTerminalCwd);

  expect(first).toBe(`display:\n  platforms:\n    telegram:\n      tool_progress: "off"\nterminal:\n  cwd: ${home}\n`);
  expect(readFileSync(configPath, "utf8")).toBe(first);
  const asHermes = YAML.parse(first, { version: "1.1" }) as { display: { platforms: { telegram: { tool_progress: unknown } } } };
  expect(asHermes.display.platforms.telegram.tool_progress).toBe("off");
});

test("DATA-434: dumpConfig double-quotes every string YAML 1.1 reads as another type, as value, list item and key; other scalars keep the 1.2 dump's bytes", () => {
  for (const word of YAML11_WORDS) {
    const doc = { k: word, l: [word], m: { [word]: 1 } };
    const text = dumpConfig(doc);
    expect(text).toBe(`k: "${word}"\nl:\n  - "${word}"\nm:\n  "${word}": 1\n`);
    expect(YAML.parse(text, { version: "1.1" })).toEqual(doc);
    expect(YAML.parse(text)).toEqual(doc);
  }
  const rest = {
    strings: PLAIN_STRINGS,
    numbers: [0, -1, 4096, 1.5, 0.1],
    flags: [true, false, null],
    nested: { show_reasoning: false, tool_progress: "new", list: [] as unknown[], empty: {} },
  };
  expect(dumpConfig(rest)).toBe(YAML.stringify(rest));
  expect(YAML.parse(dumpConfig(rest))).toEqual(rest);
});

test("DATA-434: dumpConfig quotes `=` anywhere and `<<` as a value (PyYAML refuses either bare); a `<<` key stays bare", () => {
  const doc = { a: "=", b: "<<", l: ["=", "<<"], "=": 1, "<<": { x: 1 } };
  expect(dumpConfig(doc)).toBe('a: "="\nb: "<<"\nl:\n  - "="\n  - "<<"\n"=": 1\n<<:\n  x: 1\n');
  expect(YAML.parse(dumpConfig(doc))).toEqual(doc);
});

test("DATA-434: dumpConfig quotes the strings PyYAML alone misreads (a single-line tab, a wide time zone, an empty fraction); a multi-line tab stays a block scalar", () => {
  for (const s of PYYAML_ONLY) {
    const text = dumpConfig({ k: s, l: [s], m: { [s]: 1 } });
    expect(text.startsWith('k: "')).toBe(true);
    expect(text).toContain('\n  - "');
    expect(text).toContain('\n  "');
    expect(YAML.parse(text, { version: "1.1" })).toEqual({ k: s, l: [s], m: { [s]: 1 } });
    expect(YAML.parse(text)).toEqual({ k: s, l: [s], m: { [s]: 1 } });
  }
  expect(dumpConfig({ k: "a\tb\nc\n" })).toBe("k: |\n  a\tb\n  c\n");
});

test.skipIf(!PYYAML)("DATA-434: PyYAML (Hermes's reader) reads every dumpConfig string back as that string", () => {
  const doc = {
    values: [...YAML11_WORDS, ...PLAIN_STRINGS, ...PYYAML_ONLY, "a\tb\nc\n", "=", "<<"],
    keys: Object.fromEntries([...YAML11_WORDS, ...PYYAML_ONLY, "="].map((w, i) => [w, i])),
  };
  const script = [
    "import json, sys, yaml",
    "got = yaml.safe_load(sys.stdin.read())",
    "print(json.dumps({'values': [[type(v).__name__, v] for v in got['values']], 'keys': [[type(k).__name__, k] for k in got['keys']]}, default=str))",
  ].join("\n");
  const run = Bun.spawnSync(["python3", "-c", script], { stdin: Buffer.from(dumpConfig(doc)) });
  expect(run.exitCode).toBe(0);
  const out = JSON.parse(run.stdout.toString()) as { values: [string, unknown][]; keys: [string, unknown][] };
  expect(out.values).toEqual(doc.values.map((v) => ["str", v]));
  expect(out.keys).toEqual([...YAML11_WORDS, ...PYYAML_ONLY, "="].map((w) => ["str", w]));
});

// Approval code-gap lane 2 (credential custody): av-approval is listed on every tenant, whatever
// AV_APPROVAL_ENABLED says, so custody runs everywhere; the gate half stays off unless the switch is on.
for (const approvalSwitch of [undefined, "0", "1"]) {
  test(`configureAvApproval lists av-approval with AV_APPROVAL_ENABLED=${approvalSwitch ?? "unset"}, idempotently`, () => {
    const before = process.env.AV_APPROVAL_ENABLED;
    if (approvalSwitch === undefined) delete process.env.AV_APPROVAL_ENABLED;
    else process.env.AV_APPROVAL_ENABLED = approvalSwitch;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const configPath = withConfig({ plugins: { enabled: ["dashboard-auth-edgecity", "av-events"], extra: { keep: true } } });
      configureAvApproval();
      configureAvApproval();
      const plugins = readConfig(configPath).plugins as Record<string, unknown>;
      expect(plugins.enabled).toEqual(["dashboard-auth-edgecity", "av-events", "av-approval"]);
      expect(plugins.extra).toEqual({ keep: true });
    } finally {
      log.mockRestore();
      if (before === undefined) delete process.env.AV_APPROVAL_ENABLED;
      else process.env.AV_APPROVAL_ENABLED = before;
    }
  });
}

test("configureAvApproval on a config with no plugins block", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const bare = withConfig({});
    configureAvApproval();
    const plugins = readConfig(bare).plugins as Record<string, unknown>;
    expect(plugins.enabled).toEqual(["av-approval"]);
    expect("disabled" in plugins).toBe(false);
  } finally {
    log.mockRestore();
  }
});

// SEC-1 (S3): with AV_APPROVAL_ENABLED unset or off, installApproval never runs its own
// plugins.disabled fix, so configureAvApproval (every run) takes av-approval out of the deny-list.
for (const approvalSwitch of [undefined, "0", "1"]) {
  test(`configureAvApproval removes av-approval from plugins.disabled with AV_APPROVAL_ENABLED=${approvalSwitch ?? "unset"}`, () => {
    const before = process.env.AV_APPROVAL_ENABLED;
    if (approvalSwitch === undefined) delete process.env.AV_APPROVAL_ENABLED;
    else process.env.AV_APPROVAL_ENABLED = approvalSwitch;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const configPath = withConfig({
        plugins: { enabled: ["av-events"], disabled: ["av-approval", "other", "av-approval", "user/av-approval", 7, "AV-APPROVAL"] },
      });
      configureAvApproval();
      const plugins = readConfig(configPath).plugins as Record<string, unknown>;
      expect(plugins.disabled).toEqual(["other", "user/av-approval", 7, "AV-APPROVAL"]);
      expect(plugins.enabled).toEqual(["av-events", "av-approval"]);
      const lines = log.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.at(-1)).toBe("→ removed av-approval from plugins.disabled (custody must run on every box)");
      const bytes = readFileSync(configPath, "utf8");
      configureAvApproval();
      expect(readFileSync(configPath, "utf8")).toBe(bytes);
    } finally {
      log.mockRestore();
      if (before === undefined) delete process.env.AV_APPROVAL_ENABLED;
      else process.env.AV_APPROVAL_ENABLED = before;
    }
  });
}

test("configureAvApproval leaves a plugins.disabled that is not a list, or that lacks av-approval, as it is", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const disabled of ["av-approval", null, { "av-approval": true }, ["other"], []]) {
      const configPath = withConfig({ plugins: { enabled: [], disabled } });
      configureAvApproval();
      const plugins = readConfig(configPath).plugins as Record<string, unknown>;
      expect(plugins.disabled).toEqual(disabled);
      expect(plugins.enabled).toEqual(["av-approval"]);
    }
    const lines = log.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines.some((line) => line.startsWith("→ removed"))).toBe(false);
  } finally {
    log.mockRestore();
  }
});

// LLM-429 (lanes-intro/LLM-429.md): a one-entry Hermes fallback chain to luna, so an upstream 429
// on the primary model switches that turn to luna with no wait. The literal pins the shipped value.
const LUNA = { provider: "openrouter", model: "openai/gpt-6-luna" };

function quietLog(): { lines: () => string[]; restore: () => void } {
  const log = spyOn(console, "log").mockImplementation(() => {});
  return { lines: () => log.mock.calls.map((args) => args.map(String).join(" ")), restore: () => log.mockRestore() };
}

test("LLM-429: configureModelFallback writes the one luna entry when fallback_providers is absent, null or empty", () => {
  const log = quietLog();
  try {
    for (const raw of [undefined, null, []]) {
      const configPath = withConfig(raw === undefined ? { model: { default: "anthropic/claude-haiku-5.5" } } : { fallback_providers: raw });
      configureModelFallback();
      expect(readConfig(configPath).fallback_providers).toEqual([LUNA]);
    }
    expect(log.lines().filter((line) => line.startsWith("→ set fallback_providers")).length).toBe(3);
  } finally {
    log.restore();
  }
});

test("LLM-429: configureModelFallback writes the entry on a missing config.yaml", () => {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-config-"));
  process.env.HERMES_HOME = home;
  const log = quietLog();
  try {
    configureModelFallback();
  } finally {
    log.restore();
  }
  expect(readConfig(join(home, "config.yaml"))).toEqual({ fallback_providers: [LUNA] });
});

test("LLM-429: a second configureModelFallback run is a no-op (same bytes, says already)", () => {
  const configPath = withConfig({ model: { default: "anthropic/claude-haiku-5.5", max_tokens: 4096 } });
  const log = quietLog();
  try {
    configureModelFallback();
    const first = readFileSync(configPath, "utf8");
    configureModelFallback();
    expect(readFileSync(configPath, "utf8")).toBe(first);
    expect(log.lines().at(-1)).toStartWith("→ fallback_providers already has openrouter / openai/gpt-6-luna");
  } finally {
    log.restore();
  }
});

test("LLM-429: an entry a human wrote that names the same route (case, spacing, extra keys) counts as ours: nothing is rewritten", () => {
  const raw = "# operator note\nfallback_providers:\n  - provider: OpenRouter\n    model: ' openai/GPT-6-luna '\n    reasoning_echo: true\n";
  const configPath = withConfig({});
  writeFileSync(configPath, raw);
  const log = quietLog();
  try {
    configureModelFallback();
  } finally {
    log.restore();
  }
  expect(readFileSync(configPath, "utf8")).toBe(raw);
});

test("LLM-429: configureModelFallback keeps a human's entries in order and appends luna once", () => {
  const foreign = [
    { provider: "anthropic", model: "claude-sonnet-5.5", key_env: "ANTHROPIC_API_KEY" },
    "not-an-entry",
    { provider: "openrouter", model: "google/gemini-3.5-flash", base_url: "https://openrouter.ai/api/v1" },
  ];
  const configPath = withConfig({ fallback_providers: foreign });
  const log = quietLog();
  try {
    configureModelFallback();
    configureModelFallback();
    expect(readConfig(configPath).fallback_providers).toEqual([...foreign, LUNA]);
    expect(log.lines()[0]).toBe("→ added openrouter / openai/gpt-6-luna to fallback_providers after 3 existing entries");
  } finally {
    log.restore();
  }
});

test("LLM-429: a legacy single-mapping fallback_providers becomes a list with that mapping first, then luna", () => {
  const single = { provider: "anthropic", model: "claude-sonnet-5.5" };
  const configPath = withConfig({ fallback_providers: single });
  const log = quietLog();
  try {
    configureModelFallback();
  } finally {
    log.restore();
  }
  expect(readConfig(configPath).fallback_providers).toEqual([single, LUNA]);
});

test("LLM-429: a fallback_providers that is neither a list nor a mapping, or a top-level merge key, is left alone with a warning", () => {
  const log = quietLog();
  try {
    for (const raw of ["fallback_providers: value-never-echoed\n", "fallback_providers: 3\n", "base: &b {}\n<<: *b\n"]) {
      const configPath = withConfig({});
      writeFileSync(configPath, raw);
      configureModelFallback();
      expect(readFileSync(configPath, "utf8")).toBe(raw);
    }
    expect(log.lines()).toEqual([
      "→ warning: fallback_providers is a string, not a list; left as is (add openrouter / openai/gpt-6-luna by hand)",
      "→ warning: fallback_providers is a number, not a list; left as is (add openrouter / openai/gpt-6-luna by hand)",
      '→ warning: YAML merge key "<<" at the top of config.yaml; left fallback_providers unset (add openrouter / openai/gpt-6-luna by hand)',
    ]);
  } finally {
    log.restore();
  }
});

test("LLM-429: configureModelFallback leaves model, model.context_length, model.max_tokens and cron.model exactly as they were", () => {
  const before = {
    model: { default: "anthropic/claude-haiku-5.5", model: "openai/gpt-6-luna", context_length: 90000, max_tokens: 4096 },
    cron: { model: "anthropic/claude-haiku-5.5", script_timeout_seconds: 120, wrap_response: false },
    fallback_model: { provider: "openrouter", model: "openai/gpt-6-luna" },
    context_file_max_chars: 48000,
  };
  const configPath = withConfig(before);
  const log = quietLog();
  try {
    configureModelFallback();
  } finally {
    log.restore();
  }
  const after = readConfig(configPath);
  expect(after).toEqual({ ...before, fallback_providers: [LUNA] });
});

test("LLM-429: written even when the primary model is already luna (Hermes skips a chain entry equal to the failing backend)", () => {
  for (const model of ["openai/gpt-6-luna", { default: "openai/gpt-6-luna", max_tokens: 4096 }]) {
    const configPath = withConfig({ model, cron: { model: "openai/gpt-6-luna" } });
    const log = quietLog();
    try {
      configureModelFallback();
    } finally {
      log.restore();
    }
    const after = readConfig(configPath);
    expect(after.fallback_providers).toEqual([LUNA]);
    expect(after.model).toEqual(model);
  }
});

test("LLM-429: the dumped chain reads back as the same list under YAML 1.2, YAML 1.1 and PyYAML when present", () => {
  const configPath = withConfig({ fallback_providers: [{ provider: "anthropic", model: "claude-sonnet-5.5" }] });
  const log = quietLog();
  try {
    configureModelFallback();
  } finally {
    log.restore();
  }
  const text = readFileSync(configPath, "utf8");
  const want = [{ provider: "anthropic", model: "claude-sonnet-5.5" }, LUNA];
  expect(YAML.parse(text).fallback_providers).toEqual(want);
  expect(YAML.parse(text, { version: "1.1" }).fallback_providers).toEqual(want);
  expect(dumpConfig(YAML.parse(text))).toBe(text);
  if (PYYAML) {
    const script = "import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())['fallback_providers']))";
    const run = Bun.spawnSync(["python3", "-c", script], { stdin: Buffer.from(text) });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual(want);
  }
});

test("LLM-429: install.ts runs configureModelFallback right after capModelMaxTokens", () => {
  const install = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  expect(install).toMatch(/\n  capModelMaxTokens\(\);\n  configureModelFallback\(\);\n/);
});
