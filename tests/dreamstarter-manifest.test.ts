// Deterministic checks for the DreamStarter mini-app bundle (v1.1.0, nine tools). No network, no model, no daemon.
// Run with: bun test submission/tests
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "mini-apps/dreamstarter/manifest.json"), "utf8"));
const skillBytes = readFileSync(join(root, "skills/dreamstarter/SKILL.md"));
const skill = skillBytes.toString("utf8");

const REVIEWED_TOOLS = ["discover_dreams", "dream_status", "list_workflows", "grant_requirements", "grant_prepare", "grant_status", "list_businesses", "business_brief", "business_status"];
const REVIEWED_OPS = REVIEWED_TOOLS.map((t) => `dreamstarter.${({ discover_dreams: "discover", list_workflows: "workflows", list_businesses: "businesses" } as Record<string, string>)[t] ?? t}`);
const REF = "^[a-z0-9]{20,64}$";
const SLUG = "^[a-z0-9-]{3,40}$";

describe("manifest (v2)", () => {
  test("identity, service and visibility are exact", () => {
    expect(manifest.manifest).toBe(2);
    expect(manifest.id).toBe("dreamstarter");
    expect(manifest.version).toBe("1.1.0");
    expect(manifest.visibility).toBe("everyone");
    expect(manifest.service).toEqual({ kind: "mcp", baseUrl: "https://mcp.dreamstarter.xyz/mcp", auth: { mode: "none" } });
    expect(manifest.skills).toEqual([{ name: "dreamstarter", version: "1.1.0", sha256: createHash("sha256").update(skillBytes).digest("hex"), path: "skills/dreamstarter/SKILL.md" }]);
  });

  test("exactly the nine reviewed read operations, in order, each strict", () => {
    expect(manifest.operations.map((o: { name: string }) => o.name)).toEqual(REVIEWED_OPS);
    expect(manifest.operations.map((o: { target: { tool: string } }) => o.target.tool)).toEqual(REVIEWED_TOOLS);
    for (const op of manifest.operations) {
      expect(op.class).toBe("read");
      expect(op.input.type).toBe("object");
      expect(op.input.additionalProperties).toBe(false);
      expect(op.timeoutMs).toBeLessThanOrEqual(25000);
      expect(op.maxResponseBytes).toBeLessThanOrEqual(262144);
      expect(op.name).not.toMatch(/create|send|delete|update|claim|pay|invite|submit/);
    }
  });

  test("permissions are all reads and name what leaves the box", () => {
    expect(manifest.permissions.length).toBeGreaterThanOrEqual(4);
    for (const p of manifest.permissions) expect(p.kind).toBe("read");
    const all = manifest.permissions.map((p: { description: string }) => p.description).join(" ");
    expect(all).toMatch(/nothing is created on DreamStarter until the resident opens a claim link/);
    expect(all).toMatch(/Nothing reaches ElevenLabs until the resident accepts the terms/);
  });

  test("canonical JSON", () => {
    const raw = readFileSync(join(root, "mini-apps/dreamstarter/manifest.json"), "utf8");
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + "\n");
  });
});

describe("input schemas", () => {
  const byTool = Object.fromEntries(manifest.operations.map((o: { target: { tool: string }; input: unknown }) => [o.target.tool, o.input]));

  test("discover_dreams bounds the text it accepts", () => {
    const s = byTool.discover_dreams;
    expect(s.required).toEqual(["about"]);
    expect(s.properties.about.maxLength).toBe(2000);
    expect(s.properties.interests.maxItems).toBe(12);
    expect(s.properties.goals.maxLength).toBe(1000);
    expect(s.properties.limit.maximum).toBe(3);
    expect(Object.keys(s.properties).sort()).toEqual(["about", "goals", "interests", "limit"]);
  });

  test("refs are lowercase tokens only", () => {
    for (const t of ["dream_status", "grant_status"]) {
      expect(byTool[t].required).toEqual(["ref"]);
      expect(byTool[t].properties.ref.pattern).toBe(REF);
    }
    const re = new RegExp(REF);
    expect(re.test("k7m2p9x4q1w8e5r3t6y0u2i4")).toBe(true);
    expect(re.test("K7M2P9X4Q1W8E5R3T6Y0U2I4")).toBe(false);
    expect(re.test("short")).toBe(false);
    expect(re.test("../etc/passwd")).toBe(false);
    expect(re.test("a".repeat(65))).toBe(false);
  });

  test("empty-input tools take nothing", () => {
    for (const t of ["list_workflows", "grant_requirements", "list_businesses"]) expect(byTool[t].properties).toEqual({});
  });

  test("grant_prepare bounds every string, nests strictly and has no identity slot", () => {
    const s = byTool.grant_prepare;
    expect(s.required).toEqual(["company"]);
    expect(Object.keys(s.properties).sort()).toEqual(["applicant", "company", "dream_ref", "eligibility"]);
    for (const section of ["applicant", "company", "eligibility"]) {
      expect(s.properties[section].additionalProperties).toBe(false);
      for (const [k, v] of Object.entries<Record<string, unknown>>(s.properties[section].properties)) {
        expect(k).not.toMatch(/telegram|nickname|attendee|tenant|handle|password|token/i);
        if (v.type === "string") expect(typeof v.maxLength).toBe("number");
      }
    }
    expect(s.properties.company.required).toEqual(["name"]);
    expect(s.properties.company.properties.product_description.maxLength).toBe(3000);
    expect(s.properties.dream_ref.pattern).toBe(REF);
  });

  test("business tools accept only a slug", () => {
    for (const t of ["business_brief", "business_status"]) {
      expect(byTool[t].required).toEqual(["slug"]);
      expect(Object.keys(byTool[t].properties)).toEqual(["slug"]);
      expect(byTool[t].properties.slug.pattern).toBe(SLUG);
    }
    const re = new RegExp(SLUG);
    expect(re.test("inspire-by-neha")).toBe(true);
    expect(re.test("Inspire")).toBe(false);
    expect(re.test("../etc")).toBe(false);
  });
});

describe("skill", () => {
  test("frontmatter matches the manifest and is well formed", () => {
    expect(skill.startsWith("---\nname: dreamstarter\n")).toBe(true);
    expect(skill).toContain("\nversion: 1.1.0\n");
    expect(skillBytes.length).toBeLessThanOrEqual(32768);
    expect(skill.endsWith("\n")).toBe(true);
  });

  test("calls go through the native village tool only", () => {
    expect(skill).toContain('"operation":"mini-app.read","appId":"dreamstarter"');
    expect(skill).not.toMatch(/curl |bearer [a-z0-9]|Authorization:/i);
    expect(skill).not.toContain("mcp.dreamstarter.xyz");
  });

  test("names only reviewed tools, and all of them", () => {
    const mentioned = new Set([...skill.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => /^(discover_|dream_status|list_|grant_(requirements|prepare|status)|business_(brief|status))/.test(n)));
    for (const name of mentioned) expect(REVIEWED_TOOLS).toContain(name);
    for (const name of REVIEWED_TOOLS) expect(mentioned.has(name)).toBe(true);
  });

  test("consent first, resident acts, progress honest", () => {
    expect(skill).toMatch(/ask for a yes/i);
    expect(skill).toMatch(/Send nothing until they agree/);
    expect(skill).toMatch(/You never submit the grant application, accept terms, or click\s+anything for the owner/);
    expect(skill).toMatch(/do not look up or pass on any owner's personal contact\s+details/);
    expect(skill).toMatch(/Do not invent dreams, progress/);
  });
});
