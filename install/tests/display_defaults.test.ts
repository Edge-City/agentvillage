import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { DISPLAY_DEFAULTS_ENV, configureTelegramDisplay } from "../display_defaults";

// DATA-318: residents never see reasoning on Telegram and see one quiet,
// edited-in-place progress message per reply. Telegram-scoped keys only.

const ORIGINAL = { HERMES_HOME: process.env.HERMES_HOME, [DISPLAY_DEFAULTS_ENV]: process.env[DISPLAY_DEFAULTS_ENV] };
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  delete process.env[DISPLAY_DEFAULTS_ENV];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const APPLIED = {
  show_reasoning: false,
  tool_progress: "new",
  tool_progress_grouping: "accumulate",
  interim_assistant_messages: false,
  streaming: false,
  cleanup_progress: true,
};

/** The display block Hermes v2026.9.24 writes, as seen on a production sandbox (trimmed). */
const HERMES_DEFAULT_DISPLAY = {
  compact: false,
  tool_progress: "all",
  cleanup_progress: false,
  interim_assistant_messages: true,
  show_reasoning: true,
  streaming: false,
  tool_progress_grouping: "accumulate",
  platforms: {
    telegram: { streaming: true },
    discord: { streaming: false },
    slack: { streaming: false },
    wecom: { streaming: true },
  },
};

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-display-"));
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

function displayOf(path: string): Record<string, unknown> {
  return read(path).display as Record<string, unknown>;
}

function telegramOf(path: string): Record<string, unknown> {
  return (displayOf(path).platforms as Record<string, Record<string, unknown>>).telegram!;
}

