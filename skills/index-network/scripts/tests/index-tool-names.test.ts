/**
 * The scripts and the agent-facing prose may name only the tools Index's MCP
 * endpoint has (fixtures/index-mcp-2026-07-28.json) plus the av-events plugin
 * tool record_intention, and nothing may speak the retired protocol.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { INDEX_TOOLS, PROTOCOL } from "./index-mcp-fake";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const ALLOWED = new Set([...INDEX_TOOLS, "record_intention"]);

/** Tool-shaped snake_case names: a verb Index or its predecessors used, then more words. */
const TOOL_SHAPED =
  /\b(?:get|list|read|create|update|delete|confirm|respond|accept|reject|archive|pause|resume|enrich|record|send|search|find|fetch|write|mark|submit|add|remove)_[a-z0-9_]+\b/g;

/** Names known to be gone (2026-10-03), checked literally so a narrow regex cannot hide them. */
const RETIRED = [
  "confirm_opportunity_delivery",
  "read_pending_questions",
  "list_negotiations",
  "get_negotiation",
  "respond_to_negotiation",
  "read_intents",
  "read_user_contexts",
  "read_premises",
  "create_premise",
];

const OLD_PROTOCOL = ["2024-11-05", "initialize", "confirm_opportunity_delivery"];

function filesIn(dir: string, ext: string): string[] {
  return readdirSync(join(REPO, dir))
    .filter((name) => name.endsWith(ext))
    .map((name) => join(REPO, dir, name));
}

const SCRIPTS = filesIn("skills/index-network/scripts", ".ts");
const PROSE = [
  ...filesIn("workspace", ".md"),
  ...filesIn("skills/index-network/prompts", ".md"),
  ...filesIn("skills/index-network", ".md"),
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Index tool names in scripts and prose", () => {
  test("the scan covers the files it should", () => {
    const rel = [...SCRIPTS, ...PROSE].map((path) => relative(REPO, path));
    for (const expected of [
      "skills/index-network/scripts/index-mcp.ts",
      "skills/index-network/scripts/build-daily-brief-context.ts",
      "skills/index-network/scripts/send-daily-brief.ts",
      "skills/index-network/scripts/drop-opportunity.ts",
      "skills/index-network/scripts/summarize-negotiations.ts",
      "workspace/SOUL.md",
      "workspace/AGENTS.md",
      "skills/index-network/prompts/memory-signals.md",
      "skills/index-network/prompts/brief.md",
      "skills/index-network/tools.md",
      "skills/index-network/SKILL.md",
    ]) {
      expect(rel).toContain(expected);
    }
    // The pattern does see real names (so an empty result below means something).
    expect(read(join(REPO, "skills/index-network/tools.md")).match(TOOL_SHAPED)).toContain("list_opportunities");
  });

  test("every tool-shaped name is one of Index's 14 tools or record_intention", () => {
    const unknown = [...SCRIPTS, ...PROSE].flatMap((path) =>
      [...new Set(read(path).match(TOOL_SHAPED) ?? [])]
        .filter((name) => !ALLOWED.has(name))
        .map((name) => `${relative(REPO, path)}: ${name}`),
    );
    expect(unknown).toEqual([]);
  });

  test("no retired tool name appears anywhere in them", () => {
    const hits = [...SCRIPTS, ...PROSE].flatMap((path) =>
      RETIRED.filter((name) => read(path).includes(name)).map((name) => `${relative(REPO, path)}: ${name}`),
    );
    expect(hits).toEqual([]);
  });

  test("nothing speaks the retired protocol", () => {
    const hits = [...SCRIPTS, ...PROSE].flatMap((path) => {
      const text = read(path).toLowerCase();
      return OLD_PROTOCOL.filter((needle) => text.includes(needle)).map((needle) => `${relative(REPO, path)}: ${needle}`);
    });
    expect(hits).toEqual([]);
  });

  test("the protocol revision is written in one place in the scripts", () => {
    const holders = SCRIPTS.filter((path) => read(path).includes(PROTOCOL)).map((path) => relative(REPO, path));
    expect(holders).toEqual(["skills/index-network/scripts/index-mcp.ts"]);
  });
});
