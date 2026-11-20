// Deterministic checks for the DreamStarter mini-app bundle (2.0.0, nine tools: seven reads, two owner-asked writes).
// Written by the DreamStarter team for Edge-City/agentvillage#393 (arrfire); adapted to the reviewed-app path. No
// network, no model, no daemon. Run with: bun test scripts/tests/dreamstarter-bundle.test.ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEWED_MINI_APPS } from "../../install/install_miniapps";

const root = join(import.meta.dir, "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "mini-apps/dreamstarter/manifest.json"), "utf8"));
const skillBytes = readFileSync(join(root, "skills/dreamstarter/SKILL.md"));
const skill = skillBytes.toString("utf8");
const plugin = readFileSync(join(root, "plugins/village-bridge/_mini_apps.py"), "utf8");

const REVIEWED_TOOLS = ["discover_dreams", "dream_status", "list_workflows", "grant_requirements", "grant_prepare", "grant_status", "list_businesses", "business_brief", "business_status"];
const REVIEWED_OPS = REVIEWED_TOOLS.map((t) => `dreamstarter.${({ discover_dreams: "discover", list_workflows: "workflows", list_businesses: "businesses" } as Record<string, string>)[t] ?? t}`);
const WRITES = ["dreamstarter.discover", "dreamstarter.grant_prepare"];
const REF = "^[a-z0-9]{20,64}$";
const SLUG = "^[a-z0-9-]{3,40}$";

describe("manifest (v2)", () => {
  test("identity, service and visibility are exact", () => {
    expect(manifest.manifest).toBe(2);
    expect(manifest.id).toBe("dreamstarter");
    expect(manifest.version).toBe("2.0.0");
    expect(manifest.visibility).toBe("sandbox");
    expect(manifest.owner).toEqual({ github: "arrfire", org: "DreamStarter" });
    // app-token: the reviewed path (a relay app, auth none, may carry only reads). The key is set on the cp, never here.
    expect(manifest.service).toEqual({ kind: "mcp", baseUrl: "https://mcp.dreamstarter.xyz/mcp", auth: { mode: "app-token", secretRef: "MINI_APP_DREAMSTARTER_KEY" } });
    expect(manifest.skills).toEqual([{ name: "dreamstarter", version: "2.0.0", sha256: createHash("sha256").update(skillBytes).digest("hex"), path: "skills/dreamstarter/SKILL.md" }]);
  });

  test("exactly the nine reviewed operations, in order: the two sends are writes, the rest reads, each strict", () => {
    expect(manifest.operations.map((o: { name: string }) => o.name)).toEqual(REVIEWED_OPS);
    expect(manifest.operations.map((o: { target: { tool: string } }) => o.target.tool)).toEqual(REVIEWED_TOOLS);
    for (const op of manifest.operations) {
      expect([op.name, op.class]).toEqual([op.name, WRITES.includes(op.name) ? "write" : "read"]);
      expect(op.input.type).toBe("object");
      expect(op.input.additionalProperties).toBe(false);
      expect(op.timeoutMs).toBeLessThanOrEqual(25000);
      expect(op.maxResponseBytes).toBeLessThanOrEqual(262144);
      expect(op.name).not.toMatch(/create|send|delete|update|claim|pay|invite|submit/);
    }
  });

  test("the installer and the box carry the manifest's exact projection", () => {
    const app = REVIEWED_MINI_APPS.find((a) => a.id === "dreamstarter")!;
    expect({ ...app, operations: [...app.operations], skills: [...app.skills] }).toEqual({ id: "dreamstarter", version: "2.0.0", operations: REVIEWED_OPS, skills: ["dreamstarter"] });
    expect(plugin).toContain('DS_WRITE_OPERATIONS = ("dreamstarter.discover", "dreamstarter.grant_prepare")');
    expect(plugin).toContain('"dreamstarter": (DREAMSTARTER,)');
  });

  test("permissions name what leaves the box, who keeps it, and the processors", () => {
    expect(manifest.permissions.map((p: { kind: string }) => p.kind)).toEqual(["action", "action", "read", "read", "read"]);
    const [discover, grant] = manifest.permissions.map((p: { description: string }) => p.description);
    expect(discover).toMatch(/lines you type for that\s+one request/);
    expect(discover).toMatch(/Google Gemini/);
    expect(discover).toMatch(/Nothing from your profile, memory or other chats is sent/);
    expect(discover).toMatch(/DreamStarter does not store or log your lines; it keeps only the suggestions, and deletes ones nobody claims after 14 days/);
    expect(discover).not.toMatch(/discovery session/);
    expect(grant).toMatch(/You can delete the draft there at once; otherwise it is deleted 14 days after its last edit/);
    expect(grant).toMatch(/Nothing reaches ElevenLabs until you accept the terms and click Submit/);
    expect(grant).toMatch(/ElevenLabs' live grant form/);
    expect(grant).toMatch(/proof-of-submission screenshot for 30 days/);
    for (const text of [discover, grant, manifest.description]) {
      expect(text).toMatch(/Privacy: https:\/\/mcp\.dreamstarter\.xyz\/privacy$/);
    }
    expect(manifest.description).toMatch(/Google Gemini/);
    expect(manifest.description).toMatch(/keeps only the suggestions, never the lines/);
    expect(manifest.description).not.toMatch(/discovery session/);
    expect(manifest.description).not.toMatch(/Read-only|nothing is created/i);
  });

  test("canonical JSON", () => {
    const raw = readFileSync(join(root, "mini-apps/dreamstarter/manifest.json"), "utf8");
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + "\n");
  });
});

describe("input schemas (byte-equal to DreamStarter's tools/list at serverInfo 1.1.0)", () => {
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
    expect(skill).toContain("\nversion: 2.0.0\n");
    expect(skillBytes.length).toBeLessThanOrEqual(32768);
    expect(skill.endsWith("\n")).toBe(true);
    const front = skill.slice(4, skill.indexOf("\n---\n", 4));
    expect(/^[\x20-\x7e\n]*$/.test(front)).toBe(true);
  });

  test("calls go through the native village tool's named operations only", () => {
    expect(skill).toContain('{"operation":"dreamstarter.discover","arguments":{');
    expect(skill).toContain('{"operation":"dreamstarter.grant_prepare","arguments":{');
    expect(skill).not.toContain('"operation":"mini-app.read"');
    expect(skill).not.toMatch(/curl |wget |bearer [a-z0-9]|Authorization:/i);
    expect(skill).not.toContain("mcp.dreamstarter.xyz");
    for (const op of REVIEWED_OPS) expect([op, skill.includes("`" + op + "`")]).toEqual([op, true]);
  });

  test("names only reviewed tools", () => {
    const mentioned = new Set([...skill.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => /^(discover_|dream_status|list_|grant_(requirements|prepare|status)|business_(brief|status))/.test(n)));
    for (const name of mentioned) expect(REVIEWED_TOOLS).toContain(name);
  });

  test("M2: discovery sends only the lines typed for that request, names Gemini, and asks first", () => {
    expect(skill).toMatch(/Use only what they type for this request/);
    expect(skill).toMatch(/Do not fill it in from their\s+profile, from memory or from earlier messages/);
    expect(skill).toMatch(/passes them to Google\s+Gemini to suggest dreams/);
    expect(skill).toMatch(/does not store or log your lines; it keeps\s+only the suggestions/);
    expect(skill).not.toMatch(/discovery session/);
    expect(skill).toMatch(/Send nothing until a later message from the\s+owner says yes/);
  });

  test("M1: the grant shows every field, names the 14-day draft and the live ElevenLabs submit, and asks first", () => {
    expect(skill).toMatch(/show every field you will send, one per line with its value/);
    expect(skill).toMatch(/You\s+can delete the draft there at once; otherwise it is deleted 14 days after\s+its last edit/);
    expect(skill).toMatch(/DreamStarter then submits the application to\s+ElevenLabs' live grant form/);
    expect(skill).toMatch(/proof-of-submission screenshot for 30 days/);
    expect(skill).toMatch(/then send exactly what they saw/);
  });

  test("private chat only, resident acts, progress honest", () => {
    expect(skill).toMatch(/never in a group, a scheduled\s+job or a delegated task/);
    expect(skill).toMatch(/You never sign in,\s+submit the application, accept terms or click anything for the owner/);
    expect(skill).toMatch(/never look up or pass on anyone's contact details/);
    expect(skill).toMatch(/Do not invent dreams, progress/);
    expect(skill).toMatch(/`simulated: true` is a labelled preview/);
  });
});
