import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BRIDGE_ERROR_CODES, CHECKS, GENERIC_ERROR_CODES, REQUIRED, Refusal, SECRET_PATTERNS, allowedErrorCode, bumpOf, bumpVerdict,
  loadValidator, main, parseArgs, passedOf, redact, requiredBump, runConformance, secretFindings, secretPattern, show, strictJson,
  summary, withoutAnnotations, type Report, type Result,
  ADVISORY, MAX_SERVICE_REQUESTS, OUR_HOSTS, SERVICE_DEADLINE_MS, describeValue, inputCompatibility, mainAsync, ownReport, runConformanceAsync, serviceTarget, shapeProblems, tlsDial, type ServiceDeps,
  toolErrorProblems,
} from "../mini-apps-conformance";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:tls";
import { connect as netConnect, type AddressInfo } from "node:net";

// Mini-apps v2 Phase 0, P0-5 (MINIAPPS-PLATFORM-v2-design.md section 5.3 items 1, 4-template, 5): the
// conformance v0 script, plus v1 (items 2-3, --service). Synthetic manifests and fixtures only, in
// throwaway directories; the v1 tests talk only to a local stub through a mocked resolver and dialer.
//   bun test scripts/tests/mini-apps-conformance.test.ts

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "mini-apps-conformance.ts");
const shared = createRequire(import.meta.url)("../mini-apps-manifests.cjs");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
// Escapes are built at run time so this file never holds a literal backslash-u sequence.
const BS = String.fromCharCode(92);
const u = (hex: string) => `${BS}u${hex}`;

const SKILL = "---\nname: acme\nversion: 1.0.0\n---\n# Acme\n";
function acme(): any {
  return {
    manifest: 2, id: "acme", name: "Acme", version: "1.0.0", description: "Synthetic test app.",
    homepage: "https://acme.example", visibility: "sandbox",
    permissions: [{ kind: "read", label: "Read things", description: "Reads synthetic things." }],
    service: { kind: "mcp", baseUrl: "https://acme.example/mcp", auth: { mode: "none" } },
    operations: [
      { name: "acme.lookup", class: "read", target: { tool: "lookup" },
        input: { type: "object", properties: { q: { type: "string" } }, additionalProperties: false }, maxResponseBytes: 4096 },
      { name: "acme.order.prepare", class: "prepare", target: { tool: "quote" }, input: { type: "object" },
        returns: { draftIdPath: "$.draftId", previewPath: "$.approvalPayload", previewMaxBytes: 60000, previewTtlSeconds: 3600 } },
      { name: "acme.order.confirm", class: "needs-card", target: { tool: "place" }, input: { type: "object" },
        maxRequestBytes: 65536, timeoutMs: 60000,
        approval: { prepare: "acme.order.prepare", summary: ["Acme order", "Total: {{preview.total}}"], summaryMaxBytes: 3000 } },
    ],
    skills: [{ name: "acme", version: "1.0.0", sha256: sha256(SKILL), path: "skills/acme/SKILL.md" }],
  };
}
type Catalog = { root: string; path: string; fixtures: string; outDir: string; out: string };
/**
 * A throwaway catalog root: mini-apps/<id>/manifest.json, skills/<id>/SKILL.md, and fixture files; and,
 * OUTSIDE it (--out is refused anywhere inside the repo), a throwaway directory for --out.
 */
function catalog(opts: { manifest?: any; text?: string; id?: string; skill?: string; fixtures?: Record<string, string | Buffer> } = {}): Catalog {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conformance-")));
  const id = opts.id ?? "acme";
  mkdirSync(join(root, "mini-apps", id), { recursive: true });
  mkdirSync(join(root, "skills", "acme"), { recursive: true });
  writeFileSync(join(root, "skills", "acme", "SKILL.md"), opts.skill ?? SKILL);
  const path = join(root, "mini-apps", id, "manifest.json");
  writeFileSync(path, opts.text ?? JSON.stringify(opts.manifest ?? acme(), null, 2) + "\n");
  const fixtures = join(root, "fx");
  mkdirSync(fixtures);
  for (const [rel, body] of Object.entries(opts.fixtures ?? {})) {
    mkdirSync(dirname(join(fixtures, rel)), { recursive: true });
    writeFileSync(join(fixtures, rel), body);
  }
  const outDir = realpathSync(mkdtempSync(join(tmpdir(), "conformance-out-")));
  return { root, path, fixtures, outDir, out: join(outDir, "conformance.json") };
}
const GOOD_FIXTURES = {
  "acme.lookup/ok.json": JSON.stringify({ items: [{ name: "a" }, { name: "b" }] }),
  "acme.lookup/error-not-found.json": JSON.stringify({ code: "not_found", detail: "No such item." }),
};
function run(c: Catalog, extra: { fixtures?: string | null; base?: string } = {}): Report {
  const fixtures = extra.fixtures === null ? undefined : extra.fixtures ?? c.fixtures;
  return runConformance({ manifest: c.path, fixtures, base: extra.base }, { cwd: c.root });
}
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const g = (root: string, ...args: string[]) => {
  const p = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, env: gitEnv, encoding: "utf8" });
  if (p.status !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
  return p.stdout;
};
const row = (r: Report, check: string) => r.results.find(x => x.check === check)!;
const cleanup = (c: Catalog) => { rmSync(c.root, { recursive: true, force: true }); rmSync(c.outDir, { recursive: true, force: true }); };
/** A conformance.json for `rel` (this manifest's own, unless another path is named), as a stale run left it. */
const staleReport = (rel = "mini-apps/acme/manifest.json", passed = true) =>
  JSON.stringify({ manifest: rel, sha256: "0".repeat(64), results: [{ check: "manifest.schema", pass: passed, note: "stale" }], passed }, null, 2) + "\n";
function withCatalog<T>(opts: Parameters<typeof catalog>[0], fn: (c: Catalog) => T): T {
  const c = catalog(opts);
  try { return fn(c); } finally { cleanup(c); }
}
/** Every report keeps the shape P0-3 reads, and a not_run row always has pass null. */
function invariants(r: Report) {
  expect(Object.keys(r)).toEqual(["manifest", "sha256", "results", "passed"]);
  expect(r.results.map(x => x.check)).toEqual([...CHECKS]);
  for (const x of r.results) {
    expect(Object.keys(x)).toEqual(["check", "pass", "note"]);
    expect([true, false, null]).toContain(x.pass);
    expect(typeof x.note).toBe("string");
  }
  expect(r.passed).toBe(passedOf(r.results));
}

describe("a synthetic app that conforms", () => {
  test("every check that runs passes; the Phase 1 checks and the renderer are not_run; exit 0", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const r = run(c);
      invariants(r);
      expect(r.manifest).toBe("mini-apps/acme/manifest.json");
      expect(Object.fromEntries(r.results.map(x => [x.check, x.pass]))).toEqual({
        "manifest.validator_pin": true, "manifest.schema": true, "skills.sha256": true, "version.bump": null,
        "service.reachability": null, "service.budgets": null, "service.error_bodies": null,
        "approval.prepare_pair": true, "approval.summary_render": null, "approval.fake_cp": null,
        "hygiene.fixtures": true, "hygiene.secrets": true, "hygiene.duplicate_keys": true, "hygiene.error_bodies": true,
      });
      expect(row(r, "approval.summary_render").note).toStartWith("renderer_absent");
      expect(row(r, "approval.summary_render").note).toContain("acme.order.confirm (has summary template)");
      expect(r.passed).toBe(true);
      const lines: string[] = [];
      expect(main([c.path, "--fixtures", c.fixtures], { cwd: c.root, print: s => lines.push(s), warn: () => {} })).toBe(0);
      expect(lines.join("\n")).toContain("passed: true");
    });
  });

  test("the default fixture directory is mini-apps/<id>/fixtures/ when present", () => {
    withCatalog({}, c => {
      const dir = join(c.root, "mini-apps", "acme", "fixtures");
      for (const [rel, body] of Object.entries(GOOD_FIXTURES)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), body);
      }
      expect(run(c, { fixtures: null }).passed).toBe(true);
    });
  });
});

describe("not_run is never a pass", () => {
  const all = (pass: boolean | null): Result[] => CHECKS.map(check => ({ check, pass, note: "" }));
  test("passedOf: a required check that did not run fails the run; an optional one does not", () => {
    expect(passedOf(all(true))).toBe(true);
    expect(passedOf(all(null))).toBe(false);
    expect(passedOf([])).toBe(false);
    // A required check missing from the list is not a pass either.
    expect(passedOf(all(true).filter(x => x.check !== "hygiene.secrets"))).toBe(false);
    expect(passedOf(all(true).filter(x => x.check === "version.bump"))).toBe(false);
    for (const check of CHECKS) {
      const results = all(true).map(x => x.check === check ? { ...x, pass: null } : x);
      expect([check, passedOf(results)]).toEqual([check, !REQUIRED.has(check)]);
      const failed = all(true).map(x => x.check === check ? { ...x, pass: false } : x);
      // A failed check fails the run, except an advisory v1 service row (owner ruling on ov#438).
      expect([check, passedOf(failed)]).toEqual([check, ADVISORY.has(check)]);
    }
    expect([...REQUIRED].sort()).toEqual(["hygiene.duplicate_keys", "hygiene.error_bodies", "hygiene.fixtures", "hygiene.secrets",
      "manifest.schema", "manifest.validator_pin", "skills.sha256"]);
  });

  test("no fixtures: item 5 is not_run with pass null, and the run fails although nothing failed", () => {
    withCatalog({}, c => {
      const r = run(c, { fixtures: null });
      invariants(r);
      for (const check of ["hygiene.fixtures", "hygiene.secrets", "hygiene.duplicate_keys", "hygiene.error_bodies"]) {
        expect([check, row(r, check).pass]).toEqual([check, null]);
      }
      expect(r.results.some(x => x.pass === false)).toBe(false);
      expect(r.passed).toBe(false);
      expect(main([c.path], { cwd: c.root, print: () => {}, warn: () => {} })).toBe(1);
    });
  });

  test("an empty fixture directory, or no error fixture, is not_run and fails the run", () => {
    withCatalog({}, c => {
      const r = run(c);
      expect(row(r, "hygiene.fixtures")).toEqual({ check: "hygiene.fixtures", pass: null, note: "the fixture directory holds no fixture file" });
      expect(r.passed).toBe(false);
    });
    withCatalog({ fixtures: { "acme.lookup/ok.json": "{}" } }, c => {
      const r = run(c);
      expect(row(r, "hygiene.error_bodies").pass).toBe(null);
      expect(row(r, "hygiene.secrets").pass).toBe(true);
      expect(r.passed).toBe(false);
    });
  });
});

describe("item 1: the manifest, the validator pin, the skill hashes", () => {
  test("sha256 is over the manifest file's exact bytes (CRLF, spacing and key order all count)", () => {
    const text = JSON.stringify(acme(), null, 4).replace(/\n/g, "\r\n") + "  \r\n";
    withCatalog({ text, fixtures: GOOD_FIXTURES }, c => {
      const r = run(c);
      const bytes = readFileSync(c.path);
      expect(r.sha256).toBe(sha256(bytes));
      expect(r.sha256).not.toBe(sha256(JSON.stringify(JSON.parse(bytes.toString("utf8")))));
      expect(r.sha256).not.toBe(sha256(JSON.stringify(acme(), null, 2) + "\n"));
      expect(r.passed).toBe(true);
    });
  });

  test("schema: an unknown key, an invalid JSON file, a duplicate key and an id that is not its directory each fail", () => {
    const cases: [string, Parameters<typeof catalog>[0], string][] = [
      ["unknown key", { manifest: { ...acme(), restricted: true } }, "/restricted additionalProperties"],
      ["not JSON", { text: "{\"manifest\": 2,}" }, "not strict JSON"],
      ["duplicate key", { text: JSON.stringify(acme()).replace("{\"manifest\":2,", "{\"manifest\":2,\"visibility\":\"everyone\",") }, "duplicate key /visibility"],
      ["id is not its directory", { id: "other" }, "/id is not its directory name"],
      ["a BOM", { text: String.fromCharCode(0xfeff) + JSON.stringify(acme()) }, "not strict JSON"],
    ];
    for (const [why, opts, want] of cases) {
      withCatalog({ ...opts, fixtures: GOOD_FIXTURES }, c => {
        const r = run(c);
        invariants(r);
        expect([why, row(r, "manifest.schema").pass, row(r, "manifest.schema").note.includes(want)]).toEqual([why, false, true]);
        expect(r.passed).toBe(false);
      });
    }
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      writeFileSync(c.path, Buffer.from([0x7b, 0xff, 0x7d]));
      expect(row(run(c), "manifest.schema")).toEqual({ check: "manifest.schema", pass: false, note: "not UTF-8" });
    });
    // JSON.parse alone would keep the last "visibility" and call the manifest valid.
    expect(shared.validateManifest(JSON.parse(JSON.stringify(acme()).replace("{\"manifest\":2,", "{\"manifest\":2,\"visibility\":\"everyone\","))).ok).toBe(true);
  });

  test("skills: a wrong hash, a missing file and a symlinked SKILL.md each fail", () => {
    withCatalog({ skill: SKILL + "edited\n", fixtures: GOOD_FIXTURES }, c => {
      const r = row(run(c), "skills.sha256");
      expect(r.pass).toBe(false);
      expect(r.note).toContain(`skills/acme/SKILL.md sha256 is ${sha256(SKILL + "edited\n")}`);
    });
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      rmSync(join(c.root, "skills", "acme", "SKILL.md"));
      expect(row(run(c), "skills.sha256")).toEqual({ check: "skills.sha256", pass: false, note: "skills/acme/SKILL.md missing" });
    });
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const real = join(c.root, "elsewhere.md");
      writeFileSync(real, SKILL);
      rmSync(join(c.root, "skills", "acme", "SKILL.md"));
      symlinkSync(real, join(c.root, "skills", "acme", "SKILL.md"));
      expect(row(run(c), "skills.sha256").note).toBe("skills/acme/SKILL.md is not a regular file");
    });
  });

  test("F17: the manifest's skills[].sha256 is echoed through show(): cut to 64 characters, a / escaped", () => {
    const m = acme();
    m.skills[0].sha256 = "/" + "a".repeat(200);
    withCatalog({ manifest: m, fixtures: GOOD_FIXTURES }, c => {
      const note = row(run(c), "skills.sha256").note;
      expect(note).toContain(`skills/acme/SKILL.md sha256 is ${sha256(SKILL)}, the manifest says ~1${"a".repeat(59)}...`);
      expect(note.includes("a".repeat(100))).toBe(false);
    });
  });
  test("skills: a skill directory symlinked outside the repo fails; one symlinked inside the repo is followed", () => {
    // skills/acme -> a directory outside the catalog root that holds a correct SKILL.md (the guard at realpath).
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "conformance-outside-")));
    try {
      writeFileSync(join(outside, "SKILL.md"), SKILL);
      withCatalog({ fixtures: GOOD_FIXTURES }, c => {
        rmSync(join(c.root, "skills", "acme"), { recursive: true });
        symlinkSync(outside, join(c.root, "skills", "acme"));
        const r = run(c);
        expect(row(r, "skills.sha256")).toEqual({ check: "skills.sha256", pass: false, note: "skills/acme/SKILL.md resolves outside the repo" });
        expect(r.passed).toBe(false);
      });
    } finally { rmSync(outside, { recursive: true, force: true }); }
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      renameSync(join(c.root, "skills", "acme"), join(c.root, "skills", "acme-real"));
      symlinkSync(join(c.root, "skills", "acme-real"), join(c.root, "skills", "acme"));
      expect(row(run(c), "skills.sha256")).toEqual({ check: "skills.sha256", pass: true, note: "matches: skills/acme/SKILL.md" });
    });
  });

  test("the manifest: a symlinked manifest.json refuses; a manifest over 1 MB fails, one of exactly 1 MB is read", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const real = join(c.root, "real-manifest.json");
      renameSync(c.path, real);
      symlinkSync(real, c.path);
      let reason = "";
      try { run(c); } catch (e) { reason = e instanceof Refusal ? e.reason : "other"; }
      expect(reason).toBe("manifest_not_a_regular_file");
    });
    const sized = (n: number) => { const head = "{\"pad\":\"", tail = "\"}"; return head + "a".repeat(n - head.length - tail.length) + tail; };
    withCatalog({ text: sized((1 << 20) + 1), fixtures: GOOD_FIXTURES }, c => {
      expect(statSync(c.path).size).toBe((1 << 20) + 1);
      expect(row(run(c), "manifest.schema")).toEqual({ check: "manifest.schema", pass: false, note: "over 1048576 bytes" });
    });
    withCatalog({ text: sized(1 << 20), fixtures: GOOD_FIXTURES }, c => {
      expect(statSync(c.path).size).toBe(1 << 20);
      const r = row(run(c), "manifest.schema");
      expect([r.pass, r.note.startsWith("over "), r.note.includes("/pad")]).toEqual([false, false, true]);
    });
  });

  /** A tool root holding copies of the script, the validator, the schema and the pins. */
  function toolCopy(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "conformance-tool-")));
    for (const rel of ["scripts/mini-apps-conformance.ts", "scripts/mini-apps-manifests.cjs", "mini-apps/manifest.v2.schema.json", "mini-apps/manifests.pins.json"]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      copyFileSync(join(REPO, rel), join(dir, rel));
    }
    return dir;
  }
  test("fail closed: a validator, schema or pins file that is not the pinned one refuses (exit 2, no conformance.json)", () => {
    const cases: [string, (dir: string) => void, string][] = [
      ["an edited validator", d => writeFileSync(join(d, "scripts/mini-apps-manifests.cjs"), readFileSync(join(d, "scripts/mini-apps-manifests.cjs"), "utf8") + "\n// x\n"), "validator_sha_mismatch"],
      ["an edited schema file", d => writeFileSync(join(d, "mini-apps/manifest.v2.schema.json"), "{}\n"), "schema_sha_mismatch"],
      ["a pin naming other bytes", d => writeFileSync(join(d, "mini-apps/manifests.pins.json"), JSON.stringify({ manifest: 2, sha256: { module: "0".repeat(64), schema: "0".repeat(64) } })), "validator_sha_mismatch"],
      ["a malformed pins file", d => writeFileSync(join(d, "mini-apps/manifests.pins.json"), JSON.stringify({ sha256: { module: "x" } })), "pins_malformed"],
      ["no pins file", d => rmSync(join(d, "mini-apps/manifests.pins.json")), "pins_missing"],
      ["no validator", d => rmSync(join(d, "scripts/mini-apps-manifests.cjs")), "validator_missing"],
      // A symlink to the very same (pinned) bytes is still refused: the tool reads only regular files.
      ["a symlinked pins file", d => { renameSync(join(d, "mini-apps/manifests.pins.json"), join(d, "pins-real.json")); symlinkSync(join(d, "pins-real.json"), join(d, "mini-apps/manifests.pins.json")); }, "pins_not_a_regular_file"],
      ["a symlinked validator", d => { renameSync(join(d, "scripts/mini-apps-manifests.cjs"), join(d, "validator-real.cjs")); symlinkSync(join(d, "validator-real.cjs"), join(d, "scripts/mini-apps-manifests.cjs")); }, "validator_not_a_regular_file"],
    ];
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      for (const [why, plant, reason] of cases) {
        const tool = toolCopy();
        try {
          expect(loadValidator(tool).moduleSha).toBe(sha256(readFileSync(join(REPO, "scripts/mini-apps-manifests.cjs"))));
          plant(tool);
          let refused = "";
          try { loadValidator(tool); } catch (e) { refused = e instanceof Refusal ? e.reason : "other"; }
          expect([why, refused]).toEqual([why, reason]);
          const out = c.out;
          const warned: string[] = [];
          expect([why, main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, toolRoot: tool, print: () => {}, warn: s => warned.push(s) })]).toEqual([why, 2]);
          expect(warned.join("")).toContain(`refused: ${reason}`);
          expect(() => readFileSync(out)).toThrow();
        } finally { rmSync(tool, { recursive: true, force: true }); }
      }
      // The same through a real process: the copied script refuses with its own edited validator beside it.
      const tool = toolCopy();
      try {
        writeFileSync(join(tool, "scripts/mini-apps-manifests.cjs"), readFileSync(join(tool, "scripts/mini-apps-manifests.cjs"), "utf8").replace("const MAX_ERRORS = 32;", "const MAX_ERRORS = 0;"));
        const p = spawnSync("bun", [join(tool, "scripts/mini-apps-conformance.ts"), c.path, "--fixtures", c.fixtures], { cwd: c.root, encoding: "utf8" });
        expect([p.status, p.stderr.includes("refused: validator_sha_mismatch")]).toEqual([2, true]);
      } finally { rmSync(tool, { recursive: true, force: true }); }
    });
  });

  test("the validator it runs is P0-1's module, compiled from the pinned bytes", () => {
    const { validator, moduleSha } = loadValidator(REPO);
    const pins = JSON.parse(readFileSync(join(REPO, "mini-apps/manifests.pins.json"), "utf8"));
    expect(moduleSha).toBe(pins.sha256.module);
    for (const value of [acme(), { ...acme(), restricted: true }, { ...acme(), id: "rolodex" }, {}]) {
      expect(validator.validateManifest(value)).toEqual(JSON.parse(JSON.stringify(shared.validateManifest(value))));
    }
    expect(validator.operationBudgets({ name: "x.y", class: "read" })).toEqual({ ...shared.operationBudgets({ name: "x.y", class: "read" }) });
  });
});

