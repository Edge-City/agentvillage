#!/usr/bin/env bun
/**
 * Opt-in approval.md gate (DATA-43, the overlay half): make one sandbox's
 * Hermes tool calls ask the resident's hosted approval.md daemon first.
 *
 * Source of truth: approval-md-hosted docs/03 sections 3.1 to 3.3 and 6, and
 * docs/02 sections 5 to 7. The gate is the vendored shell-hook shim
 * (`skills/approval/scripts/hermes-hook-shim.sh`); this step installs it and
 * writes the config that makes Hermes run it. It decides nothing.
 *
 * Every value the gateway will see is read from `$HERMES_HOME/.env` first and
 * the process environment second, because Hermes loads `.env` with override:
 *
 *   AV_APPROVAL_ENABLED   unset or blank → a no-op (one log line);
 *                         `1|true|yes|on` → install; anything else → the kill
 *                         switch, a FAIL-OPEN event logged as one. The
 *                         control plane (DATA-233, `APPROVALD_ENFORCE`) writes
 *                         `1` or the explicit off `0`.
 *   AV_APPROVAL_URL       the tenant's facade: `https://…` (a hosted facade),
 *                         or, co-located (DATA-233), `http://127.0.0.1:<port>`
 *                         or `unix:<absolute socket path>`. Nothing else.
 *   AV_APPROVAL_TOKEN_FILE
 *                         a file holding the AGENT credential (the control
 *                         plane writes `$HERMES_HOME/approval/agent-token`,
 *                         0600; that default is used when it exists). Read
 *                         before AV_APPROVAL_TOKEN, as the shim does.
 *   AV_APPROVAL_TOKEN     the AGENT credential (docs/02 section 5), the hosted
 *                         dogfood's form. Never printed, never written to
 *                         config.yaml.
 *   AV_APPROVAL_DAEMON_UID
 *                         the uid that must own a loopback listener or the
 *                         unix socket (default 10001); the shim checks it
 *                         before every POST.
 *   AV_APPROVAL_ALLOW_UNPATCHED_HERMES=1
 *                         DOGFOOD ONLY: accept a Hermes below the fail_closed
 *                         floor or without the signal patch, logged loudly.
 *
 * When on, before writing anything: the credentials are checked, and the
 * files this step touches (`agent-hooks/`, the shim, `config.yaml`, `.env`,
 * the surface marker) must be absent or real files/directories under
 * `$HERMES_HOME` (no symlinks), and `config.yaml` must carry no YAML merge key
 * or alias under `hooks` or `plugins` (PyYAML merges what the `yaml` package
 * reads literally, so a merged-in `fail_closed: false` would win in Hermes).
 * Then:
 *
 *   1. The shim is written (temp file, then rename) as
 *      `$HERMES_HOME/agent-hooks/hermes-hook-shim.sh`, 0700. `agent-hooks/`
 *      because the core classifier treats `.hermes/agent-hooks/`,
 *      `.hermes/config.yaml` and `.hermes/hooks*` as `policy.core`.
 *   2. `config.yaml` gets the gate: one `pre_tool_call` entry per matcher in
 *      `APPROVAL_GATED_TOOLS`, each `fail_closed: true`, `timeout: 300`;
 *      `hooks_auto_accept: true`; `plugins.hook_callback_timeout: 600`.
 *   3. `.env` gets `HERMES_ACCEPT_HOOKS=1` and the shim's settings.
 *   4. `execute_code` and relative `workdir`s are refused by the core adapter.
 *   5. No `APPROVAL.md` is written: the daemon holds the policy.
 *   6. The skill is staged and the `av-approval` plugin enabled.
 *   7. `$HERMES_HOME/agent-hooks/approval-surface.json` records
 *      `{daemon_id, tenant_id, installed_at, overrides, prior, shim_sha256}`
 *      (see `writeSurfaceMarker`); `prior` is what the first install found for
 *      each key it sets, and the kill switch restores exactly that.
 *      `shim_sha256` is the installed shim's digest, which the `av-approval`
 *      plugin's start-time integrity check compares (DATA-234).
 *   8. `checkApproval`: the static checks, the states in which Hermes ignores
 *      the gate (including a consent allowlist or its lock Hermes could not
 *      use), and the LIVE fire (one `terminal` call with no `workdir`
 *      through Hermes's own `run_once`, which must come back blocked by the
 *      facade). Any problem rolls `config.yaml` and `.env` back to their
 *      pre-install bytes and fails the step with the named reasons. With a
 *      LOCAL facade (loopback or unix socket, started by the control plane
 *      before the install) a facade that did not answer the fire is logged,
 *      not fatal: the gate itself stays fail-closed. Scripts under
 *      `$HERMES_HOME/scripts/` (cron runs them with no hook) are listed.
 *
 * `bun install/install_approval.ts --check` runs step 8 alone and writes none
 * of this step's files (Hermes's own imports may create Hermes's log or backup
 * directories, and the live fire appends to the shim's log); exit 0 when the
 * gate is in place, 1 otherwise, one JSON line out with `overrides`,
 * `hermes_exit1` (the exit-1 probe's answer) and `cron_scripts`. It is a hand
 * step: nothing runs it at gateway start (the `av-approval` plugin's own
 * integrity check does that, DATA-234).
 *
 * DATA-379, the pre-warm: after a live fire the facade REFUSED with
 * `hook-unsupported-execution-context` (not after a failed or deferred one, nor
 * one blocked with another code, which a core that decided it would give)
 * the step sends the live fire's request once more, straight through the
 * installed shim, labelled `source=prewarm` in the
 * shim's log (`prewarmApproval`). The facade refuses that request before the
 * policy decision and appends nothing, so it records no approval, opens no
 * question and charges no budget; its verdict is discarded and no tool runs.
 * A pre-warm that fails (daemon down, facade unreachable, shim missing, a
 * hang cut at its bound) is one line on stderr and nothing else: the step's
 * result does not depend on it. `AV_APPROVAL_PREWARM=0` (or `false`, `no`,
 * `off`), in the process environment or `.env`, turns it off.
 * `bun install/install_approval.ts --prewarm` runs it alone, for the control
 * plane after a daemon restart that no install follows: one JSON line out,
 * exit 0 whatever happened.
 */

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML, { isAlias, isMap, isScalar, isSeq } from "yaml";

import { dotenvFileValue, dumpConfig, envOrDotenv, readConfig, writeConfig } from "./config";
import { upsertEnvVar } from "./env";
import { hermesBin } from "./hermes_cli";
import { hermesHome, skillsDir } from "./paths";
import { copyPluginTree } from "./plugin_copy";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_SKILLS = join(SCRIPT_DIR, "..", "skills");

export const APPROVAL_SKILL = "approval";
export const APPROVAL_PLUGIN = "av-approval";

/**
 * One `pre_tool_call` entry per matcher (Hermes matchers are full-match
 * regexes). The first six are docs/03 section 3.1's gated tools
 * (`execute_code` listed so the core adapter refuses it). The rest reach
 * manual-class effects outside the classifier's view today; they are routed
 * through the gate now so the day the core adapter refuses or classifies them
 * nothing here changes. At core 6b74ca72 the adapter passes an unknown tool
 * through (`{}`), so for them the gate is transport only: the call is sent to
 * the facade (and fails closed when it cannot be), not judged.
 *
 * DATA-234: `cronjob(_manage)?` is routed (a job's `script`, `monitor` and
 * `no_agent` runs at the scheduler tick with no hook, so creating or changing
 * one is the only point the gate sees; the daily brief uses `hermes cron`, not
 * the agent tool), and `send_message` (not an agent-callable tool at Hermes
 * v2026.9.24, `tools/send_message_tool.py`; routed for any build or plugin
 * that registers it). `cronjob` and `process` are the legacy aliases Hermes
 * maps before the hook (`model_tools._LEGACY_TOOL_ALIASES`); matched anyway.
 * The `av-approval` plugin keeps a copy of this list (`GATED_MATCHERS`); a
 * test holds the two equal.
 *
 * R3b (DATA-344, claude-edge 2026-10-06 03:33Z): the side-effecting tools
 * core's adapter does not class itself are routed too, so the resident
 * policy's `tools:` list (approval.md 0.4.2, APRV-499) judges them: every
 * Index write (the nine of its 14-tool MCP surface: `create_intent`,
 * `update_intent`, `archive_intent`, `pause_intent`, `resume_intent`,
 * `accept_opportunity`, `reject_opportunity`, `update_my_profile`,
 * `enrich_my_profile`; and the eight write tools of Index's Hermes plugin,
 * whose accept or decline is `index_update_opportunity`: it has no
 * `index_accept_opportunity`), media generation, and the web reads
 * `web_search` and `x_search` (with `web_extract`, one `read.web`). Fix round
 * 2 (S1/S2) added the five MCP writes, `index_research_profile` and
 * dropped the phantom name. Index's read tools and the local tools
 * (`skill_view`, `skills_list`, `memory`, `session_search`, `todo`, `clarify`,
 * `recall`, `consent_status`, `record_intention`) stay unrouted: av-events
 * records every call as `tool.call`, and the hook is for actions. Each
 * routed call costs one shim round trip and is blocked while the gate is
 * unverified, as every entry here is.
 */
