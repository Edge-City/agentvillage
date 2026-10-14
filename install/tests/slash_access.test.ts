/**
 * SEC-6: `configureSlashAccess` turns on Hermes's slash access control for Telegram, so a resident
 * runs only `RESIDENT_SLASH_COMMANDS` (plus `/help`, `/whoami`) and `/model` is admin-only.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { configureSlashAccess, RESIDENT_SLASH_COMMANDS, SLASH_NO_ADMIN, slashAccessKeys } from "../config";

const HERMES_REF = "/Users/carter/dev/hermes-agent-ref-v2026.9.24";
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

test("fresh config: writes the four keys under platforms.telegram.extra with the sentinel admin", () => {
  const path = withText(null);
  configureSlashAccess();
  const extra = read(path).platforms.telegram.extra;
  expect(extra).toEqual({
    allow_admin_from: [SLASH_NO_ADMIN],
    group_allow_admin_from: [SLASH_NO_ADMIN],
    user_allowed_commands: [...RESIDENT_SLASH_COMMANDS],
    group_user_allowed_commands: [...RESIDENT_SLASH_COMMANDS],
  });
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
  configureSlashAccess();
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

test("AV_SLASH_ADMIN_IDS sets both admin lists; unset falls back to the sentinel", () => {
  process.env.AV_SLASH_ADMIN_IDS = "1, 2,, ";
  const path = withText(null);
  configureSlashAccess();
  const extra = read(path).platforms.telegram.extra;
  expect(extra.allow_admin_from).toEqual(["1", "2"]);
  expect(extra.group_allow_admin_from).toEqual(["1", "2"]);
  // Numeric ids stay strings in the YAML (Hermes compares str(user_id)).
  expect(readFileSync(path, "utf8")).toContain('"1"');
  delete process.env.AV_SLASH_ADMIN_IDS;
  expect(slashAccessKeys().allow_admin_from).toEqual([SLASH_NO_ADMIN]);
  process.env.AV_SLASH_ADMIN_IDS = " , ";
  expect(slashAccessKeys().group_allow_admin_from).toEqual([SLASH_NO_ADMIN]);
});

test("a non-mapping telegram block is left alone with a warning", () => {
  const path = withText("platforms:\n  telegram: oops\n");
  configureSlashAccess();
  expect(readFileSync(path, "utf8")).toBe("platforms:\n  telegram: oops\n");
  expect(logged()).toContain("slash access NOT configured");
});

test("a root telegram: block holding a slash key is warned about, not edited", () => {
  const path = withText(YAML.stringify({ telegram: { allow_admin_from: ["5"] } }));
  configureSlashAccess();
  expect(read(path).telegram).toEqual({ allow_admin_from: ["5"] });
  expect(logged()).toContain("telegram sets allow_admin_from");
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
  "every resident name is a canonical command in the Hermes registry",
  () => {
    const registry = readFileSync(join(HERMES_REF, "hermes_cli/commands.py"), "utf8");
    const names = new Set([...registry.matchAll(/CommandDef\("([a-z0-9_-]+)"/g)].map((m) => m[1]));
    expect(RESIDENT_SLASH_COMMANDS.filter((name) => !names.has(name))).toEqual([]);
  },
);