describe("item 1: the version bump class", () => {
  const budgets = shared.operationBudgets;
  const verdict = (from: any, to: any) => bumpVerdict(requiredBump(from, to, budgets), from.version, to.version);
  const edit = (version: string, change: (m: any) => void) => { const m = acme(); m.version = version; change(m); return m; };
  test("bumpOf orders semver triples", () => {
    expect(bumpOf("1.0.0", "2.0.0")).toBe("major");
    expect(bumpOf("1.0.0", "1.1.0")).toBe("minor");
    expect(bumpOf("1.0.0", "1.0.1")).toBe("patch");
    expect(bumpOf("1.0.0", "1.0.0")).toBe("none");
    expect(bumpOf("1.0.0-rc1", "1.0.0")).toBe("prerelease");
    expect(bumpOf("1.2.0", "1.1.9")).toBe("downgrade");
    expect(bumpOf("1.10.0", "1.9.0")).toBe("downgrade");
    expect(bumpOf("1.0", "1.0.1")).toBe("invalid");
  });
  test("prerelease precedence (semver section 11): a downgrade, 1.0.0 -> 1.0.0-rc.1 included, is \"downgrade\" and fails", () => {
    const downs: [string, string][] = [["1.0.0", "1.0.0-rc.1"], ["1.0.0", "1.0.0-rc1"], ["1.0.0-rc.2", "1.0.0-rc.1"], ["1.0.0-rc.10", "1.0.0-rc.9"],
      ["1.0.0-alpha.beta", "1.0.0-alpha.1"], ["1.0.0-alpha.1", "1.0.0-alpha"], ["1.0.0-beta", "1.0.0-alpha"], ["2.0.0", "2.0.0-rc.1"]];
    for (const [from, to] of downs) {
      expect([from, to, bumpOf(from, to)]).toEqual([from, to, "downgrade"]);
      const v = verdict(edit(from, () => {}), edit(to, m => { m.description = "New copy."; }));
      expect([from, to, v.pass, v.note.startsWith(`${from} -> ${to} is downgrade`)]).toEqual([from, to, false, true]);
    }
    const ups: [string, string][] = [["1.0.0-rc.1", "1.0.0"], ["1.0.0-rc.1", "1.0.0-rc.2"], ["1.0.0-rc.9", "1.0.0-rc.10"],
      ["1.0.0-alpha", "1.0.0-alpha.1"], ["1.0.0-alpha.1", "1.0.0-alpha.beta"], ["1.0.0-alpha", "1.0.0-beta"]];
    for (const [from, to] of ups) {
      expect([from, to, bumpOf(from, to)]).toEqual([from, to, "prerelease"]);
      expect([from, to, verdict(edit(from, () => {}), edit(to, m => { m.description = "New copy."; })).pass]).toEqual([from, to, true]);
    }
    expect(bumpOf("1.0.0-rc.1", "1.0.0-rc.1")).toBe("none");
    expect(bumpOf("1.0.0", "1.0.1-rc.1")).toBe("patch");
  });
  test("an input-schema edit of annotations only (description, title, examples, $comment) is a patch; any other input edit is major", () => {
    const annotations: [string, (m: any) => void][] = [
      ["a property description", m => { m.operations[0].input.properties.q.description = "The query."; }],
      ["a schema title", m => { m.operations[0].input.title = "Lookup"; }],
      ["examples", m => { m.operations[0].input.properties.q.examples = ["latte"]; }],
      ["a $comment", m => { m.operations[0].input.$comment = "from the upstream tool"; }],
      ["nested, inside items / anyOf / $defs", m => {
        m.operations[1].input = { type: "object", properties: { lines: { type: "array", items: { type: "string", description: "one line" } } },
          anyOf: [{ required: ["lines"], title: "with lines" }], $defs: { x: { type: "string", description: "x" } } };
      }],
    ];
    const base = () => {
      const m = acme();
      m.operations[1].input = { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, anyOf: [{ required: ["lines"] }], $defs: { x: { type: "string" } } };
      return m;
    };
    const ed = (version: string, change: (m: any) => void) => { const m = base(); m.version = version; change(m); return m; };
    for (const [why, change] of annotations) {
      const patch = verdict(base(), ed("1.0.1", change));
      expect([why, patch.pass, patch.note.includes("input annotations changed")]).toEqual([why, true, true]);
      expect([why, requiredBump(base(), ed("1.0.1", change), budgets).level]).toEqual([why, "patch"]);
      expect([why, verdict(base(), ed("1.0.0", change)).pass]).toEqual([why, false]);
    }
    const real: [string, (m: any) => void][] = [
      ["a type changed", m => { m.operations[0].input.properties.q.type = "number"; }],
      ["a property NAMED description added", m => { m.operations[0].input.properties.description = { type: "string" }; }],
      ["a property removed", m => { m.operations[0].input.properties = {}; }],
      ["a default added (not an annotation here)", m => { m.operations[0].input.properties.q.default = "x"; }],
      ["required changed", m => { m.operations[0].input.required = ["q"]; }],
      ["enum changed", m => { m.operations[0].input.properties.q.enum = ["a"]; }],
      ["a description under a keyword v0 does not walk", m => { m.operations[0].input["x-upstream"] = { description: "y" }; }],
      ["additionalProperties opened", m => { m.operations[0].input.additionalProperties = true; }],
    ];
    for (const [why, change] of real) {
      const minor = verdict(acme(), edit("1.1.0", change));
      expect([why, minor.pass, minor.note.includes("major: acme.lookup input changed")]).toEqual([why, false, true]);
      expect([why, verdict(acme(), edit("2.0.0", change)).pass]).toEqual([why, true]);
    }
    // withoutAnnotations keeps a property named like a keyword, and drops only keyword positions.
    expect(withoutAnnotations({ type: "object", description: "d", properties: { description: { type: "string", title: "t" } }, required: ["description"] }))
      .toEqual({ type: "object", properties: { description: { type: "string" } }, required: ["description"] });
  });
  test("S1 (review-b): a $ref into an annotation position is never an annotation-only patch; only #/$defs/<name> to an unchanged def is", () => {
    const withInput = (version: string, input: any) => { const m = acme(); m.version = version; m.operations[0].input = input; return m; };
    const obj = (props: any, extra: any = {}) => ({ type: "object", properties: props, ...extra });
    // review-b's two probes: an enforced keyword reached through a $ref into examples[0] and into a def's
    // "description". withoutAnnotations() sees no change in either, yet ajv 8.20 widens q (review-b: q="abcdef"
    // false at the base, true at the head). Both are now major.
    const majors: [string, any, any][] = [
      ["review-b probe 1: $ref into examples[0], its maxLength dropped",
        obj({ q: { $ref: "#/examples/0" } }, { examples: [{ type: "string", maxLength: 3 }] }),
        obj({ q: { $ref: "#/examples/0" } }, { examples: [{ type: "string" }] })],
      ["review-b probe 2: $ref into $defs/x/description, its maxLength dropped",
        obj({ q: { $ref: "#/$defs/x/description" } }, { $defs: { x: { type: "string", description: { type: "string", maxLength: 3 } } } }),
        obj({ q: { $ref: "#/$defs/x/description" } }, { $defs: { x: { type: "string", description: { type: "string" } } } })],
      ["#/$defs/x, but no such def (in either)", obj({ q: { $ref: "#/$defs/x" } }), obj({ q: { $ref: "#/$defs/x", description: "q" } })],
      ["#/$defs/x with an $id (it moves what # names)", obj({ q: { $ref: "#/$defs/x" } }, { $id: "https://acme.example/s", $defs: { x: { type: "string" } } }),
        obj({ q: { $ref: "#/$defs/x", description: "q" } }, { $id: "https://acme.example/s", $defs: { x: { type: "string" } } })],
      // A pointer as long as "#/$defs/" into an annotation (title), with a same-named def beside it: the
      // ref must be #/$defs/<name> itself, never a look-alike the def lookup would also resolve.
      ["#/title/x (an annotation, the length of #/$defs/)",
        obj({ q: { $ref: "#/title/x" } }, { title: { x: { type: "string", maxLength: 3 } }, $defs: { x: { type: "string" } } }),
        obj({ q: { $ref: "#/title/x" } }, { title: { x: { type: "string" } }, $defs: { x: { type: "string" } } })],
      ["#/definitions/x (not #/$defs/<name>)", obj({ q: { $ref: "#/definitions/x" } }, { definitions: { x: { type: "string" } } }),
        obj({ q: { $ref: "#/definitions/x", description: "q" } }, { definitions: { x: { type: "string" } } })],
      ["a nested pointer #/$defs/x/items", obj({ q: { $ref: "#/$defs/x/items" } }, { $defs: { x: { type: "array", items: { type: "string" } } } }),
        obj({ q: { $ref: "#/$defs/x/items", description: "q" } }, { $defs: { x: { type: "array", items: { type: "string" } } } })],
      ["a remote $ref", obj({ q: { $ref: "https://acme.example/q.json" } }), obj({ q: { $ref: "https://acme.example/q.json", title: "Q" } })],
      ["$dynamicRef to an anchor", obj({ q: { $dynamicRef: "#meta" } }), obj({ q: { $dynamicRef: "#meta", title: "Q" } })],
      ["$recursiveRef", obj({ q: { $recursiveRef: "#" } }), obj({ q: { $recursiveRef: "#", title: "Q" } })],
      ["a $ref only in the head, inside examples", obj({ q: { type: "string" } }), obj({ q: { type: "string" } }, { examples: [{ $ref: "#/$defs/x" }] })],
      ["#/$defs/x, the def's maxLength dropped", obj({ q: { $ref: "#/$defs/x" } }, { $defs: { x: { type: "string", maxLength: 3 } } }),
        obj({ q: { $ref: "#/$defs/x" } }, { $defs: { x: { type: "string" } } })],
    ];
    for (const [why, from, to] of majors) {
      const a = withInput("1.0.0", from), b = withInput("1.0.1", to);
      expect([why, requiredBump(a, b, budgets).reasons]).toEqual([why, ["major: acme.lookup input changed"]]);
      expect([why, verdict(a, b).pass, verdict(a, withInput("2.0.0", to)).pass]).toEqual([why, false, true]);
    }
    // The two probes really are annotation-only to withoutAnnotations(): the $ref gate is what makes them major.
    for (const [why, from, to] of majors.slice(0, 2)) expect([why, withoutAnnotations(from)]).toEqual([why, withoutAnnotations(to)]);
    // Patch: every reference is #/$defs/<name> to a root def both inputs hold, unchanged beyond annotations.
    const patches: [string, any, any][] = [
      ["the def's description", obj({ q: { $ref: "#/$defs/x" } }, { $defs: { x: { type: "string" } } }),
        obj({ q: { $ref: "#/$defs/x" } }, { $defs: { x: { type: "string", description: "the query" } } })],
      ["the property's title beside the $ref", obj({ q: { $ref: "#/$defs/x" }, r: { $ref: "#/$defs/y-2" } }, { $defs: { x: { type: "string" }, "y-2": { type: "number" } } }),
        obj({ q: { $ref: "#/$defs/x", title: "Q" }, r: { $ref: "#/$defs/y-2" } }, { $defs: { x: { type: "string" }, "y-2": { type: "number", $comment: "c" } } })],
      ["$dynamicRef #/$defs/x", obj({ q: { $dynamicRef: "#/$defs/x" } }, { $defs: { x: { type: "string" } } }),
        obj({ q: { $dynamicRef: "#/$defs/x" } }, { $defs: { x: { type: "string", examples: ["latte"] } } })],
    ];
    for (const [why, from, to] of patches) {
      const a = withInput("1.0.0", from), b = withInput("1.0.1", to);
      expect([why, requiredBump(a, b, budgets).reasons]).toEqual([why, ["patch: acme.lookup input annotations changed"]]);
      expect([why, verdict(a, b).pass, verdict(a, withInput("1.0.0", to)).pass]).toEqual([why, true, false]);
    }
  });
  test("a widening needs a major bump: each one fails at minor and passes at major", () => {
    const widenings: [string, (m: any) => void][] = [
      ["an op added", m => m.operations.push({ name: "acme.extra", class: "read" })],
      ["a budget raised", m => { m.operations[0].maxResponseBytes = 8192; }],
      ["a default budget raised", m => { m.operations[1].maxRequestBytes = 8192; }],
      ["a timeout raised", m => { m.operations[1].timeoutMs = 25001; }],
      ["a class changed", m => { m.operations[0].class = "write"; }],
      ["an input changed (even a tightening: v0 cannot prove a schema tighter)", m => { m.operations[0].input.properties.q.maxLength = 10; }],
      ["a target changed", m => { m.operations[0].target.tool = "other"; }],
      ["framing changed", m => { m.operations[0].framing = "media"; }],
      ["the summary template changed", m => { m.operations[2].approval.summary[1] = "Sum: {{preview.total}}"; }],
      ["summaryMaxBytes changed", m => { m.operations[2].approval.summaryMaxBytes = 2999; }],
      ["previewMaxBytes raised", m => { m.operations[1].returns.previewMaxBytes = 65536; }],
      ["auth changed", m => { m.service.auth = { mode: "app-token", secretRef: "ACME_KEY" }; }],
      ["baseUrl changed", m => { m.service.baseUrl = "https://other.example/mcp"; }],
      ["data added", m => { m.data = { context: { maxEntries: 4 } }; }],
      ["an event added", m => { m.events = { "miniapp.acme.done@1": { orderId: "string" } }; }],
      ["owner changed", m => { m.owner = { github: "someone" }; }],
    ];
    for (const [why, change] of widenings) {
      const minor = verdict(acme(), edit("1.1.0", change));
      const major = verdict(acme(), edit("2.0.0", change));
      expect([why, minor.pass, minor.note.startsWith("needs a major bump")]).toEqual([why, false, true]);
      expect([why, major.pass]).toEqual([why, true]);
    }
  });
  test("data widened needs major; copy, a lowered budget and a removed op need only a patch", () => {
    const withData = (m: any, ctx: any) => { m.data = { context: ctx }; return m; };
    expect(verdict(withData(acme(), { maxEntries: 4 }), withData(edit("1.1.0", () => {}), { maxEntries: 8 })).pass).toBe(false);
    expect(verdict(withData(acme(), { maxEntries: 4 }), withData(edit("1.1.0", () => {}), { maxEntries: 4, ceiling: "village" })).pass).toBe(false);
    expect(verdict(withData(acme(), { maxEntries: 8 }), withData(edit("1.0.1", () => {}), { maxEntries: 4 })).pass).toBe(true);
    const narrowings: [string, (m: any) => void][] = [
      ["description", m => { m.description = "New copy."; }],
      ["a budget lowered", m => { m.operations[0].maxResponseBytes = 2048; }],
      ["an op removed", m => { m.operations.splice(0, 1); }],
      ["permissions copy", m => { m.permissions[0].description = "Reads things."; }],
      ["the skill hash", m => { m.skills[0].sha256 = "a".repeat(64); }],
      ["visibility", m => { m.visibility = "admins"; }],
    ];
    for (const [why, change] of narrowings) {
      expect([why, verdict(acme(), edit("1.0.1", change)).pass]).toEqual([why, true]);
      const none = verdict(acme(), edit("1.0.0", change));
      expect([why, none.pass, none.note.startsWith("the manifest changed but the version did not")]).toEqual([why, false, true]);
    }
  });
  test("unchanged passes at any non-downgrade; a downgrade and a changed id fail", () => {
    expect(verdict(acme(), acme())).toEqual({ check: "version.bump", pass: true, note: "no change since the base; 1.0.0 -> 1.0.0 is none" });
    expect(verdict(acme(), edit("1.0.1", () => {})).pass).toBe(true);
    expect(verdict(edit("1.2.0", () => {}), edit("1.1.0", m => { m.description = "x."; })).pass).toBe(false);
    expect(verdict(acme(), edit("2.0.0", m => { m.id = "acme2"; })).pass).toBe(false);
    // Whitespace and key order are not a change (the comparison is canonical).
    const reordered = Object.fromEntries(Object.entries(acme()).reverse());
    expect(requiredBump(acme(), reordered, budgets)).toEqual({ level: "none", reasons: [] });
  });

  test("--base: the diff against a local git ref (new, unchanged, widened at minor, widened at major, v1 base, bad refs)", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      g(c.root, "init", "-q");
      g(c.root, "add", "skills");
      g(c.root, "commit", "-q", "-m", "skill only");
      expect(row(run(c, { base: "HEAD" }), "version.bump").note).toStartWith("a new manifest: none at HEAD");
      g(c.root, "add", "mini-apps");
      g(c.root, "commit", "-q", "-m", "manifest");
      expect(row(run(c, { base: "HEAD" }), "version.bump").pass).toBe(true);
      writeFileSync(c.path, JSON.stringify(edit("1.1.0", m => m.operations.push({ name: "acme.extra", class: "read" }))));
      const minor = run(c, { base: "HEAD" });
      expect([row(minor, "version.bump").pass, row(minor, "version.bump").note]).toEqual([false,
        "needs a major bump, 1.0.0 -> 1.1.0 is minor (major: operation acme.extra added)"]);
      expect(minor.passed).toBe(false);
      writeFileSync(c.path, JSON.stringify(edit("2.0.0", m => m.operations.push({ name: "acme.extra", class: "read" }))));
      expect(row(run(c, { base: "HEAD" }), "version.bump").pass).toBe(true);
      expect(run(c, { base: "HEAD" }).passed).toBe(true);
      // A v1 base (P0-1's own conversion) has no bump class: not_run, never a pass.
      writeFileSync(c.path, JSON.stringify({ id: "acme", version: "0.9.0", operations: ["mini-app.read"] }));
      g(c.root, "commit", "-q", "-am", "v1");
      writeFileSync(c.path, JSON.stringify(acme()));
      expect(row(run(c, { base: "HEAD" }), "version.bump").pass).toBe(null);
      // A v2 base the validator rejects: not_run, never a pass.
      writeFileSync(c.path, JSON.stringify({ ...acme(), restricted: true }));
      g(c.root, "commit", "-q", "-am", "an invalid v2 base");
      writeFileSync(c.path, JSON.stringify(acme()));
      expect(row(run(c, { base: "HEAD" }), "version.bump")).toEqual({ check: "version.bump", pass: null, note: "the manifest at HEAD is not a valid v2 manifest" });
      for (const bad of ["no-such-ref", "-p", "HEAD:mini-apps", "a b", "HEAD..HEAD~1", ""]) {
        let reason = "";
        try { run(c, { base: bad }); } catch (e) { reason = e instanceof Refusal ? e.reason : "other"; }
        expect([bad, reason === "bad_base_ref" || reason === "base_ref_unknown"]).toEqual([bad, true]);
      }
    });
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      let reason = "";
      try { run(c, { base: "HEAD" }); } catch (e) { reason = (e as Refusal).reason; }
      expect(reason).toBe("base_needs_a_git_checkout");
    });
  });

  test("--base: the manifest path reaches git as a literal path, never pathspec magic (a checkout dir named \":(glob)c\")", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "conformance-magic-")));
    try {
      const root = join(top, ":(glob)c");
      mkdirSync(join(root, "mini-apps", "acme"), { recursive: true });
      mkdirSync(join(root, "skills", "acme"), { recursive: true });
      writeFileSync(join(root, "skills", "acme", "SKILL.md"), SKILL);
      writeFileSync(join(root, "mini-apps", "acme", "manifest.json"), JSON.stringify(acme(), null, 2) + "\n");
      g(top, "init", "-q");
      g(top, "add", "-A");
      g(top, "commit", "-q", "-m", "a catalog in a subdirectory");
      const r = runConformance({ manifest: join(root, "mini-apps", "acme", "manifest.json"), base: "HEAD" }, { cwd: root });
      expect(row(r, "version.bump")).toEqual({ check: "version.bump", pass: true, note: "no change since the base; 1.0.0 -> 1.0.0 is none" });
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  test("--base in a partial clone: a base blob that is not local REFUSES (exit 2), never \"a new manifest\", never a pass", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      g(c.root, "init", "-q");
      g(c.root, "config", "uploadpack.allowFilter", "true");
      g(c.root, "add", "skills");
      g(c.root, "commit", "-q", "-m", "skill only");
      g(c.root, "add", "mini-apps");
      g(c.root, "commit", "-q", "-m", "acme 1.0.0");
      // A budget widened at a minor bump: a full clone fails it.
      writeFileSync(c.path, JSON.stringify(edit("1.1.0", m => { m.operations[0].maxResponseBytes = 8192; }), null, 2) + "\n");
      g(c.root, "commit", "-q", "-am", "acme 1.1.0, widened");
      const full = run(c, { base: "HEAD~1" });
      expect([row(full, "version.bump").pass, row(full, "version.bump").note]).toEqual([false,
        "needs a major bump, 1.0.0 -> 1.1.0 is minor (major: acme.lookup maxResponseBytes raised 4096 -> 8192)"]);
      const clones = realpathSync(mkdtempSync(join(tmpdir(), "conformance-clone-")));
      try {
        for (const filter of ["blob:none", "tree:0"]) {
          const dir = join(clones, filter.replace(":", "-"));
          g(clones, "clone", "-q", `--filter=${filter}`, `file://${c.root}`, dir);
          const manifest = join(dir, "mini-apps", "acme", "manifest.json");
          // The precondition: the base's manifest blob really is not in the clone's object store.
          const probe = spawnSync("git", ["cat-file", "-e", "HEAD~1:mini-apps/acme/manifest.json"], { cwd: dir, env: { ...gitEnv, GIT_NO_LAZY_FETCH: "1" } });
          expect([filter, probe.status === 0]).toEqual([filter, false]);
          const want = filter === "blob:none" ? "base_blob_missing" : "base_tree_unreadable";
          let reason = "";
          try { runConformance({ manifest, fixtures: c.fixtures, base: "HEAD~1" }, { cwd: dir }); } catch (e) { reason = e instanceof Refusal ? e.reason : `other ${e}`; }
          expect([filter, reason]).toEqual([filter, want]);
          // The CLI: exit 2, from a real process, and no conformance.json.
          const out = join(clones, `${filter.replace(":", "-")}.json`);
          const p = spawnSync("bun", [SCRIPT, manifest, "--fixtures", c.fixtures, "--base", "HEAD~1", "--out", out], { cwd: dir, encoding: "utf8" });
          expect([filter, p.status, p.stderr.includes(`refused: ${want}`), existsSync(out)]).toEqual([filter, 2, true, false]);
          // The clone fetched nothing on the tool's behalf: the blob is still not local.
          expect([filter, spawnSync("git", ["cat-file", "-e", "HEAD~1:mini-apps/acme/manifest.json"], { cwd: dir, env: { ...gitEnv, GIT_NO_LAZY_FETCH: "1" } }).status === 0]).toEqual([filter, false]);
        }
        // A path is literal, never a pathspec glob: mini-apps/[a]cme/ is not mini-apps/acme/ (no refusal).
        const globbed = join(clones, "blob-none", "mini-apps", "[a]cme");
        mkdirSync(globbed);
        copyFileSync(join(clones, "blob-none", "mini-apps", "acme", "manifest.json"), join(globbed, "manifest.json"));
        const literal = runConformance({ manifest: join(globbed, "manifest.json"), fixtures: c.fixtures, base: "HEAD~1" }, { cwd: join(clones, "blob-none") });
        expect(row(literal, "version.bump")).toEqual({ check: "version.bump", pass: null, note: "the manifest is not a valid v2 manifest" });
        // In the blob-less clone a path that is absent at the base is still told apart: a new manifest.
        const manifest = join(clones, "blob-none", "mini-apps", "acme", "manifest.json");
        const fresh = runConformance({ manifest, fixtures: c.fixtures, base: "HEAD~2" }, { cwd: join(clones, "blob-none") });
        expect(row(fresh, "version.bump").note).toStartWith("a new manifest: none at HEAD~2");
      } finally { rmSync(clones, { recursive: true, force: true }); }
    });
  });
  test("F21: a base manifest that is a symlink, a directory or a submodule REFUSES base_manifest_not_a_regular_file; the run refusal removes our own report", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const text = readFileSync(c.path, "utf8");
      const rel = "mini-apps/acme/manifest.json";
      g(c.root, "init", "-q");
      g(c.root, "add", "skills");
      g(c.root, "commit", "-q", "-m", "skill only");
      rmSync(c.path);
      writeFileSync(join(c.root, "real.json"), text);
      symlinkSync("../../real.json", c.path);
      g(c.root, "add", "-A");
      g(c.root, "commit", "-q", "-m", "a symlinked manifest");
      rmSync(c.path);
      mkdirSync(c.path);
      writeFileSync(join(c.path, "x"), "x\n");
      g(c.root, "add", "-A");
      g(c.root, "commit", "-q", "-m", "a directory at the manifest path");
      g(c.root, "rm", "-q", "-r", "--cached", rel);
      rmSync(c.path, { recursive: true });
      g(c.root, "update-index", "--add", "--cacheinfo", `160000,${g(c.root, "rev-parse", "HEAD").trim()},${rel}`);
      g(c.root, "commit", "-q", "-m", "a submodule at the manifest path");
      g(c.root, "rm", "-q", "--cached", rel);
      writeFileSync(c.path, text);
      g(c.root, "add", "-A");
      g(c.root, "commit", "-q", "-m", "a regular manifest again");
      expect(g(c.root, "ls-tree", "HEAD~1", "--", rel)).toStartWith("160000 commit ");
      expect(g(c.root, "ls-tree", "HEAD~2", "--", rel)).toStartWith("040000 tree ");
      expect(g(c.root, "ls-tree", "HEAD~3", "--", rel)).toStartWith("120000 blob ");
      for (const base of ["HEAD~1", "HEAD~2", "HEAD~3"]) {
        let reason = "";
        try { run(c, { base }); } catch (e) { reason = e instanceof Refusal ? e.reason : `other ${e}`; }
        expect([base, reason]).toEqual([base, "base_manifest_not_a_regular_file"]);
        writeFileSync(c.out, staleReport());
        const warned: string[] = [];
        expect([base, main([c.path, "--fixtures", c.fixtures, "--base", base, "--out", c.out], { cwd: c.root, print: () => {}, warn: s => warned.push(s) }),
          warned.join("").includes("refused: base_manifest_not_a_regular_file"), existsSync(c.out)]).toEqual([base, 2, true, false]);
      }
      expect(row(run(c, { base: "HEAD" }), "version.bump").note).toStartWith("no change since the base");
    });
  });
});

