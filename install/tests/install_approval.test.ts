import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  APPROVAL_ROUTED_SHA256,
  gateReceiptLine,
  lastInstallRouted,
  lastInstallVerified,
  mainCli,
  PREWARM_ENV,
  PREWARM_SESSION,
  prewarmAfterInstall,
  prewarmApproval,
  prewarmCli,
  PREWARM_MAX_TIME_S,
  PREWARM_TIMEOUT_MS,
  type PrewarmReport,
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
  "AV_APPROVAL_PREWARM",
  "APPROVAL_HOOK_LOG",
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
/** DATA-379: the stub pre-warm every install in this file runs unless a test asks for the real one. */
let prewarmCalls = 0;
const stubPrewarm = (): PrewarmReport => {
  prewarmCalls++;
  return { outcome: "facade-block", reason: null, elapsed_ms: 1 };
};

beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  logs = [];
  errors = [];
  prewarmCalls = 0;
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
  /** R3 fix round 4: load config.yaml with PyYAML and build the specs from its hooks block, as Hermes does. */
  specs_from_config?: boolean;
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
    specs_from_config: false,
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
  writeFileSync(
    join(root, "hermes_cli", "config.py"),
    `import json, os\ndef load_config():\n    if not json.load(open(os.environ["FAKE_HERMES_STATE"])).get("specs_from_config"):\n        return {}\n    import yaml\n    with open(os.path.join(os.environ["HERMES_HOME"], "config.yaml")) as fh:\n        return yaml.safe_load(fh) or {}\n`,
  );
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
    if _S.get("specs_from_config"):
        pre = ((cfg or {}).get("hooks") or {}).get("pre_tool_call") or []
        return [ShellHookSpec("pre_tool_call", str(e.get("command", "")), e.get("matcher"), e.get("timeout", 60), e.get("fail_closed") is True) for e in pre if isinstance(e, dict)]
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
  return { toolDirs: [toolDir()], managedDir: join(tmpdir(), "av-approval-no-managed-scope"), hermesPython: PYTHON, prewarm: stubPrewarm, ...extra };
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
    expect(logs.at(-1)).toContain("approval gate installed: 35 pre_tool_call entries (fail_closed)");
    // R3 fix round 4 (the trust boundary): the routed count and the sorted list's digest, as Hermes's
    // own parse reports them (live_selfcheck.py 5b), on their own line; the control plane pins both.
    const listSha = createHash("sha256").update([...APPROVAL_GATED_TOOLS].sort().join("\n"), "utf8").digest("hex");
    expect(listSha).toBe("9cb621bbe4c5761364a956509b705dbad62168e5bf42adff5600fe0a45e11d43");
    expect(APPROVAL_ROUTED_SHA256).toBe(listSha);
    expect(lastInstallRouted()).toEqual({ entries: 35, sha256: listSha });
    // Nothing about it is printed by the step: the receipt is install.ts's last line (gateReceiptLine).
    expect(logs.some((l) => l.includes("av_gate") || l.includes(listSha))).toBe(false);
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

  test("R3b (DATA-344): the side-effecting tools the policy's tools: list judges are routed, exactly (every Index write: fix round 2's S1/S2); Index's reads and the local tools are not", () => {
    const home = tenant();
    installApproval(SOURCE_SKILLS, opts());
    const matchers = ourEntries(home).map((e) => String(e.matcher));
    const covers = (tool: string) => matchers.some((m) => new RegExp(`^(?:${m})$`).test(tool));
    const before = [
      "terminal", "write_file", "patch", "read_file", "search_files", "execute_code", "process(_manage)?", "web_extract",
      "browser_.*", "skill_manage", "delegate_task", "cronjob(_manage)?", "send_message",
    ];
    // Fix round 2: Index's 14-tool MCP surface has nine writes, all routed (S1); the Index Hermes
    // plugin's accept or decline is index_update_opportunity and it has no index_accept_opportunity
    // (S2), and its eight write tools are routed, index_research_profile (POST /enrichment/enrich) included.
    const indexMcpWrites = ["create_intent", "update_intent", "archive_intent", "pause_intent", "resume_intent", "accept_opportunity", "reject_opportunity", "update_my_profile", "enrich_my_profile"];
    const indexPluginWrites = ["index_create_intent", "index_update_intent", "index_add_intent_to_network", "index_create_network", "index_update_network", "index_join_network", "index_update_opportunity", "index_research_profile"];
    const added = [
      ...indexMcpWrites.map((t) => `mcp__index__${t}`), ...indexPluginWrites,
      "image_generate", "video_generate", "text_to_speech", "web_search", "x_search",
    ];
    expect([before.length, added.length]).toEqual([13, 22]);
    // The plugin's tools as the overlay's copy of Index's contract lists them: every tool whose request
    // writes (any method but GET, less the one POST that lists: index_read_intents' /intents/list) is
    // routed, every read is not.
    const contract = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "plugins", "av-events", "tests", "vectors", "index_intent_contract.json"), "utf8"));
    const requests = contract.hermes_plugin.requests as Record<string, Array<[string, string]>>;
    expect(Object.keys(requests).sort()).toEqual([...contract.hermes_plugin.tools].sort());
    const pluginWrites = Object.keys(requests).filter((t) => requests[t].some(([method, p]) => method !== "GET" && !(method === "POST" && p === "/intents/list")));
    expect(pluginWrites.sort()).toEqual([...indexPluginWrites].sort());
    // Nothing that was routed changed; the added entries are the whole difference, one per tool.
    expect(matchers).toEqual([...before, ...added]);
    expect([...APPROVAL_GATED_TOOLS]).toEqual([...before, ...added]);
    for (const tool of added) expect([tool, covers(tool)]).toEqual([tool, true]);
    for (const tool of [
      // Index's reads (the five of its MCP surface and the plugin's seven, and index_open_app, which
      // makes no request), near misses, and the phantom index_accept_opportunity.
      "mcp__index__list_intents", "mcp__index__get_intent", "mcp__index__list_opportunities", "mcp__index__get_opportunity",
      "mcp__index__get_my_profile", "mcp__index__create_intent_x", "mcp__index__", "mcp__index__pause_intents",
      "index_read_intents", "index_list_intent_networks", "index_read_networks", "index_read_network_memberships",
      "index_list_opportunities", "index_read_docs", "index_agent_me", "index_open_app", "index_accept_opportunity",
      // The local tools, the overlay's own tools, and the media readers.
      "skill_view", "skills_list", "memory", "session_search", "todo", "clarify", "recall", "consent_status", "record_intention",
      "vision_analyze", "video_analyze", "computer_use", "manage_connections", "web_search_x", "xx_search",
    ]) {
      expect([tool, covers(tool)]).toEqual([tool, false]);
    }
  });

  test("R3 fix round 3 (recheck R3): every tool of Index's production MCP surface (the overlay's tools/list fixture) is routed or on the explicit read list, so a new Index write fails here", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "skills", "index-network", "scripts", "tests", "fixtures", "index-mcp-2026-07-28.json"), "utf8"));
    const tools = fixture.tools as string[];
    expect(tools.length).toBeGreaterThan(0);
    // Index's MCP reads: never routed (reading never waits on the gate); the policy prices them read.web.
    const reads = ["get_my_profile", "list_intents", "get_intent", "list_opportunities", "get_opportunity"];
    const routed = (name: string) => APPROVAL_GATED_TOOLS.some((m) => new RegExp(`^(?:${m})$`).test(`mcp__index__${name}`));
    for (const t of tools) {
      // A tool on neither list is a new Index MCP tool: decide whether it writes, then route it or list it here.
      expect([t, reads.includes(t) !== routed(t)]).toEqual([t, true]);
    }
    for (const r of reads) expect([r, tools.includes(r)]).toEqual([r, true]);
    // Every routed Index MCP matcher names a tool production serves.
    for (const m of APPROVAL_GATED_TOOLS.filter((x) => x.startsWith("mcp__index__"))) expect([m, tools.includes(m.slice("mcp__index__".length))]).toEqual([m, true]);
  });

  test("R3 fix round 4 (the trust boundary): the routed count and digest come from Hermes's own load of the config.yaml the install wrote; an entry added or removed by hand afterwards is caught at the next --check, and the next install puts the list back", () => {
    fakeHermes({ specs_from_config: true });
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    expect(lastInstallRouted()).toEqual({ entries: 35, sha256: APPROVAL_ROUTED_SHA256 });
    const check = () => {
      logs = [];
      const code = checkCli(["--check"], o);
      return { code, out: JSON.parse(logs.at(-1)!) };
    };
    expect(check()).toMatchObject({ code: 0, out: { ok: true, routed_entries: 35, routed_sha256: APPROVAL_ROUTED_SHA256 } });
    const path = join(home, "config.yaml");
    const original = readFileSync(path, "utf8");
    // Added by hand: one more shim entry (memory), as a sandbox writer could.
    const doc = YAML.parse(original);
    doc.hooks.pre_tool_call.push({ matcher: "memory", command: approvalShimPath(), timeout: 300, fail_closed: true });
    writeFileSync(path, YAML.stringify(doc));
    const added = check();
    expect(added.code).toBe(1);
    expect(added.out.routed_entries).toBe(36);
    expect(added.out.routed_sha256).not.toBe(APPROVAL_ROUTED_SHA256);
    expect(added.out.problems).toContain("live-routed-mismatch:36");
    // Removed by hand: one entry gone (x_search).
    const fewer = YAML.parse(original);
    fewer.hooks.pre_tool_call = fewer.hooks.pre_tool_call.filter((e: Record<string, unknown>) => e.matcher !== "x_search");
    writeFileSync(path, YAML.stringify(fewer));
    // The static check names the missing entry before the live one runs, so no routed count is
    // reported at all (null): caught, exit 1, and nothing a control plane could record as 35.
    const removed = check();
    expect(removed.code).toBe(1);
    expect(removed.out.problems).toContain("hook-missing:x_search");
    expect([removed.out.routed_entries, removed.out.routed_sha256]).toEqual([null, null]);
    // The next install merges the list back: 35 again, as Hermes loads it.
    logs = [];
    installApproval(SOURCE_SKILLS, o);
    expect(lastInstallRouted()).toEqual({ entries: 35, sha256: APPROVAL_ROUTED_SHA256 });
    expect(check()).toMatchObject({ code: 0, out: { ok: true, routed_entries: 35 } });
  });

  test("R3 fix round 4 (output injection): the gate receipt is one JSON object bound to the control plane's nonce; no valid nonce or no routed facts prints none; a failed install leaves none", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const routed = { entries: 35, sha256: APPROVAL_ROUTED_SHA256 };
    expect(JSON.parse(gateReceiptLine(nonce, routed)!)).toEqual({ av_gate: { nonce, entries: 35, sha256: APPROVAL_ROUTED_SHA256 } });
    expect(gateReceiptLine(nonce, routed)!.includes("\n")).toBe(false);
    for (const bad of [undefined, "", "0123", nonce.toUpperCase(), `${nonce}0`, `${nonce}\n{"av_gate":{}}`]) expect([bad, gateReceiptLine(bad, routed)]).toEqual([bad, null]);
    expect(gateReceiptLine(nonce, null)).toBe(null);
    expect(gateReceiptLine(nonce, { entries: 35, sha256: "x" })).toBe(null);
    // From the environment, after a real install; reset by the next run that does not install.
    const home = tenant();
    const o = opts();
    installApproval(SOURCE_SKILLS, o);
    process.env.AV_GATE_NONCE = nonce;
    try {
      expect(JSON.parse(gateReceiptLine()!)).toEqual({ av_gate: { nonce, entries: 35, sha256: APPROVAL_ROUTED_SHA256 } });
      // A later run whose self-check cannot run fails, and leaves no receipt.
      expect(() => installApproval(SOURCE_SKILLS, { ...o, hermesPython: null })).toThrow();
      expect(lastInstallRouted()).toBe(null);
      expect(gateReceiptLine()).toBe(null);
    } finally {
      delete process.env.AV_GATE_NONCE;
    }
    expect(home).toBeTruthy();
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
      // R3 fix rounds 3/4 (SF1 b): the merge plan's per-tenant check reads these, from Hermes's own parse.
      routed_entries: 35,
      routed_sha256: APPROVAL_ROUTED_SHA256,
      routed_entries_expected: 35,
      routed_sha256_expected: APPROVAL_ROUTED_SHA256,
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
    // OV-249 fix round 2 (R2-S1): an override install may fail open, so it is not a verified gate.
    expect(lastInstallVerified()).toBe(false);
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
    expect(lastInstallVerified()).toBe(false);
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
    expect(lastInstallVerified()).toBe(false);
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
      routed_entries: 35,
      routed_sha256: APPROVAL_ROUTED_SHA256,
      routed_entries_expected: 35,
      routed_sha256_expected: APPROVAL_ROUTED_SHA256,
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
    expect(logs.join("\n")).toContain("removed 35 pre_tool_call entries");
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

function shimFixture(
  mode: string,
  call: { tool_name: string; tool_input: Record<string, unknown> } | null = null,
  opt: { shell?: string } = {},
) {
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
  const shell = opt.shell ?? process.env.AV_SHIM_SHELL;
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
  // answers per the mode file. `--output` and `--write-out` as the shim uses
  // them: the write-out format is printed as curl would, with %{http_code}
  // and %{size_download} (the bytes written to --output) filled in (DATA-380).
  // A `nosize` file in the state directory drops %{size_download}, which
  // sends the shim's verdict reading to node; `custom` answers custom.body.
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
wo='%{http_code}'
while [ $# -gt 0 ]; do
  case $1 in
    --output) out=$2; shift ;;
    --write-out) wo=$2; shift ;;
  esac
  shift
done
[ -f "$st/nosize" ] && wo='%{http_code}'
emit() {
  sz=0
  [ -f "$out" ] && sz=$(wc -c < "$out" | tr -d ' ')
  printf '%s' "$wo" | sed -e "s/%{http_code}/$1/" -e "s/%{size_download}/$sz/"
}
mode=$(cat "$st/mode")
case $mode in
  allow) cat "$st/allow.json" > "$out"; emit 200 ;;
  block) cat "$st/block.json" > "$out"; emit 200 ;;
  waiting) cat "$st/waiting.json" > "$out"; emit 200 ;;
  exit1-empty) cat "$st/exit1-empty.json" > "$out"; emit 200 ;;
  truncated) cat "$st/truncated.json" > "$out"; emit 200 ;;
  custom) cat "$st/custom.body" > "$out"; emit 200 ;;
  # The custom body first, then the allow: a body read as \`wait\` is re-asked and ends allowed.
  custom-then-allow)
    if [ "$n" -le 1 ]; then cat "$st/custom.body" > "$out"; else cat "$st/allow.json" > "$out"; fi
    emit 200 ;;
  unreachable) echo "curl: (7) Failed to connect to facade.example.test port 443" >&2; emit 000; exit 7 ;;
  http503) printf '{"error":{"code":"serve-unavailable"}}' > "$out"; emit 503 ;;
  garbage) printf 'not json' > "$out"; emit 200 ;;
  first-timeout)
    if [ "$n" -eq 1 ]; then /bin/sleep 1.2; echo "curl: (28) Operation timed out" >&2; emit 000; exit 28; fi
    cat "$st/allow.json" > "$out"; emit 200 ;;
  # DATA-377: the resident taps while the shim re-asks: two hook-timeout answers, then the allow.
  wait-then-allow)
    if [ "$n" -le 2 ]; then cat "$st/waiting.json" > "$out"; else cat "$st/allow.json" > "$out"; fi
    emit 200 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  // GNU date's seconds.nanoseconds form (nine padded fraction digits), which BSD date lacks; everything else passes through.
  writeFileSync(
    join(fake, "date"),
    `#!/bin/sh
case "$1" in
  +%s.%N) exec /usr/bin/perl -MTime::HiRes=gettimeofday -e '($s, $u) = gettimeofday; printf("%d.%06d000\\n", $s, $u)' ;;
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
  // The real node, behind a wrapper that counts its starts (DATA-380: the
  // allow and block paths start none).
  writeFileSync(join(fake, "node"), `#!/bin/sh\necho x >> '${state}/node.calls'\nexec '${NODE}' "$@"\n`, { mode: 0o755 });

  const envelope = join(root, "envelope.json");
  writeFileSync(
    envelope,
    JSON.stringify({
      hook_event_name: "pre_tool_call",
      tool_name: call ? call.tool_name : "terminal",
      tool_input: call ? call.tool_input : { command: "curl -X POST https://api.example.com/send", workdir: "/home/hermes/.hermes" },
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
    run(env: Record<string, string> = {}, o: { bare?: boolean; timeoutMs?: number; printf?: Record<string, string> } = {}): ShimRun {
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
      // o.printf: variables the wrapper sets from printf formats before the shim
      // starts, for bytes a JS env string cannot carry (a lone 0x80; DATA-424).
      const pf = Object.entries(o.printf ?? {});
      const pre = pf.map(([k], i) => `${k}=$(printf "\${${i + 2}}"); export ${k}; `).join("");
      const proc = Bun.spawnSync(["bash", "-c", `${pre}exec "$0" < "$1"`, shim, envelope, ...pf.map(([, f]) => f)], {
        env: { ...base, ...env },
        ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}),
      });
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
    /** How many times the shim started node (DATA-380). */
    nodeCalls: () => (existsSync(join(state, "node.calls")) ? readFileSync(join(state, "node.calls"), "utf8").split("\n").filter(Boolean).length : 0),
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
    // A hosted (https) facade keeps the alternate header Maritime's proxy leaves alone.
    expect(r.stdin[0]).toBe(`header = "X-Approval-Authorization: Bearer ${TOKEN}"\n`);
    expect(r.stdin[0]).not.toContain('"Authorization:');
    expect(fx.log()).not.toContain(TOKEN);
  });

  test("R3b: an Index write goes through the shim as any gated call: posted to /hook/hermes, the facade's answer replayed, fail closed when it cannot be reached", () => {
    const call = { tool_name: "mcp__index__accept_opportunity", tool_input: { opportunityId: "00000000-0000-4000-8000-000000000001" } };
    const ok = shimFixture("allow", call);
    const a = ok.run();
    expect([a.code, a.stdout, a.calls]).toEqual([0, "{}", 1]);
    expect(a.argv[0].trim().split("\n").at(-1)).toBe(`${URL}/hook/hermes`);
    expect(ok.log()).toContain("tool=mcp__index__accept_opportunity");
    const b = shimFixture("block", call).run();
    expect(b.code).toBe(2);
    expect(JSON.parse(b.stdout).action).toBe("block");
    const down = shimFixture("unreachable", { tool_name: "image_generate", tool_input: { prompt: "x" } }).run();
    expect(down.code).toBe(2);
    expect(JSON.parse(down.stdout).message).toContain("approval facade unreachable");
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

  test("a clock whose fraction is not digits (BSD date prints %N as the letter N) is 0: no fatal arithmetic, verdicts intact, no re-asking", () => {
    for (const [mode, code, calls] of [
      ["allow", 0, 1],
      ["block", 2, 1],
      ["unreachable", 2, 1],
      ["waiting", 2, 1],
    ] as const) {
      const fx = shimFixture(mode);
      writeFileSync(join(fx.fake, "date"), "#!/bin/sh\ncase \"$1\" in +%s.%N) echo 1700000000.N ;; *) exec /bin/date \"$@\" ;; esac\n", {
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

// ---------------------------------------------------------------------------
// DATA-377: the shim's clock. The hosted image's date is uutils coreutils
// 0.8.0 on the boxes provisioned from the old checkpoints: its `%3N` drops the
// leading zeros of the nanoseconds (a width under nine strips the padding;
// plain `%N` IS padded there, as on GNU), so `date +%s%3N` was 16, 17, 18 or
// 19 digits and the digit-count rule (19 ns, 16 us, 13 ms, 10 s) read about
// 9 % of the clocks as 0 (b4's read of 2026-10-07: 300 samples per box, 17
// digits ~1 %, 18 ~9 %, 19 ~90 %). A 0 at T0 turns re-asking off and the
// first wait verdict becomes a block. The shim now reads `+%s.%N`: the
// separator makes the split exact, the fraction is left-padded to nine
// digits (a defence: every build measured pads `%N`) and its first three are
// the milliseconds (DATA-397).
// ---------------------------------------------------------------------------

/** The padded log fraction (GNU, uutils 0.10.0): nine digits. */
const UUTILS_FRACTION = "266475125";
/** A trimmed log fraction for 0.005567380 s: seven digits (the shape 0.8.0's `%3N` gives; a defence case for `%N`). */
const UNPADDED_FRACTION = "5567380";

/**
 * A fake `date` whose `+%s.%N` prints the given shape, advancing in real time:
 * `gnu` nine padded fraction digits (GNU, uutils 0.8.0 and 0.10.0), `unpadded`
 * the nanoseconds without their leading zeros (one to nine digits: the shape
 * 0.8.0's `%3N` gives, kept as a defence case for `%N`), `s` whole seconds and
 * no fraction (a date without %N). `gnu` and `unpadded` also print their shape
 * of the log stamp. With `offsetFile` (DATA-378: virtualSleep's file) the
 * seconds the fake sleeps added are added to the reading, so the clock moves
 * 5 s per re-ask as it does on a box.
 */
function clockFake(shape: "gnu" | "unpadded" | "s", offsetFile?: string): string {
  const stamp = {
    gnu: `/usr/bin/perl -MTime::HiRes=gettimeofday -e '($s, $u) = gettimeofday; printf("%d.%06d000\\n", $s, $u)'`,
    unpadded: `/usr/bin/perl -MTime::HiRes=gettimeofday -e '($s, $u) = gettimeofday; printf("%d.%d\\n", $s, $u * 1000)'`,
    s: "/bin/date +%s",
  }[shape];
  const logFraction = { gnu: UUTILS_FRACTION, unpadded: UNPADDED_FRACTION, s: "" }[shape];
  const logStamp = logFraction
    ? `  -u) [ "$2" = "+%Y-%m-%dT%H:%M:%S.%N" ] && { printf '%s.${logFraction}\\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%S)"; exit 0; } ;;\n`
    : "";
  const read = offsetFile
    ? `v=$(${stamp}); o=$(cat '${offsetFile}' 2>/dev/null || echo 0); case $v in *.*) echo "$((\${v%%.*} + o)).\${v#*.}" ;; *) echo "$((v + o))" ;; esac; exit 0`
    : `exec ${stamp}`;
  return `#!/bin/sh\ncase "$1" in\n  +%s.%N) ${read} ;;\n${logStamp}esac\nexec /bin/date "$@"\n`;
}

/**
 * DATA-378: the fixture's `sleep` adds its seconds to a virtual offset and
 * returns at once (the fixture's own fake sleeps 0.05 s and the clock does not
 * move). A clock that adds the offset then sees 5 s pass per re-ask, as on a
 * box, so the attempt cap (WAIT_S/5 + 2, which counts on those 5 s) is not
 * reached before the window closes. Returns the offset file (whole seconds).
 */
function virtualSleep(fx: ReturnType<typeof shimFixture>): string {
  const f = join(fx.state, "vsec");
  writeFileSync(join(fx.fake, "sleep"), `#!/bin/sh\nf='${f}'\necho $(( $(cat "$f" 2>/dev/null || echo 0) + $1 )) > "$f"\n`, { mode: 0o755 });
  return f;
}

/** A fake `date` whose `+%s.%N` prints one fixed value. */
function fixedClock(stamp: string): string {
  return `#!/bin/sh\ncase "$1" in +%s.%N) echo ${stamp} ;; *) exec /bin/date "$@" ;; esac\n`;
}

function withClock(fx: ReturnType<typeof shimFixture>, script: string): ReturnType<typeof shimFixture> {
  writeFileSync(join(fx.fake, "date"), script, { mode: 0o755 });
  return fx;
}

/** Every elapsed_ms the shim logged, in order. */
function elapsed(log: string): number[] {
  return [...log.matchAll(/elapsed_ms=(-?\d+)/g)].map((m) => Number(m[1]));
}

describe("DATA-377: the shim's clock is read as seconds.fraction, the fraction left-padded to nine digits", () => {
  test("the fake clocks print the shapes they stand for", () => {
    for (const [shape, re] of [
      ["gnu", /^\d{10}\.\d{9}$/],
      ["unpadded", /^\d{10}\.\d{1,9}$/],
      ["s", /^\d{10}$/],
    ] as const) {
      const fx = withClock(shimFixture("allow"), clockFake(shape));
      const out = Bun.spawnSync([join(fx.fake, "date"), "+%s.%N"]).stdout.toString().trim();
      expect([shape, re.test(out)]).toEqual([shape, true]);
    }
  });

  test("the hosted defect (a short fraction, as 0.8.0's %3N printed it) reads as milliseconds: the window stays open and the resident's later allow stands", () => {
    // Before the fix `+%s%3N` printed 17913936005567380 (17 digits), the digit-count rule read 0, WAIT_S became 0 and
    // the first wait answer was the block. A still clock: every read is 1791393600.005 s, so elapsed_ms is 0 throughout.
    for (const stamp of ["1791393600.5567380", "1791393600.7", "1791393600.0", "1791393600.000000001"]) {
      const fx = withClock(shimFixture("wait-then-allow"), fixedClock(stamp));
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
      expect([stamp, r.code, r.stdout, r.calls]).toEqual([stamp, 0, "{}", 3]);
      const log = fx.log();
      expect(log.match(/outcome=wait /g)?.length).toBe(2);
      expect(log).not.toContain("outcome=block");
      expect(elapsed(log)).toEqual([0, 0, 0, 0]);
    }
  }, 30000); // 4 real shim runs

  test("a stepping clock pins the place value: elapsed_ms follows the fraction left-padded to nine digits, not dropped or right-padded", () => {
    // Call k of `date +%s.%N` answers the k-th value; the last repeats. Read left-padded, the values are (ms):
    // 1 1791393600.5567380 -> ...600005 (a trimmed fraction, 0.005567380 s, as 0.8.0's %3N printed it); 2 .99999999 -> ...600099;
    // 3 1791393601.7 -> ...601000; 4 ...602.000000001 -> ...602000; 5 ...603.25 -> ...603000; 6 ...604.000000333 -> ...604000;
    // 7 ...605.5 -> ...605000; 8+ ...606.123456789 -> ...606123. Dropping the pad reads whole seconds, padding on the
    // right reads 556, 999, 700, 0, 250, 0, 500, 123 ms: neither gives the elapsed values below.
    const fx = shimFixture("wait-then-allow");
    withClock(
      fx,
      `#!/bin/sh\ncase "$1" in\n  +%s.%N) f=${fx.state}/clock.n; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$f"\n    case $n in 1) echo 1791393600.5567380 ;; 2) echo 1791393600.99999999 ;; 3) echo 1791393601.7 ;; 4) echo 1791393602.000000001 ;; 5) echo 1791393603.25 ;; 6) echo 1791393604.000000333 ;; 7) echo 1791393605.5 ;; *) echo 1791393606.123456789 ;; esac ;;\n  *) exec /bin/date "$@" ;;\nesac\n`,
    );
    const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
    expect([r.code, r.stdout, r.calls]).toEqual([0, "{}", 3]);
    // T0 is call 1 (...600005). The shim reads the clock more than once per attempt (P0, the deadline check), so the
    // four log lines see calls 2, 5, 9 and 12: ...600099 - T0 = 94, ...603000 - T0 = 2995, ...606123 - T0 = 6118, 6118.
    expect(elapsed(fx.log())).toEqual([94, 2995, 6118, 6118]);
  });

  test("a padded clock (GNU, uutils 0.8.0 and 0.10.0) and a trimmed one: a hook-timeout answer is re-asked and the resident's later allow stands", () => {
    for (const shape of ["gnu", "unpadded"] as const) {
      const fx = withClock(shimFixture("wait-then-allow"), clockFake(shape));
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
      expect([shape, r.code, r.stdout, r.calls]).toEqual([shape, 0, "{}", 3]);
      const log = fx.log();
      expect(log.match(/outcome=wait /g)?.length).toBe(2);
      expect(log).toContain("outcome=allow http=200 exit=0");
      expect(log).not.toContain("outcome=block");
      // Each re-ask posts the same envelope with the same credential.
      expect(new Set(r.stdin).size).toBe(1);
    }
  });

  test("both clocks: elapsed_ms is milliseconds (non-negative, rising, under 10000 for the run)", () => {
    for (const shape of ["gnu", "unpadded"] as const) {
      const fx = withClock(shimFixture("wait-then-allow"), clockFake(shape));
      fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
      const ms = elapsed(fx.log());
      expect([shape, ms.length]).toEqual([shape, 4]); // start, wait, wait, allow
      for (const v of ms) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(10000);
      }
      expect([...ms].sort((a, b) => a - b)).toEqual(ms);
      // Two 0.05 s pauses at least: a value in milliseconds, not a nanosecond count read as such.
      expect(ms.at(-1)!).toBeGreaterThanOrEqual(100);
    }
  });

  test("the log stamp keeps three fraction digits, with their place value: .266 from a padded fraction, .005 from a trimmed 5567380 (the shape 0.8.0's %3N printed)", () => {
    for (const [shape, want] of [
      ["gnu", UUTILS_FRACTION.slice(0, 3)],
      ["unpadded", "005"],
    ] as const) {
      const fx = withClock(shimFixture("allow"), clockFake(shape));
      fx.run();
      const lines = fx.log().trim().split("\n");
      expect([shape, lines.length]).toEqual([shape, 2]);
      for (const line of lines) {
        expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z pid=\d+ /);
        expect(line).toContain(`.${want}Z `);
      }
    }
  });

  test("both clocks: the window is measured in milliseconds (WAIT_S=6 closes after a few re-asks, then the last block stands)", () => {
    for (const shape of ["gnu", "unpadded"] as const) {
      const fx = shimFixture("waiting");
      // DATA-378: each pause moves the clock 5 s, as on a box. With the fixture's 0.05 s pause and a real-time clock
      // the attempt cap (WAIT_S/5 + 2 = 3) ended the loop before the window did.
      withClock(fx, clockFake(shape, virtualSleep(fx)));
      // A unit read wrongly here would run the loop for hours: bound the run, so it fails instead of hanging.
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "6" }, { timeoutMs: 20000 });
      expect([shape, r.code]).toEqual([shape, 2]);
      // Exactly 2: attempt 1's check comes within 1 s of T0 (as before), and the 5 s pause then closes the window.
      expect(r.calls).toBe(2);
      expect(JSON.parse(r.stdout).message).toStartWith("hook-timeout:");
      // The loop stops once now + 5 s reaches T0 + 6 s: after the first 5 s pause, so the last line reads about 5 s.
      const ms = elapsed(fx.log());
      expect(ms.at(-1)!).toBeGreaterThanOrEqual(5000);
      expect(ms.at(-1)!).toBeLessThan(10000);
    }
  });

  test("an unpadded clock: a first post that hit the curl ceiling is re-asked and the later answer stands", () => {
    const fx = withClock(shimFixture("first-timeout"), clockFake("unpadded"));
    const r = fx.run({ APPROVAL_HOOK_WAIT_S: "8" });
    expect([r.code, r.stdout, r.calls]).toEqual([0, "{}", 2]);
    expect(fx.log()).toContain("outcome=wait http=000 curl=28");
  });

  test("a clock of whole seconds (no fraction) re-asks the same way", () => {
    const fx = withClock(shimFixture("wait-then-allow"), clockFake("s"));
    const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
    expect([r.code, r.stdout, r.calls]).toEqual([0, "{}", 3]);
    const ms = elapsed(fx.log());
    expect(ms.length).toBe(4);
    for (const v of ms) {
      expect(v % 1000).toBe(0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10000);
    }
  });

  test("every clock keeps the verdicts: allow, block, unreachable and an unanswered wait (WAIT_S=0)", () => {
    for (const shape of ["gnu", "unpadded", "s"] as const) {
      for (const [mode, code, calls] of [
        ["allow", 0, 1],
        ["block", 2, 1],
        ["unreachable", 2, 1],
        ["waiting", 2, 1],
      ] as const) {
        const fx = withClock(shimFixture(mode), clockFake(shape));
        const r = fx.run({ APPROVAL_HOOK_WAIT_S: "0" });
        expect([shape, mode, r.code, r.calls]).toEqual([shape, mode, code, calls]);
        if (code !== 0) expect(JSON.parse(r.stdout).action).toBe("block");
        else expect(r.stdout).toBe("{}");
      }
    }
  }, 30000); // 12 real shim runs: past bun's 5 s default on a loaded machine, as the pre-existing matrices were

  test("a fraction that is not one to nine digits (BSD's letter N, empty, ten digits) or a value with no dot and not digits is 0: no re-asking, the first wait answer is the block", () => {
    for (const stamp of ["1700000000.N", "1700000000.", "1700000000.1234567890", "17000000003N", "1700000000.26.6"]) {
      const fx = withClock(shimFixture("wait-then-allow"), fixedClock(stamp));
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
      expect([stamp, r.code, r.calls]).toEqual([stamp, 2, 1]);
      expect(JSON.parse(r.stdout).message).toStartWith("hook-timeout:");
      expect(r.stderr).not.toMatch(/arithmetic|octal|base|Illegal number|syntax error/i);
      expect(elapsed(fx.log())).toEqual([0, 0]);
    }
  }, 30000); // 5 real shim runs

  test("seconds with a leading zero, or more than twelve of them, are 0, not a fatal octal error: a directive every time, verdicts intact, no re-asking", () => {
    for (const stamp of ["01791357719.266000000", "0001791357719.266", "1791357719266000.266"]) {
      for (const [mode, code, calls] of [
        ["allow", 0, 1],
        ["block", 2, 1],
        ["unreachable", 2, 1],
        ["wait-then-allow", 2, 1],
      ] as const) {
        const fx = withClock(shimFixture(mode), fixedClock(stamp));
        const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
        expect([stamp, mode, r.code, r.calls]).toEqual([stamp, mode, code, calls]);
        if (code !== 0) expect(JSON.parse(r.stdout).action).toBe("block");
        else expect(r.stdout).toBe("{}");
        expect(r.stderr).not.toMatch(/arithmetic|octal|base|Illegal number/i);
        expect(elapsed(fx.log())).toEqual([0, 0]);
      }
    }
  }, 30000); // 12 real shim runs, as above

  test("a fraction with leading zeros is read as nanoseconds: .0266 is 266 ns = 0 ms, .000000001 is 0 ms; not an octal error", () => {
    // Two reads of a still clock: elapsed_ms is 0 either way; the point is that neither value is read as 0 at T0
    // (the window stays open, so the wait is re-asked) and that nothing is fatal.
    for (const stamp of ["1791357719.0266", "1791357719.000000001", "1791357719.099999999"]) {
      const fx = withClock(shimFixture("wait-then-allow"), fixedClock(stamp));
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" });
      expect([stamp, r.code, r.stdout, r.calls]).toEqual([stamp, 0, "{}", 3]);
      expect(r.stderr).not.toMatch(/arithmetic|octal|base|Illegal number/i);
      expect(elapsed(fx.log())).toEqual([0, 0, 0, 0]);
    }
  });
});

// ---------------------------------------------------------------------------
// DATA-380: the shim answers allow and block without starting node. Each sh
// reading stands in for node code the shim still carries and still uses for
// whatever the sh reading declines, so each is checked against that code:
// the verdict body (VERDICT_JS), the tool name and the block message's JSON.
// ---------------------------------------------------------------------------

/** The given shells that are installed, each binary once (/bin/sh is dash on Debian). */
function data380Shells(candidates: string[]): string[] {
  const seen = new Set<string>();
  return candidates.filter((s) => {
    if (!existsSync(s)) return false;
    const real = realpathSync(s);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}
/** Full shim runs: /bin/sh (bash 3.2 on macOS, dash on Debian) and dash. */
const DATA380_SHELLS = data380Shells(["/bin/sh", "/bin/dash"]);
/** The extracted functions, which run in milliseconds: bash as well. */
const DATA380_UNIT_SHELLS = data380Shells(["/bin/sh", "/bin/dash", "/bin/bash"]);

/** A body as the core's streamsBody prints it (approval-md src/serve/server.ts). */
function coreBody(o: Record<string, unknown>): string {
  return JSON.stringify({ exit_code: 0, stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false, ...o });
}
/** `approval hook hermes`'s block, as it prints it. */
function hermesBlock(message: string): string {
  return `${JSON.stringify({ action: "block", message })}\n`;
}
const HERMES_ALLOW_ERR = "approval hook hermes: allow \u2014 terminal: read-only; class read (no approval needed)\n";

/** Log lines without the stamp, pid, elapsed time and path, for comparing two runs. */
function outcomes(log: string): string[] {
  return log
    .split("\n")
    .filter((l) => l.includes(" outcome="))
    .map((l) => l.replace(/^\S* pid=\d+ /, "").replace(/ path=\w+/, "").replace(/ elapsed_ms=-?\d+$/, ""));
}

/**
 * A clock that stands still: no perl per call, which these tables would pay
 * hundreds of times. A re-ask still happens (now + 5 s stays under the
 * deadline), and the second answer ends it.
 */
const STILL_CLOCK = '#!/bin/sh\ncase "$1" in +%s.%N) echo 1791357719.266000000 ;; *) exec /bin/date "$@" ;; esac\n';

/** One body through the shim, the sh reading allowed (fast) or not (nosize: node reads it). */
function runBody(body: Buffer | string, shell: string, forceNode: boolean) {
  const fx = withClock(shimFixture("custom-then-allow", null, { shell }), STILL_CLOCK);
  writeFileSync(join(fx.state, "custom.body"), body);
  if (forceNode) writeFileSync(join(fx.state, "nosize"), "");
  const r = fx.run({ APPROVAL_HOOK_WAIT_S: "30" });
  return { r, log: fx.log(), nodeCalls: fx.nodeCalls() };
}

// Bodies the sh reading takes: the core's shapes and the fixtures'.
const DATA380_FAST: [string, string][] = [
  ["fixture allow", JSON.stringify({ exit_code: 0, stdout: "{}", stderr: "" })],
  ["fixture block", JSON.stringify({ exit_code: 2, stdout: JSON.stringify({ action: "block", message: "approval-rejected: the resident declined message.send" }), stderr: "" })],
  ["fixture waiting", JSON.stringify({ exit_code: 2, stdout: JSON.stringify({ action: "block", message: "hook-timeout: no decision yet; the question stays open. NOTHING WAS WITHDRAWN" }), stderr: "" })],
  ["core allow, reason on stderr with the em dash", coreBody({ stdout: "{}\n", stderr: HERMES_ALLOW_ERR })],
  ["core block, quotes and backslashes in the message", coreBody({ exit_code: 2, stdout: hermesBlock('approval-rejected: the resident declined "message.send" \u2014 path C:\\tmp\\x') })],
  ["core hook-timeout, question open", coreBody({ exit_code: 2, stdout: hermesBlock("hook-timeout: no decision within 4m. This tool call is denied and NOTHING WAS WITHDRAWN: retry it \u2014 the retry adopts the question.") })],
  ["core hook-timeout, withdrawn", coreBody({ exit_code: 2, stdout: hermesBlock("hook-timeout: no decision within 4m: q-1 WAS WITHDRAWN (reason timeout).") })],
  ["hook-timeout, NOTHING WAS WITHDRAWN then WAS WITHDRAWN", coreBody({ exit_code: 2, stdout: hermesBlock("hook-timeout: NOTHING WAS WITHDRAWN; later q-2 WAS WITHDRAWN") })],
  ["hook-timeout, the cut joins WAS WITH|DRAWN", coreBody({ exit_code: 2, stdout: hermesBlock("hook-timeout: WAS WITHNOTHING WAS WITHDRAWNDRAWN") })],
  ["hook-timeout, overlapping NOTHING WAS WITHDRAWNOTHING", coreBody({ exit_code: 2, stdout: hermesBlock("hook-timeout: NOTHING WAS WITHDRAWNOTHING WAS WITHDRAWN") })],
  ["hook-timeout, lower case was withdrawn", coreBody({ exit_code: 2, stdout: hermesBlock("hook-timeout: it was withdrawn") })],
  ["code from stderr JSON with blanks and a newline", coreBody({ exit_code: 2, stdout: hermesBlock("approval-rejected: x"), stderr: '{"error":{"code" :\n "hook-timeout","message":"m"}}\n' })],
  ["code from stderr, overlapping \"code\"code\"", coreBody({ stdout: "{}\n", stderr: '"code"code" : "abc"' })],
  ["code in stderr 81 long: none, the message's then", coreBody({ exit_code: 2, stdout: hermesBlock("msg-code: x"), stderr: `"code":"${"a".repeat(81)}"` })],
  ["code in stderr 80 long", coreBody({ stdout: "{}", stderr: `"code":"${"b".repeat(80)}"` })],
  ["message code 80 long", coreBody({ exit_code: 2, stdout: hermesBlock(`${"c".repeat(80)}: x`) })],
  ["message code 81 long: none", coreBody({ exit_code: 2, stdout: hermesBlock(`${"c".repeat(81)}: x`) })],
  ["message code a:b: c", coreBody({ exit_code: 2, stdout: hermesBlock("a:b: c") })],
  ["message code needs the space", coreBody({ exit_code: 2, stdout: hermesBlock("hook-timeout:x NOTHING") })],
  ["exit 0 with a block directive", coreBody({ stdout: hermesBlock("approval-rejected: odd") })],
  ["exit 255 with a block directive", coreBody({ exit_code: 255, stdout: hermesBlock("x: y") })],
  ["exit 0, empty stdout", coreBody({ stderr: "note\n" })],
  ["exit 0, stdout one newline", coreBody({ stdout: "\n" })],
  ["directive-looking text on stderr of an allow", coreBody({ stdout: "{}\n", stderr: '{"action":"block","message":"not the stdout"}\n' })],
];

// Bodies node reads as an answer but the sh reading declines: node reads them, as before.
const DATA380_NODE: [string, string | Buffer][] = [
  ["an extra key", '{"exit_code":0,"stdout":"{}","stderr":"","x":1}'],
  ["keys out of order", '{"stdout":"{}","exit_code":0,"stderr":""}'],
  ["\\u escapes in stdout", '{"exit_code":0,"stdout":"\\u007b\\u007d","stderr":""}'],
  ["blanks between tokens", '{"exit_code": 0, "stdout": "{}", "stderr": ""}'],
  ["a trailing newline", '{"exit_code":0,"stdout":"{}","stderr":""}\n'],
  ["the decision dialect", coreBody({ exit_code: 2, stdout: '{"decision":"block","reason":"r"}\n' })],
  ["a tab escape on stderr", coreBody({ stdout: "{}\n", stderr: "a\tb" })],
  ["other non-ASCII on stderr", coreBody({ stdout: "{}\n", stderr: "caf\u00e9 \u{1F600}" })],
  ["stdout { }", coreBody({ stdout: "{ }" })],
  ["exit_code 2.0", '{"exit_code":2.0,"stdout":"{\\"action\\":\\"block\\",\\"message\\":\\"x: y\\"}","stderr":""}'],
  ["over 8 KiB", coreBody({ stdout: "{}\n", stderr: "z".repeat(8200) })],
  ["\\/ in the message", '{"exit_code":2,"stdout":"{\\"action\\":\\"block\\",\\"message\\":\\"a\\\\/b\\"}","stderr":""}'],
  ["a block with an extra directive key", coreBody({ exit_code: 2, stdout: `${JSON.stringify({ action: "block", message: "x: y", reason: "z" })}\n` })],
];

const ALLOW_FIXTURE = '{"exit_code":0,"stdout":"{}","stderr":""}';
// Bodies node cannot read as an answer: every one blocks, on both readings.
const DATA380_ADVERSARIAL: [string, string | Buffer][] = [
  ["empty", ""],
  ["truncated: no closing brace", ALLOW_FIXTURE.slice(0, -1)],
  ["stdout_truncated true", coreBody({ stdout: "{}\n", stdout_truncated: true })],
  ["stderr_truncated true", coreBody({ stdout: "{}\n", stderr_truncated: true })],
  ["exit_code a string", '{"exit_code":"0","stdout":"{}","stderr":""}'],
  ["exit_code 256", '{"exit_code":256,"stdout":"{}","stderr":""}'],
  ["exit_code -1", '{"exit_code":-1,"stdout":"{}","stderr":""}'],
  ["exit_code 0.5", '{"exit_code":0.5,"stdout":"{}","stderr":""}'],
  ["exit_code 00", '{"exit_code":00,"stdout":"{}","stderr":""}'],
  ["an array", `[${ALLOW_FIXTURE}]`],
  ["exit_code nested", '{"exit_code":{"v":0},"stdout":"{}","stderr":""}'],
  ["garbage after the object", `${ALLOW_FIXTURE}x`],
  ["NUL inside a string", Buffer.from('{"exit_code":0,"stdout":"{}\u0000","stderr":""}')],
  ["NUL after the object", Buffer.concat([Buffer.from(ALLOW_FIXTURE), Buffer.from([0])])],
  ["a raw newline inside stderr", '{"exit_code":0,"stdout":"{}","stderr":"a\nb"}'],
  ["non-UTF-8 byte after {}", Buffer.concat([Buffer.from('{"exit_code":0,"stdout":"{}'), Buffer.from([0xff]), Buffer.from('","stderr":""}')])],
  ["half an em dash after {}", Buffer.concat([Buffer.from('{"exit_code":0,"stdout":"{}'), Buffer.from([0xe2, 0x80]), Buffer.from('","stderr":""}')])],
  ["a byte order mark first", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ALLOW_FIXTURE)])],
  ["stdout not JSON", coreBody({ stdout: "allow" })],
  ["stdout an array", coreBody({ stdout: "[]" })],
  ["exit 2 with {}", coreBody({ exit_code: 2, stdout: "{}\n" })],
  ["exit 1, nothing on stdout", coreBody({ exit_code: 1, stderr: "internal error" })],
  ["duplicate key: truncated true last", '{"exit_code":0,"stdout":"{}","stderr":"","stdout_truncated":false,"stderr_truncated":false,"stdout_truncated":true}'],
  ["duplicate key: exit_code 0 then 1", '{"exit_code":0,"stdout":"{}","stderr":"","exit_code":1}'],
  ["duplicate key: stdout {} then garbage", '{"exit_code":0,"stdout":"{}","stdout":"garbage","stderr":""}'],
  ["a directive on stderr only, exit 2", coreBody({ exit_code: 2, stderr: '{"action":"block","message":"x"}' })],
  ["two directives on stdout", coreBody({ stdout: '{"action":"allow"}\n{"action":"block","message":"x"}\n' })],
  ["a message with a lone backslash before its quote", '{"exit_code":2,"stdout":"{\\"action\\":\\"block\\",\\"message\\":\\"x\\\\\\"}","stderr":""}'],
  ["a raw tab inside the directive's message", coreBody({ exit_code: 2, stdout: '{"action":"block","message":"a\tb"}\n' })],
  ["a closing brace too many", coreBody({ exit_code: 2, stdout: '{"action":"block","message":"x"}}\n' })],
  ["huge and unterminated (1 MiB)", `{"exit_code":0,"stdout":"{}","stderr":"${"x".repeat(1024 * 1024)}`],
];

/** The shim text between two markers, to run one of its functions alone. */
function shimSlice(from: string, to: string): string {
  const source = readFileSync(SHIM_SOURCE, "utf8");
  const a = source.indexOf(from);
  const b = source.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

/** A seeded generator (mulberry32), so a failing fuzz case can be found again. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("DATA-380: the shim answers allow and block without node", () => {
  test("sh -n, dash -n and bash -n are clean", () => {
    for (const shell of ["sh", "dash", "bash"]) {
      if (!Bun.which(shell)) continue;
      expect([shell, Bun.spawnSync([shell, "-n", SHIM_SOURCE]).exitCode]).toEqual([shell, 0]);
    }
  });

  test("allow, block, an answered wait and an unreachable facade start no node; every outcome line says path=fast", () => {
    for (const shell of DATA380_SHELLS) {
      for (const [mode, code, calls] of [
        ["allow", 0, 1],
        ["block", 2, 1],
        ["waiting", 2, 1],
        ["unreachable", 2, 1],
      ] as const) {
        const fx = shimFixture(mode, null, { shell });
        const r = fx.run();
        expect([shell, mode, r.code, r.calls, fx.nodeCalls()]).toEqual([shell, mode, code, calls, 0]);
        const lines = fx.log().split("\n").filter((l) => l.includes(" outcome="));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(line).toContain(" path=fast elapsed_ms=");
        expect(fx.log()).toContain("start tool=terminal ");
      }
      const fx = shimFixture("wait-then-allow", null, { shell });
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "30" });
      expect([shell, r.code, r.stdout, r.calls, fx.nodeCalls()]).toEqual([shell, 0, "{}", 3, 0]);
      expect(fx.log().match(/outcome=wait .* path=fast /g)?.length).toBe(2);
    }
  });

  test("the core's own allow, under a UTF-8 locale and Hermes's own envelope layout, starts no node", () => {
    for (const shell of DATA380_SHELLS) {
      const fx = shimFixture("custom", null, { shell });
      writeFileSync(join(fx.state, "custom.body"), coreBody({ stdout: "{}\n", stderr: HERMES_ALLOW_ERR }));
      // Python's json.dumps separators, as Hermes's _serialize_payload writes them (ensure_ascii=False).
      writeFileSync(
        join(fx.root, "envelope.json"),
        '{"hook_event_name": "pre_tool_call", "tool_name": "write_file", "tool_input": {"path": "/home/hermes/caf\u00e9.md", "content": "x\\ny"}, "session_id": "s-1", "cwd": "/home/hermes", "profile": "default", "extra": {}}',
      );
      const r = fx.run({ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
      expect([shell, r.code, r.stdout, r.stderr, fx.nodeCalls()]).toEqual([shell, 0, "{}\n", HERMES_ALLOW_ERR, 0]);
      expect(fx.log()).toContain("start tool=write_file ");
      expect(fx.log()).toContain("outcome=allow http=200 exit=0 code=- tool=write_file attempt=1 path=fast ");
    }
  });

  test("a facade refusal (HTTP 503) still reads its code with node, and says path=node", () => {
    const fx = shimFixture("http503");
    const r = fx.run();
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).message).toBe("approval facade unreachable: HTTP 503 serve-unavailable");
    expect(fx.nodeCalls()).toBe(1);
    expect(fx.log()).toContain('outcome=block-shim reason="HTTP 503 serve-unavailable" path=node');
  });

  for (const shell of DATA380_SHELLS) {
    test(`verdict table on ${shell}: the sh reading answers exactly as node does, and every adversarial body blocks`, () => {
      const rows: [string, string | Buffer, "fast" | "node" | "adversarial"][] = [
        ...DATA380_FAST.map(([n, b]) => [n, b, "fast"] as [string, string, "fast"]),
        ...DATA380_NODE.map(([n, b]) => [n, b, "node"] as [string, string | Buffer, "node"]),
        ...DATA380_ADVERSARIAL.map(([n, b]) => [n, b, "adversarial"] as [string, string | Buffer, "adversarial"]),
      ];
      expect(DATA380_ADVERSARIAL.length).toBeGreaterThanOrEqual(20);
      for (const [name, body, kind] of rows) {
        const fast = runBody(body, shell, false);
        const node = runBody(body, shell, true);
        const seen = (x: typeof fast) => [name, x.r.code, x.r.stdout, x.r.stderr, x.r.calls, outcomes(x.log)];
        expect(seen(fast)).toEqual(seen(node));
        // The forced run read the verdict with node; the fast run did only where the sh reading declined.
        expect([name, node.nodeCalls]).toEqual([name, node.r.calls]);
        expect([name, fast.nodeCalls]).toEqual([name, kind === "fast" ? 0 : fast.r.calls]);
        if (kind === "adversarial") {
          expect([name, fast.r.code, JSON.parse(fast.r.stdout).action]).toEqual([name, 2, "block"]);
          expect(JSON.parse(fast.r.stdout).message).toStartWith("approval facade unreachable: ");
        }
      }
    }, 600_000);
  }

  test("the tool name: read in sh only where node's JSON.parse would read the same name", () => {
    const cases: [string, string | Buffer, string, boolean][] = [
      // [case, envelope, the logged name, node started for it]
      ["compact", '{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{}}', "terminal", false],
      ["python separators", '{"hook_event_name": "pre_tool_call", "tool_name": "read_file", "tool_input": {}}', "read_file", false],
      ["the last key, compact", '{"hook_event_name":"pre_tool_call","tool_name":"terminal"}', "terminal", false],
      ["a later duplicate wins in JSON.parse", '{"hook_event_name":"pre_tool_call","tool_name":"read_file","tool_input":{},"tool_name":"terminal"}', "terminal", true],
      ["a duplicate spelled with \\u", '{"hook_event_name":"pre_tool_call","tool_name":"read_file","\\u0074ool_name":"terminal"}', "terminal", true],
      ["a duplicate on the next line", '{"hook_event_name":"pre_tool_call","tool_name":"read_file",\n"tool_name":"terminal"}', "terminal", true],
      [
        "a duplicate past a non-UTF-8 byte",
        Buffer.concat([Buffer.from('{"hook_event_name":"pre_tool_call","tool_name":"read_file","x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('","tool_name":"terminal"}')]),
        "terminal",
        true,
      ],
      ["tool_name inside tool_input", '{"hook_event_name":"pre_tool_call","tool_name":"mcp_x","tool_input":{"tool_name":"y"}}', "mcp_x", true],
      ["a name node refuses (space)", '{"hook_event_name":"pre_tool_call","tool_name":"a b","tool_input":{}}', "?", true],
      ["a name 65 long", `{"hook_event_name":"pre_tool_call","tool_name":"${"n".repeat(65)}","tool_input":{}}`, "?", true],
      ["a name 64 long", `{"hook_event_name":"pre_tool_call","tool_name":"${"n".repeat(64)}","tool_input":{}}`, "n".repeat(64), false],
      ["tool_name null", '{"hook_event_name":"pre_tool_call","tool_name":null}', "?", true],
      ["an escaped name", '{"hook_event_name":"pre_tool_call","tool_name":"term\\u0069nal"}', "terminal", true],
      ["another key first", '{"tool_name":"terminal","hook_event_name":"pre_tool_call"}', "terminal", true],
      ["not JSON", "garbage", "?", true],
      // The one place the two differ, stated in the shim: an envelope that is
      // not JSON past Hermes's opening. Node logs `?`; the facade refuses it.
      ["not JSON past the opening (stated)", '{"hook_event_name":"pre_tool_call","tool_name":"terminal",}', "terminal", false],
    ];
    for (const shell of DATA380_SHELLS) {
      for (const [name, envelope, tool, usesNode] of cases) {
        const fx = withClock(shimFixture("allow", null, { shell }), STILL_CLOCK);
        writeFileSync(join(fx.root, "envelope.json"), envelope);
        const r = fx.run();
        expect([shell, name, r.code]).toEqual([shell, name, 0]);
        expect([shell, name, fx.log().match(/ start tool=(\S*) /)?.[1]]).toEqual([shell, name, tool]);
        expect([shell, name, fx.nodeCalls()]).toEqual([shell, name, usesNode ? 1 : 0]);
      }
    }
  }, 300_000);

  test("fuzz: the sh verdict reading, alone, agrees with node running the shim's own VERDICT_JS wherever it answers", () => {
    const dir = scratch("av-approval-verdict-fuzz-");
    const verdictJs = shimSlice("VERDICT_JS='\n", "\n'\n").slice("VERDICT_JS='\n".length);
    const verdictSh = shimSlice("\nNL='\n", "\n# A re-post that fails");
    writeFileSync(join(dir, "verdict.js"), verdictJs);
    writeFileSync(join(dir, "verdict.sh"), verdictSh);
    // One node process runs VERDICT_JS once per body, with its own argv and exit.
    writeFileSync(
      join(dir, "oracle.cjs"),
      `const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
const STOP = {};
for (const d of process.argv.slice(3)) {
  let said = "";
  const proc = { argv: ["node", d + "/body", d + "/node.out", d + "/node.err"], stdout: { write: (s) => { said += s; } }, exit: () => { throw STOP; } };
  try { new Function("require", "process", src)(require, proc); } catch (e) { if (e !== STOP) throw e; }
  fs.writeFileSync(d + "/node.verdict", said);
}
`,
    );
    writeFileSync(
      join(dir, "driver.sh"),
      `. "$1/verdict.sh"
shift
for TMP in "$@"; do
  SIZE=$(wc -c < "$TMP/body" | tr -d ' ')
  printf '%s' "$(verdict_sh)" > "$TMP/sh.verdict"
done
`,
    );

    const rnd = prng(380);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const messages = [
      "approval-rejected: the resident declined message.send",
      "hook-timeout: no decision yet. NOTHING WAS WITHDRAWN",
      "hook-timeout: q WAS WITHDRAWN (reason timeout)",
      'hook-timeout: say "NOTHING WAS WITHDRAWN" \u2014 or not',
      "hook-timeout:x",
      "a:b: c",
      `${"k".repeat(80)}: long`,
      "back\\slash: and \"quotes\"",
      "multi\nline: message",
      "",
    ];
    const stdouts = [
      "",
      "\n",
      "{}",
      "{}",
      "{}\n",
      "{}\n",
      "{}\n",
      "{}\n",
      "{}\n",
      "{}\n",
      "{}\n\n",
      " {}",
      ...messages.map((m) => hermesBlock(m)),
      ...messages.map((m) => JSON.stringify({ action: "block", message: m })),
      '{"decision":"block","reason":"r"}',
      '{"action":"allow"}',
      "[]",
      "allow",
    ];
    const stderrs = [
      "",
      "",
      HERMES_ALLOW_ERR,
      HERMES_ALLOW_ERR,
      HERMES_ALLOW_ERR,
      '{"error":{"code":"hook-timeout","message":"m"}}\n',
      '"code" : \n "x.y:z-1"',
      '"code"code":"q"',
      `"code":"${"v".repeat(81)}"`,
      "tab\there",
      "caf\u00e9",
    ];
    const interesting = [0x22, 0x5c, 0x7b, 0x7d, 0x3a, 0x2c, 0x00, 0x0a, 0x09, 0x20, 0x75, 0x6e, 0x30, 0x32, 0xff, 0xe2, 0x80, 0x94, 0x7f];
    const mutate = (b: Buffer): Buffer => {
      const at = Math.floor(rnd() * (b.length + 1));
      switch (Math.floor(rnd() * 6)) {
        case 0:
          return Buffer.concat([b.subarray(0, at), Buffer.from([pick(interesting)]), b.subarray(at)]);
        case 1:
          return Buffer.concat([b.subarray(0, at), b.subarray(at + 1)]);
        case 2: {
          const c = Buffer.from(b);
          if (at < c.length) c[at] = pick(interesting);
          return c;
        }
        case 3:
          return b.subarray(0, at);
        case 4: {
          const from = Math.floor(rnd() * b.length);
          const len = Math.floor(rnd() * 24);
          return Buffer.concat([b.subarray(0, at), b.subarray(from, from + len), b.subarray(at)]);
        }
        default:
          return Buffer.concat([b.subarray(0, at), Buffer.from(pick([',"x":1', '"', "\\", "\\u0041", "\\n", '","stderr":"', '"}', "\u2014"])), b.subarray(at)]);
      }
    };
    const cases: Buffer[] = [];
    for (let i = 0; i < 1000; i++) {
      const exit = pick([0, 0, 0, 2, 2, 2, 1, 255]);
      const o: Record<string, unknown> = { exit_code: exit, stdout: pick(stdouts), stderr: pick(stderrs) };
      if (rnd() < 0.7) {
        o.stdout_truncated = rnd() < 0.9 ? false : true;
        o.stderr_truncated = rnd() < 0.9 ? false : true;
      }
      let b = Buffer.from(JSON.stringify(o));
      if (rnd() < 0.45) {
        const n = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) b = mutate(b);
      }
      cases.push(b);
    }
    const dirs = cases.map((b, i) => {
      const d = join(dir, `c${i}`);
      mkdirSync(d);
      writeFileSync(join(d, "body"), b);
      return d;
    });
    const o = Bun.spawnSync([NODE!, join(dir, "oracle.cjs"), join(dir, "verdict.js"), ...dirs]);
    expect(o.exitCode).toBe(0);

    for (const shell of DATA380_UNIT_SHELLS) {
      for (const d of dirs) for (const f of ["sh.verdict", "out", "err"]) rmSync(join(d, f), { force: true });
      const s = Bun.spawnSync([shell, join(dir, "driver.sh"), dir, ...dirs]);
      expect([shell, s.exitCode, s.stderr.toString()]).toEqual([shell, 0, ""]);
      const answered: Record<string, number> = { allow: 0, block: 0, wait: 0 };
      for (const d of dirs) {
        const sh = readFileSync(join(d, "sh.verdict"), "utf8");
        const node = readFileSync(join(d, "node.verdict"), "utf8");
        if (sh === "") {
          // Declined: the sh reading wrote nothing, and node reads the body.
          expect([shell, d, existsSync(join(d, "out")), existsSync(join(d, "err"))]).toEqual([shell, d, false, false]);
          continue;
        }
        expect([shell, d, sh]).toEqual([shell, d, node]);
        expect(readFileSync(join(d, "out")).equals(readFileSync(join(d, "node.out")))).toBe(true);
        expect(readFileSync(join(d, "err")).equals(readFileSync(join(d, "node.err")))).toBe(true);
        answered[sh.split(" ")[1]]++;
      }
      // The sh reading takes a real share of each kind, not just the trivial ones.
      expect([shell, answered.allow > 30, answered.block > 100, answered.wait > 30]).toEqual([shell, true, true, true]);
    }
  }, 300_000);

  /**
   * block_json, sliced from the shim, behind a driver that reads each file
   * byte for byte, writes back what it read (`<file>.in`) and block_json's
   * answer for it (`<file>.sh`). The `x` sentinel is stripped under LC_ALL=C:
   * bash 5.2 under a UTF-8 locale rewrites `${s%x}` when s holds an invalid
   * UTF-8 sequence (DATA-419: `\\` 0xd8 `\j>0xi` came out as `\\` and a few
   * stray bytes, sometimes all printable). The locale is then put back, so
   * block_json runs under the caller's as it does in the shim.
   */
  function blockJsonDir(prefix: string): string {
    const dir = scratch(prefix);
    writeFileSync(join(dir, "block_json.sh"), shimSlice("block_json() {", "\n}\n") + "\n}\n");
    writeFileSync(
      join(dir, "driver.sh"),
      `. "$1/block_json.sh"
shift
lc=\${LC_ALL-} had=\${LC_ALL+1}
for f in "$@"; do
  LC_ALL=C
  s=$(cat "$f"; printf x)
  s=\${s%x}
  if [ -n "$had" ]; then LC_ALL=$lc; else unset LC_ALL; fi
  printf '%s' "$s" > "$f.in"
  printf '%s' "$(block_json "approval facade unreachable: $s")" > "$f.sh"
done
`,
    );
    return dir;
  }
  /** The runner's own locale (LC_ALL unset), then C and C.UTF-8 pinned, so a UTF-8 locale is read on every host. */
  const BLOCK_JSON_LOCALES: (string | undefined)[] = [undefined, "C", "C.UTF-8"];
  function runBlockJson(shell: string, lc: string | undefined, dir: string, files: string[]): void {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.LC_ALL;
    if (lc !== undefined) env.LC_ALL = lc;
    for (const f of files) for (const x of [".in", ".sh"]) rmSync(`${f}${x}`, { force: true });
    const s = Bun.spawnSync([shell, join(dir, "driver.sh"), dir, ...files], { env });
    expect([shell, lc, s.exitCode]).toEqual([shell, lc, 0]);
  }

  test("fuzz: the sh block message JSON is JSON.stringify's for printable ASCII, and declines everything else", () => {
    const dir = blockJsonDir("av-approval-block-json-");
    const rnd = prng(2380);
    const files: string[] = [];
    const inputs: Buffer[] = [];
    for (let i = 0; i < 400; i++) {
      const len = Math.floor(rnd() * 40);
      const bytes: number[] = [];
      const ascii = rnd() < 0.6;
      for (let k = 0; k < len; k++) {
        const r = rnd();
        if (r < 0.15) bytes.push(0x22);
        else if (r < 0.3) bytes.push(0x5c);
        else if (ascii || r < 0.85) bytes.push(0x20 + Math.floor(rnd() * 95));
        else bytes.push(1 + Math.floor(rnd() * 255));
      }
      const f = join(dir, `m${i}`);
      writeFileSync(f, Buffer.from(bytes));
      files.push(f);
      inputs.push(Buffer.from(bytes));
    }
    for (const shell of DATA380_UNIT_SHELLS)
      for (const lc of BLOCK_JSON_LOCALES) {
        runBlockJson(shell, lc, dir, files);
        let printable = 0;
        files.forEach((f, i) => {
          // What block_json was given is the input itself, so a verdict below is about block_json.
          expect([shell, lc, f, readFileSync(`${f}.in`).toString("hex")]).toEqual([shell, lc, f, inputs[i].toString("hex")]);
          const sh = readFileSync(`${f}.sh`, "utf8");
          const isPrintable = inputs[i].every((c) => c >= 0x20 && c <= 0x7e);
          if (!isPrintable) {
            expect([shell, lc, f, sh]).toEqual([shell, lc, f, ""]);
            return;
          }
          printable++;
          const expected = JSON.stringify({ action: "block", message: `approval facade unreachable: ${inputs[i].toString("latin1")}` });
          expect([shell, lc, f, sh]).toEqual([shell, lc, f, expected]);
        });
        expect(printable).toBeGreaterThan(150);
      }
  }, 120_000);

  test("DATA-419: the fuzz's m102 and m285 (an invalid UTF-8 sequence after backslashes) reach block_json byte for byte under every shell and locale, and it declines them", () => {
    const dir = blockJsonDir("av-approval-block-json-419-");
    // m102: \\ 0xd8 \j>0xi, the input CI failed on; m285: 0xfd \\"yw\.l"!d. Each
    // came out of bash 5.2's ${s%x} under C.UTF-8 as `\\` or nothing and a few
    // stray bytes. Then a printable control with both escapes: \\"\ .
    const cases = [
      { hex: "5c5cd85c6a3e307869", sh: "" },
      { hex: "fd5c5c2279775c2e6c222164", sh: "" },
      { hex: "5c5c225c", sh: JSON.stringify({ action: "block", message: 'approval facade unreachable: \\\\"\\' }) },
    ];
    const files = cases.map((c, i) => {
      const f = join(dir, `c${i}`);
      writeFileSync(f, Buffer.from(c.hex, "hex"));
      return f;
    });
    for (const shell of DATA380_UNIT_SHELLS)
      for (const lc of BLOCK_JSON_LOCALES) {
        runBlockJson(shell, lc, dir, files);
        const got = files.map((f) => [readFileSync(`${f}.in`).toString("hex"), readFileSync(`${f}.sh`, "utf8")]);
        expect([shell, lc, got]).toEqual([shell, lc, cases.map((c) => [c.hex, c.sh])]);
      }
  });
});

// ---------------------------------------------------------------------------
// DATA-378: the re-ask loop is bounded whatever the clock does. Found by the
// DATA-377 refuter (NOTE 1): the loop ended only when now + 5 s reached
// T0 + WAIT_S, so a clock that read 0 after the start (date failed or printed
// no digits) or stepped back kept it re-posting for as long as the facade
// answered hook-timeout, past Hermes's 300 s entry timeout. Inside the loop a
// read of 0 or below the last good read now counts as the deadline passed,
// and the attempts are capped at WAIT_S/5 + 2.
//
// The virtual clock below starts at 1791393600.266 s and moves only when the
// fake sleep adds its 5 s, so every count here is exact. The shim reads it
// (call numbers, waiting mode): 1 T0, 2 the start line, then attempt 1: 3 P0,
// 4 the deadline check, 5 the wait line; attempt k >= 2: 4k-2 the time left,
// 4k-1 P0, 4k the deadline check, 4k+1 the wait line.
// ---------------------------------------------------------------------------

const V0_S = 1791393600;

/**
 * A fake `date` on the virtual clock: `+%s.%N` prints V0_S plus the seconds
 * virtualSleep added, and counts its calls in state/clock.n, so `rule` (sh;
 * $n is the call number, $s the seconds about to be printed) can break the
 * clock from some call on.
 */
function virtualClock(fx: ReturnType<typeof shimFixture>, rule = ""): ReturnType<typeof shimFixture> {
  const vsec = virtualSleep(fx);
  return withClock(
    fx,
    `#!/bin/sh
case "$1" in
  +%s.%N)
    f='${fx.state}/clock.n'; n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"
    s=$(( ${V0_S} + $(cat '${vsec}' 2>/dev/null || echo 0) ))
    ${rule}
    echo "$s.266000000" ;;
  *) exec /bin/date "$@" ;;
esac
`,
  );
}

/** The virtual seconds the fake sleep added (0 when it never ran). */
function virtualSeconds(fx: ReturnType<typeof shimFixture>): number {
  const f = join(fx.state, "vsec");
  return existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
}

/** The facade's own hook-timeout block, replayed at exit 2, with the log's last line the loop's outcome=block. */
function expectWaitBlock(label: string, fx: ReturnType<typeof shimFixture>, r: ShimRun, posts: number): void {
  expect([label, r.code, r.calls]).toEqual([label, 2, posts]);
  expect(JSON.parse(r.stdout).message).toStartWith("hook-timeout:");
  const last = fx.log().trim().split("\n").at(-1)!;
  expect(last).toMatch(
    new RegExp(` outcome=block http=200 exit=2 code=hook-timeout tool=terminal attempt=${posts} path=\\w+ elapsed_ms=-?\\d+$`),
  );
  expect(r.stderr).not.toMatch(/arithmetic|octal|base|Illegal number|syntax error/i);
}

describe("DATA-378: a clock that reads 0 or steps back mid-run ends the re-ask window, and the attempts are capped", () => {
  // A broken loop would run until killed: every run is bounded, so a regression fails instead of hanging. The bound and
  // the test timeouts are generous: a sound run takes a second or two, but this machine under load (XProtect scanning
  // each new fake) has taken over 10 s to reach the first post.
  const BOUND = { timeoutMs: 25000 };

  for (const shell of DATA380_SHELLS) {
    test(`AC #1: a clock that stops after the start (exit 1, or nothing at exit 0) ends with the block, at most WAIT_S/5 + 2 posts, within WAIT_S + 5 s virtual (${shell})`, () => {
      // From call 3 (attempt 1's P0), 6 (attempt 2's time left) and 10 (attempt 3's): the post under way is the last,
      // so 1, 2 and 3 posts. Before DATA-378 each of these ran until killed. A clock lost at the time-left read is the
      // deadline passed, so that last post gets the 1 s floor, not MAX_TIME (before, a 0 there made the time left
      // an epoch and the post got the full MAX_TIME).
      for (const [from, posts, lastMaxTime] of [
        [3, 1, "25"],
        [6, 2, "1"],
        [10, 3, "1"],
      ] as const) {
        for (const stop of ["exit 1", "exit 0"]) {
          const fx = virtualClock(shimFixture("waiting", null, { shell }), `[ "$n" -lt ${from} ] || ${stop}`);
          const r = fx.run({ APPROVAL_HOOK_WAIT_S: "20", APPROVAL_HOOK_MAX_TIME: "25" }, BOUND);
          expectWaitBlock(`${shell} from=${from} ${stop}`, fx, r, posts);
          expect(r.calls).toBeLessThanOrEqual(20 / 5 + 2);
          expect(virtualSeconds(fx)).toBeLessThanOrEqual(20 + 5);
          const argv = r.argv.at(-1)!.split("\n");
          expect([from, argv[argv.indexOf("--max-time") + 1]]).toEqual([from, lastMaxTime]);
        }
      }
    }, 180000);

    test(`AC #2: a clock stepped back 60 s mid-run ends with the block at the first read that sees the step, never later than the deadline (${shell})`, () => {
      // The step lands at call 6 (attempt 2's time left) or 8 (attempt 2's deadline check): attempt 2 is the last
      // post either way, so exactly 2. Before DATA-378 the step moved the deadline out by 60 s (16 posts, 75 s
      // virtual); without the backwards check the cap ends it at 6.
      for (const at of [6, 8]) {
        const fx = virtualClock(shimFixture("waiting", null, { shell }), `[ "$n" -lt ${at} ] || s=$((s - 60))`);
        const r = fx.run({ APPROVAL_HOOK_WAIT_S: "20" }, BOUND);
        expectWaitBlock(`${shell} at=${at}`, fx, r, 2);
        expect(virtualSeconds(fx)).toBe(5);
      }
    }, 60000);

    test(`the cap: a clock that stands still (now + 5 s never reaches the deadline) ends after exactly WAIT_S/5 + 2 posts (${shell})`, () => {
      for (const [wait, cap] of [
        ["20", 6],
        ["6", 3],
      ] as const) {
        const fx = withClock(shimFixture("waiting", null, { shell }), fixedClock(`${V0_S}.266000000`));
        const r = fx.run({ APPROVAL_HOOK_WAIT_S: wait }, BOUND);
        expectWaitBlock(`${shell} WAIT_S=${wait}`, fx, r, cap);
        expect(fx.log().match(/outcome=wait /g)?.length).toBe(cap - 1);
      }
    }, 60000);

    test(`negative control: a clock that works ends at the deadline, not at the cap; WAIT_S=20 posts 4 times as before DATA-378 (${shell})`, () => {
      const fx = virtualClock(shimFixture("waiting", null, { shell }));
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "20" }, BOUND);
      // Posts at 0, 5, 10 and 15 s; at 15 s, 15 + 5 reaches the 20 s deadline. The cap would be 6.
      expectWaitBlock(shell, fx, r, 4);
      expect(elapsed(fx.log())).toEqual([0, 0, 5000, 10000, 15000]);
      expect(virtualSeconds(fx)).toBe(15);
    }, 30000);

    test(`negative control at the installed window: WAIT_S=280 ends at the deadline after 56 posts, under the cap of 58 (${shell})`, () => {
      const fx = virtualClock(shimFixture("waiting", null, { shell }));
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "280" }, { timeoutMs: 60000 });
      expectWaitBlock(shell, fx, r, 56);
      expect(elapsed(fx.log()).at(-1)).toBe(275000);
    }, 90000);

    test(`a working clock and a resident who taps: the later allow stands, as before (${shell})`, () => {
      const fx = virtualClock(shimFixture("wait-then-allow", null, { shell }));
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "20" }, BOUND);
      expect([r.code, r.stdout, r.calls]).toEqual([0, "{}", 3]);
      expect(elapsed(fx.log())).toEqual([0, 0, 5000, 10000]);
    }, 30000);

    test(`a clock lost at the first post's P0 and good again after it: a first post that timed out is final, not re-asked (${shell})`, () => {
      // Refuter S1. Call 3 (attempt 1's P0) fails, so LOST is set and P0 is the last good read (T0). From call 4 the
      // clock reads 1 s later: the first-timeout check measures NOW - P0 = 1000 ms >= MAX_TIME (1 s) and enters the
      // branch, where LOST blocks with the transport reason. Without that guard the shim re-asked and the fixture's
      // second answer (allow) stood: exit 0, 2 posts.
      const fx = virtualClock(shimFixture("first-timeout", null, { shell }), `[ "$n" -ne 3 ] || exit 1; [ "$n" -lt 4 ] || s=$((s + 1))`);
      const r = fx.run({ APPROVAL_HOOK_WAIT_S: "8" }, BOUND);
      expect([r.code, r.calls]).toEqual([2, 1]);
      expect(JSON.parse(r.stdout).message).toContain("transport failure (curl exit 28");
      expect(fx.log()).not.toContain("outcome=wait");
    }, 30000);
  }
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
      "http://127.0.0.1:010",
      "http://127.0.0.1:04682",
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
    // `approval serve` itself, no hosted supervisor: it reads Authorization only.
    expect(r.stdin[0]).toBe(`header = "Authorization: Bearer ${TOKEN}"\n`);
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
    // `approval serve` itself, no hosted supervisor: it reads Authorization only.
    expect(r.stdin[0]).toBe(`header = "Authorization: Bearer ${TOKEN}"\n`);
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

