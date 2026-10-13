/**
 * Timour's feedback on the morning brief (2026-10-11): a blank line between
 * events, and one link to the Agent Village front page near the end. The brief
 * is model-written from prompts/brief.md over the trigger's Script Output
 * (proactive.ts briefView); Hermes sends the reply as Telegram MarkdownV2,
 * which keeps blank lines. The prompt wording is pinned in
 * install/tests/proactive_jobs.test.ts and the Script Output field in
 * proactive.test.ts; this file pins the exemplars that show the shape.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { VILLAGE_LINK } from "../proactive";

const exemplars = readFileSync(join(import.meta.dir, "..", "..", "exemplars.md"), "utf8");
const briefSection = exemplars.slice(
  exemplars.indexOf("## Good morning brief"),
  exemplars.indexOf("### Same person, more than one opportunity"),
);

describe("morning brief format", () => {
  test("the front page link is the bare Agent Village origin", () => {
    expect(VILLAGE_LINK).toBe("https://agents.edgecity.live");
  });

  test("exemplars: calendar events are separated by a blank line", () => {
    const lines = briefSection.split("\n");
    const events = lines.flatMap((line, i) => (line.startsWith("> - {timeLocal} IST") ? [i] : []));
    expect(events.length).toBeGreaterThan(1);
    for (let k = 1; k < events.length; k++) {
      // Consecutive events in one calendar block sit two lines apart, a blank quoted line between them.
      if (events[k] - events[k - 1] <= 2) expect(lines[events[k] - 1]).toBe(">");
    }
    expect(briefSection).not.toMatch(/^> - \{timeLocal\}[^\n]*\n> - \{timeLocal\}/m);
  });

  test("exemplars: each full brief gives the front page once, just before the closing line", () => {
    const closing = "> That's it for now.";
    const briefs = briefSection.split(/\n(?=### )/);
    expect(briefs).toHaveLength(3);
    for (const brief of briefs) {
      expect(brief.split(`> Agent Village: ${VILLAGE_LINK}\n`).length - 1).toBe(1);
      expect(brief.indexOf(`> Agent Village: ${VILLAGE_LINK}\n>\n${closing}`)).toBeGreaterThan(-1);
    }
    // Nowhere outside the morning briefs.
    expect(exemplars.split("Agent Village: ").length - 1).toBe(3);
  });
});
