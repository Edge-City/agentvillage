/**
 * SEC-6 half 2: `configureModelAllow` writes av-approval's local model list, `av_approval.model_allow`, from the
 * control plane's `AV_MODEL_ALLOWLIST` plus the overlay's `FALLBACK_MODEL`; absent env removes the key.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { configureModelAllow, FALLBACK_MODEL } from "../config";
import { installStatusPath, modelAllowFailedLine, recordModelAllowStatus, writeInstallStatus } from "../install_status";

const ORIGINAL = { home: process.env.HERMES_HOME, list: process.env.AV_MODEL_ALLOWLIST };
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  delete process.env.AV_MODEL_ALLOWLIST;
});

afterEach(() => {
  logSpy.mockRestore();
  for (const [name, value] of [["HERMES_HOME", ORIGINAL.home], ["AV_MODEL_ALLOWLIST", ORIGINAL.list]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function withText(text: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-model-allow-"));
  process.env.HERMES_HOME = home;
  const path = join(home, "config.yaml");
  if (text !== null) writeFileSync(path, text);
  return path;
}

const read = (path: string) => YAML.parse(readFileSync(path, "utf8")) as Record<string, any>;
const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");
/** av-approval `_models.allowlist_version`; the vector is pinned in tests/test_model_observer.py too. */
const version = (ids: string[]) => createHash("sha256").update([...new Set(ids)].sort().join(",")).digest("hex").slice(0, 12);

test("absent env: no key is written, never an empty list; an existing key is removed and siblings kept", () => {
  const fresh = withText(null);
  expect(configureModelAllow()).toBeNull();
  expect(existsSync(fresh)).toBe(false); // nothing to write: no file, no key
  const path = withText(YAML.stringify({ model: { default: "x/y" }, av_approval: { model_allow: ["a/b"], unknown_plugins: "report" } }));
  expect(configureModelAllow()).toBeNull();
  expect(read(path)).toEqual({ model: { default: "x/y" }, av_approval: { unknown_plugins: "report" } });
  const only = withText(YAML.stringify({ av_approval: { model_allow: ["a/b"] } }));
  expect(configureModelAllow()).toBeNull();
  expect(read(only)?.av_approval).toBeUndefined();
  expect(logged()).toContain("AV_MODEL_ALLOWLIST absent; no local list");
});

test("valid: the cp's ids plus FALLBACK_MODEL, sorted, other av_approval keys kept; version over the union", () => {
  process.env.AV_MODEL_ALLOWLIST = "openai/gpt-4o-mini";
  const path = withText(YAML.stringify({ model: { default: "openai/gpt-4o-mini" }, av_approval: { model_observer: "on" } }));
  expect(configureModelAllow()).toBeNull();
  const block = read(path).av_approval;
  expect(block).toEqual({ model_observer: "on", model_allow: ["openai/gpt-4o-mini", FALLBACK_MODEL] });
  expect(FALLBACK_MODEL).toBe("openai/gpt-6-luna");
  expect(version(block.model_allow)).toBe("fda54b54da8b");
});

test("dedupe: a cp list that already holds the fallback gives the same union and version", () => {
  process.env.AV_MODEL_ALLOWLIST = ` ${FALLBACK_MODEL}, openai/gpt-4o-mini ,${FALLBACK_MODEL}`;
  const path = withText(null);
  expect(configureModelAllow()).toBeNull();
  expect(read(path).av_approval.model_allow).toEqual(["openai/gpt-4o-mini", FALLBACK_MODEL]);
  expect(version(read(path).av_approval.model_allow)).toBe("fda54b54da8b");
  process.env.AV_MODEL_ALLOWLIST = "";
  expect(configureModelAllow()).toBeNull();
  expect(read(path).av_approval.model_allow).toEqual([FALLBACK_MODEL]);
});

test("garbage: invalid ids are dropped and counted, never echoed", () => {
  const long = "a/" + "b".repeat(99);
  process.env.AV_MODEL_ALLOWLIST = `OpenAI/GPT-4o,nos,https://x.example/v1,${long},x-ai/grok-4,SECRETLIKE/x`;
  const path = withText(null);
  expect(configureModelAllow()).toBeNull();
  expect(read(path).av_approval.model_allow).toEqual([FALLBACK_MODEL, "x-ai/grok-4"]);
  expect(logged()).toContain("5 invalid entries dropped");
  for (const word of ["OpenAI", "nos", "x.example", "SECRETLIKE", long]) expect(logged()).not.toContain(word);
});

/** data#539's version fixture, as copied into the plugin's tests (README names its sha). */
const DATA = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "plugins", "av-approval", "tests", "vectors",
  "model-allowlist-version.v1.json"), "utf8")) as { vectors: { note: string; env: string; ids: string[]; version: string; dropped: number }[] };

