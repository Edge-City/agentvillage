import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as R from "../mini-apps-review";

// Mini-apps v2 Phase 0, P0-3 (MINIAPPS-PLATFORM-v2-design.md §5, §6.1, §6.3): the deterministic review.
// Every fixture is invented (the app "tinyshop", its skill, its secrets); the only real inputs are the
// five published manifests, run as a no-change pull request at the end. The secret shapes are built by
// concatenation so this file holds no literal token.
//   bun test scripts/tests/mini-apps-review.test.ts

const REPO = join(import.meta.dir, "..", "..");
const V = R.loadValidator(REPO);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const SKILL = "---\nname: tinyshop\ndescription: An invented shop used only by these tests.\nversion: 1.0.0\nauthor: Test\n---\n\n# Tiny Shop\n\nUse the village tool only.\n";
function manifest(visibility = "sandbox"): any {
  return {
    manifest: 2, id: "tinyshop", name: "Tiny Shop", version: "1.0.0", description: "An invented shop used only by these tests.",
    homepage: "https://tinyshop.example.org", visibility,
    permissions: [{ kind: "read", label: "Read the menu", description: "Read the invented menu." }],
    service: { kind: "https-json", baseUrl: "https://api.tinyshop.example.org/v1", auth: { mode: "app-token", secretRef: "MINI_APP_TINYSHOP_TOKEN" } },
    operations: [
      { name: "tinyshop.menu", class: "read" },
      { name: "tinyshop.order.prepare", class: "prepare" },
      { name: "tinyshop.order.confirm", class: "needs-card", maxRequestBytes: 65536, timeoutMs: 60000, approval: { prepare: "tinyshop.order.prepare" } },
    ],
    skills: [{ name: "tinyshop", version: "1.0.0", sha256: sha256(SKILL), path: "skills/tinyshop/SKILL.md" }],
  };
}
const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
const MP = "mini-apps/tinyshop/manifest.json", SP = "skills/tinyshop/SKILL.md", CP = "mini-apps/tinyshop/conformance.json";
const CATALOG = json({ catalog: 2, apps: ["tinyshop"] });
type Files = Record<string, string | null>;
const baseFiles = (m = manifest()): Files => ({ "mini-apps/catalog.json": CATALOG, [MP]: json(m), [SP]: SKILL });

/** An in-memory pull request: base and head file maps (null deletes), modes optional; `tip` is what the base branch gained after the fork. */
function source(base: Files, head: Files, opts: { author?: string; modes?: Record<string, string>; conf?: R.ConformanceRun; tip?: Files } = {}): R.Source {
  const after: Files = { ...base, ...head };
  const files: R.Change[] = [];
  for (const path of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const b = base[path] ?? null, h = after[path] ?? null;
    if (b === h) continue;
    files.push({ path, status: b === null ? "A" : h === null ? "D" : "M", oldMode: b === null ? "000000" : "100644", newMode: h === null ? "000000" : opts.modes?.[path] ?? "100644" });
  }
  const blob = (map: Files) => (path: string) => (map[path] == null ? null : Buffer.from(map[path]!));
  return {
    files, base: blob(base), head: blob(after), headSha: "f".repeat(40), author: opts.author ?? "someone",
    ...(opts.conf ? { conformance: () => opts.conf! } : {}),
    ...(opts.tip ? { baseTip: blob({ ...base, ...opts.tip }) } : {}),
    added: path => {
      const old = new Set((base[path] ?? "").split("\n"));
      return (after[path] ?? "").split("\n").map((text, i) => ({ line: i + 1, text })).filter(l => !old.has(l.text));
    },
  };
}
/** Review a change to the tinyshop manifest: `edit` mutates a copy of the base manifest. */
function pr(edit: (m: any) => void, o: { base?: any; extra?: Files; skill?: string; author?: string; modes?: Record<string, string>; conf?: R.ConformanceRun | ((head: any) => R.ConformanceRun); tip?: Files } = {}) {
  const b = o.base ?? manifest();
  const h = clone(b);
  edit(h);
  const head: Files = { [MP]: json(h), ...(o.skill !== undefined ? { [SP]: o.skill } : {}), ...(o.extra ?? {}) };
  const conf = typeof o.conf === "function" ? o.conf(h) : o.conf;
  return R.evaluate(source(baseFiles(b), head, { author: o.author, modes: o.modes, conf, tip: o.tip }), V);
}
const codes = (r: R.Report) => r.findings.map(f => f.code);
const has = (r: R.Report, code: string, severity?: string) => r.findings.some(f => f.code === code && (!severity || f.severity === severity));
const noM = (r: R.Report) => r.findings.filter(f => f.severity === "M").map(f => `${f.code} ${f.text}`);
const patch = (m: any) => { m.version = "1.0.1"; };
/** tinyshop as an MCP app: its needs-card op calls the tool place_order. */
function tooledManifest(visibility = "admins"): any {
  const m = manifest(visibility);
  m.service = { kind: "mcp", baseUrl: "https://mcp.tinyshop.example.org/mcp", auth: { mode: "none" } };
  m.operations = [
    { name: "tinyshop.menu", class: "read", target: { tool: "menu" } },
    { name: "tinyshop.order.prepare", class: "prepare", target: { tool: "quote" } },
    { name: "tinyshop.order.confirm", class: "needs-card", target: { tool: "place_order" }, maxRequestBytes: 65536, timeoutMs: 60000, approval: { prepare: "tinyshop.order.prepare" } },
  ];
  return m;
}
/** tinyshop as an https-json app: its needs-card op is POST /orders under https://api.tinyshop.example.org/v1. */
function pathedManifest(visibility = "admins"): any {
  const m = manifest(visibility);
  m.operations = [
    { name: "tinyshop.order.prepare", class: "prepare", target: { method: "POST", path: "/quote" } },
    { name: "tinyshop.order.confirm", class: "needs-card", target: { method: "POST", path: "/orders" }, maxRequestBytes: 65536, timeoutMs: 60000, approval: { prepare: "tinyshop.order.prepare" } },
  ];
  return m;
}
/** A second invented first-party app, on its own host. */
const OSKILL = "---\nname: othershop\ndescription: Another invented shop used only by these tests.\nversion: 1.0.0\nauthor: Test\n---\n\n# Other Shop\n\nUse the village tool only.\n";
const OMP = "mini-apps/othershop/manifest.json", OSP = "skills/othershop/SKILL.md";
function othershop(visibility = "admins"): any {
  return {
    manifest: 2, id: "othershop", name: "Other Shop", version: "1.0.0", description: "Another invented shop used only by these tests.",
    homepage: "https://othershop.example.org", visibility,
    permissions: [{ kind: "read", label: "Read the menu", description: "Read the invented menu." }],
    service: { kind: "https-json", baseUrl: "https://api.othershop.example.org/v1", auth: { mode: "app-token", secretRef: "MINI_APP_OTHERSHOP_TOKEN" } },
    operations: [{ name: "othershop.menu", class: "read", target: { method: "GET", path: "/menu" } }],
    skills: [{ name: "othershop", version: "1.0.0", sha256: sha256(OSKILL), path: OSP }],
  };
}
/** Both apps listed, as the base; a pull request that edits othershop's manifest only. */
const twoApps = (tiny: any, other: any): Files => ({ "mini-apps/catalog.json": json({ catalog: 2, apps: ["tinyshop", "othershop"] }), [MP]: json(tiny), [SP]: SKILL, [OMP]: json(other), [OSP]: OSKILL });
function onOther(edit: (m: any) => void, o: { tiny?: any; tip?: Files } = {}) {
  const b = othershop(), h = clone(b);
  edit(h);
  return R.evaluate(source(twoApps(o.tiny ?? pathedManifest(), b), { [OMP]: json(h) }, { tip: o.tip }), V);
}

describe("the fixture", () => {
  test("is a valid v2 manifest by the shared validator, so every finding below is the check under test", () => {
    expect(V.validateManifest(manifest()).errors ?? []).toEqual([]);
    expect(V.validateManifest(manifest("everyone")).errors ?? []).toEqual([]);
  });
});

describe("paths: the lane classifier", () => {
  const c = (...paths: string[]) => R.classify(paths.map(path => ({ path, status: "M", oldMode: "100644", newMode: "100644" })));
  test("one id's mini-apps/<id>/ and skills/<id>/ is a manifest lane; its lane is the manifest's visibility", () => {
    expect(c(MP, SP)).toEqual({ id: "tinyshop", core: [] });
    const r = pr(m => { m.description = "Reworded."; patch(m); });
    expect([r.lane, r.manifest, r.verdict]).toEqual(["sandbox", "tinyshop@1.0.1", "PASS"]);
    expect(pr(m => { m.description = "Reworded."; patch(m); }, { base: manifest("admins") }).lane).toBe("admins");
    expect(pr(m => { m.description = "Reworded."; patch(m); }, { base: manifest("everyone") }).lane).toBe("everyone");
  });
  test("two ids is core", () => {
    expect(c(MP, "mini-apps/other/manifest.json").id).toBeNull();
    expect(c(SP, "skills/other/SKILL.md").id).toBeNull();
    const r = pr(patch, { extra: { "skills/other/SKILL.md": "x\n" } });
    expect([r.lane, r.verdict, has(r, "multiple_apps", "S")]).toEqual(["core", "NEEDS_HUMAN", true]);
  });
  test("a skills/ change only is the app's lane (and its hash then has to match)", () => {
    expect(c(SP)).toEqual({ id: "tinyshop", core: [] });
    const edited = SKILL.replace("only.", "only, always.");
    const stale = pr(() => {}, { skill: edited });
    expect([stale.lane, stale.verdict, has(stale, "skill_hash_mismatch", "M")]).toEqual(["sandbox", "FAIL", true]);
    const synced = pr(m => { m.skills[0].sha256 = sha256(edited); patch(m); }, { skill: edited });
    expect([synced.verdict, noM(synced)]).toEqual(["PASS", []]);
  });
  test("a skills/ change for an id with no manifest is core; a baseline skill's id is core by name", () => {
    const ghost = R.evaluate(source(baseFiles(), { "skills/ghostapp/SKILL.md": "x\n" }), V);
    expect([ghost.lane, ghost.verdict, has(ghost, "no_manifest")]).toEqual(["core", "NEEDS_HUMAN", true]);
    const r = R.evaluate(source(baseFiles(), { "skills/rolodex/SKILL.md": "x\n" }), V);
    expect([r.lane, r.verdict, has(r, "baseline_skill", "S")]).toEqual(["core", "NEEDS_HUMAN", true]);
  });
  test("release S2: every baseline skill (install/paths.ts EDGE_SKILL_NAMES, gold-stars among them) is core, its manifest too", () => {
    const paths = readFileSync(join(REPO, "install/paths.ts"), "utf8");
    for (const name of R.BASELINE_SKILLS) expect([name, paths.includes(`"${name}"`)]).toEqual([name, true]);
    expect(R.BASELINE_SKILLS.has("gold-stars")).toBe(true);
    for (const name of R.BASELINE_SKILLS) {
      expect([name, c(`skills/${name}/SKILL.md`).id, c(`mini-apps/${name}/manifest.json`).id]).toEqual([name, null, null]);
      const r = R.evaluate(source(baseFiles(), { [`skills/${name}/SKILL.md`]: "x\n" }), V);
      expect([name, r.lane, r.verdict, has(r, "baseline_skill", "S"), noM(r)]).toEqual([name, "core", "NEEDS_HUMAN", true, []]);
    }
  });
  test("release N3: a baseline skill's other files (skills/edge-india/references/...) are core, never a false FAIL", () => {
    for (const path of ["skills/edge-india/references/SNAPSHOT.json", "skills/edge-india/scripts/x.ts", "skills/ghostapp/notes.md"]) {
      const r = R.evaluate(source(baseFiles(), { [path]: "{}\n" }), V);
      expect([path, r.lane, r.verdict, noM(r)]).toEqual([path, "core", "NEEDS_HUMAN", []]);
    }
    // An app's skill directory still holds SKILL.md only.
    expect(has(pr(patch, { extra: { "skills/tinyshop/references/x.json": "{}\n" } }), "path_unknown_file", "M")).toBe(true);
  });
  test("review-b N5: a submodule is M; an upper-case id is core; a lane file is matched whole, never by suffix", () => {
    const sub = pr(patch, { extra: { "mini-apps/tinyshop/README.md": "x\n" }, modes: { "mini-apps/tinyshop/README.md": "160000" } });
    expect([sub.verdict, sub.findings.find(f => f.code === "path_symlink")?.severity, sub.findings.find(f => f.code === "path_symlink")?.text]).toEqual(["FAIL", "M", "a submodule is never a reviewed catalog file"]);
    for (const path of ["mini-apps/TinyShop/manifest.json", "skills/TINYSHOP/SKILL.md", "mini-apps/tinyShop/README.md"]) expect([path, c(path).id]).toEqual([path, null]);
    for (const path of ["skills/tinyshop/sub/SKILL.md", "skills/tinyshop/NOTSKILL.md", "mini-apps/tinyshop/old-manifest.json", "mini-apps/tinyshop/x/README.md"]) {
      expect([path, has(pr(patch, { extra: { [path]: "x\n" } }), "path_unknown_file", "M")]).toEqual([path, true]);
    }
  });
  test("a script change is core; every gate file says so", () => {
    expect(c(MP, "scripts/mini-apps-review.ts").id).toBeNull();
    for (const gate of R.GATE_FILES) {
      const r = pr(patch, { extra: { [gate]: "changed\n" } });
      expect([gate, r.lane, r.verdict, has(r, "gate_changed")]).toEqual([gate, "core", "NEEDS_HUMAN", true]);
    }
  });
  test("the gate list is pinned here, not read back from the script (P0-1's and P0-5's gates included)", () => {
    expect([...R.GATE_FILES].sort()).toEqual([
      ".github/workflows/mini-apps-review.yml", "install/paths.ts", "mini-apps/catalog.json", "mini-apps/manifest.v2.schema.json", "mini-apps/manifests.pins.json",
      "package.json", "scripts/mini-apps-conformance.ts", "scripts/mini-apps-manifests.cjs", "scripts/mini-apps-review-comment.ts", "scripts/mini-apps-review.ts",
      "scripts/tests/mini-app-manifests.test.ts", "scripts/tests/mini-apps-conformance.test.ts", "scripts/tests/mini-apps-review-comment.test.ts", "scripts/tests/mini-apps-review.test.ts",
    ]);
    const r = pr(patch, { extra: { "scripts/mini-apps-conformance.ts": "changed\n" } });
    expect([r.lane, r.verdict, has(r, "gate_changed")]).toEqual(["core", "NEEDS_HUMAN", true]);
  });
  test("other core shapes: no files, a top-level mini-apps file, an id the id rule refuses", () => {
    expect(R.classify([]).id).toBeNull();
    expect(c("mini-apps/README.md").id).toBeNull();
    expect(c("mini-apps/Tiny_Shop/manifest.json").id).toBeNull();
    expect(c("skills/marketplace.json").id).toBeNull();
  });
  test("a deleted manifest is core", () => {
    const r = R.evaluate(source(baseFiles(), { [MP]: null, [SP]: null }), V);
    expect([r.lane, r.verdict, has(r, "manifest_deleted")]).toEqual(["core", "NEEDS_HUMAN", true]);
  });
  test("inside the lane only the catalog files: no code, no symlink", () => {
    const script = pr(patch, { extra: { "skills/tinyshop/run.sh": "echo hi\n" } });
    expect([script.verdict, has(script, "path_unknown_file", "M")]).toEqual(["FAIL", true]);
    expect(has(pr(patch, { extra: { "mini-apps/tinyshop/extra.json": "{}\n" } }), "path_unknown_file", "M")).toBe(true);
    expect(has(pr(patch, { extra: { "mini-apps/tinyshop/README.md": "# Tiny\n" } }), "path_unknown_file")).toBe(false);
    // A committed conformance.json is never trusted (release, L14465): the bot runs the suite itself.
    const committed = pr(patch, { extra: { [CP]: "{}\n" } });
    expect([committed.verdict, committed.findings.find(x => x.code === "path_unknown_file")?.text]).toEqual(["FAIL", "a committed conformance.json is never trusted: the bot runs the suite itself; remove it"]);
    const link = pr(patch, { extra: { "mini-apps/tinyshop/README.md": "../../x" }, modes: { "mini-apps/tinyshop/README.md": "120000" } });
    expect([link.verdict, has(link, "path_symlink", "M")]).toEqual(["FAIL", true]);
  });
});

