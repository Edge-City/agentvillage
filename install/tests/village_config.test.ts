/**
 * DATA-314 B1-fix: the two config.yaml keys the proactive jobs depend on.
 *
 *   - F1: Hermes runs cron in `HERMES_TIMEZONE`, then config.yaml `timezone`,
 *     else host-local time; every schedule here is in village time and the
 *     brief delivers only 05:00 to 11:00 IST. The installer writes
 *     `timezone: Asia/Kolkata` when no zone is configured and warns loudly
 *     when another one is.
 *   - F3: the triggers wait 60 s for the lock and stop at 100 s, so
 *     `cron.script_timeout_seconds` must be about 110 s or more.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import {
  COMPRESSION_THRESHOLD,
  CONTEXT_FILE_MAX_CHARS,
  CRON_SCRIPT_TIMEOUT_SECONDS,
  HYGIENE_MAX_TURN_HOLD_SECONDS,
  VILLAGE_TIMEZONE,
  configureCronScriptTimeout,
  configureVillageTimezone,
  setCompactionSettings,
  setCompressionTrigger,
  setContextFileMaxChars,
} from "../config";
import { configureTelegramDisplay } from "../display_defaults";

const ORIGINAL = { HERMES_HOME: process.env.HERMES_HOME, HERMES_TIMEZONE: process.env.HERMES_TIMEZONE };
let home: string;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentvillage-village-config-"));
  process.env.HERMES_HOME = home;
  delete process.env.HERMES_TIMEZONE;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const configPath = () => join(home, "config.yaml");

function withText(text: string): string {
  writeFileSync(configPath(), text);
  return configPath();
}

function withDoc(doc: unknown): string {
  return withText(YAML.stringify(doc));
}

function read(): Record<string, any> {
  return YAML.parse(readFileSync(configPath(), "utf8")) as Record<string, any>;
}

const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");
const warned = () => warnSpy.mock.calls.map((c) => String(c[0])).join("\n");

describe("F1: cron runs in village time", () => {
  test("no zone anywhere: writes timezone: Asia/Kolkata, one log line, nothing else changed", () => {
    withDoc({ model: { default: "m", max_tokens: 4096 }, platforms: { telegram: { extra: { a: 1 } } } });

    configureVillageTimezone();

    expect(read()).toEqual({ model: { default: "m", max_tokens: 4096 }, platforms: { telegram: { extra: { a: 1 } } }, timezone: VILLAGE_TIMEZONE });
    expect(VILLAGE_TIMEZONE).toBe("Asia/Kolkata");
    expect(logSpy.mock.calls).toHaveLength(1);
    expect(logged()).toContain("set timezone: Asia/Kolkata");
    expect(warnSpy.mock.calls).toHaveLength(0);
  });

  test("no config.yaml at all, and Hermes's own empty default, count as no zone", () => {
    configureVillageTimezone();
    expect(read()).toEqual({ timezone: VILLAGE_TIMEZONE });

    withDoc({ timezone: "" });
    configureVillageTimezone();
    expect(read().timezone).toBe(VILLAGE_TIMEZONE);

    withText("timezone:\nstt:\n  enabled: true\n");
    configureVillageTimezone();
    expect(read()).toEqual({ timezone: VILLAGE_TIMEZONE, stt: { enabled: true } });
  });

  test("another zone in config.yaml: left as set, one loud warning naming it", () => {
    const before = YAML.stringify({ timezone: "UTC", stt: { enabled: true } });
    withText(before);

    configureVillageTimezone();

    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(warnSpy.mock.calls).toHaveLength(1);
    expect(warned()).toContain("WARNING");
    expect(warned()).toContain('"UTC"');
    expect(warned()).toContain("wrong village time");
    expect(warned()).toContain("brief will be silent");
  });

  test("another zone in HERMES_TIMEZONE (environment or .env): nothing written, the warning names it", () => {
    withDoc({ stt: { enabled: true } });
    process.env.HERMES_TIMEZONE = "Europe/London";
    configureVillageTimezone();
    expect(read()).toEqual({ stt: { enabled: true } });
    expect(warned()).toContain('HERMES_TIMEZONE is "Europe/London"');

    warnSpy.mockClear();
    delete process.env.HERMES_TIMEZONE;
    writeFileSync(join(home, ".env"), "HERMES_TIMEZONE=America/New_York\n");
    configureVillageTimezone();
    expect(read()).toEqual({ stt: { enabled: true } });
    expect(warned()).toContain('HERMES_TIMEZONE is "America/New_York"');
  });

  test("HERMES_TIMEZONE already the village zone and no key: the key is written too (the multiplexed gateway reads only config.yaml)", () => {
    withDoc({});
    process.env.HERMES_TIMEZONE = "Asia/Kolkata";
    configureVillageTimezone();
    expect(read()).toEqual({ timezone: VILLAGE_TIMEZONE });
    expect(warnSpy.mock.calls).toHaveLength(0);
  });

  test("already the village zone (or its IANA link): no rewrite, no warning; a second run is a no-op", () => {
    for (const zone of ["Asia/Kolkata", "Asia/Calcutta"]) {
      const before = `# hand-kept\ntimezone: ${zone}\n`;
      withText(before);
      configureVillageTimezone();
      expect(readFileSync(configPath(), "utf8")).toBe(before);
    }
    withDoc({});
    configureVillageTimezone();
    const once = readFileSync(configPath(), "utf8");
    configureVillageTimezone();
    expect(readFileSync(configPath(), "utf8")).toBe(once);
    expect(warnSpy.mock.calls).toHaveLength(0);
  });

  test("a non-string zone or an unusable top level is never overwritten", () => {
    withDoc({ timezone: 5 });
    configureVillageTimezone();
    expect(read().timezone).toBe(5);
    expect(warned()).toContain("timezone in config.yaml is 5");

    const merged = "base: &b\n  timezone: UTC\n<<: *b\n";
    withText(merged);
    configureVillageTimezone();
    expect(readFileSync(configPath(), "utf8")).toBe(merged);
    expect(logged()).toContain("merge key");

    withText("- a\n- b\n");
    configureVillageTimezone();
    expect(readFileSync(configPath(), "utf8")).toBe("- a\n- b\n");
  });
});

describe("F3: cron.script_timeout_seconds covers the triggers' budgets", () => {
  test("set to 120 when unset, keeping the other cron keys", () => {
    withDoc({ cron: { catch_up_missed: true } });
    configureCronScriptTimeout();
    expect(read().cron).toEqual({ catch_up_missed: true, script_timeout_seconds: CRON_SCRIPT_TIMEOUT_SECONDS });
    expect(CRON_SCRIPT_TIMEOUT_SECONDS).toBe(120);
    rmSync(configPath());
    configureCronScriptTimeout();
    expect(read().cron.script_timeout_seconds).toBe(120);
  });

  test("Hermes's own default of 3600 written out by a config save counts as unset", () => {
    withDoc({ cron: { script_timeout_seconds: 3600 } });
    configureCronScriptTimeout();
    expect(read().cron.script_timeout_seconds).toBe(120);
  });

  test("a value below 120 is raised; an operator's higher value is kept", () => {
    withDoc({ cron: { script_timeout_seconds: 60 } });
    configureCronScriptTimeout();
    expect(read().cron.script_timeout_seconds).toBe(120);

    const kept = YAML.stringify({ cron: { script_timeout_seconds: 300 } });
    withText(kept);
    configureCronScriptTimeout();
    expect(readFileSync(configPath(), "utf8")).toBe(kept);
  });

  test("a cron section that is not a mapping is left alone", () => {
    withText("cron: nope\n");
    configureCronScriptTimeout();
    expect(readFileSync(configPath(), "utf8")).toBe("cron: nope\n");
  });
});

/**
 * AGENTS-MD-CAP: Hermes truncates each context file at top-level
 * `context_file_max_chars`, else a dynamic cap that is 21,600 on the boxes
 * (context_length pinned at 90,000); rc24 to rc26 lost the middle of AGENTS.md,
 * its red lines included. The installer pins the key to 48,000 (the pre-pin
 * cap), keeping an operator's larger value.
 */
