import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { DISPLAY_DEFAULTS_ENV, TELEGRAM_DISPLAY_DEFAULTS, configureTelegramDisplay } from "../display_defaults";

// DATA-318: residents never see reasoning on Telegram. RC28 (Carter, Oct 9): the tool-progress
// bubble is back (`new`; DATA-409's `off` was history) and /verbose is enabled so each resident can
// switch it; rc29 (DATA-434) keeps a resident's `off`. Telegram-scoped keys, plus the gateway-wide
// /verbose gate under `display`.

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

/** The /verbose gate this step writes at the `display` level. */
const GATE = { tool_progress_command: true };
/** Every key a first run writes, as configureTelegramDisplay returns them. */
const ALL_KEYS = [...Object.keys(APPLIED), ...Object.keys(GATE)].sort();

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

  expect(configureTelegramDisplay().sort()).toEqual(ALL_KEYS);

  expect(read(path)).toEqual({ display: { platforms: { telegram: APPLIED }, ...GATE } });
  expect(Object.keys(read(path).display as object)).toEqual(["platforms", "tool_progress_command"]);
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
  // The CLI / desktop surfaces keep Hermes's defaults; the only global key written is the /verbose gate, appended.
  expect(globals).toEqual({ ...defaultGlobals, ...GATE });
  expect(Object.keys(doc.display as object)).toEqual([...Object.keys(HERMES_DEFAULT_DISPLAY), "tool_progress_command"]);
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

  expect(configureTelegramDisplay()).toEqual(["show_reasoning", "tool_progress_command"]);

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

    expect(configureTelegramDisplay()).toEqual(["show_reasoning", "tool_progress_command"]);

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

// Hermes v2026.9.24 (`gateway/display_config.py`, `_configured_display_value`) reads the legacy map
// only when it is a dict and its entry for the platform is not None; a null entry or a null map
// falls through to `display.tool_progress` (`all` in Hermes's template). So a null legacy value is
// no hand-set choice: `tool_progress` is written, and the legacy key itself is left as it was.
test("a null legacy tool_progress_overrides (or a null entry for telegram) is unset: tool_progress is written", () => {
  const cases: Array<[string, unknown]> = [
    ["display:\n  tool_progress: all\n  tool_progress_overrides:\n    telegram: ~\n", { telegram: null }],
    ["display:\n  tool_progress: all\n  tool_progress_overrides: null\n", null],
  ];
  for (const [text, legacy] of cases) {
    const path = withText(text);

    expect(configureTelegramDisplay().sort()).toEqual(ALL_KEYS);

    expect(telegramOf(path)).toEqual(APPLIED);
    expect(displayOf(path).tool_progress_overrides).toEqual(legacy);
    expect(displayOf(path).tool_progress).toBe("all");
  }
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
    "  tool_progress_command: true   # /verbose on",
    "",
  ].join("\n");
  const path2 = withText(commented);
  expect(configureTelegramDisplay()).toEqual([]);
  expect(readFileSync(path2, "utf8")).toBe(commented);
});

test("rc29 (DATA-434): tool_progress hermesDefaults is empty, so only absent or null counts as unset", () => {
  expect(TELEGRAM_DISPLAY_DEFAULTS.find((k) => k.key === "tool_progress")).toEqual({
    key: "tool_progress",
    value: "new",
    policy: "unset",
    hermesDefaults: [],
  });
});

test("rc29 (DATA-434): a resident's /verbose off is kept, as the string or the boolean, and the file is not rewritten", () => {
  // As Hermes's writer saves it (double-quoted), as rc28's writer left it (bare), single-quoted,
  // and the boolean an older Hermes save left (rc28 turned those back into `new`).
  for (const [kept, text] of [
    ["off", 'display:\n  tool_progress_command: true\n  platforms:\n    telegram:\n      tool_progress: "off"\n'],
    ["off", "display:\n  tool_progress_command: true\n  platforms:\n    telegram:\n      tool_progress: off\n"],
    ["off", "display:\n  tool_progress_command: true\n  platforms:\n    telegram:\n      tool_progress: 'off'\n"],
    [false, "display:\n  tool_progress_command: true\n  platforms:\n    telegram:\n      tool_progress: false\n"],
  ] as const) {
    logSpy.mockClear();
    const path = withText(text);
    expect([kept, configureTelegramDisplay().includes("tool_progress")]).toEqual([kept, false]);
    expect(telegramOf(path).tool_progress).toBe(kept);
    expect(logged()).toContain("kept as set by hand: tool_progress");
  }
});

test("rc29 (DATA-434): when the step rewrites config.yaml around a resident's off, off is written double-quoted and PyYAML (YAML 1.1) reads the string", () => {
  const path = withText('display:\n  platforms:\n    telegram:\n      tool_progress: "off"\n');
  expect(configureTelegramDisplay().sort()).toEqual(ALL_KEYS.filter((k) => k !== "tool_progress"));
  const text = readFileSync(path, "utf8");
  expect(text).toContain('\n      tool_progress: "off"\n');
  const asHermes = YAML.parse(text, { version: "1.1" }) as { display: { platforms: { telegram: Record<string, unknown> } } };
  expect(asHermes.display.platforms.telegram.tool_progress).toBe("off");
  expect(configureTelegramDisplay()).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(text);
});

