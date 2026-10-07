/**
 * The opportunity copy rules the agent reads (tools.md, AGENTS.md): a card without an
 * `acceptUrl` never gets an invented link. Seref's e2e on 2026-10-07 (tenant on rc24): an
 * opportunities reply with no message links, on a box whose Index MCP endpoint registers no
 * accept tool, so the signed link is the resident's only way to accept; the prose must send
 * them to the card's own `url` or the morning brief, and forbid building the link.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const tools = readFileSync(join(REPO, "skills/index-network/tools.md"), "utf8");
const agents = readFileSync(join(REPO, "workspace/AGENTS.md"), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("opportunity copy: a card without an acceptUrl", () => {
  test("tools.md: the listing rule names the no-link case, the pointer and the ban, once each", () => {
    const rule =
      "A card the tool returns without an `acceptUrl` has no message link: write the action as plain text and point the resident to the card's own `url` (the opportunity page, copied as returned) or to the morning brief, which carries the signed link.";
    expect(count(tools, rule)).toBe(1);
    expect(count(tools, "Never build an accept link, an `/o/<id>?action=accept` path or a Telegram link yourself")).toBe(1);
    expect(count(tools, "never present the opportunity page as the message link")).toBe(1);
    // The rule sits in the "see who is waiting" paragraph, right after the lead-line rule, so a model
    // that reads only the routing paragraph still sees it.
    const line = tools.split("\n").find((l) => l.includes("Call `list_opportunities`."))!;
    expect(line).toContain("do not assemble a URL the tool did not return. A card the tool returns without an `acceptUrl`");
  });

  test("tools.md: the opportunity-copy paragraph keeps the plain-text action and adds the pointer and the ban", () => {
    expect(count(tools, "If `acceptUrl` is missing, the action is plain text (`message Name`, no link), followed by one pointer the tool did return: the card's `url`, or the morning brief. Never invent the link.")).toBe(1);
    expect(tools).not.toContain("If `acceptUrl` is missing, the action is plain text.");
    // What stays: the signed link is copied, never built, and the accept sentence of #240.
    expect(count(tools, "`acceptUrl` is the card's signed accept link. Copy it. Do not build `/o/<id>` for that action.")).toBe(1);
    expect(count(tools, "Opening that link accepts the introduction at once and opens Telegram: say so, never as a look or a preview.")).toBe(1);
    expect(count(tools, "- Message: the card's `acceptUrl`, copied as returned.")).toBe(1);
  });

  test("AGENTS.md: the message-action bullet carries the same rule once, and the label stays `message Name`", () => {
    const bullet = agents.split("\n").filter((l) => l.startsWith("- The message action copies the card's `acceptUrl`"));
    expect(bullet).toHaveLength(1);
    expect(bullet[0]).toContain("`[message Name](acceptUrl)`. Do not build `/o/<id>` for that link. A card without an `acceptUrl` gets the action as plain text and a pointer to the card's `url` or the morning brief, never an invented link.");
    expect(agents).not.toContain("accept and message");
    expect(tools).not.toContain("accept and message");
  });

  test("nowhere does the prose offer a fallback that fabricates a link (no `/c/`, `/profile/`, `/opportunity/create`, no hand-built accept path)", () => {
    expect(count(tools, "Do not use `/c/` connect redirects as the opportunity link. Do not invent `/profile/` or `/opportunity/create` paths.")).toBe(1);
    for (const text of [tools, agents]) {
      expect(text).not.toMatch(/https:\/\/index\.network\/o\/<[^>]+>\?action=accept/);
      expect(text).not.toMatch(/^<<<<<<<|^=======$|^>>>>>>>/m);
    }
  });
});