describe("item 4: approval, statically", () => {
  test("every needs-card op names a prepare-class op; a missing, unknown or read-class prepare fails", () => {
    const cases: [string, (m: any) => void, string][] = [
      ["unknown prepare", m => { m.operations[2].approval.prepare = "acme.order.nope"; }, "is not an operation of this manifest"],
      ["a read named as prepare", m => { m.operations[2].approval.prepare = "acme.lookup"; }, "is class read, not prepare"],
      ["no approval", m => { delete m.operations[2].approval; }, "no approval.prepare"],
    ];
    for (const [why, change, want] of cases) {
      const m = acme();
      change(m);
      withCatalog({ manifest: m, fixtures: GOOD_FIXTURES }, c => {
        const r = run(c);
        expect([why, row(r, "approval.prepare_pair").pass, row(r, "approval.prepare_pair").note.includes(want)]).toEqual([why, false, true]);
        expect(r.passed).toBe(false);
      });
    }
    const none = acme();
    none.operations = none.operations.slice(0, 1);
    withCatalog({ manifest: none, fixtures: GOOD_FIXTURES }, c => {
      expect(row(run(c), "approval.prepare_pair")).toEqual({ check: "approval.prepare_pair", pass: true, note: "no needs-card operation" });
      expect(row(run(c), "approval.summary_render").note).toEndWith("; no needs-card op");
    });
  });
  test("the summary render is not_run renderer_absent: no section 3.2 renderer in the repo, and v0 renders nothing", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const r = row(run(c), "approval.summary_render");
      expect(r.pass).toBe(null);
      expect(r.note).toStartWith("renderer_absent: ");
    });
    const scripts = readFileSync(SCRIPT, "utf8");
    expect(scripts.includes("{{#each")).toBe(false);
  });
});

describe("item 5: strict JSON and duplicate keys (a raw-text scan; JSON.parse hides them)", () => {
  const dups = (text: string) => {
    const r = strictJson(text);
    if (!r.ok) throw new Error(r.error);
    return r.duplicates.map(d => show([...d.at, d.key]));
  };
  test("top level, nested, inside arrays, and only within one object", () => {
    expect(dups("{\"a\":1,\"a\":2}")).toEqual(["/a"]);
    expect(dups("{\"x\":{\"k\":1,\"j\":{\"k\":0},\"k\":2}}")).toEqual(["/x/k"]);
    expect(dups("[{\"k\":1},{\"k\":2}]")).toEqual([]);
    expect(dups("[0,{\"k\":1,\"k\":2}]")).toEqual(["/1/k"]);
    expect(dups("{\"a\":{\"k\":1},\"b\":{\"k\":1}}")).toEqual([]);
    expect(dups("{\"A\":1,\"a\":2}")).toEqual([]);
    expect(dups("{\"a\":1,\"b\":{\"c\":[{\"d\":1,\"d\":1}]},\"a\":3}")).toEqual(["/b/c/0/d", "/a"]);
    expect(dups("{\"a/b\":1,\"a/b\":2}")).toEqual(["/a~1b"]);
    // JSON.parse keeps one of them silently.
    expect(JSON.parse("{\"a\":1,\"a\":2}")).toEqual({ a: 2 });
  });
  test("escaped keys are compared after decoding", () => {
    expect(dups(`{"a":1,"${u("0061")}":2}`)).toEqual(["/a"]);
    expect(dups(`{"${u("0041")}b":1,"Ab":2}`)).toEqual(["/Ab"]);
    expect(dups(`{"a/b":1,"a${BS}/b":2}`)).toEqual(["/a~1b"]);
    expect(dups(`{"q${BS}"":1,"q${u("0022")}":2}`)).toEqual(["/q\""]);
    const smile = String.fromCodePoint(0x1f600);
    expect(dups(`{"${smile}":1,"${u("d83d")}${u("de00")}":2}`)).toEqual(["/??"]);
    expect(dups(`{"x":{"${u("006b")}":1,"k":2}}`)).toEqual(["/x/k"]);
    expect(dups(`{"a":1,"${u("0062")}":2}`)).toEqual([]);
  });
  test("it accepts exactly what JSON.parse accepts on this corpus, with the same value", () => {
    const good = ["{}", "[]", "0", "-0", "1.5e-3", "\"x\"", "true", "null", " \t\r\n{ \"a\" : [ 1 , 2 ] } ", `"${u("00e9")}${BS}n${BS}t"`,
      "[1E9,-2.5E+2,0.0]", "{\"__proto__\":1}", "[[[[{\"a\":{}}]]]]"];
    for (const text of good) {
      const r = strictJson(text);
      expect([text, r.ok]).toEqual([text, true]);
      if (r.ok) expect(r.value).toEqual(JSON.parse(text));
    }
    const bad = ["", "{\"a\":1,}", "[1,]", "{'a':1}", "01", "1.", ".5", "+1", "-", "NaN", "{\"a\":1} x", "{\"a\" 1}", "\"unterminated",
      `"${BS}x"`, `"${u("12")}"`, "\"a\tb\"", "{\"a\":1 /* c */}", String.fromCharCode(0xfeff) + "{}", "[1 2]", "{1:2}", "tru", "nul"];
    for (const text of bad) {
      expect([text, strictJson(text).ok]).toEqual([text, false]);
      expect([text, (() => { try { JSON.parse(text); return true; } catch { return false; } })()]).toEqual([text, false]);
    }
    expect(strictJson("[".repeat(300) + "]".repeat(300))).toEqual({ ok: false, error: "too_deep" });
  });
  test("a fixture with a duplicate key, an invalid file and a BOM-prefixed file fail hygiene.duplicate_keys", () => {
    const fixtures = {
      ...GOOD_FIXTURES,
      "acme.lookup/dup.json": `{"items":[{"name":"a","${u("006e")}ame":"b"}]}`,
      "acme.order.prepare/broken.json": "{\"draftId\": \"d\",}",
      "acme.order.confirm/bom.json": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
    };
    withCatalog({ fixtures }, c => {
      const r = row(run(c), "hygiene.duplicate_keys");
      expect(r.pass).toBe(false);
      expect(r.note).toContain("acme.lookup/dup.json: duplicate key /items/0/name");
      expect(r.note).toContain("acme.order.prepare/broken.json: not strict JSON (expected_key)");
      expect(r.note).toContain("acme.order.confirm/bom.json: not strict JSON (unexpected_token)");
    });
  });
});

describe("item 5: secret patterns", () => {
  // Built at run time from parts, so no secret-shaped literal sits in this file.
  const A = (n: number) => "A1b2".repeat(Math.ceil(n / 4)).slice(0, n);
  const positives: [string, string][] = [
    ["sk_key", "s" + "k-" + A(24)],
    ["sk_key", "token is s" + "k-proj-" + A(30) + " here"],
    ["stripe_key", "s" + "k_live_" + A(24)],
    ["github_token", "gh" + "p_" + A(36)],
    ["github_token", "gh" + "s_" + A(36)],
    ["github_pat", "github" + "_pat_" + A(40)],
    ["slack_token", "xo" + "xb-" + A(20)],
    ["jwt", "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxIn0." + A(20)],
    ["pem_private_key", "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIB"],
    ["pem_private_key", "-----BEGIN " + "PRIVATE KEY-----"],
    ["aws_access_key_id", "AK" + "IA" + "ABCDEFGHIJKLMNOP"],
    ["aws_secret_assignment", "aws_secret_access_key" + " = " + A(40)],
    ["password_assignment", "https://x.example/?user=a&pass" + "word=hunter2"],
    ["password_assignment", "PASS" + "WORD = x"],
    ["bearer_value", "Authorization: Bear" + "er " + A(32)],
    ["av_bridge_token", "av" + "b_" + A(43)],
    ["google_api_key", "AI" + "za" + A(35)],
    ["npm_token", "np" + "m_" + A(36)],
    ["token_assignment", "access_" + "token=" + A(20)],
    ["jwt", "id=" + "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxIn0." + A(20)],
    ["url_userinfo", "postgres://" + "app:" + "hunter2pass" + "@db.example:5432/x"],
    ["url_userinfo", "see https://" + "u:" + "p" + "@host.example/"],
    ["basic_auth", "Authorization: Bas" + "ic " + "dXNlcjpwYXNzd29yZA=="],
    ["basic_auth", "{\"authorization\": \"bas" + "ic " + "dXNlcjpwYXNz\"}"],
  ];
  const negatives = ["risk-assessment-framework-2026", "desk-0123456789abcdefghij", "s" + "k-short", "gh" + "p_short",
    "ey" + "JhbGciOiJIUzI1NiJ9", "Password: reset it from your settings", "The password reset link expired.",
    "passport=12345", "AK" + "IAshort", "a".repeat(64), "123e4567-e89b-12d3-a456-426614174000", "the bearer of good news",
    "task-0123456789abcdefghijklmn", "access token rotates daily", "avb_" + "short", "Total: 120 INR",
    "https://host.example:8443/path", "https://user@host.example/", "postgres://db.example:5432/app", "mailto:a@b.example",
    "Basic subscription: 5 USD a month", "the basic idea is simple", "x" + "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxIn0." + A(20)];
  test("each pattern finds its shape, the note names the pattern and the place, and never the secret", () => {
    for (const [name, secret] of positives) {
      const found = secretFindings({ deep: [{ text: secret }] });
      expect([name, secret.length > 0, found.map(([at, p]) => `${show(at)} ${p}`)]).toEqual([name, true, [`/deep/0/text ${name}`]]);
    }
    const fixtures: Record<string, string> = { ...GOOD_FIXTURES };
    positives.forEach(([, secret], i) => { fixtures[`acme.lookup/s${i}.json`] = JSON.stringify({ note: secret }); });
    withCatalog({ fixtures }, c => {
      const r = run(c);
      expect(row(r, "hygiene.secrets").pass).toBe(false);
      const text = JSON.stringify(r);
      for (const [, secret] of positives) expect(text.includes(secret)).toBe(false);
      expect(row(r, "hygiene.secrets").note).toContain("acme.lookup/s0.json /note (sk_key)");
      expect(r.passed).toBe(false);
    });
  });
  test("false positives: ordinary response text is not a secret", () => {
    for (const text of negatives) expect([text, secretFindings({ text })]).toEqual([text, []]);
    expect(secretFindings({ password_hint: "x", password: "", token: "", tokenCount: "3", passwordSet: true, nextToken: "page-2",
      authorization: "required", "Proxy-Authorization": "not configured yet" })).toEqual([]);
    withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/prose.json": JSON.stringify({ lines: negatives }) } }, c => {
      expect(row(run(c), "hygiene.secrets").pass).toBe(true);
    });
  });
  test("a secret escaped in the raw text, held in a key, or named by its key is still found", () => {
    const hidden = `${u("0073")}k-` + A(24);
    const key = "gh" + "p_" + A(36);
    const fixtures = {
      ...GOOD_FIXTURES,
      "acme.lookup/escaped.json": `{"note":"${hidden}"}`,
      "acme.lookup/key.json": JSON.stringify({ [key]: 1 }),
      "acme.lookup/named.json": JSON.stringify({ auth: { client_secret: "plain-looking-value" } }),
      "acme.lookup/raw.json": "{\"broken\": \"s" + "k-" + A(24) + "\",}",
    };
    withCatalog({ fixtures }, c => {
      const r = row(run(c), "hygiene.secrets");
      expect(r.pass).toBe(false);
      expect(r.note).toContain("acme.lookup/escaped.json /note (sk_key)");
      expect(r.note).toContain("acme.lookup/key.json /<redacted> (github_token, in a key)");
      expect(r.note).toContain("acme.lookup/named.json /auth/client_secret (secret_key_name)");
      expect(r.note).toContain("acme.lookup/raw.json raw text (sk_key)");
      expect(r.note.includes(key)).toBe(false);
    });
  });
  test("a key that names a credential (review-b N3 names) or an Authorization header holding a scheme value is found", () => {
    const named = ["secret_key", "secretKey", "x-api-key", "X-API-Key", "token", "api_secret", "set-cookie", "Set-Cookie", "cookie",
      "password", "client_secret", "access_token"];
    for (const key of named) expect([key, secretFindings({ h: { [key]: "plain-looking-value" } })]).toEqual([key, [[["h", key], "secret_key_name"]]]);
    for (const key of ["Authorization", "authorization", "Proxy-Authorization"]) {
      for (const value of ["Bas" + "ic dXNlcjpwYXNz", "Dig" + "est username=x", "Tok" + "en " + A(12)]) {
        expect([key, value, secretFindings({ [key]: value }).map(([, p]) => p)]).toEqual([key, value, ["authorization_header"]]);
      }
    }
  });
  test("N1 residual gaps (review-b): an empty URL user (redis://:pw@), api_token / passphrase / session_id, a quoted value with spaces", () => {
    const found: [string, string][] = [
      ["url_userinfo", "redis://" + ":" + "hunter2pass" + "@cache.example:6379/0"],
      ["token_assignment", "api_" + "token=" + A(20)],
      ["token_assignment", "session_" + "id: " + A(24)],
      ["token_assignment", "{\"api_" + "key\": \"" + "abcd efgh ijkl mnop" + "\"}"],
      ["password_assignment", "pass" + "phrase=" + "correct-horse"],
      ["password_assignment", "pass" + "word=\"" + "hunter 2" + "\""],
      ["aws_secret_assignment", "aws_secret_access_key" + "='" + "two words here" + "'"],
    ];
    for (const [name, text] of found) {
      expect([text, secretPattern(text)]).toEqual([text, name]);
      expect([text, secretFindings({ t: text }).map(([, p]) => p)]).toEqual([text, [name]]);
    }
    for (const key of ["api_token", "apiToken", "API-Token", "passphrase", "Passphrase", "session_id", "sessionId", "SESSION-ID"])
      expect([key, secretFindings({ h: { [key]: "plain-looking-value" } })]).toEqual([key, [[["h", key], "secret_key_name"]]]);
    for (const text of ["redis://:6379/0", "redis://cache.example:6379", "session ids rotate daily", "a passphrase strength meter",
      "the api token page", "session_id: 42", "api_key: \"see docs\"", "password reset", "Password: \"set it later\""])
      expect([text, secretFindings({ text })]).toEqual([text, []]);
    // Redaction removes the whole value: the space, the rest and the closing quote too.
    const values: [string, string, string][] = [
      ["pass" + "word=\"hunter 2\"", " 2", "before <redacted> after"],
      ["api_" + "key='abcd efgh ijkl mnop'", "mnop", "before <redacted> after"],
      ["aws_secret_access_key" + "=\"two words here\"", "words", "before <redacted> after"],
      ["redis://" + ":" + "hunter2pass" + "@cache.example/0", "hunter2pass", "before <redacted>cache.example/0 after"],
    ];
    for (const [text, rest, want] of values) {
      const r = redact(`before ${text} after`);
      expect([text, r.includes(rest), r]).toEqual([text, false, want]);
    }
    const fixtures: Record<string, string> = { ...GOOD_FIXTURES };
    found.forEach(([, text], i) => { fixtures[`acme.lookup/n${i}.json`] = JSON.stringify({ note: text }); });
    withCatalog({ fixtures }, c => {
      const r = run(c);
      expect(row(r, "hygiene.secrets").pass).toBe(false);
      for (const [, text] of found) expect([text, JSON.stringify(r).includes(text)]).toEqual([text, false]);
      expect(found.every((_, i) => row(r, "hygiene.secrets").note.includes(`acme.lookup/n${i}.json /note`))).toBe(true);
    });
  });
  test("redaction removes an assignment's value too, not only its key (password=, aws_secret_access_key=)", () => {
    const values = [["pass" + "word=" + "hunter2-value", "hunter2-value"], ["PASS" + "WORD = " + "s3cr3t!x", "s3cr3t!x"],
      ["aws_secret_access_key" + " = " + A(40), A(40)], ["AWS_SECRET_ACCESS_KEY" + ":" + A(40), A(40)],
      ["db postgres://" + "app:" + "hunter2pass" + "@db.example/x", "hunter2pass"], ["Authorization: Bas" + "ic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="]];
    for (const [text, value] of values) {
      const r = redact(`before ${text} after`);
      expect([text, r.includes(value), r.includes("<redacted>"), r.startsWith("before "), r.endsWith(" after")]).toEqual([text, false, true, true, true]);
    }
  });
  test("ReDoS: every pattern is linear; 1 MB adversarial strings (eyJ-eyJ-... and one per shape) each scan in well under 2 s", () => {
    const MB = 1 << 20;
    const fill = (unit: string, prefix = "") => (prefix + unit.repeat(Math.ceil(MB / unit.length))).slice(0, MB);
    const cases: [string, string][] = [
      ["eyJ-", fill("ey" + "J-")], ["eyJ.", fill("ey" + "J.")], ["eyJ then a run", fill("a", "ey" + "J")], ["eyJ, a dot, a run", fill("a", "ey" + "Jaaaaaaaaa.")],
      ["a.a.", fill("a.")], ["x://u: then a run", fill("p", "x://u:")], ["x://x://", fill("x://")], ["u:u:", fill("u:", "x://")],
      ["authorization: ", fill("authorization: ")], ["authorization:basic ", fill("authorization:bas" + "ic ")],
      ["-----BEGIN A A", fill("A ", "-----BEGIN ")], ["password ", fill("pass" + "word ")], ["bearer ", fill("bear" + "er ")],
      ["api_key ", fill("api_" + "key ")], ["AKIA", fill("AK" + "IA")],
      ["redis://: then colons", fill(":", "redis://:")], ["x://: repeated", fill("x://:")], ["a://b: repeated", fill("a://b:")],
      ["password=\" then a run", fill("a", "pass" + "word=\"")], ["api_key=\" then words", fill("a b ", "api_" + "key=\"")],
      ["api_key=\" repeated", fill("api_" + "key=\"")], ["session_id ", fill("session_" + "id ")], ["passphrase ", fill("pass" + "phrase ")],
    ];
    for (const [name, text] of cases) {
      expect(text.length).toBe(MB);
      const t = performance.now();
      secretPattern(text);
      redact(text);
      secretFindings({ [text.slice(0, 64)]: text });
      const ms = performance.now() - t;
      expect([name, ms < 2000]).toEqual([name, true]);
    }
  }, 60000);
  test("a fixture file name cannot forge a summary line, and notes carry no control character", () => {
    const spoof = "x\n  PASS    hygiene.secrets: spoofed\n.json";
    withCatalog({ fixtures: { ...GOOD_FIXTURES, [`acme.lookup/${spoof}`]: JSON.stringify({ t: "s" + "k-" + A(24) }) } }, c => {
      const r = run(c);
      expect(row(r, "hygiene.secrets").pass).toBe(false);
      const control = new RegExp(`[${BS}x00-${BS}x1f${BS}x7f-${BS}x9f${String.fromCharCode(0x2028, 0x2029)}]`);
      for (const x of r.results) expect([x.check, control.test(x.note)]).toEqual([x.check, false]);
      const lines = summary(r).split("\n");
      expect(lines.filter(l => l.includes("spoofed")).every(l => l.startsWith("  FAIL    hygiene.secrets: "))).toBe(true);
      expect(lines.length).toBe(CHECKS.length + 2);
    });
    expect(redact(["a", "b", "c", "d"].join("\n").replace("b\nc", "b" + String.fromCharCode(0x2028) + "c").replace("c\nd", "c" + String.fromCharCode(7) + "d"))).toBe("a?b?c?d");
    expect(redact("x".repeat(5000)).length).toBe(4000);
    // A long name is shown cut to 64 characters, as every pointer segment is.
    const long = "n".repeat(100) + ".txt";
    withCatalog({ fixtures: { ...GOOD_FIXTURES, [`acme.lookup/${long}`]: "{}" } }, c => {
      const note = row(run(c), "hygiene.fixtures").note;
      expect([note.includes(long), note.includes(`acme.lookup/${"n".repeat(61)}...: not a .json file`)]).toEqual([false, true]);
    });
  });
  test("the pattern list covers the brief's shapes and the validator's own", () => {
    expect(SECRET_PATTERNS.map(([n]) => n)).toEqual(expect.arrayContaining(["sk_key", "github_token", "github_pat", "jwt",
      "pem_private_key", "password_assignment", "aws_access_key_id", "aws_secret_assignment", "slack_token"]));
  });
});

