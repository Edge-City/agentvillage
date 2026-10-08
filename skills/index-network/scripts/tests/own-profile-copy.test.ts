/**
 * The "my profile" rule the agent reads (tools.md), DATA-413. A resident asked "tell me about my
 * index profile" (2026-10-07): the agent summarised `get_my_profile` correctly, linked the Rolodex
 * view of themselves, and said it could not change the profile from chat. The index-links plugin
 * now keeps the `/u/` links in a `get_my_profile` result (0.3.0), and `update_my_profile` is
 * available for explicit corrections, so the prose must say to link the profile `get_my_profile`
 * returned, offer the correction in chat or in the Edge City app, and nowhere say the agent cannot
 * change the profile (the one ban sentence quotes the refusal it forbids, and is the only place it may).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const tools = readFileSync(join(REPO, "skills/index-network/tools.md"), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

const RULE =
  '**Their own profile.** When the user asks about their profile, link the `/u/` link `get_my_profile` returned (their Index profile, not the Rolodex) and offer: "tell me the correction here, or edit it in the Edge City app".';
const BAN = 'Never refuse with "I can\'t change it" or "profile edits happen in the app".';
/** Any way of saying the agent cannot change or edit the profile, or that edits only happen in the app. */
const DENIAL =
  /\b(can['’]?t|cannot|can not|unable to|not able to|no way to)\b[^.\n]*\b(change|edit|update|correct)\b|\b(profile )?edits? (only )?happen in the (Edge City )?app\b|\bfrom chat\b[^.\n]*\b(can['’]?t|cannot)\b|\bonly (be )?(edit|chang|updat|correct)\w*\b[^.\n]*\bin the (Edge City )?app\b|\b(edit|chang|updat|correct)\w*\b[^.\n]*\bonly in the (Edge City )?app\b|\bnot (possible|available|supported)\b[^.\n]*\b(chat|here)\b/i;

describe("own profile: link what get_my_profile returned, offer the correction, never deny the edit", () => {
  test("the rule sits right after the get_my_profile ownership line, names the tool and the /u/ link, and offers chat or the app", () => {
    expect(count(tools, RULE)).toBe(1);
    const owner = "`get_my_profile` is the owner's own profile. Do not use it to look up someone else.\n\n";
    expect(tools).toContain(owner + RULE);
    const line = tools.split("\n").find((l) => l.startsWith("**Their own profile.**"))!;
    expect(line).toBeDefined();
    expect(line).toContain("`get_my_profile`");
    expect(line).toContain("tell me the correction here, or edit it in the Edge City app");
    expect(line).toContain("not the Rolodex");
    expect(line.endsWith(BAN)).toBe(true);
  });

  test("the correction path stays wired to update_my_profile for an explicit correction", () => {
    expect(count(tools, "Call `update_my_profile` only when the user explicitly corrects a field.")).toBe(1);
    expect(count(tools, "- **Profile correction** — the user explicitly corrects their own name, intro, location, or timezone → call `update_my_profile` with only that field.")).toBe(1);
  });

  test("outside the one ban sentence, tools.md nowhere says the agent cannot change the profile", () => {
    expect(count(tools, BAN)).toBe(1);
    // The pattern does catch the refusal (so a clean result below means something).
    expect(DENIAL.test(BAN)).toBe(true);
    expect(DENIAL.test("I can't change the profile from chat. Profile edits happen in the Edge City app.")).toBe(true);
    const hits = tools
      .replace(BAN, "")
      .split("\n")
      .filter((l) => DENIAL.test(l));
    expect(hits).toEqual([]);
  });
});