describe("first-party packages: a CLOSED allow-list of ids whose skills/<id>/scripts/ and prompts/ are core, the human review", () => {
  // Lead ASK CLAIMS L21092 (ov#441): zzzbot's runtime package (skills/zzzbot/scripts/, skills/zzzbot/prompts/) is
  // first-party overlay code, so the bot says NEEDS_HUMAN (core) for it, not path_unknown_file. Every other id stays
  // strict: a third party never gets the core read by adding a scripts/ or prompts/ directory.
  const ZMP = "mini-apps/zzzbot/manifest.json", ZSP = "skills/zzzbot/SKILL.md";
  const ZSCRIPT = "skills/zzzbot/scripts/zzz_managed_runner.py", ZPROMPT = "skills/zzzbot/prompts/participate.md";
  // zzzbot has a manifest at the base, as on main: so today its skills/zzzbot/ is an app skill (SKILL.md only).
  const withZzz = (): Files => ({ ...baseFiles(), [ZMP]: "{}\n", [ZSP]: "---\nname: zzzbot\n---\n" });
  const run = (head: Files, base = withZzz()) => R.evaluate(source(base, head), V);
  const fp = (r: R.Report) => r.findings.filter(f => f.code === "first_party_package");

  test("the list is pinned here: zzzbot alone, scripts/ and prompts/ alone; never a baseline skill; every id a reviewed mini-app", async () => {
    expect(clone(R.FIRST_PARTY_PACKAGES)).toEqual({ zzzbot: ["scripts", "prompts"] });
    expect(Object.isFrozen(R.FIRST_PARTY_PACKAGES)).toBe(true);
    const { REVIEWED_MINI_APPS } = await import("../../install/install_miniapps");
    for (const id of Object.keys(R.FIRST_PARTY_PACKAGES)) {
      expect([id, R.BASELINE_SKILLS.has(id), REVIEWED_MINI_APPS.some(a => a.id === id)]).toEqual([id, false, true]);
    }
    expect(R.HUMAN_CODES.has("first_party_package")).toBe(true);
  });
  test("(a) skills/zzzbot/scripts/ + skills/zzzbot/prompts/: core, NEEDS_HUMAN, reason \"core: human review\", no M", () => {
    const r = run({ [ZSCRIPT]: "print('x')\n", [ZPROMPT]: "# participate\n" });
    expect([r.lane, r.verdict, r.manifest, noM(r), has(r, "path_unknown_file")]).toEqual(["core", "NEEDS_HUMAN", null, [], false]);
    expect(fp(r).map(f => [f.severity, f.file])).toEqual([["S", ZPROMPT], ["S", ZSCRIPT]]);
    for (const f of fp(r)) expect(f.text).toEndWith("core: human review");
    expect(has(r, "core_path")).toBe(false);
    // Each alone, a nested file, a delete: the same.
    for (const head of [{ [ZSCRIPT]: "x\n" }, { [ZPROMPT]: "x\n" }, { "skills/zzzbot/scripts/lib/util.sh": "x\n" }]) {
      const one = run(head);
      expect([Object.keys(head)[0], one.lane, one.verdict, noM(one), fp(one).length]).toEqual([Object.keys(head)[0], "core", "NEEDS_HUMAN", [], 1]);
    }
    const del = run({ [ZSCRIPT]: null }, { ...withZzz(), [ZSCRIPT]: "x\n" });
    expect([del.lane, del.verdict, noM(del), fp(del).length]).toEqual(["core", "NEEDS_HUMAN", [], 1]);
    // With zzzbot's SKILL.md and manifest in the same pull request: still core (one id, but a core path), no M.
    const mixed = run({ [ZSCRIPT]: "x\n", [ZSP]: "---\nname: zzzbot\nversion: 2\n---\n", [ZMP]: "{ }\n" });
    expect([mixed.lane, mixed.verdict, noM(mixed), fp(mixed).length]).toEqual(["core", "NEEDS_HUMAN", [], 1]);
    // The classifier: a first-party package file is core, never the app's lane.
    const c = (...paths: string[]) => R.classify(paths.map(path => ({ path, status: "M", oldMode: "100644", newMode: "100644" })));
    expect(c(ZSCRIPT, ZPROMPT)).toEqual({ id: null, core: [ZSCRIPT, ZPROMPT] });
    expect(c(ZSP)).toEqual({ id: "zzzbot", core: [] });
  });
  test("(a) the strict checks still apply inside a first-party package: a secret is M, a symlink is M", () => {
    const leak = run({ [ZSCRIPT]: "pass" + "word=hunter22\n" });
    expect([leak.verdict, has(leak, "secret_in_diff", "M")]).toEqual(["FAIL", true]);
    const link = R.evaluate(source(withZzz(), { [ZSCRIPT]: "../../x" }, { modes: { [ZSCRIPT]: "120000" } }), V);
    expect([link.verdict, has(link, "path_symlink", "M")]).toEqual(["FAIL", true]);
  });
  test("(b) the same paths under a non-first-party id: path_unknown_file, FAIL, as before", () => {
    for (const dir of ["scripts/zzz_managed_runner.py", "prompts/participate.md", "scripts/lib/util.sh"]) {
      const path = `skills/tinyshop/${dir}`;
      const r = pr(patch, { extra: { [path]: "x\n" } });
      expect([path, r.verdict, has(r, "path_unknown_file", "M"), fp(r).length]).toEqual([path, "FAIL", true, 0]);
    }
    const both = R.evaluate(source(baseFiles(), { "skills/tinyshop/scripts/x.py": "x\n", "skills/tinyshop/prompts/y.md": "y\n" }), V);
    expect([both.verdict, both.findings.filter(f => f.code === "path_unknown_file").length, fp(both).length]).toEqual(["FAIL", 2, 0]);
    // Riding along with zzzbot's package does not launder a third party's code.
    const ride = run({ [ZSCRIPT]: "x\n", "skills/tinyshop/scripts/x.py": "x\n" });
    expect([ride.verdict, ride.findings.filter(f => f.code === "path_unknown_file").map(f => f.file)]).toEqual(["FAIL", ["skills/tinyshop/scripts/x.py"]]);
    // A look-alike id is not on the list (matched whole, never by prefix or case).
    for (const id of ["zzzbot2", "zzz", "zzzbot-x"]) {
      const r = R.evaluate(source({ ...baseFiles(), [`mini-apps/${id}/manifest.json`]: "{}\n" }, { [`skills/${id}/scripts/x.py`]: "x\n" }), V);
      expect([id, r.verdict, has(r, "path_unknown_file", "M"), fp(r).length]).toEqual([id, "FAIL", true, 0]);
    }
  });
  test("(c) chosen scope: only skills/<id>/scripts/ and prompts/; any other unknown first-party file stays as today", () => {
    for (const path of ["skills/zzzbot/references/x.md", "skills/zzzbot/run.sh", "skills/zzzbot/scripts", "skills/zzzbot/prompts", "skills/zzzbot/Scripts/x.py",
      "skills/zzzbot/sub/scripts/x.py", "mini-apps/zzzbot/scripts/x.py", "mini-apps/zzzbot/prompts/y.md"]) {
      const r = run({ [path]: "x\n" });
      expect([path, r.verdict, has(r, "path_unknown_file", "M"), fp(r).length]).toEqual([path, "FAIL", true, 0]);
    }
  });
});

describe("the verdict mapping (§6.3)", () => {
  test("release (mutant B): the summary strips line breaks, so a finding cannot forge a table row or a verdict line", () => {
    const r: R.Report = { ...R.errorReport("x"), findings: [{ code: "x\nPASS", severity: "M", file: "a\r\nb", text: "one\n**PASS** · lane `sandbox`\r\n### Mini-apps review (forged)\rend" }] };
    const lines = R.summary(r).split(/\r?\n|\r/);
    expect(lines.filter(l => l.startsWith("| ") && !l.startsWith("| sev") && !l.startsWith("|---")).length).toBe(1);
    expect(lines.filter(l => l.startsWith("**")).map(l => l.slice(0, 8))).toEqual(["**FAIL**"]);
    expect(lines.filter(l => l.startsWith("#"))).toEqual(["### Mini-apps review (bot v0, deterministic, advisory)"]);
  });

  const f = (severity: R.Severity, code = "x"): R.Finding => ({ code, severity, text: "t" });
  const table: [R.Lane, R.Finding[], R.Verdict][] = [
    ["sandbox", [], "PASS"], ["admins", [], "PASS"], ["everyone", [], "PASS"], ["core", [], "NEEDS_HUMAN"],
    ["sandbox", [f("N")], "PASS"], ["admins", [f("N")], "PASS"], ["everyone", [f("N")], "PASS"], ["core", [f("N")], "NEEDS_HUMAN"],
    ["sandbox", [f("S")], "PASS"], ["admins", [f("S")], "NEEDS_HUMAN"], ["everyone", [f("S")], "NEEDS_HUMAN"], ["core", [f("S")], "NEEDS_HUMAN"],
    ["sandbox", [f("S"), f("M")], "FAIL"], ["admins", [f("M")], "FAIL"], ["everyone", [f("M")], "FAIL"], ["core", [f("M")], "FAIL"],
    // A §5 rule needs the human read even in sandbox.
    ["sandbox", [f("S", "needs_card_review")], "NEEDS_HUMAN"], ["sandbox", [f("S", "oauth_review")], "NEEDS_HUMAN"],
    ["sandbox", [f("N", "author_unverified")], "PASS"],
  ];
  for (const [lane, findings, want] of table) {
    test(`${lane} + [${findings.map(x => x.severity + (x.code === "x" ? "" : `:${x.code}`)).join(",")}] -> ${want}`, () => {
      expect(R.verdictOf(lane, findings)).toBe(want);
    });
  }
});

describe("author", () => {
  test("no owner.github yet: N author_unverified, never a pass on its own and never a FAIL", () => {
    const r = pr(patch);
    const author = r.findings.filter(x => x.code.startsWith("author"));
    expect(author.map(x => [x.code, x.severity])).toEqual([["author_unverified", "N"]]);
  });
  test("an owner opens it: N; anyone else (staff included): S, the human read, never M", () => {
    const owned = (m: any) => { m.owner = { github: ["tiny-dev", "Tiny-Ops"] }; };
    const base = manifest(); owned(base);
    expect(has(pr(patch, { base, author: "tiny-ops" }), "author_is_owner", "N")).toBe(true);
    const other = pr(patch, { base, author: "staffer" });
    expect([has(other, "author_not_owner", "S"), other.verdict, noM(other)]).toEqual([true, "NEEDS_HUMAN", []]);
    // review-b N1: with owners listed, a [bot] author or no author at all is S too, never a quiet N.
    for (const author of ["renovate[bot]", "tiny-dev[bot]", ""]) {
      const r = pr(patch, { base, author });
      expect([author, has(r, "author_not_owner", "S"), has(r, "author_unverified"), r.verdict]).toEqual([author, true, false, "NEEDS_HUMAN"]);
    }
  });
});

