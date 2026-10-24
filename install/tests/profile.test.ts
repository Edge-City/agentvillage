import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "agentvillage-profile-"));
process.env.HERMES_HOME = home; // before reset.ts reads it
const { installProfileIdentity, resolveProfile, renderOdinSoul, NO_CONSTITUTION_LINE } = await import("../profile");
const { removeProjectFiles, removeSoulFile } = await import("../reset");

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), "../../workspace");
const read = (name: string) => readFileSync(join(home, name), "utf8");

afterEach(() => {
  for (const f of ["SOUL.md", "AGENTS.md", "USER.md", "constitution.md", ".env"]) rmSync(join(home, f), { force: true });
});

test("AV_PROFILE defaults to resident, accepts odin, rejects others", () => {
  expect(resolveProfile({})).toBe("resident");
  expect(resolveProfile({ AV_PROFILE: " " })).toBe("resident");
  expect(resolveProfile({ AV_PROFILE: "resident" })).toBe("resident");
  expect(resolveProfile({ AV_PROFILE: "odin" })).toBe("odin");
  expect(() => resolveProfile({ AV_PROFILE: "thor" })).toThrow();
});

test("AV_PROFILE falls back to $HERMES_HOME/.env, process env wins, unknown value throws", () => {
  writeFileSync(join(home, ".env"), "OTHER=1\nAV_PROFILE=odin\n");
  expect(resolveProfile({})).toBe("odin");
  expect(resolveProfile({ AV_PROFILE: "resident" })).toBe("resident");
  writeFileSync(join(home, ".env"), "AV_PROFILE='Odin'\n");
  expect(resolveProfile({})).toBe("odin");
  writeFileSync(join(home, ".env"), "AV_PROFILE=thor\n");
  expect(() => resolveProfile({})).toThrow();
  expect(resolveProfile({ AV_PROFILE: "odin" })).toBe("odin");
});

