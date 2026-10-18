// Deterministic checks for the DreamStarter mini-app bundle. No network, no model, no daemon.
// Run with: bun test submission/tests
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "mini-apps/dreamstarter/manifest.json"), "utf8"));
const skill = readFileSync(join(root, "skills/dreamstarter/SKILL.md"), "utf8");

const REVIEWED_TOOLS = ["discover_dreams", "dream_status", "list_workflows"];

describe("manifest", () => {
  test("identity and operations are exact", () => {
    expect(manifest.id).toBe("dreamstarter");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.skills).toEqual(["dreamstarter"]);
    expect(manifest.operations).toEqual(["mini-app.read"]);
    expect(manifest.mcp.url).toBe("https://mcp.dreamstarter.xyz/mcp");
    expect(manifest.mcp.url.startsWith("https://")).toBe(true);
  });

  test("only the three reviewed read tools, each strict", () => {
    const names = manifest.mcp.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(REVIEWED_TOOLS);
    for (const tool of manifest.mcp.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  test("permissions are all reads", () => {
    expect(manifest.permissions.length).toBeGreaterThan(0);
    for (const p of manifest.permissions) expect(p.kind).toBe("read");
  });

  test("no write-shaped tool names", () => {
    for (const t of manifest.mcp.tools) expect(t.name).not.toMatch(/create|send|delete|update|claim|pay|invite/);
  });
});

describe("input schemas", () => {
  const byName = Object.fromEntries(manifest.mcp.tools.map((t: { name: string }) => [t.name, t.inputSchema]));

  test("discover_dreams bounds the text it accepts", () => {
    const s = byName.discover_dreams;
    expect(s.required).toEqual(["about"]);
    expect(s.properties.about.maxLength).toBe(2000);
    expect(s.properties.interests.maxItems).toBe(12);
    expect(s.properties.goals.maxLength).toBe(1000);
    expect(s.properties.limit.maximum).toBe(3);
    expect(Object.keys(s.properties).sort()).toEqual(["about", "goals", "interests", "limit"]);
  });

  test("dream_status accepts only a lowercase token ref", () => {
    const re = new RegExp(byName.dream_status.properties.ref.pattern);
    expect(re.test("k7m2p9x4q1w8e5r3t6y0u2i4")).toBe(true);
    expect(re.test("K7M2P9X4Q1W8E5R3T6Y0U2I4")).toBe(false);
    expect(re.test("short")).toBe(false);
    expect(re.test("../etc/passwd")).toBe(false);
    expect(re.test("a".repeat(65))).toBe(false);
  });

  test("list_workflows takes nothing", () => {
    expect(byName.list_workflows.properties).toEqual({});
  });
});

describe("skill", () => {
  test("frontmatter matches the manifest", () => {
    expect(skill).toMatch(/^---\nname: dreamstarter\n/);
    expect(skill).toContain("version: 1.0.0");
  });

  test("calls go through the native village tool only", () => {
    expect(skill).toContain('"operation":"mini-app.read","appId":"dreamstarter"');
    expect(skill).not.toMatch(/curl |bearer [a-z0-9]|Authorization:/i);
    expect(skill).not.toContain("mcp.dreamstarter.xyz");
  });

  test("names only reviewed tools", () => {
    const mentioned = [...skill.matchAll(/"tool":"([a-z_]+)"/g)].map((m) => m[1]);
    for (const name of mentioned) expect(REVIEWED_TOOLS).toContain(name);
  });

  test("requires consent before the first call", () => {
    expect(skill).toMatch(/ask for a yes/i);
    expect(skill).toMatch(/Send nothing until they agree/);
  });
});