describe("schema: the shared validator", () => {
  test("fires on what the validator refuses and is silent on a valid manifest", () => {
    const bad = pr(m => { m.restricted = true; patch(m); });
    expect([bad.verdict, bad.findings.find(x => x.code === "schema_invalid")?.text]).toEqual(["FAIL", "/restricted additionalProperties"]);
    expect(has(pr(patch), "schema_invalid")).toBe(false);
  });
  test("a manifest that is not JSON fails", () => {
    const r = R.evaluate(source(baseFiles(), { [MP]: "{ nope" }), V);
    expect([r.verdict, has(r, "manifest_unparseable", "M")]).toEqual(["FAIL", true]);
  });
  test("the catalog: a manifest the cp would drop fails; one it does not list is a note", () => {
    const wrongId = pr(m => {
      m.id = "tinyshop2"; m.skills[0] = { ...m.skills[0], name: "tinyshop2", path: "skills/tinyshop2/SKILL.md" };
      m.service.auth.secretRef = "MINI_APP_TINYSHOP2_TOKEN";
      m.operations.forEach((op: any) => { op.name = op.name.replace("tinyshop.", "tinyshop2."); });
      m.operations[2].approval.prepare = "tinyshop2.order.prepare";
    });
    expect(has(wrongId, "catalog_dropped", "M")).toBe(true);
    const r = R.evaluate(source({ ...baseFiles(), "mini-apps/catalog.json": json({ catalog: 2, apps: ["dizko"] }) }, { [MP]: json({ ...manifest(), version: "1.0.1" }) }), V);
    expect([has(r, "catalog_unlisted", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
});

describe("the validator is loaded only at its pinned sha (fail closed)", () => {
  const root = () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-pins-"));
    for (const rel of [R.VALIDATOR_PATH, R.SCHEMA_PATH, R.PINS_PATH]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      copyFileSync(join(REPO, rel), join(dir, rel));
    }
    return dir;
  };
  test("the pinned copy loads", () => {
    const dir = root();
    try { expect(typeof R.loadValidator(dir).validateManifest).toBe("function"); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const tampers: [string, (dir: string) => void][] = [
    ["one byte of the validator", dir => { const p = join(dir, R.VALIDATOR_PATH); writeFileSync(p, readFileSync(p, "utf8").replace("const MAX_ERRORS = 32;", "const MAX_ERRORS = 33;")); }],
    ["the schema file", dir => { const p = join(dir, R.SCHEMA_PATH); writeFileSync(p, readFileSync(p, "utf8") + " "); }],
    ["the pins file", dir => { const p = join(dir, R.PINS_PATH); writeFileSync(p, readFileSync(p, "utf8").replace(/"module": "[0-9a-f]{64}"/, `"module": "${"0".repeat(64)}"`)); }],
    ["a pins file that is not JSON", dir => writeFileSync(join(dir, R.PINS_PATH), "{")],
    ["a missing validator", dir => rmSync(join(dir, R.VALIDATOR_PATH))],
  ];
  for (const [why, tamper] of tampers) {
    test(`refuses ${why}`, () => {
      const dir = root();
      try {
        tamper(dir);
        expect(() => R.loadValidator(dir)).toThrow(R.BotError);
        let out = "";
        const code = R.main(["--base", "HEAD", "--head", "HEAD", "--repo", REPO], { validatorRoot: dir, stdout: s => { out += s; }, stderr: () => {} });
        const report = JSON.parse(out);
        expect([code, report.verdict, report.findings[0].code, report.checked]).toEqual([2, "FAIL", "bot_error", []]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe("hashes", () => {
  test("a skill whose frontmatter version is not skills[].version fails", () => {
    const skill = SKILL.replace("version: 1.0.0", "version: 1.0.1");
    const r = pr(m => { m.skills[0].sha256 = sha256(skill); patch(m); }, { skill });
    expect(has(r, "skill_version_mismatch", "M")).toBe(true);
    const ok = pr(m => { m.skills[0].sha256 = sha256(skill); m.skills[0].version = "1.0.1"; patch(m); }, { skill });
    expect(noM(ok)).toEqual([]);
  });
  test("a skill file that is not at head fails", () => {
    const r = R.evaluate(source(baseFiles(), { [MP]: json({ ...manifest(), version: "1.0.1" }), [SP]: null }), V);
    expect(has(r, "skill_missing", "M")).toBe(true);
  });
});

describe("version bump class", () => {
  const need = (edit: (m: any) => void, base = manifest()) => { const h = clone(base); edit(h); return R.requiredBump(base, h, V.operationBudgets).level; };
  const cases: [string, (m: any) => void, R.Level][] = [
    ["nothing", () => {}, "none"],
    ["a description", m => { m.description = "Other words."; }, "patch"],
    ["the skill hash", m => { m.skills[0].sha256 = "0".repeat(64); }, "patch"],
    ["a visibility change", m => { m.visibility = "admins"; }, "minor"],
    ["an op removed", m => { m.operations.splice(0, 1); }, "minor"],
    ["a budget lowered", m => { m.operations[0].maxRequestBytes = 1024; }, "minor"],
    ["an op added", m => { m.operations.push({ name: "tinyshop.hours", class: "read" }); }, "major"],
    ["a request budget raised (from the default)", m => { m.operations[0].maxRequestBytes = 8192; }, "major"],
    ["a framing change", m => { m.operations[0].framing = "media"; }, "major"],
    ["a class change", m => { m.operations[0].class = "write"; }, "major"],
    ["an input schema", m => { m.operations[0].input = { type: "object", properties: {}, additionalProperties: false }; }, "major"],
    ["a target", m => { m.operations[0].target = { method: "GET", path: "/menu" }; }, "major"],
    ["the auth block", m => { m.service.auth.secretRef = "MINI_APP_TINYSHOP_OTHER"; }, "major"],
    ["data.context added", m => { m.data = { context: { maxEntries: 4, ceiling: "private" } }; }, "major"],
    ["the approval summary", m => { m.operations[2].approval.summary = ["Order {{preview.total}}"]; }, "major"],
    ["a new permission", m => { m.permissions.push({ kind: "action", label: "Order", description: "Order." }); }, "major"],
    ["events added", m => { m.events = { "miniapp.tinyshop.order@1": { orderId: "string" } }; }, "major"],
  ];
  for (const [why, edit, level] of cases) test(`${why}: ${level}`, () => expect(need(edit)).toBe(level));
  test("a timeout raised is major, lowered is minor", () => {
    const base = manifest(); base.operations[0].timeoutMs = 10000;
    expect(need(m => { m.operations[0].timeoutMs = 20000; }, base)).toBe("major");
    expect(need(m => { m.operations[0].timeoutMs = 5000; }, base)).toBe("minor");
  });
  test("annotation-only input edits (description, title, examples) are a patch; a property named description is not", () => {
    const base = manifest();
    base.operations[0].input = { type: "object", description: "Menu query.", properties: { day: { type: "string", title: "Day", examples: ["mon"] } }, additionalProperties: false };
    expect(need(m => { m.operations[0].input.description = "The menu query."; m.operations[0].input.properties.day.title = "Weekday"; m.operations[0].input.properties.day.examples = ["tue"]; }, base)).toBe("patch");
    expect(need(m => { delete m.operations[0].input.properties.day.examples; m.operations[0].input.$comment = "x"; }, base)).toBe("patch");
    expect(need(m => { m.operations[0].input.properties.description = { type: "string" }; }, base)).toBe("major");
    expect(need(m => { m.operations[0].input.properties.day.maxLength = 3; }, base)).toBe("major");
    expect(need(m => { m.operations[0].input.properties.day.description = "Which day."; }, base)).toBe("patch");
  });
  test("data.context narrowing is minor, widening is major", () => {
    const base = manifest(); base.data = { context: { maxEntries: 16, ceiling: "village" } };
    expect(need(m => { m.data.context.maxEntries = 8; }, base)).toBe("minor");
    expect(need(m => { m.data.context.ceiling = "private"; }, base)).toBe("minor");
    expect(need(m => { m.data.context.maxEntries = 32; }, base)).toBe("major");
    expect(need(m => { m.data.context.ceiling = "public"; }, base)).toBe("major");
  });
  test("bumpOf reads the numeric triple", () => {
    expect([R.bumpOf("1.0.0", "2.0.0"), R.bumpOf("1.0.0", "1.1.0"), R.bumpOf("1.0.9", "1.0.10"), R.bumpOf("1.2.3", "1.2.3"),
      R.bumpOf("1.2.3", "1.2.2"), R.bumpOf("1.2.3", "0.9.9"), R.bumpOf("1.0", "1.0.1")]).toEqual(["major", "minor", "patch", "none", "down", "down", null]);
  });
  test("in a review: too small, not bumped and going down are reported as N, not enforced, until S2 is settled", () => {
    expect(R.BUMP_SEVERITY).toBe("N");
    const addOp = (m: any) => m.operations.push({ name: "tinyshop.hours", class: "read" });
    const small = pr(m => { addOp(m); m.version = "1.1.0"; });
    expect([has(small, "version_bump_too_small", "N"), noM(small), small.verdict]).toEqual([true, [], "PASS"]);
    const ok = pr(m => { addOp(m); m.version = "2.0.0"; });
    expect([has(ok, "version_bump", "N"), noM(ok)]).toEqual([true, []]);
    const same = pr(m => { m.description = "Other."; });
    expect([has(same, "version_not_bumped", "N"), same.verdict]).toEqual([true, "PASS"]);
    const down = pr(m => { m.description = "Other."; m.version = "0.9.0"; });
    expect([has(down, "version_not_monotonic", "N"), down.verdict]).toEqual([true, "PASS"]);
    const fresh = R.evaluate(source({ "mini-apps/catalog.json": CATALOG }, { [MP]: json(manifest()), [SP]: SKILL }), V);
    expect([has(fresh, "version_new_manifest", "N"), noM(fresh)]).toEqual([true, []]);
  });
});

describe("(e) the bump's $ref gate: P0-5's annotationOnlyEdit, copied, so the bot and the suite agree", () => {
  const obj = (props: any, extra: any = {}) => ({ type: "object", properties: props, ...extra });
  const o = (extra: any) => ({ type: "object", ...extra });
  // P0-5's own cases (ov#422 5aacadf4, scripts/tests/mini-apps-conformance.test.ts, "S1 (review-b)"): 12 major, 3 patch.
  const P05: [string, any, any, R.Level][] = [
    ["review-b probe 1: $ref into examples[0], its maxLength dropped", obj({ q: { $ref: "#/examples/0" } }, { examples: [{ type: "string", maxLength: 3 }] }), obj({ q: { $ref: "#/examples/0" } }, { examples: [{ type: "string" }] }), "major"],
    ["review-b probe 2: $ref into $defs/x/description, its maxLength dropped", obj({ q: { $ref: "#/$defs/x/description" } }, { $defs: { x: { type: "string", description: { type: "string", maxLength: 3 } } } }), obj({ q: { $ref: "#/$defs/x/description" } }, { $defs: { x: { type: "string", description: { type: "string" } } } }), "major"],
    ["#/$defs/x, but no such def (in either)", obj({ q: { $ref: "#/$defs/x" } }), obj({ q: { $ref: "#/$defs/x", description: "q" } }), "major"],
    ["#/$defs/x with an $id", obj({ q: { $ref: "#/$defs/x" } }, { $id: "https://acme.example/s", $defs: { x: { type: "string" } } }), obj({ q: { $ref: "#/$defs/x", description: "q" } }, { $id: "https://acme.example/s", $defs: { x: { type: "string" } } }), "major"],
    ["#/title/x (an annotation, the length of #/$defs/)", obj({ q: { $ref: "#/title/x" } }, { title: { x: { type: "string", maxLength: 3 } }, $defs: { x: { type: "string" } } }), obj({ q: { $ref: "#/title/x" } }, { title: { x: { type: "string" } }, $defs: { x: { type: "string" } } }), "major"],
    ["#/definitions/x (not #/$defs/<name>)", obj({ q: { $ref: "#/definitions/x" } }, { definitions: { x: { type: "string" } } }), obj({ q: { $ref: "#/definitions/x", description: "q" } }, { definitions: { x: { type: "string" } } }), "major"],
    ["a nested pointer #/$defs/x/items", obj({ q: { $ref: "#/$defs/x/items" } }, { $defs: { x: { type: "array", items: { type: "string" } } } }), obj({ q: { $ref: "#/$defs/x/items", description: "q" } }, { $defs: { x: { type: "array", items: { type: "string" } } } }), "major"],
    ["a remote $ref", obj({ q: { $ref: "https://acme.example/q.json" } }), obj({ q: { $ref: "https://acme.example/q.json", title: "Q" } }), "major"],
    ["$dynamicRef to an anchor", obj({ q: { $dynamicRef: "#meta" } }), obj({ q: { $dynamicRef: "#meta", title: "Q" } }), "major"],
    ["$recursiveRef", obj({ q: { $recursiveRef: "#" } }), obj({ q: { $recursiveRef: "#", title: "Q" } }), "major"],
    ["a $ref only in the head, inside examples", obj({ q: { type: "string" } }), obj({ q: { type: "string" } }, { examples: [{ $ref: "#/$defs/x" }] }), "major"],
    ["#/$defs/x, the def's maxLength dropped", obj({ q: { $ref: "#/$defs/x" } }, { $defs: { x: { type: "string", maxLength: 3 } } }), obj({ q: { $ref: "#/$defs/x" } }, { $defs: { x: { type: "string" } } }), "major"],
    ["the def's description", obj({ q: { $ref: "#/$defs/x" } }, { $defs: { x: { type: "string" } } }), obj({ q: { $ref: "#/$defs/x" } }, { $defs: { x: { type: "string", description: "the query" } } }), "patch"],
    ["the property's title beside the $ref", obj({ q: { $ref: "#/$defs/x" }, r: { $ref: "#/$defs/y-2" } }, { $defs: { x: { type: "string" }, "y-2": { type: "number" } } }), obj({ q: { $ref: "#/$defs/x", title: "Q" }, r: { $ref: "#/$defs/y-2" } }, { $defs: { x: { type: "string" }, "y-2": { type: "number", $comment: "c" } } }), "patch"],
    ["$dynamicRef #/$defs/x", obj({ q: { $dynamicRef: "#/$defs/x" } }, { $defs: { x: { type: "string" } } }), obj({ q: { $dynamicRef: "#/$defs/x" } }, { $defs: { x: { type: "string", examples: ["latte"] } } }), "patch"],
  ];
  // review-b's 26 probes (ov#422 delta read, fold 2), with the level P0-5's requiredBump gives each at 5aacadf4
  // (20 major, 5 patch, 1 none: A8b's two inputs are the same). The bot before this fold said patch for 19 of them.
  const REVIEW_B: [string, any, any, R.Level][] = [
  ["P1 $ref #/examples/0", o({ properties: { q: { $ref: "#/examples/0" } }, examples: [{ type: "string", maxLength: 3 }] }), o({ properties: { q: { $ref: "#/examples/0" } }, examples: [{ type: "string" }] }), "major"],
  ["P2 $ref #/$defs/x/description", o({ properties: { q: { $ref: "#/$defs/x/description" } }, $defs: { x: { description: { type: "string", maxLength: 3 } } } }), o({ properties: { q: { $ref: "#/$defs/x/description" } }, $defs: { x: { description: { type: "string" } } } }), "major"],
  ["A1 #/$defs/x -> nested $ref #/examples/0", o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { $ref: "#/examples/0" } }, examples: [{ type: "string", maxLength: 3 }] }), o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { $ref: "#/examples/0" } }, examples: [{ type: "string" }] }), "major"],
  ["A1b #/$defs/x -> allOf[$ref #/$defs/x/title]", o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { allOf: [{ $ref: "#/$defs/y/title" }] }, y: { title: { maxLength: 3 } } } }), o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { allOf: [{ $ref: "#/$defs/y/title" }] }, y: { title: {} } } }), "major"],
  ["A2 $defs/x $anchor changed", o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { $anchor: "a", type: "string", maxLength: 3 } } }), o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { $anchor: "b", type: "string", maxLength: 3 } } }), "major"],
  ["A3 $ref #anchor into examples", o({ properties: { q: { $ref: "#lim" } }, examples: [{ $anchor: "lim", type: "string", maxLength: 3 }] }), o({ properties: { q: { $ref: "#lim" } }, examples: [{ $anchor: "lim", type: "string" }] }), "major"],
  ["A3b $ref #anchor into $defs (title edit)", o({ properties: { q: { $ref: "#lim" } }, $defs: { x: { $anchor: "lim", type: "string", maxLength: 3, title: "a" } } }), o({ properties: { q: { $ref: "#lim" } }, $defs: { x: { $anchor: "lim", type: "string", maxLength: 3, title: "b" } } }), "major"],
  ["A4 $dynamicRef #/$defs/x/description", o({ properties: { q: { $dynamicRef: "#/$defs/x/description" } }, $defs: { x: { description: { maxLength: 3 } } } }), o({ properties: { q: { $dynamicRef: "#/$defs/x/description" } }, $defs: { x: { description: {} } } }), "major"],
  ["A4b $dynamicRef #meta (anchor in examples)", o({ $dynamicAnchor: "meta", properties: { q: { $dynamicRef: "#meta" } }, examples: [{ maxLength: 3 }] }), o({ $dynamicAnchor: "meta", properties: { q: { $dynamicRef: "#meta" } }, examples: [{}] }), "major"],
  ["A4c $dynamicRef #/$defs/x (ok, desc edit)", o({ properties: { q: { $dynamicRef: "#/$defs/x" } }, $defs: { x: { type: "string", maxLength: 3, description: "a" } } }), o({ properties: { q: { $dynamicRef: "#/$defs/x" } }, $defs: { x: { type: "string", maxLength: 3, description: "b" } } }), "patch"],
  ["A4d $recursiveRef #", o({ properties: { q: { $recursiveRef: "#" } }, examples: [1] }), o({ properties: { q: { $recursiveRef: "#" } }, examples: [2] }), "major"],
  ["A5 ~1 escape #/$defs/a~1b", o({ properties: { q: { $ref: "#/$defs/a~1b" } }, $defs: { "a/b": { type: "string", maxLength: 3 } }, title: "a" }), o({ properties: { q: { $ref: "#/$defs/a~1b" } }, $defs: { "a/b": { type: "string", maxLength: 3 } }, title: "b" }), "major"],
  ["A5b %24defs pointer to examples", o({ properties: { q: { $ref: "#/%24defs/x/examples/0" } }, $defs: { x: { examples: [{ maxLength: 3 }] } } }), o({ properties: { q: { $ref: "#/%24defs/x/examples/0" } }, $defs: { x: { examples: [{}] } } }), "major"],
  ["A5c %2F in name", o({ properties: { q: { $ref: "#/$defs/x%2Fdescription" } }, $defs: { x: { description: { maxLength: 3 } } } }), o({ properties: { q: { $ref: "#/$defs/x%2Fdescription" } }, $defs: { x: { description: {} } } }), "major"],
  ["A5d ~0 in name", o({ properties: { q: { $ref: "#/$defs/a~0b" } }, $defs: { "a~b": { maxLength: 3 } }, title: "a" }), o({ properties: { q: { $ref: "#/$defs/a~0b" } }, $defs: { "a~b": { maxLength: 3 } }, title: "b" }), "major"],
  ["A6 ref in allOf/if/then/not -> examples", o({ allOf: [{ if: { $ref: "#/examples/0" }, then: { not: { $ref: "#/examples/1" } } }], examples: [{ properties: { q: { const: "abcdef" } }, required: ["q"] }, { properties: { q: { type: "string" } } }] }), o({ allOf: [{ if: { $ref: "#/examples/0" }, then: { not: { $ref: "#/examples/1" } } }], examples: [{ properties: { q: { const: "abcdef" } }, required: ["q"] }, { properties: { q: { type: "number" } } }] }), "major"],
  ["A7 $id deep inside, ref #/$defs/x", o({ properties: { q: { $id: "https://e.x/q", $ref: "#/$defs/x", $defs: { x: { title: { maxLength: 3 } } } } }, $defs: { x: { type: "string" } } }), o({ properties: { q: { $id: "https://e.x/q", $ref: "#/$defs/x", $defs: { x: { title: {} } } } }, $defs: { x: { type: "string" } } }), "major"],
  ["A7b $id only in examples (ref ok)", o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string", maxLength: 3 } }, examples: [{ $id: "a" }] }), o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string", maxLength: 3 } }, examples: [{ $id: "b" }] }), "major"],
  ["A8 #/definitions/x/description", o({ properties: { q: { $ref: "#/definitions/x/description" } }, definitions: { x: { description: { maxLength: 3 } } } }), o({ properties: { q: { $ref: "#/definitions/x/description" } }, definitions: { x: { description: {} } } }), "major"],
  ["A8b #/$defs/x but def only in definitions", o({ properties: { q: { $ref: "#/$defs/x" } }, definitions: { x: { maxLength: 3 } }, $defs: {} }), o({ properties: { q: { $ref: "#/$defs/x" } }, definitions: { x: { maxLength: 3 } }, $defs: {} }), "none"],
  ["A9 unevaluatedProperties + ref to def (desc edit)", o({ $ref: "#/$defs/x", unevaluatedProperties: false, $defs: { x: { properties: { q: { type: "string", description: "a" } } } } }), o({ $ref: "#/$defs/x", unevaluatedProperties: false, $defs: { x: { properties: { q: { type: "string", description: "b" } } } } }), "patch"],
  ["A9b unevaluatedProperties: ref into examples", o({ properties: { q: {} }, allOf: [{ $ref: "#/examples/0" }], unevaluatedProperties: false, examples: [{}] }), o({ properties: { q: {} }, allOf: [{ $ref: "#/examples/0" }], unevaluatedProperties: false, examples: [{ properties: { z: true } }] }), "major"],
  ["A10 __proto__ def name", o({ properties: { q: { $ref: "#/$defs/__proto__" } }, $defs: JSON.parse('{"__proto__":{"type":"string","maxLength":3}}'), title: "a" }), o({ properties: { q: { $ref: "#/$defs/__proto__" } }, $defs: JSON.parse('{"__proto__":{"type":"string","maxLength":3}}'), title: "b" }), "patch"],
  ["A11 legit #/$defs/x desc edit (expect patch)", o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string", maxLength: 3, description: "a" } } }), o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string", maxLength: 3, description: "b" } } }), "patch"],
  ["A12 ref trailing newline", o({ properties: { q: { $ref: "#/$defs/x\n" } }, $defs: { x: { maxLength: 3 } }, title: "a" }), o({ properties: { q: { $ref: "#/$defs/x\n" } }, $defs: { x: { maxLength: 3 } }, title: "b" }), "major"],
  ["A13 relative ref 'x' with $defs", o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string", maxLength: 3 } }, $comment: "a" }), o({ properties: { q: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string", maxLength: 3 } }, $comment: "b" }), "patch"],
  ];
  // Fold 2's mutant e3 (any "#/$defs/" pointer accepted): a def whose literal key is an escaped pointer sits beside
  // the def the pointer really names, so only the strict #/$defs/<name> pattern keeps these major (P0-5 says major).
  const ESCAPED: [string, any, any, R.Level][] = [
    ["a def literally named x%2Fdescription beside x (the ref reaches x's description)", o({ properties: { q: { $ref: "#/$defs/x%2Fdescription" } }, $defs: { "x%2Fdescription": { type: "string" }, x: { description: { type: "string", maxLength: 3 } } } }),
      o({ properties: { q: { $ref: "#/$defs/x%2Fdescription" } }, $defs: { "x%2Fdescription": { type: "string" }, x: { description: { type: "string" } } } }), "major"],
    ["a def literally named a~1b beside a/b (the ref reaches a/b)", o({ properties: { q: { $ref: "#/$defs/a~1b" } }, $defs: { "a~1b": { type: "string" }, "a/b": { type: "string" } }, title: "a" }),
      o({ properties: { q: { $ref: "#/$defs/a~1b" } }, $defs: { "a~1b": { type: "string" }, "a/b": { type: "string" } }, title: "b" }), "major"],
  ];
  // Each input is op 0's; base and head carry the same version, so the level is the input rule's alone.
  const level = (from: any, to: any) => {
    const a = manifest(), b = manifest();
    a.operations[0].input = from; b.operations[0].input = to;
    return R.requiredBump(a, b, V.operationBudgets).level;
  };
  test("the case lists are whole: P0-5's 15 and review-b's 26", () => {
    expect([P05.length, REVIEW_B.length, REVIEW_B.filter(c => c[3] === "major").length, REVIEW_B.filter(c => c[3] === "patch").length]).toEqual([15, 26, 20, 5]);
  });
  for (const [why, from, to, want] of [...P05, ...REVIEW_B, ...ESCAPED]) test(`${why}: ${want}`, () => expect(level(from, to)).toBe(want));
  test("in a review the bump stays a note (BUMP_SEVERITY N): a $ref annotation edit at patch is version_bump_too_small, N", () => {
    const [, from, to] = P05[0];
    const base = manifest(); base.operations[0].input = from;
    const r = pr(m => { m.operations[0].input = to; patch(m); }, { base });
    expect([has(r, "version_bump_too_small", "N"), noM(r)]).toEqual([true, []]);
    expect(r.findings.find(f => f.code === "version_bump_too_small")?.text).toContain("needs major");
  });
  test.skipIf(!existsSync(join(REPO, R.CONFORMANCE_PATH)))("with P0-5's suite in the tree: its requiredBump and the bot's give the same level on all 43 cases (the merged tree)", async () => {
    const p05 = await import(join(REPO, R.CONFORMANCE_PATH));
    for (const [why, from, to] of [...P05, ...REVIEW_B, ...ESCAPED]) {
      const a = manifest(), b = manifest();
      a.operations[0].input = from; b.operations[0].input = to;
      expect([why, R.requiredBump(a, b, V.operationBudgets).level]).toEqual([why, p05.requiredBump(a, b, V.operationBudgets).level]);
    }
  });
});

