import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import {
  APPROVAL_GATED_TOOLS,
  APPROVAL_PLUGIN,
  ApprovalInstallError,
  ENV_NAME,
  SHIM_TOOLS,
  allowlistProblems,
  approvalChoice,
  approvalEnvLines,
  approvalProblems,
  approvalShimPath,
  approvalSurfacePath,
  assertEnvNames,
  checkApproval,
  checkCli,
  cronScripts,
  facadeUrlKind,
  installApproval,
  mergeApprovalHooks,
  mergeOrAliasPaths,
  pyStrip,
  runApprovalStep,
  tokenSource,
  type ApprovalOptions,
} from "../install_approval";

const REPO = join(import.meta.dir, "..", "..");
const SOURCE_SKILLS = join(REPO, "skills");
const SHIM_SOURCE = join(SOURCE_SKILLS, "approval", "scripts", "hermes-hook-shim.sh");
const ENV_NAMES = [
  "HERMES_HOME",
  "AV_APPROVAL_ENABLED",
  "AV_APPROVAL_URL",
  "AV_APPROVAL_TOKEN",
  "AV_APPROVAL_TOKEN_FILE",
  "AV_APPROVAL_DAEMON_UID",
  "AV_APPROVAL_ALLOW_UNPATCHED_HERMES",
  "AV_APPROVAL_HERMES_PYTHON",
  "TENANT_ID",
  "AV_TENANT_ID",
  "HERMES_ACCEPT_HOOKS",
  "HERMES_SAFE_MODE",
  "HERMES_MANAGED",
  "HERMES_MANAGED_DIR",
  "APPROVAL_HOOK_URL_ENV",
  "APPROVAL_HOOK_TOKEN_ENV",
  "APPROVAL_HOOK_WAIT_S",
  "PYTHONPATH",
  "FAKE_HERMES_STATE",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
const TOKEN = "agent-token-SENTINEL-0123";
const URL = "https://facade.example.test";
const TENANT = "11111111-2222-4333-8444-555555555555";
const PYTHON = Bun.which("python3");

const dirs: string[] = [];
let logs: string[] = [];
let errors: string[] = [];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  logs = [];
  errors = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A directory holding an executable stub for every program the shim resolves. */
function toolDir(omit: string[] = []): string {
  const dir = scratch("av-approval-tools-");
  for (const tool of SHIM_TOOLS) {
    if (omit.includes(tool)) continue;
    writeFileSync(join(dir, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// A fake Hermes for the live fire: the real live_selfcheck.py runs against
// these modules, driven by a JSON state file. Only what the script imports.
// ---------------------------------------------------------------------------

const FACADE_BLOCK = {
  returncode: 2,
  stdout: JSON.stringify({ action: "block", message: "hook-unsupported-execution-context: set workdir to an absolute path" }),
  parsed: { action: "block", message: "hook-unsupported-execution-context: set workdir to an absolute path" },
  error: null,
  timed_out: false,
};

interface FakeHermesState {
  release_date?: string;
  /** Behaviour: does a SIGKILLed fail_closed hook block? */
  signal_patch?: boolean;
  /** Behaviour: does a fail_closed hook that exits 1 with no output block? (stock Hermes: no) */
  exit1_patch?: boolean;
  /** Text: does shell_hooks.py carry the marker? Defaults to `signal_patch`. */
  signal_marker?: boolean;
  /** Specs Hermes's parser returns for the shim, in config order: [matcher, fail_closed]. Default: every gated matcher, fail_closed. */
  specs?: [string, boolean][];
  managed_dir?: string | null;
  run_once?: Record<string, unknown>;
  no_run_once?: boolean;
  fail_closed?: boolean;
  consent?: boolean;
}

function fakeHermes(state: FakeHermesState = {}): { kwargs: () => Record<string, unknown> | null } {
  const root = scratch("av-approval-fakehermes-");
  const full = {
    release_date: "2026.9.21",
    signal_patch: true,
    exit1_patch: false,
    managed_dir: null,
    run_once: FACADE_BLOCK,
    no_run_once: false,
    fail_closed: true,
    consent: true,
    specs: APPROVAL_GATED_TOOLS.map((m) => [m, true]),
    ...state,
  };
  const marker = state.signal_marker ?? full.signal_patch;
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify(full));
  mkdirSync(join(root, "hermes_cli"));
  mkdirSync(join(root, "agent"));
  writeFileSync(
    join(root, "hermes_cli", "__init__.py"),
    `import json, os\n_S = json.load(open(os.environ["FAKE_HERMES_STATE"]))\n__version__ = "0.0.0-fake"\n__release_date__ = _S["release_date"]\n`,
  );
  writeFileSync(
    join(root, "hermes_cli", "env_loader.py"),
    `import os\ndef load_hermes_dotenv(hermes_home=None, **_):\n    p = os.path.join(hermes_home or os.environ["HERMES_HOME"], ".env")\n    if not os.path.exists(p):\n        return\n    for line in open(p):\n        line = line.strip()\n        if line and not line.startswith("#") and "=" in line:\n            k, v = line.split("=", 1)\n            os.environ[k.strip()] = v.strip()\n`,
  );
  writeFileSync(join(root, "hermes_cli", "config.py"), `def load_config():\n    return {}\n`);
  writeFileSync(
    join(root, "hermes_cli", "managed_scope.py"),
    `import json, os\ndef get_managed_dir():\n    return json.load(open(os.environ["FAKE_HERMES_STATE"]))["managed_dir"]\n`,
  );
  writeFileSync(join(root, "agent", "__init__.py"), "");
  writeFileSync(
    join(root, "agent", "shell_hooks.py"),
    `${marker ? "# approval.md patch: signal-killed hook fails closed\n" : ""}import json, os, re
_S = json.load(open(os.environ["FAKE_HERMES_STATE"]))
class ShellHookSpec:
    def __init__(self, event, command, matcher=None, timeout=60, fail_closed=False):
        self.event, self.matcher, self.command, self.fail_closed, self.timeout = event, matcher, command, fail_closed, timeout
    def matches_tool(self, name):
        return re.fullmatch(self.matcher, name) is not None
def iter_configured_hooks(cfg):
    shim = os.path.join(os.environ["HERMES_HOME"], "agent-hooks", "hermes-hook-shim.sh")
    return [ShellHookSpec("pre_tool_call", shim, m, 300, fc and _S["fail_closed"]) for m, fc in _S["specs"]]
def _resolve_effective_accept(cfg, arg):
    return _S["consent"]
def allowlist_path():
    import pathlib
    return pathlib.Path(os.environ["HERMES_HOME"]) / "shell-hooks-allowlist.json"
def allowlist_entry_for(event, command):
    try:
        data = json.load(open(allowlist_path()))
    except Exception:
        return None
    return next((e for e in data.get("approvals", []) if e.get("event") == event and e.get("command") == command), None)
${full.no_run_once ? "" : `def run_once(spec, kwargs):
    if spec.command.endswith("killed.sh"):
        assert spec.fail_closed is True and open(spec.command).read().strip().endswith("kill -9 $$")
        blocked = {"action": "block", "message": "hook killed by signal 9"} if _S["signal_patch"] else None
        return {"returncode": -9, "stdout": "", "parsed": blocked, "error": None, "timed_out": False}
    if spec.command.endswith("exit1.sh"):
        assert spec.fail_closed is True and open(spec.command).read().strip().endswith("exit 1")
        blocked = {"action": "block", "message": "hook exited 1 without a directive"} if _S["exit1_patch"] else None
        return {"returncode": 1, "stdout": "", "parsed": blocked, "error": None, "timed_out": False}
    with open(os.environ["FAKE_HERMES_STATE"] + ".kwargs", "w") as fh:
        json.dump(kwargs, fh)
    return dict(_S["run_once"])
`}`,
  );
  process.env.PYTHONPATH = root;
  process.env.FAKE_HERMES_STATE = statePath;
  return {
    kwargs: () => (existsSync(`${statePath}.kwargs`) ? JSON.parse(readFileSync(`${statePath}.kwargs`, "utf8")) : null),
  };
}

/** Options for a run that should pass: stub tools, no managed scope, the fake Hermes. */
function opts(extra: ApprovalOptions = {}): ApprovalOptions {
  if (!PYTHON) throw new Error("python3 is required for the live self-check tests");
  if (!process.env.FAKE_HERMES_STATE) fakeHermes();
  return { toolDirs: [toolDir()], managedDir: join(tmpdir(), "av-approval-no-managed-scope"), hermesPython: PYTHON, ...extra };
}

const OPERATOR_HOOK = { matcher: "terminal", command: "/usr/local/bin/operator-audit.sh", timeout: 30 };
const BASE_CONFIG = {
  model: { default: "openrouter/some-model", max_tokens: 4096 },
  terminal: { cwd: "/home/hermes/.hermes" },
  platforms: { telegram: { extra: { drop_pending_on_cold_boot: false } } },
  plugins: { enabled: ["dashboard-auth-edgecity", "av-events"], disabled: ["something"] },
  hooks: {
    pre_tool_call: [OPERATOR_HOOK],
    post_tool_call: [{ command: "/usr/local/bin/operator-post.sh" }],
  },
  approvals: { mode: false },
};

/** A tenant home named `.hermes`. `env` lines go into `$HERMES_HOME/.env`, the way the control plane delivers them. */
function tenant(o: { config?: unknown; env?: Record<string, string>; rawConfig?: string; homeName?: string } = {}): string {
  const home = join(scratch("av-approval-home-"), o.homeName ?? ".hermes");
  mkdirSync(home);
  process.env.HERMES_HOME = home;
  if (o.rawConfig !== undefined) writeFileSync(join(home, "config.yaml"), o.rawConfig);
  else writeFileSync(join(home, "config.yaml"), YAML.stringify(o.config ?? BASE_CONFIG));
  const env = o.env ?? {
    AV_APPROVAL_ENABLED: "1",
    AV_APPROVAL_URL: URL,
    AV_APPROVAL_TOKEN: TOKEN,
    TENANT_ID: TENANT,
  };
  const lines = ["# written by the control plane", "AV_EVENTS_TOKEN=keep-me", "", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  writeFileSync(join(home, ".env"), `${lines.join("\n")}\n`);
  return home;
}

function appendEnv(home: string, line: string): void {
  writeFileSync(join(home, ".env"), `${readFileSync(join(home, ".env"), "utf8")}${line}\n`);
}

function config(home: string): Record<string, any> {
  return YAML.parse(readFileSync(join(home, "config.yaml"), "utf8"));
}

function ourEntries(home: string): Record<string, unknown>[] {
  return (config(home).hooks?.pre_tool_call ?? []).filter((e: any) => e?.command === approvalShimPath());
}

function bytes(home: string): { config: string; env: string } {
  return { config: readFileSync(join(home, "config.yaml"), "utf8"), env: readFileSync(join(home, ".env"), "utf8") };
}

function expectInstallError(fn: () => unknown, code: string): ApprovalInstallError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApprovalInstallError);
    expect((err as ApprovalInstallError).code).toBe(code);
    return err as ApprovalInstallError;
  }
  throw new Error(`expected ${code}, nothing was thrown`);
}

function failsWith(problem: string, o: ApprovalOptions = opts()): void {
  const err = expectInstallError(() => installApproval(SOURCE_SKILLS, o), "approval-selfcheck-failed");
  expect(err.message).toContain(problem);
}

describe("approvalChoice and where values are read (L2)", () => {
  test("unset or blank is no choice; 1|true|yes|on is on; anything else is off", () => {
    tenant({ env: {} });
    expect(approvalChoice()).toBe("unset");
    process.env.AV_APPROVAL_ENABLED = "  ";
    expect(approvalChoice()).toBe("unset");
    for (const on of ["1", "true", "YES", " On "]) {
      process.env.AV_APPROVAL_ENABLED = on;
      expect(approvalChoice()).toBe("on");
    }
    for (const off of ["0", "off", "disabled", "enable", "n"]) {
      process.env.AV_APPROVAL_ENABLED = off;
      expect(approvalChoice()).toBe("off");
    }
  });

  test(".env wins over the process environment, as Hermes's override load does", () => {
    tenant({ env: { AV_APPROVAL_ENABLED: "1" } });
    process.env.AV_APPROVAL_ENABLED = "0";
    expect(approvalChoice()).toBe("on");
    tenant({ env: { AV_APPROVAL_ENABLED: "0" } });
    process.env.AV_APPROVAL_ENABLED = "1";
    expect(approvalChoice()).toBe("off");
  });

  test("a URL and token in .env win over different ones in the process environment", () => {
    const home = tenant();
    process.env.AV_APPROVAL_URL = "http://not-this-one";
    process.env.AV_APPROVAL_TOKEN = "not this one";
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(ourEntries(home)).toHaveLength(APPROVAL_GATED_TOOLS.length);
  });
});

describe("off by default and misconfiguration (A.7)", () => {
  test("unset: a no-op that logs one line and writes nothing", () => {
    const home = tenant({ env: {} });
    const before = bytes(home);
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("skipped");
    expect(logs).toEqual(["→ skipped approval gate (opt-in: AV_APPROVAL_ENABLED=1)"]);
    expect(bytes(home)).toEqual(before);
    expect(existsSync(approvalShimPath())).toBe(false);
  });

  test("on without URL and token fails with a named reason, writes nothing, prints no secret", () => {
    const home = tenant({ env: { AV_APPROVAL_ENABLED: "1" } });
    const before = bytes(home);
    const err = expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-credentials-missing");
    expect(err.message).toContain("AV_APPROVAL_URL and AV_APPROVAL_TOKEN are not set");
    expect(bytes(home)).toEqual(before);
    expect(existsSync(approvalShimPath())).toBe(false);
  });

  test("on with only the token missing names the token; a blank value counts as missing", () => {
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: URL } });
    const err = expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-credentials-missing");
    expect(err.message).toContain("AV_APPROVAL_TOKEN is not set");
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: URL, AV_APPROVAL_TOKEN: "  " } });
    expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-credentials-missing");
  });

  test("a non-https URL and a malformed token are refused before anything is written", () => {
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: "http://facade.example.test", AV_APPROVAL_TOKEN: TOKEN } });
    expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-url-not-https");
    expect(existsSync(approvalShimPath())).toBe(false);
    const home = tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: URL, AV_APPROVAL_TOKEN: '"quoted' } });
    const err = expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-token-malformed");
    expect(err.message).not.toContain('"quoted');
    expect(ourEntries(home)).toEqual([]);
  });

  test("runApprovalStep reports the code, returns false, and never prints the token", () => {
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_TOKEN: TOKEN } });
    expect(runApprovalStep(SOURCE_SKILLS, opts())).toBe(false);
    expect(errors.join("\n")).toContain("✗ approval gate: approval-credentials-missing:");
    expect([...logs, ...errors].join("\n")).not.toContain(TOKEN);
  });

  test("install.ts runs the step before the restart and exits non-zero when it fails", () => {
    const source = readFileSync(join(REPO, "install", "install.ts"), "utf8");
    const step = source.indexOf("runApprovalStep(SOURCE_SKILLS)");
    const restart = source.indexOf("restartGateway();\n  }");
    expect(step).toBeGreaterThan(0);
    expect(restart).toBeGreaterThan(step);
    expect(source.slice(step, restart)).toContain("process.exit(1)");
  });
});