// ---------------------------------------------------------------------------
// DATA-379: the pre-warm after the live fire (and `--prewarm` for the control
// plane): the live fire's request once more, through the installed shim;
// labelled source=prewarm, never re-asked, never fatal
// ---------------------------------------------------------------------------

describe("DATA-379: the pre-warm", () => {
  /** The facade's refusal of a Hermes terminal call with no workdir, as the core prints it (APRV-415). */
  const REFUSED = coreBody({
    exit_code: 2,
    stdout: hermesBlock("hook-unsupported-execution-context: Hermes terminal states no workdir; set workdir to an absolute path"),
  });
  const LOCAL_URL = "http://127.0.0.1:4682";
  const SHIM_UNREACHABLE = {
    returncode: 2,
    stdout: JSON.stringify({ action: "block", message: "approval facade unreachable: transport failure (curl exit 7)" }),
    parsed: { action: "block", message: "x" },
    error: null,
    timed_out: false,
  };
  const PREWARM_SENT = "→ approval gate: pre-warm sent (refused by the facade as expected";

  /**
   * An overlay source tree whose shim is the fixture's copy (fake curl, date, stat), so the real
   * pre-warm runs the real shim code end to end. The fake curl's first call also keeps the
   * envelope it posted and the environment it ran in.
   */
  function prewarmWorld(mode: string): { fx: ReturnType<typeof shimFixture>; skills: string } {
    const fx = shimFixture(mode);
    writeFileSync(join(fx.state, "custom.body"), REFUSED);
    const skills = scratch("av-approval-prewarm-skills-");
    cpSync(join(SOURCE_SKILLS, "approval"), join(skills, "approval"), { recursive: true });
    writeFileSync(join(skills, "approval", "scripts", "hermes-hook-shim.sh"), readFileSync(join(fx.root, "hermes-hook-shim.sh")));
    writeFileSync(
      join(fx.state, "after.1"),
      `f=$(grep '^@' '${fx.state}/argv.1' | head -n 1)\ncp "\${f#@}" '${fx.state}/envelope.1'\nenv > '${fx.state}/env.1'\n`,
    );
    return { fx, skills };
  }
  const hookLog = (home: string) => {
    const path = join(home, "agent-hooks", "approval-hook.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  const calls = (fx: ReturnType<typeof shimFixture>) =>
    existsSync(join(fx.state, "count")) ? Number(readFileSync(join(fx.state, "count"), "utf8")) : 0;
  const prewarmLines = (lines: string[]) => lines.filter((l) => l.includes("pre-warm"));

  test("after a live fire the facade answered, the install sends ONE pre-warm through the installed shim: the live fire's request, every log line source=prewarm, nothing else written", () => {
    const { fx, skills } = prewarmWorld("custom");
    const home = tenant();
    fakeHermes();
    // The default (no stub): what install.ts runs.
    expect(installApproval(skills, opts({ prewarm: undefined }))).toBe("installed");
    expect(calls(fx)).toBe(1);
    // The request is the live fire's: terminal, no workdir (refused before the policy decision, appends nothing).
    const envelope = JSON.parse(readFileSync(join(fx.state, "envelope.1"), "utf8"));
    expect(envelope).toMatchObject({ hook_event_name: "pre_tool_call", tool_name: "terminal", session_id: PREWARM_SESSION });
    expect(envelope.tool_input).toEqual({ command: "ls /tmp" });
    // The shim got the pre-warm's fixed settings and only the names it reads from .env.
    const env = readFileSync(join(fx.state, "env.1"), "utf8");
    expect(env).toContain("APPROVAL_HOOK_SOURCE=prewarm\n");
    expect(env).toContain("APPROVAL_HOOK_WAIT_S=0\n");
    expect(env).toContain(`APPROVAL_HOOK_MAX_TIME=${PREWARM_MAX_TIME_S}\n`);
    expect(PREWARM_MAX_TIME_S).toBe(10);
    for (const foreign of ["AV_EVENTS_TOKEN", "FAKE_HERMES_STATE", "PYTHONPATH"]) expect(env).not.toContain(foreign);
    // The shim log: the pre-warm's lines only (the fake Hermes's live fire runs no shim), each labelled.
    const lines = hookLog(home).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line).toMatch(/ source=prewarm elapsed_ms=\d+$/);
    expect(lines[0]).toContain(" start tool=terminal");
    expect(lines.at(-1)).toContain(" outcome=block http=200 exit=2 code=hook-unsupported-execution-context tool=terminal attempt=1 path=fast source=prewarm elapsed_ms=");
    // One receipt line on stdout, before the step's own last line; nothing on stderr.
    expect(prewarmLines(logs)).toHaveLength(1);
    expect(prewarmLines(logs)[0]).toStartWith(PREWARM_SENT);
    expect(logs.at(-1)).toContain("approval gate installed: 35 pre_tool_call entries (fail_closed)");
    expect(prewarmLines(errors)).toEqual([]);
    expect([...logs, ...errors, hookLog(home)].join("\n")).not.toContain(TOKEN);

    // A second pre-warm (the control plane's `--prewarm`) writes nothing but the log either.
    const before = { files: bytes(home), marker: readFileSync(approvalSurfacePath(), "utf8"), dir: readdirSync(join(home, "agent-hooks")).sort() };
    expect(prewarmApproval()).toMatchObject({ outcome: "facade-block", reason: null });
    expect(calls(fx)).toBe(2);
    expect({ files: bytes(home), marker: readFileSync(approvalSurfacePath(), "utf8"), dir: readdirSync(join(home, "agent-hooks")).sort() }).toEqual(before);
    expect(before.dir).toEqual(["approval-hook.log", "approval-surface.json", "hermes-hook-shim.sh"]);
  }, 120_000);

  test("runs once per install after a passing live fire; never after a failed or deferred one, nor with the gate unset or off", () => {
    tenant();
    fakeHermes();
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(prewarmCalls).toBe(1);
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(prewarmCalls).toBe(2);

    // A failed live fire: the step fails, nothing is pre-warmed.
    prewarmCalls = 0;
    tenant();
    fakeHermes({ run_once: { returncode: 0, stdout: "{}", parsed: null, error: null, timed_out: false } });
    failsWith("live-call-allowed");
    tenant();
    fakeHermes({ run_once: SHIM_UNREACHABLE });
    failsWith("live-facade-unreachable");
    tenant();
    fakeHermes();
    expect(() => installApproval(SOURCE_SKILLS, opts({ hermesPython: null }))).toThrow();
    expect(prewarmCalls).toBe(0);

    // A deferred live fire (a local facade that did not answer): installed, not pre-warmed, and said so.
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: LOCAL_URL, AV_APPROVAL_TOKEN: TOKEN, TENANT_ID: TENANT } });
    fakeHermes({ run_once: SHIM_UNREACHABLE });
    logs = [];
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(prewarmCalls).toBe(0);
    expect(prewarmLines(logs)).toEqual(["→ approval gate: pre-warm not run (the live self-check was deferred)"]);
    expect(logs.at(-1)).toContain("self-check passed (live: deferred, live-facade-unreachable)");

    // Unset and off never reach the live fire.
    tenant({ env: {} });
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("skipped");
    tenant({ env: { AV_APPROVAL_ENABLED: "0" } });
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("disabled");
    expect(prewarmCalls).toBe(0);
  });

  test("OV-249 (B): lastInstallVerified is true only after an install whose live fire the facade answered with the full routed list; a failed, deferred, unset or off run resets it", () => {
    const verified = () => {
      tenant();
      fakeHermes();
      expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
      expect(lastInstallVerified()).toBe(true);
    };
    verified();
    // A failed live fire, or none at all: the step throws and the flag is false.
    fakeHermes({ run_once: { returncode: 0, stdout: "{}", parsed: null, error: null, timed_out: false } });
    failsWith("live-call-allowed");
    expect(lastInstallVerified()).toBe(false);
    verified();
    expect(() => installApproval(SOURCE_SKILLS, opts({ hermesPython: null }))).toThrow();
    expect(lastInstallVerified()).toBe(false);
    // Deferred (a local facade that did not answer): installed, but not verified.
    verified();
    tenant({ env: { AV_APPROVAL_ENABLED: "1", AV_APPROVAL_URL: LOCAL_URL, AV_APPROVAL_TOKEN: TOKEN, TENANT_ID: TENANT } });
    fakeHermes({ run_once: SHIM_UNREACHABLE });
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(lastInstallVerified()).toBe(false);
    // Unset and off.
    verified();
    tenant({ env: {} });
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("skipped");
    expect(lastInstallVerified()).toBe(false);
    verified();
    tenant({ env: { AV_APPROVAL_ENABLED: "0" } });
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("disabled");
    expect(lastInstallVerified()).toBe(false);
  });

  test("OV-249 fix round 2 (R2-N1): a live report without the routed facts installs, but is not a verified gate", () => {
    // The real live self-check, with routed_entries and routed_sha256 stripped from its last line.
    const dir = scratch("av-approval-no-routed-");
    const wrapper = join(dir, "live_selfcheck_no_routed.py");
    const real = join(SOURCE_SKILLS, "approval", "scripts", "live_selfcheck.py");
    writeFileSync(
      wrapper,
      [
        "import json, subprocess, sys",
        `out = subprocess.run([sys.executable, ${JSON.stringify(real)}, *sys.argv[1:]], capture_output=True, text=True)`,
        'lines = out.stdout.strip().split("\\n")',
        "facts = json.loads(lines[-1])",
        'facts.pop("routed_entries", None)',
        'facts.pop("routed_sha256", None)',
        'sys.stdout.write("\\n".join(lines[:-1] + [json.dumps(facts)]) + "\\n")',
        "sys.stderr.write(out.stderr)",
        "sys.exit(out.returncode)",
        "",
      ].join("\n"),
    );
    tenant();
    fakeHermes();
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(lastInstallVerified()).toBe(true);
    tenant();
    fakeHermes();
    expect(installApproval(SOURCE_SKILLS, opts({ liveScript: wrapper }))).toBe("installed");
    expect(lastInstallRouted()).toBe(null);
    expect(lastInstallVerified()).toBe(false);
  });

  test(`${PREWARM_ENV}=0 (or false, no, off; process environment first, then .env) skips it, and says so`, () => {
    for (const off of ["0", "false", "No", " OFF "]) {
      tenant();
      fakeHermes();
      process.env[PREWARM_ENV] = off;
      logs = [];
      expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
      expect(prewarmLines(logs)).toEqual([`→ approval gate: pre-warm skipped (${PREWARM_ENV} is off)`]);
      expect(logs.at(-1)).toContain("approval gate installed");
    }
    expect(prewarmCalls).toBe(0);
    expect(prewarmApproval()).toEqual({ outcome: "skipped", reason: "opted-out", elapsed_ms: null });
    logs = [];
    expect(prewarmCli(["--prewarm"])).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ prewarm: "av-approval", outcome: "skipped", reason: "opted-out", elapsed_ms: null });

    delete process.env[PREWARM_ENV];
    const home = tenant();
    appendEnv(home, `${PREWARM_ENV}=off`);
    fakeHermes();
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(prewarmCalls).toBe(0);
    // Any other value runs it; the process environment is read before .env, as AV_DISPLAY_DEFAULTS is.
    process.env[PREWARM_ENV] = "1";
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(prewarmCalls).toBe(1);
  });

  test("a failure is logged (one stderr line) and ignored: daemon down, an error answer, a throw, a hang, no shim; the install stands and --check is unchanged", () => {
    const { fx, skills } = prewarmWorld("unreachable");
    const home = tenant();
    fakeHermes();
    const o = opts();
    expect(installApproval(skills, o)).toBe("installed");
    logs = [];
    expect(checkCli(["--check"], o)).toBe(0);
    const check = logs.at(-1);

    // Daemon down (curl exit 7): the shim's own block, labelled; the step still succeeds.
    logs = [];
    errors = [];
    expect(runApprovalStep(skills, opts({ prewarm: undefined }))).toBe(true);
    expect(calls(fx)).toBe(1);
    expect(prewarmLines(errors)).toEqual(["! approval gate: pre-warm shim-block; ignored, the install does not depend on it"]);
    expect(prewarmLines(logs)).toEqual([]);
    expect(logs.at(-1)).toContain("approval gate installed");
    expect(hookLog(home)).toMatch(/outcome=block-shim reason="transport failure \(curl exit 7[^\n]* source=prewarm elapsed_ms=\d+\n$/);
    expect(ourEntries(home)).toHaveLength(APPROVAL_GATED_TOOLS.length);
    logs = [];
    expect(checkCli(["--check"], o)).toBe(0);
    expect(logs.at(-1)).toBe(check);

    // The facade answering an error status: the same.
    writeFileSync(join(fx.state, "mode"), "http503");
    errors = [];
    expect(prewarmAfterInstall({ prewarm: undefined })).toMatchObject({ outcome: "shim-block" });
    expect(prewarmLines(errors)).toEqual(["! approval gate: pre-warm shim-block; ignored, the install does not depend on it"]);

    // A pre-warm that throws: reported by name, the install stands (nothing rolled back).
    errors = [];
    expect(
      installApproval(SOURCE_SKILLS, opts({ prewarm: () => { throw new TypeError("boom"); } })),
    ).toBe("installed");
    expect(prewarmLines(errors)).toEqual(["! approval gate: pre-warm error (TypeError); ignored, the install does not depend on it"]);
    expect(ourEntries(home)).toHaveLength(APPROVAL_GATED_TOOLS.length);
    expect(errors.join("\n")).not.toContain("boom");

    // A facade that hangs is cut at the bound.
    installApproval(skills, o);
    writeFileSync(join(fx.state, "mode"), "first-timeout");
    rmSync(join(fx.state, "count"), { force: true });
    expect(prewarmApproval({ timeoutMs: 400 })).toMatchObject({ outcome: "error", reason: "timed-out" });

    // No shim, or one that cannot run: skipped, exit 0, said on stderr by the install's call.
    chmodSync(approvalShimPath(), 0o600);
    expect(prewarmApproval()).toEqual({ outcome: "skipped", reason: "shim-not-executable", elapsed_ms: null });
    rmSync(approvalShimPath());
    logs = [];
    expect(prewarmCli(["--prewarm"])).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ prewarm: "av-approval", outcome: "skipped", reason: "shim-missing", elapsed_ms: null });
    errors = [];
    prewarmAfterInstall({ prewarm: undefined });
    expect(prewarmLines(errors)).toEqual(["! approval gate: pre-warm skipped (shim-missing); ignored, the install does not depend on it"]);

    // The gate off: nothing to warm.
    tenant({ env: {} });
    expect(prewarmApproval()).toEqual({ outcome: "skipped", reason: "approval-not-enabled", elapsed_ms: null });
  }, 120_000);

  test("a hook-timeout answer is not waited on: one post, no outcome=wait line, although .env sets a 280 s window", () => {
    const { fx, skills } = prewarmWorld("waiting");
    const home = tenant();
    fakeHermes();
    expect(installApproval(skills, opts())).toBe("installed");
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("APPROVAL_HOOK_WAIT_S=280");
    // Another code than the live fire's: reported, still nothing acted on.
    expect(prewarmApproval()).toMatchObject({ outcome: "facade-block", reason: "code-not-matched" });
    expect(calls(fx)).toBe(1);
    expect(hookLog(home)).not.toContain("outcome=wait");
    expect(hookLog(home)).toContain("outcome=block");
  }, 120_000);

  test("fix round 1 (S1): a live fire blocked with ANOTHER code (a core that decided it) passes the install but is not repeated", () => {
    for (const message of ["approval-rejected: the policy denies terminal ls /tmp", "hook-policy-unavailable: no policy"]) {
      tenant();
      fakeHermes({ run_once: { ...FACADE_BLOCK, stdout: JSON.stringify({ action: "block", message }), parsed: { action: "block", message } } });
      logs = [];
      errors = [];
      expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
      expect(prewarmCalls).toBe(0);
      expect(prewarmLines(logs)).toEqual(["→ approval gate: pre-warm not run (the live fire was decided, not refused)"]);
      expect(prewarmLines(errors)).toEqual([]);
      expect(logs.at(-1)).toContain("self-check passed (live: blocked by the facade)");
    }
    // The expected refusal still pre-warms (the control case of the same fixture).
    tenant();
    fakeHermes();
    expect(installApproval(SOURCE_SKILLS, opts())).toBe("installed");
    expect(prewarmCalls).toBe(1);
  });

  test("fix round 1 (S2): the default spawn bound is 15 s and the default path uses it (a facade that answers after 20 s is cut, timed-out)", () => {
    expect(PREWARM_TIMEOUT_MS).toBe(15_000);
    const { fx, skills } = prewarmWorld("custom");
    tenant();
    fakeHermes();
    expect(installApproval(skills, opts())).toBe("installed");
    // The fake curl answers the expected refusal, but only after 20 s (above the bound, below the test's own).
    writeFileSync(join(fx.state, "after.1"), "/bin/sleep 20\n");
    const t0 = performance.now();
    const r = prewarmApproval();
    const took = performance.now() - t0;
    expect(r).toMatchObject({ outcome: "error", reason: "timed-out" });
    expect(took).toBeGreaterThanOrEqual(PREWARM_TIMEOUT_MS - 500);
    // No upper bound here: the bound kills the shim, and spawnSync then waits for its pipes, which the
    // fake curl (a grandchild, sleeping 20 s) still holds. A real curl holds them at most its own
    // --max-time (APPROVAL_HOOK_MAX_TIME=10, asserted in the first test).
  }, 120_000);

  test("the shim's label: only the exact word prewarm; any other value adds nothing and no run's verdict changes", () => {
    const plain = shimFixture("allow");
    const p = plain.run();
    expect(plain.log()).not.toContain("source=");
    const labelled = shimFixture("allow");
    const l = labelled.run({ APPROVAL_HOOK_SOURCE: "prewarm" });
    for (const line of labelled.log().trim().split("\n")) expect(line).toMatch(/ source=prewarm elapsed_ms=\d+$/);
    for (const forgedValue of ["prewarm elapsed_ms=0", "Prewarm", "prewarm\n", "resident"]) {
      const forged = shimFixture("allow");
      const f = forged.run({ APPROVAL_HOOK_SOURCE: forgedValue });
      expect([forgedValue, forged.log().includes("source=")]).toEqual([forgedValue, false]);
      expect([f.code, f.stdout, f.calls]).toEqual([p.code, p.stdout, p.calls]);
    }
    expect([l.code, l.stdout, l.calls]).toEqual([p.code, p.stdout, p.calls]);
  }, 120_000);

  test("the command line: --check is unchanged, --prewarm takes no argument, anything else is the usage", () => {
    tenant({ env: {} });
    expect(mainCli(["--prewarm", "x"])).toBe(2);
    expect(mainCli([])).toBe(2);
    expect(mainCli(["--bogus"])).toBe(2);
    logs = [];
    expect(mainCli(["--prewarm"])).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ prewarm: "av-approval", outcome: "skipped", reason: "approval-not-enabled", elapsed_ms: null });
    logs = [];
    expect(mainCli(["--check"])).toBe(1);
    expect(JSON.parse(logs.at(-1)!).problems).toEqual(["approval-not-enabled"]);
    expect(checkCli(["--prewarm"])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DATA-424: the facade URL and credential checks are locale-independent.
// They used `[![:print:]]`, which follows the hook's locale: under a UTF-8
// locale a valid multibyte character such as 'é' (c3 a9) passed, under C it
// was refused. Ruling (the lead in Carter's absence, CLAIMS SWEEP-L44,
// 2026-10-09 11:40Z): ASCII-only. Each value must be bytes 0x21-0x7E with no
// `"` or `\`, whatever LC_ALL the shim inherits. Fix round 1 (the refuter's
// SHOULD-1): the 92 allowed characters are spelled out in the pattern, with no
// range, no class and no LC_ALL, so CI's dash and bash 5 pin the same contract
// as the Mac's bash 3.2. A pass case holds all 92, so dropping any one fails.
// ---------------------------------------------------------------------------

/** The installed locales among C.UTF-8 (always run) and en_US.UTF-8, as `locale -a` names them. */
function data424Locales(): string[] {
  const have = Bun.spawnSync(["locale", "-a"]).stdout.toString().split("\n").map((l) => l.trim().toLowerCase().replace("-", ""));
  return ["C", "C.UTF-8", ...(have.includes("en_us.utf8") ? ["en_US.UTF-8"] : [])];
}

describe("DATA-424: the shim's facade URL and credential checks are printable ASCII under every locale", () => {
  const shells = data380Shells(["/bin/sh", "/bin/dash", "/bin/bash", ...(process.env.AV_SHIM_SHELL ? [process.env.AV_SHIM_SHELL] : [])]);
  const locales = data424Locales();
  const URL_BLOCK = `${JSON.stringify({ action: "block", message: "approval facade unreachable: the facade URL contains a character a URL cannot" })}\n`;
  const TOKEN_BLOCK = `${JSON.stringify({
    action: "block",
    message: "approval facade unreachable: the facade credential contains a character a credential cannot",
  })}\n`;
  // [name, the bytes as a printf format]: each refused in the URL and in the credential.
  const refused: [string, string][] = [
    ["é (c3 a9)", "x\\303\\251y"],
    ["tab", "x\\ty"],
    ["space", "x y"],
    ["double quote", 'x\\"y'],
    ["backslash", "x\\\\y"],
    ["DEL (7f)", "x\\177y"],
    ["0x80", "x\\200y"],
    ["CR", "x\\ry"],
    ["LF", "x\\ny"],
    ["VT", "x\\vy"],
    ["FF", "x\\fy"],
  ];
  // Every byte the check allows: 0x21-0x7E less `"` and `\`, 92 characters.
  const ALLOWED = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i))
    .filter((c) => c !== '"' && c !== "\\")
    .join("");

  test("the allowed set is 92 characters", () => {
    expect(ALLOWED.length).toBe(92);
  });

  // One test per shell and locale: each runs the shim 25 times.
  for (const shell of shells)
    for (const lc of locales)
      test(`${shell}, LC_ALL=${lc}: a URL or credential holding é, tab, space, quote, backslash, DEL, 0x80, CR, LF, VT or FF is refused with the existing block message; plain ASCII passes, all 92 allowed characters included`, () => {
        for (const [name, fmt] of refused) {
          const u = shimFixture("allow", null, { shell }).run({ LC_ALL: lc }, { printf: { AV_APPROVAL_URL: `${URL}/${fmt}` } });
          expect(["url", name, u.code, u.calls, u.stdout]).toEqual(["url", name, 2, 0, URL_BLOCK]);
          expect(u.stderr).not.toContain("setlocale");
          const t = shimFixture("allow", null, { shell }).run({ LC_ALL: lc }, { printf: { AV_APPROVAL_TOKEN: `${TOKEN}${fmt}` } });
          expect(["token", name, t.code, t.calls, t.stdout]).toEqual(["token", name, 2, 0, TOKEN_BLOCK]);
          expect(t.stderr).not.toContain("setlocale");
        }
        for (const [url, token] of [
          [URL, TOKEN],
          [`${URL}/~a!b`, `${TOKEN}!~`],
          [`${URL}/${ALLOWED}`, ALLOWED],
        ]) {
          const r = shimFixture("allow", null, { shell }).run({ LC_ALL: lc, AV_APPROVAL_URL: url, AV_APPROVAL_TOKEN: token });
          expect([url, r.code, r.calls, r.stdout]).toEqual([url, 0, 1, "{}"]);
          expect(r.argv[0].trim().split("\n").at(-1)).toBe(`${url}/hook/hermes`);
          expect(r.stdin[0]).toBe(`header = "X-Approval-Authorization: Bearer ${token}"\n`);
          expect(r.stderr).not.toContain("setlocale");
        }
      });
});
