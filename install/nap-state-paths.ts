#!/usr/bin/env bun
/**
 * The nap state path rules (P-COST NAP design v2 sections 1.2-1.4, 13 M1 and M3): the EXCLUDE list (the
 * only thing that keeps a file out of the archive), the classifier, and the `cp_remintable` list.
 *
 * The archive walks the whole home (`/home/hermes`, which holds `$HERMES_HOME` and the agent's working
 * files) and consults ONLY `EXCLUDES`. Everything else is archived, including names nothing here lists:
 * those are class `unclassified`. Every excluded path is still counted, per exclude name, so the control
 * plane's independent root count can be compared with what the script packed (13 M2).
 *
 * Classes (`files.json`):
 *   - `secret_cp`    : what the control plane re-mints on every wake (`CP_REMINTABLE.files`; and in
 *                      `$HERMES_HOME/.env`, the key names in `CP_REMINTABLE.env_keys`): archived, NEVER
 *                      written back;
 *   - `secret_box`   : credentials only the archive holds (`auth.json`, the vault, OAuth and MCP tokens, the
 *                      av-events HMAC key, `$HERMES_HOME/.env` for every key the cp did not write, and any
 *                      `.env`, `*.pem`, `*.key`, `*.p12` file): archived AND restored, mode 0600;
 *   - `log`          : `$HERMES_HOME/logs/`;
 *   - `state`        : the paths design 1.2 names (rows 1-24);
 *   - `unclassified` : anything else under the home: archived and restored like `state`, counted apart;
 *   - `link`         : a symlink (set by the walker), recorded with its target, never followed;
 *   - `dir`          : a directory the walk entered, empty or not, with its mode (Fable S2): no data.
 * The approvald store tar (staged by the control plane's root piece into the nap dir, the ONE file under
 * `av-events/nap/` that is archived; review-a S-n2) rides as one `state` entry named `APPROVALD_STORE_ENTRY`,
 * and each of its members is listed after it, file by file, under the virtual prefix
 * `/var/lib/approvald/<tenant>/` (class `state`, `member_of` the store entry, size and SHA-256, no data of
 * its own), so the control plane's root count of `/var/lib/approvald/<t>` can be compared member by member.
 * Every one of these paths starts with `/`, so none can ever name a home file, and a restore never writes
 * them into the home.
 *
 * One module, imported by `install/nap-archive.ts` and `install/restore-state.ts`; the control plane reads
 * the same rules from `bun --no-env-file --no-install install/nap-state-paths.ts` (one JSON document,
 * `nap_state_paths.v2`), and the module uses only erasable TypeScript and `node:` imports, so Node's type
 * stripping can import it too.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, posix } from "node:path";

export const NAP_STATE_PATHS_SCHEMA = "nap_state_paths.v2";

export type NapClass = "state" | "secret_cp" | "secret_box" | "unclassified" | "link" | "log" | "dir";

/** The tool's own working directory, relative to `$HERMES_HOME`. */
export const NAP_DIR = "av-events/nap";
/** Where the root piece stages the approvald store tar, relative to `$HERMES_HOME`. */
export const APPROVALD_STORE_FILE = `${NAP_DIR}/approvald-store.tar.gz`;
/** Its `files.json` path: absolute, so never a home path, and a restore never writes it into the home. */
export const APPROVALD_STORE_ENTRY = "/var/lib/approvald/.nap-store.tar.gz";
/** The virtual root of the store's members in `files.json` (`/var/lib/approvald/<tenant>/<member>`). */
export const APPROVALD_MEMBER_ROOT = "/var/lib/approvald/";
export const approvaldMemberPath = (tenant: string, member: string) => `${APPROVALD_MEMBER_ROOT}${tenant}/${member}`;
/** The browser profiles stay excluded (Hermes treats them as a regenerable credential store; review-a
 * N-n3): the manifest records how many files were dropped and a flag, for the resident notice. */
export const BROWSER_PROFILE_EXCLUDE = "browser_profile";
/**
 * The nap bundle (review-a S-n4): the files the control plane stages, pinned, per run (one directory, so the
 * relative imports resolve) and runs from there. `tool_sha256` is the SHA-256 of the text
 * `<name>\n<sha256 hex of its bytes>\n` for each name in this order; the archive prints it on a dry run and
 * records it in the manifest.
 */
