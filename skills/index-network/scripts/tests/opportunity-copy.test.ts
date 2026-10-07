/**
 * The opportunity copy rules the agent reads (tools.md, AGENTS.md). Seref's e2e on 2026-10-07
 * (tenant on rc24, Haiku): two asks for opportunities, the tool result carried a signed
 * `acceptUrl` on every card (12/12, then 11/11), and both replies copied the lead line's
 * profile (Rolodex) links and emitted no message link at all (claude-b4's session-store read,
 * 23:11Z). So the prose must say that the lead line's links are profiles, that every pending
 * card gets its own `[message Name](acceptUrl)`, and what to do for a card without one:
 * plain text plus one pointer per reply to the Connections link the morning brief ends with,
 * never an invented link (the brief itself has carried no per-person link since DATA-314).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const tools = read("skills/index-network/tools.md");
const agents = read("workspace/AGENTS.md");
const exemplars = read("skills/index-network/exemplars.md");
const promptsDir = "skills/index-network/prompts";
const prompts = readdirSync(join(REPO, promptsDir))
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({ name: `${promptsDir}/${name}`, text: read(`${promptsDir}/${name}`) }));
const everything = [{ name: "tools.md", text: tools }, { name: "AGENTS.md", text: agents }, { name: "exemplars.md", text: exemplars }, ...prompts];
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("opportunity copy: the lead line is profiles, every pending card gets its acceptUrl, no link is ever invented", () => {
  test("tools.md: the listing paragraph says the lead line's links are profiles and each pending card gets its own message link", () => {
    const line = tools.split("\n").find((l) => l.includes("Call `list_opportunities`."))!;
    expect(line).toBeDefined();
    expect(count(line, "those links are the people's profiles (the Rolodex), not the action.")).toBe(1);
    expect(count(line, "Reuse the names and their profile links, then add, for every `pending` card, the message link from that card's own `acceptUrl` field in the JSON below the lead line: `[message Name](acceptUrl)`.")).toBe(1);
    expect(count(line, "A reply that lists pending introductions with profile links only and no message link is wrong: the resident cannot accept from it.")).toBe(1);
    // The old wording that let a model stop at the lead line is gone.
    expect(tools).not.toContain("Reuse that line.");
  });

  test("tools.md: a card without an acceptUrl: plain text, one Connections pointer per reply, the ban, right after the no-invented-URL rule", () => {
    const rule =
      "A card the tool returns without an `acceptUrl` has no message link: write `message Name` as plain text and, once per reply after the list, point the resident to the Connections link the morning brief ends with (the app's people and opportunities page, where they can see who is waiting).";
    expect(count(tools, rule)).toBe(1);
    expect(count(tools, "Never build an accept link, an `/o/<id>?action=accept` path or a Telegram link yourself, and never present the opportunity page or the profile link as the message link.")).toBe(1);
    const line = tools.split("\n").find((l) => l.includes("Call `list_opportunities`."))!;
    expect(line).toContain("do not assemble a URL the tool did not return. A card the tool returns without an `acceptUrl`");
    // The brief carries no per-person link (DATA-314): the prose must not claim it does.
    expect(tools).not.toContain("which carries the signed link");
    expect(agents).not.toContain("which carries the signed link");
  });

  test("tools.md: the opportunity-copy paragraph keeps the plain-text action, points to the one pointer, and keeps the sentences that must stay", () => {
    expect(count(tools, "If `acceptUrl` is missing, write `message Name` as plain text and give the one Connections pointer per reply described above. Never invent the link.")).toBe(1);
    expect(tools).not.toContain("If `acceptUrl` is missing, the action is plain text.");
    expect(tools).not.toContain(", no link)");
    expect(count(tools, "`acceptUrl` is the card's signed accept link. Copy it. Do not build `/o/<id>` for that action.")).toBe(1);
    expect(count(tools, "Opening that link accepts the introduction at once and opens Telegram: say so, never as a look or a preview.")).toBe(1);
    expect(count(tools, "- Message: the card's `acceptUrl`, copied as returned.")).toBe(1);
    expect(count(tools, "Do not use `/c/` connect redirects as the opportunity link. Do not invent `/profile/` or `/opportunity/create` paths.")).toBe(1);
  });

  test("AGENTS.md: the message-action bullet keeps #240's sentence about the accept link, THEN the profile rule, THEN the no-acceptUrl rule", () => {
    const bullets = agents.split("\n").filter((l) => l.startsWith("- The message action copies the card's `acceptUrl`"));
    expect(bullets).toHaveLength(1);
    const bullet = bullets[0];
    const accept = "Opening it accepts the introduction at once and opens Telegram with that person: say so in plain words, and never present it as a look or a preview.";
    const profiles = "The lead line's name links are profiles, not the action: every pending card gets its own `[message Name](acceptUrl)`.";
    const missing = "A card without an `acceptUrl` gets `message Name` as plain text and, once per reply, a pointer to the Connections link the morning brief ends with, never an invented link.";
    expect(count(agents, accept)).toBe(1);
    expect(count(bullet, profiles)).toBe(1);
    expect(count(bullet, missing)).toBe(1);
    // "It" in the accept sentence must still mean the acceptUrl link: the accept sentence comes first.
    expect(bullet.indexOf("`[message Name](acceptUrl)`. Do not build `/o/<id>` for that link. " + accept)).toBeGreaterThan(-1);
    expect(bullet.indexOf(accept)).toBeLessThan(bullet.indexOf(profiles));
    expect(bullet.indexOf(profiles)).toBeLessThan(bullet.indexOf(missing));
    expect(bullet.endsWith(missing)).toBe(true);
  });

  test("across tools.md, AGENTS.md, exemplars.md and the prompts: no hand-built accept path, no 'accept and message' label, no label linked to the card's url, no fallback link", () => {
    for (const { name, text } of everything) {
      // The ban sentence in tools.md is the only place the accept path may be spelled out.
      expect({ name, hits: count(text, "?action=accept") }).toEqual({ name, hits: name === "tools.md" ? 1 : 0 });
      expect({ name, hit: /accept and message/i.test(text) }).toEqual({ name, hit: false });
      expect({ name, hit: /\]\((url|opportunityUrl)\)/.test(text) }).toEqual({ name, hit: false });
      // A "message Name" label links only to the card's acceptUrl (or the drop's messageUrl), as a field name or a {placeholder}.
      expect({ name, hit: /\[message [^\]]+\]\((?!\{?(acceptUrl|messageUrl)\}?\))/i.test(text) }).toEqual({ name, hit: false });
      expect(text).not.toMatch(/^<<<<<<<|^=======$|^>>>>>>>/m);
    }
  });
});