export const APPROVAL_GATED_TOOLS = [
  "terminal",
  "write_file",
  "patch",
  "read_file",
  "search_files",
  "execute_code",
  "process(_manage)?",
  "web_extract",
  "browser_.*",
  "skill_manage",
  "delegate_task",
  "cronjob(_manage)?",
  "send_message",
  "mcp__index__create_intent",
  "mcp__index__update_intent",
  "mcp__index__archive_intent",
  "mcp__index__pause_intent",
  "mcp__index__resume_intent",
  "mcp__index__accept_opportunity",
  "mcp__index__reject_opportunity",
  "mcp__index__update_my_profile",
  "mcp__index__enrich_my_profile",
  "index_create_intent",
  "index_update_intent",
  "index_add_intent_to_network",
  "index_create_network",
  "index_update_network",
  "index_join_network",
  "index_update_opportunity",
  "index_research_profile",
  "image_generate",
  "video_generate",
  "text_to_speech",
  "web_search",
  "x_search",
] as const;

/**
 * N3 (R3 fix round 2): the plugins are staged around the approval step, so an
 * upgrade never leaves the `av-approval` plugin's matcher list
 * (`GATED_MATCHERS`) ahead of the hooks block the step writes. The plugin
 * checks at every gateway start that each of its matchers has a shim entry; a
 * newer plugin against an older block finds `hook-missing`, which is sticky
 * and blocks every gated call until a restart with the block intact.
 *
 * - `before-approval`: every plugin but `av-approval`; and `av-approval` too
 *   when no copy is installed yet (a fresh install), so a step that fails
 *   later still leaves the backstop to fail closed.
 * - `after-approval`, run only once the approval step succeeded:
 *   `av-approval`, now that the hooks block it checks has been written (or,
 *   switched off, removed, which the plugin reads as fail-open).
 *
 * An upgrade whose approval step fails keeps the installed `av-approval` and
 * the hooks block it was installed with: the install stops before the restart,
 * as before, and the next run stages it.
 */
export function stagePlugins(sourceRoot: string, targetRoot: string, phase: "before-approval" | "after-approval"): number {
  if (!existsSync(sourceRoot)) return 0;
  let copied = 0;
  for (const name of readdirSync(sourceRoot).sort()) {
    const source = join(sourceRoot, name);
    if (!statSync(source).isDirectory()) continue;
    const approval = name === APPROVAL_PLUGIN;
    if (phase === "after-approval" && !approval) continue;
    if (phase === "before-approval" && approval && existsSync(join(targetRoot, name))) continue;
    copied += copyPluginTree(source, join(targetRoot, name));
  }
  return copied;
}

/** Hermes's per-entry maximum; it clamps anything above. */
export const APPROVAL_ENTRY_TIMEOUT_S = 300;
/** `plugins.hook_callback_timeout`: above the entry timeout, at Hermes's 600 s maximum. */
export const APPROVAL_CALLBACK_TIMEOUT_S = 600;
/** The shim's re-ask window: under the entry timeout so the shim answers before Hermes kills it. */
export const APPROVAL_WAIT_S = 280;
const SHIM_MAX_WAIT_S = 285;

/** Every program the shim resolves, and the only directories it looks in (the shim's own lists). */
export const SHIM_TOOLS = ["curl", "date", "mktemp", "head", "tr", "cat", "rm", "sleep", "stat", "id", "node"] as const;
export const SHIM_TOOL_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"] as const;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const URL_VAR = "AV_APPROVAL_URL";
const TOKEN_VAR = "AV_APPROVAL_TOKEN";
const TOKEN_FILE_VAR = "AV_APPROVAL_TOKEN_FILE";
const DAEMON_UID_VAR = "AV_APPROVAL_DAEMON_UID";
const OVERRIDE_VAR = "AV_APPROVAL_ALLOW_UNPATCHED_HERMES";
/** Hermes's consent allowlist and the flock sidecar it opens "a+" (agent/shell_hooks.py at v2026.9.24). */
export const ALLOWLIST_FILE = "shell-hooks-allowlist.json";
export const ALLOWLIST_LOCK_FILE = `${ALLOWLIST_FILE}.lock`;
/**
 * The only shape of variable name this step writes, as a key or as a name the
 * shim dereferences. The shim `eval`s `${<name>:-}`: a name starting with a
 * digit is a fatal "bad substitution" that ends the shell with no directive.
 */
export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** `.env` keys whose VALUE is itself a variable name the shim reads. */
const NAME_VALUED_LINES = new Set(["APPROVAL_HOOK_URL_ENV", "APPROVAL_HOOK_TOKEN_ENV"]);
/** Live-fire outcomes that only say the facade did not answer; logged, not fatal, for a local facade. */
const DEFERRABLE_LIVE = new Set(["live-facade-unreachable", "live-hook-timed-out"]);
/** The live fire spawns the shim, which may re-ask for up to 280 s inside a 300 s entry timeout. */
const LIVE_TIMEOUT_MS = 330_000;

export function approvalHooksDir(): string {
  return join(hermesHome(), "agent-hooks");
}

export function approvalShimPath(): string {
  return join(approvalHooksDir(), "hermes-hook-shim.sh");
}

/** Under `agent-hooks/` so a gated write to it is `policy.core`. DATA-43b must still not trust it. */
export function approvalSurfacePath(): string {
  return join(approvalHooksDir(), "approval-surface.json");
}

/** The `.env` lines this step owns, by name. */
export function approvalEnvLines(): Record<string, string> {
  return {
    HERMES_ACCEPT_HOOKS: "1",
    APPROVAL_HOOK_URL_ENV: URL_VAR,
    APPROVAL_HOOK_TOKEN_ENV: TOKEN_VAR,
    APPROVAL_HOOK_WAIT_S: String(APPROVAL_WAIT_S),
  };
}

/**
 * Throws `approval-env-name-invalid` unless every key, and every value that
 * names a variable, matches `ENV_NAME`. Run before anything is written.
 */
export function assertEnvNames(lines: Record<string, string>): void {
  const bad: string[] = [];
  for (const [name, value] of Object.entries(lines)) {
    if (!ENV_NAME.test(name)) bad.push(`key ${JSON.stringify(name)}`);
    else if (NAME_VALUED_LINES.has(name) && !ENV_NAME.test(value)) bad.push(`${name}'s value`);
  }
  if (bad.length > 0) {
    throw new ApprovalInstallError(
      "approval-env-name-invalid",
      `${bad.join(", ")} is not a variable name of the form ${ENV_NAME.source}; nothing was written`,
    );
  }
}

/** A failure with a machine-readable reason; the installer prints both and exits non-zero. */
export class ApprovalInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalInstallError";
  }
}

export interface ApprovalOptions {
  /** Where the shim's programs are looked for. Tests pass a fake bin; the default is the shim's own list. */
  toolDirs?: readonly string[];
  /** Hermes's managed-scope directory (default `/etc/hermes`). */
  managedDir?: string;
  /** Hermes's interpreter for the live fire; `null` means none could be found. Default: resolved. */
  hermesPython?: string | null;
  /** The live self-check script (default: the overlay's `skills/approval/scripts/live_selfcheck.py`). */
  liveScript?: string;
  /** Clock for `installed_at`. */
  now?: Date;
  /** DATA-379: the pre-warm run after a live fire the facade refused (default `prewarmApproval`). Tests pass a stub. */
  prewarm?: () => PrewarmReport;
}

/**
 * A value as the gateway will see it: `$HERMES_HOME/.env` first (Hermes loads
 * it with override), the process environment only when `.env` does not assign it.
 */
export function gatewayValue(name: string): string | undefined {
  return dotenvFileValue(name) ?? process.env[name];
}

export type ApprovalChoice = "unset" | "on" | "off";

/** `AV_APPROVAL_ENABLED`: blank or unset is no choice, `1|true|yes|on` (any case) is on, anything else is off. */
export function approvalChoice(): ApprovalChoice {
  const raw = gatewayValue("AV_APPROVAL_ENABLED")?.trim().toLowerCase();
  if (!raw) return "unset";
  return TRUTHY.has(raw) ? "on" : "off";
}

function overrideOn(): boolean {
  return gatewayValue(OVERRIDE_VAR)?.trim() === "1";
}

// ---------------------------------------------------------------------------
// Paths: no symlinks, nothing outside $HERMES_HOME
// ---------------------------------------------------------------------------

/** Named problems with the paths this step writes. Absent is fine; a symlink or the wrong kind is not. */
export function pathProblems(): string[] {
  const home = hermesHome();
  const problems: string[] = [];
  let realHome: string;
  try {
    realHome = realpathSync(home);
  } catch {
    return [];
  }
  const targets: [string, "dir" | "file"][] = [
    [approvalHooksDir(), "dir"],
    [approvalShimPath(), "file"],
    [approvalSurfacePath(), "file"],
    [join(home, "config.yaml"), "file"],
    [join(home, ".env"), "file"],
  ];
  for (const [path, kind] of targets) {
    const name = relative(home, path);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      problems.push(`path-symlink:${name}`);
      continue;
    }
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) {
      problems.push(`path-not-regular:${name}`);
      continue;
    }
    try {
      const real = realpathSync(path);
      if (!real.startsWith(realHome + sep)) problems.push(`path-outside-home:${name}`);
    } catch {
      problems.push(`path-unresolvable:${name}`);
    }
  }
  return problems;
}

