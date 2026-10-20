/**
 * VISIBILITY B3, the prompt half (lanes-context CONTEXT-SECTIONS-GOLIVE-PASTE.md THE ORDER, step 3): the
 * code half (ov#417) keeps a Private line out of the overlay's stated items; tools.md's "What the app
 * knows about them" says the same thing in plain words, so the agent never sends a Private item to
 * Index by hand. This pins that sentence to the reader's rule: an item marked `private` or the vocab's
 * Private id (VISIBILITY_PRIVATE) is Private; in an entry with any mark, an unmarked item is Private too; a
 * guess or chat item is never the resident's statement.
 *
 * The ids are built from context-tags.ts, never written here: context-marks.test.ts lists every file that
 * names one ("writers are unchanged"), and tools.md is on that list as a reader-side prompt.
 *
 *   bun test skills/index-network/scripts/tests/context-private-prompt.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MARK_VISIBILITY, VISIBILITY_EDGE_CITY_INDIA_2026, VISIBILITY_PRIVATE, markVisibility } from "../context-tags";

const tools = readFileSync(join(import.meta.dir, "..", "..", "tools.md"), "utf8");
const SECTION_START = tools.indexOf("\n## What the app knows about them\n");
const SECTION = tools.slice(SECTION_START, tools.indexOf("\n## ", SECTION_START + 1));
const LINES = tools.split("\n").filter((l) => l.startsWith("- **Private items.**"));
const LINE = LINES[0] ?? "";

describe("tools.md: the Private items rule (VISIBILITY B3, prompt half)", () => {
  test("one line, the first rule under What the app knows about them", () => {
    expect(LINES.length).toBe(1);
    expect(SECTION_START).toBeGreaterThan(0);
    expect(SECTION.split("\n").find((l) => l.startsWith("- "))).toBe(LINE);
  });

  test("it names both Private marks, and every mark the reader reads as Private", () => {
    expect(LINE).toContain(`An item marked \`private\` or \`${VISIBILITY_PRIVATE}\` is private.`);
    const privateMarks = Object.keys(MARK_VISIBILITY).filter((m) => MARK_VISIBILITY[m] === VISIBILITY_PRIVATE);
    expect(privateMarks.sort()).toEqual([VISIBILITY_PRIVATE, "private"].sort());
    for (const mark of privateMarks) expect(LINE).toContain(`\`${mark}\``);
  });

  test("it says an unmarked item in a marked entry is private, and what counts as a mark", () => {
    expect(LINE).toContain(
      "In an entry where any item carries a mark (`public`, `village`, `private` or an `agentvillage/` id), an unmarked item is private too.",
    );
    // The marks it lists are the reader's: the wide ones are Edge City India 2026, no mark is Private.
    expect(markVisibility("public", false)).toBe(VISIBILITY_EDGE_CITY_INDIA_2026);
    expect(markVisibility("village", false)).toBe(VISIBILITY_EDGE_CITY_INDIA_2026);
    expect(markVisibility(null, false)).toBe(VISIBILITY_PRIVATE);
    for (const mark of Object.keys(MARK_VISIBILITY)) {
      expect({ mark, listed: mark.startsWith("agentvillage/") || LINE.includes(`\`${mark}\``) }).toEqual({ mark, listed: true });
    }
  });

  test("it never lets a private item reach Index, the village or anyone else", () => {
    expect(LINE).toContain("Never send a private item to Index, the village or anyone else: not in a search, an intention, a profile or a message.");
  });

  test("a guess or chat item is never their statement, whatever its mark", () => {
    expect(LINE).toContain("A (guess) or (chat) item is never their statement, whatever its mark.");
    // The reader agrees: a guess is Private whatever its mark.
    expect(markVisibility("public", true)).toBe(VISIBILITY_PRIVATE);
    expect(markVisibility(VISIBILITY_EDGE_CITY_INDIA_2026, true)).toBe(VISIBILITY_PRIVATE);
  });
});