describe("AGENTS-MD-CAP: context_file_max_chars is pinned to at least 48,000", () => {
  // A box's config.yaml shape (fleet read, 2026-10-08): no context_file_max_chars key at all.
  const BOX = { _config_version: 46, model: { default: "m", context_length: 90000 }, cron: { wrap_response: false }, terminal: { cwd: "/h" }, streaming: { enabled: false } };

  test("absent: 48000 written at the end, every other key byte-for-byte in order, one log line", () => {
    const before = YAML.stringify(BOX);
    withText(before);
    setContextFileMaxChars();
    const after = readFileSync(configPath(), "utf8");
    expect(CONTEXT_FILE_MAX_CHARS).toBe(48000);
    expect(after).toBe(`${before}context_file_max_chars: 48000\n`);
    expect(Object.keys(read())).toEqual([...Object.keys(BOX), "context_file_max_chars"]);
    expect(logSpy.mock.calls).toHaveLength(1);
    expect(logged()).toBe("→ set context_file_max_chars: 48000 (was unset; Hermes truncates a longer context file)");

    rmSync(configPath());
    setContextFileMaxChars();
    expect(read()).toEqual({ context_file_max_chars: 48000 });
  });

  test("the boxes' dynamic 21600 written out, or any number below 48000, is raised in place", () => {
    for (const low of [21600, 20000, 47999, 0, -1, 25000.5]) {
      logSpy.mockClear();
      withDoc({ a: 1, context_file_max_chars: low, z: 2 });
      setContextFileMaxChars();
      expect(read()).toEqual({ a: 1, context_file_max_chars: 48000, z: 2 });
      expect(Object.keys(read())).toEqual(["a", "context_file_max_chars", "z"]);
      expect(logged()).toBe(`→ set context_file_max_chars: 48000 (was ${low}, below 48000; Hermes truncates a longer context file)`);
    }
  });

  test("an operator's value of 48000 or more is kept, file untouched, and the log says so", () => {
    for (const kept of [48000, 60000, 120000]) {
      logSpy.mockClear();
      const before = `# hand-kept\nmodel:\n  default: m\ncontext_file_max_chars: ${kept}\n`;
      withText(before);
      setContextFileMaxChars();
      expect(readFileSync(configPath(), "utf8")).toBe(before);
      expect(logSpy.mock.calls).toHaveLength(1);
      expect(logged()).toBe(`→ context_file_max_chars already ${kept} (at least 48000); left as is`);
    }
  });

  test("null (Hermes's documented default) is set", () => {
    withText("context_file_max_chars: null\nstt:\n  enabled: true\n");
    setContextFileMaxChars();
    expect(read()).toEqual({ context_file_max_chars: 48000, stt: { enabled: true } });
    expect(logged()).toContain("was null (Hermes's dynamic cap)");

    logSpy.mockClear();
    withText("context_file_max_chars:\n");
    setContextFileMaxChars();
    expect(read()).toEqual({ context_file_max_chars: 48000 });
    expect(logged()).toContain("was null");
  });

  test("a value Hermes does not read as a number is set, the log naming its kind and never its text", () => {
    const cases: [string, string][] = [
      ['context_file_max_chars: "60000"\n', "was a string, not a number Hermes reads"],
      ["context_file_max_chars: big-secret-ish\n", "was a string, not a number Hermes reads"],
      ["context_file_max_chars: true\n", "was a boolean, not a number Hermes reads"],
      ["context_file_max_chars: .inf\n", "was a non-finite number, not a number Hermes reads"],
      ["context_file_max_chars: [1]\n", "was a list, not a number Hermes reads"],
      ["context_file_max_chars:\n  x: 1\n", "was a mapping, not a number Hermes reads"],
    ];
    for (const [text, why] of cases) {
      logSpy.mockClear();
      withText(text);
      setContextFileMaxChars();
      expect(read()).toEqual({ context_file_max_chars: 48000 });
      expect(logged()).toBe(`→ set context_file_max_chars: 48000 (${why}; Hermes truncates a longer context file)`);
      expect(logged()).not.toContain("big-secret-ish");
      expect(logged()).not.toContain('"60000"');
    }
  });

  test("a top level that is not a mapping, or holds a merge key, is left alone with a warning", () => {
    for (const text of ["- a\n- b\n", "just a string\n", "base: &b\n  context_file_max_chars: 1\n<<: *b\n"]) {
      logSpy.mockClear();
      withText(text);
      setContextFileMaxChars();
      expect(readFileSync(configPath(), "utf8")).toBe(text);
      expect(logSpy.mock.calls).toHaveLength(1);
      expect(logged()).toStartWith("→ warning: ");
      expect(logged()).toContain("left context_file_max_chars unset");
    }
  });

  test("a second run changes nothing (same bytes) and says it is already set", () => {
    withDoc(BOX);
    setContextFileMaxChars();
    const once = readFileSync(configPath(), "utf8");
    logSpy.mockClear();
    setContextFileMaxChars();
    expect(readFileSync(configPath(), "utf8")).toBe(once);
    expect(logged()).toBe("→ context_file_max_chars already 48000 (at least 48000); left as is");
  });

  test("install.ts runs the step with the other config steps, before the gateway restart", () => {
    const text = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
    const main = text.slice(text.indexOf("function main(): void {"));
    const at = (needle: string) => {
      const i = main.indexOf(needle);
      expect([needle, i >= 0, main.indexOf(needle, i + 1)]).toEqual([needle, true, -1]);
      return i;
    };
    const wrap = at("configureCronWrapResponse();");
    const pin = at("setContextFileMaxChars();");
    const restart = at("restartGateway();");
    expect(wrap < pin && pin < restart).toBe(true);
    // A bare statement at main()'s top level (two-space indent, alone on its line): not commented out,
    // not behind an `if`, not inside a block. The line before it is the cron step, also unconditional.
    const body = main.slice(0, main.indexOf("\n}\n"));
    expect(body.match(/^.*setContextFileMaxChars.*$/gm)).toEqual(["  setContextFileMaxChars();"]);
    expect(body).toMatch(/^  configureCronWrapResponse\(\);\n  setContextFileMaxChars\(\);$/m);
  });
});