describe("installing the gate", () => {
  test("writes the hooks block, consent in both places, the shim, the skill, the plugin and the marker", () => {
    const home = tenant();
    const hermes = fakeHermes();
    expect(installApproval(SOURCE_SKILLS, opts({ now: new Date("2026-10-01T09:00:00Z") }))).toBe("installed");

    const doc = config(home);
    const ours = ourEntries(home);
    expect(ours.map((e) => e.matcher)).toEqual([...APPROVAL_GATED_TOOLS]);
    for (const entry of ours) {
      expect(entry).toEqual({ matcher: entry.matcher, command: approvalShimPath(), timeout: 300, fail_closed: true });
    }
    expect(doc.hooks_auto_accept).toBe(true);
    expect(doc.plugins.hook_callback_timeout).toBe(600);
    expect(doc.plugins.enabled).toContain(APPROVAL_PLUGIN);

    const env = readFileSync(join(home, ".env"), "utf8");
    for (const line of [
      "HERMES_ACCEPT_HOOKS=1",
      "APPROVAL_HOOK_URL_ENV=AV_APPROVAL_URL",
      "APPROVAL_HOOK_TOKEN_ENV=AV_APPROVAL_TOKEN",
      "APPROVAL_HOOK_WAIT_S=280",
      `AV_APPROVAL_TOKEN=${TOKEN}`,
      "AV_EVENTS_TOKEN=keep-me",
    ]) {
      expect(env.split("\n")).toContain(line);
    }

    const shim = approvalShimPath();
    expect(shim).toBe(join(home, "agent-hooks", "hermes-hook-shim.sh"));
    expect(statSync(shim).mode & 0o777).toBe(0o700);
    expect(readFileSync(shim, "utf8")).toBe(readFileSync(SHIM_SOURCE, "utf8"));
    expect(existsSync(join(home, "skills", "approval", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "APPROVAL.md"))).toBe(false);

    expect(approvalSurfacePath()).toBe(join(home, "agent-hooks", "approval-surface.json"));
    const marker = JSON.parse(readFileSync(approvalSurfacePath(), "utf8"));
    expect(marker).toEqual({
      daemon_id: null,
      tenant_id: TENANT,
      installed_at: "2026-10-01T09:00:00.000Z",
      overrides: [],
      prior: {
        config: { hooks_auto_accept: { present: false }, "plugins.hook_callback_timeout": { present: false } },
        env: {
          HERMES_ACCEPT_HOOKS: { present: false },
          APPROVAL_HOOK_URL_ENV: { present: false },
          APPROVAL_HOOK_TOKEN_ENV: { present: false },
          APPROVAL_HOOK_WAIT_S: { present: false },
        },
      },
      shim_sha256: createHash("sha256").update(readFileSync(SHIM_SOURCE)).digest("hex"),
    });
    expect(statSync(approvalSurfacePath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, "agent-hooks")).sort()).toEqual(["approval-surface.json", "hermes-hook-shim.sh"]);

    // The live fire: one terminal call, deliberately without a workdir.
    expect(hermes.kwargs()).toEqual({ tool_name: "terminal", args: { command: "ls /tmp" }, session_id: "av-approval-selfcheck" });
    expect(logs.at(-1)).toContain("approval gate installed: 13 pre_tool_call entries (fail_closed)");
    expect(logs.at(-1)).toContain("live: blocked by the facade), overrides: none");
    expect([...logs, ...errors].join("\n")).not.toContain(TOKEN);
    expect(readFileSync(join(home, "config.yaml"), "utf8")).not.toContain(TOKEN);
  });

  test("H1 + DATA-234 G3: the extra tools are routed through the gate, cronjob_manage and send_message included", () => {
    const home = tenant();
    installApproval(SOURCE_SKILLS, opts());
    const matchers = ourEntries(home).map((e) => String(e.matcher));
    const covers = (tool: string) => matchers.some((m) => new RegExp(`^(?:${m})$`).test(tool));
    for (const tool of [
      "process",
      "process_manage",
      "web_extract",
      "browser_navigate",
      "browser_click",
      "browser_exec",
      "browser_cdp",
      "skill_manage",
      "delegate_task",
      "cronjob_manage",
      "cronjob",
      "send_message",
    ]) {
      expect(covers(tool)).toBe(true);
    }
    // Full-match: a prefix is not the tool.
    for (const tool of ["cronjob_manager", "send_message_x", "mcp_index_search", "memory"]) expect(covers(tool)).toBe(false);
  });

  test("idempotent: a second run changes no byte of config.yaml or .env and keeps installed_at", () => {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, { ...o, now: new Date("2026-10-01T09:00:00Z") });
    const first = bytes(home);
    installApproval(SOURCE_SKILLS, { ...o, now: new Date("2026-10-02T09:00:00Z") });
    expect(bytes(home)).toEqual(first);
    expect(ourEntries(home)).toHaveLength(APPROVAL_GATED_TOOLS.length);
    expect(config(home).plugins.enabled.filter((n: string) => n === APPROVAL_PLUGIN)).toHaveLength(1);
    expect(JSON.parse(readFileSync(approvalSurfacePath(), "utf8")).installed_at).toBe("2026-10-01T09:00:00.000Z");
    expect(logs.at(-1)).toContain("config unchanged, 0 .env line(s) set");
  });

  test("never clobbers unrelated keys, other hooks or other plugins", () => {
    const home = tenant();
    installApproval(SOURCE_SKILLS, opts());
    const doc = config(home);
    expect(doc.model).toEqual(BASE_CONFIG.model);
    expect(doc.terminal).toEqual(BASE_CONFIG.terminal);
    expect(doc.platforms).toEqual(BASE_CONFIG.platforms);
    expect(doc.approvals).toEqual(BASE_CONFIG.approvals);
    expect(doc.plugins.disabled).toEqual(["something"]);
    expect(doc.plugins.enabled.slice(0, 2)).toEqual(["dashboard-auth-edgecity", "av-events"]);
    expect(doc.hooks.pre_tool_call[0]).toEqual(OPERATOR_HOOK);
    expect(doc.hooks.post_tool_call).toEqual(BASE_CONFIG.hooks.post_tool_call);
  });

  test("an entry of ours left with fail_closed off, or spelled with $HERMES_HOME, is replaced", () => {
    const home = tenant();
    const stale = {
      ...BASE_CONFIG,
      hooks: {
        pre_tool_call: [
          OPERATOR_HOOK,
          { matcher: "terminal", command: approvalShimPath(), timeout: 60, fail_closed: false },
          { matcher: "write_file", command: "$HERMES_HOME/agent-hooks/hermes-hook-shim.sh" },
        ],
      },
    };
    writeFileSync(join(home, "config.yaml"), YAML.stringify(stale));
    installApproval(SOURCE_SKILLS, opts());
    const pre = config(home).hooks.pre_tool_call as any[];
    expect(pre[0]).toEqual(OPERATOR_HOOK);
    expect(pre.slice(1)).toHaveLength(APPROVAL_GATED_TOOLS.length);
    expect(pre.slice(1).every((e) => e.fail_closed === true && e.timeout === 300 && e.command === approvalShimPath())).toBe(true);
  });

  test("an empty or absent config.yaml gets the gate", () => {
    const home = tenant({ rawConfig: "" });
    installApproval(SOURCE_SKILLS, opts());
    expect(ourEntries(home)).toHaveLength(APPROVAL_GATED_TOOLS.length);
    rmSync(join(home, "config.yaml"));
    installApproval(SOURCE_SKILLS, opts());
    expect(ourEntries(home)).toHaveLength(APPROVAL_GATED_TOOLS.length);
  });

  test("credentials only in the process environment are enough (Railway-injected sandbox env)", () => {
    const home = tenant({ env: {} });
    process.env.AV_APPROVAL_ENABLED = "1";
    process.env.AV_APPROVAL_URL = URL;
    process.env.AV_APPROVAL_TOKEN = TOKEN;
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain(TOKEN);
    expect(JSON.parse(readFileSync(approvalSurfacePath(), "utf8")).tenant_id).toBeNull();
    expect(logs.at(-1)).toContain("no TENANT_ID");
  });

  test("shapes it cannot merge into are refused with a named reason and left untouched", () => {
    for (const raw of [
      "hooks:\n  - not a mapping\n",
      "hooks:\n  pre_tool_call: {matcher: terminal}\n",
      "plugins: [a, b]\n",
      "- a\n- b\n",
      "base: &b {x: 1}\nhooks:\n  <<: *b\n",
    ]) {
      const home = tenant({ rawConfig: raw });
      expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-config-unmergeable");
      expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(raw);
    }
  });

  test("mergeApprovalHooks is pure: the input document is not mutated", () => {
    const input = structuredClone(BASE_CONFIG);
    const snapshot = structuredClone(input);
    mergeApprovalHooks(input, "/x/agent-hooks/hermes-hook-shim.sh");
    expect(input).toEqual(snapshot);
  });
});

