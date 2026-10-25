/**
 * SEC-3 PR 1: av-approval's expected plugin set (`plugins/av-approval/expected_plugins.json`) is the
 * installer's, derived, never counted.
 *
 * In `quarantine` mode av-approval unlists (and unloads) every plugin it does not expect, so the set
 * must move with the installer: a new overlay plugin, a `NOT_STAGED_PLUGINS` change (BRIDGE-1 re-staging
 * village-bridge) or an `INDEX_PLUGIN_REF` bump that does not update the JSON in the same PR fails here.
 *
 * - `overlay` == every directory under `plugins/` minus `NOT_STAGED_PLUGINS` (what `stagePlugins` copies);
 * - `index` == {`INDEX_PLUGIN`, `INDEX_PLUGIN_REF`} (the installer's `--ref` for index-network);
 * - `conditional` (present on some boxes only, or never loaded by the general manager, so never
 *   `expected_missing`) == `recall`, the index plugin, `village-memory` (a memory provider), and
 *   `village-bridge` only while it is staged;
 * - `expected_set_version` == the first 12 hex of sha256 over the canonical JSON of the set (keys sorted,
 *   no spaces), the same function as `_plugins.set_version` in Python.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { NOT_STAGED_PLUGINS } from "../install_approval";
import { INDEX_PLUGIN, INDEX_PLUGIN_REF } from "../install_index_plugin";

const PLUGINS = join(import.meta.dir, "..", "..", "plugins");
const EXPECTED_PATH = join(PLUGINS, "av-approval", "expected_plugins.json");

interface ExpectedSet {
  expected_set_version: string;
  overlay: string[];
  index: { name: string; ref: string };
  conditional: string[];
}

const expected: ExpectedSet = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));

/** What `stagePlugins` copies to a box: the directories under `plugins/`, minus `NOT_STAGED_PLUGINS`. */
function stagedOverlay(): string[] {
  return readdirSync(PLUGINS)
    .filter((name) => statSync(join(PLUGINS, name)).isDirectory() && !NOT_STAGED_PLUGINS.has(name))
    .sort();
}

function setVersion(set: ExpectedSet): string {
  const canonical = JSON.stringify({
    conditional: set.conditional,
    index: { name: set.index.name, ref: set.index.ref },
    overlay: set.overlay,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}

describe("expected_plugins.json is the installer's set", () => {
  test("the file holds exactly the four keys", () => {
    expect(Object.keys(expected)).toEqual(["expected_set_version", "overlay", "index", "conditional"]);
  });

  test("overlay == readdir(plugins/) minus NOT_STAGED_PLUGINS", () => {
    expect(expected.overlay).toEqual(stagedOverlay());
    for (const name of NOT_STAGED_PLUGINS) expect(expected.overlay).not.toContain(name);
    expect(expected.overlay).toContain("av-approval");
  });

  test("index == the installer's index-network pin", () => {
    expect(expected.index).toEqual({ name: INDEX_PLUGIN, ref: INDEX_PLUGIN_REF });
    expect(INDEX_PLUGIN_REF).toMatch(/^[0-9a-f]{40}$/);
  });

  // village-memory (D3) is a memory provider (`kind: exclusive`): Hermes's general manager records it as a
  // placeholder and never loads it, so it can never count as loaded and must not count as missing.
  // av-elicit (GC-ELICIT) is opt-in like recall (AV_ELICIT_ENABLED): staged on every box, loaded only where listed.
  test("conditional == recall, av-elicit, the index plugin, village-memory, and village-bridge only while staged", () => {
    const want = ["recall", "av-elicit", INDEX_PLUGIN, "village-memory", ...(NOT_STAGED_PLUGINS.has("village-bridge") ? [] : ["village-bridge"])].sort();
    expect(expected.conditional).toEqual(want);
    for (const name of expected.conditional) expect([...expected.overlay, INDEX_PLUGIN]).toContain(name);
  });

  test("expected_set_version == sha256 prefix of the canonical JSON of the set", () => {
    expect(expected.expected_set_version).toMatch(/^[0-9a-f]{12}$/);
    expect(expected.expected_set_version).toBe(setVersion(expected));
  });

  test("a changed set changes the version (the check is not vacuous)", () => {
    expect(setVersion({ ...expected, overlay: [...expected.overlay, "village-bridge"].sort() })).not.toBe(
      expected.expected_set_version,
    );
    expect(setVersion({ ...expected, index: { ...expected.index, ref: "0".repeat(40) } })).not.toBe(
      expected.expected_set_version,
    );
  });
});