/**
 * RC28: the deferred-compression notice loop. The gateway holds an arriving
 * message at most `compression.hygiene_max_turn_hold_seconds` (Hermes default
 * 10) for the pre-turn summary; a slower summary sends "Context compression
 * deferred" to the chat and the turn runs uncompressed, again on every message.
 * The installer pins the hold to 25 and turns the summary's reasoning off
 * (`auxiliary.compression.reasoning_effort: none`, on whatever route the box
 * uses). Fix round 1: the Telegram warning switch is never written (refute M1),
 * no explicit route is written (refute S2), and a hold written as a number in a
 * string is read as Hermes reads it (refute N3).
 */
describe("RC28: compaction settings (hold 25, summary reasoning off)", () => {
  const HOLD = "compression.hygiene_max_turn_hold_seconds";
  const EFFORT = "auxiliary.compression.reasoning_effort";
  const SET_EFFORT = `→ set ${EFFORT}: none (the summary runs on the box's main model with reasoning off)`;
  // A box's shape: the control plane's model block, display keys from the Telegram display step, no compression block.
  const BOX = {
    _config_version: 46,
    model: { default: "anthropic/claude-haiku-5.5", provider: "openrouter", context_length: 90000, max_tokens: 4096 },
    display: { show_reasoning: true, platforms: { telegram: { show_reasoning: false, tool_progress: false, streaming: false } } },
    cron: { wrap_response: false },
    context_file_max_chars: 48000,
  };
  const lines = () => logSpy.mock.calls.map((c) => String(c[0]));

  test("a box with neither key: both written, every other key byte-for-byte in order, one line per pin", () => {
    withDoc(BOX);
    setCompactionSettings();
    const doc = read();
    expect(HYGIENE_MAX_TURN_HOLD_SECONDS).toBe(25);
    expect(doc.compression).toEqual({ hygiene_max_turn_hold_seconds: 25 });
    expect(doc.auxiliary).toEqual({ compression: { reasoning_effort: "none" } });
    expect(Object.keys(doc)).toEqual([...Object.keys(BOX), "compression", "auxiliary"]);
    expect(readFileSync(configPath(), "utf8")).toBe(YAML.stringify({ ...BOX, compression: doc.compression, auxiliary: doc.auxiliary }));
    expect(lines()).toEqual([
      `→ set ${HOLD}: 25 (was unset; a summary that lands inside the hold is adopted with no notice)`,
      SET_EFFORT,
    ]);
  });

  test("refute M1: the Telegram warning switch is never written, and a value already there stays as it is", () => {
    withDoc(BOX);
    setCompactionSettings();
    expect(read().display).toEqual(BOX.display);
    for (const value of [true, false]) {
      const display = { platforms: { telegram: { suppress_warning_notifications: value } } };
      withDoc({ display });
      setCompactionSettings();
      expect(read().display).toEqual(display);
    }
    expect(logged()).not.toContain("suppress_warning_notifications");
  });

  test("hold 10 (Hermes's default written out) or any number below 25 is raised in place; the other compression keys stay", () => {
    for (const low of [10, 0, -5, 24.5]) {
      logSpy.mockClear();
      withDoc({ a: 1, compression: { enabled: true, hygiene_max_turn_hold_seconds: low, hygiene_timeout_seconds: 30 }, z: 2 });
      setCompactionSettings();
      expect(read().compression).toEqual({ enabled: true, hygiene_max_turn_hold_seconds: 25, hygiene_timeout_seconds: 30 });
      expect(Object.keys(read()).slice(0, 3)).toEqual(["a", "compression", "z"]);
      expect(lines()[0]).toBe(`→ set ${HOLD}: 25 (was ${low}, below 25; a summary that lands inside the hold is adopted with no notice)`);
    }
  });

  test("an operator's hold of 25 or more is kept, the log says so", () => {
    for (const kept of [25, 60]) {
      logSpy.mockClear();
      withDoc({ compression: { hygiene_max_turn_hold_seconds: kept } });
      setCompactionSettings();
      expect(read().compression).toEqual({ hygiene_max_turn_hold_seconds: kept });
      expect(lines()[0]).toBe(`→ ${HOLD} already ${kept} (at least 25); left as is`);
    }
  });

  test("refute N3: a hold written as a number in a string (Hermes's float() reads it) is kept at 25 or more, raised below", () => {
    for (const [text, n] of [['"45"', 45], ['"25"', 25], ["' 30.5 '", 30.5], ['"1e2"', 100]] as const) {
      logSpy.mockClear();
      const before = `compression:\n  hygiene_max_turn_hold_seconds: ${text}\nauxiliary:\n  compression:\n    reasoning_effort: none\n`;
      withText(before);
      setCompactionSettings();
      expect(readFileSync(configPath(), "utf8")).toBe(before);
      expect(lines()[0]).toBe(`→ ${HOLD} already ${n}, written as a string Hermes reads as a number (at least 25); left as is`);
    }
    logSpy.mockClear();
    withText('compression:\n  hygiene_max_turn_hold_seconds: "10"\n');
    setCompactionSettings();
    expect(read().compression).toEqual({ hygiene_max_turn_hold_seconds: 25 });
    expect(lines()[0]).toBe(`→ set ${HOLD}: 25 (was 10 written as a string, below 25; a summary that lands inside the hold is adopted with no notice)`);
  });

  test("null, true, a word, a list or an empty value is set to the number 25; the log names the kind, never the text", () => {
    const cases: [string, string][] = [
      ["compression:\n  hygiene_max_turn_hold_seconds: secret-ish\n", "was a string, not a number"],
      ['compression:\n  hygiene_max_turn_hold_seconds: "inf"\n', "was a string, not a number"],
      ["compression:\n  hygiene_max_turn_hold_seconds: null\n", "was null"],
      ["compression:\n  hygiene_max_turn_hold_seconds: true\n", "was a boolean, not a number"],
      ["compression:\n  hygiene_max_turn_hold_seconds: [1]\n", "was a list, not a number"],
      ["compression:\n", "was unset"],
    ];
    for (const [text, why] of cases) {
      logSpy.mockClear();
      withText(text);
      setCompactionSettings();
      expect(read().compression).toEqual({ hygiene_max_turn_hold_seconds: 25 });
      expect(lines()[0]).toBe(`→ set ${HOLD}: 25 (${why}; a summary that lands inside the hold is adopted with no notice)`);
      expect(logged()).not.toContain("secret-ish");
    }
  });

  test("compression not a mapping, or holding a merge key: that pin is skipped with a warning, the other still applies", () => {
    for (const [text, kept] of [
      ["compression: off\n", "off"],
      ["compression:\n  - 1\n", [1]],
    ] as const) {
      logSpy.mockClear();
      withText(text);
      setCompactionSettings();
      expect(read().compression).toEqual(kept);
      expect(lines()[0]).toBe(`→ warning: compression is not a mapping; left ${HOLD} unset`);
      expect(read().auxiliary).toEqual({ compression: { reasoning_effort: "none" } });
    }
    logSpy.mockClear();
    withText("base: &b\n  hygiene_max_turn_hold_seconds: 5\ncompression:\n  <<: *b\n");
    setCompactionSettings();
    expect(lines()[0]).toBe(`→ warning: YAML merge key "<<" under compression; set it by hand; left ${HOLD} unset`);
    expect(read().compression).toEqual({ "<<": { hygiene_max_turn_hold_seconds: 5 } });
  });

  test("refute S2: only reasoning_effort is written; provider, model and every other key of the block stay as they are", () => {
    // Hermes's own default block, written out by a config save.
    const route = { provider: "auto", model: "", base_url: "", api_key: "", timeout: 120, extra_body: {}, reasoning_effort: "", no_progress_timeout: null };
    withDoc({ model: BOX.model, auxiliary: { vision: { provider: "auto" }, compression: route } });
    setCompactionSettings();
    expect(read().auxiliary).toEqual({ vision: { provider: "auto" }, compression: { ...route, reasoning_effort: "none" } });
    expect(Object.keys(read().auxiliary.compression)).toEqual(Object.keys(route));
    expect(lines()[1]).toBe(SET_EFFORT);

    // An explicit route an operator set (base_url and key included) is left alone; the key is added.
    logSpy.mockClear();
    const explicit = { provider: "openrouter", model: "google/gemini-3.5-flash", base_url: "https://example.invalid/v1", key_env: "X_KEY" };
    withDoc({ model: BOX.model, auxiliary: { compression: explicit } });
    setCompactionSettings();
    expect(read().auxiliary.compression).toEqual({ ...explicit, reasoning_effort: "none" });
  });

  test("an existing reasoning_effort is kept, whatever it is; the file is not rewritten", () => {
    for (const value of ["low", "none", false, "high"]) {
      logSpy.mockClear();
      const text = YAML.stringify({ compression: { hygiene_max_turn_hold_seconds: 25 }, auxiliary: { compression: { reasoning_effort: value } } });
      withText(text);
      setCompactionSettings();
      expect(readFileSync(configPath(), "utf8")).toBe(text);
      expect(lines()[1]).toBe(`→ ${EFFORT} already set; left as is`);
    }
  });

  test("null or blank reasoning_effort counts as unset", () => {
    for (const text of ["auxiliary:\n  compression:\n    reasoning_effort: null\n", 'auxiliary:\n  compression:\n    reasoning_effort: "  "\n', "auxiliary:\n  compression:\n"]) {
      withText(text);
      setCompactionSettings();
      expect(read().auxiliary.compression).toEqual({ reasoning_effort: "none" });
    }
  });

  test("auxiliary or auxiliary.compression not a mapping, or holding a merge key, is left alone with a warning", () => {
    for (const [aux, why] of [["off", "auxiliary is not a mapping"], [{ compression: "fast" }, "auxiliary.compression is not a mapping"]] as const) {
      logSpy.mockClear();
      withDoc({ model: BOX.model, auxiliary: aux });
      setCompactionSettings();
      expect(read().auxiliary).toEqual(aux);
      expect(lines()[1]).toBe(`→ warning: ${why}; left ${EFFORT} unset`);
    }
    logSpy.mockClear();
    withText("r: &r\n  reasoning_effort: low\nauxiliary:\n  compression:\n    <<: *r\n");
    setCompactionSettings();
    expect(lines()[1]).toBe(`→ warning: YAML merge key "<<" under auxiliary.compression; set it by hand; left ${EFFORT} unset`);
  });

  test("the Telegram display step and this step run in sequence without undoing each other", () => {
    withDoc(BOX);
    setCompactionSettings();
    configureTelegramDisplay();
    const once = readFileSync(configPath(), "utf8");
    setCompactionSettings();
    configureTelegramDisplay();
    expect(readFileSync(configPath(), "utf8")).toBe(once);
    // rc29 (DATA-434): BOX's `tool_progress: false` is kept (rc28 turned it into `new`).
    expect(read().display.platforms.telegram.tool_progress).toBe(false);
    expect(read().display.tool_progress_command).toBe(true);
    expect(read().compression).toEqual({ hygiene_max_turn_hold_seconds: 25 });
  });

  test("a second run changes nothing (same bytes), says so in one line per pin, and does not rewrite the file", () => {
    withDoc(BOX);
    setCompactionSettings();
    const once = readFileSync(configPath(), "utf8");
    logSpy.mockClear();
    writeFileSync(configPath(), `# marker comment survives only if the file is not rewritten\n${once}`);
    setCompactionSettings();
    expect(readFileSync(configPath(), "utf8")).toBe(`# marker comment survives only if the file is not rewritten\n${once}`);
    expect(lines()).toEqual([`→ ${HOLD} already 25 (at least 25); left as is`, `→ ${EFFORT} already set; left as is`]);
  });

  test("no config.yaml at all: both keys written", () => {
    setCompactionSettings();
    expect(read()).toEqual({ compression: { hygiene_max_turn_hold_seconds: 25 }, auxiliary: { compression: { reasoning_effort: "none" } } });
  });

  test("a top level that is not a mapping, or holds a merge key, is left alone with one warning", () => {
    for (const text of ["- a\n- b\n", "just a string\n", "base: &b\n  compression: {}\n<<: *b\n"]) {
      logSpy.mockClear();
      withText(text);
      setCompactionSettings();
      expect(readFileSync(configPath(), "utf8")).toBe(text);
      expect(logSpy.mock.calls).toHaveLength(1);
      expect(logged()).toStartWith("→ warning: ");
      expect(logged()).toContain("left the compaction settings unset");
    }
  });

  test("install.ts runs the step right after the context-file cap, before the display step and the restart", () => {
    const text = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
    const main = text.slice(text.indexOf("function main(): void {"));
    const at = (needle: string) => {
      const i = main.indexOf(needle);
      expect([needle, i >= 0, main.indexOf(needle, i + 1)]).toEqual([needle, true, -1]);
      return i;
    };
    const cap = at("setContextFileMaxChars();");
    const step = at("setCompactionSettings();");
    const display = at("configureTelegramDisplay();");
    const restart = at("restartGateway();");
    expect(cap < step && step < display && display < restart).toBe(true);
    const body = main.slice(0, main.indexOf("\n}\n"));
    expect(body.match(/^.*setCompactionSettings.*$/gm)).toEqual(["  setCompactionSettings();"]);
    expect(body).toMatch(/^  setContextFileMaxChars\(\);\n  setCompactionSettings\(\);$/m);
  });
});