describe("M1: YAML merge keys and aliases anywhere under hooks or plugins", () => {
  test("the reproduction: an anchor with fail_closed false merged into a terminal entry fails the install", () => {
    const home = tenant({ rawConfig: "" });
    const raw = `x-gate: &g
  command: ${approvalShimPath()}
  timeout: 300
  fail_closed: false
hooks:
  pre_tool_call:
    - <<: *g
      matcher: terminal
`;
    writeFileSync(join(home, "config.yaml"), raw);
    const err = expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-config-unmergeable");
    expect(err.message).toContain("hooks.pre_tool_call[0].<<");
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(raw);
    expect(existsSync(approvalShimPath())).toBe(false);
  });

  test("an alias value deep under hooks, and a merge under plugins, are found and named", () => {
    expect(mergeOrAliasPaths("t: &t 300\nhooks:\n  pre_tool_call:\n    - matcher: terminal\n      timeout: *t\n")).toEqual([
      "hooks.pre_tool_call[0].timeout",
    ]);
    expect(mergeOrAliasPaths("p: &p {hook_callback_timeout: 30}\nplugins:\n  <<: *p\n")).toEqual(["plugins.<<", "plugins.<<"]);
    expect(mergeOrAliasPaths("hooks: &h {}\nother: *h\n")).toEqual([]);
  });

  test("the self-check names one planted after install", () => {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    const text = readFileSync(join(home, "config.yaml"), "utf8");
    writeFileSync(join(home, "config.yaml"), `x: &f false\n${text.replace("fail_closed: true", "fail_closed: *f")}`);
    expect(approvalProblems(o).some((p) => p.startsWith("yaml-merge-or-alias:hooks.pre_tool_call["))).toBe(true);
  });
});

describe("M2: symlinks and non-regular files are refused", () => {
  for (const target of ["agent-hooks", "agent-hooks/hermes-hook-shim.sh", "config.yaml", ".env"] as const) {
    test(`a planted symlink at ${target} fails the install and the link target is untouched`, () => {
      const home = tenant();
      const victim = join(scratch("av-approval-outside-"), "victim");
      if (target === "agent-hooks") {
        mkdirSync(victim);
        symlinkSync(victim, join(home, "agent-hooks"));
      } else {
        if (target.startsWith("agent-hooks/")) mkdirSync(join(home, "agent-hooks"));
        const original = join(home, target);
        if (existsSync(original)) renameSync(original, victim);
        else writeFileSync(victim, "#!/bin/sh\necho '{}'\n");
        symlinkSync(victim, original);
      }
      const victimBefore = target === "agent-hooks" ? "" : readFileSync(victim, "utf8");
      const err = expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-path-unsafe");
      expect(err.message).toContain(`path-symlink:${target}`);
      if (target === "agent-hooks") expect(readdirSync(victim)).toEqual([]);
      else expect(readFileSync(victim, "utf8")).toBe(victimBefore);
    });
  }

  test("a directory where the shim should be is refused as not regular", () => {
    tenant();
    mkdirSync(join(process.env.HERMES_HOME!, "agent-hooks", "hermes-hook-shim.sh"), { recursive: true });
    const err = expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-path-unsafe");
    expect(err.message).toContain("path-not-regular:agent-hooks/hermes-hook-shim.sh");
  });
});

describe("M3: the live self-check and --check", () => {
  test("a facade allow on the no-workdir call fails the install and rolls config and .env back (L4)", () => {
    const home = tenant();
    const before = bytes(home);
    fakeHermes({ run_once: { returncode: 0, stdout: "{}", parsed: null, error: null, timed_out: false } });
    failsWith("live-call-allowed");
    expect(bytes(home)).toEqual(before);
    expect(existsSync(approvalSurfacePath())).toBe(false);
    expect(errors.join("")).toBe("");
  });

  test("a block the shim made on its own (facade unreachable) fails", () => {
    tenant();
    fakeHermes({
      run_once: {
        returncode: 2,
        stdout: JSON.stringify({ action: "block", message: "approval facade unreachable: transport failure (curl exit 7)" }),
        parsed: { action: "block", message: "x" },
        error: null,
        timed_out: false,
      },
    });
    failsWith("live-facade-unreachable");
  });

  test("a hook that timed out or could not be spawned fails", () => {
    tenant();
    fakeHermes({ run_once: { returncode: null, stdout: "", parsed: null, error: null, timed_out: true } });
    failsWith("live-hook-timed-out");
    tenant();
    fakeHermes({ run_once: { returncode: null, stdout: "", parsed: null, error: "no such file", timed_out: false } });
    failsWith("live-hook-not-spawned");
  });

  test("no Hermes interpreter, or a Hermes without run_once: selfcheck-live-unavailable, fail closed", () => {
    tenant();
    failsWith("selfcheck-live-unavailable:no-hermes-interpreter", opts({ hermesPython: null }));
    tenant();
    fakeHermes({ no_run_once: true });
    failsWith("selfcheck-live-unavailable:hermes-modules");
  });

  test("--check writes nothing, exits 0 on an installed gate and 1 with named problems", () => {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    const before = bytes(home);
    logs = [];
    expect(checkCli(["--check"], o)).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toEqual({
      check: "av-approval",
      ok: true,
      problems: [],
      overrides: [],
      hermes_exit1: "allowed",
      cron_scripts: [],
    });
    expect(bytes(home)).toEqual(before);
    expect(checkCli([], o)).toBe(2);
  });

  test("hand step 4: removing headless consent makes --check FAIL (it never re-adds it)", () => {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    const envPath = join(home, ".env");
    writeFileSync(envPath, readFileSync(envPath, "utf8").replace("HERMES_ACCEPT_HOOKS=1\n", ""));
    const after = bytes(home);
    logs = [];
    expect(checkCli(["--check"], o)).toBe(1);
    expect(JSON.parse(logs.at(-1)!).problems).toEqual(["consent-missing:env.HERMES_ACCEPT_HOOKS"]);
    expect(bytes(home)).toEqual(after);
  });

  test("--check on a tenant that has not opted in says so", () => {
    tenant({ env: {} });
    expect(checkApproval(opts())).toEqual(["approval-not-enabled"]);
  });
});

