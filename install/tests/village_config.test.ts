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
  CRON_SCRIPT_TIMEOUT_SECONDS,
  VILLAGE_TIMEZONE,
  configureCronScriptTimeout,
  configureVillageTimezone,
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
