/**
 * DATA-373: cron deliveries carry no Hermes "Cronjob Response" wrapper.
 *
 *   - AC #1: `configureCronWrapResponse` writes `cron.wrap_response: false`,
 *     is idempotent, and leaves the other `cron.*` keys alone. install.ts and
 *     the standalone reconcile run it (their spawned runs are checked in
 *     reconcile_digest_crons.test.ts, F9 and R1).
 *   - AC #2: every delivering prompt ends with its own manage line, verbatim;
 *     the prompts that never deliver carry none.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { configureCronScriptTimeout, configureCronWrapResponse } from "../config";
import { DIGEST_CRON_SPECS, type DigestCronSpec } from "../install_index";

const ORIGINAL_HOME = process.env.HERMES_HOME;
let home: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentvillage-cron-wrapper-"));
  process.env.HERMES_HOME = home;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  if (ORIGINAL_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = ORIGINAL_HOME;
  rmSync(home, { recursive: true, force: true });
});

const configPath = () => join(home, "config.yaml");
const withText = (text: string) => writeFileSync(configPath(), text);
const withDoc = (doc: unknown) => withText(YAML.stringify(doc));
const read = (): Record<string, any> => YAML.parse(readFileSync(configPath(), "utf8"));
const logged = () => logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");

describe("AC #1: cron.wrap_response is false after the installer step", () => {
  test("written when there is no config file, and when cron is absent", () => {
    configureCronWrapResponse();
    expect(read()).toEqual({ cron: { wrap_response: false } });

    withDoc({ model: { max_tokens: 4096 } });
    configureCronWrapResponse();
    expect(read()).toEqual({ model: { max_tokens: 4096 }, cron: { wrap_response: false } });
  });

  test("the other cron keys and the rest of the file are left as they are", () => {
    withDoc({ timezone: "Asia/Kolkata", cron: { catch_up_missed: true, script_timeout_seconds: 300 } });
    configureCronWrapResponse();
    expect(read()).toEqual({
      timezone: "Asia/Kolkata",
      cron: { catch_up_missed: true, script_timeout_seconds: 300, wrap_response: false },
    });
  });

  test("idempotent: a second run leaves the file byte for byte and says so", () => {
    withDoc({ cron: { catch_up_missed: true } });
    configureCronWrapResponse();
    const first = readFileSync(configPath(), "utf8");
    const mtime = statSync(configPath()).mtimeMs;
    configureCronWrapResponse();
    expect(readFileSync(configPath(), "utf8")).toBe(first);
    expect(statSync(configPath()).mtimeMs).toBe(mtime);
    expect(logged()).toContain("cron.wrap_response already false; left as is");
  });

  test("Hermes wraps on anything but false: true (its default, as a config save writes it) and a stray string become false", () => {
    withDoc({ cron: { wrap_response: true } });
    configureCronWrapResponse();
    expect(read().cron.wrap_response).toBe(false);

    withText("cron:\n  wrap_response: 'false'\n");
    configureCronWrapResponse();
    expect(read().cron.wrap_response).toBe(false);

    withText("cron:\n  wrap_response: null\n");
    configureCronWrapResponse();
    expect(read().cron.wrap_response).toBe(false);
  });

  test("a YAML False written by Hermes counts as false and is not rewritten", () => {
    const text = "cron:\n  wrap_response: False\n";
    withText(text);
    configureCronWrapResponse();
    expect(readFileSync(configPath(), "utf8")).toBe(text);
  });

  test("a cron section that is not a mapping is left alone", () => {
    withText("cron: nope\n");
    configureCronWrapResponse();
    expect(readFileSync(configPath(), "utf8")).toBe("cron: nope\n");
    withText("cron:\n  - a\n");
    configureCronWrapResponse();
    expect(readFileSync(configPath(), "utf8")).toBe("cron:\n  - a\n");
    expect(logged()).toContain("left cron.wrap_response unset");
  });

  test("with the script timeout step, in install.ts order, both keys land and neither undoes the other", () => {
    withDoc({ cron: { catch_up_missed: true } });
    configureCronScriptTimeout();
    configureCronWrapResponse();
    configureCronScriptTimeout();
    configureCronWrapResponse();
    expect(read().cron).toEqual({ catch_up_missed: true, script_timeout_seconds: 120, wrap_response: false });
  });

  test("install.ts runs it right after the script timeout step; the standalone reconcile runs it before reconciling", () => {
    // install.ts runs main() on import, so its order is pinned on the source.
    const install = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
    const main = install.slice(install.indexOf("function main(): void {"));
    expect(main).toContain("  configureCronScriptTimeout();\n  configureCronWrapResponse();\n");
    const reconcile = readFileSync(join(import.meta.dir, "..", "reconcile_digest_crons.ts"), "utf8");
    const call = reconcile.indexOf("\nconfigureCronWrapResponse();\n");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(reconcile.indexOf("reconcileDigestCronJobs(hermesExecEnv())"));
  });
});

const SKILLS = join(import.meta.dir, "..", "..", "skills");
const PROMPTS_DIR = join(SKILLS, "index-network", "prompts");
const MANAGE_TAIL = " message - you can ask me to stop or manage it)";
const manageLine = (label: string) => `(${label}${MANAGE_TAIL}`;

/**
 * Every prompt file under skills/index-network/prompts and its label, or null
 * for a prompt that never delivers. A new prompt file fails the first test
 * until it is added here.
 */
