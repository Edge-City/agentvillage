/**
 * DATA-373: cron deliveries carry no Hermes "Cronjob Response" wrapper.
 *
 *   - AC #1: `configureCronWrapResponse` writes `cron.wrap_response: false`,
 *     is idempotent, and leaves the other `cron.*` keys alone. install.ts and
 *     the standalone reconcile run it (their spawned runs are checked in
 *     reconcile_digest_crons.test.ts, F9 and R1).
 *   - AC #2: every delivering prompt ends with its own manage line, verbatim;
 *     the prompts that never deliver carry none. The token usage audit's
 *     inline prompt ends with the Usage report line (follow-up round).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { configureCronScriptTimeout, configureCronWrapResponse } from "../config";
import { DIGEST_CRON_SPECS, type DigestCronSpec, templateCronSpec } from "../install_index";
import { TEMPLATE_NAMES } from "../../skills/index-network/scripts/job-settings";

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
 * Delivering jobs with an inline prompt (no prompt file) and their label. The
 * token usage audit is opt-in; Carter named its label "Usage report". A new
 * delivering job with neither a prompt file in PROMPT_LABELS nor an entry here
 * fails the table test below until someone names its label.
 */
const INLINE_LABELS: Record<string, string> = {
  "Edge — token usage audit": "Usage report",
};

function promptText(spec: DigestCronSpec): string {
  return spec.promptFile ? readFileSync(join(SKILLS, spec.promptFile), "utf8") : spec.promptBody ?? "";
}

