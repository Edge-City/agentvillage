/**
 * DATA-42 (ruling R2): the evening outcome ask, the trigger's half
 * (outcome-ask.ts through proactive.ts's evening action). Index and the
 * reminder pick go through the trigger's seams; the plugin's half (arming,
 * the delivery check, outcome.asked, the answer) is
 * plugins/av-events/tests/test_outcome_ask.py.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BriefOpportunity } from "../build-daily-brief-context";
import {
  MAX_ATTEMPTS,
  askedLedgerPath,
  backfillAnnounced,
  dueSubjects,
  outcomeId,
  outcomeQuestion,
  stagePath,
} from "../outcome-ask";
import { type ProactiveOptions, runProactive } from "../proactive";
import { cleanName } from "../proactive-text";

/** 19:00 IST on 2026-10-14. */
const EVENING = new Date("2026-10-14T13:30:00Z");
const DATE = "2026-10-14";
const OPP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OPP2 = "1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const THIRD_PARTY = "THIRD PARTY WORDS";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-outcome-ask-"));
  mkdirSync(join(home, "memory"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function stateFile(): string {
  return join(home, "memory", "heartbeat-state.json");
}

function writeState(value: Record<string, unknown>): void {
  writeFileSync(stateFile(), JSON.stringify(value));
}

function state(): Record<string, any> {
  return existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf8")) : {};
}

function announced(entries: Record<string, string>, extra: Record<string, unknown> = {}): void {
  writeState({ negotiationSummary: { reportedCompletedIds: Object.keys(entries), announcedOn: entries }, ...extra });
}

function accepted(name: string, id = OPP): BriefOpportunity {
  return {
    name,
    opportunityId: id,
    status: "accepted",
    headline: `${THIRD_PARTY} headline`,
    mainText: `${THIRD_PARTY} summary`,
    userUrl: `https://index.network/u/${id}`,
    opportunityUrl: `https://index.network/o/${id}`,
  };
}

const REMINDER = { name: "Pending Person", headline: THIRD_PARTY, userUrl: "https://index.network/u/p", opportunityUrl: "https://index.network/o/p" };

function options(over: Partial<ProactiveOptions> = {}): ProactiveOptions {
  return {
    home,
    now: () => EVENING,
    lock: { waitMs: 50, pollMs: 5 },
    accepted: async () => [accepted("Arjun Mehta")],
    evening: async () => REMINDER,
    ...over,
  };
}

function output(lines: string[]): Record<string, any> {
  return JSON.parse(lines.slice(0, -1).join("\n"));
}

function stage(): Record<string, any> | null {
  return existsSync(stagePath(home)) ? JSON.parse(readFileSync(stagePath(home), "utf8")) : null;
}

function runLog(): Array<Record<string, any>> {
  const path = join(home, "av-events", "proactive", "triggers.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function markAsked(...ids: string[]): void {
  mkdirSync(join(home, "av-events", "proactive"), { recursive: true });
  writeFileSync(askedLedgerPath(home), JSON.stringify({ v: 1, asked: Object.fromEntries(ids.map((id) => [id, "2026-10-13T13:31:00Z"])) }));
}

describe("the evening asks about one accepted connection announced two or more days ago", () => {
  test("the evening prompt's question, exactly, with the cleaned name, and a 0600 stage with ids only", async () => {
    announced({ [OPP]: "2026-10-12" });
    const result = await runProactive("evening", options());
    expect(result.woke).toBe(true);
    expect(output(result.lines)).toEqual({ job: "evening-note", date: DATE, outcomeQuestion: "Did you and Arjun Mehta meet? Reply met, not useful, or missed." });
    expect(result.lines.join("\n")).not.toContain(THIRD_PARTY);
    const staged = stage()!;
    expect(staged).toEqual({
      v: 1, action: "evening", date: DATE, staged_at: EVENING.toISOString(), asked_by: "outcome_cron", window_days: 1,
      subjects: [{ outcome_id: `opp-outcome:${OPP}`, opportunity_id: OPP }],
    });
    expect(readFileSync(stagePath(home), "utf8")).not.toContain("Arjun");
    expect(statSync(stagePath(home)).mode & 0o777).toBe(0o600);
    // Staged, not asked: only the plugin's ledger marks a subject asked.
    expect(state().outcomeAsk).toEqual({ attempts: { [OPP]: [DATE] } });
    expect(state().proactiveRuns).toEqual({ evening: DATE });
    expect(runLog().at(-1)).toMatchObject({ action: "evening", decision: "woke", detail: "outcome-ask" });
  });

  test("the name goes through cleanName like every other name", async () => {
    const raw = "R.Krishnan​";
    announced({ [OPP]: "2026-10-10" });
    const result = await runProactive("evening", options({ accepted: async () => [accepted(raw)] }));
    expect(cleanName(raw)).not.toBeNull();
    expect(output(result.lines).outcomeQuestion).toBe(outcomeQuestion(cleanName(raw)!));
  });

  test("a name that does not clean: no ask tonight, the reminder instead, and the subject stays due", async () => {
    announced({ [OPP]: "2026-10-12" });
    const result = await runProactive("evening", options({ accepted: async () => [accepted("www evil")] }));
    expect(output(result.lines).person.name).toBe("Pending Person");
    expect(stage()).toBeNull();
    expect(state().outcomeAsk).toBeUndefined();
    expect(dueSubjects(state(), new Set(), "2026-10-15")).toEqual([OPP]);
    expect(runLog().at(-1)).toMatchObject({ decision: "woke", detail: "outcome-ask-name-withheld" });
  });

  test("announced yesterday is not due: the reminder, no stage", async () => {
    announced({ [OPP]: "2026-10-13" });
    let indexRead = false;
    const result = await runProactive("evening", options({ accepted: async () => { indexRead = true; return [accepted("Arjun")]; } }));
    expect(output(result.lines).person).toBeDefined();
    expect(indexRead).toBe(false);
    expect(stage()).toBeNull();
    expect(runLog().at(-1)).toMatchObject({ detail: "outcome-ask-none-due" });
  });

  test("a subject the plugin recorded as asked is never asked again", async () => {
    announced({ [OPP]: "2026-10-10" });
    markAsked(OPP);
    const result = await runProactive("evening", options());
    expect(output(result.lines).person).toBeDefined();
    expect(stage()).toBeNull();
  });

  test("Index down, or the connection no longer accepted: the reminder, and the subject stays due", async () => {
    announced({ [OPP]: "2026-10-10" });
    const down = await runProactive("evening", options({ accepted: async () => { throw new Error("down"); } }));
    expect(output(down.lines).person).toBeDefined();
    expect(runLog().at(-1)).toMatchObject({ detail: "outcome-ask-index-unavailable" });
    rmSync(stateFile());
    announced({ [OPP]: "2026-10-10" });
    const gone = await runProactive("evening", options({ accepted: async () => [accepted("Someone Else", OPP2)] }));
    expect(output(gone.lines).person).toBeDefined();
    expect(stage()).toBeNull();
    expect(runLog().at(-1)).toMatchObject({ detail: "outcome-ask-not-listed" });
  });

  test("the oldest announcement is asked first, one subject only", async () => {
    announced({ [OPP2]: "2026-10-11", [OPP]: "2026-10-09" });
    const result = await runProactive("evening", options({ accepted: async () => [accepted("Second", OPP2), accepted("First", OPP)] }));
    expect(output(result.lines).outcomeQuestion).toBe(outcomeQuestion("First"));
    expect(stage()!.subjects).toEqual([{ outcome_id: `opp-outcome:${OPP}`, opportunity_id: OPP }]);
  });

  test("nothing due and nothing pending: silent, no stage", async () => {
    const result = await runProactive("evening", options({ evening: async () => ({ silent: true, reason: "nothing-waiting" }) }));
    expect(result.woke).toBe(false);
    expect(stage()).toBeNull();
  });
});

describe("a failed or silent ask leaves the subject due, and the stage is never reused", () => {
  test("an ask the plugin never confirmed (silent, failed delivery) is due again the next evening, up to MAX_ATTEMPTS evenings", async () => {
    announced({ [OPP]: "2026-10-10" });
    const asked: string[] = [];
    for (let day = 0; day < MAX_ATTEMPTS + 2; day++) {
      const now = new Date(EVENING.getTime() + day * 86_400_000);
      const result = await runProactive("evening", options({ now: () => now }));
      if (result.woke && output(result.lines).outcomeQuestion) asked.push(output(result.lines).date);
    }
    expect(asked).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"].slice(0, MAX_ATTEMPTS));
  });

  test("once the plugin records the ask, the subject is not due the next evening", async () => {
    announced({ [OPP]: "2026-10-10" });
    await runProactive("evening", options());
    markAsked(OPP);
    const next = await runProactive("evening", options({ now: () => new Date(EVENING.getTime() + 86_400_000) }));
    expect(output(next.lines).person).toBeDefined();
  });

  test("a stage left by an earlier run is removed by the next evening run, which falls back to the reminder", async () => {
    mkdirSync(join(home, "av-events", "proactive"), { recursive: true });
    writeFileSync(stagePath(home), JSON.stringify({ v: 1, action: "evening", date: "2026-10-13", subjects: [] }));
    const result = await runProactive("evening", options());
    expect(output(result.lines).person).toBeDefined();
    expect(stage()).toBeNull();
  });

  test("done today: no stage, and the earlier one is left for the plugin", async () => {
    announced({ [OPP]: "2026-10-10" });
    await runProactive("evening", options());
    const first = readFileSync(stagePath(home), "utf8");
    const again = await runProactive("evening", options());
    expect(again.reason).toBe("done-today");
    expect(readFileSync(stagePath(home), "utf8")).toBe(first);
  });

  test("two triggers racing leave one stage and no temp file", async () => {
    announced({ [OPP]: "2026-10-10" });
    const results = await Promise.all([runProactive("evening", options()), runProactive("evening", options())]);
    expect(results.filter((r) => r.woke)).toHaveLength(1);
    const files = readdirSync(join(home, "av-events", "proactive")).filter((name) => name.startsWith("outcome-ask"));
    expect(files).toEqual(["outcome-ask-evening.json"]);
    expect(state().outcomeAsk.attempts[OPP]).toEqual([DATE]);
  });
});

describe("the helpers", () => {
  test("connections reported before dates were recorded are dated today, so they are due two days later", () => {
    const before = { negotiationSummary: { reportedCompletedIds: [OPP, OPP2], announcedOn: { [OPP2]: "2026-10-01" } } };
    const { state: after, changed } = backfillAnnounced(before, DATE);
    expect(changed).toBe(true);
    expect((after.negotiationSummary as any).announcedOn).toEqual({ [OPP2]: "2026-10-01", [OPP]: DATE });
    expect(dueSubjects(after, new Set(), DATE)).toEqual([OPP2]);
    expect(dueSubjects(after, new Set(), "2026-10-16")).toEqual([OPP2, OPP]);
    expect(backfillAnnounced(after, DATE).changed).toBe(false);
  });

  test("an id that cannot be an envelope id is never due", () => {
    expect(outcomeId("has space")).toBeNull();
    expect(outcomeId("x".repeat(101))).toBeNull();
    expect(outcomeId(OPP)).toBe(`opp-outcome:${OPP}`);
    expect(dueSubjects({ negotiationSummary: { announcedOn: { "has space": "2026-10-01" } } }, new Set(), DATE)).toEqual([]);
  });
});