describe("M4: states in which Hermes ignores the gate", () => {
  test("HERMES_SAFE_MODE, HERMES_MANAGED and HERMES_MANAGED_DIR in .env are each refused", () => {
    for (const [line, problem] of [
      ["HERMES_SAFE_MODE=1", "hermes-safe-mode"],
      ["HERMES_MANAGED=homebrew", "hermes-managed"],
      ["HERMES_MANAGED_DIR=/etc/elsewhere", "hermes-managed-scope"],
    ] as const) {
      const home = tenant();
      appendEnv(home, line);
      failsWith(problem);
    }
  });

  test("a managed overlay config file, and a managed scope Hermes itself reports, are refused", () => {
    tenant();
    const managed = scratch("av-approval-managed-");
    writeFileSync(join(managed, "config.yaml"), "hooks: {}\n");
    failsWith("hermes-managed-scope", opts({ managedDir: managed }));
    tenant();
    fakeHermes({ managed_dir: "/etc/hermes" });
    failsWith("hermes-managed-scope");
  });

  test("a HERMES_HOME not named .hermes is refused (the classifier would not protect it)", () => {
    tenant({ homeName: "data" });
    failsWith("hermes-home-not-dot-hermes");
  });

  test("a build below the fail_closed floor is refused; the dogfood override accepts it loudly", () => {
    tenant();
    fakeHermes({ release_date: "2026.9.14" });
    failsWith("hermes-below-fail-closed-floor:2026.9.14");
    const home = tenant();
    appendEnv(home, "AV_APPROVAL_ALLOW_UNPATCHED_HERMES=1");
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(errors.join("\n")).toContain("!! approval gate: AV_APPROVAL_ALLOW_UNPATCHED_HERMES=1 accepts hermes-below-fail-closed-floor");
    expect(errors.join("\n")).toContain("DOGFOOD ONLY");
  });

  test("H2: a Hermes without the signal-fail-closed patch marker is refused unless overridden", () => {
    tenant();
    fakeHermes({ signal_patch: false });
    failsWith("hermes-signal-patch-missing(marker:absent)");
    const home = tenant();
    appendEnv(home, "AV_APPROVAL_ALLOW_UNPATCHED_HERMES=1");
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(errors.join("\n")).toContain("accepts hermes-signal-patch-missing");
  });

  test("R2-4: the patch is judged by behaviour: a marker without the behaviour fails, the behaviour without the marker passes", () => {
    tenant();
    fakeHermes({ signal_patch: false, signal_marker: true });
    failsWith("hermes-signal-patch-missing(marker:present)");
    tenant();
    fakeHermes({ signal_patch: true, signal_marker: false });
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
  });

  test("R2-3: an accepted override shows in the success line, the marker and --check", () => {
    const home = tenant();
    appendEnv(home, "AV_APPROVAL_ALLOW_UNPATCHED_HERMES=1");
    fakeHermes({ signal_patch: false });
    const o = opts();
    expect(installApproval(SOURCE_SKILLS, o)).toBe("installed");
    const expected = ["AV_APPROVAL_ALLOW_UNPATCHED_HERMES:hermes-signal-patch-missing(marker:absent)"];
    expect(logs.at(-1)).toContain(`overrides: ${expected[0]}`);
    expect(JSON.parse(readFileSync(approvalSurfacePath(), "utf8")).overrides).toEqual(expected);
    logs = [];
    expect(checkCli(["--check"], o)).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toEqual({
      check: "av-approval",
      ok: true,
      problems: [],
      overrides: expected,
      hermes_exit1: "allowed",
      cron_scripts: [],
    });
  });

  test("Hermes reporting no effective consent, or a terminal entry it parses as not fail_closed, fails", () => {
    tenant();
    fakeHermes({ consent: false });
    failsWith("consent-missing:hermes-effective");
    tenant();
    fakeHermes({ fail_closed: false });
    failsWith("live-not-fail-closed:terminal");
  });
});

describe("static self-check: named reasons", () => {
  function installed(): { home: string; o: ApprovalOptions } {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    return { home, o };
  }

  test("passes on a fresh install", () => {
    const { o } = installed();
    expect(approvalProblems(o)).toEqual([]);
  });

  test("a program the shim needs is missing: the install fails, naming it", () => {
    tenant();
    const err = expectInstallError(
      () => installApproval(SOURCE_SKILLS, opts({ toolDirs: [toolDir(["node", "curl"])] })),
      "approval-selfcheck-failed",
    );
    expect(err.message).toContain("shim-tool-missing:curl");
    expect(err.message).toContain("shim-tool-missing:node");
  });

  test("headless consent removed from either place is named", () => {
    const { home, o } = installed();
    const envPath = join(home, ".env");
    writeFileSync(envPath, readFileSync(envPath, "utf8").replace("HERMES_ACCEPT_HOOKS=1\n", ""));
    const doc = config(home);
    doc.hooks_auto_accept = false;
    writeFileSync(join(home, "config.yaml"), YAML.stringify(doc));
    expect(approvalProblems(o)).toEqual(["consent-missing:config.hooks_auto_accept", "consent-missing:env.HERMES_ACCEPT_HOOKS"]);
  });

  test("fail_closed off, a wrong timeout, a missing entry and a low callback cap are each named", () => {
    const { home, o } = installed();
    const doc = config(home);
    const pre = doc.hooks.pre_tool_call as any[];
    pre.find((e) => e.matcher === "terminal" && e.command === approvalShimPath()).fail_closed = false;
    pre.find((e) => e.matcher === "patch").timeout = 60;
    doc.hooks.pre_tool_call = pre.filter((e) => e.matcher !== "execute_code");
    doc.plugins.hook_callback_timeout = 30;
    writeFileSync(join(home, "config.yaml"), YAML.stringify(doc));
    expect(approvalProblems(o)).toEqual([
      "hook-missing:execute_code",
      "fail-closed-off:terminal",
      "entry-timeout:patch",
      "callback-timeout-not-above-entry",
    ]);
  });

  test("a shim that is missing, not executable or loosened is named", () => {
    const { o } = installed();
    chmodSync(approvalShimPath(), 0o644);
    expect(approvalProblems(o)).toEqual(["shim-not-executable"]);
    chmodSync(approvalShimPath(), 0o755);
    expect(approvalProblems(o)).toEqual(["shim-mode-not-0700"]);
    rmSync(approvalShimPath());
    expect(approvalProblems(o)).toEqual(["shim-missing"]);
  });

  test("env names the shim reads that do not resolve, and a bad wait window, are named", () => {
    const { home, o } = installed();
    const envPath = join(home, ".env");
    const text = readFileSync(envPath, "utf8")
      .replace(`AV_APPROVAL_TOKEN=${TOKEN}\n`, "")
      .replace("APPROVAL_HOOK_URL_ENV=AV_APPROVAL_URL", "APPROVAL_HOOK_URL_ENV=HOSTED_DOGFOOD_FACADE_URL")
      .replace("APPROVAL_HOOK_WAIT_S=280", "APPROVAL_HOOK_WAIT_S=300");
    writeFileSync(envPath, text);
    expect(approvalProblems(o)).toEqual([
      "env-unresolvable:HOSTED_DOGFOOD_FACADE_URL",
      "env-unresolvable:AV_APPROVAL_TOKEN",
      "wait-window-invalid",
    ]);
  });
});

describe("kill switch (L3): AV_APPROVAL_ENABLED off is fail-open, says so, and takes consent with it", () => {
  test("removes our entries, consent in both places, the callback cap, our .env lines, the shim, skill and marker", () => {
    const home = tenant();
    installApproval(SOURCE_SKILLS, opts());
    const envPath = join(home, ".env");
    writeFileSync(envPath, readFileSync(envPath, "utf8").replace("AV_APPROVAL_ENABLED=1", "AV_APPROVAL_ENABLED=0"));
    logs = [];
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("disabled");
    const doc = config(home);
    expect(doc.hooks.pre_tool_call).toEqual([OPERATOR_HOOK]);
    expect(doc.hooks.post_tool_call).toEqual(BASE_CONFIG.hooks.post_tool_call);
    expect("hooks_auto_accept" in doc).toBe(false);
    expect("hook_callback_timeout" in doc.plugins).toBe(false);
    // L1: the plugin stays listed so the gateway logs `av-approval: disabled (fail-open)`.
    expect(doc.plugins.enabled).toContain(APPROVAL_PLUGIN);
    const env = readFileSync(envPath, "utf8");
    for (const name of ["HERMES_ACCEPT_HOOKS", "APPROVAL_HOOK_URL_ENV", "APPROVAL_HOOK_TOKEN_ENV", "APPROVAL_HOOK_WAIT_S"]) {
      expect(env).not.toContain(`${name}=`);
    }
    expect(env).toContain("AV_EVENTS_TOKEN=keep-me");
    expect(existsSync(approvalShimPath())).toBe(false);
    expect(existsSync(approvalSurfacePath())).toBe(false);
    expect(existsSync(join(home, "skills", "approval"))).toBe(false);
    expect(logs.join("\n")).toContain("removed 13 pre_tool_call entries");
    expect(logs.join("\n")).toContain("FAIL-OPEN");
  });

  test("off on a tenant that never installed it changes nothing in config.yaml", () => {
    const home = tenant({ env: { AV_APPROVAL_ENABLED: "off" }, config: { model: { default: "m" } } });
    const before = readFileSync(join(home, "config.yaml"), "utf8");
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("disabled");
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(before);
    expect(logs).toEqual(["→ approval gate off (AV_APPROVAL_ENABLED off); no gate entries were installed"]);
  });
});

describe("R2-1: commands compared the way Hermes strips them", () => {
  test("the \\x1F reproduction: a trailing control char is the same hook to Hermes, so it is replaced", () => {
    const home = tenant();
    const raw = YAML.stringify({
      hooks: { pre_tool_call: [OPERATOR_HOOK, { matcher: "terminal", command: `${approvalShimPath()}\x1f`, timeout: 300 }] },
    });
    writeFileSync(join(home, "config.yaml"), raw);
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    const pre = config(home).hooks.pre_tool_call as any[];
    expect(pre[0]).toEqual(OPERATOR_HOOK);
    expect(pre.slice(1).map((e) => e.command)).toEqual(APPROVAL_GATED_TOOLS.map(() => approvalShimPath()));
    expect(pre.slice(1).every((e) => e.fail_closed === true)).toBe(true);
  });

  test("pyStrip strips Python's whitespace set, not JavaScript's", () => {
    expect(pyStrip("x\x1c\x1d\x1e\x1f\x85 \t")).toBe("x");
    expect(pyStrip("\ufeffx")).toBe("\ufeffx");
    expect("x\x1f".trim()).toBe("x\x1f");
  });

  test("the static self-check sees a planted \\x1F entry as ours and names it", () => {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    const doc = config(home);
    doc.hooks.pre_tool_call.unshift({ matcher: "read_file", command: `${approvalShimPath()}\x1f`, timeout: 300 });
    writeFileSync(join(home, "config.yaml"), YAML.stringify(doc));
    expect(approvalProblems(o)).toContain("fail-closed-off:read_file");
  });

  test("the live check judges the FIRST spec Hermes parses for every gated matcher, not only terminal", () => {
    tenant();
    fakeHermes({ specs: [...APPROVAL_GATED_TOOLS.map((m) => [m, m !== "read_file"] as [string, boolean]), ["read_file", true]] });
    failsWith("live-not-fail-closed:read_file");
    tenant();
    fakeHermes({ specs: APPROVAL_GATED_TOOLS.filter((m) => m !== "browser_.*").map((m) => [m, true] as [string, boolean]) });
    failsWith("live-entry-missing:browser_.*");
  });
});