function labelOf(spec: DigestCronSpec): string | null | undefined {
  return spec.promptFile ? PROMPT_LABELS[spec.promptFile.split("/").pop()!] : INLINE_LABELS[spec.name];
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
      const label = labelOf(spec);
      if (spec.deliver) {
        expect({ job: spec.name, label: typeof label }).toEqual({ job: spec.name, label: "string" });
        expect({ job: spec.name, last: lastLine(text) }).toEqual({ job: spec.name, last: manageLine(label!) });
      } else {
        expect({ job: spec.name, line: text.includes(MANAGE_TAIL) }).toEqual({ job: spec.name, line: false });
      }
    }
    // The five DATA-373 names and the token usage audit, so a rename cannot drop one silently.
    const labelled = DIGEST_CRON_SPECS.filter((spec) => spec.deliver).map((spec) => [spec.name, labelOf(spec)]);
    expect(labelled).toEqual([
      ["Edge — daily digest", "Daily digest"],
      ["Edge — negotiation summary", "Conversation update"],
      ["Edge — evening questions", "Evening questions"],
      ["Edge — opportunity drop (midday)", "Introduction suggestion"],
      ["Edge — opportunity drop (evening)", "Introduction suggestion"],
      ["Edge — token usage audit", "Usage report"],
    ]);
  });

  test("the token usage audit's inline prompt ends with the Usage report line, after a blank line, and keeps it off a [SILENT] reply", () => {
    const audit = DIGEST_CRON_SPECS.find((spec) => spec.name === "Edge — token usage audit")!;
    expect(audit.promptFile).toBeUndefined();
    expect(audit.deliver).toBe(true);
    const body = audit.promptBody!;
    // Exactly the last line, once, as a line of its own after a blank line; nothing after it (the installer trims).
    expect(lastLine(body)).toBe("(Usage report message - you can ask me to stop or manage it)");
    expect(body.endsWith("\n\n(Usage report message - you can ask me to stop or manage it)")).toBe(true);
    expect(body.split(MANAGE_TAIL).length - 1).toBe(1);
    expect(body.split("\n")).toHaveLength(3);
    // The [SILENT] path adds nothing: the rule above the line says so, and the wake-false rule is unchanged.
    expect(body).toContain("If the script emitted wakeAgent:false, return [SILENT].");
    expect(body).toContain("a [SILENT] reply is only that, without the line.");
    // The prompt files' wording for the line itself (brief.md "# Last line").
    expect(body).toContain("exactly as written: never translated, reworded or formatted, with nothing after it");
    expect(body.indexOf("a [SILENT] reply is only that")).toBeLessThan(body.indexOf("(Usage report message"));
    // The audit's own text is unchanged ahead of the new sentence.
    expect(body.startsWith("A deterministic local token usage audit found an actionable driver. ")).toBe(true);
  });

  test("av-events strips every label the installer emits: the seed's manage_line is exactly these labels' lines", () => {
    const seed = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "plugins", "av-events", "outcome_question.json"), "utf8"));
    const manage = new RegExp(`^(?:${seed.normalise.manage_line})$`, "u");
    const emitted = [...new Set([...Object.values(PROMPT_LABELS), ...Object.values(INLINE_LABELS)].filter((label): label is string => label !== null))];
    expect(emitted.sort()).toEqual(["Conversation update", "Daily digest", "Evening questions", "Introduction suggestion", "Usage report"]);
    for (const label of emitted) expect({ label, strips: manage.test(manageLine(label)) }).toEqual({ label, strips: true });
    // The alternation names these five and nothing else.
    const alternation = /^\\\(\(\?:([^)]+)\) message/.exec(seed.normalise.manage_line)![1].split("|").sort();
    expect(alternation).toEqual(emitted.sort());
  });

  test("AGENTS.md maps every label to exactly its jobs; the agent stops only Daily digest and Usage report", () => {
    const agents = readFileSync(join(import.meta.dir, "..", "..", "workspace", "AGENTS.md"), "utf8");
    const section = agents.slice(agents.indexOf("## Cron schedule"), agents.indexOf("## Red lines"));
    expect(section).toContain(`\`(<Label>${MANAGE_TAIL}\``);
    const mapping = section.match(/Each label maps to its job: (.+?)\.\n/)![1];
    // Label -> the backticked job names its entry lists, read back from the text.
    const listed = new Map(
      mapping.split("; ").map((part) => {
        const [label, rest] = part.split(" = ");
        return [label, [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort()] as const;
      }),
    );
    // Exactly the default delivering jobs under their labels: no job missing, none extra, no template (operator previews).
    const expected = new Map<string, string[]>();
    for (const spec of DIGEST_CRON_SPECS.filter((s) => s.deliver)) {
      const label = labelOf(spec)!;
      expected.set(label, [...(expected.get(label) ?? []), spec.name].sort());
    }
    expect(Object.fromEntries(listed)).toEqual(Object.fromEntries(expected));
    expect(section).not.toContain("template");
    // B1: the agent pauses only the two a roll leaves paused; the other three it must not pause.
    expect(section).toContain("You can stop the Daily digest and the Usage report yourself");
    expect(section).toContain("pause that job with the `cronjob_manage` tool");
    expect(section).toContain("Do not pause Conversation update, Evening questions or Introduction suggestion");
    expect(section).toContain("you can't stop those yet and that this is being worked on");
    // S1: resume only its own stops, and no promise that a missed one waits.
    expect(section).toContain("only a message you stopped at their request; never restart one that was switched off some other way");
    expect(section).toContain("one it missed while stopped may arrive right away");
    expect(section).toContain("no scheduled message can be moved or added");
    expect(section).not.toContain("can't be changed");
  });

  test("every template a job can be added from delivers on a labelled prompt, so it carries its base job's line", () => {
    // Templates are operator-added previews (install/jobs.ts add): AGENTS.md leaves them out, but none may deliver unlabelled.
    expect([...TEMPLATE_NAMES].sort()).toEqual(["brief", "digest-preview", "evening-ask"]);
    for (const template of TEMPLATE_NAMES) {
      const spec = templateCronSpec(template, "0 9 * * *");
      const label = labelOf(spec);
      expect({ template, deliver: spec.deliver, label: typeof label }).toEqual({ template, deliver: true, label: "string" });
      expect({ template, last: lastLine(promptText(spec)) }).toEqual({ template, last: manageLine(label!) });
    }
  });

  test("the evening outcome question stays the whole reply: the manage line is never added to it", () => {
    const evening = readFileSync(join(PROMPTS_DIR, "ask-questions.md"), "utf8");
    // The sentence the av-events matcher arms on (is_the_question fullmatches the normalised reply).
    expect(evening).toContain("With `outcomeQuestion`: deliver it as the whole reply, word for word, and nothing else.");
    expect(evening).toContain("Never add it to the `outcomeQuestion`: that question stays the whole reply, alone.");
    expect(evening).toContain("With `closeoutQuestion`: deliver it word for word, followed only by the last line below.");
  });
});
