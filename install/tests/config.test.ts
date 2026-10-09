import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import {
  capModelMaxTokens,
  configureAvEvents,
  configureHostedGateway,
  configureIndexLinks,
  configureStt,
  disableTelegramLinkPreviews,
  dumpConfig,
  setTerminalCwd,
} from "../config";

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
const PYYAML = Bun.spawnSync(["python3", "-c", "import yaml"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

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

test.skipIf(!PYYAML)("DATA-434: PyYAML (Hermes's reader) reads every dumpConfig string back as that string", () => {
  const doc = {
    values: [...YAML11_WORDS, ...PLAIN_STRINGS, "=", "<<"],
    keys: Object.fromEntries([...YAML11_WORDS, "="].map((w, i) => [w, i])),
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
  expect(out.keys).toEqual([...YAML11_WORDS, "="].map((w) => ["str", w]));
});