export const BUNDLE_FILES: readonly string[] = [
  "nap-archive.ts", "nap-common.ts", "nap-sqlite-fold.ts", "nap-state-paths.ts", "paths.ts", "restore-state.ts",
];

/**
 * An exclude: `scope` says what `match` is matched against.
 *   - `dir_any_depth`: a DIRECTORY of that name at any depth (the whole subtree); a regular file or link
 *     of that name is not matched (Fable S3);
 *   - `name_any_depth`: a file name at any depth;
 *   - `suffix_any_depth`: a file-name suffix at any depth;
 *   - `hermes_path`: a path under `$HERMES_HOME` (file or subtree), with `except` paths kept;
 *   - `root_path`: a path under the walk root (file or subtree);
 *   - `type`: a special file type (`socket`, `fifo`).
 */
export type Exclude = {
  name: string;
  scope: "dir_any_depth" | "name_any_depth" | "suffix_any_depth" | "hermes_path" | "root_path" | "type";
  match: string;
  except?: string[];
};

/** Design 1.3, the whole of what the archive leaves out. */
export const EXCLUDES: readonly Exclude[] = [
  // Interpreter and dependency trees.
  { name: "hermes_agent", scope: "hermes_path", match: "hermes-agent" },
  { name: "venv", scope: "dir_any_depth", match: ".venv" },
  { name: "venv", scope: "dir_any_depth", match: "venv" },
  { name: "site_packages", scope: "dir_any_depth", match: "site-packages" },
  { name: "node_modules", scope: "dir_any_depth", match: "node_modules" },
  { name: "pycache", scope: "dir_any_depth", match: "__pycache__" },
  { name: "pyc", scope: "suffix_any_depth", match: ".pyc" },
  { name: "dot_cache", scope: "dir_any_depth", match: ".cache" },
  { name: "bun_install_cache", scope: "root_path", match: ".bun/install/cache" },
  { name: "browser_profile", scope: "dir_any_depth", match: "browser-profile" },
  { name: "browser_profile", scope: "dir_any_depth", match: "browser-profiles" },
  // Installer binaries and checkouts the control plane re-stages.
  { name: "edge_src", scope: "hermes_path", match: "edge-src" },
  { name: "hermes_bin", scope: "hermes_path", match: "bin" },
  { name: "local_bin", scope: "root_path", match: ".local/bin" },
  { name: "local_share_uv", scope: "root_path", match: ".local/share/uv" },
  { name: "bun_bin", scope: "root_path", match: ".bun/bin" },
  // The derived recall index; its `--wipe-user` epoch marker is kept (13 N3; install/install_recall.ts:12-14).
  { name: "recall", scope: "hermes_path", match: ".recall", except: [".recall/epoch"] },
  // Hermes's runtime files, at the $HERMES_HOME root only (hermes_cli/backup.py:108, :128): a resident's
  // file of the same name anywhere else is archived (Fable S3).
  { name: "pid", scope: "hermes_path", match: "gateway.pid" },
  { name: "pid", scope: "hermes_path", match: "cron.pid" },
  { name: "gateway_lock", scope: "hermes_path", match: "gateway.lock" },
  { name: "processes_json", scope: "hermes_path", match: "processes.json" },
  { name: "backup_lock", scope: "hermes_path", match: ".backup.lock" },
  { name: "socket", scope: "type", match: "socket" },
  { name: "fifo", scope: "type", match: "fifo" },
  // The tool's own staging: neither archived nor counted (the approvald store tar staged inside it is
  // archived as its own entry, with its members listed; S-n2).
  { name: "nap_dir", scope: "hermes_path", match: NAP_DIR },
];

/** Every exclude name, for the counts. */
export const EXCLUDE_NAMES: readonly string[] = [...new Set(EXCLUDES.map((e) => e.name))];

/** What the control plane re-mints on every wake (design 1.4's "cp" rows, 13 M3): class `secret_cp`. */
export const CP_REMINTABLE = {
  /** Files, relative to `$HERMES_HOME`. */
  files: ["approval/agent-token"] as readonly string[],
  /** `$HERMES_HOME/.env` key names: archived, never merged back (the wake wrote fresh ones). */
  env_keys: [
    "AV_EVENTS_TOKEN",
    "AV_BACKUP_TOKEN",
    "AV_ARCHIVE_READ_HASH",
    "AV_APPROVAL_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "OPENROUTER_API_KEY",
    "INDEX_API_KEY",
    "EDGEOS_API_KEY",
    "GROQ_API_KEY",
    "MORALMOD_LLM_API_KEY",
    "AV_GODCONST_BALLOT_KEY",
    "AV_THOR_KEY",
  ] as readonly string[],
};