describe("item 5: error bodies and the fixture layout", () => {
  test("an error body is exactly {code, detail} with a code from the closed set", () => {
    const cases: [string, unknown, string][] = [
      ["an extra key", { code: "not_found", detail: "No such item.", trace: "x" }, "keys are code, detail, trace"],
      ["no detail", { code: "not_found" }, "keys are code, not exactly code, detail"],
      ["an open code", { code: "Something went wrong", detail: "x" }, "is not in the closed set for acme"],
      ["another app's code", { code: "zzz_not_found", detail: "x" }, "(it is zzzbot's)"],
      ["a code that is not a string", { code: 404, detail: "x" }, "code (not a string)"],
      ["an empty detail", { code: "not_found", detail: " " }, "detail is a non-empty string"],
      ["a long detail", { code: "not_found", detail: "x".repeat(1001) }, "detail is a non-empty string"],
      ["an array", [{ code: "not_found", detail: "x" }], "an error body is a {code, detail} object"],
    ];
    for (const [why, body, want] of cases) {
      withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/error-x.json": JSON.stringify(body) } }, c => {
        const r = row(run(c), "hygiene.error_bodies");
        expect([why, r.pass, r.note.includes(want)]).toEqual([why, false, true]);
      });
    }
    withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/ok-but.json": JSON.stringify({ error: "zzz_invalid" }) } }, c => {
      expect(row(run(c), "hygiene.error_bodies").note).toContain("a success fixture carries \"error\"");
    });
    for (const code of GENERIC_ERROR_CODES) {
      withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.order.confirm/error.json": JSON.stringify({ code, detail: "Fixed sentence." }) } }, c => {
        expect([code, row(run(c), "hygiene.error_bodies").pass]).toEqual([code, true]);
      });
    }
  });
  test("the closed set: each first-party app may use only its own bridge codes; any other app the generic list", () => {
    expect(allowedErrorCode("zzzbot", "zzz_not_found")).toBe(true);
    expect(allowedErrorCode("forkicks", "zzz_not_found")).toBe(false);
    expect(allowedErrorCode("forkicks", "pickup_only:latte-1")).toBe(true);
    expect(allowedErrorCode("acme", "pickup_only:latte-1")).toBe(false);
    expect(allowedErrorCode("gold-stars", "star_self")).toBe(true);
    expect(allowedErrorCode("gold-stars", "not_found")).toBe(false);
    expect(allowedErrorCode("slopfolio", "DRAFT_NOT_FOUND")).toBe(true);
    expect(allowedErrorCode("dizko", "not_found")).toBe(true);
    expect(allowedErrorCode("acme", "star_self")).toBe(false);
    for (const code of GENERIC_ERROR_CODES) expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
  test("drift guard: every bridge code is still a literal in plugins/village-bridge/__init__.py", () => {
    const bridge = readFileSync(join(REPO, "plugins", "village-bridge", "__init__.py"), "utf8");
    for (const code of Object.keys(BRIDGE_ERROR_CODES)) expect([code, bridge.includes(`"${code}"`)]).toEqual([code, true]);
    expect(bridge.includes("pickup_only:[A-Za-z0-9_-]{1,128}")).toBe(true);
  });
  test("the layout is closed: unknown op directories, loose files, other extensions, symlinks, nesting and oversize fail", () => {
    const cases: [string, (dir: string) => void, string][] = [
      ["an unknown op", d => { mkdirSync(join(d, "acme.other")); writeFileSync(join(d, "acme.other", "ok.json"), "{}"); }, "acme.other/: not an operation of this manifest"],
      ["a loose file", d => writeFileSync(join(d, "ok.json"), "{}"), "ok.json: a fixture sits in an <operation>/ directory"],
      ["another extension", d => writeFileSync(join(d, "acme.lookup", "ok.txt"), "{}"), "acme.lookup/ok.txt: not a .json file"],
      ["a symlinked fixture", d => symlinkSync(join(d, "acme.lookup", "ok.json"), join(d, "acme.lookup", "link.json")), "acme.lookup/link.json: symlink"],
      ["a symlinked op dir", d => symlinkSync(join(d, "acme.lookup"), join(d, "acme.order.prepare")), "acme.order.prepare: symlink"],
      ["a nested directory", d => mkdirSync(join(d, "acme.lookup", "more")), "acme.lookup/more: not a regular file"],
      ["oversize", d => writeFileSync(join(d, "acme.lookup", "big.json"), JSON.stringify({ x: "y".repeat(5000) })), "is over acme.lookup's maxResponseBytes 4096"],
      ["a .DS_Store", d => writeFileSync(join(d, "acme.lookup", ".DS_Store"), ""), "acme.lookup/.DS_Store: not a .json file"],
    ];
    for (const [why, plant, want] of cases) {
      withCatalog({ fixtures: GOOD_FIXTURES }, c => {
        plant(c.fixtures);
        const r = run(c);
        invariants(r);
        expect([why, row(r, "hygiene.fixtures").pass, row(r, "hygiene.fixtures").note.includes(want)]).toEqual([why, false, true]);
        expect(r.passed).toBe(false);
      });
    }
  });
});