describe("R2-2: the kill switch restores exactly what the first install found", () => {
  const RESIDENT = {
    ...BASE_CONFIG,
    hooks_auto_accept: true,
    plugins: { ...BASE_CONFIG.plugins, hook_callback_timeout: 120 },
  };

  test("resident-set consent and callback timeout survive install and kill", () => {
    const home = tenant({ config: RESIDENT });
    appendEnv(home, "HERMES_ACCEPT_HOOKS=true");
    installApproval(SOURCE_SKILLS, opts());
    installApproval(SOURCE_SKILLS, opts()); // a re-install must not record its own values as the resident's
    const envPath = join(home, ".env");
    writeFileSync(envPath, readFileSync(envPath, "utf8").replace("AV_APPROVAL_ENABLED=1", "AV_APPROVAL_ENABLED=0"));
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("disabled");
    const doc = config(home);
    expect(doc.hooks_auto_accept).toBe(true);
    expect(doc.plugins.hook_callback_timeout).toBe(120);
    expect(doc.hooks.pre_tool_call).toEqual([OPERATOR_HOOK]);
    const env = readFileSync(envPath, "utf8");
    expect(env.split("\n")).toContain("HERMES_ACCEPT_HOOKS=true");
    expect(env).not.toContain("APPROVAL_HOOK_");
  });

  test("a never-installed tenant is untouched on kill, apart from a stray entry running the shim", () => {
    const home = tenant({ config: RESIDENT, env: { AV_APPROVAL_ENABLED: "0" } });
    appendEnv(home, "HERMES_ACCEPT_HOOKS=1");
    const before = bytes(home);
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("disabled");
    expect(bytes(home)).toEqual(before);
    const stray = { ...RESIDENT, hooks: { pre_tool_call: [OPERATOR_HOOK, { matcher: "terminal", command: approvalShimPath() }] } };
    writeFileSync(join(home, "config.yaml"), YAML.stringify(stray));
    installApproval(SOURCE_SKILLS, opts());
    const doc = config(home);
    expect(doc.hooks.pre_tool_call).toEqual([OPERATOR_HOOK]);
    expect(doc.hooks_auto_accept).toBe(true);
    expect(doc.plugins.hook_callback_timeout).toBe(120);
    expect(bytes(home).env).toBe(before.env);
  });
});

describe("R2-5", () => {
  test("(a) a failed first install removes the shim, agent-hooks/ and skills/approval/ it staged", () => {
    const home = tenant();
    fakeHermes({ run_once: { returncode: 0, stdout: "{}", parsed: null, error: null, timed_out: false } });
    failsWith("live-call-allowed");
    expect(existsSync(join(home, "agent-hooks"))).toBe(false);
    expect(existsSync(join(home, "skills", "approval"))).toBe(false);
  });

  test("(a) a failed re-install keeps the shim and skill the earlier install left", () => {
    const home = tenant();
    installApproval(SOURCE_SKILLS, opts());
    fakeHermes({ run_once: { returncode: 0, stdout: "{}", parsed: null, error: null, timed_out: false } });
    failsWith("live-call-allowed");
    expect(existsSync(approvalShimPath())).toBe(true);
    expect(existsSync(join(home, "skills", "approval", "SKILL.md"))).toBe(true);
  });

  test("(b) the shim logs under agent-hooks/ by default", () => {
    expect(readFileSync(SHIM_SOURCE, "utf8")).toContain("LOG=${APPROVAL_HOOK_LOG:-${HERMES_HOME:-/opt/data}/agent-hooks/approval-hook.log}");
  });

  test("(c) a .hermes that is a symlink to a home with another name is refused", () => {
    const real = join(scratch("av-approval-real-"), "data");
    mkdirSync(real);
    const link = join(scratch("av-approval-link-"), ".hermes");
    symlinkSync(real, link);
    tenant();
    const from = process.env.HERMES_HOME!;
    for (const f of ["config.yaml", ".env"]) writeFileSync(join(real, f), readFileSync(join(from, f)));
    process.env.HERMES_HOME = link;
    failsWith("hermes-home-not-dot-hermes");
  });
});

// ---------------------------------------------------------------------------
// The shim, run through `bash -c` with a fake curl.
//
// The shim ignores PATH by design: it resolves every program from /usr/bin,
// /bin and /usr/local/bin only, so a fake on PATH would never be called. The
// test runs a copy whose ONE directory-list line has the fake bin prepended;
// nothing else differs, and the test fails if that line ever changes.
// ---------------------------------------------------------------------------

const DIR_LINE = "  for d in /usr/bin /bin /usr/local/bin; do";
/** The shim's one fixed listener-table root; the fixture points its copy at a fake /proc. */
const PROC_LINE = "\nAV_PROC_ROOT=/proc\n";
const NODE = Bun.which("node");
const MY_UID = process.getuid?.() ?? 0;

interface ShimRun {
  code: number;
  stdout: string;
  stderr: string;
  calls: number;
  argv: string[];
  stdin: string[];
}

