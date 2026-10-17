/**
 * SEC-6: `configureSlashAccess` turns on Hermes's slash access control for Telegram, so a resident
 * runs only `RESIDENT_SLASH_COMMANDS` (plus `/help`, `/whoami`) and `/model` is admin-only.
 * Fix round 1: no env admin override (S1), competing blocks lose the keys (S2), fail loud (S3).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import {
  configureSlashAccess,
  findMergeKey,
  RESIDENT_PLUGIN_SLASH_COMMANDS,
  RESIDENT_SLASH_COMMANDS,
  SLASH_ACCESS_KEYS,
  SLASH_NO_ADMIN,
  slashAccessKeys,
} from "../config";
import { installStatusPath, recordSlashAccessStatus, writeInstallStatus } from "../install_status";

const HERMES_REF = "/Users/carter/dev/hermes-agent-ref-v2026.9.24";
const REPO_ROOT = join(import.meta.dir, "..", "..");
const ORIGINAL = { home: process.env.HERMES_HOME, admins: process.env.AV_SLASH_ADMIN_IDS };
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  delete process.env.AV_SLASH_ADMIN_IDS;
});

afterEach(() => {
  logSpy.mockRestore();
  for (const [name, value] of [["HERMES_HOME", ORIGINAL.home], ["AV_SLASH_ADMIN_IDS", ORIGINAL.admins]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function withText(text: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-slash-"));
  process.env.HERMES_HOME = home;
  const path = join(home, "config.yaml");
  if (text !== null) writeFileSync(path, text);
  return path;
}

const read = (path: string) => YAML.parse(readFileSync(path, "utf8")) as Record<string, any>;
const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");

/** Commands that change the model, cost, tools or config: never resident-runnable. */
const ADMIN_ONLY = ["model", "reasoning", "fast", "yolo", "config", "plugins", "skills", "cron", "reload", "update", "tools"];
const SENTINEL_KEYS = {
  allow_admin_from: [SLASH_NO_ADMIN],
  group_allow_admin_from: [SLASH_NO_ADMIN],
  user_allowed_commands: [...RESIDENT_SLASH_COMMANDS],
  group_user_allowed_commands: [...RESIDENT_SLASH_COMMANDS],
};

test("fresh config: writes the four keys under platforms.telegram.extra with the sentinel admin", () => {
  const path = withText(null);
  expect(configureSlashAccess()).toBeNull();
  expect(read(path).platforms.telegram.extra).toEqual(SENTINEL_KEYS);
  expect(logged()).toContain(
    `→ slash access: residents may run ${RESIDENT_SLASH_COMMANDS.length} commands; /model and config commands are admin-only`,
  );
});

test("keeps every other key, overwrites stale values and a promoted top-level copy", () => {
  const path = withText(
    YAML.stringify({
      model: { default: "x/y" },
      platforms: {
        telegram: {
          gateway_restart_notification: false,
          user_allowed_commands: ["model"],
          extra: { drop_pending_on_cold_boot: false, disable_link_previews: true, allow_admin_from: ["999"] },
        },
        discord: { enabled: false },
      },
    }),
  );
  expect(configureSlashAccess()).toBeNull();
  const doc = read(path);
  expect(doc.model).toEqual({ default: "x/y" });
  expect(doc.platforms.discord).toEqual({ enabled: false });
  const telegram = doc.platforms.telegram;
  expect(telegram.gateway_restart_notification).toBe(false);
  expect(telegram.user_allowed_commands).toEqual([...RESIDENT_SLASH_COMMANDS]);
  expect(telegram.extra.drop_pending_on_cold_boot).toBe(false);
  expect(telegram.extra.disable_link_previews).toBe(true);
  expect(telegram.extra.allow_admin_from).toEqual([SLASH_NO_ADMIN]);
});

