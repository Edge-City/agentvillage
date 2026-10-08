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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import {
  CONTEXT_FILE_MAX_CHARS,
  CRON_SCRIPT_TIMEOUT_SECONDS,
  VILLAGE_TIMEZONE,
  configureCronScriptTimeout,
  configureVillageTimezone,
  setContextFileMaxChars,
} from "../config";

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
