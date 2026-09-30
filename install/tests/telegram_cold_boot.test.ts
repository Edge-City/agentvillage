import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import {
  capModelMaxTokens,
  configureAvEvents,
  configureDashboardAuth,
  configureHostedGateway,
  configureStt,
  keepTelegramBacklogOnColdBoot,
  setTerminalCwd,
} from "../config";

// Hermes (2026-09-20+) discards Telegram's queued updates on a cold gateway start
// unless platforms.telegram.extra.drop_pending_on_cold_boot is false. The installer
// sets it to false only when an operator has not set it.

const ORIGINAL_HOME = process.env.HERMES_HOME;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  if (ORIGINAL_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = ORIGINAL_HOME;
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-telegram-"));
  process.env.HERMES_HOME = home;
  return join(home, "config.yaml");
}

function withText(text: string): string {
  const path = freshHome();
  writeFileSync(path, text);
  return path;
}

function withDoc(doc: unknown): string {
  return withText(YAML.stringify(doc));
}

function read(path: string): Record<string, unknown> {
  return YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function telegramOf(path: string): Record<string, unknown> {
  return (read(path).platforms as Record<string, Record<string, unknown>>).telegram!;
}

function extraOf(path: string): Record<string, unknown> {
  return telegramOf(path).extra as Record<string, unknown>;
}

function logged(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

test("no config.yaml: writes the key", () => {
  const path = freshHome();
  expect(existsSync(path)).toBe(false);

  keepTelegramBacklogOnColdBoot();

  expect(read(path)).toEqual({ platforms: { telegram: { extra: { drop_pending_on_cold_boot: false } } } });
});

test("no platforms section: adds it and changes nothing else", () => {
  const before = [
    "model:",
    "  default: google/gemini-3.5-flash",
    "  max_tokens: 4096",
    "terminal:",
    "  cwd: /data/hermes",
    "",
  ].join("\n");
  const path = withText(before);

  keepTelegramBacklogOnColdBoot();

  expect(readFileSync(path, "utf8")).toBe(
    before + ["platforms:", "  telegram:", "    extra:", "      drop_pending_on_cold_boot: false", ""].join("\n"),
  );
});

test("platforms without telegram: adds telegram.extra, other platforms untouched", () => {
  const path = withDoc({ platforms: { discord: { enabled: true, extra: { drop_pending_on_cold_boot: true } } } });

  keepTelegramBacklogOnColdBoot();

  const platforms = read(path).platforms as Record<string, unknown>;
  expect(platforms.discord).toEqual({ enabled: true, extra: { drop_pending_on_cold_boot: true } });
  expect(platforms.telegram).toEqual({ extra: { drop_pending_on_cold_boot: false } });
});

test("telegram without extra: adds extra, keeps the telegram keys byte-for-byte", () => {
  const before = [
    "gateway:",
    "  pairing:",
    "    global_mode: pair",
    "platforms:",
    "  telegram:",
    "    enabled: true",
    "    gateway_restart_notification: false",
    "stt:",
    "  enabled: true",
    "  provider: groq",
    "",
  ].join("\n");
  const path = withText(before);

  keepTelegramBacklogOnColdBoot();

  expect(readFileSync(path, "utf8")).toBe(
    [
      "gateway:",
      "  pairing:",
      "    global_mode: pair",
      "platforms:",
      "  telegram:",
      "    enabled: true",
      "    gateway_restart_notification: false",
      "    extra:",
      "      drop_pending_on_cold_boot: false",
      "stt:",
      "  enabled: true",
      "  provider: groq",
      "",
    ].join("\n"),
  );
});

test("telegram.extra with other keys: adds the key alongside them", () => {
  const path = withDoc({ platforms: { telegram: { extra: { disable_link_previews: false, dm_topics: [] } } } });

  keepTelegramBacklogOnColdBoot();

  expect(extraOf(path)).toEqual({ disable_link_previews: false, dm_topics: [], drop_pending_on_cold_boot: false });
});

test("null platforms / telegram / extra count as absent", () => {
  for (const doc of [
    { platforms: null },
    { platforms: { telegram: null } },
    { platforms: { telegram: { enabled: true, extra: null } } },
  ]) {
    const path = withDoc(doc);
    keepTelegramBacklogOnColdBoot();
    expect(extraOf(path).drop_pending_on_cold_boot).toBe(false);
  }
});

const HAND_SET: Array<[string, unknown]> = [
  ["extra true", { platforms: { telegram: { extra: { drop_pending_on_cold_boot: true } } } }],
  ["extra false", { platforms: { telegram: { extra: { drop_pending_on_cold_boot: false } } } }],
  ["extra string 'true'", { platforms: { telegram: { extra: { drop_pending_on_cold_boot: "true" } } } }],
  ["extra null", { platforms: { telegram: { extra: { drop_pending_on_cold_boot: null } } } }],
  // Hermes promotes non-typed top-level platform keys into extra (explicit extra wins on a clash),
  // so writing extra.drop_pending_on_cold_boot here would override the operator.
  ["telegram top-level true", { platforms: { telegram: { drop_pending_on_cold_boot: true } } }],
];

for (const [name, doc] of HAND_SET) {
  test(`operator value (${name}) is never overwritten and the file is not rewritten`, () => {
    const before = `# operator comment\n${YAML.stringify(doc)}`;
    const path = withText(before);

    keepTelegramBacklogOnColdBoot();
    keepTelegramBacklogOnColdBoot();

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(logged()).toContain("already set; left as is");
  });
}

for (const [name, doc, where] of [
  ["top level is a list", ["platforms"], "the top level of config.yaml"],
  ["top level is a scalar", "just a string", "the top level of config.yaml"],
  ["platforms is a list", { platforms: ["telegram"] }, "platforms"],
  ["telegram is a string", { platforms: { telegram: "on" } }, "platforms.telegram"],
  ["extra is a list", { platforms: { telegram: { extra: ["x"] } } }, "platforms.telegram.extra"],
] as Array<[string, unknown, string]>) {
  test(`non-mapping section (${name}) is left alone with a warning naming ${where}`, () => {
    const before = YAML.stringify(doc);
    const path = withText(before);

    keepTelegramBacklogOnColdBoot();

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(logged()).toContain(`warning: ${where} is not a mapping`);
    expect(logged()).not.toContain("already set");
    expect(logged()).not.toContain("→ set platforms");
  });
}

// The `yaml` package (YAML 1.2) reads `<<` as a literal key, but Hermes (PyYAML) applies it as a
// shallow merge. Writing an explicit `extra` beside a merge would replace the merged-in `extra`
// wholesale in Hermes: the operator's value flips and sibling keys vanish. So a merge key on the
// path means hands off.
const MERGE_CASES: Array<[string, string]> = [
  [
    "platforms.telegram",
    [
      "defaults: &tg",
      "  extra:",
      "    drop_pending_on_cold_boot: true",
      "    disable_link_previews: true",
      "platforms:",
      "  telegram:",
      "    <<: *tg",
      "    enabled: true",
      "",
    ].join("\n"),
  ],
  ["platforms", ["base: &p", "  telegram:", "    enabled: true", "platforms:", "  <<: *p", ""].join("\n")],
  [
    "platforms.telegram.extra",
    [
      "tgextra: &e",
      "  drop_pending_on_cold_boot: true",
      "platforms:",
      "  telegram:",
      "    extra:",
      "      <<: *e",
      "      disable_link_previews: true",
      "",
    ].join("\n"),
  ],
];

for (const [where, before] of MERGE_CASES) {
  test(`YAML merge key under ${where}: file left byte-identical with a warning`, () => {
    const path = withText(before);

    keepTelegramBacklogOnColdBoot();

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(logged()).toContain(`warning: YAML merge key "<<" under ${where}`);
  });
}

test("re-run is a no-op: the second run leaves the file byte-identical", () => {
  const path = withDoc({ model: { default: "x" }, platforms: { telegram: { enabled: true } } });

  keepTelegramBacklogOnColdBoot();
  const first = readFileSync(path, "utf8");
  keepTelegramBacklogOnColdBoot();

  expect(readFileSync(path, "utf8")).toBe(first);
  expect(extraOf(path).drop_pending_on_cold_boot).toBe(false);
});

test("an operator flipping it to true after install survives the next install", () => {
  const path = withDoc({});
  keepTelegramBacklogOnColdBoot();

  const doc = read(path);
  ((doc.platforms as Record<string, Record<string, Record<string, unknown>>>).telegram!.extra!)
    .drop_pending_on_cold_boot = true;
  writeFileSync(path, YAML.stringify(doc));

  keepTelegramBacklogOnColdBoot();

  expect(extraOf(path).drop_pending_on_cold_boot).toBe(true);
});

/** The config steps `install/install.ts` runs, in its order. */
function installerConfigPass(): void {
  setTerminalCwd();
  capModelMaxTokens();
  configureStt();
  configureHostedGateway();
  keepTelegramBacklogOnColdBoot();
  configureDashboardAuth();
  configureAvEvents();
}

test("full installer config pass: sets the key once, keeps it, and is idempotent on re-run", () => {
  const path = withDoc({
    model: { default: "google/gemini-3.5-flash" },
    platforms: { telegram: { extra: { disable_link_previews: false } } },
  });

  installerConfigPass();
  const first = readFileSync(path, "utf8");
  installerConfigPass();

  expect(readFileSync(path, "utf8")).toBe(first);
  const telegram = telegramOf(path);
  expect(telegram.gateway_restart_notification).toBe(false);
  expect(telegram.extra).toEqual({ disable_link_previews: false, drop_pending_on_cold_boot: false });
});

test("full installer config pass keeps an operator's true", () => {
  const path = withDoc({ platforms: { telegram: { extra: { drop_pending_on_cold_boot: true } } } });

  installerConfigPass();
  installerConfigPass();

  expect(extraOf(path).drop_pending_on_cold_boot).toBe(true);
});

for (const [name, text] of [
  ["empty", ""],
  ["comment-only", "# nothing configured yet\n"],
] as Array<[string, string]>) {
  test(`full installer config pass succeeds on a config.yaml that is ${name}`, () => {
    const path = withText(text);

    installerConfigPass();

    expect((read(path).terminal as Record<string, unknown>).cwd).toBe(process.env.HERMES_HOME);
    expect(extraOf(path).drop_pending_on_cold_boot).toBe(false);
  });
}