function requireSafePaths(): void {
  const problems = pathProblems();
  if (problems.length > 0) {
    throw new ApprovalInstallError(
      "approval-path-unsafe",
      `refusing to write through ${problems.join(", ")}; nothing was written, remove it by hand`,
    );
  }
}

/** Write `data` to a temp file in `path`'s directory, then rename over `path` (never follows a link at `path`). */
function writeFileAtomic(path: string, data: string, mode: number): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, data, { mode, flag: "wx" });
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unmergeable(why: string): ApprovalInstallError {
  return new ApprovalInstallError("approval-config-unmergeable", `config.yaml: ${why}; nothing was written, fix it by hand`);
}

/**
 * Paths of every YAML merge key (`<<`) and alias anywhere under the top-level
 * `hooks` and `plugins` (and a top-level `<<`). The `yaml` package keeps `<<`
 * as a literal key while Hermes (PyYAML) merges it, so what this installer
 * sees and what Hermes runs would differ; an alias under the gate can carry
 * values defined outside it. Both are refused rather than interpreted.
 */
export function mergeOrAliasPaths(text: string): string[] {
  const found: string[] = [];
  const doc = YAML.parseDocument(text);
  const walk = (node: unknown, path: string): void => {
    if (isAlias(node)) {
      found.push(path);
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key;
        if (isAlias(key)) {
          found.push(`${path}.<alias key>`);
          continue;
        }
        const name = isScalar(key) ? String(key.value) : "?";
        if (name === "<<") found.push(`${path}.<<`);
        walk(pair.value, `${path}.${name}`);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, `${path}[${i}]`));
    }
  };
  const root = doc.contents;
  if (isMap(root)) {
    for (const pair of root.items) {
      const name = isScalar(pair.key) ? String(pair.key.value) : "?";
      if (name === "<<") found.push("<<");
      if (name === "hooks" || name === "plugins") walk(pair.value, name);
    }
  }
  return found;
}