test("second run is byte-identical", () => {
  const path = withText("platforms:\n  telegram:\n    extra:\n      drop_pending_on_cold_boot: false\n");
  configureSlashAccess();
  const first = readFileSync(path, "utf8");
  configureSlashAccess();
  expect(readFileSync(path, "utf8")).toBe(first);
});

test("S1: AV_SLASH_ADMIN_IDS in the environment is ignored; the admin lists are exactly the sentinel", () => {
  process.env.AV_SLASH_ADMIN_IDS = "123456, 2";
  const path = withText(null);
  expect(configureSlashAccess()).toBeNull();
  const extra = read(path).platforms.telegram.extra;
  expect(extra.allow_admin_from).toEqual([SLASH_NO_ADMIN]);
  expect(extra.group_allow_admin_from).toEqual([SLASH_NO_ADMIN]);
  expect(slashAccessKeys()).toEqual(SENTINEL_KEYS);
  expect(readFileSync(join(REPO_ROOT, "install", "config.ts"), "utf8")).not.toContain("AV_SLASH_ADMIN_IDS");
});

test("S2: the four keys are deleted from every block Hermes may read over platforms.telegram", () => {
  const competing = { allow_admin_from: [], user_allowed_commands: ["model"], require_mention: true };
  const path = withText(
    YAML.stringify({
      telegram: { ...competing, extra: { group_user_allowed_commands: ["model"], keep: 1 } },
      gateway: {
        telegram: { group_allow_admin_from: [], extra: { allow_admin_from: [], keep: 2 } },
        platforms: { telegram: { ...competing, extra: { group_allow_admin_from: [] } } },
      },
    }),
  );
  expect(configureSlashAccess()).toBeNull();
  const doc = read(path);
  for (const block of [doc.telegram, doc.telegram.extra, doc.gateway.telegram, doc.gateway.telegram.extra,
    doc.gateway.platforms.telegram, doc.gateway.platforms.telegram.extra]) {
    for (const key of SLASH_ACCESS_KEYS) expect(block).not.toHaveProperty(key);
  }
  expect(doc.telegram.require_mention).toBe(true);
  expect(doc.telegram.extra.keep).toBe(1);
  expect(doc.gateway.telegram.extra.keep).toBe(2);
  expect(doc.platforms.telegram.extra).toEqual(SENTINEL_KEYS);
  expect(logged()).toContain("→ slash access: removed telegram.allow_admin_from");
  expect(logged()).toContain("→ slash access: removed gateway.telegram.extra.allow_admin_from");
  expect(logged()).toContain("→ slash access: removed gateway.platforms.telegram.user_allowed_commands");
});

test("S3: an uneditable level writes nothing and returns the reason", () => {
  for (const [text, why] of [
    ["platforms:\n  telegram: oops\n", "platforms.telegram is not a mapping"],
    ["base: &b {a: 1}\nplatforms:\n  telegram:\n    extra:\n      <<: *b\n", 'YAML merge key "<<" under platforms.telegram.extra'],
    ["base: &b {a: 1}\ntelegram:\n  <<: *b\n", 'YAML merge key "<<" under telegram'],
    ["- a list\n", "the top level of config.yaml is not a mapping"],
  ] as const) {
    const path = withText(text);
    expect(configureSlashAccess()).toBe(why);
    expect(readFileSync(path, "utf8")).toBe(text);
  }
  expect(logged()).toContain("slash access NOT configured");
  expect(logged()).not.toContain("residents may run");
});

test("S3: recordSlashAccessStatus sets the field in this run's status file, null on a clean run", () => {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-slash-status-"));
  expect(recordSlashAccessStatus(home, "x")).toBe(false); // no status file written this run
  writeInstallStatus(home, []);
  expect(recordSlashAccessStatus(home, "platforms.telegram is not a mapping")).toBe(true);
  expect(JSON.parse(readFileSync(installStatusPath(home), "utf8"))).toMatchObject({
    version: 1, cron_failed: [], slash_access_failed: "platforms.telegram is not a mapping",
  });
  writeInstallStatus(home, []);
  recordSlashAccessStatus(home, null);
  expect(JSON.parse(readFileSync(installStatusPath(home), "utf8")).slash_access_failed).toBeNull();
});