function shimFixture(mode: string) {
  const root = scratch("av-approval-shim-");
  const fake = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(fake);
  mkdirSync(state);
  writeFileSync(join(state, "mode"), mode);

  const source = readFileSync(SHIM_SOURCE, "utf8");
  expect(source.split(DIR_LINE).length - 1).toBe(1);
  expect(source.split(PROC_LINE).length - 1).toBe(1);
  const proc = join(root, "proc");
  mkdirSync(join(proc, "net"), { recursive: true });
  const shim = join(root, "hermes-hook-shim.sh");
  // AV_SHIM_SHELL=/bin/dash (or /bin/bash) runs the copy under that shell instead of /bin/sh.
  const shell = process.env.AV_SHIM_SHELL;
  writeFileSync(
    shim,
    source
      .replace(DIR_LINE, `  for d in ${fake} /usr/bin /bin /usr/local/bin; do`)
      .replace(PROC_LINE, `\nAV_PROC_ROOT=${proc}\n`)
      .replace(/^#!\/bin\/sh\n/, shell ? `#!${shell}\n` : "#!/bin/sh\n"),
    { mode: 0o700 },
  );

  const allow = JSON.stringify({ exit_code: 0, stdout: "{}", stderr: "" });
  const block = JSON.stringify({
    exit_code: 2,
    stdout: JSON.stringify({ action: "block", message: "approval-rejected: the resident declined message.send" }),
    stderr: "",
  });
  const waiting = JSON.stringify({
    exit_code: 2,
    stdout: JSON.stringify({ action: "block", message: "hook-timeout: no decision yet; the question stays open. NOTHING WAS WITHDRAWN" }),
    stderr: "",
  });
  writeFileSync(join(state, "allow.json"), allow);
  writeFileSync(join(state, "block.json"), block);
  writeFileSync(join(state, "waiting.json"), waiting);
  // A non-zero exit with nothing on stdout: Hermes would read no directive as an allow.
  writeFileSync(join(state, "exit1-empty.json"), JSON.stringify({ exit_code: 1, stdout: "", stderr: "internal error" }));
  // An allow whose body the facade says it cut short.
  writeFileSync(join(state, "truncated.json"), JSON.stringify({ exit_code: 0, stdout: "{}", stderr: "", stdout_truncated: true }));

  // The fake curl: records argv and the config it was handed on stdin, then
  // answers per the mode file. `--output` and `--write-out` as the shim uses them.
  writeFileSync(
    join(fake, "curl"),
    `#!/bin/sh
st='${state}'
n=$(( $(cat "$st/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$st/count"
printf '%s\\n' "$@" > "$st/argv.$n"
cat > "$st/stdin.$n"
# A test may change the world after call n (the daemon restarted, a squatter bound the port).
[ -f "$st/after.$n" ] && /bin/sh "$st/after.$n"
out=""
while [ $# -gt 0 ]; do
  case $1 in --output) out=$2; shift ;; esac
  shift
done
mode=$(cat "$st/mode")
case $mode in
  allow) cat "$st/allow.json" > "$out"; printf 200 ;;
  block) cat "$st/block.json" > "$out"; printf 200 ;;
  waiting) cat "$st/waiting.json" > "$out"; printf 200 ;;
  exit1-empty) cat "$st/exit1-empty.json" > "$out"; printf 200 ;;
  truncated) cat "$st/truncated.json" > "$out"; printf 200 ;;
  unreachable) echo "curl: (7) Failed to connect to facade.example.test port 443" >&2; printf 000; exit 7 ;;
  http503) printf '{"error":{"code":"serve-unavailable"}}' > "$out"; printf 503 ;;
  garbage) printf 'not json' > "$out"; printf 200 ;;
  first-timeout)
    if [ "$n" -eq 1 ]; then /bin/sleep 1.2; echo "curl: (28) Operation timed out" >&2; printf 000; exit 28; fi
    cat "$st/allow.json" > "$out"; printf 200 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  // GNU date's millisecond form, which BSD date lacks; everything else passes through.
  writeFileSync(
    join(fake, "date"),
    `#!/bin/sh
case "$1" in
  +%s%3N) exec /usr/bin/perl -MTime::HiRes=time -e 'printf("%d\\n", time()*1000)' ;;
esac
exec /bin/date "$@"
`,
    { mode: 0o755 },
  );
  // The re-ask cadence is 5 s; the test keeps the loop and shortens the pause.
  writeFileSync(join(fake, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.05\n", { mode: 0o755 });
  // GNU stat's -c '%u %a' and -c %u (lstat, as GNU stat without -L), which BSD stat lacks.
  writeFileSync(
    join(fake, "stat"),
    `#!/bin/sh
[ "$1" = -c ] || exec /usr/bin/stat "$@"
exec /usr/bin/perl -e '@s = lstat($ARGV[1]) or exit 1; $f = $ARGV[0]; $f =~ s/%u/$s[4]/; $u = sprintf("%o", $s[2] & 07777); $f =~ s/%a/$u/; print "$f\\n"' "$2" "$3"
`,
    { mode: 0o755 },
  );
  if (!NODE) throw new Error("node is required to run the shim tests");
  symlinkSync(NODE, join(fake, "node"));

  const envelope = join(root, "envelope.json");
  writeFileSync(
    envelope,
    JSON.stringify({
      hook_event_name: "pre_tool_call",
      tool_name: "terminal",
      tool_input: { command: "curl -X POST https://api.example.com/send", workdir: "/home/hermes/.hermes" },
      session_id: "s-1",
      cwd: "/home/hermes/.hermes",
      extra: { tool_call_id: "call-1" },
    }),
  );

  return {
    root,
    state,
    proc,
    fake,
    run(env: Record<string, string> = {}, o: { bare?: boolean } = {}): ShimRun {
      const base = o.bare
        ? { PATH: `${fake}:/usr/bin:/bin` }
        : {
            HOME: root,
            HERMES_HOME: root,
            PATH: `${fake}:/usr/bin:/bin`,
            AV_APPROVAL_URL: URL,
            AV_APPROVAL_TOKEN: TOKEN,
            APPROVAL_HOOK_URL_ENV: "AV_APPROVAL_URL",
            APPROVAL_HOOK_TOKEN_ENV: "AV_APPROVAL_TOKEN",
            APPROVAL_HOOK_WAIT_S: "0",
            APPROVAL_HOOK_MAX_TIME: "1",
            APPROVAL_HOOK_LOG: join(root, "hook.log"),
          };
      const proc = Bun.spawnSync(["bash", "-c", `exec "$0" < "$1"`, shim, envelope], { env: { ...base, ...env } });
      const calls = existsSync(join(state, "count")) ? Number(readFileSync(join(state, "count"), "utf8")) : 0;
      const read = (name: string) => Array.from({ length: calls }, (_, i) => readFileSync(join(state, `${name}.${i + 1}`), "utf8"));
      return {
        code: proc.exitCode ?? -1,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        calls,
        argv: read("argv"),
        stdin: read("stdin"),
      };
    },
    log: () => (existsSync(join(root, "hook.log")) ? readFileSync(join(root, "hook.log"), "utf8") : ""),
  };
}

describe("the vendored shim (bash -c, fake curl)", () => {
  test("parses under sh -n and bash -n", () => {
    for (const shell of ["sh", "bash"]) {
      expect(Bun.spawnSync([shell, "-n", SHIM_SOURCE]).exitCode).toBe(0);
    }
  });

  test("allow: the facade's {} passes through at exit 0; the token travels on stdin, never argv", () => {
    const fx = shimFixture("allow");
    const r = fx.run();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("{}");
    expect(r.calls).toBe(1);
    expect(r.argv[0]).not.toContain(TOKEN);
    expect(r.argv[0].trim().split("\n").at(-1)).toBe(`${URL}/hook/hermes`);
    expect(r.stdin[0]).toBe(`header = "X-Approval-Authorization: Bearer ${TOKEN}"\n`);
    expect(fx.log()).not.toContain(TOKEN);
  });

  test("block: the facade's block directive is replayed with exit 2", () => {
    const r = shimFixture("block").run();
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ action: "block", message: "approval-rejected: the resident declined message.send" });
  });

  test("facade unreachable: a block directive on stdout and exit 2", () => {
    const r = shimFixture("unreachable").run();
    expect(r.code).toBe(2);
    const directive = JSON.parse(r.stdout);
    expect(directive.action).toBe("block");
    expect(directive.message).toContain("approval facade unreachable: transport failure (curl exit 7");
  });

  test("a non-200 and an unparseable body both block at exit 2", () => {
    for (const [mode, needle] of [
      ["http503", "HTTP 503 serve-unavailable"],
      ["garbage", "unparseable body"],
    ] as const) {
      const r = shimFixture(mode).run();
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout).message).toContain(needle);
    }
  });

  test("credential missing from the hook's environment: block at exit 2 without calling the facade", () => {
    const r = shimFixture("allow").run({ AV_APPROVAL_TOKEN: "" });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).message).toContain("AV_APPROVAL_TOKEN is not set");
    expect(r.calls).toBe(0);
  });

  test("timeout: hook-timeout answers are re-asked until the window closes, then the last block stands", () => {
    const fx = shimFixture("waiting");
    const r = fx.run({ APPROVAL_HOOK_WAIT_S: "6" });
    expect(r.code).toBe(2);
    expect(r.calls).toBeGreaterThan(1);
    expect(JSON.parse(r.stdout).message).toStartWith("hook-timeout:");
    expect(fx.log()).toContain("outcome=wait");
    // Each re-ask posts the same envelope with the same credential.
    expect(new Set(r.stdin).size).toBe(1);
  });

  test("M6: a non-zero exit with an empty stdout is a block at exit 2, never passed through", () => {
    const r = shimFixture("exit1-empty").run();
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({
      action: "block",
      message: "approval facade unreachable: exit 1 without a block directive",
    });
  });

  test("M6: a body the facade marks truncated is a block at exit 2, even when it says allow", () => {
    const r = shimFixture("truncated").run();
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).message).toBe("approval facade unreachable: truncated body");
  });

  test("M6: a re-ask window above the shim's 285 s bound is refused (one post, then the block)", () => {
    const r = shimFixture("waiting").run({ APPROVAL_HOOK_WAIT_S: "400" });
    expect(r.code).toBe(2);
    expect(r.calls).toBe(1);
    expect(JSON.parse(r.stdout).message).toStartWith("hook-timeout:");
  });

  test("timeout with no re-ask window (WAIT_S=0): one post, then block", () => {
    const r = shimFixture("waiting").run({ APPROVAL_HOOK_WAIT_S: "0" });
    expect(r.code).toBe(2);
    expect(r.calls).toBe(1);
  });

  test("a first post that hit the curl ceiling is re-asked and the later answer stands", () => {
    const r = shimFixture("first-timeout").run({ APPROVAL_HOOK_WAIT_S: "8" });
    expect(r.calls).toBe(2);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// DATA-234: the gate's fail-open holes
// ---------------------------------------------------------------------------

/** A /proc/net/tcp line (the kernel's layout; uid is the 8th field). */
function tcpLine(addr: string, port: number, state: string, uid: number): string {
  const p = port.toString(16).toUpperCase().padStart(4, "0");
  return `   0: ${addr}:${p} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 12345 1 0000000000000000 100 0 0 10 0`;
}
const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const TCP6_HEADER =
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function writeProc(fx: ReturnType<typeof shimFixture>, v4: string[], v6: string[] | null = []): void {
  writeFileSync(join(fx.proc, "net", "tcp"), [TCP_HEADER, ...v4, ""].join("\n"));
  const six = join(fx.proc, "net", "tcp6");
  if (v6 === null) rmSync(six, { force: true });
  else writeFileSync(six, [TCP6_HEADER, ...v6, ""].join("\n"));
}

const LOOP_URL = "http://127.0.0.1:4682";
const DAEMON = 10001;

describe("DATA-234 G1: the shim's own fatal paths", () => {
  test("a variable name with a leading digit blocks with a directive (it was a fatal bad substitution)", () => {
    for (const env of [{ APPROVAL_HOOK_URL_ENV: "1ABC" }, { APPROVAL_HOOK_TOKEN_ENV: "9TOKEN" }, { APPROVAL_HOOK_URL_ENV: "A-B" }]) {
      const r = shimFixture("allow").run(env);
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout).action).toBe("block");
      expect(JSON.parse(r.stdout).message).toContain("is not a variable name");
      expect(r.calls).toBe(0);
    }
  });

  test("every setting unset (no HOME, HERMES_HOME, URL, token or shim settings): a block directive at exit 2", () => {
    const r = shimFixture("allow").run({}, { bare: true });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({
      action: "block",
      message: "approval facade unreachable: AV_APPROVAL_URL is not set in the hook's environment",
    });
    expect(r.calls).toBe(0);
  });

  test("a clock that prints no digits (BSD date's %3N) is 0: no fatal arithmetic, verdicts intact, no re-asking", () => {
    for (const [mode, code, calls] of [
      ["allow", 0, 1],
      ["block", 2, 1],
      ["unreachable", 2, 1],
      ["waiting", 2, 1],
    ] as const) {
      const fx = shimFixture(mode);
      writeFileSync(join(fx.fake, "date"), "#!/bin/sh\ncase \"$1\" in +%s%3N) echo 17000000003N ;; *) exec /bin/date \"$@\" ;; esac\n", {
        mode: 0o755,
      });
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
      expect(r.code).toBe(code);
      expect(r.calls).toBe(calls);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
      if (code !== 0) expect(JSON.parse(r.stdout).action).toBe("block");
      expect(fx.log()).toContain("elapsed_ms=");
    }
  });

  test("the installer only writes variable names of the form ^[A-Z][A-Z0-9_]*$", () => {
    expect(() => assertEnvNames(approvalEnvLines())).not.toThrow();
    for (const [name] of Object.entries(approvalEnvLines())) expect(ENV_NAME.test(name)).toBe(true);
    for (const bad of [{ "1ABC": "1" }, { lower_case: "1" }, { APPROVAL_HOOK_URL_ENV: "1ABC" }, { APPROVAL_HOOK_TOKEN_ENV: "A-B" }]) {
      expect(() => assertEnvNames(bad)).toThrow(ApprovalInstallError);
    }
  });

  test("the static check names a shim setting that is not such a name", () => {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    const envPath = join(home, ".env");
    writeFileSync(envPath, readFileSync(envPath, "utf8").replace("APPROVAL_HOOK_URL_ENV=AV_APPROVAL_URL", "APPROVAL_HOOK_URL_ENV=1ABC"));
    expect(approvalProblems(o)).toEqual(["env-unresolvable:1ABC"]);
  });

  test("the interpreter line stays #!/bin/sh (absolute; the consented command is the shim's path, unchanged)", () => {
    const source = readFileSync(SHIM_SOURCE, "utf8");
    expect(source.split("\n", 1)[0]).toBe("#!/bin/sh");
    expect(source).not.toMatch(/^set -[a-z]*u/m);
  });
});

describe("DATA-234 G2: the shim digest the backstop compares", () => {
  test("the static check names a shim that differs from the recorded digest, or a marker without one", () => {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    expect(approvalProblems(o)).toEqual([]);
    writeFileSync(approvalShimPath(), `${readFileSync(approvalShimPath(), "utf8")}\n# planted\n`);
    expect(approvalProblems(o)).toEqual(["shim-hash-mismatch"]);
    const marker = JSON.parse(readFileSync(approvalSurfacePath(), "utf8"));
    delete marker.shim_sha256;
    writeFileSync(approvalSurfacePath(), JSON.stringify(marker));
    expect(approvalProblems(o)).toEqual(["manifest-missing"]);
    expect(home).toContain(".hermes");
  });

  test("the plugin's matcher list is the installer's", () => {
    const plugin = readFileSync(join(REPO, "plugins", "av-approval", "__init__.py"), "utf8");
    const block = /GATED_MATCHERS: tuple\[str, \.\.\.\] = \(([\s\S]*?)\n\)/.exec(plugin);
    expect(block).not.toBeNull();
    const listed = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual([...APPROVAL_GATED_TOOLS]);
  });
});