describe("secrets", () => {
  const T = {
    openai: "sk" + "-proj-" + "Ab12Cd34Ef56Gh78Ij90Kl12",
    anthropic: "sk" + "-ant-api03-" + "Ab12Cd34Ef56Gh78Ij90Kl12",
    stripe: "sk" + "_live_" + "Ab12Cd34Ef56Gh78Ij90",
    ghp: "gh" + "p_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78",
    pat: "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghijklmnop",
    jwt: "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiJ0ZXN0In0" + "." + "c2lnbmF0dXJlMTIz",
    pem: "-----BEGIN " + "RSA PRIVATE" + " KEY-----",
    pemPlain: "-----BEGIN " + "PRIVATE" + " KEY-----",
    akia: "AK" + "IA" + "ABCDEFGHIJ234567",
    awsSecret: "aws_secret" + "_access_key = " + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90",
    slack: "xo" + "xb-" + "1234567890-abcdef",
    google: "AI" + "za" + "SyAb12Cd34Ef56Gh78Ij90Kl12Mn34Op56Q",
    password: "pass" + "word=" + "hunter22",
    passwordJson: `"pass` + `word": "hunter22"`,
    bearer: "Authorization: " + "Bearer " + "abcdefghijklmnopqrstuvwxyz012345",
    apiKey: `api_` + `key: "` + "Ab12Cd34Ef56Gh78Ij90" + `"`,
  };
  const want: Record<keyof typeof T, string> = {
    openai: "openai_or_anthropic_key", anthropic: "openai_or_anthropic_key", stripe: "stripe_key", ghp: "github_token", pat: "github_pat",
    jwt: "jwt", pem: "pem_private_key", pemPlain: "pem_private_key", akia: "aws_access_key_id", awsSecret: "aws_secret_access_key",
    slack: "slack_token", google: "google_api_key", password: "password_assignment", passwordJson: "password_field", bearer: "bearer_token",
    apiKey: "credential_assignment",
  };
  for (const key of Object.keys(T) as (keyof typeof T)[]) {
    test(`true positive: ${key}`, () => expect(R.secretHits(`  value ${T[key]} here`)).toContain(want[key]));
  }
  const clean = [
    "Run a risk-assessment-framework-checklist before ordering.",
    "Never ask for the resident's password: the app holds no account.",
    "password = ",
    "The app server holds the Bearer tokens; the box never sees one.",
    `"secretRef": "TINYSHOP_AV_TOKEN"`,
    `"token": "TINYSHOP_AV_TOKEN_NAME"`,
    `apiKey: "credential_assignment",`,
    `"sha256": "${"a".repeat(64)}"`,
    "-----BEGIN PUBLIC KEY-----",
    "eyJ alone is not a token",
    "AKIA123",
    "task-1234567890abcdefghij is a task id",
    "https://api.tinyshop.example.org/menu?date=2026-10-19",
  ];
  for (const text of clean) test(`false positive stays quiet: ${text.slice(0, 40)}`, () => expect(R.secretHits(text)).toEqual([]));

  test("release N4: a JSON-escaped secret is still found (the line is matched raw and JSON-unescaped)", () => {
    const BS = String.fromCharCode(92);
    const token = "gh" + "p_" + "A1b2C3d4".repeat(5);
    const escaped = `${BS}u0067` + token.slice(1);
    expect([R.secretHits(`"${escaped}"`), R.secretHits(R.jsonUnescape(`"${escaped}"`))]).toEqual([[], ["github_token"]]);
    expect(R.jsonUnescape(`a${BS}"b${BS}${BS}c${BS}/d${BS}n`)).toBe('a"b' + BS + "c/d\n");
    const h = manifest(); h.version = "1.0.1";
    const text = json(h).replace('"An invented shop used only by these tests."', `"${escaped}"`);
    const r = R.evaluate(source(baseFiles(), { [MP]: text }), V);
    expect([has(r, "secret_in_diff", "M"), r.verdict, JSON.stringify(r).includes(token)]).toEqual([true, "FAIL", false]);
  });
  test("an added line with a secret fails, names the line and never echoes the value", () => {
    const skill = SKILL + `Token: ${T.ghp}\n`;
    const r = pr(m => { m.skills[0].sha256 = sha256(skill); patch(m); }, { skill });
    const hit = r.findings.find(x => x.code === "secret_in_diff")!;
    expect([r.verdict, hit.severity, hit.file, hit.line]).toEqual(["FAIL", "M", SP, skill.split("\n").length - 1]);
    expect(JSON.stringify(r)).not.toContain(T.ghp);
  });
  test("only added lines are scanned; a core file's secret fails too", () => {
    const withOld = { ...baseFiles(), "docs/old.md": `old ${T.akia}\n` };
    const r = R.evaluate(source(withOld, { "docs/old.md": `old ${T.akia}\nnew line\n` }), V);
    expect(has(r, "secret_in_diff")).toBe(false);
    const core = R.evaluate(source(baseFiles(), { "docs/new.md": `${T.pat}\n` }), V);
    expect([core.verdict, has(core, "secret_in_diff", "M")]).toEqual(["FAIL", true]);
  });
  test("a data: URI or a base64 run over 1 KiB in a catalog file fails; 1 KiB does not", () => {
    const uri = "data:" + "image/png;base64,iVBORw0KGgo";
    const big = "QUJD".repeat(257);
    const at = (extra: string) => { const skill = SKILL + extra + "\n"; return pr(m => { m.skills[0].sha256 = sha256(skill); patch(m); }, { skill }); };
    expect(has(at(uri), "data_uri", "M")).toBe(true);
    expect(has(at(big), "base64_blob", "M")).toBe(true);
    expect(has(at(big.slice(0, 1024)), "base64_blob")).toBe(false);
  });
});

describe("data.context", () => {
  const withCtx = (ctx: any, vis = "sandbox") => { const m = manifest(vis); m.data = { context: ctx }; return m; };
  test("no data block: no data finding", () => {
    expect(codes(pr(patch)).filter(c => c.startsWith("data") || c.startsWith("context"))).toEqual([]);
  });
  test("an unchanged private ceiling is quiet", () => {
    const r = pr(patch, { base: withCtx({ maxEntries: 16, ceiling: "private" }) });
    expect(codes(r).filter(c => c.startsWith("context") || c.startsWith("data"))).toEqual([]);
  });
  test("maxEntries over 64 and a data block other than context fail", () => {
    const over = pr(m => { m.data.context.maxEntries = 65; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "private" }) });
    expect(has(over, "context_max_entries", "M")).toBe(true);
    const state = pr(m => { m.data.state = { rows: 1 }; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "private" }) });
    expect(has(state, "data_block_not_allowed", "M")).toBe(true);
  });
  test("a ceiling above the lane's fails (everyone may not declare public)", () => {
    const r = pr(m => { m.data.context.ceiling = "public"; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "village" }, "everyone") });
    expect(has(r, "context_ceiling_over_lane", "M")).toBe(true);
    const sandbox = pr(m => { m.data.context.ceiling = "public"; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "village" }) });
    expect(has(sandbox, "context_ceiling_over_lane")).toBe(false);
  });
  test("a ceiling raised above private needs the human read, even in sandbox; a missing ceiling is S", () => {
    const r = pr(m => { m.data.context.ceiling = "village"; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "private" }) });
    expect([has(r, "context_ceiling_above_private", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    const missing = pr(m => { m.data = { context: { maxEntries: 4 } }; m.version = "2.0.0"; });
    expect(has(missing, "context_ceiling_missing", "S")).toBe(true);
  });
});