test("a leading '## Village constitution' heading in the export is dropped; the export shape splices once", () => {
  writeFileSync(
    join(home, "constitution.md"),
    "## Village constitution\n\n<!-- constitution: v1 -->\n\n### Section\n\n1. rule\n",
  );
  installProfileIdentity(WORKSPACE, home, "odin");
  const soul = read("SOUL.md");
  expect(soul.match(/## Village constitution/g)).toHaveLength(1);
  expect(soul).toContain("## Village constitution\n\n<!-- constitution: v1 -->\n\n### Section\n\n1. rule\n");
  // Only a leading heading is dropped.
  expect(renderOdinSoul("{{CONSTITUTION}}", home)).toBe("<!-- constitution: v1 -->\n\n### Section\n\n1. rule");
  writeFileSync(join(home, "constitution.md"), "Preamble\n\n## Village constitution\n");
  expect(renderOdinSoul("{{CONSTITUTION}}", home)).toBe("Preamble\n\n## Village constitution");
});

test("resident profile copies the resident SOUL.md byte for byte and writes no AGENTS.md itself", () => {
  const written = installProfileIdentity(WORKSPACE, home, "resident");
  expect(written).toEqual(["SOUL.md"]);
  expect(read("SOUL.md")).toBe(readFileSync(join(WORKSPACE, "SOUL.md"), "utf8"));
  expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
});

test("odin profile installs ODIN's SOUL.md and AGENTS.md, not the resident ones", () => {
  expect(installProfileIdentity(WORKSPACE, home, "odin")).toEqual(["SOUL.md", "AGENTS.md"]);
  expect(read("SOUL.md")).toContain("You are ODIN");
  expect(read("SOUL.md")).not.toContain("Edge");
  expect(read("AGENTS.md")).toBe(readFileSync(join(WORKSPACE, "odin/AGENTS.md"), "utf8"));
});

test("constitution absent: the section holds the single placeholder line", () => {
  installProfileIdentity(WORKSPACE, home, "odin");
  const soul = read("SOUL.md");
  expect(soul.endsWith(`## Village constitution\n\n${NO_CONSTITUTION_LINE}\n`)).toBe(true);
  expect(soul).not.toContain("{{CONSTITUTION}}");
});

test("constitution present: its text is spliced in, verbatim, even with $ sequences", () => {
  writeFileSync(join(home, "constitution.md"), "Article 1. Be kind $& $1.\nArticle 2. Be brief.\n");
  installProfileIdentity(WORKSPACE, home, "odin");
  const soul = read("SOUL.md");
  expect(soul).toContain("## Village constitution\n\nArticle 1. Be kind $& $1.\nArticle 2. Be brief.\n");
  expect(soul).not.toContain(NO_CONSTITUTION_LINE);
});

test("an empty constitution.md counts as absent", () => {
  writeFileSync(join(home, "constitution.md"), "  \n");
  expect(renderOdinSoul("x\n{{CONSTITUTION}}\n", home)).toBe(`x\n${NO_CONSTITUTION_LINE}\n`);
});

test("--preserve-context keeps existing files", () => {
  writeFileSync(join(home, "SOUL.md"), "mine");
  writeFileSync(join(home, "AGENTS.md"), "mine");
  expect(installProfileIdentity(WORKSPACE, home, "odin", true)).toEqual([]);
  expect(read("SOUL.md")).toBe("mine");
});

test("the shipped ODIN files carry no constitution text and one splice point", () => {
  const soul = readFileSync(join(WORKSPACE, "odin/SOUL.md"), "utf8");
  expect(soul.split("{{CONSTITUTION}}").length).toBe(2);
  expect(soul.trimEnd().endsWith("{{CONSTITUTION}}")).toBe(true);
});

// ODIN-SOUL-TEMPLATE-v1's fixed sections, in the template's order. "The fixed sections win any conflict"
// (its "How you resolve conflicts", rule 1), so they must survive every install and roll.
const TEMPLATE_V1_FIXED_HEADINGS = [
  "Who you are",
  "Safety and harm floor",
  "Privacy and consent floor",
  "Tools and actions",
  "Honesty",
  "How you resolve conflicts",
];
// sha256 of ODIN-SOUL-TEMPLATE-v1's text before its "## Village constitution" heading (title + fixed sections).
const TEMPLATE_V1_FIXED_SHA256 = "444fedd349b764a50beb9544c0d765fa5606e3334d3814f840daf2353cb987b3";

test("installed ODIN SOUL.md carries every template-v1 fixed heading exactly once, in order, then the constitution", () => {
  const constitution = "<!-- constitution: v1 -->\n\n### Care and wellbeing\n\n1. rule one\n\n### Limits\n\n2. rule two";
  writeFileSync(join(home, "constitution.md"), `## Village constitution\n\n${constitution}\n`);
  installProfileIdentity(WORKSPACE, home, "odin");
  const soul = read("SOUL.md");
  const headings = [...soul.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  for (const h of TEMPLATE_V1_FIXED_HEADINGS) expect(headings.filter((x) => x === h)).toHaveLength(1);
  const positions = TEMPLATE_V1_FIXED_HEADINGS.map((h) => headings.indexOf(h));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(positions[0]).toBe(0); // nothing above the fixed sections
  // The constitution is the last section and renders unchanged.
  expect(headings.at(-1)).toBe("Village constitution");
  expect(Math.max(...positions)).toBeLessThan(headings.length - 1);
  expect(soul.endsWith(`## Village constitution\n\n${constitution}\n`)).toBe(true);
});

test("ODIN SOUL.md's fixed sections are template v1 byte for byte (only 'How you speak' sits between them and the constitution)", () => {
  const soul = readFileSync(join(WORKSPACE, "odin/SOUL.md"), "utf8");
  const before = soul.slice(0, soul.indexOf("## Village constitution\n"));
  const speak = before.indexOf("## How you speak\n");
  expect(speak).toBeGreaterThan(0);
  expect(before.slice(speak).match(/^## /gm)).toHaveLength(1); // the overlay's own section is the last before the slot
  const fixed = before.slice(0, speak);
  expect(createHash("sha256").update(fixed).digest("hex")).toBe(TEMPLATE_V1_FIXED_SHA256);
});

test("reset removes the same files after an odin install and leaves constitution.md", () => {
  writeFileSync(join(home, "constitution.md"), "Article 1.");
  installProfileIdentity(WORKSPACE, home, "odin");
  removeSoulFile();
  removeProjectFiles(false);
  expect(existsSync(join(home, "SOUL.md"))).toBe(false);
  expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(home, "constitution.md"))).toBe(true);
});

test("a full odin install (no Index key, no flags) runs, and installs no resident-only piece or cron", () => {
  const box = mkdtempSync(join(tmpdir(), "agentvillage-odin-box-"));
  try {
    mkdirSync(box, { recursive: true });
    writeFileSync(join(box, ".env"), "AV_PROFILE=odin\n"); // as the control plane writes it
    const env = { ...process.env, HERMES_HOME: box };
    delete env.AV_PROFILE;
    delete env.INDEX_API_KEY;
    const run = spawnSync("bun", [join(WORKSPACE, "../install/install.ts"), "--no-restart"], { env, encoding: "utf8", timeout: 15000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("(profile odin)");
    expect(run.stdout).toContain("index network: not installed (profile odin)");
    const config = readFileSync(join(box, "config.yaml"), "utf8");
    for (const name of ["village-bridge", "av-vote", "index-links", "index-network"]) expect(config).not.toContain(name);
    expect(config).toContain("av-events");
    const env2 = readFileSync(join(box, ".env"), "utf8");
    expect(env2).not.toMatch(/INDEX_API_KEY|EDGEOS_/);
    expect(existsSync(join(box, "index"))).toBe(false);
    // Cron list: no Edge resident cron jobs.
    const jobs = join(box, "cron", "jobs.json");
    const listed = existsSync(jobs) ? readFileSync(jobs, "utf8") : "";
    expect(listed).not.toMatch(/Index|Edge/);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});
