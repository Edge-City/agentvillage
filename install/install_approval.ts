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

import { dotenvFileValue, readConfig, writeConfig } from "./config";
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
] as const;

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
  if (YAML.stringify(before) === YAML.stringify(next)) return false;
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
  const loop = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})(?:\/.*)?$/.exec(url);
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
  safe_mode?: boolean;
  managed?: boolean;
  managed_dir?: string | null;
  floor_ok?: boolean;
  release_date?: string;
  signal_patch?: boolean;
  signal_patch_marker?: boolean;
  exit1_blocks?: boolean | null;
  consent_effective?: boolean | null;
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
  return { problems, overrides, exit1 };
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
  return { problems: [...new Set(live.problems)], overrides: live.overrides, exit1: live.exit1 ?? "unknown" };
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

export function installApproval(sourceSkills: string, options: ApprovalOptions = {}): ApprovalOutcome {
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
    const scripts = cronScripts();
    if (scripts.length > 0) {
      console.log(
        `→ approval gate: ${scripts.length} script(s) under $HERMES_HOME/scripts/ run at cron ticks with NO hook ` +
          `(DATA-234; only creating or changing a job is gated): ${scripts.join(", ")}`,
      );
    }
    console.log(exit1Line(report.exit1));
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
    }),
  );
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(checkCli(process.argv.slice(2)));
}