describe("DATA-234 G4/G5: cron scripts, the consent allowlist and the exit-1 probe", () => {
  test("scripts under $HERMES_HOME/scripts/ are listed by name in the install log and --check", () => {
    const home = tenant();
    mkdirSync(join(home, "scripts", "brief"), { recursive: true });
    writeFileSync(join(home, "scripts", "brief", "prepare.py"), "print(1)\n");
    writeFileSync(join(home, "scripts", "ping.sh"), "echo hi\n");
    const o = opts();
    expect(installApproval(SOURCE_SKILLS, o)).toBe("installed");
    expect(cronScripts()).toEqual(["brief/prepare.py", "ping.sh"]);
    expect(logs.join("\n")).toContain("2 script(s) under $HERMES_HOME/scripts/ run at cron ticks with NO hook");
    expect(logs.join("\n")).toContain("brief/prepare.py, ping.sh");
    logs = [];
    expect(checkCli(["--check"], o)).toBe(0);
    expect(JSON.parse(logs.at(-1)!).cron_scripts).toEqual(["brief/prepare.py", "ping.sh"]);
  });

  test("a lock Hermes cannot open (mode 000, a directory, a symlink) fails the install; absent is fine", () => {
    const lock = (home: string) => join(home, "shell-hooks-allowlist.json.lock");
    let home = tenant();
    writeFileSync(lock(home), "", { mode: 0o000 });
    failsWith("allowlist-unusable:shell-hooks-allowlist.json.lock:not-read-write");
    home = tenant();
    mkdirSync(lock(home));
    failsWith("allowlist-unusable:shell-hooks-allowlist.json.lock:not-regular");
    home = tenant();
    writeFileSync(join(home, "elsewhere"), "");
    symlinkSync(join(home, "elsewhere"), lock(home));
    failsWith("allowlist-unusable:shell-hooks-allowlist.json.lock:not-regular");
    home = tenant();
    writeFileSync(join(home, "shell-hooks-allowlist.json"), '{"approvals": []}', { mode: 0o200 });
    failsWith("allowlist-unusable:shell-hooks-allowlist.json:unreadable");
    tenant();
    expect(allowlistProblems()).toEqual([]);
  });

  test("an absent lock in a home this user cannot write is named (Hermes's open would raise)", () => {
    const home = tenant();
    chmodSync(home, 0o500);
    try {
      expect(allowlistProblems()).toEqual(["allowlist-unusable:shell-hooks-allowlist.json.lock:uncreatable"]);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  test("live_selfcheck.py reports the exit-1 probe and the allowlist facts; an unusable lock is a problem", () => {
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    const live = (state: FakeHermesState = {}) => {
      fakeHermes(state);
      const out = Bun.spawnSync(
        [PYTHON!, join(SOURCE_SKILLS, "approval", "scripts", "live_selfcheck.py"), "--home", home, "--shim", approvalShimPath(), "--matchers", JSON.stringify(APPROVAL_GATED_TOOLS)],
        { env: { ...process.env, HERMES_HOME: home } },
      );
      expect(out.exitCode).toBe(0);
      return JSON.parse(out.stdout.toString().trim().split("\n").at(-1)!);
    };
    let facts = live();
    expect(facts.exit1_blocks).toBe(false);
    expect(facts.consent_allowlist).toEqual({ basis: "hermes", allowlist: "absent", allowlist_lock: "absent", shim_recorded: false });
    expect(facts.problems).toEqual([]);
    writeFileSync(
      join(home, "shell-hooks-allowlist.json"),
      JSON.stringify({ approvals: [{ event: "pre_tool_call", command: approvalShimPath() }] }),
      { mode: 0o600 },
    );
    writeFileSync(join(home, "shell-hooks-allowlist.json.lock"), "", { mode: 0o000 });
    facts = live({ exit1_patch: true });
    expect(facts.exit1_blocks).toBe(true);
    expect(facts.consent_allowlist).toEqual({ basis: "hermes", allowlist: "ok", allowlist_lock: "not-read-write", shim_recorded: true });
    expect(facts.problems).toEqual(["allowlist-unusable:shell-hooks-allowlist.json.lock:not-read-write"]);
  });

  test("the exit-1 answer is printed at install and in --check: allowed on stock Hermes, blocked on the patched build", () => {
    tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    expect(logs.join("\n")).toContain("Hermes ALLOWS a fail_closed hook that exits 1 with no output (unpatched; DATA-228");
    tenant();
    fakeHermes({ exit1_patch: true });
    installApproval(SOURCE_SKILLS, o);
    expect(logs.join("\n")).toContain("Hermes blocks a fail_closed hook that exits 1 with no output (patched checkpoint)");
    logs = [];
    expect(checkCli(["--check"], o)).toBe(0);
    expect(JSON.parse(logs.at(-1)!).hermes_exit1).toBe("blocked");
  });
});

describe("DATA-234 amendments: the co-located installer contract", () => {
  function tokenFile(home: string, value = TOKEN, mode = 0o600): string {
    const dir = join(home, "approval");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "agent-token");
    writeFileSync(path, `${value}\n`, { mode });
    chmodSync(path, mode);
    return path;
  }

  test("AV_APPROVAL_TOKEN_FILE in place of AV_APPROVAL_TOKEN: installs; the value is never printed", () => {
    const home = tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: URL, TENANT_ID: TENANT } });
    const path = tokenFile(home);
    appendEnv(home, `AV_APPROVAL_TOKEN_FILE=${path}`);
    expect(tokenSource()).toEqual({ kind: "file", path, named: true });
    const o = opts();
    expect(installApproval(SOURCE_SKILLS, o)).toBe("installed");
    expect(approvalProblems(o)).toEqual([]);
    expect([...logs, ...errors].join("\n")).not.toContain(TOKEN);
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain(TOKEN);
  });

  test("the default $HERMES_HOME/approval/agent-token is used when it exists and no variable names a file", () => {
    const home = tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: URL, TENANT_ID: TENANT } });
    const path = tokenFile(home);
    expect(tokenSource()).toEqual({ kind: "file", path, named: false });
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
  });

  test("a token file the shim would refuse is refused before anything is written, naming why, never the value", () => {
    for (const [setup, why] of [
      [(home: string) => tokenFile(home, TOKEN, 0o644), "mode-not-0600"],
      [(home: string) => join(home, "approval", "missing"), "missing"],
      [(home: string) => tokenFile(home, "has space"), "malformed"],
      [(home: string) => tokenFile(home, ""), "empty"],
      [() => "relative/agent-token", "not-absolute"],
    ] as const) {
      const home = tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: URL, AV_APPROVAL_TOKEN: TOKEN } });
      mkdirSync(join(home, "approval"), { recursive: true });
      appendEnv(home, `AV_APPROVAL_TOKEN_FILE=${setup(home)}`);
      const before = bytes(home);
      const err = expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-token-file-unusable");
      expect(err.message).toContain(` is ${why};`);
      expect(err.message).not.toContain(TOKEN);
      expect(bytes(home)).toEqual(before);
    }
  });

  test("URL forms: https, http://127.0.0.1:<port> and unix:<absolute path> install; any other http:// is refused", () => {
    expect(facadeUrlKind("https://facade.example.test")).toBe("https");
    expect(facadeUrlKind(LOOP_URL)).toBe("loopback");
    expect(facadeUrlKind("unix:/var/lib/approvald/t/run/hook.sock")).toBe("unix");
    for (const bad of [
      "http://facade.example.test",
      "http://localhost:4682",
      "http://127.0.0.1",
      "http://127.0.0.1:99999",
      "http://127.0.0.1:80@evil.example",
      "http://127.0.0.2:4682",
      "unix:relative.sock",
      "unix:/a b.sock",
    ]) {
      expect(facadeUrlKind(bad)).toBeNull();
    }
    for (const url of [LOOP_URL, "unix:/var/lib/approvald/t/run/hook.sock"]) {
      tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: url, AV_APPROVAL_TOKEN: TOKEN, TENANT_ID: TENANT } });
      expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    }
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: "http://127.0.0.1:4682@evil.example", AV_APPROVAL_TOKEN: TOKEN } });
    expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-url-not-https");
  });

  test("a non-numeric AV_APPROVAL_DAEMON_UID is refused", () => {
    const home = tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: LOOP_URL, AV_APPROVAL_TOKEN: TOKEN } });
    appendEnv(home, "AV_APPROVAL_DAEMON_UID=approvald");
    expectInstallError(() => installApproval(SOURCE_SKILLS, opts()), "approval-daemon-uid-invalid");
  });

  const UNREACHABLE = {
    returncode: 2,
    stdout: JSON.stringify({ action: "block", message: "approval facade unreachable: transport failure (curl exit 7)" }),
    parsed: { action: "block", message: "x" },
    error: null,
    timed_out: false,
  };

  test("live fire best-effort for a LOCAL facade: unreachable or timed out is logged and the install stands", () => {
    for (const url of [LOOP_URL, "unix:/var/lib/approvald/t/run/hook.sock"]) {
      for (const run_once of [UNREACHABLE, { returncode: null, stdout: "", parsed: null, error: null, timed_out: true }]) {
        tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: url, AV_APPROVAL_TOKEN: TOKEN, TENANT_ID: TENANT } });
        fakeHermes({ run_once });
        errors = [];
        expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
        expect(errors.join("\n")).toContain("! approval gate: live self-check deferred (local facade did not answer");
        expect(logs.at(-1)).toContain("self-check passed (live: deferred, live-");
      }
    }
  });

  test("live fire stays MANDATORY for a remote https facade, and for any non-transient answer from a local one", () => {
    tenant();
    fakeHermes({ run_once: UNREACHABLE });
    failsWith("live-facade-unreachable");
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: LOOP_URL, AV_APPROVAL_TOKEN: TOKEN } });
    fakeHermes({ run_once: { returncode: 0, stdout: "{}", parsed: null, error: null, timed_out: false } });
    failsWith("live-call-allowed");
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: LOOP_URL, AV_APPROVAL_TOKEN: TOKEN } });
    fakeHermes({ signal_patch: false, run_once: UNREACHABLE });
    failsWith("hermes-signal-patch-missing");
  });

  test("the kill switch literal the control plane writes, 0, is the explicit off; unset is a skip", () => {
    tenant({ env: { AV_APPROVAL_ENABLED: "0" } });
    expect(approvalChoice()).toBe("off");
    tenant({ env: {} });
    expect(approvalChoice()).toBe("unset");
  });
});