describe("approval classes", () => {
  test("a needs-card op with no prepare op fails", () => {
    const r = pr(m => { m.operations[1].class = "read"; m.version = "2.0.0"; });
    expect(has(r, "needs_card_without_prepare", "M")).toBe(true);
    expect(has(pr(patch), "needs_card_without_prepare")).toBe(false);
  });
  test("needs-card -> write is a downgrade: core, NEEDS_HUMAN", () => {
    const r = pr(m => {
      const op = m.operations[2];
      op.class = "write"; delete op.approval; op.timeoutMs = 25000; op.maxRequestBytes = 4096; m.version = "2.0.0";
    });
    expect([noM(r), r.lane, r.verdict, has(r, "needs_card_downgrade", "S")]).toEqual([[], "core", "NEEDS_HUMAN", true]);
  });
  test("needs-card -> read is a downgrade too; an unchanged needs-card op is not", () => {
    const r = pr(m => { const op = m.operations[2]; op.class = "read"; delete op.approval; delete op.timeoutMs; delete op.maxRequestBytes; m.version = "2.0.0"; });
    expect([r.lane, has(r, "needs_card_downgrade")]).toEqual(["core", true]);
    const same = pr(patch);
    expect([has(same, "needs_card_downgrade"), has(same, "needs_card_review"), same.lane]).toEqual([false, false, "sandbox"]);
  });
  test("review-b S1: a card-less ALIAS on a needs-card op's target (tool or path, at base or head) is a downgrade: core", () => {
    const tooled = (visibility = "admins") => {
      const m = manifest(visibility);
      m.service = { kind: "mcp", baseUrl: "https://mcp.tinyshop.example.org/mcp", auth: { mode: "none" } };
      m.operations = [
        { name: "tinyshop.menu", class: "read", target: { tool: "menu" } },
        { name: "tinyshop.order.prepare", class: "prepare", target: { tool: "quote" } },
        { name: "tinyshop.order.confirm", class: "needs-card", target: { tool: "place_order" }, maxRequestBytes: 65536, timeoutMs: 60000, approval: { prepare: "tinyshop.order.prepare" } },
      ];
      return m;
    };
    expect(V.validateManifest(tooled()).errors ?? []).toEqual([]);
    for (const cls of ["write", "read", "prepare"]) {
      const r = pr(m => { m.operations.push({ name: `tinyshop.order.${cls}alias`, class: cls, target: { tool: "place_order" } }); m.version = "2.0.0"; }, { base: tooled() });
      expect([cls, has(r, "needs_card_downgrade", "S"), r.lane, r.verdict]).toEqual([cls, true, "core", "NEEDS_HUMAN"]);
    }
    // Split across two pull requests: PR1 adds the alias (the card op is still there), PR2 removes the card op.
    const pr1 = pr(m => { m.operations.push({ name: "tinyshop.order.peek", class: "read", target: { tool: "place_order" } }); m.version = "1.1.0"; }, { base: tooled() });
    const after1 = tooled(); after1.operations.push({ name: "tinyshop.order.peek", class: "read", target: { tool: "place_order" } }); after1.version = "1.1.0";
    const pr2 = pr(m => { m.operations = m.operations.filter((op: any) => op.class !== "needs-card"); m.operations[1].class = "write"; m.version = "2.0.0"; }, { base: after1 });
    for (const [why, r] of [["PR1", pr1], ["PR2", pr2]] as const) expect([why, has(r, "needs_card_downgrade", "S"), r.lane]).toEqual([why, true, "core"]);
    // Another target is not an alias; an https-json path target is keyed by its path, whatever the method.
    const other = pr(m => { m.operations.push({ name: "tinyshop.hours", class: "read", target: { tool: "hours" } }); m.version = "2.0.0"; }, { base: tooled() });
    expect([has(other, "needs_card_downgrade"), other.lane]).toEqual([false, "admins"]);
    const pathed = manifest("admins");
    pathed.operations = [
      { name: "tinyshop.order.prepare", class: "prepare", target: { method: "POST", path: "/quote" } },
      { name: "tinyshop.order.confirm", class: "needs-card", target: { method: "POST", path: "/orders" }, maxRequestBytes: 65536, timeoutMs: 60000, approval: { prepare: "tinyshop.order.prepare" } },
    ];
    const getAlias = pr(m => { m.operations.push({ name: "tinyshop.orders", class: "read", target: { method: "GET", path: "/orders" } }); m.version = "2.0.0"; }, { base: pathed });
    expect([has(getAlias, "needs_card_downgrade", "S"), getAlias.lane]).toEqual([true, "core"]);
  });
  test("a needs-card op removed while a card-less op is added: the human read", () => {
    const r = pr(m => { m.operations.splice(2, 1); m.operations.push({ name: "tinyshop.order.place", class: "write" }); m.version = "2.0.0"; });
    expect([has(r, "needs_card_replaced", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
  test("review-b S (the two-PR split): removing a needs-card op is S needs_card_removed, the human read in every lane, never a PASS; each PR alone is NEEDS_HUMAN", () => {
    const dropCard = (m: any) => { m.operations = m.operations.filter((op: any) => op.class !== "needs-card"); m.version = "1.1.0"; };
    const quick = (m: any) => { m.operations.push({ name: "tinyshop.order.quick", class: "write", target: { tool: "place_order" } }); m.version = "2.0.0"; };
    for (const visibility of ["sandbox", "admins", "everyone"]) {
      // PR1 removes the card op and adds nothing: S needs_card_removed, NEEDS_HUMAN, sandbox and admins included.
      const pr1 = pr(dropCard, { base: tooledManifest(visibility) });
      expect([visibility, has(pr1, "needs_card_removed", "S"), pr1.verdict, noM(pr1)]).toEqual([visibility, true, "NEEDS_HUMAN", []]);
      expect(R.HUMAN_CODES.has("needs_card_removed")).toBe(true);
      // PR2, opened from the same base, adds a write on the card op's target: core.
      const pr2 = pr(quick, { base: tooledManifest(visibility) });
      expect([visibility, has(pr2, "needs_card_downgrade", "S"), pr2.lane, pr2.verdict, noM(pr2)]).toEqual([visibility, true, "core", "NEEDS_HUMAN", []]);
      // PR2 still core once PR1 has merged: the base tip has no card op, but PR2's merge base does.
      const after1 = tooledManifest(visibility); dropCard(after1);
      const late = pr(quick, { base: tooledManifest(visibility), tip: { [MP]: json(after1) } });
      expect([visibility, has(late, "needs_card_downgrade", "S"), late.lane, late.verdict]).toEqual([visibility, true, "core", "NEEDS_HUMAN"]);
    }
    // The removal is named per op; an unchanged card op is not a removal, nor is a renamed op's old name kept.
    expect(has(pr(m => { m.description = "Other."; patch(m); }, { base: tooledManifest() }), "needs_card_removed")).toBe(false);
    const renamed = pr(m => { m.operations[2].name = "tinyshop.order.place"; m.version = "2.0.0"; }, { base: tooledManifest() });
    expect([has(renamed, "needs_card_removed", "S"), renamed.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
  test("review-b N-c: targets are matched normalised (a trailing slash, the case, the baseUrl's host and path)", () => {
    const alias = (path: string, base = pathedManifest(), edit: (m: any) => void = () => {}) =>
      pr(m => { edit(m); m.operations.push({ name: "tinyshop.orders", class: "read", target: { method: "GET", path } }); m.version = "2.0.0"; }, { base });
    for (const path of ["/orders/", "/Orders", "/ORDERS/"]) {
      const r = alias(path);
      expect([path, has(r, "needs_card_downgrade", "S"), r.lane, r.verdict, noM(r)]).toEqual([path, true, "core", "NEEDS_HUMAN", []]);
    }
    // The base path moved out of the baseUrl into the target: the same endpoint.
    const moved = alias("/v1/orders", pathedManifest(), m => { m.service.baseUrl = "https://api.tinyshop.example.org/"; });
    expect([has(moved, "needs_card_downgrade", "S"), moved.lane, noM(moved)]).toEqual([true, "core", []]);
    // An MCP tool name in another case.
    const tool = pr(m => { m.operations.push({ name: "tinyshop.order.peek", class: "read", target: { tool: "Place_Order" } }); m.version = "2.0.0"; }, { base: tooledManifest() });
    expect([has(tool, "needs_card_downgrade", "S"), tool.lane]).toEqual([true, "core"]);
    // Controls: another path or tool stays in the lane.
    const other = alias("/orders-history");
    expect([has(other, "needs_card_downgrade"), other.lane]).toEqual([false, "admins"]);
    // The helpers: the host is lower case with no trailing dot, the path has no trailing slash.
    expect(R.endpointOf("https://API.TinyShop.example.org./v1/")).toEqual({ host: "api.tinyshop.example.org", path: "/v1" });
    expect(R.endpointOf("https://api.tinyshop.example.org")).toEqual({ host: "api.tinyshop.example.org", path: "/" });
    expect(R.endpointOf(undefined)).toBeNull();
    expect(R.targetKeys({ target: { method: "GET", path: "/Orders/" } }, "https://API.TinyShop.example.org/v1/"))
      .toEqual(R.targetKeys({ target: { method: "POST", path: "/orders" } }, "https://api.tinyshop.example.org/v1"));
    expect(R.targetKeys({ target: { method: "GET", path: "/orders" } }, "https://api.tinyshop.example.org/v1"))
      .toEqual({ local: ["path /orders", "path /v1/orders"], global: ["api.tinyshop.example.org path /orders", "api.tinyshop.example.org path /v1/orders"] });
    expect(R.targetKeys({ target: { tool: "Place_Order" } }, "https://MCP.tinyshop.example.org/mcp")).toEqual({ local: ["tool place_order"], global: ["mcp.tinyshop.example.org/mcp tool place_order"] });
  });
  test("review-b N-c: a target on another first-party app's endpoint is core (cross_app_target), and so is a baseUrl on its host (cross_app_host)", () => {
    expect(V.validateManifest(othershop()).errors ?? []).toEqual([]);
    const untouched = onOther(m => { m.description = "Reworded."; patch(m); });
    expect([untouched.lane, untouched.verdict, codes(untouched).filter(c => c.startsWith("cross_app"))]).toEqual(["admins", "PASS", []]);
    // review-b's probe: othershop's baseUrl pointed at tinyshop's host, and a write on tinyshop's needs-card target.
    const probe = onOther(m => { m.service.baseUrl = "https://api.tinyshop.example.org/v1"; m.operations.push({ name: "othershop.order", class: "write", target: { method: "POST", path: "/orders" } }); m.version = "2.0.0"; });
    expect([has(probe, "cross_app_target", "S"), has(probe, "cross_app_host", "S"), probe.lane, probe.verdict, noM(probe)]).toEqual([true, true, "core", "NEEDS_HUMAN", []]);
    expect(probe.findings.find(f => f.code === "cross_app_target")?.text).toContain("tinyshop's tinyshop.order.confirm (needs-card)");
    // The same endpoint reached through another split of baseUrl and path.
    const split = onOther(m => { m.service.baseUrl = "https://api.tinyshop.example.org/"; m.operations.push({ name: "othershop.order", class: "write", target: { method: "POST", path: "/v1/Orders/" } }); m.version = "2.0.0"; });
    expect([has(split, "cross_app_target", "S"), split.lane]).toEqual([true, "core"]);
    // The host rule alone: tinyshop's host, no shared target.
    const host = onOther(m => { m.service.baseUrl = "https://api.tinyshop.example.org/v2"; m.version = "2.0.0"; });
    expect([has(host, "cross_app_host", "S"), has(host, "cross_app_target"), host.lane, host.verdict]).toEqual([true, false, "core", "NEEDS_HUMAN"]);
    expect(R.HUMAN_CODES.has("cross_app_target") && R.HUMAN_CODES.has("cross_app_host")).toBe(true);
    // Control: othershop's own /orders on its own host is not another app's endpoint.
    const own = onOther(m => { m.operations.push({ name: "othershop.order", class: "write", target: { method: "POST", path: "/orders" } }); m.version = "2.0.0"; });
    expect([codes(own).filter(c => c.startsWith("cross_app")), own.lane]).toEqual([[], "admins"]);
    // An app main listed after the fork counts too (read at the base tip).
    const NMP = "mini-apps/newshop/manifest.json";
    const newshop = { ...othershop(), id: "newshop", service: { ...othershop().service, baseUrl: "https://api.newshop.example.org/v1" } };
    const tip = { "mini-apps/catalog.json": json({ catalog: 2, apps: ["tinyshop", "othershop", "newshop"] }), [NMP]: json(newshop) };
    const late = onOther(m => { m.service.baseUrl = "https://api.newshop.example.org/v1"; m.version = "2.0.0"; }, { tip });
    expect([has(late, "cross_app_host", "S"), late.lane]).toEqual([true, "core"]);
    expect(has(onOther(m => { m.service.baseUrl = "https://api.newshop.example.org/v1"; m.version = "2.0.0"; }), "cross_app_host")).toBe(false);
  });
  test("review-b N-d: a needs-card op main gained after the fork, plus a write alias on its target in the pull request: NEEDS_HUMAN, core", () => {
    const atTip = tooledManifest(); atTip.version = "1.1.0";
    atTip.operations.push({ name: "tinyshop.express.prepare", class: "prepare", target: { tool: "express_quote" } },
      { name: "tinyshop.express.confirm", class: "needs-card", target: { tool: "express_order" }, maxRequestBytes: 65536, timeoutMs: 60000, approval: { prepare: "tinyshop.express.prepare" } });
    expect(V.validateManifest(atTip).errors ?? []).toEqual([]);
    const write = (m: any) => { m.operations.push({ name: "tinyshop.express.quick", class: "write", target: { tool: "express_order" } }); m.version = "2.0.0"; };
    const r = pr(write, { base: tooledManifest(), tip: { [MP]: json(atTip) } });
    expect([has(r, "needs_card_downgrade", "S"), r.lane, r.verdict, noM(r)]).toEqual([true, "core", "NEEDS_HUMAN", []]);
    // Judged against the merge base alone the same pull request is a PASS: the base tip is what catches it.
    expect(pr(write, { base: tooledManifest() }).verdict).toBe("PASS");
    // The tip's visibility widens the lane too: main raised the app to everyone after the fork.
    const everyone = tooledManifest("everyone"); everyone.version = "1.1.0";
    expect(pr(m => { m.description = "Reworded."; patch(m); }, { base: tooledManifest("admins"), tip: { [MP]: json(everyone) } }).lane).toBe("everyone");
    // An unreadable tip manifest is ignored (the merge base still counts), never a crash.
    expect(pr(write, { base: tooledManifest(), tip: { [MP]: "{ nope" } }).verdict).toBe("PASS");
  });
  test("a new or changed needs-card op needs the human read, even in sandbox", () => {
    const r = pr(m => { m.operations[2].approval.summary = ["Order"]; m.version = "2.0.0"; });
    expect([has(r, "needs_card_review", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
  test("the template render is reported as not run (N), never as a pass", () => {
    const r = pr(patch);
    const t = r.findings.filter(x => x.code === "template_render_not_run");
    expect(t.map(x => x.severity)).toEqual(["N"]);
    expect(t[0].text).toContain("not rendered (not a pass)");
    expect(codes(r).some(c => /render/.test(c) && c !== "template_render_not_run")).toBe(false);
  });
});

describe("conformance: the bot runs P0-5's suite itself (release, L14465)", () => {
  // P0-5's output (ov#422): manifest is the repo-relative path; sha256 is over the exact bytes; not_run is pass: null.
  const out = (h: any, over: any = {}) => Buffer.from(json({ manifest: MP, sha256: sha256(json(h)),
    results: [{ check: "manifest.schema", pass: true, note: "" }, { check: "hygiene.secrets", pass: true, note: "" }], passed: true, ...over }));
  const ran = (over: any = {}, exit: number | null = 0) => (h: any): R.ConformanceRun => ({ status: "ran", exit, bytes: out(h, over) });
  const conf = (r: R.Report) => r.findings.filter(x => x.code.startsWith("conformance")).map(x => [x.code, x.severity]);
  const admins = manifest("admins");
  test("the suite not in the checkout: N conformance_not_available (no S, no M)", () => {
    for (const r of [pr(patch), pr(patch, { base: admins })]) expect([conf(r), r.verdict]).toEqual([[["conformance_not_available", "N"]], "PASS"]);
  });
  test("a passed run for this manifest: quiet, admins PASS", () => {
    const r = pr(patch, { base: admins, conf: ran() });
    expect([conf(r), r.verdict]).toEqual([[], "PASS"]);
  });
  test("another manifest's path or another manifest's bytes (re-serialized included): M", () => {
    expect(conf(pr(patch, { conf: ran({ manifest: "tinyshop@1.0.1" }) }))).toContainEqual(["conformance_wrong_manifest", "M"]);
    expect(conf(pr(patch, { conf: h => ({ status: "ran", exit: 0, bytes: out(h, { sha256: sha256(JSON.stringify(h)) }) }) }))).toContainEqual(["conformance_stale", "M"]);
  });
  test("a failed check: M; passed: true over a failed row, or passed against the exit code: M inconsistent", () => {
    const failed = pr(patch, { conf: ran({ passed: false, results: [{ check: "hygiene.secrets", pass: false, note: "x" }] }, 1) });
    expect([conf(failed), failed.verdict]).toEqual([[["conformance_check_failed", "M"]], "FAIL"]);
    expect(conf(pr(patch, { conf: ran({ results: [{ check: "skills.sha256", pass: false, note: "x" }] }) }))).toContainEqual(["conformance_inconsistent", "M"]);
    expect(conf(pr(patch, { conf: ran({}, 1) }))).toContainEqual(["conformance_inconsistent", "M"]);
    expect(conf(pr(patch, { conf: ran({ passed: false }, 0) }))).toContainEqual(["conformance_inconsistent", "M"]);
  });
  test("required checks not run (pass: null, never a pass): S incomplete, so admins NEEDS_HUMAN and sandbox PASS", () => {
    const notRun = { passed: false, results: [{ check: "manifest.schema", pass: true, note: "" }, { check: "hygiene.secrets", pass: null, note: "no fixtures" }] };
    const a = pr(patch, { base: admins, conf: ran(notRun, 1) });
    expect([conf(a), a.verdict]).toEqual([[["conformance_not_run", "N"], ["conformance_incomplete", "S"]], "NEEDS_HUMAN"]);
    expect(pr(patch, { conf: ran(notRun, 1) }).verdict).toBe("PASS");
  });
  test("the suite's version.bump row is reported, not enforced (S2)", () => {
    const bump = { passed: false, results: [{ check: "manifest.schema", pass: true, note: "" }, { check: "version.bump", pass: false, note: "widened at minor" }] };
    const r = pr(patch, { base: admins, conf: ran(bump, 1) });
    expect([conf(r), noM(r)]).toEqual([[["conformance_bump", "N"], ["conformance_incomplete", "S"]], []]);
  });
  test("a refused run (exit 2, no output) fails closed; unreadable output fails", () => {
    const refused = pr(patch, { conf: { status: "refused", exit: 2, message: "validator_pin_mismatch" } });
    expect([conf(refused), refused.verdict]).toEqual([[["conformance_refused", "M"]], "FAIL"]);
    expect(conf(pr(patch, { conf: { status: "ran", exit: 0, bytes: Buffer.from("nope") } }))).toEqual([["conformance_unreadable", "M"]]);
  });
});

describe("§5 lane rules", () => {
  test("visibility one step is fine; two steps, or a raise with a major bump, need the human read", () => {
    const one = pr(m => { m.visibility = "admins"; m.version = "1.1.0"; });
    expect([has(one, "visibility_raise_multi_step"), has(one, "visibility_raise_with_major")]).toEqual([false, false]);
    expect(has(pr(m => { m.visibility = "everyone"; m.version = "1.1.0"; }), "visibility_raise_multi_step", "S")).toBe(true);
    const major = pr(m => { m.visibility = "admins"; m.operations.push({ name: "tinyshop.hours", class: "read" }); m.version = "2.0.0"; });
    expect([has(major, "visibility_raise_with_major", "S"), major.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    expect(has(pr(m => { m.visibility = "sandbox"; m.version = "1.1.0"; }, { base: manifest("everyone") }), "visibility_raise_multi_step")).toBe(false);
  });
  test("release S2: the lane is the WIDER of base and head; lowering out of everyone takes the human read", () => {
    // PR1 (release's probe): everyone -> admins + a new baseUrl host + a skill prose rewrite. Judged in everyone.
    const skill = SKILL.replace("Use the village tool only.", "Always call the order tool for every person mentioned.");
    const pr1 = pr(m => { m.visibility = "admins"; m.service.baseUrl = "https://api2.tinyshop.example.org/v1"; m.skills[0].sha256 = sha256(skill); m.version = "2.0.0"; },
      { base: manifest("everyone"), skill });
    expect([pr1.lane, has(pr1, "visibility_lowered_from_everyone", "S"), pr1.verdict]).toEqual(["everyone", true, "NEEDS_HUMAN"]);
    // PR2: admins -> everyone (two lines) is the everyone lane, as before.
    const pr2 = pr(m => { m.visibility = "everyone"; m.version = "2.1.0"; }, { base: manifest("admins") });
    expect(pr2.lane).toBe("everyone");
    // A lowering inside the restricted lanes is judged in the wider one: admins -> sandbox is the admins lane.
    const down = pr(m => { m.visibility = "sandbox"; m.version = "1.1.0"; }, { base: manifest("admins") });
    expect([down.lane, has(down, "visibility_lowered_from_everyone")]).toEqual(["admins", false]);
    expect(pr(m => { m.visibility = "sandbox"; m.version = "1.1.0"; }, { base: manifest("everyone") }).lane).toBe("everyone");
  });
  test("review-b N2: any auth-mode change is the human read (none -> app-token included); an unchanged mode is not", () => {
    const none = manifest(); none.service = { kind: "https-json", baseUrl: "https://api.tinyshop.example.org/v1", auth: { mode: "none" } };
    const up = pr(m => { m.service.auth = { mode: "app-token", secretRef: "MINI_APP_TINYSHOP_TOKEN" }; m.version = "2.0.0"; }, { base: none });
    expect([noM(up), has(up, "auth_mode_review", "S"), up.verdict]).toEqual([[], true, "NEEDS_HUMAN"]);
    const downgrade = pr(m => { m.service.auth = { mode: "none" }; m.version = "2.0.0"; });
    expect([has(downgrade, "auth_mode_review", "S"), downgrade.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    expect(has(pr(patch), "auth_mode_review")).toBe(false);
  });
  test("review-b N3: a manifest absent at the merge base is a new app, core, even when catalog.json already lists its id", () => {
    const listed = json({ catalog: 2, apps: ["tinyshop"] });
    const r = R.evaluate(source({ "mini-apps/catalog.json": listed }, { [MP]: json(manifest()), [SP]: SKILL }), V);
    expect([r.lane, r.verdict, has(r, "new_app", "S"), has(r, "catalog_unlisted")]).toEqual(["core", "NEEDS_HUMAN", true, false]);
  });
  test("a new oauth block needs the human read, even in sandbox; an unchanged one does not", () => {
    const oauth = { kind: "mcp", baseUrl: "https://mcp.tinyshop.example.org/mcp", auth: { mode: "oauth", oauth: { resource: "https://mcp.tinyshop.example.org/mcp", scopes: ["menu:read"], discovery: "https://mcp.tinyshop.example.org/.well-known/oauth-authorization-server" } } };
    const r = pr(m => { m.service = oauth; m.version = "2.0.0"; });
    expect([noM(r), has(r, "oauth_review", "S"), r.verdict]).toEqual([[], true, "NEEDS_HUMAN"]);
    const base = manifest(); base.service = oauth;
    expect(has(pr(patch, { base }), "oauth_review")).toBe(false);
  });
  test("an events block: the human read; entering everyone is named so", () => {
    const ev = { "miniapp.tinyshop.order@1": { orderId: "string" } };
    const r = pr(m => { m.events = ev; m.version = "2.0.0"; });
    expect([has(r, "events_review", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    const base = manifest("admins"); base.events = ev;
    expect(has(pr(m => { m.visibility = "everyone"; m.version = "1.1.0"; }, { base }), "events_entering_everyone", "S")).toBe(true);
    expect(has(pr(patch, { base }), "events_review")).toBe(false);
  });
});

describe("the five real manifests, as a no-change pull request", () => {
  const index = JSON.parse(readFileSync(join(REPO, "mini-apps/catalog.json"), "utf8"));
  const real = (path: string) => { try { return readFileSync(join(REPO, path)); } catch { return null; } };
  for (const id of index.apps as string[]) {
    test(`${id}: PASS or NEEDS_HUMAN, no M, never a crash`, () => {
      const r = R.evaluate({ files: [{ path: `mini-apps/${id}/manifest.json`, status: "M", oldMode: "100644", newMode: "100644" }], base: real, head: real, added: () => [], headSha: "e".repeat(40), author: "someone" }, V);
      expect(["PASS", "NEEDS_HUMAN"]).toContain(r.verdict);
      expect([id, noM(r)]).toEqual([id, []]);
      // gold-stars is a baseline skill (install/paths.ts): core whatever its manifest says (release S2).
      expect([id, r.lane === "core"]).toEqual([id, R.BASELINE_SKILLS.has(id)]);
      if (R.BASELINE_SKILLS.has(id)) { expect([r.verdict, has(r, "baseline_skill", "S")]).toEqual(["NEEDS_HUMAN", true]); return; }
      // Every required check ran; only the advisory conformance (P0-5 not on this base) is listed as not run.
      expect(r.checked).toEqual(R.CHECKED.filter(c => c !== "conformance"));
      expect(r.not_run.map(n => n.check)).toEqual(["conformance"]);
      for (const c of R.REQUIRED_CHECKS) expect(r.checked).toContain(c);
    });
  }
});

describe("fail closed: an error, a missing input or an unknown state is never a PASS", () => {
  const ch = (path: string, status = "M", newMode = "100644"): R.Change => ({ path, status, oldMode: "100644", newMode });
  test("an empty diff is core and NEEDS_HUMAN, with every manifest check listed as not run", () => {
    const r = R.evaluate(source(baseFiles(), {}), V);
    expect([r.lane, r.verdict, codes(r)]).toEqual(["core", "NEEDS_HUMAN", ["empty_diff"]]);
    expect(r.checked).toEqual(["paths", "secrets"]);
    expect(r.not_run.map(n => n.check)).toEqual(R.CHECKED.filter(c => c !== "paths" && c !== "secrets"));
  });
  test("a diff that cannot be attributed to one id is core (two ids, a top-level file, a bad id)", () => {
    for (const extra of [{ "skills/other/SKILL.md": "x\n" }, { "mini-apps/README.md": "x\n" }, { "skills/Bad_Id/SKILL.md": "x\n" }]) {
      const r = pr(patch, { extra });
      expect([Object.keys(extra)[0], r.lane, r.verdict]).toEqual([Object.keys(extra)[0], "core", "NEEDS_HUMAN"]);
    }
  });
  test("a rename counts as both paths: moved out of mini-apps/<id>/ into core is core, either direction", () => {
    const raw = (from: string, to: string) => `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R100\0${from}\0${to}\0`;
    const out = R.parseRawDiff(raw("mini-apps/tinyshop/README.md", "docs/x.md"));
    expect(out.map(f => [f.status, f.path])).toEqual([["R", "mini-apps/tinyshop/README.md"], ["R", "docs/x.md"]]);
    expect(R.classify(out).id).toBeNull();
    expect(R.classify(R.parseRawDiff(raw("scripts/x.ts", "skills/tinyshop/SKILL.md"))).id).toBeNull();
    const mixed = R.parseRawDiff(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0${MP}\0` + raw("x.md", SP).replace(/^:/, ":"));
    expect(mixed.map(f => f.path)).toEqual([MP, "x.md", SP]);
    expect(() => R.parseRawDiff(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R100\0only-one\0`)).toThrow(R.BotError);
    expect(() => R.parseRawDiff("garbage\0x\0")).toThrow(R.BotError);
  });
  test("a rename inside one lane, a type change or an unmerged entry: the human read, even in sandbox", () => {
    for (const status of ["R", "C", "T", "U", "X"]) {
      const src = source(baseFiles(), { [MP]: json({ ...manifest(), version: "1.0.1" }) });
      src.files.push(ch("mini-apps/tinyshop/README.md", status));
      const r = R.evaluate(src, V);
      expect([status, has(r, "path_status_unknown", "S"), r.verdict]).toEqual([status, true, "NEEDS_HUMAN"]);
    }
  });
  test("an executable or other odd mode on a catalog file: the human read", () => {
    const r = pr(patch, { modes: { [MP]: "100755" } });
    expect([has(r, "path_mode_unusual", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
  test("a binary file cannot be scanned: FAIL in a catalog path, the human read elsewhere", () => {
    const src = source(baseFiles(), { [MP]: json({ ...manifest(), version: "1.0.1" }), "mini-apps/tinyshop/README.md": "x" });
    src.added = path => (path.endsWith("README.md") ? "binary" : []);
    expect(has(R.evaluate(src, V), "binary_file", "M")).toBe(true);
    const core = source(baseFiles(), { "docs/logo.png": "x" });
    core.added = () => "binary";
    const r = R.evaluate(core, V);
    expect([has(r, "binary_unscanned", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
  test("the base manifest missing when the pull request edits it: the human read; the base checks are not run", () => {
    const src = source(baseFiles(), { [MP]: json({ ...manifest(), version: "1.0.1" }) });
    src.base = path => (path === MP ? null : Buffer.from(baseFiles()[path] ?? ""));
    const r = R.evaluate(src, V);
    expect([has(r, "base_manifest_missing", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    expect(r.not_run.map(n => n.check)).toEqual(expect.arrayContaining(["version_bump", "approval_classes", "lane_rules"]));
    expect(r.findings.filter(f => f.code === "check_not_run").map(f => f.text.split(" ")[3])).toEqual(["approval_classes", "lane_rules"]);
  });
  test("an added manifest that already exists at the base, a base that is not JSON, a base that is not v2: the human read", () => {
    const added = R.evaluate({ ...source(baseFiles(), { [MP]: json({ ...manifest(), version: "1.0.1" }) }), files: [ch(MP, "A")] }, V);
    expect([has(added, "base_manifest_unexpected", "S"), added.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    const notJson = R.evaluate(source({ ...baseFiles(), [MP]: "{ nope" }, { [MP]: json({ ...manifest(), version: "1.0.1" }) }), V);
    expect([has(notJson, "base_unparseable", "S"), has(notJson, "check_not_run"), notJson.verdict]).toEqual([true, true, "NEEDS_HUMAN"]);
    const v1 = manifest(); v1.manifest = 1;
    const invalid = R.evaluate(source(baseFiles(v1), { [MP]: json({ ...manifest(), version: "1.0.1" }) }), V);
    expect([has(invalid, "base_invalid", "S"), invalid.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
  test("catalog.json missing or not JSON at head: the human read", () => {
    for (const body of [null, "{ nope"]) {
      // The diff stays a manifest lane; only the head read of catalog.json comes back missing or broken.
      const src = source(baseFiles(), { [MP]: json({ ...manifest(), version: "1.0.1" }) });
      const head = src.head;
      src.head = path => (path === "mini-apps/catalog.json" ? (body === null ? null : Buffer.from(body)) : head(path));
      const r = R.evaluate(src, V);
      expect([String(body), r.lane, has(r, "catalog_unreadable", "S"), r.verdict]).toEqual([String(body), "sandbox", true, "NEEDS_HUMAN"]);
    }
  });
  test("a skills[] entry without a skills/<name>/SKILL.md path fails, never skipped", () => {
    const r = pr(m => { m.skills[0].path = "elsewhere.md"; patch(m); });
    expect([has(r, "skill_path_invalid", "M"), r.verdict]).toEqual([true, "FAIL"]);
  });
  test("a manifest with no skills: hashes did not run, never a PASS", () => {
    const r = pr(m => { m.skills = []; patch(m); });
    expect([r.not_run.map(n => n.check).includes("hashes"), r.verdict]).toEqual([true, "FAIL"]);
    expect(r.findings.some(f => f.code === "check_not_run" && f.text.includes("hashes"))).toBe(true);
  });
  test("a validator that refuses without a reason is still a FAIL", () => {
    const quiet: R.Validator = { ...V, validateManifest: () => ({ ok: false, errors: [] }) };
    expect(R.evaluate(source(baseFiles(), { [MP]: json({ ...manifest(), version: "1.0.1" }) }), quiet).verdict).toBe("FAIL");
  });
  test("verdictOf: a check_not_run finding blocks PASS in every lane", () => {
    for (const lane of ["sandbox", "admins", "everyone"] as const) expect(R.verdictOf(lane, [{ code: "check_not_run", severity: "S", text: "t" }])).toBe("NEEDS_HUMAN");
  });
});

// ---- The git layer and the CLI, on a throwaway repository ------------------------------------------
function gitRepo(): { dir: string; run: (...args: string[]) => string; commit: (files: Files, msg: string, modes?: Record<string, string>) => string } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-git-"));
  const run = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return String(r.stdout).trim();
  };
  run("init", "-q", "-b", "main");
  const commit = (files: Files, msg: string, modes: Record<string, string> = {}) => {
    for (const [path, body] of Object.entries(files)) {
      const p = join(dir, path);
      if (body === null) { rmSync(p, { force: true }); continue; }
      mkdirSync(dirname(p), { recursive: true });
      rmSync(p, { force: true });
      if (modes[path] === "120000") symlinkSync(body, p); else writeFileSync(p, body);
    }
    run("add", "-A");
    run("commit", "-q", "-m", msg);
    return run("rev-parse", "HEAD");
  };
  return { dir, run, commit };
}
const cli = (args: string[]) => {
  let out = "", err = "";
  const code = R.main(args, { stdout: s => { out += s; }, stderr: s => { err += s; } });
  return { code, report: JSON.parse(out) as R.Report, err };
};

describe("git and the CLI", () => {
  test("end to end: exit 0, the JSON on stdout and in --out, the summary in --summary", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      g.run("checkout", "-q", "-b", "pr");
      const skill = SKILL.replace("only.", "only, always.");
      const m = manifest(); m.version = "1.0.1"; m.skills[0].sha256 = sha256(skill);
      const head = g.commit({ [MP]: json(m), [SP]: skill }, "pr");
      // The base branch moves on after the fork: base...head diffs from the merge base, so this is not in the pull request.
      g.run("checkout", "-q", "main");
      const moved = g.commit({ "scripts/other.ts": "x\n" }, "main moves");
      const out = join(g.dir, "..", `${base.slice(0, 8)}-review.json`), md = join(g.dir, "..", `${base.slice(0, 8)}-review.md`);
      const { code, report, err } = cli(["--base", moved, "--head", head, "--author", "someone", "--repo", g.dir, "--out", out, "--summary", md]);
      expect([code, report.verdict, report.lane, report.manifest, report.head]).toEqual([0, "PASS", "sandbox", "tinyshop@1.0.1", head]);
      expect(noM(report)).toEqual([]);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(report);
      expect(readFileSync(md, "utf8")).toContain("**PASS** · lane `sandbox`");
      expect(err).toContain("Mini-apps review");
      rmSync(out); rmSync(md);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("ov#477 fold 1 (review-b M1): --pr and --base-ref go into the JSON with base_sha (--base resolved); absent => null; malformed => exit 2", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      g.run("checkout", "-q", "-b", "pr");
      const m = manifest(); m.version = "1.0.1"; m.description = "Reworded.";
      const head = g.commit({ [MP]: json(m) }, "pr");
      const bound = cli(["--base", "main", "--head", head, "--repo", g.dir, "--pr", "12", "--base-ref", "main"]);
      expect([bound.code, bound.report.pr, bound.report.base_ref, bound.report.base_sha]).toEqual([0, 12, "main", base]);
      const keys = Object.keys(bound.report);
      expect(keys.slice(0, 7)).toEqual(["bot", "version", "manifest", "head", "pr", "base_ref", "base_sha"]);
      const bare = cli(["--base", base, "--head", head, "--repo", g.dir]);
      expect([bare.code, bare.report.pr, bare.report.base_ref, bare.report.base_sha]).toEqual([0, null, null, base]);
      for (const [flag, value] of [["--pr", "0"], ["--pr", "12x"], ["--pr", "-1"], ["--pr", "1e3"], ["--pr", "012"], ["--base-ref", "a..b"], ["--base-ref", "-x"], ["--base-ref", "main\nx"]]) {
        const bad = cli(["--base", base, "--head", head, "--repo", g.dir, flag, value]);
        expect([flag, value, bad.code, bad.report.verdict, bad.report.pr, bad.report.base_ref, bad.report.base_sha]).toEqual([flag, value, 2, "FAIL", null, null, null]);
      }
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("review-b N-e (mutant k12) and N-d, real git: main moves the manifest after the fork; the bump is judged against the MERGE base, and the base tip's card op still counts", () => {
    const g = gitRepo();
    try {
      const fork = g.commit(baseFiles(tooledManifest()), "base");
      g.run("checkout", "-q", "-b", "pr");
      // The pull request: a write on express_order, at 2.0.0.
      const h = tooledManifest(); h.version = "2.0.0";
      h.operations.push({ name: "tinyshop.express.quick", class: "write", target: { tool: "express_order" } });
      const head = g.commit({ [MP]: json(h) }, "pr: a write on express_order");
      // main, after the fork: a needs-card op on express_order, at 1.1.0.
      g.run("checkout", "-q", "main");
      const t = tooledManifest(); t.version = "1.1.0";
      t.operations.push({ name: "tinyshop.express.prepare", class: "prepare", target: { tool: "express_quote" } },
        { name: "tinyshop.express.confirm", class: "needs-card", target: { tool: "express_order" }, maxRequestBytes: 65536, timeoutMs: 60000, approval: { prepare: "tinyshop.express.prepare" } });
      const tip = g.commit({ [MP]: json(t) }, "main: an express card op");
      const bumpText = (r: R.Report) => r.findings.find(f => f.code.startsWith("version"))?.text ?? "";
      // As CI calls it (--base = the base sha, the tip): the diff and the bump are from the merge base (1.0.0),
      // never the tip (1.1.0), and main's own ops are not "removed" by this pull request (k12: mergeBase = base).
      const ci = R.review({ repo: g.dir, base: tip, head });
      expect([bumpText(ci).startsWith("version 1.0.0 -> 2.0.0"), has(ci, "needs_card_removed"), has(ci, "version_not_monotonic")]).toEqual([true, false, false]);
      expect(ci.findings.filter(f => f.code === "core_path")).toEqual([]);
      // N-d: the tip's card op makes the pull request's write an alias: core.
      expect([has(ci, "needs_card_downgrade", "S"), ci.lane, ci.verdict]).toEqual([true, "core", "NEEDS_HUMAN"]);
      // The same through --base-tip, with --base at the fork: the tip is read as data.
      const viaTip = cli(["--base", fork, "--head", head, "--base-tip", "main", "--repo", g.dir]);
      expect([viaTip.code, viaTip.report.verdict, viaTip.report.lane, has(viaTip.report, "needs_card_downgrade", "S")]).toEqual([0, "NEEDS_HUMAN", "core", true]);
      // Control: judged at the fork with no tip, the write is a plain new op (no alias, the admins lane): the tip is
      // what catches it. (No verdict here: with P0-5's suite in the tree, its incomplete run is S in admins.)
      const forkOnly = R.review({ repo: g.dir, base: fork, head });
      expect([forkOnly.lane, has(forkOnly, "needs_card_downgrade"), noM(forkOnly)]).toEqual(["admins", false, []]);
      // A tip that does not resolve is a bot error (exit 2), never "no tip".
      const bad = cli(["--base", fork, "--head", head, "--base-tip", "no-such-branch-xyz", "--repo", g.dir]);
      expect([bad.code, bad.report.verdict, bad.report.findings[0].text]).toEqual([2, "FAIL", expect.stringMatching(/^git_failed: git rev-parse/)]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("real git: added-line numbers, the symlink mode, a core path", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      const skill = SKILL + "\n" + "pass" + "word=hunter22\n";
      const m = manifest(); m.version = "1.0.1"; m.skills[0].sha256 = sha256(skill);
      const head = g.commit({ [MP]: json(m), [SP]: skill, "mini-apps/tinyshop/README.md": "../../etc" }, "pr", { "mini-apps/tinyshop/README.md": "120000" });
      const r = R.review({ repo: g.dir, base, head, author: "someone" });
      const hit = r.findings.find(f => f.code === "secret_in_diff");
      expect([hit?.file, hit?.line]).toEqual([SP, skill.split("\n").length - 1]);
      expect(has(r, "path_symlink", "M")).toBe(true);
      const files = R.changedFiles(g.dir, base, head);
      expect(files.find(f => f.path.endsWith("README.md"))?.newMode).toBe("120000");
      const core = g.commit({ "install/x.ts": "x\n" }, "core");
      expect(R.review({ repo: g.dir, base, head: core }).lane).toBe("core");
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  // A stand-in for P0-5's suite at scripts/mini-apps-conformance.ts: it records its argv in its one row.
  const fakeSuite = (exit: number, write: boolean) => [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { createHash } from "node:crypto";',
    "const a = process.argv.slice(2);",
    write ? 'writeFileSync(a[a.indexOf("--out") + 1], JSON.stringify({ manifest: a[0].slice(a[0].lastIndexOf("/mini-apps/") + 1), sha256: createHash("sha256").update(readFileSync(a[0])).digest("hex"), results: [{ check: "argv", pass: true, note: [process.execArgv.join(","), process.cwd(), ...a].join(" ") }], passed: true }));' : "",
    `process.exit(${exit});`, "",
  ].join("\n");
  /** A throwaway tool tree holding only a suite at scripts/mini-apps-conformance.ts (the validator is passed as V). */
  const toolWith = (suite: string | null) => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-tool-"));
    if (suite) { mkdirSync(join(dir, "scripts"), { recursive: true }); writeFileSync(join(dir, R.CONFORMANCE_PATH), suite); }
    return dir;
  };
  const withSuite = (suite: string | null, repoSuite: string | null = null) => {
    const g = gitRepo();
    // The repository under review may hold a suite of its own (at base and head alike, so the pull request
    // stays in the lane): it is data, never run. Only the tool tree's suite runs.
    const base = g.commit({ ...baseFiles(), ...(repoSuite ? { [R.CONFORMANCE_PATH]: repoSuite } : {}) }, "base");
    const m = manifest(); m.version = "1.0.1"; m.description = "Reworded.";
    const head = g.commit({ [MP]: json(m) }, "pr");
    return { g, base, head, tool: toolWith(suite), m };
  };
  test("the TOOL's suite runs, never the pull request's, on head's bytes from git objects, always with --base, and is judged", () => {
    const forged = fakeSuite(0, true).replace('note: [process.execArgv.join(","), process.cwd(), ...a].join(" ")', 'note: "FORGED BY THE REPO"');
    expect(forged).toContain("FORGED BY THE REPO");
    const { g, base, head, tool, m } = withSuite(fakeSuite(0, true), forged);
    const saved = join(g.dir, "..", `${base.slice(0, 8)}-conformance`);
    try {
      // The repository's working tree is at the BASE (as in CI): the head is only ever read through git.
      g.run("checkout", "-q", base);
      const r = R.review({ repo: g.dir, base, head, validator: V, toolRoot: tool, conformanceDir: saved });
      expect([r.verdict, r.findings.filter(f => f.code.startsWith("conformance"))]).toEqual(["PASS", []]);
      const written = JSON.parse(readFileSync(join(saved, "tinyshop.conformance.json"), "utf8"));
      expect([written.manifest, written.sha256]).toEqual([MP, sha256(json(m))]);
      const [flags, cwd, manifestArg, ...rest] = written.results[0].note.split(" ");
      // From the tool tree, with bun's config, .env, auto-install and a cwd tsconfig.json all off (review-b N-a).
      expect([flags, cwd]).toEqual(["--config=/dev/null,--no-env-file,--no-install,--tsconfig-override=/dev/null", realpathSync(tool)]);
      expect(manifestArg.endsWith(`/${MP}`) && !manifestArg.startsWith(realpathSync(g.dir))).toBe(true);
      expect([rest[0], rest[2]]).toEqual(["--base", "--out"]);
      // --base names the throwaway repository's one commit: the merge base's manifest, byte for byte.
      expect(rest[1]).toMatch(/^[0-9a-f]{40}$/);
      expect(readFileSync(join(g.dir, MP), "utf8")).toBe(json(manifest()));
      // No throwaway data or output directory is left behind.
      expect(readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith("mini-apps-review-data-") || n.startsWith("mini-apps-review-conformance-"))).toEqual([]);
    } finally { for (const d of [g.dir, saved, tool]) rmSync(d, { recursive: true, force: true }); }
  });
  test("a suite that refuses (exit 2, no conformance.json) fails closed; no suite in the tool tree is N, whatever the repository holds", () => {
    for (const [suite, prSuite, code, severity] of [[fakeSuite(2, false), null, "conformance_refused", "M"], [null, fakeSuite(0, true), "conformance_not_available", "N"]] as const) {
      const { g, base, head, tool } = withSuite(suite, prSuite);
      try {
        const r = R.review({ repo: g.dir, base, head, validator: V, toolRoot: tool });
        expect(r.findings.filter(f => f.code.startsWith("conformance")).map(f => [f.code, f.severity])).toEqual([[code, severity]]);
      } finally { rmSync(g.dir, { recursive: true, force: true }); rmSync(tool, { recursive: true, force: true }); }
    }
  });
  test("a shallow or partial clone cannot be judged: exit 2", () => {
    const { g, base, head, tool } = withSuite(null);
    rmSync(tool, { recursive: true, force: true });
    const shallow = `${g.dir}-shallow`;
    try {
      const c = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${g.dir}`, shallow]);
      expect(c.status).toBe(0);
      const s1 = cli(["--base", "HEAD", "--head", "HEAD", "--repo", shallow]);
      expect([s1.code, s1.report.findings[0].text]).toEqual([2, "shallow_checkout: fetch the full history (fetch-depth: 0)"]);
      g.run("config", "core.repositoryformatversion", "1");
      g.run("config", "extensions.partialClone", "origin");
      const s2 = cli(["--base", base, "--head", head, "--repo", g.dir]);
      expect([s2.code, s2.report.verdict, s2.report.findings[0].code]).toEqual([2, "FAIL", "bot_error"]);
      expect(s2.report.findings[0].text).toMatch(/^partial_clone/);
    } finally { rmSync(g.dir, { recursive: true, force: true }); rmSync(shallow, { recursive: true, force: true }); }
  });
  test("real git: a file moved out of the lane with git mv is both paths, so core", () => {
    const g = gitRepo();
    try {
      const base = g.commit({ ...baseFiles(), "mini-apps/tinyshop/README.md": "# Tiny Shop\nA readme long enough to be found as a rename.\n" }, "base");
      g.run("mv", "mini-apps/tinyshop/README.md", "docs-tinyshop.md");
      g.run("commit", "-q", "-m", "move");
      const head = g.run("rev-parse", "HEAD");
      const r = R.review({ repo: g.dir, base, head });
      expect(r.findings.filter(f => f.code === "core_path").map(f => f.file)).toEqual(["docs-tinyshop.md"]);
      expect([r.lane, r.verdict]).toEqual(["core", "NEEDS_HUMAN"]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("real git: a file that is listed but unreadable is a git failure (exit 2), never \"missing\"", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      const m = manifest(); m.version = "1.0.1";
      const head = g.commit({ [MP]: json(m) }, "pr");
      // catalog.json is unchanged, so only the bot's own read (blobAt) touches its blob, not git diff.
      const blob = g.run("rev-parse", `${base}:mini-apps/catalog.json`);
      rmSync(join(g.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
      const { code, report } = cli(["--base", base, "--head", head, "--repo", g.dir]);
      expect([code, report.verdict, report.findings[0].code]).toEqual([2, "FAIL", "bot_error"]);
      expect(report.findings[0].text).toMatch(/^git_failed/);
      expect(report.not_run.map(n => n.check)).toEqual([...R.CHECKED]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("a throw inside a check is exit 2 and FAIL, never caught into a PASS", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      const m = manifest(); m.version = "1.0.1";
      const head = g.commit({ [MP]: json(m) }, "pr");
      const boom: R.Validator = { ...V, validateManifest: () => { throw new Error("boom"); } };
      let out = "";
      const code = R.main(["--base", base, "--head", head, "--repo", g.dir], { validator: boom, stdout: s => { out += s; }, stderr: () => {} });
      const report = JSON.parse(out);
      expect([code, report.verdict, report.findings[0].code, report.checked]).toEqual([2, "FAIL", "bot_error", []]);
      expect(report.findings[0].text).toMatch(/^bot_crashed: Error: boom/);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("release N1: exit 1 on a FAIL verdict (the job goes red), 0 on PASS and NEEDS_HUMAN, 2 when the bot cannot judge", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      g.run("checkout", "-q", "-b", "pr");
      const stale = g.commit({ [SP]: SKILL.replace("only.", "only, always.") }, "a skill edit without its hash");
      const failed = cli(["--base", base, "--head", stale, "--repo", g.dir]);
      expect([failed.code, failed.report.verdict, has(failed.report, "skill_hash_mismatch", "M")]).toEqual([1, "FAIL", true]);
      const core = g.commit({ "install/x.ts": "x\n" }, "core");
      // A core pull request is NEEDS_HUMAN (the lane checks do not run on it): exit 0.
      expect([cli(["--base", base, "--head", core, "--repo", g.dir]).code, cli(["--base", base, "--head", core, "--repo", g.dir]).report.verdict]).toEqual([0, "NEEDS_HUMAN"]);
      g.run("checkout", "-q", "main");
      const m = manifest(); m.version = "1.0.1"; m.description = "Reworded.";
      const ok = g.commit({ [MP]: json(m) }, "ok");
      expect([cli(["--base", base, "--head", ok, "--repo", g.dir]).code, cli(["--base", base, "--head", ok, "--repo", g.dir]).report.verdict]).toEqual([0, "PASS"]);
      expect(cli(["--base", "no-such-rev-xyz", "--head", ok, "--repo", g.dir]).code).toBe(2);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("review-b N5 (m7): an added line whose text starts with \"++\" is scanned like any other", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      const skill = SKILL + "++" + "pass" + "word=hunter22\n" + "+++ " + "gh" + "p_" + "A1b2C3d4".repeat(5) + "\n";
      const m = manifest(); m.version = "1.0.1"; m.skills[0].sha256 = sha256(skill);
      const head = g.commit({ [MP]: json(m), [SP]: skill }, "pr");
      const hits = R.review({ repo: g.dir, base, head }).findings.filter(f => f.code === "secret_in_diff").map(f => [f.file, f.line]);
      const n = skill.split("\n").length;
      expect(hits).toEqual([[SP, n - 2], [SP, n - 1]]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test.skipIf(!existsSync(join(REPO, R.CONFORMANCE_PATH)))("with P0-5's real suite in the tool tree: it runs on head's bytes and is judged (the merged tree)", () => {
    const g = gitRepo();
    const saved = join(g.dir, "..", "real-suite-conformance");
    try {
      const base = g.commit(baseFiles(), "base");
      const m = manifest(); m.version = "1.0.1"; m.description = "Reworded.";
      const head = g.commit({ [MP]: json(m) }, "pr");
      g.run("checkout", "-q", base);
      const r = R.review({ repo: g.dir, base, head, conformanceDir: saved });
      expect([noM(r), r.checked.includes("conformance")]).toEqual([[], true]);
      const written = JSON.parse(readFileSync(join(saved, "tinyshop.conformance.json"), "utf8"));
      expect([written.manifest, written.sha256]).toEqual([MP, sha256(json(m))]);
      const row = (check: string) => written.results.find((x: any) => x.check === check);
      expect([row("manifest.schema").pass, row("skills.sha256").pass, row("version.bump").pass]).toEqual([true, true, true]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); rmSync(saved, { recursive: true, force: true }); }
  });
  // Each on its own full throwaway repository: CI's test.yml checkout is shallow (fetch-depth: 2), and a
  // shallow clone is refused on purpose, so this repository is never the --repo here.
  test("base = head: an empty diff is core and NEEDS_HUMAN, exit 0, never a crash", () => {
    const g = gitRepo();
    try {
      g.commit(baseFiles(), "base");
      const { code, report } = cli(["--base", "HEAD", "--head", "HEAD", "--repo", g.dir]);
      expect([code, report.verdict, report.lane, codes(report)]).toEqual([0, "NEEDS_HUMAN", "core", ["empty_diff"]]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("bad usage and a revision that does not resolve: exit 2, FAIL, bot_error, for that reason", () => {
    const g = gitRepo();
    try {
      g.commit(baseFiles(), "base");
      const cases: [string[], RegExp][] = [
        [[], /^usage/], [["--base", "HEAD"], /^usage/], [["--base", "--head", "HEAD"], /^usage/],
        [["--base", "HEAD..x", "--head", "HEAD", "--repo", g.dir], /^bad_revision/],
        [["--base", "no-such-rev-xyz", "--head", "HEAD", "--repo", g.dir], /^git_failed: git rev-parse/],
        [["--base", "HEAD", "--head", "HEAD", "--author", "a b", "--repo", g.dir], /^usage: --author/],
      ];
      for (const [args, why] of cases) {
        const { code, report } = cli(args);
        expect([args.join(" "), code, report.verdict, report.findings[0].code]).toEqual([args.join(" "), 2, "FAIL", "bot_error"]);
        expect(report.findings[0].text).toMatch(why);
      }
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
});


/** The steps of mini-apps-review.yml, read from this file's own shape (no YAML package needed). */
type Step = { name?: string; uses?: string; run?: string; env: Record<string, string>; with: Record<string, string> };
function workflowSteps(text: string): Step[] {
  const lines = text.split("\n");
  const start = lines.findIndex(l => l === "    steps:");
  const steps: Step[] = [];
  let cur: Step | null = null, block: "env" | "with" | "run" | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line)) continue;
    const dash = /^      - (\w[\w-]*): ?(.*)$/.exec(line);
    if (dash) { cur = { env: {}, with: {} }; steps.push(cur); block = null; (cur as any)[dash[1]] = dash[2]; continue; }
    if (!cur) continue;
    const key = /^        ([\w-]+):(?: (.*))?$/.exec(line);
    if (key) {
      block = key[1] === "env" || key[1] === "with" ? key[1] : key[1] === "run" ? "run" : null;
      if (key[1] === "run") cur.run = key[2] && key[2] !== "|" ? key[2] : "";
      else if (!block) (cur as any)[key[1]] = key[2];
      continue;
    }
    if (block === "run" && (line.startsWith("          ") || line === "")) { cur.run += line.slice(10) + "\n"; continue; }
    const sub = /^          ([\w-]+): (.*)$/.exec(line);
    if (sub && (block === "env" || block === "with")) { cur[block][sub[1]] = sub[2]; continue; }
    if (line && !line.startsWith("      ")) break;
  }
  return steps;
}
describe("the workflow", () => {
  const wf = readFileSync(join(REPO, ".github/workflows/mini-apps-review.yml"), "utf8");
  test("read-only, pull_request on mini-apps/** and skills/**, no secrets in the review job, actions pinned by full sha", () => {
    expect(wf).toMatch(/\npermissions:\n  contents: read\n/);
    expect(wf).toContain('      - "mini-apps/**"\n      - "skills/**"\n');
    const code = wf.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    // P0-3 bot wiring: the review job (everything before the comment job) holds no secret and no write token.
    // The comment job's App token (Pull requests write, two secrets by name) is pinned in
    // scripts/tests/mini-apps-review-comment.test.ts; here only its one write grant is allowed.
    const jobs = code.split("\n  comment:\n");
    expect(jobs.length).toBe(2);
    expect(jobs[0]).not.toMatch(/pull_request_target|secrets\.|GITHUB_TOKEN|github\.token|write-all|: write\b|issues:|pull-requests:/);
    expect(code).not.toMatch(/pull_request_target|GITHUB_TOKEN|github\.token|write-all|issues:/);
    expect(code.match(/^.*: write\b.*$/gm)).toEqual(["          permission-pull-requests: write"]);
    const uses = [...wf.matchAll(/uses: (\S+)/g)].map(m => m[1]);
    expect(uses.length).toBe(7);
    for (const u of uses) expect(u).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
    expect(wf).toContain("persist-credentials: false");
    expect(wf).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(wf).toContain("name: mini-apps-review");
    // Exit 2 (the bot could not judge) must fail the job: nothing hides it.
    expect(code).not.toMatch(/continue-on-error|\|\|\s*true|\|\|\s*:|set \+e/);
    expect(wf).toContain("**FAIL** (bot_error)");
  });
  test("release S1: the tool is the BASE commit (the only checkout); the head is fetched as objects only and judged at its own sha", () => {
    const steps = workflowSteps(wf);
    const checkouts = steps.filter(s => s.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBe(1);
    expect(checkouts[0].with).toEqual({ ref: "${{ github.event.pull_request.base.sha }}", path: "tool", "fetch-depth": "0", "persist-credentials": "false" });
    const fetch = steps.find(s => s.name === "Fetch the pull request head (data only)")!;
    const review = steps.find(s => s.name === "Review")!;
    expect(fetch.env).toEqual({ PR_NUMBER: "${{ github.event.pull_request.number }}", HEAD_SHA: "${{ github.event.pull_request.head.sha }}", BASE_REF: "${{ github.event.pull_request.base.ref }}" });
    expect(fetch.run).toContain('git -C tool fetch --no-tags --no-recurse-submodules --quiet origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pull/head"');
    // review-b N-d: the base branch's tip, as data too.
    expect(fetch.run).toContain('git -C tool fetch --no-tags --no-recurse-submodules --quiet origin "+refs/heads/${BASE_REF}:refs/remotes/base/tip"');
    expect(review.env).toEqual({ BASE_SHA: "${{ github.event.pull_request.base.sha }}", HEAD_SHA: "${{ github.event.pull_request.head.sha }}", PR_AUTHOR: "${{ github.event.pull_request.user.login }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}", BASE_REF: "${{ github.event.pull_request.base.ref }}" });
    // ov#477 fold 1 (review-b M1): the JSON names the pull request and the base it judged, from the same event.
    expect(review.run).toContain('--pr "$PR_NUMBER" --base-ref "$BASE_REF"');
    // review-b N-a: by explicit path (no package.json script can shadow it) and with no cwd tsconfig.json.
    expect(review.run).toStartWith("bun --config=/dev/null --no-env-file --no-install --tsconfig-override=/dev/null ./tool/scripts/mini-apps-review.ts --repo tool \\\n");
    expect(review.run).toContain('--base "$BASE_SHA" --head "$HEAD_SHA" --base-tip refs/remotes/base/tip');
    const runs = steps.map(s => s.run ?? "").join("\n");
    // Nothing from the pull request is checked out, installed or executed, and no step runs in another tree.
    expect(runs.replaceAll("--no-install", "")).not.toMatch(/\b(?:checkout|switch|worktree|install|npm|npx|bunx|yarn|pnpm|reset|restore)\b/);
    expect(wf).not.toMatch(/working-directory|github\.sha|head\.ref|merge_commit_sha|refs\/pull\/[^"]*\/merge/);
    expect(steps.filter(s => /^bun /.test(s.run ?? "")).length).toBe(1);
    // The trigger is pull_request only (never _target), with no other event.
    expect(/\non:\n  pull_request:\n    types: \[[^\]]*\]\n    paths:\n      - "mini-apps\/\*\*"\n      - "skills\/\*\*"\n\npermissions:/.test(wf)).toBe(true);
  });
  test("release (mutant C): no run: block holds a ${{ }} expression; every event value arrives through env", () => {
    const steps = workflowSteps(wf);
    expect(steps.filter(s => s.run !== undefined).map(s => s.name)).toEqual(["Fetch the pull request head (data only)", "Review", "Job summary"]);
    for (const s of steps) expect([s.name, (s.run ?? "").includes("${{")]).toEqual([s.name, false]);
    for (const s of steps) for (const v of Object.values(s.env)) expect(v).toMatch(/^\$\{\{ github\.event\.pull_request\.[a-z_.]+ \}\}$/);
    // The parser sees what the file says: a planted expression in a run block is found.
    const planted = wf.replace('git -C tool cat-file -e "${HEAD_SHA}^{commit}"', 'echo "${{ github.event.pull_request.head.ref }}"');
    expect(workflowSteps(planted).some(s => (s.run ?? "").includes("${{"))).toBe(true);
  });
  test("release S1 end to end: a pull request that adds a root bunfig.toml preload forges PASS when its own tree runs the bot, and gets the honest verdict from the workflow's steps", () => {
    // The fixture repository: the tool (this bot, the validator, its pins) and the tinyshop app, as the base.
    const g = gitRepo();
    const work = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-ci-"));
    try {
      const tool: Files = {};
      for (const rel of ["scripts/mini-apps-review.ts", R.VALIDATOR_PATH, R.SCHEMA_PATH, R.PINS_PATH, "install/paths.ts", ".github/workflows/mini-apps-review.yml"]) tool[rel] = readFileSync(join(REPO, rel), "utf8");
      const base = g.commit({ ...tool, ...baseFiles() }, "base: the tool and tinyshop");
      g.run("checkout", "-q", "-b", "attack");
      const preload = [
        "const real = JSON.stringify;",
        '(JSON as any).stringify = (v: any, ...rest: any[]) => real(v && v.bot === "av-miniapp-review" ? { ...v, verdict: "PASS", lane: "sandbox", findings: [] } : v, ...rest);',
        "",
      ].join("\n");
      const head = g.commit({ "bunfig.toml": 'preload = ["./docs/notes.ts"]\n', "docs/notes.ts": preload, "mini-apps/tinyshop/README.md": "# Tiny Shop\n" }, "a lane README line, plus a preload");
      // GitHub keeps the head under refs/pull/<n>/head; the branch itself is not fetched by the checkout.
      g.run("update-ref", "refs/pull/7/head", head);
      g.run("checkout", "-q", "main");
      g.run("branch", "-D", "attack");
      // The attack works when the pull request's own tree runs the bot (the old workflow): a forged PASS.
      const prTree = join(work, "pr-tree");
      expect(spawnSync("git", ["clone", "-q", `file://${g.dir}`, prTree]).status).toBe(0);
      expect(spawnSync("git", ["-C", prTree, "fetch", "-q", "origin", "refs/pull/7/head"]).status).toBe(0);
      expect(spawnSync("git", ["-C", prTree, "checkout", "-q", "FETCH_HEAD"]).status).toBe(0);
      const forged = spawnSync(process.execPath, ["scripts/mini-apps-review.ts", "--base", base, "--head", head], { cwd: prTree, encoding: "utf8" });
      expect([forged.status, JSON.parse(forged.stdout).verdict, JSON.parse(forged.stdout).lane]).toEqual([0, "PASS", "sandbox"]);
      // The workflow: actions/checkout of the BASE sha into tool/ (full history), then its own run: steps, in bash.
      const workspace = join(work, "workspace"), temp = join(work, "runner-temp");
      mkdirSync(workspace); mkdirSync(temp);
      expect(spawnSync("git", ["clone", "-q", "--no-checkout", `file://${g.dir}`, join(workspace, "tool")]).status).toBe(0);
      expect(spawnSync("git", ["-C", join(workspace, "tool"), "checkout", "-q", "--detach", base]).status).toBe(0);
      expect(spawnSync("git", ["-C", join(workspace, "tool"), "cat-file", "-e", `${head}^{commit}`]).status).not.toBe(0);
      const steps = workflowSteps(readFileSync(join(REPO, ".github/workflows/mini-apps-review.yml"), "utf8"));
      const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: work, RUNNER_TEMP: temp, GIT_CONFIG_NOSYSTEM: "1",
        PR_NUMBER: "7", BASE_SHA: base, HEAD_SHA: head, BASE_REF: "main", PR_AUTHOR: "someone" };
      for (const name of ["Fetch the pull request head (data only)", "Review"]) {
        const step = steps.find(s => s.name === name)!;
        const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], { cwd: workspace, env, encoding: "utf8" });
        expect([name, r.status]).toEqual([name, 0]);
      }
      const honest = JSON.parse(readFileSync(join(temp, "mini-apps-review.json"), "utf8")) as R.Report;
      expect([honest.verdict, honest.lane, honest.head]).toEqual(["NEEDS_HUMAN", "core", head]);
      // ov#477 fold 1: bound to the pull request and the base the tool checked out (the same event sha).
      expect([honest.pr, honest.base_ref, honest.base_sha]).toEqual([7, "main", base]);
      expect(honest.findings.filter(f => f.code === "core_path").map(f => f.file).sort()).toEqual(["bunfig.toml", "docs/notes.ts"]);
      expect(readFileSync(join(temp, "mini-apps-review.md"), "utf8")).toContain("**NEEDS_HUMAN** · lane `core`");
      // The tool tree is still the base, untouched: nothing of the pull request was checked out into it.
      const t = (...args: string[]) => String(spawnSync("git", ["-C", join(workspace, "tool"), ...args]).stdout).trim();
      expect([t("rev-parse", "HEAD"), t("status", "--porcelain"), existsSync(join(workspace, "tool", "bunfig.toml")), existsSync(join(workspace, "tool", "docs"))]).toEqual([base, "", false, false]);
      expect(readdirSync(workspace)).toEqual(["tool"]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
  });
  test("review-b N-a: a cwd tsconfig.json with a \"*\" path and a cwd package.json script named like the tool never run, the tool present or absent", () => {
    const g = gitRepo();
    const work = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-na-"));
    try {
      const tool: Files = {};
      for (const rel of ["scripts/mini-apps-review.ts", R.VALIDATOR_PATH, R.SCHEMA_PATH, R.PINS_PATH, "install/paths.ts", ".github/workflows/mini-apps-review.yml"]) tool[rel] = readFileSync(join(REPO, rel), "utf8");
      const base = g.commit({ ...tool, ...baseFiles() }, "base: the tool and tinyshop");
      g.run("checkout", "-q", "-b", "lane");
      const head = g.commit({ "mini-apps/tinyshop/README.md": "# Tiny Shop\n" }, "a lane README");
      g.run("update-ref", "refs/pull/7/head", head);
      g.run("checkout", "-q", "main");
      g.run("branch", "-D", "lane");
      const workspace = join(work, "workspace"), temp = join(work, "runner-temp"), canary = join(work, "CANARY");
      mkdirSync(workspace); mkdirSync(temp);
      expect(spawnSync("git", ["clone", "-q", "--no-checkout", `file://${g.dir}`, join(workspace, "tool")]).status).toBe(0);
      expect(spawnSync("git", ["-C", join(workspace, "tool"), "checkout", "-q", "--detach", base]).status).toBe(0);
      // Pull request bytes in the workspace root, the day a step writes them there (review-b's bisect, variants A and C).
      writeFileSync(join(workspace, "evil.ts"), `require("fs").appendFileSync(${JSON.stringify(canary)}, "tsconfig\\n");\nexport const EDGE_SKILL_NAMES = [];\nexport {};\n`);
      writeFileSync(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "*": ["./evil.ts"] } } }) + "\n");
      writeFileSync(join(workspace, "evil.sh"), `echo script >> ${JSON.stringify(canary)}\n`);
      writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "x", scripts: { "tool/scripts/mini-apps-review.ts": "sh evil.sh", "./tool/scripts/mini-apps-review.ts": "sh evil.sh" } }) + "\n");
      const steps = workflowSteps(readFileSync(join(REPO, ".github/workflows/mini-apps-review.yml"), "utf8"));
      const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: work, RUNNER_TEMP: temp, GIT_CONFIG_NOSYSTEM: "1",
        PR_NUMBER: "7", BASE_SHA: base, HEAD_SHA: head, BASE_REF: "main", PR_AUTHOR: "someone" };
      const bash = (script: string) => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd: workspace, env, encoding: "utf8" });
      const fired = () => (existsSync(canary) ? readFileSync(canary, "utf8").trim() : "none");
      const report = join(temp, "mini-apps-review.json");
      const review = steps.find(s => s.name === "Review")!.run!;
      // fold 1's line, before review-b N-a: no tsconfig override, the tool by a bare relative path.
      const fold1 = review.replace("--tsconfig-override=/dev/null ./tool/", "tool/");
      expect(fold1).not.toBe(review);
      expect(bash(steps.find(s => s.name === "Fetch the pull request head (data only)")!.run!).status).toBe(0);
      // The tool present: the workflow's line runs the honest bot, and neither plant fires.
      const r = bash(review);
      expect([r.status, fired()]).toEqual([0, "none"]);
      const honest = JSON.parse(readFileSync(report, "utf8")) as R.Report;
      expect([honest.verdict, honest.lane, honest.head]).toEqual(["PASS", "sandbox", head]);
      // Control: the fixture is live. fold 1's line in the same cwd runs the tsconfig plant.
      bash(fold1);
      expect(fired()).toBe("tsconfig");
      rmSync(canary); rmSync(report);
      // The tool absent (a base that predates the bot): the workflow's line fails closed, no report, neither plant fires.
      rmSync(join(workspace, "tool", "scripts", "mini-apps-review.ts"));
      const absent = bash(review);
      expect([absent.status === 0, fired(), existsSync(report)]).toEqual([false, "none", false]);
      // Control: fold 1's line, the tool absent, runs the package.json script instead.
      bash(fold1);
      expect(fired()).toBe("script");
    } finally { rmSync(g.dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
  });
});