test.each(DATA.vectors.map((row) => [row.note, row] as const))("data's version fixture: %s", (_note, row) => {
  process.env.AV_MODEL_ALLOWLIST = row.env;
  const path = withText(null);
  expect(configureModelAllow()).toBeNull();
  const written = read(path).av_approval.model_allow as string[];
  expect(written).toEqual([...new Set([...row.ids, FALLBACK_MODEL])].sort());
  expect(version(row.ids)).toBe(row.version);
  if (row.ids.includes(FALLBACK_MODEL)) expect(version(written)).toBe(row.version);
  if (row.dropped) expect(logged()).toContain(`${row.dropped} invalid ${row.dropped === 1 ? "entry" : "entries"} dropped`);
});

test("cap: at most 64 of the cp's ids besides the fallback, the rest dropped in one counted line", () => {
  const vendors = Array.from({ length: 70 }, (_, i) => `vendor/m${String(i).padStart(2, "0")}`);
  process.env.AV_MODEL_ALLOWLIST = [FALLBACK_MODEL, ...vendors].join(",");
  const path = withText(null);
  expect(configureModelAllow()).toBeNull();
  const written = read(path).av_approval.model_allow as string[];
  expect(written).toEqual([FALLBACK_MODEL, ...vendors.slice(0, 64)]);
  expect(version(written)).toBe("be3a3f29e54d"); // data's 65-id row
  expect(logged()).toContain("→ model observer: 6 valid ids past the 64-id cap dropped");
});

test("idempotent: a second run is byte-identical", () => {
  process.env.AV_MODEL_ALLOWLIST = "x-ai/grok-4,openai/gpt-4o-mini";
  const path = withText("model:\n  default: x-ai/grok-4\nav_approval:\n  unknown_plugins: report\n");
  configureModelAllow();
  const first = readFileSync(path, "utf8");
  configureModelAllow();
  expect(readFileSync(path, "utf8")).toBe(first);
});

test.each([
  ["model: [unclosed\n", "parse_error"],
  ["- a\n- b\n", "the top level of config.yaml is not a mapping"],
  ["base: &b {x: 1}\nav_approval:\n  <<: *b\n", 'YAML merge key "<<" under av_approval'],
  ["av_approval: report\n", "av_approval is not a mapping"],
])("fails loud and writes nothing: %p", (text, why) => {
  process.env.AV_MODEL_ALLOWLIST = "x-ai/grok-4";
  const path = withText(text);
  expect(configureModelAllow()).toBe(why);
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(logged()).toContain(`→ error: ${why}; av_approval.model_allow NOT written`);
});

test.each([
  ["av_approval: report\n", "av_approval is not a mapping"],
  ["model: [unclosed\n", "parse_error"],
])("S2: a failure is recorded as model_allow_failed in install-status.json and printed: %p", (text, why) => {
  process.env.AV_MODEL_ALLOWLIST = "x-ai/grok-4";
  withText(text);
  const home = process.env.HERMES_HOME!;
  writeInstallStatus(home, []);
  const failed = configureModelAllow();
  expect(failed).toBe(why);
  expect(recordModelAllowStatus(home, failed)).toBe(true);
  expect(JSON.parse(readFileSync(installStatusPath(home), "utf8")).model_allow_failed).toBe(why);
  expect(modelAllowFailedLine(failed!)).toBe(`agentvillage-install: model_allow_failed=${JSON.stringify(why)}`);
});

test("S2: a clean run records model_allow_failed null", () => {
  process.env.AV_MODEL_ALLOWLIST = "x-ai/grok-4";
  withText(null);
  const home = process.env.HERMES_HOME!;
  writeInstallStatus(home, []);
  expect(recordModelAllowStatus(home, configureModelAllow())).toBe(true);
  expect(JSON.parse(readFileSync(installStatusPath(home), "utf8")).model_allow_failed).toBeNull();
});

test("install.ts runs the step after configureSlashAccess and exits non-zero when it fails", () => {
  const source = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  const slash = source.indexOf("const slashAccessFailed = configureSlashAccess();");
  const step = source.indexOf("const modelAllowFailed = configureModelAllow();");
  expect(slash).toBeGreaterThan(0);
  expect(step).toBeGreaterThan(slash);
  const tail = source.slice(source.indexOf("if (modelAllowFailed) {"));
  expect(tail.indexOf("process.exitCode = 1;")).toBeGreaterThan(0);
  expect(tail.indexOf("process.exitCode = 1;")).toBeLessThan(tail.indexOf("const receipt = codeExecFailed ? null : gateReceiptLine();"));
  expect(tail.indexOf("console.log(modelAllowFailedLine(modelAllowFailed));")).toBeGreaterThan(0);
  expect(source).toContain("recordModelAllowStatus(hermesHome(), modelAllowFailed);");
  expect(source).toContain("recordModelAllowStatus(hermesHome(), parseFailed);"); // the early parse-error exit too
  expect(source).toContain("console.log(modelAllowFailedLine(parseFailed));");
});
