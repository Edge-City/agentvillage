/**
 * AGENTS-MD-CAP: workspace/AGENTS.md stays whole in every resident's prompt, red lines first.
 *
 * Hermes (0.21.5, agent/prompt_builder.py `_get_context_file_max_chars`) caps each
 * context file at top-level `context_file_max_chars`, else at a dynamic cap of
 * max(20,000, context_length * 4 * 0.06): 21,600 on the boxes, whose
 * `model.context_length` is pinned at 90,000. Over the cap it keeps a head and a tail
 * and drops the MIDDLE. rc24 to rc26 shipped 25,232 to 29,714 chars, and the cut took
 * most of `## Red lines` on every box. The installer now pins the cap at 48,000
 * (install/config.ts `setContextFileMaxChars`); this file is the real fix: AGENTS.md
 * under the 20,000 floor (target 18,000), so no model pin can truncate it, with the
 * red lines at the top, inside any head budget. The reference sections it shed live
 * at the end of skills/index-network/tools.md, read on demand.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const agents = readFileSync(join(REPO, "workspace", "AGENTS.md"), "utf8");
const tools = readFileSync(join(REPO, "skills", "index-network", "tools.md"), "utf8");

/** Hard limit: Hermes's dynamic floor. Never truncated under it, whatever context_length the model is pinned to. */
const HARD_LIMIT = 20_000;
/** The target, leaving room under the floor for the next sentence someone adds. */
const TARGET = 18_000;
/** `## Red lines` must start inside the head Hermes keeps of any over-cap file. */
const RED_LINES_BY = 6_000;

/** Sections moved verbatim from AGENTS.md to the end of tools.md (AGENTS.md keeps a pointer). */
const MOVED = ["## Cron schedule", "## URL preservation", "## Channel formatting", "## What the app knows about them"];
const headings = (text: string) => [...text.matchAll(/^#{1,3} .*$/gm)].map((m) => m[0]);

describe("AGENTS.md budget (AGENTS-MD-CAP)", () => {
  test(`AGENTS.md is under ${HARD_LIMIT} chars (target ${TARGET})`, () => {
    console.log(`workspace/AGENTS.md: ${agents.length} chars (target ${TARGET}, hard limit ${HARD_LIMIT})`);
    if (agents.length >= HARD_LIMIT) {
      throw new Error(
        `workspace/AGENTS.md is ${agents.length} chars. Keep it at or under ${TARGET} (hard limit ${HARD_LIMIT}): ` +
          `Hermes truncates a context file over its cap (21,600 on the boxes, context_length 90,000; never under 20,000 ` +
          `at any context_length) and drops the middle. Move reference prose to skills/index-network/tools.md with a ` +
          `one-line pointer, or tighten, rather than raising this limit.`,
      );
    }
  });

  test(`## Red lines appears once, before ## Community context, starting before char ${RED_LINES_BY}`, () => {
    expect(agents.split("\n## Red lines\n").length - 1).toBe(1);
    const at = agents.indexOf("\n## Red lines\n");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(RED_LINES_BY);
    expect(at).toBeLessThan(agents.indexOf("\n## Community context\n"));
    // Right after the identity block: the first section heading in the file.
    expect(headings(agents).slice(0, 2)).toEqual(["# AGENTS.md — Your Workspace", "## Red lines"]);
    // The whole section, not just its heading, sits in the head: its last bullet ends before the next section.
    const end = agents.indexOf("\n## ", at + 1);
    const section = agents.slice(at, end);
    expect(section).toContain("- Intentions: if `record_intention` is available");
    expect(section).toContain("- `trash` > `rm`. When in doubt, ask.");
  });

  test("each moved section is in tools.md, once, and no longer in AGENTS.md, which points there", () => {
    for (const heading of [...MOVED, "## Backend notes"]) {
      expect({ heading, inTools: headings(tools).filter((h) => h === heading).length }).toEqual({ heading, inTools: 1 });
      expect({ heading, inAgents: headings(agents).includes(heading) }).toEqual({ heading, inAgents: false });
    }
    // Appended after tools.md's own sections, in this order.
    const order = [...MOVED, "## Backend notes"].map((h) => tools.indexOf(`\n${h}\n`));
    expect(order.every((i, k) => i > tools.indexOf("\n## Output translation\n") && (k === 0 || i > order[k - 1]))).toBe(true);
    // The pointer, as the agent reads a file (relative to HERMES_HOME, absolute path to the file tool).
    expect(agents).toContain("read `skills/index-network/tools.md` under your `HERMES_HOME` (give the file tool its absolute path)");
    for (const name of ["Cron schedule", "URL preservation", "Channel formatting", "Backend notes"]) expect(agents).toContain(`"${name}"`);
    expect(agents).toContain('read "What the app knows about them" in `skills/index-network/tools.md`');
    expect(agents).toContain("URL preservation rules in `skills/index-network/tools.md`.");
  });

  test("the knowledge/ paragraph and the welcome gate's seeded-intents sentence stay in AGENTS.md", () => {
    expect(agents).toContain("- `knowledge/` holds what services wrote for you, one directory per provider");
    expect(agents).toContain("Never write under `knowledge/`;");
    expect(agents).toContain(
      "The welcome script seeds intents from the resident's signup selections on the first welcome (the script does it, once per box)",
    );
    expect(agents).toContain("### Welcome gate");
    expect(agents).toContain("**`edge-india`**");
  });

  test("tools.md keeps its own sections first and its pinned shape (on demand: no length limit)", () => {
    console.log(`skills/index-network/tools.md: ${tools.length} chars (read on demand, no limit)`);
    expect(tools.startsWith("# Index Network — Tools\n")).toBe(true);
    const own = ["## Tool families", "## Tool routing — finding people", "## Capturing new signal in conversation", "## Output translation"];
    const at = own.map((h) => tools.indexOf(`\n${h}\n`));
    expect(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1]))).toBe(true);
    // Every heading once; the lines other pins find by their opening words are still single lines.
    const all = headings(tools);
    expect(new Set(all).size).toBe(all.length);
    expect(tools.split("\n").filter((l) => l.includes("Call `list_opportunities`.")).length).toBe(1);
    expect(tools.split("\n").filter((l) => l.startsWith("When you call `record_intention`:")).length).toBe(1);
    expect(tools.endsWith("\n") && !tools.endsWith("\n\n")).toBe(true);
  });
});
