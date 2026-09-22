import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { copyPluginTree, shouldCopyPluginEntry } from "../plugin_copy";

function fixture(): { source: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), "agentvillage-plugincopy-"));
  const source = join(root, "av-events");
  mkdirSync(join(source, "tests"), { recursive: true });
  mkdirSync(join(source, "__pycache__"), { recursive: true });
  mkdirSync(join(source, ".pytest_cache", "v"), { recursive: true });

  writeFileSync(join(source, "__init__.py"), "# plugin");
  writeFileSync(join(source, "_core.py"), "# core");
  writeFileSync(join(source, "plugin.yaml"), "name: av-events");
  writeFileSync(join(source, "README.md"), "# readme");
  writeFileSync(join(source, "pytest.ini"), "[pytest]");
  writeFileSync(join(source, "_core.pyc"), "compiled");
  writeFileSync(join(source, "tests", "conftest.py"), "# fixtures");
  writeFileSync(join(source, "tests", "test_buffer.py"), "# tests");
  writeFileSync(join(source, "__pycache__", "_core.cpython-311.pyc"), "compiled");
  writeFileSync(join(source, ".pytest_cache", "v", "cache"), "{}");

  return { source, target: join(root, "out") };
}

test("copyPluginTree stages the plugin but not its test suite or caches", () => {
  const { source, target } = fixture();

  const copied = copyPluginTree(source, target);

  expect(existsSync(join(target, "__init__.py"))).toBe(true);
  expect(existsSync(join(target, "_core.py"))).toBe(true);
  expect(existsSync(join(target, "plugin.yaml"))).toBe(true);
  expect(existsSync(join(target, "README.md"))).toBe(true);

  expect(existsSync(join(target, "tests"))).toBe(false);
  expect(existsSync(join(target, "__pycache__"))).toBe(false);
  expect(existsSync(join(target, ".pytest_cache"))).toBe(false);
  expect(existsSync(join(target, "pytest.ini"))).toBe(false);
  expect(existsSync(join(target, "_core.pyc"))).toBe(false);

  expect(copied).toBe(4);
});

test("copyPluginTree keeps nested plugin assets", () => {
  const { source, target } = fixture();
  mkdirSync(join(source, "assets"), { recursive: true });
  writeFileSync(join(source, "assets", "edge.svg"), "<svg/>");

  copyPluginTree(source, target);

  expect(existsSync(join(target, "assets", "edge.svg"))).toBe(true);
});

test("shouldCopyPluginEntry rules", () => {
  expect(shouldCopyPluginEntry("tests", true)).toBe(false);
  expect(shouldCopyPluginEntry("__pycache__", true)).toBe(false);
  expect(shouldCopyPluginEntry("assets", true)).toBe(true);
  expect(shouldCopyPluginEntry("a.pyc", false)).toBe(false);
  expect(shouldCopyPluginEntry("pytest.ini", false)).toBe(false);
  expect(shouldCopyPluginEntry("__init__.py", false)).toBe(true);
  // A plugin that legitimately ships a file called "tests.py" keeps it.
  expect(shouldCopyPluginEntry("tests.py", false)).toBe(true);
});