test("RC28: tool_progress absent or null becomes new; the modes a resident can choose are kept", () => {
  for (const unset of [undefined, null]) {
    logSpy.mockClear();
    const path = withDoc({ display: { ...GATE, platforms: { telegram: { ...APPLIED, tool_progress: unset } } } });
    expect(configureTelegramDisplay()).toEqual(["tool_progress"]);
    expect(telegramOf(path)).toEqual(APPLIED);
    expect(logged()).toBe("→ telegram display: tool_progress=new");
  }

  // The modes a resident can cycle to with /verbose, and other hand edits, are kept.
  for (const chosen of ["off", false, "all", "verbose", "log", "New", true]) {
    logSpy.mockClear();
    const kept = withDoc({ display: { ...GATE, platforms: { telegram: { ...APPLIED, tool_progress: chosen } } } });
    const before = readFileSync(kept, "utf8");
    expect(configureTelegramDisplay()).toEqual([]);
    expect(readFileSync(kept, "utf8")).toBe(before);
    expect(logged()).toBe("→ telegram display settings already in place (kept as set by hand: tool_progress)");
  }

  // `new` already there: nothing written.
  logSpy.mockClear();
  const already = withDoc({ display: { ...GATE, platforms: { telegram: APPLIED } } });
  const bytes = readFileSync(already, "utf8");
  expect(configureTelegramDisplay()).toEqual([]);
  expect(readFileSync(already, "utf8")).toBe(bytes);
  expect(logged()).toBe("→ telegram display settings already in place");

  // Absent: written.
  const absent = withDoc({ display: { ...GATE, platforms: { telegram: { show_reasoning: false } } } });
  expect(configureTelegramDisplay().sort()).toEqual(Object.keys(APPLIED).filter((k) => k !== "show_reasoning").sort());
  expect(telegramOf(absent).tool_progress).toBe("new");

  // A legacy per-platform override still counts as hand-set, even over an absent tool_progress.
  const { tool_progress: _absent, ...withoutToolProgress } = APPLIED;
  const legacy = withDoc({ display: { ...GATE, tool_progress_overrides: { telegram: "all" }, platforms: { telegram: withoutToolProgress } } });
  expect(configureTelegramDisplay()).toEqual([]);
  expect(telegramOf(legacy).tool_progress).toBeUndefined();
});

test("RC28: display.tool_progress_command (the /verbose gate) is written when unset and kept otherwise", () => {
  for (const unset of [undefined, null]) {
    logSpy.mockClear();
    const path = withDoc({ display: { show_reasoning: true, tool_progress_command: unset, platforms: { telegram: APPLIED } } });
    expect(configureTelegramDisplay()).toEqual(["tool_progress_command"]);
    expect(displayOf(path)).toEqual({ show_reasoning: true, tool_progress_command: true, platforms: { telegram: APPLIED } });
    expect(logged()).toBe("→ telegram display: tool_progress_command=true");
  }
  for (const chosen of [false, "yes"]) {
    logSpy.mockClear();
    const path = withDoc({ display: { tool_progress_command: chosen, platforms: { telegram: APPLIED } } });
    const before = readFileSync(path, "utf8");
    expect(configureTelegramDisplay()).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(logged()).toBe("→ telegram display settings already in place (kept as set by hand: tool_progress_command)");
  }
  // Both levels in one write, one log line.
  logSpy.mockClear();
  const path = withDoc({ display: { platforms: { telegram: { ...APPLIED, tool_progress: null } } } });
  expect(configureTelegramDisplay()).toEqual(["tool_progress", "tool_progress_command"]);
  expect(logSpy.mock.calls).toHaveLength(1);
  expect(logged()).toBe("→ telegram display: tool_progress=new, tool_progress_command=true");
});

test("RC28: no value this step writes is a YAML 1.1 boolean word, so PyYAML reads back what was written", () => {
  const path = freshHome();
  configureTelegramDisplay();
  const text = readFileSync(path, "utf8");
  for (const word of ["off", "on", "yes", "no", "y", "n", "Off", "On", "Yes", "No", "OFF", "ON", "YES", "NO", "Y", "N"]) {
    expect([word, new RegExp(`: ${word}$`, "m").test(text)]).toEqual([word, false]);
  }
  const second = configureTelegramDisplay();
  expect(second).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(text);
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
    // Neither the Telegram keys nor the /verbose gate.
    expect(displayOf(path).tool_progress_command).toBeUndefined();
    expect(telegramOf(path).tool_progress).toBeUndefined();
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

// chmod cannot deny root, so the case only holds for a non-root user (GitHub's ubuntu runner is one).
test.skipIf(process.getuid?.() === 0)(
  "an unreadable $HERMES_HOME/.env (permission denied) does not stop the roll: the quiet settings are applied with a warning",
  () => {
    const path = withDoc({ display: HERMES_DEFAULT_DISPLAY });
    const dotenv = join(process.env.HERMES_HOME!, ".env");
    writeFileSync(dotenv, `${DISPLAY_DEFAULTS_ENV}=0\n`);
    chmodSync(dotenv, 0o000);
    try {
      expect(() => readFileSync(dotenv, "utf8")).toThrow(/EACCES/); // the precondition holds

      expect(configureTelegramDisplay().sort()).toEqual(ALL_KEYS);

      expect(telegramOf(path)).toEqual(APPLIED);
      expect(logged()).toContain(`could not read ${DISPLAY_DEFAULTS_ENV} from $HERMES_HOME/.env`);
    } finally {
      chmodSync(dotenv, 0o600);
    }
  },
);

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