/** `$HERMES_HOME/.env`: class `secret_box`, restored by a merge (keys absent from the cp-written file). */
export const ENV_FILE = ".env";
/** Class `secret_box`, relative to `$HERMES_HOME` (design 1.2 rows 16, 22; 1.4). */
export const SECRET_BOX_FILES: readonly string[] = [ENV_FILE, "auth.json", "vault.key", "vault.json.enc", "google_token.json", "av-events/hash.key"];
export const SECRET_BOX_DIRS: readonly string[] = ["mcp-tokens"];
/** Any file named like this, anywhere under the home, is `secret_box`. */
export const SECRET_BOX_NAME = /^(\.env(\..+)?|.+\.(pem|key|p12))$/;
/** Class `log`, relative to `$HERMES_HOME`. */
export const LOG_DIRS: readonly string[] = ["logs"];
/** The files design 1.2 names (rows 1-24), relative to `$HERMES_HOME`: class `state`. */
export const STATE_FILES: readonly string[] = [
  "config.yaml", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "state.db", "cron/jobs.json", "cron/executions.db",
  "gateway_state.json", "av-profile.json", "_profile.md", ".moralmod-box/box.py", "kanban.db", "response_store.db",
  "memory_store.db", "projects.db", "verification_evidence.db", "channel_directory.json", "channel_aliases.json",
  "webhook_subscriptions.json", "mini-apps.json", "village-bridge.json", "constitution.md", "shell-hooks-allowlist.json",
  ".recall/epoch",
];
/** The directories design 1.2 names, relative to `$HERMES_HOME`: class `state`. */
export const STATE_DIRS: readonly string[] = [
  "memories", "memory", "sessions", "cron/output", "skills", "knowledge", "scripts", "av-events", "agent-hooks", "index",
  "zzzbot", "pairing", "platforms/pairing", "kanban/boards", "plugin-data", "profiles", "cache/images", "cache/audio",
  "cache/videos", "cache/documents", "cache/screenshots", "cache/citations", "image_cache", "audio_cache", "document_cache",
  "resident-chat", "attachments", "composer-pastes", "forkicks-drafts", ".dashboard-auth-edgecity",
];
/** SQLite files the archive folds (13 S1), and the WAL sidecar suffix it refuses to leave non-empty. */
export const SQLITE_SUFFIXES: readonly string[] = [".db", ".sqlite", ".sqlite3"];
export const WAL_SUFFIX = "-wal";
const SIDECARS = ["-wal", "-shm", "-journal"];

export type PathRules = { hermesRel: string };

// A backslash is an ordinary byte in a Linux name (Fable N4); no tar entry ever carries a path.
const SEGMENT_OK = (s: string) => s.length > 0 && s !== "." && s !== ".." && !s.includes("\0");

/** A clean relative path: no leading `/`, no empty, `.` or `..` segment, no NUL. */
export function cleanRelPath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 4096 || rel.startsWith("/")) return false;
  return rel.split("/").every(SEGMENT_OK);
}

const under = (rel: string, base: string) => rel === base || rel.startsWith(`${base}/`);
const inHermes = (r: PathRules, p: string) => (r.hermesRel ? `${r.hermesRel}/${p}` : p);

/** The exclude name that leaves `rel` (relative to the walk root) out, or null. `isDir` says whether `rel`
 * itself is a directory (a `dir_any_depth` rule matches only a directory); the special types are the
 * walker's. */
export function excludedBy(rel: string, rules: PathRules, isDir = false): string | null {
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  for (const e of EXCLUDES) {
    switch (e.scope) {
      case "hermes_path": {
        const base = inHermes(rules, e.match);
        if (!under(rel, base)) break;
        if (e.except && (rel === base || e.except.some((x) => under(inHermes(rules, x), rel) || under(rel, inHermes(rules, x))))) break;
        return e.name;
      }
      case "root_path":
        if (under(rel, e.match)) return e.name;
        break;
      case "dir_any_depth":
        if (parts.slice(0, -1).includes(e.match) || (isDir && name === e.match)) return e.name;
        break;
      case "name_any_depth":
        if (name === e.match) return e.name;
        break;
      case "suffix_any_depth":
        if (name.endsWith(e.match)) return e.name;
        break;
    }
  }
  return null;
}

