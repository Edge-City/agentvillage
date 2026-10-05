/**
 * The expressions the croniter differential test covers, with the canonical
 * form install/jobs.ts would send Hermes for each (null: refused by the
 * grammar). Not a test file. Regenerate the fixture with croniter 6.0.0 (the
 * version Hermes v2026.9.24 pins), from the repo root:
 *
 *   bun skills/index-network/scripts/tests/fixtures/croniter-fixture-input.ts <tmp>/input.json
 *   <hermes-venv>/bin/python skills/index-network/scripts/tests/fixtures/croniter_fixture.py <tmp>/input.json skills/index-network/scripts/tests/fixtures/croniter-6.0.0.json
 *
 * The test (job-settings.test.ts) checks the fixture's canonical forms still
 * match the tool's, so a grammar change that is not regenerated fails.
 */
import { writeFileSync } from "node:fs";

import { parseStrictCron } from "../../job-settings";

/** The reviewer's report and probes, then the cases this fix round adds. Accepted and refused alike. */
export const REPORT_EXPRESSIONS: string[] = [
  // The reviewer's cron_probe list.
  "0 8 * * *", "5/15 8 * * *", "0 8/5 * * *", "0 23/5 * * *", "*/60 8 * * *", "0 */24 * * *",
  "0-58/59 8 * * *", "0 8 */31 * *", "0 8 * */12 *", "0 8 * * */7", "0 8 * * 0-6/7", "0 8 * * 6/7",
  "0 8 31 2 *", "0 8 30 2 *", "0 8 31 4,6,9,11 *", "0 8 31 * *", "08 08 * * *", "00 8 * * *",
  "0 8 * * 0", "0 8 * * 5-6", "0 8 1-31/30 * *", "0 0-23/23 * * *", "0 8 1 * 1",
  "59 23 * * *", "* * * * *", "0 8 * * 1-1", "0 8 * * 7", "0 8 1-1 * *", "0,0 8 * * *",
  "  0 8 * * *  ", "0  8 * * *", "0 8 * * * ", "0 8 * 2 0", "0 8 29 2 *",
  "0 22,1 * * *", "1-59/58 * * * *", "0 1-23/22 * * *", "0 0/0 * * *",
  // The reviewer's probes: the misread hour, the impossible date, every minute, the DST cases.
  "0 23/2 * * *", "0 18 * * *", "30 18 * * *", "30 2 * * *", "0 15 * * *",
  // Every field's maximum with a step (croniter reads `max/s` as `*/s`).
  "59/1 8 * * *", "59/5 8 * * *", "59/60 8 * * *", "0 23/1 * * *", "0 23/24 * * *", "0 8 31/1 * *", "0 8 31/2 * *",
  "0 8 31/31 * *", "0 8 * 12/1 *", "0 8 * 12/5 *", "0 8 * 12/12 *", "0 8 * * 6/1", "0 8 * * 6/2",
  // Degenerate ranges, with and without a step (croniter reads `a-a` as the whole field).
  "0 8-8 * * *", "0 8-8/2 * * *", "59-59 * * * *", "0 8 * 2-2 *", "0 8 * * 1-1/1", "0 8 15-15/3 * *",
  // Reversed ranges, out of range, steps out of range.
  "0 9-8 * * *", "0 8 * * 6-0", "60 8 * * *", "0 24 * * *", "0 8 0 * *", "0 8 32 * *", "0 8 * 13 *", "0 8 * 0 *",
  "*/0 8 * * *", "*/61 8 * * *", "0 */25 * * *", "0 8 * * */8", "100 8 * * *", "-1 8 * * *",
  // Names, specials, shapes outside the grammar.
  "0 8 * * MON", "0 8 * JAN *", "@daily", "0 8 ? * *", "0 8 L * *", "0 8 * * 1#2", "0 8 * *", "0 8 * * * *",
  "0 8 * * ,", "0 ,8 * * *", "0 8 * * 1-", "1,,2 8 * * *", "0\t8 * * *",
  // Day of month and day of week: either matches when both are restricted; a full field is `*`.
  "0 8 1-31 * 1", "0 8 1-31 * *", "0 8 * * 0-6", "0 8 1 * 0-6", "0 8 13 * 5", "0 8 1-15 * 1-5", "0 8 31 2 1",
  "0 8 29 2 1", "0 8 30 2,4 *", "0 8 31 4,6,9,11 0", "0 8 1,15 * *", "0 8 * 2 *",
  // Ordinary schedules, lists and steps.
  "30 17 * * *", "30 19 * * *", "30 16 * * *", "30 16,17 * * *", "*/20 6-8 * * *", "5,35 7 * * 1-5",
  "10-50/20 9 1 10 0", "15/30 9 * * *", "0 */6 * * *", "0 0 * * *", "0 12 * * 1,3,5", "45 9 1-7 * *",
  "0,30 8 * * *", "0 8,20 * * *", "7 8 * * *", "0 6-18/3 * * 1-5",
];

/** The reviewer's sweep: `a/s` for every start and step in minute, hour, day of month and day of week; and month. */
export function sweepExpressions(): string[] {
  const out: string[] = [];
  for (let a = 0; a <= 59; a++) for (let s = 1; s <= 60; s++) out.push(`${a}/${s} 8 * * *`);
  for (let a = 0; a <= 23; a++) for (let s = 1; s <= 24; s++) out.push(`0 ${a}/${s} * * *`);
  for (let a = 1; a <= 31; a++) for (let s = 1; s <= 31; s++) out.push(`0 8 ${a}/${s} * *`);
  for (let a = 0; a <= 6; a++) for (let s = 1; s <= 7; s++) out.push(`0 8 * * ${a}/${s}`);
  for (let a = 1; a <= 12; a++) for (let s = 1; s <= 12; s++) out.push(`0 8 * ${a}/${s} *`);
  return out;
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) throw new Error("usage: croniter-fixture-input.ts <output.json>");
  const row = (e: string) => ({ e, c: parseStrictCron(e)?.expr ?? null });
  writeFileSync(target, `${JSON.stringify({ report: REPORT_EXPRESSIONS.map(row), sweep: sweepExpressions().map(row) })}\n`);
  console.log(`wrote ${REPORT_EXPRESSIONS.length} report and ${sweepExpressions().length} sweep expressions to ${target}`);
}
