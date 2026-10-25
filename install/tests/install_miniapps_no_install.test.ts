// V2114 HOTFIX: the control plane runs this installer on a box as `bun --no-env-file --no-install
// install/install_miniapps.ts` (cp mini-apps-runtime.js) from ~/.hermes/edge-src, a shallow clone with NO
// node_modules. With --no-install, Bun resolves no npm package (not even from its global cache), so a bare
// package anywhere on the installer's import graph fails the module load: exit 1, empty stdout, and the cp
// records mini_apps_stage_failed for every box on that overlay (v2.1.14: zzz_managed_job.ts imported
// hermesAvailable through install_index.ts, which imports `yaml`). These tests run with node_modules present,
// so the second one copies the tree without it and runs the exact box command.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { REVIEWED_MINI_APPS } from "../install_miniapps";

const repo = resolve(import.meta.dir, "../..");
const ENTRY = "install/install_miniapps.ts";
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/**
 * Every relative import reachable from `entry` (static imports, re-exports, literal import() and require()), and every
 * non-builtin bare specifier among them. An import() or require() whose argument is not a string literal cannot be
 * followed, so it is reported as bare too (fail closed).
 */
function importGraph(root: string, entry: string): { files: string[]; bare: string[] } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const bare: string[] = [];
  const resolveFile = (from: string, spec: string) => {
    const base = resolve(dirname(from), spec);
    const found = [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")].find(path => existsSync(path) && statSync(path).isFile());
    if (!found) throw new Error(`unresolved ${spec} from ${relative(root, from)}`);
    return found;
  };
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8").replace(/^#!.*/, "");
    const scanned = transpiler.scanImports(source);
    const calls = source.match(/\b(?:import|require)\s*\(/g)?.length ?? 0;
    if (calls > scanned.filter(({ kind }) => kind === "dynamic-import" || kind === "require-call").length) bare.push(`${relative(root, file)}: non-literal import()/require()`);
    for (const { path: spec } of scanned) {
      if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) walk(resolveFile(file, spec));
      else bare.push(`${relative(root, file)}: ${spec}`);
    }
  };
  walk(join(root, entry));
  return { files: [...seen].map(file => relative(root, file)), bare };
}

test("static: no npm package on install_miniapps.ts's import graph (only node:, bun: and relative files)", () => {
  const { files, bare } = importGraph(repo, ENTRY);
  expect(files).toContain("install/zzz_managed_job.ts");
  expect(bare).toEqual([]);
});

test("the box command loads and stages from a checkout with no node_modules (--no-install)", () => {
  // realpath: the installer refuses any symlinked parent of HERMES_HOME (macOS /var and /tmp are links).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "miniapps-no-install-")));
  roots.push(root);
  const src = join(root, "edge-src");
  const skip = new Set(["node_modules", ".git", ".test-deps"]);
  for (const part of ["package.json", "install", "skills"]) cpSync(join(repo, part), join(src, part), { recursive: true, filter: path => !skip.has(basename(path)) });
  // Bun resolves a package from any node_modules up the tree, so none may sit above the copy (or the test proves nothing).
  for (let dir = src; ; dir = dirname(dir)) {
    expect(existsSync(join(dir, "node_modules")) ? join(dir, "node_modules") : null).toBeNull();
    if (dirname(dir) === dir) break;
  }
  const home = join(root, "home", ".hermes");
  mkdirSync(home, { recursive: true });
  const run = (projection: unknown, verify = false) => spawnSync(process.execPath, ["--no-env-file", "--no-install", ENTRY, ...(verify ? ["--verify"] : [])], {
    cwd: src, input: JSON.stringify(projection), encoding: "utf8", timeout: 20000,
    env: { PATH: process.env.PATH, HOME: dirname(home), HERMES_HOME: home },
  });
  const empty = run({ version: 1, apps: [] });
  expect({ status: empty.status, stderr: empty.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(empty.stdout)).toMatchObject({ version: 1, staged: true, apps: [], files: [] });
  // The cp's gold-stars entry (the staff app every tenant carries): staged and verified the same way.
  const gold = REVIEWED_MINI_APPS[0];
  const projection = { version: 1, apps: [{ id: gold.id, version: gold.version, operations: [...gold.operations], skills: [...gold.skills] }] };
  const staged = run(projection);
  expect({ status: staged.status, stderr: staged.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(staged.stdout)).toMatchObject({ version: 1, staged: true, apps: [{ id: "gold-stars", version: gold.version }] });
  const verified = run(projection, true);
  expect({ status: verified.status, stderr: verified.stderr }).toEqual({ status: 0, stderr: "" });
});