/** The class of a regular file at `rel` (relative to the walk root). A symlink is always `link`. */
export function classOf(rel: string, rules: PathRules): "state" | "secret_cp" | "secret_box" | "unclassified" | "log" {
  const h = rules.hermesRel ? `${rules.hermesRel}/` : "";
  const hRel = rel.startsWith(h) ? rel.slice(h.length) : null;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  if (hRel !== null) {
    if (CP_REMINTABLE.files.includes(hRel)) return "secret_cp";
    if (SECRET_BOX_FILES.includes(hRel) || SECRET_BOX_DIRS.some((d) => hRel.startsWith(`${d}/`))) return "secret_box";
  }
  if (SECRET_BOX_NAME.test(name)) return "secret_box";
  if (hRel !== null) {
    if (LOG_DIRS.some((d) => hRel.startsWith(`${d}/`))) return "log";
    const main = SIDECARS.reduce((p, s) => (p.endsWith(s) ? p.slice(0, -s.length) : p), hRel);
    if (STATE_FILES.includes(hRel) || STATE_FILES.includes(main) || STATE_DIRS.some((d) => hRel.startsWith(`${d}/`))) return "state";
  }
  return "unclassified";
}

/** Whether a restore may write `rel`: a clean path under the root that the exclude list does not leave out. */
export function restorable(rel: string, rules: PathRules, isDir = false): boolean {
  return cleanRelPath(rel) && excludedBy(rel, rules, isDir) === null;
}

/** A symlink target a restore may recreate (Fable S4): any non-empty text without NUL, absolute or climbing
 * out of the root included. Recreating a link writes only the link; a restore never writes THROUGH one. */
export function linkTargetValid(target: unknown): target is string {
  return typeof target === "string" && target.length > 0 && Buffer.byteLength(target) < 4096 && !target.includes("\0");
}

/** How a link's target reaches out: `absolute`, `escaping` (relative, climbs out of the walk root) or null. */
export function linkReach(linkRel: string, target: string): "absolute" | "escaping" | null {
  if (target.startsWith("/")) return "absolute";
  const resolved = posix.normalize(posix.join(posix.dirname(linkRel), target));
  return resolved === ".." || resolved.startsWith("../") ? "escaping" : null;
}

export type WalkItem = { rel: string; type: "file" | "link" | "dir"; st: Stats };
export type ExcludedCounts = Record<string, { files: number; bytes: number }>;
/** What a lenient walk counted instead of refusing (review-a N-n1: batch 0's dry count). */
export type WalkProblems = { unreadable: number; unsupported: number; name_invalid: number };
export type WalkResult = { items: WalkItem[]; excluded: ExcludedCounts; problems: WalkProblems };

export class WalkRefused extends Error {}

/**
 * Every archivable entry under `root`, sorted, and every excluded one counted per exclude name (a
 * subtree's non-directory entries each count, with their `lstat` size). The one exception is `nap_dir`,
 * the tool's own transient staging (run file, progress, chunks, the staged approvald tar): it is neither
 * archived nor counted, and the control plane's root count prunes it the same way. Symlinks are listed and never
 * followed. Refuses (`WalkRefused`) on anything it cannot read or archive (13 S10: nothing is skipped):
 * `file_unreadable` for a directory it cannot list, `file_unsupported` for a device or a bad name.
 * `lenient` (the dry count and the fold only) counts those in `problems` and carries on.
 */