test("S3: install.ts runs every other step, records slash_access_failed and exits non-zero", () => {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-slash-install-"));
  const fakeHermes = join(home, "fake-hermes");
  writeFileSync(fakeHermes, "#!/bin/sh\nexit 127\n");
  chmodSync(fakeHermes, 0o755);
  // A scalar telegram block is turned into a mapping by configureHostedGateway first; a merge key is not.
  writeFileSync(join(home, "config.yaml"), "base: &b {a: 1}\nplatforms:\n  telegram:\n    extra:\n      <<: *b\n");
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, HERMES_HOME: home, HERMES_BIN: fakeHermes };
  for (const key of ["AV_APPROVAL_ENABLED", "AV_RECALL_ENABLED", "AV_SLASH_ADMIN_IDS"]) delete env[key];
  const run = Bun.spawnSync({
    cmd: ["bun", join(REPO_ROOT, "install", "install.ts"), "--no-restart", "--skip-crons", "--skip-index"],
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = run.stdout.toString();
  expect(run.exitCode).toBe(1);
  const why = 'YAML merge key "<<" under platforms.telegram.extra';
  expect(stdout).toContain(`agentvillage-install: slash_access_failed=${JSON.stringify(why)}`);
  expect(stdout).toContain("✓ installed"); // the remaining steps ran first
  expect(existsSync(join(home, "AGENTS.md"))).toBe(true);
  expect(JSON.parse(readFileSync(installStatusPath(home), "utf8")).slash_access_failed).toBe(why);
});

/** Run install.ts end to end over `configText`, as the control plane does (--no-restart). */
function runInstall(configText: string): { code: number | null; stdout: string; status: Record<string, unknown> } {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-slash-install-"));
  const fakeHermes = join(home, "fake-hermes");
  writeFileSync(fakeHermes, "#!/bin/sh\nexit 127\n");
  chmodSync(fakeHermes, 0o755);
  writeFileSync(join(home, "config.yaml"), configText);
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, HERMES_HOME: home, HERMES_BIN: fakeHermes };
  for (const key of ["AV_APPROVAL_ENABLED", "AV_RECALL_ENABLED", "AV_SLASH_ADMIN_IDS"]) delete env[key];
  const run = Bun.spawnSync({
    cmd: ["bun", join(REPO_ROOT, "install", "install.ts"), "--no-restart", "--skip-crons", "--skip-index"],
    cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe",
  });
  const statusPath = installStatusPath(home);
  const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : {};
  return { code: run.exitCode, stdout: run.stdout.toString(), status };
}

/** Fix round 2 (M1-M3): PyYAML merges these into a Telegram block that ungates; the `yaml` package does not. */
const MERGE_SHAPES = [
  ["M1 top level", "tdef: &t {telegram: {allow_admin_from: []}}\n<<: *t\n", "the top level"],
  ["M2 gateway", "gdef: &g {telegram: {extra: {allow_admin_from: []}}}\ngateway:\n  <<: *g\n", "gateway"],
  ["M3 gateway.platforms", "pdef: &p {telegram: {user_allowed_commands: [model]}}\ngateway:\n  platforms:\n    <<: *p\n", "gateway.platforms"],
] as const;

for (const [name, text, where] of MERGE_SHAPES) {
  test(`fix round 2 ${name}: a merge key fails closed, file byte-identical, install exits 1 with slash_access_failed`, () => {
    const why = `YAML merge key "<<" under ${where}`;
    const path = withText(text);
    expect(configureSlashAccess()).toBe(why);
    expect(readFileSync(path, "utf8")).toBe(text);
    const run = runInstall(text);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`agentvillage-install: slash_access_failed=${JSON.stringify(why)}`);
    expect(run.status.slash_access_failed).toBe(why);
  });
}