/**
 * RC42 COMPRESSION TRIGGER (Carter, CLAIMS L7597 and L7607): the box context
 * pin becomes 1,000,000 and compaction must stay at 75% of it. Hermes keeps 75%
 * on its own only below 512K and caps the trigger at 256,000 tokens, so the
 * installer writes `compression.threshold: 0.75` and
 * `compression.threshold_tokens: null`: the trigger then reads only
 * `model.context_length`, the key the control plane pins. Nothing else under
 * `compression` is written (`protect_last_n` and the tool-result prune stay
 * Hermes's).
 */
describe("RC42: compression trigger at 75% of the pin (ratio 0.75, no token cap)", () => {
  const RATIO = "compression.threshold";
  const CAP = "compression.threshold_tokens";
  const SET_RATIO = (why: string) => `→ set ${RATIO}: 0.75 (${why}; Hermes compacts at 75% of model.context_length, the control plane's pin)`;
  const SET_CAP = (why: string) => `→ set ${CAP}: null (${why}; a token cap stops the trigger following the pin)`;
  const TUNED = { threshold: 0.75, threshold_tokens: null };
  // A box's shape after the RC28 step: the control plane's model block and the turn hold, nothing else under compression.
  const BOX = {
    _config_version: 46,
    model: { default: "anthropic/claude-haiku-5.5", provider: "openrouter", context_length: 90000, max_tokens: 4096 },
    cron: { wrap_response: false },
    context_file_max_chars: 48000,
    compression: { hygiene_max_turn_hold_seconds: 25 },
    auxiliary: { compression: { reasoning_effort: "none" } },
  };
  // Hermes v2026.9.24's own compression block written out by a config save (hermes_cli/config_defaults.py, trimmed).
  const HERMES_BLOCK = {
    enabled: true, threshold: 0.5, threshold_tokens: 256000, target_ratio: 0.2, tail_mode: "lean", protect_last_n: 20,
    max_attempts: 3, proactive_prune_tokens: 0, proactive_prune_min_result_chars: 8000, proactive_prune_min_reclaim_tokens: 4096,
    hygiene_max_turn_hold_seconds: 10, protect_first_n: 3, model_thresholds: {},
  };
  const lines = () => logSpy.mock.calls.map((c) => String(c[0]));

  test("a box's shape: the two keys added after the hold, every other key byte-for-byte in order, one line per key", () => {
    withDoc(BOX);
    setCompressionTrigger();
    expect(COMPRESSION_THRESHOLD).toBe(0.75);
    const doc = read();
    expect(doc.compression).toEqual({ hygiene_max_turn_hold_seconds: 25, ...TUNED });
    expect(Object.keys(doc.compression)).toEqual(["hygiene_max_turn_hold_seconds", "threshold", "threshold_tokens"]);
    expect(readFileSync(configPath(), "utf8")).toBe(YAML.stringify({ ...BOX, compression: doc.compression }));
    expect(readFileSync(configPath(), "utf8")).toContain("  threshold_tokens: null\n");
    expect(lines()).toEqual([SET_RATIO("was unset"), SET_CAP("was unset, Hermes's default cap 256,000")]);
  });

  test("the pin is never read or written: model.context_length stays the control plane's, and the block is the same at any pin", () => {
    const blocks = [];
    for (const context_length of [90000, 128000, 1000000, undefined]) {
      const model: Record<string, unknown> = { ...BOX.model, context_length };
      if (context_length === undefined) delete model.context_length;
      withDoc({ ...BOX, model });
      setCompressionTrigger();
      expect(read().model).toEqual(model);
      blocks.push(read().compression);
    }
    expect(blocks).toEqual(Array(4).fill({ hygiene_max_turn_hold_seconds: 25, ...TUNED }));
  });

  test("no absolute token number is written: Hermes's 256,000 written out is cleared, and every other key (protect_last_n, the prune) stays", () => {
    withDoc({ model: BOX.model, compression: HERMES_BLOCK });
    setCompressionTrigger();
    const compression = read().compression;
    expect(compression).toEqual({ ...HERMES_BLOCK, ...TUNED });
    expect(Object.keys(compression)).toEqual(Object.keys(HERMES_BLOCK));
    expect(compression.protect_last_n).toBe(20);
    expect(compression.proactive_prune_tokens).toBe(0);
    expect(lines()).toEqual([SET_RATIO("was 0.5, below 0.75"), SET_CAP("was 256000")]);
  });

  test("on a box with no compression keys beyond the hold, only threshold and threshold_tokens are ever added", () => {
    withDoc(BOX);
    setCompressionTrigger();
    setCompressionTrigger();
    expect(Object.keys(read().compression).sort()).toEqual(["hygiene_max_turn_hold_seconds", "threshold", "threshold_tokens"]);
    expect(logged()).not.toContain("protect_last_n");
    expect(logged()).not.toContain("proactive_prune");
  });

  test("an operator's later trigger (0.75 to 1, or one written as a string) is kept", () => {
    for (const [text, n] of [["0.75", 0.75], ["0.85", 0.85], ["1", 1], ['"0.9"', 0.9]] as const) {
      logSpy.mockClear();
      const before = `compression:\n  threshold: ${text}\n  threshold_tokens: null\n`;
      withText(before);
      setCompressionTrigger();
      expect(readFileSync(configPath(), "utf8")).toBe(before);
      const how = text.startsWith('"') ? ", written as a string Hermes reads as a number" : "";
      expect(lines()[0]).toBe(`→ ${RATIO} already ${n}${how} (from 0.75 to 1); left as is`);
    }
  });

  test("a ratio below 0.75, above 1, or not a number Hermes reads is set to 0.75; the log never echoes the text", () => {
    const cases: [string, string][] = [
      ["0.5", "was 0.5, below 0.75"],
      ["0", "was 0, below 0.75"],
      ["-0.8", "was -0.8, below 0.75"],
      ["1.5", "was 1.5, above 1"],
      ['"0.6"', "was 0.6 written as a string, below 0.75"],
      [".inf", "was a non-finite number, not a number"],
      ["secret-ish", "was a string, not a number"],
      ["true", "was a boolean, not a number"],
      ["{a: 1}", "was a mapping, not a number"],
      ["null", "was null"],
    ];
    for (const [text, why] of cases) {
      logSpy.mockClear();
      withText(`compression:\n  threshold: ${text}\n`);
      setCompressionTrigger();
      expect(read().compression).toEqual(TUNED);
      expect(lines()[0]).toBe(SET_RATIO(why));
      expect(logged()).not.toContain("secret-ish");
    }
  });

  test("any token cap is cleared to null, whatever it is; null is kept", () => {
    for (const [text, why] of [["256000", "was 256000"], ["750000", "was 750000"], ["0", "was 0"], ["secret-ish", "was a string"], ["[1]", "was a list"]] as const) {
      logSpy.mockClear();
      withText(`compression:\n  threshold_tokens: ${text}\n`);
      setCompressionTrigger();
      expect(read().compression).toEqual({ threshold_tokens: null, threshold: 0.75 });
      expect(lines()[1]).toBe(SET_CAP(why));
      expect(logged()).not.toContain("secret-ish");
    }
    logSpy.mockClear();
    withText("compression:\n  threshold: 0.75\n  threshold_tokens: null\n");
    setCompressionTrigger();
    expect(lines()[1]).toBe(`→ ${CAP} already null (no token cap; the trigger follows the pin); left as is`);
  });

  test("a second run changes nothing (same bytes), says so in one line per key, and does not rewrite the file", () => {
    withDoc(BOX);
    setCompressionTrigger();
    const once = readFileSync(configPath(), "utf8");
    logSpy.mockClear();
    writeFileSync(configPath(), `# marker comment survives only if the file is not rewritten\n${once}`);
    setCompressionTrigger();
    expect(readFileSync(configPath(), "utf8")).toBe(`# marker comment survives only if the file is not rewritten\n${once}`);
    expect(lines()).toEqual([
      `→ ${RATIO} already 0.75 (from 0.75 to 1); left as is`,
      `→ ${CAP} already null (no token cap; the trigger follows the pin); left as is`,
    ]);
  });

  test("the RC28 step and this step run in sequence, in either order, without undoing each other", () => {
    withDoc({ model: BOX.model });
    setCompactionSettings();
    setCompressionTrigger();
    const once = readFileSync(configPath(), "utf8");
    setCompressionTrigger();
    setCompactionSettings();
    expect(readFileSync(configPath(), "utf8")).toBe(once);
    expect(read().compression).toEqual({ hygiene_max_turn_hold_seconds: 25, ...TUNED });
  });

  test("no config.yaml at all: the two keys written", () => {
    setCompressionTrigger();
    expect(read()).toEqual({ compression: TUNED });
  });

  test("compression not a mapping, or holding a merge key, and a bad top level: nothing written, one warning", () => {
    for (const [text, why] of [
      ["compression: off\n", "compression is not a mapping"],
      ["compression:\n  - 1\n", "compression is not a mapping"],
      ["base: &b\n  threshold: 0.5\ncompression:\n  <<: *b\n", 'YAML merge key "<<" under compression; set them by hand'],
    ] as const) {
      logSpy.mockClear();
      withText(text);
      setCompressionTrigger();
      expect(readFileSync(configPath(), "utf8")).toBe(text);
      expect(lines()).toEqual([`→ warning: ${why}; left ${RATIO} and ${CAP} unset`]);
    }
    for (const text of ["- a\n- b\n", "just a string\n", "base: &b\n  compression: {}\n<<: *b\n"]) {
      logSpy.mockClear();
      withText(text);
      setCompressionTrigger();
      expect(readFileSync(configPath(), "utf8")).toBe(text);
      expect(logSpy.mock.calls).toHaveLength(1);
      expect(logged()).toStartWith("→ warning: ");
      expect(logged()).toContain("left the compression trigger unset");
    }
  });

  test("install.ts runs the step once, right after the RC28 compaction step, before the display step and the restart", () => {
    const text = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
    const main = text.slice(text.indexOf("function main(): void {"));
    const body = main.slice(0, main.indexOf("\n}\n"));
    expect(body.match(/^.*setCompressionTrigger.*$/gm)).toEqual(["  setCompressionTrigger();"]);
    expect(body).toMatch(/^  setCompactionSettings\(\);\n  setCompressionTrigger\(\);\n  configureTelegramDisplay\(\);$/m);
    expect(main.indexOf("setCompressionTrigger();")).toBeLessThan(main.indexOf("restartGateway();"));
  });

  test("the installer source holds no context-pin or trigger token number in code (90k, 67,500, 750k, 1M)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "config.ts"), "utf8");
    // Code only: drop block and line comments before looking for the numbers.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const n of ["90000", "90_000", "67500", "67_500", "64428", "750000", "750_000", "1000000", "1_000_000", "256000", "256_000"]) {
      expect([n, code.includes(n)]).toEqual([n, false]);
    }
  });

  // Every key this step writes, and the numbers it relies on, exist in the Hermes the overlay pins (local
  // reference checkout; skipped where it is absent, as in CI).
  const HERMES_REF = "/Users/carter/dev/hermes-agent-ref-v2026.9.24";
  test.skipIf(!existsSync(join(HERMES_REF, "agent/context_compressor.py")))("Hermes v2026.9.24 has these keys and constants", () => {
    const defaults = readFileSync(join(HERMES_REF, "hermes_cli/config_defaults.py"), "utf8");
    expect(defaults).toContain('"threshold": 0.50,');
    expect(defaults).toContain('"threshold_tokens": 256_000,');
    const compressor = readFileSync(join(HERMES_REF, "agent/context_compressor.py"), "utf8");
    expect(compressor).toContain(`_SMALL_CTX_THRESHOLD_PERCENT = ${COMPRESSION_THRESHOLD}\n`);
    expect(compressor).toContain("_SMALL_CTX_WINDOW_LIMIT = 512_000\n");
    const init = readFileSync(join(HERMES_REF, "agent/agent_init.py"), "utf8");
    expect(init).toContain("Explicit null is the ratio-only opt-out and stays None.");
    expect(init).toContain('threshold = float(cfg.get("threshold", 0.50))');
  });
});