export function walkHome(root: string, rules: PathRules, opts: { lenient?: boolean } = {}): WalkResult {
  const items: WalkItem[] = [];
  const excluded: ExcludedCounts = {};
  const problems: WalkProblems = { unreadable: 0, unsupported: 0, name_invalid: 0 };
  const problem = (code: "file_unreadable" | "file_unsupported" | "file_changed" | "file_name_invalid"): null => {
    if (!opts.lenient) throw new WalkRefused(code);
    if (code === "file_unsupported") problems.unsupported++;
    else if (code === "file_name_invalid") problems.name_invalid++;
    else problems.unreadable++;
    return null;
  };
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const count = (name: string, bytes: number) => {
    const c = (excluded[name] ??= { files: 0, bytes: 0 });
    c.files++;
    c.bytes += bytes;
  };
  const stat = (rel: string): Stats | null => {
    try {
      return lstatSync(rel ? join(root, ...rel.split("/")) : root);
    } catch {
      return problem("file_changed");
    }
  };
  const list = (rel: string): string[] => {
    try {
      // As bytes: a name that is not UTF-8 cannot be named in files.json, and a lossy decode would not
      // find the file again (Fable N4). It refuses `file_name_invalid`; the dry run counts it.
      const names: string[] = [];
      for (const raw of readdirSync(rel ? join(root, ...rel.split("/")) : root, { encoding: "buffer" })) {
        let name: string;
        try {
          name = utf8.decode(raw);
        } catch {
          problem("file_name_invalid");
          continue;
        }
        names.push(name);
      }
      return names.sort();
    } catch {
      problem("file_unreadable");
      return [];
    }
  };
  /** Count a whole excluded subtree under `name`. */
  const countAll = (rel: string, name: string) => {
    const st = stat(rel);
    if (!st) return;
    if (st.isDirectory()) for (const child of list(rel)) countAll(`${rel}/${child}`, name);
    else count(name, st.size);
  };
  let top: Stats | null;
  try {
    top = lstatSync(root);
  } catch {
    top = null;
  }
  if (!top?.isDirectory()) throw new WalkRefused("root_invalid");
  const visit = (rel: string) => {
    for (const child of list(rel)) {
      const r = rel ? `${rel}/${child}` : child;
      if (!cleanRelPath(r)) {
        problem("file_unsupported");
        continue;
      }
      const st = stat(r);
      if (!st) continue;
      const why = excludedBy(r, rules, st.isDirectory());
      if (why === "nap_dir") continue; // the tool's own transient staging: neither archived nor counted
      if (why) {
        countAll(r, why);
        continue;
      }
      if (st.isSymbolicLink()) items.push({ rel: r, type: "link", st });
      else if (st.isFile()) items.push({ rel: r, type: "file", st });
      else if (st.isDirectory()) {
        items.push({ rel: r, type: "dir", st });
        visit(r);
      }
      else if (st.isSocket()) count("socket", st.size);
      else if (st.isFIFO()) count("fifo", st.size);
      else problem("file_unsupported");
    }
  };
  visit("");
  items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { items, excluded, problems };
}

/** The rules as data, for the control plane (its root count renders the same exclude list into `find`). */
export function napStatePathsDocument() {
  return {
    schema: NAP_STATE_PATHS_SCHEMA,
    walk_root: "$HOME",
    hermes_home: "$HERMES_HOME",
    nap_dir: `$HERMES_HOME/${NAP_DIR}`,
    approvald_store: {
      staged_at: `$HERMES_HOME/${APPROVALD_STORE_FILE}`,
      files_json_path: APPROVALD_STORE_ENTRY,
      member_prefix: `${APPROVALD_MEMBER_ROOT}<tenant>/`,
    },
    browser_profile: { exclude: BROWSER_PROFILE_EXCLUDE, archived: false },
    bundle_files: BUNDLE_FILES,
    excludes: EXCLUDES,
    exclude_names: EXCLUDE_NAMES,
    cp_remintable: CP_REMINTABLE,
    classes: {
      secret_box_files: SECRET_BOX_FILES.map((p) => `$HERMES_HOME/${p}`),
      secret_box_dirs: SECRET_BOX_DIRS.map((p) => `$HERMES_HOME/${p}/`),
      secret_box_name: SECRET_BOX_NAME.source,
      log_dirs: LOG_DIRS.map((p) => `$HERMES_HOME/${p}/`),
      state_files: STATE_FILES.map((p) => `$HERMES_HOME/${p}`),
      state_dirs: STATE_DIRS.map((p) => `$HERMES_HOME/${p}/`),
      default: "unclassified",
    },
    sqlite: { suffixes: SQLITE_SUFFIXES, wal_suffix: WAL_SUFFIX },
  };
}

/** The SHA-256 of the rules document, as the manifest's `paths_sha256` records it. */
export function napPathsSha256(): string {
  return createHash("sha256").update(JSON.stringify(napStatePathsDocument())).digest("hex");
}

if (import.meta.main) {
  console.log(JSON.stringify(napStatePathsDocument()));
}