const PROMPT_LABELS: Record<string, string | null> = {
  "brief.md": "Daily digest",
  "negotiation-summary.md": "Conversation update",
  "ask-questions.md": "Evening questions",
  // Both opportunity drops (midday and evening) share this file and its label.
  "opportunity-drop.md": "Introduction suggestion",
  // The 01:00 sync: silent, deliver false.
  "memory-signals.md": null,
};

/**
 * Jobs that deliver to the resident with no manage line yet. The token usage
 * audit (inline prompt) was outside DATA-373's five; its label is Carter's
 * call. Listed so that a new delivering job fails until someone decides.
 */
const DELIVERING_WITHOUT_LINE = new Set(["Edge — token usage audit"]);

function promptText(spec: DigestCronSpec): string {
  return spec.promptFile ? readFileSync(join(SKILLS, spec.promptFile), "utf8") : spec.promptBody ?? "";
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1];
}

describe("AC #2: each delivering prompt ends with its own manage line", () => {
  test("the table covers every prompt file", () => {
    const files = readdirSync(PROMPTS_DIR).filter((name) => name.endsWith(".md")).sort();
    expect(files).toEqual(Object.keys(PROMPT_LABELS).sort());
  });

  for (const [file, label] of Object.entries(PROMPT_LABELS)) {
    test(`${file}: ${label === null ? "no manage line (never delivers)" : `ends with "${manageLine(label)}"`}`, () => {
      const text = readFileSync(join(PROMPTS_DIR, file), "utf8");
      if (label === null) {
        expect(text).not.toContain(MANAGE_TAIL);
        expect(text).not.toContain("stop or manage");
        return;
      }
      expect(lastLine(text)).toBe(manageLine(label));
      // Once, and as a line of its own after a blank line.
      expect(text.split(MANAGE_TAIL).length - 1).toBe(1);
      expect(text.trimEnd().endsWith(`\n\n${manageLine(label)}`)).toBe(true);
      // The rule above it leaves the line out of a [SILENT] reply.
      expect(text).toContain("When you reply `[SILENT]`, write only that and leave this line out.");
      // The line uses none of the prompt's own banned words.
      const banned = text.match(/^- Banned words: (.+)\.$/m);
      expect(banned).not.toBeNull();
      for (const word of banned![1].split(", ")) {
        expect({ word, hit: new RegExp(`\\b${word}\\b`, "i").test(manageLine(label)) }).toEqual({ word, hit: false });
      }
    });
  }

  test("every delivering job's prompt ends with its label's line; every silent job's prompt has none", () => {
    for (const spec of DIGEST_CRON_SPECS) {
      const text = promptText(spec);
      const label = spec.promptFile ? PROMPT_LABELS[spec.promptFile.split("/").pop()!] : null;
      if (spec.deliver && !DELIVERING_WITHOUT_LINE.has(spec.name)) {
        expect({ job: spec.name, label: typeof label }).toEqual({ job: spec.name, label: "string" });
        expect({ job: spec.name, last: lastLine(text) }).toEqual({ job: spec.name, last: manageLine(label!) });
      } else {
        expect({ job: spec.name, line: text.includes(MANAGE_TAIL) }).toEqual({ job: spec.name, line: false });
      }
    }
    // The five DATA-373 names, so a rename cannot drop one silently.
    const labelled = DIGEST_CRON_SPECS.filter((spec) => spec.deliver && !DELIVERING_WITHOUT_LINE.has(spec.name)).map((spec) => spec.name);
    expect(labelled).toEqual([
      "Edge — daily digest",
      "Edge — negotiation summary",
      "Edge — evening questions",
      "Edge — opportunity drop (midday)",
      "Edge — opportunity drop (evening)",
    ]);
  });

  test("the evening outcome question stays the whole reply: the manage line is never added to it", () => {
    const evening = readFileSync(join(PROMPTS_DIR, "ask-questions.md"), "utf8");
    // The sentence the av-events matcher arms on (is_the_question fullmatches the normalised reply).
    expect(evening).toContain("With `outcomeQuestion`: deliver it as the whole reply, word for word, and nothing else.");
    expect(evening).toContain("Never add it to the `outcomeQuestion`: that question stays the whole reply, alone.");
    expect(evening).toContain("With `closeoutQuestion`: deliver it word for word, followed only by the last line below.");
  });
});
