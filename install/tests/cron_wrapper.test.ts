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
import { MESSAGE_LABELS } from "../../skills/index-network/scripts/message-labels";

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
  // DATA-430: the hourly alert for an opportunity that newly turned pending.
  "pending-alert.md": "Pending opportunity",
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
    // The five DATA-373 names, DATA-430's pending alert and the token usage audit, so a rename cannot drop one silently.
    const labelled = DIGEST_CRON_SPECS.filter((spec) => spec.deliver).map((spec) => [spec.name, labelOf(spec)]);
    expect(labelled).toEqual([
      ["Edge — daily digest", "Daily digest"],
      ["Edge — negotiation summary", "Conversation update"],
      ["Edge — evening questions", "Evening questions"],
      ["Edge — opportunity drop (midday)", "Introduction suggestion"],
      ["Edge — opportunity drop (evening)", "Introduction suggestion"],
      ["Edge — pending opportunity", "Pending opportunity"],
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
    // DATA-430: the pending alert's label is not in the seed's alternation. The seed strips a manage line
    // from the evening outcome ask's reply only (the one job that arms an ask, under the Evening questions
    // label); the pending alert never arms one, and changing the seed is the av-events plugin's contract
    // (outcome_question.json), left to that owner. Every other label stays pinned.
    const NOT_IN_OUTCOME_SEED = new Set(["Pending opportunity"]);
    const emitted = [...new Set([...Object.values(PROMPT_LABELS), ...Object.values(INLINE_LABELS)].filter((label): label is string => label !== null && !NOT_IN_OUTCOME_SEED.has(label)))];
    expect(emitted.sort()).toEqual(["Conversation update", "Daily digest", "Evening questions", "Introduction suggestion", "Usage report"]);
    for (const label of emitted) expect({ label, strips: manage.test(manageLine(label)) }).toEqual({ label, strips: true });
    // The alternation names these five and nothing else.
    const alternation = /^\\\(\(\?:([^)]+)\) message/.exec(seed.normalise.manage_line)![1].split("|").sort();
    expect(alternation).toEqual(emitted.sort());
  });

  test("tools.md's Cron schedule maps every label to exactly its jobs; the agent stops and restarts all six with the pause script", () => {
    // AGENTS-MD-CAP: the section moved verbatim from workspace/AGENTS.md to the index-network skill's tools.md
    // (AGENTS.md keeps a pointer to it); the holds-file paragraph moved with it.
    const agents = readFileSync(join(import.meta.dir, "..", "..", "workspace", "AGENTS.md"), "utf8");
    const tools = readFileSync(join(import.meta.dir, "..", "..", "skills", "index-network", "tools.md"), "utf8");
    expect(agents).not.toContain("## Cron schedule");
    expect(agents).toContain("read `skills/index-network/tools.md` under your `HERMES_HOME`");
    const start = tools.indexOf("## Cron schedule");
    expect(start).toBeGreaterThan(-1);
    const next = tools.indexOf("\n## ", start + 1);
    const section = tools.slice(start, next < 0 ? undefined : next);
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
    // DATA-376: the pause script's own table is the same mapping.
    expect(Object.fromEntries(Object.entries(MESSAGE_LABELS).map(([label, names]) => [label, [...names].sort()]))).toEqual(Object.fromEntries(expected));
    // DATA-376: all six (DATA-430 added the pending alert) stop and restart through the pause script, which records a hold an update keeps.
    expect(section).toContain("You can stop and restart any of these six messages when the user asks.");
    expect(section).toContain("Pending opportunity = `Edge — pending opportunity`");
    expect(section).toContain('`bun skills/index-network/scripts/pause-job.ts pause --label "<Label>"`');
    expect(section).toContain("run the same with `resume`");
    expect(section).toContain("Call `terminal` with exactly `command` plus `workdir` set to your absolute `HERMES_HOME` directory, and nothing else.");
    expect(section).toContain("an update does not switch it back on");
    expect(section).toContain("A restarted one comes back at its usual time, not at once.");
    for (const error of ["held-by-admin", "held-by-settings", "holds-unreadable", "job-missing", "busy"]) expect(section).toContain(`\`${error}\``);
    // Fix round 1 (S2): the reply's own words win over the default line.
    expect(section).toContain('If the reply has `"resumeMayFire": true` anywhere, never say "not at once": say it is back on, and that one it missed while stopped may arrive soon.');
    expect(section).toContain('If it says `"ok": false` but `applied` lists a job, the change went through: say it is stopped (or back on), but you could not finish tidying up and will run it once more, then run the same command once more.');
    // Fix round 1 (S3): each refusal in its own words.
    expect(section).toContain("`held-by-admin`: it was switched off by the Edge City team, so you can't restart it, and they can ask the team;");
    expect(section).toContain("`held-by-settings`: it was switched off in settings the Edge City team manages for now, so ask them to turn it back on;");
    expect(section).toContain("`holds-unreadable`: something is wrong with its settings file, the Edge City team needs to look, and the message stays as it is for now;");
    expect(section).not.toContain("switched off by the Edge City team or in settings");
    expect(section).toContain("Never use `cronjob_manage` on these jobs: a pause made that way is lost at the next update.");
    // The #224 wording is gone: no "not yet", no cron tool pause, no promise that a missed one may arrive.
    expect(section).not.toContain("can't stop those yet");
    expect(section).not.toContain("pause that job with the `cronjob_manage` tool");
    expect(section).not.toContain("may arrive right away");
    expect(section).toContain("no scheduled message can be moved or added");
    expect(section).not.toContain("can't be changed");
    // The holds file is not a preferences file, and the line saying so stays true.
    expect(section).toContain("Edge keeps no separate preferences file. `av-events/job-holds.json` only records who stopped or restarted a scheduled message");
    expect(agents).not.toContain("Edge does not keep a separate preferences file.");
    expect(tools).not.toContain("Edge does not keep a separate preferences file.");
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