function configText(): string {
  const path = join(hermesHome(), "config.yaml");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function requireMergeableConfig(): void {
  let paths: string[];
  try {
    paths = mergeOrAliasPaths(configText());
    readConfig();
  } catch {
    throw unmergeable("it is not YAML this installer can read");
  }
  if (paths.length > 0) throw unmergeable(`YAML merge key or alias at ${paths.join(", ")}`);
}

function mappingAt(doc: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = doc[key] ?? {};
  if (!isMapping(value)) throw unmergeable(`'${path}' is not a mapping`);
  if ("<<" in value) throw unmergeable(`'${path}' holds a YAML merge key (<<)`);
  return value;
}

/**
 * Python's `str.strip()` set (`str.isspace()`), spelled out. Hermes strips a
 * command with it before using it as the registration key, and it differs
 * from JS `trim()`: it includes \x1c-\x1f and \x85, and excludes \ufeff. A
 * command `<shim>\x1f` is "not ours" to `trim()` but the same hook to Hermes,
 * registered first if it comes first.
 */
const PY_WHITESPACE = "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const PY_STRIP = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, "g");

/** `s.strip()` as Python (and therefore Hermes) does it. */
export function pyStrip(text: string): string {
  return text.replace(PY_STRIP, "");
}

/** True for an entry whose command is the shim as Hermes sees it: Python-stripped, exact or with `~`/`$HERMES_HOME`. */
function isOurEntry(entry: unknown, command: string): boolean {
  if (!isMapping(entry)) return false;
  const raw = pyStrip(String(entry.command ?? ""));
  if (raw === command) return true;
  const home = process.env.HOME ?? "";
  const expanded = raw
    .replace(/^~(?=\/)/, home)
    .replace(/^\$\{?HERMES_HOME\}?(?=\/)/, hermesHome());
  return expanded === command;
}

/** `doc` with the gate merged in (write-hooks.py's `merge`, gate only). Pure. */
export function mergeApprovalHooks(doc: unknown, command: string): Record<string, unknown> {
  if (!isMapping(doc)) throw unmergeable("the top level is not a mapping");
  if ("<<" in doc) throw unmergeable("the top level holds a YAML merge key (<<)");
  const hooks = mappingAt(doc, "hooks", "hooks");
  const rawPre = hooks.pre_tool_call ?? [];
  if (!Array.isArray(rawPre)) throw unmergeable("'hooks.pre_tool_call' is not a list");
  const kept = rawPre.filter((entry) => !isOurEntry(entry, command));
  const desired = APPROVAL_GATED_TOOLS.map((tool) => ({
    matcher: tool,
    command,
    timeout: APPROVAL_ENTRY_TIMEOUT_S,
    fail_closed: true,
  }));
  const plugins = mappingAt(doc, "plugins", "plugins");
  return {
    ...doc,
    hooks: { ...hooks, pre_tool_call: [...kept, ...desired] },
    hooks_auto_accept: true,
    plugins: { ...plugins, hook_callback_timeout: APPROVAL_CALLBACK_TIMEOUT_S },
  };
}

/**
 * `doc` with the gate taken out (the kill switch): our entries, the headless
 * consent and the callback timeout this step set. Consent must not outlive the
 * gate. Other hooks and every other key stay.
 */
export function removeApprovalHooks(doc: unknown, command: string): { doc: Record<string, unknown>; removed: number } {
  if (!isMapping(doc)) throw unmergeable("the top level is not a mapping");
  const next: Record<string, unknown> = { ...doc };
  let removed = 0;
  const hooks = mappingAt(doc, "hooks", "hooks");
  const rawPre = hooks.pre_tool_call;
  if (Array.isArray(rawPre)) {
    const kept = rawPre.filter((entry) => !isOurEntry(entry, command));
    removed = rawPre.length - kept.length;
    const nextHooks: Record<string, unknown> = { ...hooks, pre_tool_call: kept };
    if (kept.length === 0) delete nextHooks.pre_tool_call;
    if (Object.keys(nextHooks).length === 0) delete next.hooks;
    else next.hooks = nextHooks;
  } else if (rawPre !== undefined && rawPre !== null) {
    throw unmergeable("'hooks.pre_tool_call' is not a list");
  }
  delete next.hooks_auto_accept;
  if (isMapping(doc.plugins) && "hook_callback_timeout" in doc.plugins) {
    const plugins = { ...doc.plugins };
    delete plugins.hook_callback_timeout;
    next.plugins = plugins;
  }
  return { doc: next, removed };
}

/** Write `next` only when it serialises differently from `before`, so a re-run leaves the file alone. */
function writeIfChanged(before: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (dumpConfig(before) === dumpConfig(next)) return false;
  writeConfig(next);
  return true;
}

function withPluginListed(doc: Record<string, unknown>, on: boolean): Record<string, unknown> {
  const plugins = mappingAt(doc, "plugins", "plugins");
  const enabled = Array.isArray(plugins.enabled)
    ? ((plugins.enabled as unknown[]).filter((n) => typeof n === "string") as string[])
    : [];
  const has = enabled.includes(APPROVAL_PLUGIN);
  if (on === has) return doc;
  const next = on ? [...enabled, APPROVAL_PLUGIN] : enabled.filter((n) => n !== APPROVAL_PLUGIN);
  return { ...doc, plugins: { ...plugins, enabled: next } };
}

// ---------------------------------------------------------------------------
// .env, shim, marker
// ---------------------------------------------------------------------------

/** The facade URL forms the shim accepts without a test-only flag. */
export type FacadeUrlKind = "https" | "loopback" | "unix";

/**
 * `https://…` (a hosted facade); `http://127.0.0.1:<port>[/…]` (the co-located
 * daemon in tcp mode: plain http on loopback, which the shim dials only after
 * checking the listener is the daemon's uid); `unix:<absolute path>` (the
 * co-located daemon's socket). Anything else, including any other `http://`,
 * is `null`. No spaces, quotes or backslashes (the shim's curl config line).
 */
export function facadeUrlKind(url: string): FacadeUrlKind | null {
  if (/[\s"\\]/.test(url) || /[^\x20-\x7e]/.test(url)) return null;
  if (/^https:\/\/.+$/.test(url)) return "https";
  // No leading zero: the shim's listener check formats the port in hex and a
  // POSIX printf reads `010` as octal.
  const loop = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(?:\/.*)?$/.exec(url);
  if (loop) {
    const port = Number(loop[1]);
    return port >= 1 && port <= 65535 ? "loopback" : null;
  }
  if (/^unix:\/.+$/.test(url)) return "unix";
  return null;
}

/** A local facade (loopback or unix socket): the control plane runs it beside the gateway. */
export function isLocalFacade(url: string | undefined): boolean {
  const kind = url ? facadeUrlKind(url.trim()) : null;
  return kind === "loopback" || kind === "unix";
}

/** The name the shim reads the facade URL from (its `.env` setting, else `AV_APPROVAL_URL`). */
function urlVarName(): string {
  return dotenvFileValue("APPROVAL_HOOK_URL_ENV")?.trim() || URL_VAR;
}

/** Where the shim reads the agent credential from (the shim's own order). */
export type TokenSource = { kind: "file"; path: string; named: boolean } | { kind: "env"; name: string };

/** `$HERMES_HOME/approval/agent-token`: where the control plane writes the agent token under co-location. */
export function defaultTokenFile(): string {
  return join(hermesHome(), "approval", "agent-token");
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The shim's order: the file `AV_APPROVAL_TOKEN_FILE` names; else
 * `$HERMES_HOME/approval/agent-token` when it exists; else the variable
 * `APPROVAL_HOOK_TOKEN_ENV` names (`AV_APPROVAL_TOKEN`).
 */
export function tokenSource(): TokenSource {
  const named = gatewayValue(TOKEN_FILE_VAR);
  if (named) return { kind: "file", path: named, named: true };
  const dflt = defaultTokenFile();
  if (lexists(dflt)) return { kind: "file", path: dflt, named: false };
  return { kind: "env", name: dotenvFileValue("APPROVAL_HOOK_TOKEN_ENV")?.trim() || TOKEN_VAR };
}

function tokenMalformed(token: string): boolean {
  return /[\s"\\]/.test(token) || /[^\x20-\x7e]/.test(token);
}

/**
 * Why the shim would refuse this token file, as a short reason, or `null`
 * when it would read it: absolute, a regular file (not a link), owned by this
 * user, mode 0600, a first line that is a well-formed credential. The value is
 * read to check its shape and never printed, logged or returned.
 */
export function tokenFileProblem(path: string): string | null {
  if (!path.startsWith("/")) return "not-absolute";
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink() || !st.isFile()) return "not-regular";
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "wrong-owner";
  if ((st.mode & 0o777) !== 0o600) return "mode-not-0600";
  let first: string;
  try {
    first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  } catch {
    return "unreadable";
  }
  if (!first) return "empty";
  return tokenMalformed(first) ? "malformed" : null;
}

function requireCredentials(): void {
  const source = tokenSource();
  const missing = [URL_VAR, ...(source.kind === "env" ? [TOKEN_VAR] : [])].filter((name) => !gatewayValue(name)?.trim());
  if (missing.length > 0) {
    throw new ApprovalInstallError(
      "approval-credentials-missing",
      `AV_APPROVAL_ENABLED is on but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set ` +
        `($HERMES_HOME/.env or environment; the agent token may instead be the file ${TOKEN_FILE_VAR} names); ` +
        "opting in without the facade URL and the agent token is a misconfiguration",
    );
  }
  const url = gatewayValue(URL_VAR)!.trim();
  if (facadeUrlKind(url) === null) {
    throw new ApprovalInstallError(
      "approval-url-not-https",
      `${URL_VAR} is not an https:// URL, http://127.0.0.1:<port> or unix:<absolute path> without spaces or quotes; ` +
        "the shim refuses anything else",
    );
  }
  const uid = gatewayValue(DAEMON_UID_VAR)?.trim();
  if (uid !== undefined && uid !== "" && !/^[0-9]+$/.test(uid)) {
    throw new ApprovalInstallError("approval-daemon-uid-invalid", `${DAEMON_UID_VAR} is not a numeric uid; the shim refuses it`);
  }
  if (source.kind === "file") {
    const why = tokenFileProblem(source.path);
    if (why) {
      throw new ApprovalInstallError(
        "approval-token-file-unusable",
        `the agent token file (${source.named ? TOKEN_FILE_VAR : "$HERMES_HOME/approval/agent-token"}) is ${why}; ` +
          "the shim refuses it (it must be a regular file owned by this user, mode 0600)",
      );
    }
    return;
  }
  const token = gatewayValue(TOKEN_VAR)!.trim();
  if (tokenMalformed(token)) {
    throw new ApprovalInstallError(
      "approval-token-malformed",
      `${TOKEN_VAR} contains whitespace, a quote, a backslash or a non-printable character; the shim refuses it`,
    );
  }
}

function writeEnvLines(): number {
  let changed = 0;
  const lines = approvalEnvLines();
  assertEnvNames(lines);
  for (const [name, value] of Object.entries(lines)) {
    if (dotenvFileValue(name) === value) continue;
    upsertEnvVar(name, value);
    changed++;
  }
  return changed;
}

/** Remove every assignment of `names` from `.env`, keeping every other line byte for byte. */
function removeEnvLines(names: string[]): number {
  const path = join(hermesHome(), ".env");
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?(?:${names.join("|")})\\s*=`);
  const lines = text.split("\n");
  const kept = lines.filter((line) => !pattern.test(line));
  const removed = lines.length - kept.length;
  if (removed > 0) writeFileAtomic(path, kept.join("\n"), statSync(path).mode & 0o777);
  return removed;
}

function installShim(sourceSkills: string): void {
  const source = join(sourceSkills, APPROVAL_SKILL, "scripts", "hermes-hook-shim.sh");
  if (!existsSync(source)) {
    throw new ApprovalInstallError("approval-shim-source-missing", `${source} is missing from the overlay checkout`);
  }
  const dir = approvalHooksDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(approvalShimPath(), readFileSync(source, "utf8"), 0o700);
}

/**
 * The marker for the `approval_md` identity-map row (docs/03 section 3.2
 * item 5; AV spec section 5.2). The installer cannot write to ingest, so it
 * records the tenant and when the skill was installed, under `agent-hooks/`
 * where a gated write is `policy.core`. It is still a file on attendee
 * compute: DATA-43b must not trust it for anything but a hint.
 *
 * TODO(DATA-43b): `daemon_id` is null on purpose. The facade reports the
 * daemon instance id (APRV-383) only on `GET /status`, which answers the
 * TENANT credential (approval-md `src/serve/server.ts`, `scopeOf`); the
 * sandbox holds the agent credential. The DATA-43b follower holds the tenant
 * credential, reads the id there, and is the writer of the `approval_md` row.
 */
/** A key's state before the first install: absent, or the value it had. */
export type PriorValue = { present: false } | { present: true; value: unknown };

/** What the first install found for the keys it sets, so the kill switch can put back exactly that. */
export interface PriorState {
  config: { hooks_auto_accept: PriorValue; "plugins.hook_callback_timeout": PriorValue };
  env: Record<string, PriorValue>;
}

export interface SurfaceMarker {
  daemon_id: null;
  tenant_id: string | null;
  installed_at: string;
  overrides: string[];
  prior: PriorState;
  /** sha256 of the installed shim; the av-approval plugin's integrity check compares it (DATA-234). */
  shim_sha256: string | null;
}

/** sha256 (hex) of a file's bytes, or `null` when it cannot be read. */
export function fileSha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function readMarker(): SurfaceMarker | null {
  const path = approvalSurfacePath();
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as SurfaceMarker;
    return isMapping(m) && isMapping(m.prior) ? m : null;
  } catch {
    return null;
  }
}

/** The current state of the keys this step sets (read before it sets them). */
function capturePrior(doc: Record<string, unknown>): PriorState {
  const at = (obj: unknown, key: string): PriorValue =>
    isMapping(obj) && key in obj ? { present: true, value: obj[key] } : { present: false };
  const env: Record<string, PriorValue> = {};
  for (const name of Object.keys(approvalEnvLines())) {
    const value = dotenvFileValue(name);
    env[name] = value === undefined ? { present: false } : { present: true, value };
  }
  return {
    config: { hooks_auto_accept: at(doc, "hooks_auto_accept"), "plugins.hook_callback_timeout": at(doc.plugins, "hook_callback_timeout") },
    env,
  };
}

/**
 * The marker for the `approval_md` identity-map row (docs/03 section 3.2
 * item 5; AV spec section 5.2), and the record of what the first install found.
 * The installer cannot write to ingest, so it records the tenant, when the
 * skill was installed, any dogfood override in force, and the prior state of
 * every key it sets (kept from the FIRST install, so a re-install never records
 * its own values as the resident's). It lives under `agent-hooks/`, where a
 * gated write is `policy.core`, but it is still a file on attendee compute:
 * DATA-43b must not trust it for anything but a hint.
 *
 * TODO(DATA-43b): `daemon_id` is null on purpose. The facade reports the
 * daemon instance id (APRV-383) only on `GET /status`, which answers the
 * TENANT credential (approval-md `src/serve/server.ts`, `scopeOf`); the
 * sandbox holds the agent credential. The DATA-43b follower holds the tenant
 * credential, reads the id there, and is the writer of the `approval_md` row.
 */
function writeSurfaceMarker(now: Date, prior: PriorState, overrides: string[]): { tenant: string | null } {
  const tenant = gatewayValue("AV_TENANT_ID")?.trim() || gatewayValue("TENANT_ID")?.trim() || null;
  const existing = readMarker();
  const installedAt =
    existing && existing.tenant_id === tenant && typeof existing.installed_at === "string" ? existing.installed_at : now.toISOString();
  const marker: SurfaceMarker = {
    daemon_id: null,
    tenant_id: tenant,
    installed_at: installedAt,
    overrides,
    prior: existing ? existing.prior : prior,
    shim_sha256: fileSha256(approvalShimPath()),
  };
  writeFileAtomic(approvalSurfacePath(), `${JSON.stringify(marker, null, 2)}\n`, 0o600);
  return { tenant };
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function accessible(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hermes's consent allowlist and its lock, as Hermes will meet them at the
 * next gateway start. Absent is fine (Hermes creates both). A lock it cannot
 * open "a+" (not ours, not read-write, not a regular file, or absent in a home
 * we cannot write) makes `register_from_config` RAISE, which the gateway
 * swallows: no hook registers and every tool runs ungated (DATA-234). An
 * allowlist we cannot read reads as "no consent". Named, never repaired.
 */
export function allowlistProblems(): string[] {
  const home = hermesHome();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const problems: string[] = [];
  for (const [name, mode] of [
    [ALLOWLIST_FILE, constants.R_OK],
    [ALLOWLIST_LOCK_FILE, constants.R_OK | constants.W_OK],
  ] as const) {
    const path = join(home, name);
    let st;
    try {
      st = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`allowlist-unusable:${name}:unstatable`);
      else if (name === ALLOWLIST_LOCK_FILE && !accessible(home, constants.W_OK | constants.X_OK)) {
        problems.push(`allowlist-unusable:${name}:uncreatable`);
      }
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) problems.push(`allowlist-unusable:${name}:not-regular`);
    else if (uid !== undefined && st.uid !== uid) problems.push(`allowlist-unusable:${name}:wrong-owner`);
    else if (!accessible(path, mode)) problems.push(`allowlist-unusable:${name}:${mode & constants.W_OK ? "not-read-write" : "unreadable"}`);
  }
  return problems;
}

/**
 * Scripts under `$HERMES_HOME/scripts/` (relative paths, sorted, at most 50).
 * Hermes's scheduler runs a cron job's `script`, `monitor` and prerun script
 * from there with NO `pre_tool_call` (cron/scheduler_script.py), so each one
 * runs ungated at every tick. Listed for the operator; not a problem (the
 * daily brief stages its own scripts there).
 */
export function cronScripts(limit = 50): string[] {
  const root = join(hermesHome(), "scripts");
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 4) walk(path, depth + 1);
      else if (!st.isDirectory()) found.push(relative(root, path));
    }
  };
  walk(root, 0);
  return found.sort().slice(0, limit);
}

/** States in which Hermes registers no shell hook or replaces the hooks block, and a home the classifier cannot see. */
export function environmentProblems(options: ApprovalOptions = {}): string[] {
  const problems: string[] = [];
  if (TRUTHY.has(gatewayValue("HERMES_SAFE_MODE")?.trim().toLowerCase() ?? "")) problems.push("hermes-safe-mode");
  if (gatewayValue("HERMES_MANAGED")?.trim()) problems.push("hermes-managed");
  const managedDir = options.managedDir ?? "/etc/hermes";
  if (gatewayValue("HERMES_MANAGED_DIR")?.trim() || existsSync(join(managedDir, "config.yaml"))) {
    problems.push("hermes-managed-scope");
  }
  // The core classifier protects the gate's organs only under a `.hermes` path segment.
  let real = hermesHome();
  try {
    real = realpathSync(real);
  } catch {
    // an absent home is judged by its name
  }
  if (basename(hermesHome()) !== ".hermes" || basename(real) !== ".hermes") problems.push("hermes-home-not-dot-hermes");
  return problems;
}

/**
 * Named reasons the installed gate is NOT what this step writes (empty: it
 * is). File and environment state only; `checkApproval` adds the live fire.
 */
export function approvalProblems(options: ApprovalOptions = {}): string[] {
  const problems: string[] = [...pathProblems()];
  try {
    for (const p of mergeOrAliasPaths(configText())) problems.push(`yaml-merge-or-alias:${p}`);
  } catch {
    problems.push("config-unreadable");
  }
  const command = approvalShimPath();
  let doc: unknown;
  try {
    doc = readConfig();
  } catch {
    return [...problems, "config-unreadable"];
  }
  const top = isMapping(doc) ? doc : {};
  const hooks = isMapping(top.hooks) ? top.hooks : {};
  const pre = Array.isArray(hooks.pre_tool_call) ? hooks.pre_tool_call : [];
  const ours = pre.filter((entry) => isOurEntry(entry, command)) as Record<string, unknown>[];
  for (const tool of APPROVAL_GATED_TOOLS) {
    if (!ours.some((entry) => entry.matcher === tool)) problems.push(`hook-missing:${tool}`);
  }
  for (const entry of ours) {
    const tool = typeof entry.matcher === "string" ? entry.matcher : "?";
    if (entry.fail_closed !== true) problems.push(`fail-closed-off:${tool}`);
    if (entry.timeout !== APPROVAL_ENTRY_TIMEOUT_S) problems.push(`entry-timeout:${tool}`);
  }
  const plugins = isMapping(top.plugins) ? top.plugins : {};
  const callback = plugins.hook_callback_timeout;
  if (typeof callback !== "number" || callback <= APPROVAL_ENTRY_TIMEOUT_S) problems.push("callback-timeout-not-above-entry");
  if (top.hooks_auto_accept !== true) problems.push("consent-missing:config.hooks_auto_accept");
  if (dotenvFileValue("HERMES_ACCEPT_HOOKS")?.trim() !== "1") problems.push("consent-missing:env.HERMES_ACCEPT_HOOKS");

  if (!existsSync(command)) problems.push("shim-missing");
  else if (!isExecutable(command)) problems.push("shim-not-executable");
  else if ((statSync(command).mode & 0o777) !== 0o700) problems.push("shim-mode-not-0700");
  else {
    // The digest the av-approval plugin checks at every gateway start.
    const recorded = readMarker()?.shim_sha256;
    if (typeof recorded !== "string") problems.push("manifest-missing");
    else if (recorded !== fileSha256(command)) problems.push("shim-hash-mismatch");
  }

  const urlName = urlVarName();
  const source = tokenSource();
  const names = source.kind === "env" ? [urlName, source.name] : [urlName];
  for (const name of names) {
    if (!ENV_NAME.test(name) || !gatewayValue(name)?.trim()) problems.push(`env-unresolvable:${name}`);
  }
  const url = ENV_NAME.test(urlName) ? gatewayValue(urlName)?.trim() : undefined;
  if (url && facadeUrlKind(url) === null) problems.push("url-unsupported");
  if (source.kind === "file") {
    const why = tokenFileProblem(source.path);
    if (why) problems.push(`token-file-unusable:${why}`);
  }
  const uid = gatewayValue(DAEMON_UID_VAR)?.trim();
  if (uid !== undefined && uid !== "" && !/^[0-9]+$/.test(uid)) problems.push("daemon-uid-invalid");
  problems.push(...allowlistProblems());
  const wait = Number(dotenvFileValue("APPROVAL_HOOK_WAIT_S")?.trim());
  if (!Number.isInteger(wait) || wait < 1 || wait > SHIM_MAX_WAIT_S || wait >= APPROVAL_ENTRY_TIMEOUT_S) {
    problems.push("wait-window-invalid");
  }

  const dirs = options.toolDirs ?? SHIM_TOOL_DIRS;
  for (const tool of SHIM_TOOLS) {
    if (!dirs.some((dir) => isExecutable(join(dir, tool)))) problems.push(`shim-tool-missing:${tool}`);
  }
  problems.push(...environmentProblems(options));
  return problems;
}

/** Hermes's interpreter: the override, the `hermes` script's python shebang, or a known venv. `null` when none. */
export function resolveHermesPython(): string | null {
  const fromEnv = process.env.AV_APPROVAL_HERMES_PYTHON?.trim();
  if (fromEnv) return isExecutable(fromEnv) ? fromEnv : null;
  try {
    const bin = realpathSync(hermesBin());
    const first = readFileSync(bin, "utf8").split("\n", 1)[0] ?? "";
    const m = /^#!\s*(\S*python[0-9.]*)\s*$/.exec(first);
    if (m && isExecutable(m[1]!)) return m[1]!;
  } catch {
    // fall through to the known locations
  }
  for (const candidate of [
    join(hermesHome(), "hermes-agent", "venv", "bin", "python"),
    join(hermesHome(), "hermes-agent", ".venv", "bin", "python"),
    "/opt/hermes/.venv/bin/python",
  ]) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

interface LiveFacts {
  problems?: string[];
  /** The fire itself (live_selfcheck.py item 6); `code_matched` only on a facade block. */
  fire?: { verdict?: string; code_matched?: boolean };
  safe_mode?: boolean;
  managed?: boolean;
  managed_dir?: string | null;
  floor_ok?: boolean;
  release_date?: string;
  signal_patch?: boolean;
  signal_patch_marker?: boolean;
  exit1_blocks?: boolean | null;
  consent_effective?: boolean | null;
  /** R3 fix round 4: what Hermes's own parse of config.yaml registers for the shim (live_selfcheck.py 5b). */
  routed_entries?: number;
  routed_sha256?: string;
}

/**
 * R3 fix round 4 (the trust boundary): the expected routed list's digest, the sha256 of
 * APPROVAL_GATED_TOOLS sorted and joined by newlines. The control plane pins the same value.
 */
export const APPROVAL_ROUTED_SHA256 = createHash("sha256").update([...APPROVAL_GATED_TOOLS].sort().join("\n"), "utf8").digest("hex");

/** The routed count and digest as Hermes's own parse reports them, or null when the live check did not report them. */
export interface RoutedFacts {
  entries: number;
  sha256: string;
}

/**
 * How this Hermes treats a `fail_closed` hook that exits 1 with an empty
 * stdout: `blocked` (the checkpoint's widened patch, DATA-228), `allowed`
 * (stock Hermes: `_evaluate_result` reads no directive as an allow), or
 * `unknown` (the live check did not run). Reported, not a problem: the shim
 * never exits non-zero without a directive on any path it can see.
 */
export type Exit1Behaviour = "blocked" | "allowed" | "unknown";

/** What a check found: named problems, and the dogfood overrides it accepted instead of failing. */
export interface ApprovalReport {
  problems: string[];
  overrides: string[];
  /** The exit-1 probe's answer (DATA-234 / DATA-228). */
  exit1?: Exit1Behaviour;
  /** R3 fix round 4: what Hermes registers for the shim, from its own parse of config.yaml. */
  routed?: RoutedFacts | null;
  /**
   * DATA-379 (fix round 1): the live fire was blocked by the facade with `hook-unsupported-execution-context`,
   * i.e. REFUSED before any decision (true), blocked with another code (false: a core that decided it), or
   * not reported (null). The pre-warm repeats the fire only when it is true.
   */
  liveCodeMatched?: boolean | null;
}

/** The live fire through Hermes's `run_once`. Accepted dogfood overrides are returned and warned about on stderr. */
export function liveReport(options: ApprovalOptions = {}): ApprovalReport {
  const fail = (problem: string): ApprovalReport => ({ problems: [problem], overrides: [] });
  const python = options.hermesPython === undefined ? resolveHermesPython() : options.hermesPython;
  const script = options.liveScript ?? join(DEFAULT_SOURCE_SKILLS, APPROVAL_SKILL, "scripts", "live_selfcheck.py");
  if (!python) return fail("selfcheck-live-unavailable:no-hermes-interpreter");
  const args = [script, "--home", hermesHome(), "--shim", approvalShimPath(), "--matchers", JSON.stringify(APPROVAL_GATED_TOOLS)];
  const out = spawnSync(python, args, {
    env: { ...process.env, HERMES_HOME: hermesHome() },
    encoding: "utf8",
    timeout: LIVE_TIMEOUT_MS,
  });
  if (out.status === 3) return fail("selfcheck-live-unavailable:hermes-modules");
  let facts: LiveFacts;
  try {
    const lines = (out.stdout ?? "").trim().split("\n");
    facts = JSON.parse(lines[lines.length - 1] ?? "") as LiveFacts;
  } catch {
    return fail(`selfcheck-live-unavailable:no-report(exit ${out.status ?? "signal"})`);
  }
  const problems = [...(facts.problems ?? [])];
  const exit1: Exit1Behaviour = facts.exit1_blocks === true ? "blocked" : facts.exit1_blocks === false ? "allowed" : "unknown";
  if (facts.safe_mode) problems.push("hermes-safe-mode");
  if (facts.managed) problems.push("hermes-managed");
  if (facts.managed_dir) problems.push("hermes-managed-scope");
  if (facts.consent_effective === false) problems.push("consent-missing:hermes-effective");
  // R3 fix round 4: the routed list as Hermes's own parse sees it; any other count or list than the
  // installer's (an entry added to or removed from config.yaml after it wrote it) is a problem.
  const routed: RoutedFacts | null =
    Number.isInteger(facts.routed_entries) && typeof facts.routed_sha256 === "string" && /^[0-9a-f]{64}$/.test(facts.routed_sha256)
      ? { entries: facts.routed_entries as number, sha256: facts.routed_sha256 }
      : null;
  if (routed && (routed.entries !== APPROVAL_GATED_TOOLS.length || routed.sha256 !== APPROVAL_ROUTED_SHA256)) {
    problems.push(`live-routed-mismatch:${routed.entries}`);
  }
  const unpatched: string[] = [];
  if (facts.floor_ok !== true) unpatched.push(`hermes-below-fail-closed-floor:${facts.release_date || "unknown"}`);
  if (facts.signal_patch !== true) {
    // Judged by behaviour (a SIGKILLed fail_closed hook must block); the marker is a hint only.
    unpatched.push(`hermes-signal-patch-missing(marker:${facts.signal_patch_marker ? "present" : "absent"})`);
  }
  const overrides: string[] = [];
  if (unpatched.length > 0) {
    if (overrideOn()) {
      console.error(
        `!! approval gate: ${OVERRIDE_VAR}=1 accepts ${unpatched.join(", ")}. DOGFOOD ONLY: ` +
          "on this build a hook that times out or is killed by a signal may let the tool call RUN.",
      );
      overrides.push(...unpatched.map((p) => `${OVERRIDE_VAR}:${p}`));
    } else {
      problems.push(...unpatched);
    }
  }
  const liveCodeMatched = typeof facts.fire?.code_matched === "boolean" ? facts.fire.code_matched : null;
  return { problems, overrides, exit1, routed, liveCodeMatched };
}

/**
 * The whole check: static, environment, then (only when those pass, as the
 * upstream self-check never fires a hook it already judged) the live fire.
 * Writes nothing to the installer's state.
 */
export function checkApprovalReport(options: ApprovalOptions = {}): ApprovalReport {
  if (approvalChoice() !== "on") return { problems: ["approval-not-enabled"], overrides: [] };
  const problems = approvalProblems(options);
  if (problems.length > 0) return { problems: [...new Set(problems)], overrides: [] };
  const live = liveReport(options);
  return { problems: [...new Set(live.problems)], overrides: live.overrides, exit1: live.exit1 ?? "unknown", routed: live.routed ?? null, liveCodeMatched: live.liveCodeMatched ?? null };
}

/** One line for the exit-1 probe's answer. */
function exit1Line(exit1: Exit1Behaviour | undefined): string {
  switch (exit1) {
    case "blocked":
      return "→ approval gate: Hermes blocks a fail_closed hook that exits 1 with no output (patched checkpoint)";
    case "allowed":
      return (
        "→ approval gate: Hermes ALLOWS a fail_closed hook that exits 1 with no output (unpatched; DATA-228 widens " +
        "the checkpoint patch). The shim prints a block directive and exits 2 on every failure path it can see; " +
        "this matters only if the shim dies outside them"
      );
    default:
      return "→ approval gate: the exit-1 probe did not run";
  }
}

/** `checkApprovalReport`'s problems alone. */
export function checkApproval(options: ApprovalOptions = {}): string[] {
  return checkApprovalReport(options).problems;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export type ApprovalOutcome = "skipped" | "installed" | "disabled";

/** The bytes (or absence) of a file, to restore exactly. */
function snapshot(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function restore(path: string, bytes: string | null): void {
  if (bytes === null) rmSync(path, { force: true });
  else writeFileSync(path, bytes);
}

/**
 * The kill switch: take this step's gate out. Fail-open, and said so.
 *
 * With a marker from an earlier install, the keys that install set are put
 * back exactly as it found them (absent stays absent, a resident's own value
 * returns), so consent never outlives the gate and a resident's own settings
 * survive it. Without a marker nothing but entries whose command is the shim is
 * touched: there is no record of what was the resident's.
 */
export function disableApprovalGate(): void {
  requireSafePaths();
  requireMergeableConfig();
  const marker = readMarker();
  const before = readConfig();
  const { doc: stripped, removed } = removeApprovalHooks(before, approvalShimPath());
  let next = stripped;
  let envRestored = 0;
  if (marker) {
    next = { ...next };
    const put = (obj: Record<string, unknown>, key: string, prior: PriorValue): void => {
      if (prior.present) obj[key] = prior.value;
      else delete obj[key];
    };
    put(next, "hooks_auto_accept", marker.prior.config.hooks_auto_accept);
    const plugins = isMapping(next.plugins) ? { ...next.plugins } : {};
    put(plugins, "hook_callback_timeout", marker.prior.config["plugins.hook_callback_timeout"]);
    if (Object.keys(plugins).length > 0 || isMapping(next.plugins)) next.plugins = plugins;
    const absent = Object.keys(approvalEnvLines()).filter((n) => !marker.prior.env[n]?.present);
    envRestored += removeEnvLines(absent);
    for (const [name, prior] of Object.entries(marker.prior.env)) {
      if (prior.present && dotenvFileValue(name) !== String(prior.value)) {
        upsertEnvVar(name, String(prior.value));
        envRestored++;
      }
    }
  } else {
    // No record of the resident's own consent: leave it, and the callback timeout, as they are.
    next = { ...stripped };
    if ("hooks_auto_accept" in before) next.hooks_auto_accept = before.hooks_auto_accept;
    if (isMapping(before.plugins) && "hook_callback_timeout" in before.plugins) {
      next.plugins = { ...(isMapping(next.plugins) ? next.plugins : {}), hook_callback_timeout: before.plugins.hook_callback_timeout };
    }
  }
  // The plugin stays listed so the gateway logs `av-approval: disabled (fail-open)`.
  writeIfChanged(before, next);
  if (marker) {
    const skill = join(skillsDir(), APPROVAL_SKILL);
    if (existsSync(skill)) rmSync(skill, { recursive: true, force: true });
    rmSync(approvalShimPath(), { force: true });
    rmSync(approvalSurfacePath(), { force: true });
  }
  if (removed > 0) {
    console.log(
      `→ approval gate DISABLED (AV_APPROVAL_ENABLED off): removed ${removed} pre_tool_call entries` +
        (marker ? `; consent, the callback timeout and ${envRestored} .env line(s) restored to their pre-install state` : "") +
        "; FAIL-OPEN: this tenant's tool calls are no longer gated once the gateway restarts",
    );
  } else {
    console.log("→ approval gate off (AV_APPROVAL_ENABLED off); no gate entries were installed");
  }
}

/**
 * R3 fix round 4 (trust boundary, output injection): what this process's last successful approval
 * install found routed, from Hermes's own parse (live_selfcheck.py 5b); null otherwise.
 */
let lastRouted: RoutedFacts | null = null;
export function lastInstallRouted(): RoutedFacts | null {
  return lastRouted;
}

/**
 * OV-249 (B): this process's last approval step installed the gate, its live fire was answered by
 * the facade (not deferred), and Hermes's own parse routes exactly APPROVAL_GATED_TOOLS. False
 * otherwise: skipped, switched off, failed, deferred, or another routed list. The Index plugin step
 * enables `index-network` for an ON resident only when this is true.
 */
let lastVerified = false;
export function lastInstallVerified(): boolean {
  return lastVerified;
}

/** The nonce the control plane passes for one install exec (AV_GATE_NONCE): 16 random bytes, hex. */
export const GATE_NONCE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * R3 fix round 4: the gate receipt, `{"av_gate":{"nonce":"<nonce>","entries":<n>,"sha256":"<hex>"}}`,
 * which install.ts prints as the LAST line of its stdout, or null (no valid nonce in the
 * environment, or no routed facts from a successful install this run). The control plane accepts
 * only this object, with the nonce it passed that exec, as the last line: an earlier line (forged
 * or not) never counts, and anything printed after it voids it. The nonce is never logged.
 */
export function gateReceiptLine(nonce: string | undefined = process.env.AV_GATE_NONCE, routed: RoutedFacts | null = lastRouted): string | null {
  if (typeof nonce !== "string" || !GATE_NONCE_PATTERN.test(nonce) || !routed) return null;
  if (!Number.isInteger(routed.entries) || routed.entries < 0 || !/^[0-9a-f]{64}$/.test(routed.sha256)) return null;
  return JSON.stringify({ av_gate: { nonce, entries: routed.entries, sha256: routed.sha256 } });
}

export function installApproval(sourceSkills: string, options: ApprovalOptions = {}): ApprovalOutcome {
  lastRouted = null;
  lastVerified = false;
  const choice = approvalChoice();
  if (choice === "unset") {
    console.log("→ skipped approval gate (opt-in: AV_APPROVAL_ENABLED=1)");
    return "skipped";
  }
  if (choice === "off") {
    disableApprovalGate();
    return "disabled";
  }

  requireCredentials();
  assertEnvNames(approvalEnvLines());
  requireSafePaths();
  requireMergeableConfig();

  const configPath = join(hermesHome(), "config.yaml");
  const envPath = join(hermesHome(), ".env");
  const skillTarget = join(skillsDir(), APPROVAL_SKILL);
  const saved = {
    config: snapshot(configPath),
    env: snapshot(envPath),
    surface: snapshot(approvalSurfacePath()),
    shim: snapshot(approvalShimPath()),
    hooksDir: existsSync(approvalHooksDir()),
    skill: existsSync(skillTarget),
  };
  try {
    const before = readConfig();
    const prior = capturePrior(before);
    installShim(sourceSkills);
    const merged = withPluginListed(mergeApprovalHooks(before, approvalShimPath()), true);
    const configChanged = writeIfChanged(before, merged);
    const envChanged = writeEnvLines();
    copyPluginTree(join(sourceSkills, APPROVAL_SKILL), skillTarget);
    const now = options.now ?? new Date();
    writeSurfaceMarker(now, prior, []);

    const report = checkApprovalReport({ liveScript: join(sourceSkills, APPROVAL_SKILL, "scripts", "live_selfcheck.py"), ...options });
    // A local facade (the control plane started it before this install) that
    // did not answer the fire is logged, not fatal: the shim blocks while it
    // is unreachable, so the gate stays fail-closed. A remote facade must answer.
    const local = isLocalFacade(gatewayValue(urlVarName()));
    const deferred = local ? report.problems.filter((p) => DEFERRABLE_LIVE.has(p)) : [];
    const hard = report.problems.filter((p) => !deferred.includes(p));
    if (hard.length > 0) {
      throw new ApprovalInstallError(
        "approval-selfcheck-failed",
        `self-check failed: ${report.problems.join(", ")}; config.yaml and .env were restored to their pre-install bytes`,
      );
    }
    if (deferred.length > 0) {
      console.error(
        `! approval gate: live self-check deferred (local facade did not answer: ${deferred.join(", ")}); ` +
          "the gate stays fail-closed (the shim blocks while the facade is unreachable). " +
          "Run `bun install/install_approval.ts --check` by hand once the daemon answers.",
      );
    }
    const { tenant } = writeSurfaceMarker(now, prior, report.overrides);
    // DATA-379: only after a live fire the facade REFUSED (its expected code; a block with another code means a
    // core decided it, and the pre-warm would be a second decided request); never fatal (it cannot throw).
    if (deferred.length > 0) console.log("→ approval gate: pre-warm not run (the live self-check was deferred)");
    else if (report.liveCodeMatched === true) prewarmAfterInstall(options);
    else console.log("→ approval gate: pre-warm not run (the live fire was decided, not refused)");
    const scripts = cronScripts();
    if (scripts.length > 0) {
      console.log(
        `→ approval gate: ${scripts.length} script(s) under $HERMES_HOME/scripts/ run at cron ticks with NO hook ` +
          `(DATA-234; only creating or changing a job is gated): ${scripts.join(", ")}`,
      );
    }
    console.log(exit1Line(report.exit1));
    // R3 fix round 4 (the trust boundary): what Hermes's own load and parse of the config.yaml this
    // install just wrote registers for the shim (live_selfcheck.py 5b), kept for the gate receipt
    // install.ts prints last (gateReceiptLine); nothing about it is printed here.
    lastRouted = report.routed ?? null;
    lastVerified = deferred.length === 0 && lastRouted?.entries === APPROVAL_GATED_TOOLS.length && lastRouted.sha256 === APPROVAL_ROUTED_SHA256;
    console.log(
      `→ approval gate installed: ${APPROVAL_GATED_TOOLS.length} pre_tool_call entries (fail_closed), ` +
        `config ${configChanged ? "updated" : "unchanged"}, ${envChanged} .env line(s) set, ` +
        (deferred.length > 0 ? `self-check passed (live: deferred, ${deferred.join(", ")}), ` : "self-check passed (live: blocked by the facade), ") +
        `overrides: ${report.overrides.length > 0 ? report.overrides.join(", ") : "none"}` +
        (tenant ? "" : " (warning: no TENANT_ID; the surface marker records tenant_id null)"),
    );
    return "installed";
  } catch (err) {
    restore(configPath, saved.config);
    restore(envPath, saved.env);
    restore(approvalSurfacePath(), saved.surface);
    // What a failed FIRST install staged goes too; a re-install keeps the shim it found.
    if (saved.shim === null) rmSync(approvalShimPath(), { force: true });
    else writeFileAtomic(approvalShimPath(), saved.shim, 0o700);
    if (!saved.skill) rmSync(skillTarget, { recursive: true, force: true });
    if (!saved.hooksDir) rmSync(approvalHooksDir(), { recursive: true, force: true });
    throw err;
  }
}

/**
 * `installApproval` for the installer: a failure is printed with its reason
 * and reported to the caller, which exits non-zero. Never throws.
 */
export function runApprovalStep(sourceSkills: string, options: ApprovalOptions = {}): boolean {
  try {
    installApproval(sourceSkills, options);
    return true;
  } catch (err) {
    if (err instanceof ApprovalInstallError) {
      console.error(`✗ approval gate: ${err.code}: ${err.message}`);
    } else {
      const kind = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
      console.error(`✗ approval gate: approval-install-error: ${kind}`);
    }
    return false;
  }
}

/** `bun install/install_approval.ts --check`: writes nothing; exit 0 when the gate is in place, 1 otherwise. */
export function checkCli(argv: string[], options: ApprovalOptions = {}): number {
  if (argv[0] !== "--check" || argv.length > 1) {
    console.error("usage: bun install/install_approval.ts --check");
    return 2;
  }
  let report: ApprovalReport;
  try {
    report = checkApprovalReport(options);
  } catch (err) {
    report = { problems: [`check-error:${err instanceof Error ? err.name : typeof err}`], overrides: [] };
  }
  const { problems, overrides } = report;
  let scripts: string[] = [];
  try {
    scripts = cronScripts();
  } catch {
    // a listing that fails changes no verdict
  }

  console.log(
    JSON.stringify({
      check: "av-approval",
      ok: problems.length === 0,
      problems,
      overrides,
      hermes_exit1: report.exit1 ?? "unknown",
      cron_scripts: scripts,
      // R3 fix rounds 3/4 (SF1 b): what Hermes's own parse registers for the shim, against what
      // this installer writes; null when the live check did not run. A mismatch is also a problem.
      routed_entries: report.routed?.entries ?? null,
      routed_sha256: report.routed?.sha256 ?? null,
      routed_entries_expected: APPROVAL_GATED_TOOLS.length,
      routed_sha256_expected: APPROVAL_ROUTED_SHA256,
    }),
  );
  return problems.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// DATA-379: the pre-warm
// ---------------------------------------------------------------------------

/** The word the shim writes as `source=prewarm` on the pre-warm's log lines (the only word it accepts). */
export const PREWARM_SOURCE = "prewarm";
/** The pre-warm's session id in the envelope (never a resident's). */
export const PREWARM_SESSION = "av-approval-prewarm";
/** Operator override: an "off" spelling skips the pre-warm, as `AV_DISPLAY_DEFAULTS` does its step. */
export const PREWARM_ENV = "AV_APPROVAL_PREWARM";
const PREWARM_OFF = new Set(["0", "false", "no", "off"]);
/** One post (`APPROVAL_HOOK_WAIT_S=0`), a short curl ceiling, and a bound on the whole spawn. */
export const PREWARM_MAX_TIME_S = 10;
export const PREWARM_TIMEOUT_MS = 15_000;
/** The facade's refusal of the live fire's request (APRV-415; live_selfcheck.py item 6). */
const PREWARM_EXPECTED_CODE = "hook-unsupported-execution-context";
const SHIM_BLOCK_PREFIX = "approval facade unreachable";

export type PrewarmOutcome = "facade-block" | "shim-block" | "allow" | "unexpected" | "error" | "skipped";

/** What one pre-warm did: an outcome, a fixed reason code (never a value or a message), and its wall time. */
export interface PrewarmReport {
  outcome: PrewarmOutcome;
  reason: string | null;
  elapsed_ms: number | null;
}

/** `AV_APPROVAL_PREWARM` off (process environment first, then `.env`, as `AV_DISPLAY_DEFAULTS`). A read that fails is not off. */
export function prewarmOptedOut(): boolean {
  try {
    const raw = envOrDotenv(PREWARM_ENV);
    return raw !== undefined && PREWARM_OFF.has(raw.trim().toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The pre-warm's envelope: the live fire's request (a `terminal` call with NO `workdir`), as Hermes
 * serializes a pre_tool_call. Core v0.4.3 refuses it in `commandHook` before the open window, the
 * policy decision, the classifier and any append (`hook-unsupported-execution-context`, APRV-415),
 * which every install and every `--check` already relies on. Nothing runs whatever the answer.
 */
export function prewarmEnvelope(cwd: string = process.cwd()): string {
  return JSON.stringify({
    hook_event_name: "pre_tool_call",
    tool_name: "terminal",
    tool_input: { command: "ls /tmp" },
    session_id: PREWARM_SESSION,
    cwd,
    extra: {},
  });
}

/**
 * The hook's environment as the gateway would hand it over, for the names the shim reads by hand
 * (`.env` first, then this process's environment, as Hermes loads `.env` with override), plus the
 * pre-warm's three fixed settings. Only these names: nothing else of `.env` reaches the shim.
 */
function prewarmEnv(): Record<string, string> {
  const names = new Set<string>([
    "APPROVAL_HOOK_URL_ENV",
    "APPROVAL_HOOK_TOKEN_ENV",
    "APPROVAL_HOOK_LOG",
    "APPROVAL_FACADE_ALLOW_HTTP",
    URL_VAR,
    TOKEN_VAR,
    TOKEN_FILE_VAR,
    DAEMON_UID_VAR,
  ]);
  for (const ref of NAME_VALUED_LINES) {
    const named = gatewayValue(ref)?.trim();
    if (named && ENV_NAME.test(named)) names.add(named);
  }
  const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  for (const name of names) {
    const value = gatewayValue(name);
    if (value !== undefined) env[name] = value;
  }
  env.HERMES_HOME = hermesHome();
  env.APPROVAL_HOOK_WAIT_S = "0";
  env.APPROVAL_HOOK_MAX_TIME = String(PREWARM_MAX_TIME_S);
  env.APPROVAL_HOOK_SOURCE = PREWARM_SOURCE;
  return env;
}

/**
 * DATA-379: the live fire's request once more, through the installed shim, so the shim's programs
 * and the daemon's pooled hook thread (its modules, its proof of the log and the policy load the
 * thread runs before every call) are warm before the resident's next gated call. What it cannot warm:
 * the classifier, the decision and the append, which no request from here can reach without being
 * recorded or asked about under the resident's policy. Never throws, never fails: a gate that is
 * off, opted out or not installed is `skipped`, a facade that does not answer is `shim-block`, a hang
 * is `error`/`timed-out`. Writes nothing but the shim's own log lines (`source=prewarm`).
 */
export function prewarmApproval(options: { timeoutMs?: number } = {}): PrewarmReport {
  const skipped = (reason: string): PrewarmReport => ({ outcome: "skipped", reason, elapsed_ms: null });
  try {
    if (prewarmOptedOut()) return skipped("opted-out");
    if (approvalChoice() !== "on") return skipped("approval-not-enabled");
    const shim = approvalShimPath();
    let st;
    try {
      st = lstatSync(shim);
    } catch {
      return skipped("shim-missing");
    }
    if (!st.isFile() || st.isSymbolicLink()) return skipped("shim-not-regular");
    if (!isExecutable(shim)) return skipped("shim-not-executable");
    const t0 = performance.now();
    const out = spawnSync(shim, [], {
      input: prewarmEnvelope(),
      env: prewarmEnv(),
      encoding: "utf8",
      timeout: options.timeoutMs ?? PREWARM_TIMEOUT_MS,
    });
    const elapsed = Math.round(performance.now() - t0);
    const report = (outcome: PrewarmOutcome, reason: string | null = null): PrewarmReport => ({ outcome, reason, elapsed_ms: elapsed });
    if (out.error) return report("error", (out.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timed-out" : "spawn-error");
    if (out.status === null) return report("error", "signal");
    const stdout = (out.stdout ?? "").trim();
    // An allow is reported, never acted on: the pre-warm runs no tool, whatever the answer.
    if (out.status === 0) return stdout === "" || stdout === "{}" ? report("allow") : report("unexpected", "exit-0");
    let directive: unknown = null;
    try {
      directive = JSON.parse(stdout);
    } catch {
      directive = null;
    }
    if (out.status === 2 && isMapping(directive) && directive.action === "block") {
      const message = typeof directive.message === "string" ? directive.message : "";
      if (message.startsWith(SHIM_BLOCK_PREFIX)) return report("shim-block");
      return report("facade-block", message.includes(PREWARM_EXPECTED_CODE) ? null : "code-not-matched");
    }
    return report("unexpected", `exit-${out.status}`);
  } catch (err) {
    return { outcome: "error", reason: err instanceof Error ? err.name : typeof err, elapsed_ms: null };
  }
}

/**
 * The install's call (step 8, after a live fire the facade refused): the pre-warm, then one line,
 * on stdout when the facade refused it as expected or it was opted out, else on stderr. Never
 * throws: whatever the pre-warm did, the step's result is the one it would have been without it.
 */
export function prewarmAfterInstall(options: ApprovalOptions = {}): PrewarmReport {
  let report: PrewarmReport;
  try {
    if (prewarmOptedOut()) report = { outcome: "skipped", reason: "opted-out", elapsed_ms: null };
    else report = (options.prewarm ?? prewarmApproval)();
  } catch (err) {
    report = { outcome: "error", reason: err instanceof Error ? err.name : typeof err, elapsed_ms: null };
  }
  try {
    if (report.reason === "opted-out") {
      console.log(`→ approval gate: pre-warm skipped (${PREWARM_ENV} is off)`);
    } else if (report.outcome === "facade-block" && report.reason === null) {
      console.log(`→ approval gate: pre-warm sent (refused by the facade as expected, ${report.elapsed_ms ?? "?"} ms; shim log source=prewarm)`);
    } else {
      console.error(
        `! approval gate: pre-warm ${report.outcome}${report.reason ? ` (${report.reason})` : ""}; ignored, the install does not depend on it`,
      );
    }
  } catch {
    // a line that cannot be printed changes nothing
  }
  return report;
}

/** `bun install/install_approval.ts --prewarm`: one JSON line; exit 0 whatever happened. */
export function prewarmCli(argv: string[], options: { timeoutMs?: number } = {}): number {
  if (argv[0] !== "--prewarm" || argv.length > 1) {
    console.error("usage: bun install/install_approval.ts --prewarm");
    return 2;
  }
  const report = prewarmApproval(options);
  console.log(JSON.stringify({ prewarm: "av-approval", ...report }));
  return 0;
}

/** The command line: `--check` (unchanged) or `--prewarm`. */
export function mainCli(argv: string[]): number {
  return argv[0] === "--prewarm" ? prewarmCli(argv) : checkCli(argv);
}

if (import.meta.main) {
  process.exit(mainCli(process.argv.slice(2)));
}