test("fix round 2: findMergeKey walks every depth, sequences included, and survives shared nodes", () => {
  expect(findMergeKey({ a: { b: [{ c: 1 }, { d: { "<<": {} } }] } })).toBe("a.b[1].d");
  const shared: Record<string, unknown> = { x: 1 };
  const cyclic: Record<string, unknown> = { a: shared, b: shared };
  cyclic.self = cyclic;
  expect(findMergeKey(cyclic)).toBeNull();
  expect(findMergeKey(YAML.parse("a: &x {k: 1}\nb: *x\n"))).toBeNull(); // anchors and aliases alone are fine
});

test("fix round 2: a config.yaml that cannot be parsed (duplicate key) records parse_error and exits 1", () => {
  const text = "platforms:\n  telegram: {}\nplatforms:\n  telegram: {allow_admin_from: []}\n";
  const path = withText(text);
  expect(configureSlashAccess()).toBe("parse_error");
  expect(readFileSync(path, "utf8")).toBe(text);
  const run = runInstall(text);
  expect(run.code).toBe(1);
  expect(run.stdout).toContain('agentvillage-install: slash_access_failed="parse_error"');
  expect(run.status.slash_access_failed).toBe("parse_error");
});

/** The mutation check: adding any admin-only name (e.g. `model`) to the resident list fails here. */
function adminOnlyLeaks(list: readonly string[]): string[] {
  return ADMIN_ONLY.filter((name) => list.includes(name));
}

test("the resident list holds no model, cost, tool or config command", () => {
  expect(adminOnlyLeaks(RESIDENT_SLASH_COMMANDS)).toEqual([]);
  expect(adminOnlyLeaks([...RESIDENT_SLASH_COMMANDS, "model"])).toEqual(["model"]);
  expect(Object.isFrozen(RESIDENT_SLASH_COMMANDS)).toBe(true);
  expect(new Set(RESIDENT_SLASH_COMMANDS).size).toBe(RESIDENT_SLASH_COMMANDS.length);
});

test.skipIf(!existsSync(join(HERMES_REF, "hermes_cli/commands.py")))(
  "every resident name is a canonical command in the Hermes registry, or one of the overlay's plugin commands",
  () => {
    const registry = readFileSync(join(HERMES_REF, "hermes_cli/commands.py"), "utf8");
    const names = new Set([...registry.matchAll(/CommandDef\("([a-z0-9_-]+)"/g)].map((m) => m[1]));
    const core = RESIDENT_SLASH_COMMANDS.filter((name) => !RESIDENT_PLUGIN_SLASH_COMMANDS.includes(name));
    expect(core.filter((name) => !names.has(name))).toEqual([]);
    // A plugin command never shadows a core one (Hermes refuses the registration: hermes_cli/plugins.py:670-675).
    expect(RESIDENT_PLUGIN_SLASH_COMMANDS.filter((name) => names.has(name))).toEqual([]);
  },
);

test("rc44: /village is a resident command, and av-display registers it", () => {
  expect(RESIDENT_PLUGIN_SLASH_COMMANDS).toEqual(["village"]);
  expect(RESIDENT_SLASH_COMMANDS).toContain("village");
  expect(RESIDENT_SLASH_COMMANDS.at(-1)).toBe("village");
  expect(Object.isFrozen(RESIDENT_PLUGIN_SLASH_COMMANDS)).toBe(true);
  expect(slashAccessKeys().user_allowed_commands).toContain("village");
  expect(slashAccessKeys().group_user_allowed_commands).toContain("village");
  const plugin = readFileSync(join(import.meta.dir, "..", "..", "plugins", "av-display", "__init__.py"), "utf8");
  expect(plugin).toContain('VILLAGE_COMMAND = "village"');
  expect(plugin).toContain("register_command(VILLAGE_COMMAND, village_command, description=VILLAGE_DESCRIPTION)");
});