describe("the CLI", () => {
  test("arguments: one manifest path, each option once with a value, no unknown option", () => {
    expect(parseArgs(["--", "m/mini-apps/a/manifest.json", "--out", "o.json"])).toEqual({ manifest: "m/mini-apps/a/manifest.json", fixtures: undefined, out: "o.json", base: undefined });
    for (const bad of [[], ["a", "b"], ["a", "--out"], ["a", "--out", "--base"], ["a", "--out", "x", "--out", "y"], ["a", "--force"], ["a", "--base=HEAD"]]) {
      expect(() => parseArgs(bad)).toThrow(Refusal);
    }
  });
  test("exit codes from a real process: 0 passed with conformance.json written, 1 failed, 2 refused", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const out = c.out;
      const ok = spawnSync("bun", [SCRIPT, c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, encoding: "utf8" });
      expect([ok.status, ok.stdout.trim().split("\n").at(-1)]).toEqual([0, "passed: true"]);
      const written = JSON.parse(readFileSync(out, "utf8"));
      invariants(written);
      expect(written.sha256).toBe(sha256(readFileSync(c.path)));
      expect(written.passed).toBe(true);
      const failed = spawnSync("bun", [SCRIPT, c.path], { cwd: c.root, encoding: "utf8" });
      expect(failed.status).toBe(1);
      const refusals: [string[], string][] = [
        [[], "one_manifest_path_expected"],
        [[join(c.root, "skills", "acme", "SKILL.md")], "manifest_path_must_be"],
        [[c.path, "--fixtures", join(c.root, "nope")], "fixtures_not_a_directory"],
        [[c.path, "--out", join(c.root, "nope", "c.json")], "out_directory_missing"],
        [[c.path, "--out", c.path], "out_would_overwrite_the_manifest"],
        [[c.path, "--out", join(c.root, "conformance.json")], "out_inside_the_repo_or_the_tool_root"],
        [[c.path, "--unknown"], "unknown_option"],
        [[join(c.root, "mini-apps", "gone", "manifest.json")], "manifest_missing"],
      ];
      for (const [args, reason] of refusals) {
        const p = spawnSync("bun", [SCRIPT, ...args], { cwd: c.root, encoding: "utf8" });
        expect([args.join(" "), p.status, p.stderr.includes(reason)]).toEqual([args.join(" "), 2, true]);
      }
      expect(readFileSync(c.path, "utf8")).toBe(JSON.stringify(acme(), null, 2) + "\n");
    });
  });
  const quiet = { print: () => {}, warn: () => {} };
  test("--out: an argument refusal touches nothing; a run refusal removes only this manifest's own conformance.json; exit 0 and 1 replace it; no --out writes no file", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const out = c.out;
      // Argument refusals (N3, release ruling L14545): every argument is checked before any file is
      // touched, so the file at --out is byte for byte what it was, whether it is ours or not.
      const argumentRefusals: [string, string[], string][] = [
        ["--fixtures given twice", [c.path, "--out", out, "--fixtures", c.fixtures, "--fixtures", c.fixtures], "--fixtures_given_twice"],
        ["an unknown option", [c.path, "--out", out, "--force"], "unknown_option"],
        ["--out given twice", [c.path, "--out", out, "--out", out], "--out_given_twice"],
        ["a fixtures path that is not a directory", [c.path, "--out", out, "--fixtures", join(c.root, "nope")], "fixtures_not_a_directory"],
        ["a base ref outside a git checkout", [c.path, "--out", out, "--base", "HEAD"], "base_needs_a_git_checkout"],
        ["a malformed base ref", [c.path, "--out", out, "--base", "a b"], "bad_base_ref"],
        ["a manifest that is not there", [join(c.root, "mini-apps", "gone", "manifest.json"), "--out", out], "manifest_missing"],
      ];
      for (const body of [staleReport(), "{\"passed\": true}\n"]) {
        for (const [why, args, reason] of argumentRefusals) {
          writeFileSync(out, body);
          const warned: string[] = [];
          expect([why, main(args, { cwd: c.root, print: () => {}, warn: s => warned.push(s) }), warned.join("").includes(`refused: ${reason}`), readFileSync(out, "utf8")])
            .toEqual([why, 2, true, body]);
        }
      }
      // A file at --out that is not this manifest's own conformance.json is refused before the run and
      // left as it is, even when the run would pass: a forged passed:true, another manifest's report, a
      // report with a duplicate key, plain text, a symlink to our own report (the link and its target).
      const own = join(c.outDir, "own.json");
      writeFileSync(own, staleReport());
      const foreign: [string, () => void][] = [
        ["a forged passed:true", () => writeFileSync(out, "{\"passed\": true}\n")],
        ["another manifest's report", () => writeFileSync(out, staleReport("mini-apps/other/manifest.json"))],
        ["a duplicate key", () => writeFileSync(out, staleReport().replace("\"passed\": true", "\"passed\": true, \"passed\": true"))],
        ["plain text", () => writeFileSync(out, "notes\n")],
        ["a symlink to our own report", () => symlinkSync(own, out)],
      ];
      for (const [why, plant] of foreign) {
        rmSync(out, { force: true });
        plant();
        const before = lstatSync(out).isSymbolicLink() ? "link" : readFileSync(out, "utf8");
        const warned: string[] = [];
        expect([why, main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, print: () => {}, warn: s => warned.push(s) }),
          warned.join("").includes("refused: out_exists_and_is_not_this_manifests_conformance_json")]).toEqual([why, 2, true]);
        expect([why, lstatSync(out).isSymbolicLink() ? "link" : readFileSync(out, "utf8")]).toEqual([why, before]);
      }
      expect(readFileSync(own, "utf8")).toBe(staleReport());
      rmSync(out);
      // A run refusal (a pin mismatch: the tool refuses before reading anything) removes our own stale report.
      writeFileSync(out, staleReport());
      const tool = realpathSync(mkdtempSync(join(tmpdir(), "conformance-tool-")));
      try {
        mkdirSync(join(tool, "mini-apps"));
        writeFileSync(join(tool, "mini-apps", "manifests.pins.json"), "{}");
        expect([main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, toolRoot: tool, ...quiet }), existsSync(out)]).toEqual([2, false]);
      } finally { rmSync(tool, { recursive: true, force: true }); }
      // Exit 1 and exit 0 replace our stale report with this run's report.
      writeFileSync(out, staleReport());
      expect(main([c.path, "--out", out], { cwd: c.root, ...quiet })).toBe(1);
      expect(JSON.parse(readFileSync(out, "utf8")).passed).toBe(false);
      expect(main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, ...quiet })).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).passed).toBe(true);
      // No temp file is left beside it.
      expect(readdirSync(c.outDir).filter(n => n.includes(".tmp-"))).toEqual([]);
      // Without --out nothing is written: not next to the manifest, not anywhere in the catalog.
      rmSync(out);
      const before = readdirSync(c.root, { recursive: true }).map(String).sort();
      expect(main([c.path, "--fixtures", c.fixtures], { cwd: c.root, ...quiet })).toBe(0);
      expect(readdirSync(c.root, { recursive: true }).map(String).sort()).toEqual(before);
      expect(readdirSync(join(c.root, "mini-apps", "acme"))).toEqual(["manifest.json"]);
    });
  });
  test("an internal error (not a Refusal) exits 2 with only the error's name, and leaves no conformance.json", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const out = c.out;
      const warned: string[] = [];
      const code = main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, print: () => { throw new TypeError("boom s" + "k-" + "A1b2".repeat(6)); }, warn: s => warned.push(s) });
      expect([code, warned, existsSync(out)]).toEqual([2, ["conformance: refused: internal error TypeError"], false]);
    });
  });
  test("a refusal after the write removes only this manifest's own report: a foreign file that appears at --out stays", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const warned: string[] = [];
      const code = main([c.path, "--fixtures", c.fixtures, "--out", c.out], { cwd: c.root, print: () => { writeFileSync(c.out, "foreign\n"); throw new TypeError("late"); }, warn: s => warned.push(s) });
      expect([code, warned, readFileSync(c.out, "utf8")]).toEqual([2, ["conformance: refused: internal error TypeError"], "foreign\n"]);
    });
  });
  test("the temp file is opened exclusively (wx): a file or symlink planted at its name is never written through", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const out = c.out;
      const target = join(c.root, "victim.txt");
      writeFileSync(target, "untouched\n");
      symlinkSync(target, `${out}.tmp-${process.pid}`);
      const warned: string[] = [];
      expect(main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, print: () => {}, warn: s => warned.push(s) })).toBe(2);
      expect([warned.join(""), readFileSync(target, "utf8"), existsSync(out)]).toEqual(["conformance: refused: internal error Error", "untouched\n", false]);
      expect(lstatSync(`${out}.tmp-${process.pid}`).isSymbolicLink()).toBe(true);
    });
  });
  test("--out is refused anywhere inside the repo (and its git checkout) or the tool root, and as the manifest (a hard link, a symlink; any case on a case-insensitive fs)", () => {
    // The tool root is a throwaway copy: a mutant that drops a guard can never touch this repo.
    const tool = realpathSync(mkdtempSync(join(tmpdir(), "conformance-tool-")));
    for (const rel of ["scripts/mini-apps-manifests.cjs", "mini-apps/manifest.v2.schema.json", "mini-apps/manifests.pins.json"]) {
      mkdirSync(dirname(join(tool, rel)), { recursive: true });
      copyFileSync(join(REPO, rel), join(tool, rel));
    }
    mkdirSync(join(tool, "mini-apps", "gold-stars"));
    try { withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const bytes = readFileSync(c.path);
      const skill = readFileSync(join(c.root, "skills", "acme", "SKILL.md"));
      const toolFiles = ["scripts/mini-apps-manifests.cjs", "mini-apps/manifests.pins.json"].map(rel => [rel, readFileSync(join(tool, rel))] as const);
      linkSync(c.path, join(c.root, "hard-link.json"));
      symlinkSync(c.path, join(c.root, "sym-link.json"));
      mkdirSync(join(c.root, "elsewhere"));
      symlinkSync(join(c.root, "mini-apps"), join(c.root, "elsewhere", "apps"));
      // A symlinked directory OUTSIDE the repo that points back into it.
      symlinkSync(c.root, join(c.outDir, "into-repo"));
      symlinkSync(tool, join(c.outDir, "into-tool"));
      // This manifest's own report, sitting inside the repo: still refused, and left there.
      writeFileSync(join(c.root, "conformance.json"), staleReport());
      const asManifest = [c.path, "mini-apps/acme/manifest.json", "./mini-apps/../mini-apps/acme/manifest.json", "hard-link.json", "sym-link.json"];
      const inside = [
        "mini-apps/acme/other.json", "mini-apps/conformance.json", "mini-apps/acme/fixtures.json", "elsewhere/apps/acme/x.json",
        "conformance.json", "skills/acme/SKILL.md", "elsewhere/c.json", join(c.root, "new.json"), join(c.outDir, "into-repo", "x.json"),
        join(tool, "mini-apps", "manifests.pins.json"), join(tool, "mini-apps", "gold-stars", "conformance.json"),
        join(tool, "scripts", "mini-apps-manifests.cjs"), join(tool, "conformance.json"), join(c.outDir, "into-tool", "scripts", "x.json"),
      ];
      for (const [arg, reason] of [...asManifest.map(a => [a, "out_would_overwrite_the_manifest"]), ...inside.map(a => [a, "out_inside_the_repo_or_the_tool_root"])]) {
        const warned: string[] = [];
        expect([arg, main([c.path, "--fixtures", c.fixtures, "--out", arg], { cwd: c.root, toolRoot: tool, print: () => {}, warn: s => warned.push(s) }),
          warned.join("").includes(`refused: ${reason}`)]).toEqual([arg, 2, true]);
      }
      // Case variants: on a case-insensitive filesystem (macOS) they name the manifest or a path in the repo;
      // on a case-sensitive one the directory does not exist. Either way: exit 2, and nothing is touched.
      for (const arg of ["mini-apps/acme/MANIFEST.json", "MINI-APPS/acme/manifest.json", "Mini-Apps/ACME/x.json", "SKILLS/acme/x.json",
        join(dirname(c.root), basename(c.root).toUpperCase(), "x.json")]) {
        const warned: string[] = [];
        expect([arg, main([c.path, "--fixtures", c.fixtures, "--out", arg], { cwd: c.root, toolRoot: tool, print: () => {}, warn: s => warned.push(s) })]).toEqual([arg, 2]);
        expect([arg, ["out_would_overwrite_the_manifest", "out_inside_the_repo_or_the_tool_root", "out_directory_missing"].some(r => warned.join("").includes(`refused: ${r}`))]).toEqual([arg, true]);
      }
      // Nothing it guards was touched, and none of the refused paths was removed or created.
      expect(readFileSync(c.path).equals(bytes)).toBe(true);
      expect(readFileSync(join(c.root, "skills", "acme", "SKILL.md")).equals(skill)).toBe(true);
      for (const [rel, was] of toolFiles) expect([rel, readFileSync(join(tool, rel)).equals(was)]).toEqual([rel, true]);
      expect(readFileSync(join(c.root, "conformance.json"), "utf8")).toBe(staleReport());
      expect(readdirSync(join(c.root, "mini-apps", "acme"))).toEqual(["manifest.json"]);
      expect([existsSync(join(c.root, "hard-link.json")), lstatSync(join(c.root, "sym-link.json")).isSymbolicLink()]).toEqual([true, true]);
      expect(readdirSync(join(tool, "mini-apps", "gold-stars"))).toEqual([]);
      expect([existsSync(join(c.root, "new.json")), existsSync(join(tool, "conformance.json"))]).toEqual([false, false]);
      // F22: a directory refuses out_is_a_directory, outside the repo too, and is left as it is.
      mkdirSync(join(c.outDir, "a-dir"));
      const warned: string[] = [];
      expect([main([c.path, "--fixtures", c.fixtures, "--out", join(c.outDir, "a-dir")], { cwd: c.root, toolRoot: tool, print: () => {}, warn: s => warned.push(s) }),
        warned.join("").includes("refused: out_is_a_directory"), readdirSync(join(c.outDir, "a-dir"))]).toEqual([2, true, []]);
      // A symlinked parent directory outside the repo and the tool (e.g. macOS /tmp) is followed.
      mkdirSync(join(c.outDir, "real-out"));
      symlinkSync(join(c.outDir, "real-out"), join(c.outDir, "out-link"));
      expect(main([c.path, "--fixtures", c.fixtures, "--out", join(c.outDir, "out-link", "c.json")], { cwd: c.root, toolRoot: tool, ...quiet })).toBe(0);
      expect(JSON.parse(readFileSync(join(c.outDir, "real-out", "c.json"), "utf8")).passed).toBe(true);
    }); } finally { rmSync(tool, { recursive: true, force: true }); }
  });
  test("--out inside the git checkout around the repo is refused too (a catalog in a subdirectory of a checkout)", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "conformance-top-")));
    const outs = realpathSync(mkdtempSync(join(tmpdir(), "conformance-out-")));
    try {
      const root = join(top, "sub");
      mkdirSync(join(root, "mini-apps", "acme"), { recursive: true });
      mkdirSync(join(root, "skills", "acme"), { recursive: true });
      writeFileSync(join(root, "skills", "acme", "SKILL.md"), SKILL);
      const manifest = join(root, "mini-apps", "acme", "manifest.json");
      writeFileSync(manifest, JSON.stringify(acme(), null, 2) + "\n");
      g(top, "init", "-q");
      writeFileSync(join(top, "keep.txt"), "keep\n");
      for (const arg of [join(top, "keep.txt"), join(top, "c.json")]) {
        const warned: string[] = [];
        expect([arg, main([manifest, "--out", arg], { cwd: root, print: () => {}, warn: s => warned.push(s) }),
          warned.join("").includes("refused: out_inside_the_repo_or_the_tool_root")]).toEqual([arg, 2, true]);
      }
      expect([readFileSync(join(top, "keep.txt"), "utf8"), existsSync(join(top, "c.json"))]).toEqual(["keep\n", false]);
      expect(main([manifest, "--out", join(outs, "c.json")], { cwd: root, ...quiet })).toBe(1);
      expect(JSON.parse(readFileSync(join(outs, "c.json"), "utf8")).manifest).toBe("mini-apps/acme/manifest.json");
    } finally { rmSync(top, { recursive: true, force: true }); rmSync(outs, { recursive: true, force: true }); }
  });
  test("N4: the summary header prints the manifest path through show(): a directory name with newlines forges no line", () => {
    const id = "x\n  PASS    manifest.schema: forged\npassed: true\n";
    withCatalog({ id, fixtures: GOOD_FIXTURES }, c => {
      const lines: string[] = [];
      expect(main([c.path, "--fixtures", c.fixtures], { cwd: c.root, print: s => lines.push(s), warn: () => {} })).toBe(1);
      const out = lines.join("\n").split("\n");
      expect(out.length).toBe(CHECKS.length + 2);
      expect(out[0]).toStartWith("conformance mini-apps/x?  PASS    manifest.schema: forged?passed: true?/manifest.json sha256 ");
      expect(out.filter(l => l === "passed: true" || l.startsWith("  PASS    manifest.schema"))).toEqual([]);
      expect(out.at(-1)).toBe("passed: false");
    });
  });
  test("bun run conformance -- <manifest> from the repo root (the package.json script)", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.scripts).toEqual({ conformance: "bun scripts/mini-apps-conformance.ts" });
    const p = spawnSync("bun", ["run", "conformance", "--", "mini-apps/dizko/manifest.json"], { cwd: REPO, encoding: "utf8" });
    expect([p.status, p.stdout.includes("conformance mini-apps/dizko/manifest.json sha256 ")]).toEqual([1, true]);
  });
});

describe("the real manifests in mini-apps/catalog.json", () => {
  // The id list comes FROM the catalog, so the next first-party app does not break this test.
  const index = JSON.parse(readFileSync(join(REPO, "mini-apps", "catalog.json"), "utf8"));
  const EXPECTED = {
    "manifest.validator_pin": true, "manifest.schema": true, "skills.sha256": true, "version.bump": null,
    "service.reachability": null, "service.budgets": null, "service.error_bodies": null,
    "approval.prepare_pair": true, "approval.summary_render": null, "approval.fake_cp": null,
    "hygiene.fixtures": null, "hygiene.secrets": null, "hygiene.duplicate_keys": null, "hygiene.error_bodies": null,
  };
  test("the catalog lists unique ids, each with mini-apps/<id>/manifest.json", () => {
    expect(Array.isArray(index.apps)).toBe(true);
    expect(index.apps.length).toBeGreaterThan(0);
    expect(new Set(index.apps).size).toBe(index.apps.length);
    for (const id of index.apps) expect([id, existsSync(join(REPO, "mini-apps", id, "manifest.json"))]).toEqual([id, true]);
  });
  test("each runs without crashing: item 1 passes, item 5 is not_run (no fixtures in the closed mini-apps/ tree), so each fails honestly", () => {
    for (const id of index.apps) {
      const r = runConformance({ manifest: `mini-apps/${id}/manifest.json` }, { cwd: REPO });
      invariants(r);
      expect([id, r.sha256]).toEqual([id, sha256(readFileSync(join(REPO, "mini-apps", id, "manifest.json")))]);
      const got = Object.fromEntries(r.results.map(x => [x.check, x.pass]));
      expect([id, got]).toEqual([id, EXPECTED]);
      expect([id, r.passed]).toEqual([id, false]);
      expect(main([`mini-apps/${id}/manifest.json`], { cwd: REPO, print: () => {}, warn: () => {} })).toBe(1);
    }
  });
  test("mosaic (service.kind \"none\", no operations): every service check is not_run, never a FAIL and never a silent PASS; items 1 and 4 still run", () => {
    expect(index.apps).toContain("mosaic");
    const path = "mini-apps/mosaic/manifest.json";
    const m = JSON.parse(readFileSync(join(REPO, path), "utf8"));
    expect([m.service, m.operations]).toEqual([{ kind: "none" }, []]);
    const r = runConformance({ manifest: path }, { cwd: REPO });
    invariants(r);
    expect(Object.fromEntries(r.results.map(x => [x.check, x.pass]))).toEqual(EXPECTED);
    const service = r.results.filter(x => x.check.startsWith("service."));
    expect(service.length).toBeGreaterThan(0);
    for (const x of service) expect([x.check, x.pass]).toEqual([x.check, null]);
    const note = Object.fromEntries(r.results.map(x => [x.check, x.note]));
    expect([note["manifest.schema"].startsWith("a valid v2 manifest"), note["skills.sha256"], note["approval.prepare_pair"]])
      .toEqual([true, "matches: skills/mosaic/SKILL.md", "no needs-card operation"]);
    expect(r.passed).toBe(false);
    expect(main([path], { cwd: REPO, print: () => {}, warn: () => {} })).toBe(1);
  });
});

// ---- Conformance v1: the service checks (section 5.3 items 2-3), only with --service ----------------------
// A local stub server on 127.0.0.1 serves the logic; the resolver and the dialer are mocked (ServiceDeps),
// so the suite believes it talks to a public address of "sandbox.acme-dev.example" and nothing leaves this
// machine. The refusal tests prove that a refused address is never connected to: the dial spy is never
// called and the real stub listening on 127.0.0.1 accepts no connection.
const V1 = join(import.meta.dir, "fixtures", "conformance-v1");
// The v1 tests start local servers and wait on real timers; under a loaded machine 5 s is too tight.
setDefaultTimeout(30_000);
const SERVICE = "https://sandbox.acme-dev.example/mcp";
const PUBLIC = "93.184.215.14";
type Seen = { method: string; url: string; names: string[]; headers: Record<string, string>; body: string };
type Stub = { seen: Seen[]; deps: ServiceDeps; dials: { address: string; host: string; port: number }[]; resolves: string[]; connections: () => number; port: number; close: () => Promise<void> };
async function stub(handler: (req: Seen, res: ServerResponse) => void | Promise<void>, resolveTo: (n: number) => { address: string; family: number }[] = () => [{ address: PUBLIC, family: 4 }]): Promise<Stub> {
  const seen: Seen[] = [], dials: Stub["dials"] = [], resolves: string[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => {
      const names: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) names.push(req.rawHeaders[i].toLowerCase());
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", names, headers: req.headers as Record<string, string>, body: Buffer.concat(parts).toString("utf8") };
      seen.push(s);
      Promise.resolve(handler(s, res)).catch(() => res.destroy());
    });
  });
  server.on("connection", () => { connections++; });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const deps: ServiceDeps = {
    resolve: async host => { resolves.push(host); return resolveTo(resolves.length); },
    dial: to => { dials.push(to); return netConnect(port, "127.0.0.1"); },
  };
  const close = () => new Promise<void>(r => { (server as any).closeAllConnections?.(); server.close(() => r()); setTimeout(r, 500); });
  return { seen, deps, dials, resolves, connections: () => connections, port, close };
}
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers });
  res.end(body);
};
const TOOLS = JSON.parse(readFileSync(join(V1, "mcp-tools.json"), "utf8"));
/** A Streamable HTTP MCP server for acme: two tools/list pages, lookup answers per its q. */
function mcpServer(opts: { lookup?: (args: any, res: ServerResponse, id: number) => void; sse?: boolean; session?: string; init?: (res: ServerResponse) => boolean } = {}) {
  return (req: Seen, res: ServerResponse) => {
    const msg = JSON.parse(req.body || "{}");
    const answer = (result: unknown) => {
      if (opts.sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
        return; // Streamable HTTP may keep the stream open; the suite must not wait for EOF.
      }
      json(res, 200, { jsonrpc: "2.0", id: msg.id, result });
    };
    if (msg.method === "initialize") {
      if (opts.init && opts.init(res)) return;
      json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acme", version: "1" } } },
        { "mcp-session-id": opts.session ?? "sess-123", "set-cookie": "sid=abc; Path=/" });
      return;
    }
    if (msg.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (msg.method === "tools/list") {
      if (!msg.params?.cursor) return answer({ tools: TOOLS.slice(0, 1), nextCursor: "p2" });
      return answer({ tools: TOOLS.slice(1) });
    }
    if (msg.method === "tools/call" && msg.params?.name === "lookup") {
      if (opts.lookup) return opts.lookup(msg.params.arguments, res, msg.id);
      if (msg.params.arguments.q === "missing") return answer({ isError: true, content: [{ type: "text", text: "No such item." }], structuredContent: { code: "not_found", detail: "No such item." } });
      return answer({ content: [{ type: "text", text: "Two things." }], structuredContent: { items: [{ name: "a", rank: 1 }, { name: "b", rank: 2 }] }, more: true });
    }
    json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
  };
}
function httpsJsonAcme(extra: (m: any) => void = () => {}): any {
  const m = acme();
  m.service = { kind: "https-json", auth: { mode: "none" } };
  m.operations[0].target = { method: "POST", path: "/api/lookup" };
  m.operations[1].target = { method: "POST", path: "/api/quote" };
  m.operations[2].target = { method: "POST", path: "/api/place" };
  extra(m);
  return m;
}
/** A catalog whose --fixtures directory is a copy of conformance-v1/<kind>/, edited by `edit`. */
function v1Catalog(kind: "mcp" | "https-json", manifest: any = kind === "mcp" ? acme() : httpsJsonAcme(), edit: (files: Record<string, string>) => void = () => {}): Catalog {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(V1, kind, "acme.lookup"))) files[`acme.lookup/${name}`] = readFileSync(join(V1, kind, "acme.lookup", name), "utf8");
  edit(files);
  return catalog({ manifest, fixtures: files });
}
async function withStub<T>(handler: Parameters<typeof stub>[0], fn: (s: Stub) => Promise<T>, resolveTo?: Parameters<typeof stub>[1]): Promise<T> {
  const s = await stub(handler, resolveTo);
  try { return await fn(s); } finally { await s.close(); }
}
const runV1 = (c: Catalog, s: Stub, service = SERVICE) => runConformanceAsync({ manifest: c.path, fixtures: c.fixtures, service }, { cwd: c.root, service: s.deps });
const v1Rows = (r: Report) => Object.fromEntries(["service.reachability", "service.budgets", "service.error_bodies", "approval.fake_cp"].map(k => [k, row(r, k).pass]));
async function refusalOf(p: Promise<unknown>): Promise<string> {
  try { await p; return "no refusal"; } catch (e) { return e instanceof Refusal ? e.reason : `other ${e}`; }
}

describe("v1: not run by default, never REQUIRED", () => {
  test("without --service the three service rows are not_run with a how-to note; REQUIRED is the v0 set; a conforming app still passes", async () => {
    expect([...REQUIRED].sort()).toEqual(["hygiene.duplicate_keys", "hygiene.error_bodies", "hygiene.fixtures", "hygiene.secrets",
      "manifest.schema", "manifest.validator_pin", "skills.sha256"]);
    for (const check of ["service.reachability", "service.budgets", "service.error_bodies"]) expect(REQUIRED.has(check)).toBe(false);
    await withStub(mcpServer(), async s => {
      withCatalog({ fixtures: GOOD_FIXTURES }, c => {
        const r = run(c);
        invariants(r);
        for (const check of ["service.reachability", "service.budgets", "service.error_bodies"]) {
          expect([check, row(r, check).pass, row(r, check).note.startsWith("advisory (v1): not run by default (conformance v1): ")]).toEqual([check, null, true]);
        }
        expect(row(r, "service.reachability").note).toContain("--service");
        expect(r.passed).toBe(true);
      });
      // runConformanceAsync without --service: the same report, and no resolve and no dial.
      const c = catalog({ fixtures: GOOD_FIXTURES });
      try {
        const r = await runConformanceAsync({ manifest: c.path, fixtures: c.fixtures }, { cwd: c.root, service: s.deps });
        expect(r).toEqual(run(c));
      } finally { cleanup(c); }
      expect([s.resolves.length, s.dials.length, s.connections()]).toEqual([0, 0, 0]);
    });
  });
  test("advisory (owner ruling on ov#438): a v1 service row, run or not, passed or FAILED, never changes passed; a required row still does", () => {
    expect([...ADVISORY].sort()).toEqual(["service.budgets", "service.error_bodies", "service.reachability"]);
    for (const check of ADVISORY) expect(REQUIRED.has(check)).toBe(false);
    const base = CHECKS.map(check => ({ check, pass: REQUIRED.has(check) ? true : null, note: "" }));
    expect(passedOf(base as Result[])).toBe(true);
    for (const check of ADVISORY) {
      for (const value of [false, true, null]) expect([check, value, passedOf(base.map(r => r.check === check ? { ...r, pass: value } : r) as Result[])]).toEqual([check, value, true]);
    }
    expect(passedOf(base.map(r => ADVISORY.has(r.check) ? { ...r, pass: false } : r) as Result[])).toBe(true);
    // Everything else is unchanged: a failed optional v0 row and a missing required row still fail the run.
    expect(passedOf(base.map(r => r.check === "version.bump" ? { ...r, pass: false } : r) as Result[])).toBe(false);
    expect(passedOf(base.map(r => r.check === "hygiene.secrets" ? { ...r, pass: null } : r) as Result[])).toBe(false);
  });
  test("advisory end to end: every service row FAILS against the stub, yet passed is true, mainAsync exits 0, and the summary marks the rows advisory (v1)", async () => {
    await withStub((req, res) => json(res, 500, { code: "unavailable", detail: "down" }), async s => {
      const c = v1Catalog("https-json");
      try {
        const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
        invariants(r);
        expect(Object.fromEntries([...ADVISORY].map(k => [k, row(r, k).pass]))).toEqual({ "service.reachability": false, "service.budgets": false, "service.error_bodies": false });
        expect([...REQUIRED].every(k => row(r, k).pass === true)).toBe(true);
        expect(r.passed).toBe(true);
        const lines: string[] = [];
        const code = await mainAsync([c.path, "--fixtures", c.fixtures, "--service", "https://sandbox.acme-dev.example/", "--out", c.out], { cwd: c.root, service: s.deps, print: x => lines.push(x), warn: () => {} });
        expect(code).toBe(0);
        expect(JSON.parse(readFileSync(c.out, "utf8")).passed).toBe(true);
        const text = lines.join("\n");
        for (const k of ADVISORY) expect(text).toContain(`FAIL    ${k}: advisory (v1): `);
        expect(text.split("\n").at(-1)).toBe("passed: true");
        // A failing REQUIRED row still fails the run with the same advisory rows.
        writeFileSync(join(c.fixtures, "acme.lookup", "ok.json"), "{\"a\":1,\"a\":2}");
        expect((await runV1(c, s, "https://sandbox.acme-dev.example/")).passed).toBe(false);
      } finally { cleanup(c); }
    });
  });
  test("the sync entries refuse --service (it needs the network): runConformance and main", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      let reason = "";
      try { runConformance({ manifest: c.path, fixtures: c.fixtures, service: SERVICE }, { cwd: c.root }); } catch (e) { reason = (e as Refusal).reason; }
      expect(reason).toBe("service_needs_runConformanceAsync");
      const warned: string[] = [];
      expect(main([c.path, "--service", SERVICE], { cwd: c.root, print: () => {}, warn: s => warned.push(s) })).toBe(2);
      expect(warned.join("")).toContain("service_needs_mainAsync");
    });
  });
});

