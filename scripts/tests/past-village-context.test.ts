import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EDGE_SKILL_NAMES, RETIRED_SKILL_DIRS } from "../../install/paths";
import { welcomeText } from "../../skills/index-network/scripts/welcome";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const active = [
  "workspace/AGENTS.md", "workspace/SOUL.md",
  ...EDGE_SKILL_NAMES.map((name) => `skills/${name}/SKILL.md`),
  ...readdirSync(join(root, "skills/index-network/prompts"))
    .filter((name) => name.endsWith(".md")).map((name) => `skills/index-network/prompts/${name}`),
  "skills/index-network/exemplars.md", "skills/agent-plaza/prompts/selfie.md",
  "skills/kismet/SKILL.md", "skills/favorloop/SKILL.md", "skills/library/SKILL.md", "skills/zzzbot/SKILL.md",
];
const currentEventClaims = [
  /(?:current|live) event (?:is |— |: )?\*{0,2}Edge City India/i,
  /knowledge for the current event/i,
  /complete, live Edge City India schedule/i,
  /Welcome to Edge City India/i,
  /You are (?:Edge, )?the user's agent for Edge City India/i,
];

describe("past-village runtime contract", () => {
  test("runtime context and local India skill explicitly identify the ended event", () => {
    for (const path of ["workspace/AGENTS.md", "workspace/SOUL.md", "skills/edge-india/SKILL.md"]) {
      const text = read(path).replaceAll("*", "");
      expect(text).toContain("October 11 to November 1, 2026");
      expect(text).toContain("has ended");
      expect(text).toContain("current availability");
    }
  });

  test("shipped and optional runtime prompts never frame India as the current event", () => {
    for (const path of [...new Set(active)]) {
      for (const claim of currentEventClaims) expect(read(path), `${path}: ${claim}`).not.toMatch(claim);
      expect(read(path), path).not.toContain("skills/edge-esmeralda/SKILL.md");
    }
  });

  test("all intent entry points require current support rather than carrying old village plans forward", () => {
    for (const path of ["workspace/AGENTS.md", "workspace/SOUL.md", "skills/index-network/SKILL.md",
      "skills/index-network/tools.md", "skills/record-intention/SKILL.md", "skills/index-network/prompts/memory-signals.md"]) {
      const text = read(path);
      expect(text, path).toContain("what the resident wants now");
      expect(text, path).toMatch(/Never carry (?:plans from )?India|Never carry plans from India/);
      expect(text, path).toContain("consent and approval rules");
      expect(text, path).toMatch(/not automatically change existing intents/);
    }
  });

  test("actual welcome preserves the agent name and does not welcome arrivals to an ended event", () => {
    const text = welcomeText("Juniper", { kind: "unreachable" }, "https://agents.edgecity.live/intents");
    expect(text).toContain("Welcome to Agent Village");
    expect(text).toContain("I'm Juniper, your personal agent in Agent Village");
    expect(text).not.toContain("Welcome to Edge City India");
    expect(text).not.toContain("What events are happening tomorrow?");
  });

  test("privacy and current-context guards survive outside the Red lines", () => {
    expect(read("workspace/AGENTS.md")).toContain("share private info without opt-in");
    expect(read("workspace/AGENTS.md")).toContain("Do not imply the resident is still in Goa");
    const tools = read("skills/index-network/tools.md");
    expect(tools).toContain("Require current support from the resident");
    expect(tools).toContain("If only historical material supports it, ask whether it still reflects what they want now");
    const brief = read("skills/index-network/prompts/brief.md");
    expect(brief).toContain("never imply the ended India village has a current schedule to obtain");
    expect(brief).toContain("Do not fill gaps with historical events");
  });

  test("Kismet identifies its India origin as historical and uses current service facts", () => {
    const text = read("skills/kismet/SKILL.md");
    const introduction = text.split("## What Kismet is\n\n")[1].split("Matching is")[0];
    expect(introduction).toContain("matchmaker for the Agent Village community, originally introduced");
    expect(introduction).toContain("October 11 to November 1, 2026), which has\nended");
    expect(introduction).not.toContain("is a matchmaker for Edge City India");
    expect(text).toContain("Use the installed service's returned facts for its current capabilities");
    expect(text).toContain("never assume residents are still in Goa");
    expect(text).toContain("infer a current area in Goa from historical signup answers");
    expect(text).toContain("That historical schedule is not a current promise");
    expect(text).toContain("confirm any present arrangement from the service and the owner's current plans");
  });

  test("Esmeralda is retired while historical archives and sharing labels remain intact", () => {
    expect(EDGE_SKILL_NAMES as readonly string[]).not.toContain("edge-esmeralda");
    expect(RETIRED_SKILL_DIRS as readonly string[]).toContain("edge-esmeralda");
    expect(read("skills/edge-esmeralda/SKILL.md")).toContain("Esmeralda");
    expect(read("skills/index-network/tools.md")).toContain("(Edge City India 2026)");
    expect(read("skills/edge-india/references/SNAPSHOT.json")).toContain("sha256");
  });
});