function logged(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

test("no config.yaml: writes the Telegram display block and nothing else", () => {
  const path = freshHome();
  expect(existsSync(path)).toBe(false);

  expect(configureTelegramDisplay().sort()).toEqual(Object.keys(APPLIED).sort());

  expect(read(path)).toEqual({ display: { platforms: { telegram: APPLIED } } });
});

test("Hermes defaults: Telegram gets the quiet settings; globals, other platforms and other sections untouched", () => {
  const path = withDoc({
    model: { default: "google/gemini-3.5-flash", max_tokens: 4096 },
    display: HERMES_DEFAULT_DISPLAY,
    platforms: { telegram: { gateway_restart_notification: false, extra: { drop_pending_on_cold_boot: false } } },
  });

  configureTelegramDisplay();

  const doc = read(path);
  expect(telegramOf(path)).toEqual(APPLIED);
  const { platforms, ...globals } = doc.display as Record<string, unknown>;
  const { platforms: defaultPlatforms, ...defaultGlobals } = HERMES_DEFAULT_DISPLAY;
  expect(globals).toEqual(defaultGlobals); // the CLI / desktop surfaces keep Hermes's defaults
  const { telegram: _t, ...otherPlatforms } = platforms as Record<string, unknown>;
  const { telegram: _d, ...otherDefaultPlatforms } = defaultPlatforms;
  expect(otherPlatforms).toEqual(otherDefaultPlatforms);
  expect(doc.model).toEqual({ default: "google/gemini-3.5-flash", max_tokens: 4096 });
  expect(doc.platforms).toEqual({
    telegram: { gateway_restart_notification: false, extra: { drop_pending_on_cold_boot: false } },
  });
});

test("a block the resident customised: show_reasoning is forced off, every other hand-set value is kept", () => {
  const path = withDoc({
    display: {
      ...HERMES_DEFAULT_DISPLAY,
      platforms: {
        telegram: {
          show_reasoning: true,
          tool_progress: "all",
          tool_progress_grouping: "separate",
          interim_assistant_messages: true,
          streaming: "true", // not the boolean Hermes writes: a hand edit
          cleanup_progress: false,
          reasoning_style: "blockquote",
        },
      },
    },
  });

  expect(configureTelegramDisplay()).toEqual(["show_reasoning"]);

  expect(telegramOf(path)).toEqual({
    show_reasoning: false,
    tool_progress: "all",
    tool_progress_grouping: "separate",
    interim_assistant_messages: true,
    streaming: "true",
    cleanup_progress: false,
    reasoning_style: "blockquote",
  });
  expect(logged()).toContain("kept as set by hand: tool_progress, tool_progress_grouping, interim_assistant_messages, streaming, cleanup_progress");
});

test("show_reasoning is forced off whatever spelling turned it on", () => {
  for (const on of [true, "true", "on", "verbose", 1]) {
    const path = withDoc({ display: { show_reasoning: true, platforms: { telegram: { ...APPLIED, show_reasoning: on } } } });

    expect(configureTelegramDisplay()).toEqual(["show_reasoning"]);

    expect(telegramOf(path).show_reasoning).toBe(false);
  }
});

test("null values count as unset (Hermes treats null as inherit)", () => {
  const path = withText([
    "display:",
    "  platforms:",
    "    telegram:",
    "      tool_progress: ~",
    "      streaming: null",
    "      cleanup_progress:",
    "",
  ].join("\n"));

  configureTelegramDisplay();

  expect(telegramOf(path)).toEqual(APPLIED);
});

test("a legacy tool_progress_overrides entry for telegram is a hand-set tool_progress and is kept", () => {
  const path = withDoc({ display: { tool_progress_overrides: { telegram: "verbose" } } });

  configureTelegramDisplay();

  const { tool_progress: _tp, ...rest } = APPLIED;
  expect(telegramOf(path)).toEqual(rest);
  expect(displayOf(path).tool_progress_overrides).toEqual({ telegram: "verbose" });
});

test("idempotent: a second run changes nothing and does not rewrite the file (comments survive)", () => {
  const path = freshHome();
  configureTelegramDisplay();
  const once = readFileSync(path, "utf8");

  expect(configureTelegramDisplay()).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(once);
  expect(logged()).toContain("telegram display settings already in place");

  // A file already in the target state is never rewritten, so its comments and layout stay.
  const commented = [
    "# operator notes",
    "display:",
    "  show_reasoning: true   # CLI keeps reasoning",
    "  platforms:",
    "    telegram:",
    "      show_reasoning: false",
    "      tool_progress: new",
    "      tool_progress_grouping: accumulate",
    "      interim_assistant_messages: false",
    "      streaming: false",
    "      cleanup_progress: true",
    "",
  ].join("\n");
  const path2 = withText(commented);
  expect(configureTelegramDisplay()).toEqual([]);
  expect(readFileSync(path2, "utf8")).toBe(commented);
});

test("idempotent with hand-set values: a second run leaves them and the file alone", () => {
  const path = withDoc({ display: { platforms: { telegram: { tool_progress: "verbose" } } } });
  configureTelegramDisplay();
  const once = readFileSync(path, "utf8");

  expect(configureTelegramDisplay()).toEqual([]);

  expect(readFileSync(path, "utf8")).toBe(once);
  expect(telegramOf(path).tool_progress).toBe("verbose");
});

test(`${DISPLAY_DEFAULTS_ENV}=0 in the environment leaves config.yaml untouched`, () => {
  const text = YAML.stringify({ display: HERMES_DEFAULT_DISPLAY });
  for (const off of ["0", "false", "No", " OFF "]) {
    process.env[DISPLAY_DEFAULTS_ENV] = off;
    const path = withText(text);

    expect(configureTelegramDisplay()).toEqual([]);

    expect(readFileSync(path, "utf8")).toBe(text);
  }
  expect(logged()).toContain(`left untouched (${DISPLAY_DEFAULTS_ENV} is off)`);
});

test(`${DISPLAY_DEFAULTS_ENV}=0 in $HERMES_HOME/.env leaves config.yaml untouched; any other value applies`, () => {
  const text = YAML.stringify({ display: HERMES_DEFAULT_DISPLAY });
  const path = withText(text);
  writeFileSync(join(process.env.HERMES_HOME!, ".env"), `${DISPLAY_DEFAULTS_ENV}=0\n`);

  expect(configureTelegramDisplay()).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(text);

  writeFileSync(join(process.env.HERMES_HOME!, ".env"), `${DISPLAY_DEFAULTS_ENV}=1\n`);
  configureTelegramDisplay();
  expect(telegramOf(path)).toEqual(APPLIED);

  // The process environment wins over the file, as for the other AV_* flags.
  const path2 = withText(text);
  writeFileSync(join(process.env.HERMES_HOME!, ".env"), `${DISPLAY_DEFAULTS_ENV}=off\n`);
  process.env[DISPLAY_DEFAULTS_ENV] = "1";
  configureTelegramDisplay();
  expect(telegramOf(path2)).toEqual(APPLIED);
});

test("leaves the file alone with a warning when a level is not a mapping or holds a merge key", () => {
  const cases: Array<[string, string]> = [
    ["- just\n- a list\n", "top level of config.yaml is not a mapping"],
    ["display: quiet\n", "display is not a mapping"],
    ["display:\n  platforms: [telegram]\n", "display.platforms is not a mapping"],
    ["display:\n  platforms:\n    telegram: off\n", "display.platforms.telegram is not a mapping"],
    [
      "base: &tg\n  show_reasoning: true\ndisplay:\n  platforms:\n    telegram:\n      <<: *tg\n",
      'YAML merge key "<<" under display.platforms.telegram',
    ],
  ];
  for (const [text, why] of cases) {
    const path = withText(text);

    expect(configureTelegramDisplay()).toEqual([]);

    expect(readFileSync(path, "utf8")).toBe(text);
    expect(logged()).toContain(why);
  }
});