describe("v1 network safety: the URL, the address, redirects, budgets, credentials", () => {
  test("rule 1: --service must pass the validator's endpointRefusal and not be an Agent Village host; refused before any resolve or connection, through mainAsync (exit 2)", async () => {
    const { validator } = loadValidator(REPO);
    const refused: [string, string][] = [
      ["http://sandbox.acme-dev.example/mcp", "service_url_url"],
      ["https://127.0.0.1/mcp", "service_url_internal_host"],
      ["https://169.254.169.254/latest/meta-data/", "service_url_internal_host"],
      ["https://[::1]/mcp", "service_url_internal_host"],
      ["https://8.8.8.8/mcp", "service_url_ip_literal"],
      ["https://2130706433/mcp", "service_url_internal_host"],
      ["https://localhost/mcp", "service_url_internal_host"],
      ["https://metadata.google.internal/computeMetadata/v1/", "service_url_internal_host"],
      ["https://box.local/mcp", "service_url_internal_host"],
      ["https://sandbox/mcp", "service_url_internal_host"],
      ["https://sandbox.acme-dev.example:8443/mcp", "service_url_port"],
      ["https://u:p@sandbox.acme-dev.example/mcp", "service_url_userinfo"],
      ["https://sandbox.acme-dev.example/mcp?x=1", "service_url_not_canonical"],
      ["https://sandbox.acme-dev.example", "service_url_not_canonical"],
      ["https://Sandbox.acme-dev.example/mcp", "service_url_not_canonical"],
      ["https://agents.edgecity.live/api/v1/village-bridge/tool", "service_is_an_agent_village_host"],
      ["https://edgecity.live/", "service_is_an_agent_village_host"],
      ["https://control-plane-production-606c.up.railway.app/", "service_is_an_agent_village_host"],
      // review-b N1 on ov#438: EdgeOS, the old Esmeralda cp and the app's Railway domain.
      ["https://api.edgeos.world/", "service_is_an_agent_village_host"],
      ["https://edgecity.edgeos.world/mcp", "service_is_an_agent_village_host"],
      ["https://edgeos.world/", "service_is_an_agent_village_host"],
      ["https://control-plane-production-b752.up.railway.app/", "service_is_an_agent_village_host"],
      ["https://agentvillage-app-production.up.railway.app/api/v1/village-bridge/tool", "service_is_an_agent_village_host"],
    ];
    for (const [url, reason] of refused) {
      let got = "";
      try { serviceTarget(url, validator); } catch (e) { got = (e as Refusal).reason; }
      expect([url, got]).toEqual([url, reason]);
    }
    expect(serviceTarget(SERVICE, validator)).toEqual({ url: SERVICE, host: "sandbox.acme-dev.example", basePath: "/mcp" });
    expect(serviceTarget("https://my-app.up.railway.app/", validator).host).toBe("my-app.up.railway.app");
    for (const ok of ["https://edgecity.live.attacker.example/", "https://edgeos.world.attacker.example/", "https://notedgeos.world/", "https://zzz.bot/mcp"]) {
      expect([ok, serviceTarget(ok, validator).url]).toEqual([ok, ok]);
    }
    expect([...OUR_HOSTS].sort()).toEqual(["agentvillage-app-production.up.railway.app", "control-plane-production-606c.up.railway.app",
      "control-plane-production-b752.up.railway.app", "edgecity.live", "edgeos.world"]);
    await withStub(mcpServer(), async s => {
      const c = v1Catalog("mcp");
      try {
        writeFileSync(c.out, staleReport());
        for (const [url, reason] of refused.slice(0, 6)) {
          const warned: string[] = [];
          const code = await mainAsync([c.path, "--fixtures", c.fixtures, "--service", url, "--out", c.out], { cwd: c.root, service: s.deps, print: () => {}, warn: x => warned.push(x) });
          // An argument refusal: exit 2 and the file at --out untouched.
          expect([url, code, warned.join("").includes(`refused: ${reason}`), readFileSync(c.out, "utf8")]).toEqual([url, 2, true, staleReport()]);
        }
      } finally { cleanup(c); }
      expect([s.resolves.length, s.dials.length, s.connections()]).toEqual([0, 0, 0]);
    });
  });

  test("rule 2: a name resolving to a private, loopback, link-local, metadata or special-purpose address is refused WITHOUT connecting (mocked resolver; the stub on 127.0.0.1 gets no connection)", async () => {
    const internal: [string, string][] = [
      ["127.0.0.1", "service_address_internal"],
      ["10.1.2.3", "service_address_internal"],
      ["172.16.9.9", "service_address_internal"],
      ["192.168.1.10", "service_address_internal"],
      ["100.64.0.1", "service_address_internal"],
      ["0.0.0.0", "service_address_internal"],
      ["169.254.10.10", "service_address_internal"],
      ["169.254.169.254", "service_address_metadata"],
      ["169.254.170.2", "service_address_metadata"],
      ["100.100.100.200", "service_address_metadata"],
      ["192.0.0.192", "service_address_metadata"],
      ["fd00:ec2::254", "service_address_metadata"],
      ["::1", "service_address_internal"],
      ["::", "service_address_internal"],
      ["fe80::1", "service_address_internal"],
      ["fe80::1%en0", "service_address_unparseable_or_scoped"],
      ["fc00::5", "service_address_internal"],
      ["::ffff:127.0.0.1", "service_address_internal"],
      ["::ffff:169.254.169.254", "service_address_metadata"],
      ["64:ff9b::a9fe:a9fe", "service_address_internal"],
      ["2002:a9fe:a9fe::1", "service_address_special_purpose"],
      ["2001:0:4136:e378::1", "service_address_special_purpose"],
      ["192.0.2.7", "service_address_special_purpose"],
      ["224.0.0.1", "service_address_internal"],
      ["not-an-ip", "service_address_unparseable_or_scoped"],
    ];
    for (const [address, reason] of internal) {
      await withStub(mcpServer(), async s => {
        // This dialer WOULD reach the live stub on 127.0.0.1 if the guard let it through.
        s.deps.dial = to => { s.dials.push(to); return netConnect(s.port, "127.0.0.1"); };
        const c = v1Catalog("mcp");
        try {
          writeFileSync(c.out, staleReport());
          expect([address, await refusalOf(runV1(c, s))]).toEqual([address, reason]);
          const warned: string[] = [];
          const code = await mainAsync([c.path, "--fixtures", c.fixtures, "--service", SERVICE, "--out", c.out], { cwd: c.root, service: s.deps, print: () => {}, warn: x => warned.push(x) });
          // A run refusal: exit 2, our own stale report removed, nothing written.
          expect([address, code, warned.join("").includes(reason), existsSync(c.out)]).toEqual([address, 2, true, false]);
        } finally { cleanup(c); }
        await new Promise(r => setTimeout(r, 20));
        expect([address, s.resolves.length, s.dials.length, s.connections(), s.seen.length]).toEqual([address, 2, 0, 0, 0]);
      }, () => [{ address, family: address.includes(":") ? 6 : 4 }]);
    }
  });

  test("rule 2: ANY refused answer refuses the name (a public and a private answer together); an empty or failed resolution fails reachability, no connection", async () => {
    await withStub(mcpServer(), async s => {
      const c = v1Catalog("mcp");
      try { expect(await refusalOf(runV1(c, s))).toBe("service_address_internal"); } finally { cleanup(c); }
      expect([s.dials.length, s.connections()]).toEqual([0, 0]);
    }, () => [{ address: PUBLIC, family: 4 }, { address: "10.0.0.8", family: 4 }]);
    for (const resolveTo of [() => [], () => { throw new Error("ENOTFOUND"); }]) {
      await withStub(mcpServer(), async s => {
        const c = v1Catalog("mcp");
        try {
          const r = await runV1(c, s);
          invariants(r);
          expect(v1Rows(r)).toEqual({ "service.reachability": false, "service.budgets": null, "service.error_bodies": null, "approval.fake_cp": null });
          expect(row(r, "service.reachability").note).toBe("advisory (v1): sandbox.acme-dev.example does not resolve");
        } finally { cleanup(c); }
        expect([s.dials.length, s.connections()]).toEqual([0, 0]);
      }, resolveTo as any);
    }
  });

  test("rule 2: DNS rebinding: the name is resolved once, and every connection of the run goes to that one checked address", async () => {
    await withStub(mcpServer(), async s => {
      const c = v1Catalog("mcp");
      try {
        const r = await runV1(c, s);
        expect(v1Rows(r)).toEqual({ "service.reachability": true, "service.budgets": true, "service.error_bodies": true, "approval.fake_cp": null });
      } finally { cleanup(c); }
      expect(s.resolves).toEqual(["sandbox.acme-dev.example"]);
      expect(s.dials.length).toBeGreaterThanOrEqual(6);
      expect(s.dials.every(d => d.address === PUBLIC && d.host === "sandbox.acme-dev.example" && d.port === 443)).toBe(true);
    }, n => n === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
  });

  test("rule 3: no redirect is ever followed, to another host or the same one; its body is not read", async () => {
    for (const [location, where] of [["https://evil.example/mcp", "another host"], ["https://sandbox.acme-dev.example/v2/mcp", "the same host"], ["/elsewhere", "the same host"]]) {
      // The redirect's body is never read: here it declares more than any cap, and the answer is still the redirect.
      await withStub(mcpServer({ init: res => { res.socket?.end(`HTTP/1.1 302 Found\r\nlocation: ${location}\r\ncontent-length: 300000\r\n\r\nhello`); return true; } }), async s => {
        const c = v1Catalog("mcp");
        try {
          const r = await runV1(c, s);
          expect(v1Rows(r)).toEqual({ "service.reachability": false, "service.budgets": null, "service.error_bodies": null, "approval.fake_cp": null });
          expect(row(r, "service.reachability").note).toContain(`initialize: a 302 redirect to ${where}, never followed`);
        } finally { cleanup(c); }
        expect([location, s.dials.length, s.seen.map(x => x.url)]).toEqual([location, 1, ["/mcp"]]);
      });
    }
    // https-json: a read op path that redirects fails reachability and its call; nothing else is fetched.
    await withStub((req, res) => { res.writeHead(307, { location: "https://evil.example/x", "content-length": "0" }); res.end(); }, async s => {
      const c = v1Catalog("https-json");
      try {
        const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
        expect(row(r, "service.reachability").pass).toBe(false);
        expect(row(r, "service.budgets").note).toContain("a 307 redirect to another host, never followed");
      } finally { cleanup(c); }
      expect(s.seen.map(x => x.url)).toEqual(["/api/lookup", "/api/lookup"]);
    });
  });

  test("rule 4: a read op's call is cut off at its timeoutMs and its maxResponseBytes (declared, chunked or close-delimited)", async () => {
    const slow = acme();
    slow.operations[0].timeoutMs = 300;
    await withStub(mcpServer({ lookup: (args, res, id) => { setTimeout(() => json(res, 200, { jsonrpc: "2.0", id, result: {} }), 4000); } }), async s => {
      const c = v1Catalog("mcp", slow);
      try {
        const started = Date.now();
        const r = await runV1(c, s);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(row(r, "service.budgets").pass).toBe(false);
        expect(row(r, "service.budgets").note).toContain("acme.lookup/ok.request.json: no complete answer within 300 ms");
      } finally { cleanup(c); }
    });
    const big = "x".repeat(5000); // maxResponseBytes of acme.lookup is 4096
    const shapes: [string, (res: ServerResponse, id: number) => void, string][] = [
      // A declared length over the cap is refused from the header, before any body byte is read (here the body is cut short).
      ["content-length", (res, id) => { res.socket?.end("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 5000\r\n\r\n{"); }, "content-length 5000 is over maxResponseBytes 4096"],
      ["chunked", (res, id) => { res.writeHead(200, { "content-type": "application/json" }); res.write(JSON.stringify({ jsonrpc: "2.0", id, result: { big } }).slice(0, 3000)); setTimeout(() => res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { big } }).slice(3000)), 20); }, "the body is over maxResponseBytes 4096"],
      ["sse", (res, id) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { big } })}\n\n`); }, "the body is over maxResponseBytes 4096"],
    ];
    for (const [name, answer, want] of shapes) {
      await withStub(mcpServer({ lookup: (args, res, id) => answer(res, id) }), async s => {
        const c = v1Catalog("mcp");
        try {
          const r = await runV1(c, s);
          expect([name, row(r, "service.budgets").pass, row(r, "service.budgets").note.includes(want)]).toEqual([name, false, true]);
        } finally { cleanup(c); }
      });
    }
    // https-json: a close-delimited body (no content-length, no chunking) over the cap.
    await withStub((req, res) => { res.socket?.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ items: [], big })}`); res.socket?.end(); }, async s => {
      const c = v1Catalog("https-json");
      try {
        const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
        expect(row(r, "service.budgets").note).toContain("acme.lookup/ok.request.json: the body is over maxResponseBytes 4096");
      } finally { cleanup(c); }
    });
  });

  test("rule 3: the default dial is TLS verified for the name: a certificate the system does not trust is refused, and nothing is read", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "conformance-tls-")));
    try {
      const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
        "-days", "2", "-subj", "/CN=sandbox.acme-dev.example", "-addext", "subjectAltName=DNS:sandbox.acme-dev.example"], { encoding: "utf8" });
      if (made.status !== 0) { console.log("openssl unavailable: TLS dial test skipped"); return; }
      let handshakes = 0, bytes = 0;
      const server = createTlsServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, sock => { handshakes++; sock.on("data", (d: Buffer) => { bytes += d.length; }); });
      await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as AddressInfo).port;
      try {
        const c = v1Catalog("mcp");
        try {
          const deps: ServiceDeps = { resolve: async () => [{ address: PUBLIC, family: 4 }], dial: to => tlsDial({ ...to, address: "127.0.0.1", port }) };
          const r = await runConformanceAsync({ manifest: c.path, fixtures: c.fixtures, service: SERVICE }, { cwd: c.root, service: deps });
          expect(row(r, "service.reachability").pass).toBe(false);
          expect(row(r, "service.reachability").note).toMatch(/initialize: could not connect or read \((?:DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\)/);
        } finally { cleanup(c); }
        expect([handshakes, bytes]).toEqual([0, 0]);
      } finally { server.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("rule 5: no credential is ever sent: a fixed header list, no Authorization or Cookie (a Set-Cookie is not kept), nothing from the environment", async () => {
    const saved = { ...process.env };
    process.env.AUTHORIZATION = "Bearer " + "A1b2".repeat(8);
    process.env.MINI_APP_ACME_TOKEN = "tok-" + "A1b2".repeat(8);
    try {
      await withStub(mcpServer(), async s => {
        const c = v1Catalog("mcp");
        try { expect((await runV1(c, s)).passed).toBe(true); } finally { cleanup(c); }
        const allowed = ["host", "user-agent", "accept", "accept-encoding", "connection", "content-type", "content-length", "mcp-protocol-version", "mcp-session-id"];
        expect(s.seen.length).toBeGreaterThanOrEqual(6);
        for (const req of s.seen) {
          expect(req.names.filter(n => !allowed.includes(n))).toEqual([]);
          expect(JSON.stringify(req)).not.toContain("A1b2A1b2");
        }
        // The server-issued session id is echoed after initialize; the cookie is not.
        expect(s.seen.slice(1).every(r => r.headers["mcp-session-id"] === "sess-123" && r.headers["mcp-protocol-version"] === "2025-06-18")).toBe(true);
      });
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("v1 checks against a stub sandbox", () => {
  test("mcp, auth none: initialize 2025-06-18, tools/list (two pages) holds every target.tool, read calls fixture-shaped, error body closed; prepare and needs-card never called", async () => {
    for (const sse of [false, true]) {
      await withStub(mcpServer({ sse }), async s => {
        const c = v1Catalog("mcp");
        try {
          const r = await runV1(c, s);
          invariants(r);
          expect([sse, v1Rows(r)]).toEqual([sse, { "service.reachability": true, "service.budgets": true, "service.error_bodies": true, "approval.fake_cp": null }]);
          expect(row(r, "service.reachability").note).toContain("initialize answers 2025-06-18; tools/list holds every target.tool (3 tool(s))");
          expect(row(r, "service.budgets").note).toStartWith("advisory (v1): 1 read call(s) answered within timeoutMs and maxResponseBytes");
          expect(row(r, "service.error_bodies").note).toStartWith("advisory (v1): 1 error call(s) answered like their fixture: exactly {code, detail} with its closed code");
          expect(row(r, "approval.fake_cp").note).toContain("Not checkable without a card");
          expect(r.passed).toBe(true);
        } finally { cleanup(c); }
        const methods = s.seen.map(x => JSON.parse(x.body || "{}")).map(m => m.method === "tools/call" ? `tools/call ${m.params.name}` : m.method);
        expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call lookup", "tools/call lookup"]);
      });
    }
  });

  test("https-json, auth none: each read op path answers 2xx or a documented 4xx; only the read path is ever requested", async () => {
    await withStub((req, res) => {
      const args = JSON.parse(req.body || "{}");
      if (args.q === "missing") return json(res, 404, { code: "not_found", detail: "No such item." });
      json(res, 200, { items: [{ name: "a", rank: 1 }], asOf: "2026-10-20", extra: [1, 2] });
    }, async s => {
      const c = v1Catalog("https-json");
      try {
        const r = await runV1(c, s, "https://sandbox.acme-dev.example/v1/");
        invariants(r);
        expect(v1Rows(r)).toEqual({ "service.reachability": true, "service.budgets": true, "service.error_bodies": true, "approval.fake_cp": null });
        expect(row(r, "service.reachability").note).toContain("write, prepare and needs-card paths are never called");
      } finally { cleanup(c); }
      expect(s.seen.map(x => `${x.method} ${x.url} ${x.body}`)).toEqual([
        "POST /v1/api/lookup {\"q\":\"missing\"}", "POST /v1/api/lookup {\"q\":\"things\"}"]);
    });
  });

  test("fixture shape: a missing key, a wrong type or a wrong element shape fails service.budgets with its pointer; extra keys are fine", async () => {
    const answers: [unknown, string][] = [
      [{ items: [{ name: "a", rank: 1 }] }, "acme.lookup/ok.request.json: /asOf is missing"],
      [{ items: { name: "a" }, asOf: "x" }, "/items is object, the fixture has array"],
      [{ items: [{ name: "a", rank: "1" }], asOf: "x" }, "/items/0/rank is string, the fixture has number"],
      [[1, 2], "/ is array, the fixture has object"],
    ];
    for (const [body, want] of answers) {
      await withStub((req, res) => json(res, JSON.parse(req.body).q === "missing" ? 404 : 200, JSON.parse(req.body).q === "missing" ? { code: "not_found", detail: "x" } : body), async s => {
        const c = v1Catalog("https-json");
        try {
          const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
          expect([want, row(r, "service.budgets").pass, row(r, "service.budgets").note.includes(want)]).toEqual([want, false, true]);
          // Advisory: the failed v1 row is reported, and the run still passes on its required set.
          expect(r.passed).toBe(true);
        } finally { cleanup(c); }
      });
    }
    expect(shapeProblems({ a: null, b: [{ c: 1 }] }, { a: "anything", b: [], z: 1 })).toEqual([]);
  });

  test("live error bodies: an extra key, an open code, another code than the fixture's, a 5xx, a 2xx, or (mcp) a JSON-RPC error where the fixture says a code each fail service.error_bodies", async () => {
    const bad: [number, unknown, string][] = [
      [404, { code: "not_found", detail: "x", trace: "y" }, "keys are code, detail, trace, not exactly code, detail"],
      [400, { code: "boom", detail: "x" }, "code boom is not in the closed set for acme"],
      [409, { code: "conflict", detail: "x" }, "code conflict, the fixture says not_found"],
      [503, { code: "unavailable", detail: "x" }, "HTTP 503, the fixture is an error body (a documented 4xx)"],
      [200, { items: [] }, "HTTP 200, the fixture is an error body"],
      [404, { code: "not_found", detail: "Contact sk-" + "A1b2".repeat(6) }, "the answer holds a secret pattern at /detail (sk_key)"],
    ];
    for (const [status, body, want] of bad) {
      await withStub((req, res) => JSON.parse(req.body).q === "missing" ? json(res, status, body) : json(res, 200, { items: [{ name: "a", rank: 1 }], asOf: "x" }), async s => {
        const c = v1Catalog("https-json");
        try {
          const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
          expect([want, row(r, "service.error_bodies").pass, row(r, "service.error_bodies").note.includes(want)]).toEqual([want, false, true]);
          expect(JSON.stringify(r)).not.toContain("A1b2A1b2");
        } finally { cleanup(c); }
      });
    }
    await withStub(mcpServer({ lookup: (args, res, id) => args.q === "missing"
      ? json(res, 200, { jsonrpc: "2.0", id, error: { code: -32000, message: "nope" } })
      : json(res, 200, { jsonrpc: "2.0", id, result: { content: [], structuredContent: { items: [] } } }) }), async s => {
      const c = v1Catalog("mcp");
      try {
        const r = await runV1(c, s);
        // A JSON-RPC error is a conforming MCP error answer, but not where the fixture says a closed code.
        expect(row(r, "service.error_bodies").note).toContain("a JSON-RPC error -32000, the fixture says code not_found");
      } finally { cleanup(c); }
    });
  });

  test("reachability (mcp): a wrong protocol, a missing tool, or a manifest looser than the tool's inputSchema fails", async () => {
    await withStub(mcpServer({ init: res => { json(res, 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }); return true; } }), async s => {
      const c = v1Catalog("mcp");
      try { expect(row(await runV1(c, s), "service.reachability").note).toContain("initialize answers protocol 2024-11-05, not 2025-06-18"); } finally { cleanup(c); }
    });
    const missing = acme();
    missing.operations[1].target = { tool: "quote_v2" };
    await withStub(mcpServer(), async s => {
      const c = v1Catalog("mcp", missing);
      try {
        const r = await runV1(c, s);
        expect(row(r, "service.reachability").note).toContain("acme.order.prepare: tool quote_v2 is not in tools/list");
        // Listing is safe; calling a prepare is not: still only lookup is called.
        expect(s.seen.map(x => JSON.parse(x.body || "{}")).filter(m => m.method === "tools/call").map(m => m.params.name)).toEqual(["lookup", "lookup"]);
      } finally { cleanup(c); }
    });
    expect(inputCompatibility({ type: "object", properties: { q: { type: "string" } } }, { type: "object", properties: { q: { type: "string" }, n: { type: "integer" } }, required: ["n"] }))
      .toEqual(["the tool requires n, the manifest does not"]);
    expect(inputCompatibility({ type: "object", properties: { q: { type: "string" }, z: {} } }, { type: "object", properties: { q: { type: "integer" } }, additionalProperties: false }))
      .toEqual(["q is \"string\" here, \"integer\" in the tool", "the manifest allows z, the tool does not"]);
    expect(inputCompatibility({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] }, { type: "object", properties: { n: { type: "number" } }, required: ["n"] })).toEqual([]);
  });

  test("oauth / app-token: only the refusal without a token is checked (401; 401 or 403); budgets and error bodies are not_run; discovery is fetched only on the --service host", async () => {
    const oauth = (discovery: string) => { const m = acme(); m.service.auth = { mode: "oauth", oauth: { resource: "https://acme.example/mcp", scopes: ["acme:read"], discovery } }; return m; };
    await withStub((req, res) => req.url === "/.well-known/oauth-authorization-server" ? json(res, 200, { issuer: "https://sandbox.acme-dev.example" }) : json(res, 401, { error: "unauthorized" }), async s => {
      const c = v1Catalog("mcp", oauth("https://sandbox.acme-dev.example/.well-known/oauth-authorization-server"));
      try {
        const r = await runV1(c, s);
        expect(v1Rows(r)).toEqual({ "service.reachability": true, "service.budgets": null, "service.error_bodies": null, "approval.fake_cp": null });
        expect(row(r, "service.reachability").note).toContain("refuses a call without a token (HTTP 401); oauth discovery answers 200 with a JSON object");
        expect(row(r, "service.budgets").note).toBe("advisory (v1): auth oauth: a read needs a credential, and conformance never sends one");
      } finally { cleanup(c); }
      expect(s.seen.map(x => `${x.method} ${x.url}`)).toEqual(["POST /mcp", "GET /.well-known/oauth-authorization-server"]);
      expect(s.seen.every(x => !x.names.includes("authorization") && !x.names.includes("cookie"))).toBe(true);
    });
    await withStub((req, res) => json(res, 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), async s => {
      const c = v1Catalog("mcp", oauth("https://auth.acme.example/.well-known/oauth-authorization-server"));
      try {
        const r = await runV1(c, s);
        expect(row(r, "service.reachability").pass).toBe(false);
        expect(row(r, "service.reachability").note).toContain("without a token it answers HTTP 200, not 401 (auth oauth)");
        expect(row(r, "service.reachability").note).toContain("oauth discovery is on auth.acme.example, not the --service host: not fetched");
      } finally { cleanup(c); }
      expect(s.seen.length).toBe(1);
    });
    const token = httpsJsonAcme(m => { m.service.auth = { mode: "app-token", secretRef: "MINI_APP_ACME_TOKEN" }; });
    await withStub((req, res) => json(res, 403, { code: "not_authorized", detail: "x" }), async s => {
      const c = v1Catalog("https-json", token);
      try {
        const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
        expect(v1Rows(r)).toEqual({ "service.reachability": true, "service.budgets": null, "service.error_bodies": null, "approval.fake_cp": null });
      } finally { cleanup(c); }
      expect(s.seen.map(x => x.url)).toEqual(["/api/lookup"]);
      expect(s.seen[0].names.includes("authorization")).toBe(false);
    });
  });

  test("what is never called: no request fixture, a GET with arguments, a read op declared PUT/DELETE; internal and invalid manifests resolve nothing", async () => {
    await withStub(mcpServer(), async s => {
      const c = catalog({ fixtures: GOOD_FIXTURES }); // no .request.json at all
      try {
        const r = await runV1(c, s);
        expect(v1Rows(r)).toEqual({ "service.reachability": true, "service.budgets": null, "service.error_bodies": null, "approval.fake_cp": null });
        expect(row(r, "service.budgets").note).toContain("acme.lookup: no <name>.request.json");
        expect(r.passed).toBe(true); // v1 not run never blocks
      } finally { cleanup(c); }
    });
    for (const [method, body, want] of [["GET", "{\"q\":\"things\"}", "a GET op takes no arguments yet"], ["PUT", "{}", "a read op with method PUT is never called"], ["DELETE", "{}", "a read op with method DELETE is never called"]]) {
      await withStub((req, res) => json(res, 200, { items: [], asOf: "x" }), async s => {
        const c = v1Catalog("https-json", httpsJsonAcme(m => { m.operations[0].target.method = method; }), files => {
          files["acme.lookup/ok.request.json"] = body;
          delete files["acme.lookup/error-not-found.request.json"];
        });
        try {
          const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
          expect([method, row(r, "service.budgets").pass, row(r, "service.budgets").note.includes(want)]).toEqual([method, null, true]);
        } finally { cleanup(c); }
        expect([method, s.seen.length]).toEqual([method, 0]);
      });
    }
    // A GET read op with {} is called, with no body.
    await withStub((req, res) => json(res, 200, { items: [{ name: "a", rank: 1 }], asOf: "x" }), async s => {
      const c = v1Catalog("https-json", httpsJsonAcme(m => { m.operations[0].target.method = "GET"; }), files => {
        files["acme.lookup/ok.request.json"] = "{}";
        delete files["acme.lookup/error-not-found.request.json"];
      });
      try { expect(row(await runV1(c, s, "https://sandbox.acme-dev.example/"), "service.budgets").pass).toBe(true); } finally { cleanup(c); }
      expect(s.seen.map(x => `${x.method} ${x.url} ${x.body}`)).toEqual(["GET /api/lookup "]);
    });
    await withStub(mcpServer(), async s => {
      const gold = runConformanceAsync({ manifest: "mini-apps/gold-stars/manifest.json", service: SERVICE }, { cwd: REPO, service: s.deps });
      const r = await gold;
      expect(row(r, "service.reachability").note).toContain("service.kind internal");
      const c = catalog({ manifest: { ...acme(), extra: 1 }, fixtures: GOOD_FIXTURES });
      try { expect(row(await runV1(c, s), "service.budgets").note).toBe("advisory (v1): the manifest is not a valid v2 manifest: no service is called"); } finally { cleanup(c); }
      expect([s.resolves.length, s.dials.length]).toEqual([0, 0]);
    });
  });

  test("the reader: a malformed status line, an informational answer, a compressed body, two content-lengths, a cut-off body each fail", async () => {
    const raw: [string, string][] = [
      ["HTTX/1.1 200 OK\r\n\r\n", "not an HTTP/1.1 answer"],
      ["HTTP/1.1 103 Early Hints\r\n\r\n", "an informational 103 answer"],
      ["HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: 2\r\n\r\n{}", "a compressed body (content-encoding gzip)"],
      ["HTTP/1.1 200 OK\r\ncontent-length: 2\r\ncontent-length: 3\r\n\r\n{}", "two different content-length headers"],
      ["HTTP/1.1 200 OK\r\ncontent-length: 50\r\n\r\n{\"a\":", "the connection closed in the middle of the body"],
      ["HTTP/1.1 200 OK\r\nx: " + "y".repeat(17000) + "\r\n\r\n", "response headers over 16384 bytes"],
      ["HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n", "a malformed chunked body"],
    ];
    for (const [answer, want] of raw) {
      await withStub((req, res) => { res.socket?.end(answer); }, async s => {
        const c = v1Catalog("https-json");
        try {
          const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
          expect([want, row(r, "service.budgets").note.includes(want) || row(r, "service.error_bodies").note.includes(want)]).toEqual([want, true]);
        } finally { cleanup(c); }
      });
    }
  });

  test("the request cap: at most MAX_SERVICE_REQUESTS requests in one run", async () => {
    await withStub((req, res) => json(res, 200, { items: [{ name: "a", rank: 1 }], asOf: "x" }), async s => {
      const c = v1Catalog("https-json", httpsJsonAcme(), files => {
        delete files["acme.lookup/error-not-found.request.json"];
        for (let i = 0; i < MAX_SERVICE_REQUESTS + 5; i++) { files[`acme.lookup/r${String(i).padStart(3, "0")}.json`] = files["acme.lookup/ok.json"]; files[`acme.lookup/r${String(i).padStart(3, "0")}.request.json`] = "{}"; }
      });
      try {
        const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
        expect(row(r, "service.budgets").note).toContain(`over the suite's ${MAX_SERVICE_REQUESTS}-request cap`);
      } finally { cleanup(c); }
      expect(s.seen.length).toBe(MAX_SERVICE_REQUESTS);
    });
  });

  test("a real process: bun <script> --service with a refused URL exits 2 with no network (the CLI entry is mainAsync)", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      for (const url of ["https://127.0.0.1/", "https://localhost/mcp", "http://sandbox.acme-dev.example/"]) {
        const p = spawnSync("bun", [SCRIPT, c.path, "--fixtures", c.fixtures, "--service", url], { cwd: c.root, encoding: "utf8", timeout: 30000 });
        expect([url, p.status, p.stderr.includes("refused: service_url_")]).toEqual([url, 2, true]);
      }
      expect(parseArgs([c.path, "--service", SERVICE]).service).toBe(SERVICE);
      for (const bad of [[c.path, "--service"], [c.path, "--service", SERVICE, "--service", SERVICE], [c.path, "--service", "--out"]]) expect(() => parseArgs(bad)).toThrow(Refusal);
    });
  });
});