describe("DATA-234 shim: the co-located facade (token file, loopback listener, unix socket)", () => {
  test("the token file is read before the variable; the value travels on stdin only and is never logged", () => {
    const fx = shimFixture("allow");
    const dir = join(fx.root, "approval");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "agent-token"), "file-token-SENTINEL\n", { mode: 0o600 });
    // The default path, found under HERMES_HOME:
    let r = fx.run({ AV_APPROVAL_TOKEN: "" });
    expect(r.code).toBe(0);
    expect(r.stdin[0]).toBe('header = "X-Approval-Authorization: Bearer file-token-SENTINEL"\n');
    // Named, it wins over the variable:
    r = fx.run({ AV_APPROVAL_TOKEN_FILE: join(dir, "agent-token") });
    expect(r.stdin.at(-1)).toBe('header = "X-Approval-Authorization: Bearer file-token-SENTINEL"\n');
    expect(r.argv.join("")).not.toContain("SENTINEL");
    expect(`${r.stdout}${r.stderr}${fx.log()}`).not.toContain("SENTINEL");
  });

  test("a token file that is missing, loose, a link or not ours blocks without calling the facade (no fallback)", () => {
    const fx = shimFixture("allow");
    const dir = join(fx.root, "approval");
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, "agent-token");
    writeFileSync(path, "file-token\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    let r = fx.run({ AV_APPROVAL_TOKEN_FILE: path });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).message).toContain("not owned by this user with mode 0600");
    r = fx.run({ AV_APPROVAL_TOKEN_FILE: join(dir, "absent") });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).message).toContain("missing or not a regular file");
    chmodSync(path, 0o600);
    symlinkSync(path, join(dir, "link"));
    r = fx.run({ AV_APPROVAL_TOKEN_FILE: join(dir, "link") });
    expect(r.code).toBe(2);
    r = fx.run({ AV_APPROVAL_TOKEN_FILE: "relative" });
    expect(r.code).toBe(2);
    expect(r.calls).toBe(0);
  });

  test("loopback: the daemon's uid on 127.0.0.1:<port> passes; plain http needs no allow flag", () => {
    const fx = shimFixture("allow");
    writeProc(fx, [tcpLine("0100007F", 4682, "0A", DAEMON), tcpLine("0100007F", 9999, "0A", MY_UID)]);
    const r = fx.run({ AV_APPROVAL_URL: LOOP_URL, AV_APPROVAL_DAEMON_UID: String(DAEMON) });
    expect(r.code).toBe(0);
    expect(r.argv[0].trim().split("\n").at(-1)).toBe(`${LOOP_URL}/hook/hermes`);
    expect(r.argv[0]).toContain("=http\n");
  });

  test("loopback: a squatter of another uid, a wildcard or mapped listener of it, or no listener blocks with facade_listener_foreign", () => {
    for (const [v4, v6, needle] of [
      [[tcpLine("0100007F", 4682, "0A", 1000)], [], "held by uid 1000"],
      [[tcpLine("0100007F", 4682, "0A", DAEMON), tcpLine("00000000", 4682, "0A", 1000)], [], "held by uid 1000"],
      [[tcpLine("0100007F", 4682, "0A", DAEMON)], [tcpLine("0000000000000000FFFF00000100007F", 4682, "0A", 1000)], "held by uid 1000"],
      [[tcpLine("0100007F", 4682, "0A", DAEMON)], [tcpLine("00000000000000000000000000000000", 4682, "0A", 1000)], "held by uid 1000"],
      [[tcpLine("0200007F", 4682, "0A", 1000), tcpLine("0100007F", 4682, "0A", DAEMON)], [], "held by uid 1000"],
      [[tcpLine("0100007F", 4682, "01", DAEMON)], [], "nothing listens"],
      [[tcpLine("0A00000A", 4682, "0A", DAEMON)], [], "nothing listens"],
      [[], null, "nothing listens"],
    ] as const) {
      const fx = shimFixture("allow");
      writeProc(fx, [...v4], v6 === null ? null : [...v6]);
      const r = fx.run({ AV_APPROVAL_URL: LOOP_URL, AV_APPROVAL_DAEMON_UID: String(DAEMON) });
      expect(r.code).toBe(2);
      const message = JSON.parse(r.stdout).message as string;
      expect(message).toStartWith("approval facade unreachable: facade_listener_foreign: ");
      expect(message).toContain(needle);
      expect(r.calls).toBe(0);
      expect(r.stdin).toEqual([]);
    }
  });

  test("loopback: an unreadable listener table blocks; the default daemon uid is 10001", () => {
    const fx = shimFixture("allow");
    rmSync(join(fx.proc, "net"), { recursive: true });
    let r = fx.run({ AV_APPROVAL_URL: LOOP_URL });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).message).toContain("facade_listener_foreign: the listener table");
    mkdirSync(join(fx.proc, "net"));
    writeProc(fx, [tcpLine("0100007F", 4682, "0A", 10001)]);
    r = fx.run({ AV_APPROVAL_URL: LOOP_URL });
    expect(r.code).toBe(0);
    r = fx.run({ AV_APPROVAL_URL: LOOP_URL, AV_APPROVAL_DAEMON_UID: "approvald" });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).message).toContain("AV_APPROVAL_DAEMON_UID is not a uid");
  });

  test("loopback: the listener is checked before EVERY post, so a squatter that binds during a re-ask is refused", () => {
    const fx = shimFixture("waiting");
    writeProc(fx, [tcpLine("0100007F", 4682, "0A", DAEMON)]);
    // After the first post the daemon is gone and a uid-1000 process holds the port.
    writeFileSync(join(fx.state, "after.1"), `printf '%s\\n%s\\n' '${TCP_HEADER}' '${tcpLine("0100007F", 4682, "0A", 1000)}' > '${join(fx.proc, "net", "tcp")}'\n`);
    const r = fx.run({ AV_APPROVAL_URL: LOOP_URL, AV_APPROVAL_DAEMON_UID: String(DAEMON), APPROVAL_HOOK_WAIT_S: "20" });
    expect(r.calls).toBe(1);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).message).toContain("facade_listener_foreign: loopback port 4682 is held by uid 1000");
  });

  test("a remote https facade never reads the listener table", () => {
    const fx = shimFixture("allow");
    rmSync(join(fx.proc, "net"), { recursive: true });
    expect(fx.run().code).toBe(0);
  });

  function unixSocket(dir: string): string {
    const sock = join(dir, "hook.sock");
    const made = Bun.spawnSync([PYTHON!, "-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])", sock]);
    expect(made.exitCode).toBe(0);
    return sock;
  }

  test("unix socket: the daemon's socket in its own directory is dialled with --unix-socket and an http://localhost URL", () => {
    const fx = shimFixture("allow");
    const run = join(fx.root, "r");
    mkdirSync(run);
    chmodSync(run, 0o711);
    const sock = unixSocket(run);
    const r = fx.run({ AV_APPROVAL_URL: `unix:${sock}`, AV_APPROVAL_DAEMON_UID: String(MY_UID) });
    expect(r.code).toBe(0);
    const argv = r.argv[0].trim().split("\n");
    expect(argv.at(-1)).toBe("http://localhost/hook/hermes");
    expect(argv[argv.indexOf("--unix-socket") + 1]).toBe(sock);
    expect(r.stdin[0]).toBe(`header = "X-Approval-Authorization: Bearer ${TOKEN}"\n`);
  });

  test("unix socket: another owner, a directory others can write, a link or a plain file blocks with facade_listener_foreign", () => {
    const cases: [string, (fx: ReturnType<typeof shimFixture>) => [string, string], string][] = [
      ["owner", (fx) => {
        const d = join(fx.root, "r");
        mkdirSync(d);
        chmodSync(d, 0o711);
        return [unixSocket(d), String(MY_UID + 1)];
      }, "not owned by the approval daemon"],
      ["dir writable", (fx) => {
        const d = join(fx.root, "r");
        mkdirSync(d);
        chmodSync(d, 0o773);
        return [unixSocket(d), String(MY_UID)];
      }, "writable by others"],
      ["link", (fx) => {
        const d = join(fx.root, "r");
        mkdirSync(d);
        chmodSync(d, 0o711);
        const s = unixSocket(d);
        symlinkSync(s, join(d, "l.sock"));
        return [join(d, "l.sock"), String(MY_UID)];
      }, "missing or not a socket"],
      ["file", (fx) => {
        const d = join(fx.root, "r");
        mkdirSync(d);
        writeFileSync(join(d, "f.sock"), "");
        return [join(d, "f.sock"), String(MY_UID)];
      }, "missing or not a socket"],
    ];
    for (const [, setup, needle] of cases) {
      const fx = shimFixture("allow");
      const [sock, uid] = setup(fx);
      const r = fx.run({ AV_APPROVAL_URL: `unix:${sock}`, AV_APPROVAL_DAEMON_UID: uid });
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout).message).toContain(`facade_listener_foreign: ${needle.startsWith("missing") ? "the facade socket is " : ""}`);
      expect(JSON.parse(r.stdout).message).toContain(needle);
      expect(r.calls).toBe(0);
    }
  });
});