describe("v1 fixtures: <name>.request.json", () => {
  test("a request is strict JSON, secret-scanned, an object, beside its response, for a read op, under maxRequestBytes; it is never an error or success body", () => {
    const ok = { ...GOOD_FIXTURES, "acme.lookup/ok.request.json": "{\"q\":\"x\"}", "acme.lookup/error-not-found.request.json": "{\"q\":\"y\"}" };
    withCatalog({ fixtures: ok }, c => {
      const r = run(c);
      expect(row(r, "hygiene.fixtures")).toEqual({ check: "hygiene.fixtures", pass: true, note: "2 fixture file(s), 1 error bod(ies), 2 request(s)" });
      expect(row(r, "hygiene.error_bodies").pass).toBe(true); // error-not-found.request.json is not an error body
      expect(r.passed).toBe(true);
    });
    const bad: [Record<string, string>, string, string][] = [
      [{ "acme.order.prepare/ok.json": "{}", "acme.order.prepare/ok.request.json": "{}" }, "hygiene.fixtures", "acme.order.prepare/ok.request.json: a request is sent only for a read operation (acme.order.prepare is prepare)"],
      [{ "acme.lookup/lone.request.json": "{}" }, "hygiene.fixtures", "acme.lookup/lone.request.json: a request needs its response fixture lone.json beside it"],
      [{ "acme.lookup/ok.request.json": "[1]" }, "hygiene.fixtures", "acme.lookup/ok.request.json: a request is a JSON object of the op's arguments"],
      [{ "acme.lookup/ok.request.json": JSON.stringify({ q: "x".repeat(5000) }) }, "hygiene.fixtures", "is over acme.lookup's maxRequestBytes 4096 (the bridge refuses it)"],
      [{ "acme.lookup/ok.request.json": "{\"q\":1,\"q\":2}" }, "hygiene.duplicate_keys", "acme.lookup/ok.request.json: duplicate key /q"],
      [{ "acme.lookup/ok.request.json": JSON.stringify({ token: "abc" }) }, "hygiene.secrets", "acme.lookup/ok.request.json /token (secret_key_name)"],
    ];
    for (const [extra, check, want] of bad) {
      withCatalog({ fixtures: { ...GOOD_FIXTURES, ...extra } }, c => {
        const r = run(c);
        expect([want, row(r, check).pass, row(r, check).note.includes(want)]).toEqual([want, false, true]);
      });
    }
  });
});

describe("P0-5 follow-ups (review-b's fold-2 delta read on ov#422)", () => {
  test("N-a: from a git worktree, --out into the primary checkout (any file, its .git/hooks) is refused; outside it is fine", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "conformance-wt-")));
    try {
      const primary = join(top, "P"), worktree = join(top, "R");
      mkdirSync(join(primary, "scripts"), { recursive: true });
      writeFileSync(join(primary, "scripts", "keep.txt"), "x\n");
      g(top, "init", "-q", primary);
      g(primary, "add", "-A");
      g(primary, "commit", "-q", "-m", "p");
      g(primary, "worktree", "add", "-q", "-b", "w", worktree);
      const c = catalog({ fixtures: GOOD_FIXTURES });
      try {
        // The catalog sits inside the worktree R.
        const manifestDir = join(worktree, "mini-apps", "acme");
        mkdirSync(manifestDir, { recursive: true });
        mkdirSync(join(worktree, "skills", "acme"), { recursive: true });
        copyFileSync(c.path, join(manifestDir, "manifest.json"));
        copyFileSync(join(c.root, "skills", "acme", "SKILL.md"), join(worktree, "skills", "acme", "SKILL.md"));
        const manifest = join(manifestDir, "manifest.json");
        for (const arg of [join(primary, "scripts", "new.json"), join(primary, ".git", "hooks", "pre-push"), join(primary, "c.json"), join(worktree, "c.json")]) {
          const warned: string[] = [];
          expect([arg, main([manifest, "--fixtures", c.fixtures, "--out", arg], { cwd: worktree, print: () => {}, warn: s => warned.push(s) }),
            warned.join("").includes("refused: out_inside_the_repo_or_the_tool_root"), existsSync(arg)]).toEqual([arg, 2, true, false]);
        }
        expect(main([manifest, "--fixtures", c.fixtures, "--out", c.out], { cwd: worktree, print: () => {}, warn: () => {} })).toBe(0);
        expect(existsSync(c.out)).toBe(true);
      } finally { cleanup(c); }
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  test("N-b: an empty pre-created --out (mktemp) is accepted and replaced; a non-empty foreign file is still refused", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      writeFileSync(c.out, "");
      expect(main([c.path, "--fixtures", c.fixtures, "--out", c.out], { cwd: c.root, print: () => {}, warn: () => {} })).toBe(0);
      expect(JSON.parse(readFileSync(c.out, "utf8")).passed).toBe(true);
      writeFileSync(c.out, " ");
      expect(main([c.path, "--fixtures", c.fixtures, "--out", c.out], { cwd: c.root, print: () => {}, warn: () => {} })).toBe(2);
      expect(readFileSync(c.out, "utf8")).toBe(" ");
    });
  });

  test("N-c: the colon form (password: hunter2..., \"password\": \"...\") is found and redacted; prose is not", () => {
    for (const text of ["pass" + "word: hunter2", "Pass" + "word: hunter2!", "\"pass" + "word\": \"hunter 2\"", "pass" + "wd: P@ssw0rd", "pass" + "phrase: correct-horse-9", "{\"pass" + "word\":\"abcdefgh\"}"]) {
      expect([text, secretPattern(text)]).toEqual([text, "password_colon"]);
      expect([text, redact(`a ${text} b`).includes("hunter") || redact(`a ${text} b`).includes("ssw0") || redact(`a ${text} b`).includes("horse") || redact(`a ${text} b`).includes("abcdefgh")]).toEqual([text, false]);
    }
    for (const text of ["Password: reset it via the link", "Password: required", "password: 8", "Your password: must be long", "Password: \"set it later\"", "password: 'two words'"]) {
      expect([text, secretPattern(text)]).toEqual([text, null]);
    }
    for (const s of ["pass" + "word:".repeat(150000), "pass" + "word: " + "a1".repeat(500000), "\"pass" + "word\":\"".repeat(80000)]) {
      const t = Date.now();
      secretPattern(s); redact(s);
      expect(Date.now() - t).toBeLessThan(2000);
    }
  });

  test("N-d: ownReport is exact: a non-hex sha256, an entry not shaped {check, pass, note}, or a file over 1 MiB is foreign (refused, left alone)", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const rel = "mini-apps/acme/manifest.json";
      const good = { manifest: rel, sha256: "0".repeat(64), results: [{ check: "x", pass: true, note: "" }], passed: true };
      const foreign: [string, string][] = [
        ["sha not hex", JSON.stringify({ ...good, sha256: "z".repeat(64) })],
        ["sha upper-case", JSON.stringify({ ...good, sha256: "A".repeat(64) })],
        ["an entry without note", JSON.stringify({ ...good, results: [{ check: "x", pass: true }] })],
        ["an entry with an extra key", JSON.stringify({ ...good, results: [{ check: "x", pass: true, note: "", more: 1 }] })],
        ["over 1 MiB", JSON.stringify({ ...good, results: [{ check: "x", pass: true, note: "n".repeat(1 << 20) }] })],
      ];
      expect(ownReport(join(c.outDir, "none.json"), rel)).toBe(false);
      writeFileSync(c.out, JSON.stringify(good));
      expect(ownReport(c.out, rel)).toBe(true);
      for (const [why, text] of foreign) {
        writeFileSync(c.out, text);
        expect([why, ownReport(c.out, rel)]).toEqual([why, false]);
        expect([why, main([c.path, "--fixtures", c.fixtures, "--out", c.out], { cwd: c.root, print: () => {}, warn: () => {} }), readFileSync(c.out, "utf8") === text]).toEqual([why, 2, true]);
      }
    });
  });
});

describe("fold 2 (review-b on ov#438): a hostile sandbox never crashes the run; a whole-run deadline", () => {
  const raw = (res: ServerResponse, text: string) => { res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }); res.end(text); };
  const hostile: [string, (req: Seen, res: ServerResponse) => void, string, string][] = [
    ["initialize protocolVersion {toString:1}", mcpServer({ init: res => { raw(res, '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":{"toString":1}}}'); return true; } }),
      "service.reachability", 'initialize answers protocol {"toString":1}, not 2025-06-18'],
    ["tools/list required [{toString:1}]", (req, res) => {
      const msg = JSON.parse(req.body || "{}");
      if (msg.method === "tools/list") return raw(res, `{"jsonrpc":"2.0","id":${msg.id},"result":{"tools":[{"name":"lookup","inputSchema":{"type":"object","required":[{"toString":1}]}},{"name":"quote","inputSchema":{}},{"name":"place","inputSchema":{}}]}}`);
      return mcpServer()(req, res);
    }, "service.reachability", 'the tool requires {"toString":1}, the manifest does not'],
    ["tools/list property type {toString:1}", (req, res) => {
      const msg = JSON.parse(req.body || "{}");
      if (msg.method === "tools/list") return raw(res, `{"jsonrpc":"2.0","id":${msg.id},"result":{"tools":[{"name":"lookup","inputSchema":{"type":"object","properties":{"q":{"type":{"toString":1}}}}},{"name":"quote","inputSchema":{}},{"name":"place","inputSchema":{}}]}}`);
      return mcpServer()(req, res);
    }, "service.reachability", 'q is "string" here, {"toString":1} in the tool'],
    ["error call code {toString:1}", mcpServer({ lookup: (args, res, id) => args.q === "missing"
      ? raw(res, `{"jsonrpc":"2.0","id":${id},"result":{"isError":true,"content":[],"structuredContent":{"code":{"toString":1},"detail":"x"}}}`)
      : raw(res, `{"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":"Two things."}],"structuredContent":{"items":[{"name":"a","rank":1}]}}}`) }),
      "service.error_bodies", 'code {"toString":1}, the fixture says not_found'],
    ["toString and valueOf both null (protocolVersion)", mcpServer({ init: res => { raw(res, '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":{"toString":null,"valueOf":null}}}'); return true; } }),
      "service.reachability", 'initialize answers protocol {"toString":null,"valueOf":null}'],
  ];
  for (const [name, handler, check, want] of hostile) {
    test(`S1 ${name}: exit 0, conformance.json written, passed as without --service; the value is described, never String()-ed`, async () => {
      await withStub(handler, async s => {
        const c = v1Catalog("mcp");
        try {
          const without = run(c);
          expect(without.passed).toBe(true);
          const warned: string[] = [];
          const code = await mainAsync([c.path, "--fixtures", c.fixtures, "--service", SERVICE, "--out", c.out], { cwd: c.root, service: s.deps, print: () => {}, warn: x => warned.push(x) });
          expect([name, code, warned]).toEqual([name, 0, []]);
          const report = JSON.parse(readFileSync(c.out, "utf8")) as Report;
          invariants(report);
          expect(report.passed).toBe(without.passed);
          expect([name, row(report, check).pass, row(report, check).note.includes(want)]).toEqual([name, false, true]);
        } finally { cleanup(c); }
      });
    });
  }
  test("S1 over https-json: an error body whose code is {toString:1} is a FAIL row, not a crash", async () => {
    await withStub((req, res) => JSON.parse(req.body).q === "missing" ? (res.writeHead(404, { "content-type": "application/json", "content-length": "36" }), res.end('{"code":{"toString":1},"detail":"x"}')) : json(res, 200, { items: [{ name: "a", rank: 1 }], asOf: "x" }), async s => {
      const c = v1Catalog("https-json");
      try {
        const code = await mainAsync([c.path, "--fixtures", c.fixtures, "--service", "https://sandbox.acme-dev.example/", "--out", c.out], { cwd: c.root, service: s.deps, print: () => {}, warn: () => {} });
        expect(code).toBe(0);
        const report = JSON.parse(readFileSync(c.out, "utf8")) as Report;
        expect(row(report, "service.error_bodies").pass).toBe(false);
        expect(row(report, "service.error_bodies").note).toContain("code (not a string) is not in the closed set for acme");
      } finally { cleanup(c); }
    });
  });
  test("S1 (a): any other throw inside the service checks is three advisory FAIL rows with a fixed note; a refusal still exits 2", async () => {
    await withStub(mcpServer(), async s => {
      s.deps.resolve = async () => [{ get address(): string { throw new TypeError("sandbox-chosen text " + "A1b2".repeat(8)); }, family: 4 }];
      const c = v1Catalog("mcp");
      try {
        const code = await mainAsync([c.path, "--fixtures", c.fixtures, "--service", SERVICE, "--out", c.out], { cwd: c.root, service: s.deps, print: () => {}, warn: () => {} });
        expect(code).toBe(0);
        const report = JSON.parse(readFileSync(c.out, "utf8")) as Report;
        expect(report.passed).toBe(true);
        for (const k of ADVISORY) expect([k, row(report, k)]).toEqual([k, { check: k, pass: false, note: "advisory (v1): internal error TypeError in the service checks; the other rows stand" }]);
        expect(readFileSync(c.out, "utf8")).not.toContain("A1b2A1b2");
        // A failing required row keeps its verdict: exit 1, not 2.
        writeFileSync(join(c.fixtures, "acme.lookup", "ok.json"), "{\"a\":1,\"a\":2}");
        expect(await mainAsync([c.path, "--fixtures", c.fixtures, "--service", SERVICE, "--out", c.out], { cwd: c.root, service: s.deps, print: () => {}, warn: () => {} })).toBe(1);
      } finally { cleanup(c); }
      expect(s.dials.length).toBe(0);
    });
    expect(describeValue({ toString: 1 })).toBe('{"toString":1}');
    expect(describeValue("x")).toBe("x");
    const cyclic: any = {}; cyclic.self = cyclic;
    expect([describeValue(cyclic), describeValue(undefined), describeValue(10n as any), describeValue("y".repeat(300))])
      .toEqual(["object", "undefined", "bigint", "y".repeat(300)]);
    expect(describeValue({ k: "z".repeat(300) }).length).toBe(120);
  });
  test("N3: past the whole-run deadline the unfinished rows are advisory \"not run (deadline)\"; a failure the deadline did not cause stays FAIL; requests stop", async () => {
    expect(SERVICE_DEADLINE_MS).toBe(600_000);
    await withStub((req, res) => {
      if (JSON.parse(req.body).q === "missing") return json(res, 500, { code: "unavailable", detail: "x" });
      setTimeout(() => json(res, 200, { items: [{ name: "a", rank: 1 }], asOf: "x" }), 300);
    }, async s => {
      s.deps.deadlineMs = 700;
      const c = v1Catalog("https-json", httpsJsonAcme(), files => {
        for (let i = 0; i < 8; i++) { files[`acme.lookup/r${i}.json`] = files["acme.lookup/ok.json"]; files[`acme.lookup/r${i}.request.json`] = "{}"; }
      });
      try {
        const started = Date.now();
        const r = await runV1(c, s, "https://sandbox.acme-dev.example/");
        expect(Date.now() - started).toBeLessThan(2500);
        invariants(r);
        expect(row(r, "service.budgets")).toEqual({ check: "service.budgets", pass: null, note: "advisory (v1): not run (deadline): the service checks stop after 700 ms in all, and this one was not finished" });
        // error-not-found sorts first and failed fast (a 500): those failures are real, so they stay FAIL.
        expect(row(r, "service.error_bodies").pass).toBe(false);
        expect(row(r, "service.reachability").pass).toBe(false);
        expect(row(r, "service.reachability").note).not.toContain("deadline");
        expect(r.passed).toBe(true);
      } finally { cleanup(c); }
      expect(s.seen.length).toBeLessThanOrEqual(4);
    });
  });
});

// MCP error envelopes (protocol 2025-06-18): a tool error is a result with isError: true and a content
// array; a protocol error is a JSON-RPC error {code: integer, message: string}. Both are a conforming answer
// to a tools/call, as an error fixture and live. Reported against conformance v0 (ov#422) on MCP apps whose
// fixtures carry the envelope the server returns; the repro below is reconstructed (no recorded CI run).
describe("MCP error envelopes: a well-formed one conforms, a malformed one does not", () => {
  const TOOL_TEXT = { isError: true, content: [{ type: "text", text: "Invalid arguments for lookup: q must be a string." }] };
  const TOOL_CODED = { isError: true, content: [{ type: "text", text: "No such item." }], structuredContent: { code: "not_found", detail: "No such item." } };
  const RPC_PARAMS = { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Invalid params: q must be a string" } };
  test("v0: an error fixture that is a tool error (bare or in its JSON-RPC response) or a JSON-RPC error passes hygiene.error_bodies", () => {
    const good: [string, unknown][] = [
      ["a bare isError result, plain text", TOOL_TEXT],
      ["a bare isError result carrying a closed {code, detail}", TOOL_CODED],
      ["an isError result in its JSON-RPC response", { jsonrpc: "2.0", id: 3, result: TOOL_TEXT }],
      ["a JSON-RPC error (-32602)", RPC_PARAMS],
      ["a JSON-RPC error with data and a string id", { jsonrpc: "2.0", id: "req-3", error: { code: -32000, message: "Server error", data: { retry: false } } }],
    ];
    for (const [why, body] of good) {
      withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/error-envelope.json": JSON.stringify(body) } }, c => {
        const r = run(c);
        expect([why, row(r, "hygiene.error_bodies").pass, row(r, "hygiene.error_bodies").note]).toEqual([why, true, expect.stringContaining("2 error bod(ies)")]);
        expect([why, r.passed]).toEqual([why, true]);
      });
    }
  });
  test("v0: a fixture not named error* that IS an MCP error answer (a tool-refusal.json with isError) counts as an error body", () => {
    withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/tool-refusal.json": JSON.stringify(TOOL_TEXT) } }, c => {
      const r = run(c);
      expect(row(r, "hygiene.fixtures").note).toBe("3 fixture file(s), 2 error bod(ies)");
      expect(row(r, "hygiene.error_bodies").pass).toBe(true);
    });
    withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/tool-refusal.json": JSON.stringify({ isError: true }) } }, c => {
      const r = row(run(c), "hygiene.error_bodies");
      expect([r.pass, r.note]).toEqual([false, expect.stringContaining("acme.lookup/tool-refusal.json: isError without a content array")]);
    });
    // Not an MCP signal: a plain {"error": ...} in a success fixture still fails as before.
    withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/ok-but.json": JSON.stringify({ error: "zzz_invalid" }) } }, c => {
      expect(row(run(c), "hygiene.error_bodies").note).toContain("a success fixture carries \"error\"");
    });
  });
  test("v0: a malformed envelope is still rejected (id, result and error, code, message, content, the closed code)", () => {
    const bad: [string, unknown, string][] = [
      ["no id", { jsonrpc: "2.0", error: { code: -32602, message: "x" } }, "no id"],
      ["a null id", { jsonrpc: "2.0", id: null, error: { code: -32602, message: "x" } }, "no id"],
      ["no jsonrpc", { id: 3, result: TOOL_TEXT }, "jsonrpc is not \"2.0\""],
      ["result without jsonrpc or id", { result: TOOL_TEXT }, "no id"],
      ["both result and error", { jsonrpc: "2.0", id: 3, result: TOOL_TEXT, error: { code: -32602, message: "x" } }, "both result and error"],
      ["a fractional code", { jsonrpc: "2.0", id: 3, error: { code: -32602.5, message: "x" } }, "error.code is not an integer"],
      ["a string code", { jsonrpc: "2.0", id: 3, error: { code: "-32602", message: "x" } }, "error.code is not an integer"],
      ["a non-string message", { jsonrpc: "2.0", id: 3, error: { code: -32602, message: 7 } }, "error.message is not a string"],
      ["isError without content", { isError: true }, "isError without a content array"],
      ["isError with content not an array", { isError: true, content: { type: "text", text: "x" } }, "isError without a content array"],
      ["a content item without a type", { isError: true, content: [{ text: "x" }] }, "content/0 has no string type"],
      ["a text item without text", { isError: true, content: [{ type: "text" }] }, "content/0 is text without a string text"],
      ["isError the string \"true\"", { isError: "true", content: [] }, "isError is not true"],
      ["a result that is not an error", { jsonrpc: "2.0", id: 3, result: { content: [] } }, "isError is not true"],
      ["a carried open code", { isError: true, content: [], structuredContent: { code: "boom", detail: "x" } }, "code boom is not in the closed set for acme"],
    ];
    for (const [why, body, want] of bad) {
      withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/error-x.json": JSON.stringify(body) } }, c => {
        const r = row(run(c), "hygiene.error_bodies");
        expect([why, r.pass, r.note]).toEqual([why, false, expect.stringContaining(want)]);
      });
    }
  });
  test("S1 (review-b on ov#474): every content item is checked, not only the first twelve; only the notes are capped", () => {
    const good = Array.from({ length: 13 }, (_, i) => ({ type: "text", text: `Line ${i}.` }));
    withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/error-x.json": JSON.stringify({ isError: true, content: good }) } }, c => {
      expect(row(run(c), "hygiene.error_bodies").pass).toBe(true);
    });
    for (const last of [42, { type: "text" }, { text: "no type" }]) {
      const body = { isError: true, content: [...good.slice(0, 12), last] };
      withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/error-x.json": JSON.stringify(body) } }, c => {
        const r = row(run(c), "hygiene.error_bodies");
        expect([JSON.stringify(last), r.pass, r.note]).toEqual([JSON.stringify(last), false, expect.stringContaining("content/12 ")]);
      });
      expect(toolErrorProblems(body).length).toBe(1);
    }
    // Thirty bad items: each is checked, the note lists twelve and counts the rest.
    const many = toolErrorProblems({ isError: true, content: Array.from({ length: 30 }, () => 42) });
    expect([many.length, many[11], many[12]]).toEqual([13, "content/11 has no string type", "and 18 more content item problem(s)"]);
  });
  test("v0: an https-json app gets no envelope rule: its error fixture is still exactly {code, detail}", () => {
    withCatalog({ manifest: httpsJsonAcme(), fixtures: { ...GOOD_FIXTURES, "acme.lookup/error-x.json": JSON.stringify(TOOL_TEXT) } }, c => {
      const r = row(run(c), "hygiene.error_bodies");
      expect([r.pass, r.note]).toEqual([false, expect.stringContaining("keys are content, isError, not exactly code, detail")]);
    });
  });

  /** The lookup error call answered by `packet` (its id filled in), as JSON or over an event stream. */
  const answering = (sse: boolean, packet: (id: number) => unknown) => mcpServer({
    lookup: (args, res, id) => {
      const body = args.q === "missing" ? packet(id) : { jsonrpc: "2.0", id, result: { content: [], structuredContent: { items: [{ name: "a", rank: 1 }] } } };
      if (!sse) return json(res, 200, body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    },
  });
  const withError = (fixture: unknown) => v1Catalog("mcp", acme(), files => { files["acme.lookup/error-not-found.json"] = JSON.stringify(fixture); });
  test("v1: a JSON-RPC error or an isError result answers an error call (JSON and event stream), matched to its fixture", async () => {
    const good: [string, unknown, (id: number) => unknown][] = [
      ["JSON-RPC -32602, fixture the same error", RPC_PARAMS, id => ({ ...RPC_PARAMS, id, error: { code: -32602, message: "Invalid params (live wording)" } })],
      ["isError plain text, fixture a bare tool error", TOOL_TEXT, id => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "not found" }] } })],
      ["isError plain text, fixture the wrapped tool error", { jsonrpc: "2.0", id: 9, result: TOOL_TEXT }, id => ({ jsonrpc: "2.0", id, result: TOOL_TEXT })],
      ["isError carrying {code, detail}, fixture {code, detail}", { code: "not_found", detail: "No such item." }, id => ({ jsonrpc: "2.0", id, result: TOOL_CODED })],
    ];
    for (const sse of [false, true]) {
      for (const [why, fixture, packet] of good) {
        await withStub(answering(sse, packet), async s => {
          const c = withError(fixture);
          try {
            const r = await runV1(c, s);
            invariants(r);
            expect([sse, why, v1Rows(r), row(r, "service.error_bodies").note]).toEqual([sse, why,
              { "service.reachability": true, "service.budgets": true, "service.error_bodies": true, "approval.fake_cp": null }, expect.stringContaining("1 error call(s)")]);
          } finally { cleanup(c); }
        });
      }
    }
  });
  test("v1: a malformed or mismatched live error answer still fails service.error_bodies; a success call answered by an error still fails budgets", async () => {
    const bad: [string, unknown, (id: number) => unknown, string][] = [
      ["both result and error", RPC_PARAMS, id => ({ jsonrpc: "2.0", id, result: TOOL_TEXT, error: { code: -32602, message: "x" } }), "both result and error"],
      ["a fractional code", RPC_PARAMS, id => ({ jsonrpc: "2.0", id, error: { code: 1.5, message: "x" } }), "error.code is not an integer"],
      ["a non-string message", RPC_PARAMS, id => ({ jsonrpc: "2.0", id, error: { code: -32602, message: null } }), "error.message is not a string"],
      ["no id", RPC_PARAMS, () => ({ jsonrpc: "2.0", error: { code: -32602, message: "x" } }), "not the JSON-RPC response to this request"],
      ["isError without content", TOOL_TEXT, id => ({ jsonrpc: "2.0", id, result: { isError: true } }), "isError without a content array"],
      ["another JSON-RPC code than the fixture's", RPC_PARAMS, id => ({ jsonrpc: "2.0", id, error: { code: -32601, message: "x" } }), "JSON-RPC error -32601, the fixture says -32602"],
      ["a JSON-RPC error where the fixture is a tool error", TOOL_TEXT, id => ({ jsonrpc: "2.0", id, error: { code: -32602, message: "x" } }), "a JSON-RPC error -32602, the fixture is an isError result"],
      ["a JSON-RPC error where the fixture is {code, detail}", { code: "not_found", detail: "x" }, id => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "nope" } }), "a JSON-RPC error -32000, the fixture says code not_found"],
      ["an isError result where the fixture is a JSON-RPC error", RPC_PARAMS, id => ({ jsonrpc: "2.0", id, result: TOOL_TEXT }), "an isError result, the fixture is JSON-RPC error -32602"],
      ["plain text where the fixture is {code, detail}", { code: "not_found", detail: "x" }, id => ({ jsonrpc: "2.0", id, result: TOOL_TEXT }), "the isError result carries no {code, detail}"],
      ["a success where the fixture is an error", TOOL_TEXT, id => ({ jsonrpc: "2.0", id, result: { content: [] } }), "answered a result, not isError or a JSON-RPC error, where the fixture is an error"],
    ];
    for (const [why, fixture, packet, want] of bad) {
      await withStub(answering(false, packet), async s => {
        const c = withError(fixture);
        try {
          const r = row(await runV1(c, s), "service.error_bodies");
          expect([why, r.pass, r.note]).toEqual([why, false, expect.stringContaining(want)]);
        } finally { cleanup(c); }
      });
    }
    await withStub(mcpServer({ lookup: (args, res, id) => json(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: "x" } }) }), async s => {
      const c = v1Catalog("mcp");
      try {
        const r = await runV1(c, s);
        expect([row(r, "service.budgets").pass, row(r, "service.budgets").note]).toEqual([false, expect.stringContaining("acme.lookup/ok.request.json: a JSON-RPC error, not a result")]);
      } finally { cleanup(c); }
    });
  });
});
