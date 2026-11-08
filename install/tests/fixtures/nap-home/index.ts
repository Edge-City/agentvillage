/**
 * Synthetic box homes and the control plane's side of a nap, for the nap tests (design v2 section 8). Nothing
 * here is real: every token is a planted marker the tests grep for, every id is made up.
 *
 * `buildNapHome(base)` writes a `/home/hermes`-shaped tree: the state design 1.2 names (rows 1-24, the
 * Hermes stores and media included), secrets of both classes, unknown files (at the home root, under
 * `resident-chat/`, in `cache/audio`, in legacy `image_cache/`) and an unknown secret file and `.env` key,
 * the `.recall` epoch marker, planted excludes of every kind (counted), a relative symlink, a hard-link pair,
 * a file larger than one test chunk, a real SQLite `state.db` whose writer was killed with rows still only in
 * its `-wal`, and a stand-in `/var/lib/approvald/<t>` OUTSIDE the home whose store the simulated root piece
 * tars (without the daemon's token files), encrypts to the cp's key and stages with a member list.
 *
 * The control plane's other steps before an archive (review-a S-n1, S-n4) are `prepareRun`: the run file,
 * its copy of the path rules, and the WAL fold run as its own exec.
 */
import { createCipheriv, createHash, createPrivateKey, createPublicKey, constants, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, createDecipheriv } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, lstatSync, symlinkSync, utimesSync, writeFileSync, readlinkSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";

import { napStatePathsDocument } from "../../../nap-state-paths";
import type { Stub } from "../put-stub";

export const TENANT = "0f0e0d0c-0000-4000-8000-00000000abcd";
export const SERVED = "a".repeat(40);
export const PLANTED = {
  eventsToken: "PLANTED-EVENTS-TOKEN-1f9c2b7e",
  botToken: "PLANTED-BOT-TOKEN-55aa66bb",
  agentToken: "PLANTED-AGENT-TOKEN-0c0ffee0",
  residentKey: "PLANTED-RESIDENT-PAT-77e1d2c3",
  authJson: "PLANTED-OAUTH-REFRESH-9d8c7b6a",
  vaultKey: "PLANTED-VAULT-KEY-1234abcd",
  hmacKey: "PLANTED-HMAC-KEY-feedface",
  deployPem: "PLANTED-UNKNOWN-PEM-a1b2c3d4",
  approvaldEnv: "PLANTED-APPROVALD-DAEMON-TOKEN-5e5e5e5e",
  approvaldHook: "PLANTED-APPROVALD-HOOK-TOKEN-6f6f6f6f",
} as const;

export type NapHome = {
  base: string;
  root: string;
  home: string;
  /** The stand-in `/var/lib/approvald/<t>` (outside the home). */
  approvaldDir: string;
  /** Paths (relative to root) that must be archived, with their class. */
  included: Record<string, string>;
  /** Paths (relative to root) left out by an exclude, with the exclude name that counts them. */
  excluded: Record<string, string>;
};

export function tempBase(label: string): string {
  // realpath: macOS /var is a symlink, and the tests compare paths.
  return realpathSync(mkdtempSync(join(tmpdir(), `nap-${label}-`)));
}

function put(root: string, rel: string, data: string | Uint8Array, mode?: number) {
  const path = join(root, ...rel.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  if (mode !== undefined) chmodSync(path, mode);
  const when = new Date(1_790_000_000_000);
  utimesSync(path, when, when);
}

/** The cp's encryption to its own key (here: an AES-256-GCM key wrapped RSA-OAEP to the test pair; the box
 * never sees either). */
function encryptToCp(plain: Buffer): Buffer {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const wrapped = publicEncrypt({ key: createPublicKey(wrapKeys().publicPem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(wrapped.length);
  return Buffer.concat([Buffer.from("TESTSTORE1"), len, wrapped, iv, c.getAuthTag(), ct]);
}

/** The control plane's root piece (4.2; review-a (b) at L43357, release L43372): tar the approvald tenant
 * directory WITHOUT the daemon's token files, encrypt it to the cp's key, encrypt its member list (path,
 * size, SHA-256) to the same key, and stage both 0600 in the nap dir. Returns the staged paths, the staged
 * bytes, and the plaintext list and members (for the test's own checks only). */
export const STORE_TOKEN_FILES = ["env", "hook-token", "run"];
export function stageStoreCopy(h: NapHome) {
  const dir = join(h.home, "av-events", "nap");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // COPYFILE_DISABLE: macOS tar would add AppleDouble `._*` members; a box's GNU tar never does.
  const p = spawnSync("tar", ["-czf", "-", ...STORE_TOKEN_FILES.map((n) => `--exclude=./${n}`), "-C", h.approvaldDir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (p.status !== 0) throw new Error(`tar failed: ${p.stderr}`);
  const blob = encryptToCp(p.stdout as Buffer);
  const members: { path: string; bytes: number; sha256: string }[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(rel ? join(h.approvaldDir, rel) : h.approvaldDir).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && STORE_TOKEN_FILES.includes(name)) continue;
      const st = lstatSync(join(h.approvaldDir, r));
      if (st.isDirectory()) walk(r);
      else members.push({ path: r, bytes: st.size, sha256: createHash("sha256").update(readFileSync(join(h.approvaldDir, r))).digest("hex") });
    }
  };
  walk("");
  members.sort((x, y) => (x.path < y.path ? -1 : 1));
  const listPlain = Buffer.from(JSON.stringify({ members }));
  const list = encryptToCp(listPlain);
  const blobPath = join(dir, "approvald-store.enc");
  const listPath = join(dir, "approvald-store.members.enc");
  writeFileSync(blobPath, blob, { mode: 0o600 });
  writeFileSync(listPath, list, { mode: 0o600 });
  chmodSync(blobPath, 0o600);
  chmodSync(listPath, 0o600);
  return { blobPath, listPath, blob, list, listPlain, members };
}

/** The cp's root step on wake: decrypt the blob (with the cp's private key) back to the store tar.gz, or the
 * encrypted list back to its JSON. */
export function decryptStoreBlob(blob: Buffer): Buffer {
  if (blob.subarray(0, 10).toString() !== "TESTSTORE1") throw new Error("not a test store blob");
  const len = blob.readUInt16BE(10);
  let off = 12;
  const wrapped = blob.subarray(off, (off += len));
  const iv = blob.subarray(off, (off += 12));
  const tag = blob.subarray(off, (off += 16));
  const key = privateDecrypt({ key: createPrivateKey(wrapKeys().privatePem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(off)), d.final()]);
}

export const STATE_DB_ROWS = 25;

/** A WAL-mode database whose writer is killed (SIGKILL) after `rows` committed inserts, never checkpointed. */
export function sqliteWithLiveWal(path: string, rows: number) {
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(path)});
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x INTEGER);");
    const ins = db.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < ${rows}; i++) ins.run(i);
    process.kill(process.pid, "SIGKILL");
  `;
  spawnSync(process.execPath, ["--no-env-file", "-e", script], { env: { PATH: process.env.PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const when = new Date(1_790_000_000_000);
  utimesSync(path, when, when);
}

export function buildNapHome(base: string, opts: { bigBytes?: number } = {}): NapHome {
  const root = join(base, "home");
  const home = join(root, ".hermes");
  mkdirSync(home, { recursive: true });
  const included: Record<string, string> = {};
  const inc = (rel: string, data: string | Uint8Array, cls = "state", mode?: number) => {
    put(root, rel, data, mode);
    included[rel] = cls;
  };
  const excluded: Record<string, string> = {};
  const exc = (rel: string, name: string, data: string | Uint8Array = "x") => {
    put(root, rel, data);
    excluded[rel] = name;
  };
  // Design 1.2 rows 1-20.
  inc(".hermes/config.yaml", "model: test\n");
  for (const f of ["SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"]) inc(`.hermes/${f}`, `# ${f}\n`);
  inc(".hermes/memories/MEMORY.md", "tool memory\n");
  inc(".hermes/memory/2026-11-01.md", "- a daily note\n");
  inc(".hermes/memory/agentvillage-state.json", "{}\n");
  // A real database whose writer was killed: rows only in its `-wal` (and a `-shm`). The fold folds them
  // and SQLite removes both sidecars, so neither is in `included`.
  sqliteWithLiveWal(join(home, "state.db"), STATE_DB_ROWS);
  included[".hermes/state.db"] = "state";
  inc(".hermes/sessions/s1.jsonl", '{"role":"user"}\n');
  inc(".hermes/sessions/big.bin", randomBytes(opts.bigBytes ?? 200 * 1024));
  inc(".hermes/cron/jobs.json", '{"jobs":[]}\n');
  inc(".hermes/cron/output/brief.md", "brief\n");
  inc(".hermes/skills/edge/SKILL.md", "skill\n");
  inc(".hermes/skills/.archive/old/SKILL.md", "archived skill\n");
  inc(".hermes/knowledge/index.md", "index\n");
  inc(".hermes/av-events/backup.json", "{}\n");
  inc(".hermes/agent-hooks/approval-surface.json", "{}\n");
  inc(".hermes/logs/gateway.log", "log line\n", "log");
  inc(".hermes/gateway_state.json", '{"state":"stopped"}\n');
  inc(".hermes/av-profile.json", "{}\n");
  inc(".hermes/.recall/epoch", "1790000000\n"); // 13 N3: kept
  // Rows 21-24: Hermes stores, media, working files.
  for (const db of ["kanban.db", "response_store.db", "memory_store.db", "projects.db"]) inc(`.hermes/${db}`, `db ${db}\n`);
  inc(".hermes/cache/images/a.png", randomBytes(300));
  inc(".hermes/cache/audio/v.ogg", randomBytes(300));
  inc(".hermes/cache/documents/d.pdf", randomBytes(300));
  inc(".hermes/image_cache/i.jpg", randomBytes(300));
  inc(".hermes/audio_cache/a.ogg", randomBytes(300));
  inc(".hermes/resident-chat/plan.md", "plan\n");
  inc(".hermes/attachments/upload.txt", "upload\n");
  inc(".hermes/forkicks-drafts/draft.json", "{}\n");
  inc(".hermes/mini-apps.json", "{}\n");
  inc(".hermes/constitution.md", "constitution\n");
  // Unknown files: archived as `unclassified` (13 M1).
  inc("surprise.bin", randomBytes(64), "unclassified");
  inc("notes/todo.txt", "outside HERMES_HOME\n", "unclassified");
  inc(".hermes/brand-new-dir/unknown.dat", randomBytes(64), "unclassified");
  inc(".hermes/agent-wrote-this.md", "the agent's cwd is HERMES_HOME\n", "unclassified");
  inc(".hermes/backups/resident-snapshot.tar", randomBytes(64), "unclassified");
  inc(".local/share/tool/data.txt", "tool data\n", "unclassified");
  inc(".bun/install/global/package.json", "{}\n", "unclassified");
  inc("project/.git/HEAD", "ref: refs/heads/main\n", "unclassified");
  // Secrets (13 M3).
  inc(".hermes/.env", `AV_EVENTS_TOKEN=${PLANTED.eventsToken}\nTELEGRAM_BOT_TOKEN=${PLANTED.botToken}\nMY_GITHUB_PAT=${PLANTED.residentKey}\nRESIDENT_NOTE=hello\n`, "secret_box", 0o600);
  inc(".hermes/approval/agent-token", PLANTED.agentToken, "secret_cp", 0o600);
  inc(".hermes/auth.json", `{"refresh":"${PLANTED.authJson}"}`, "secret_box", 0o644);
  inc(".hermes/vault.key", PLANTED.vaultKey, "secret_box", 0o600);
  inc(".hermes/vault.json.enc", randomBytes(128), "secret_box", 0o600);
  inc(".hermes/google_token.json", "{}", "secret_box", 0o600);
  inc(".hermes/mcp-tokens/server.json", "{}", "secret_box", 0o600);
  inc(".hermes/av-events/hash.key", PLANTED.hmacKey, "secret_box", 0o600);
  inc("notes/deploy.pem", PLANTED.deployPem, "secret_box", 0o640); // an unknown secret file
  inc("project/.env", "PROJECT_SETTING=1\n", "secret_box", 0o600);
  // Excludes (1.3), each counted under its name.
  exc(".hermes/hermes-agent/venv/bin/python", "hermes_agent");
  exc(".hermes/edge-src/install/install.ts", "edge_src");
  exc(".hermes/bin/hermes", "hermes_bin");
  exc(".bun/bin/bun", "bun_bin");
  exc(".bun/install/cache/pkg.tgz", "bun_install_cache");
  exc(".local/bin/tool", "local_bin");
  exc(".local/share/uv/tools/x", "local_share_uv");
  exc(".cache/pip/http/x", "dot_cache");
  exc(".hermes/skills/mine/node_modules/pkg/index.js", "node_modules");
  exc(".hermes/skills/mine/__pycache__/m.cpython-311.pyc", "pycache");
  exc(".hermes/skills/mine/tool.pyc", "pyc");
  exc("project/.venv/lib/site.py", "venv");
  exc(".local/lib/python3.11/site-packages/pkg/__init__.py", "site_packages");
  exc(".hermes/browser-profile/Cookies", "browser_profile");
  exc(".hermes/.recall/index.db", "recall");
  exc(".hermes/gateway.pid", "pid", "999999999"); // a stale record: no such process
  exc(".hermes/cron.pid", "pid", "124");
  exc(".hermes/gateway.lock", "gateway_lock", "{}");
  exc(".hermes/processes.json", "processes_json", "[]");
  exc(".hermes/.backup.lock", "backup_lock", "");
  // A FIFO and a socket: endpoints, excluded by type and counted.
  spawnSync("mkfifo", [join(home, "a.fifo")]);
  excluded[".hermes/a.fifo"] = "fifo";
  const sock = spawnSync("python3", ["-c", "import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1])", join(home, "a.sock")]);
  if (sock.status === 0) excluded[".hermes/a.sock"] = "socket";
  // A relative symlink inside the home: archived as a link, never followed.
  symlinkSync("edge", join(home, "skills", "linked"));
  included[".hermes/skills/linked"] = "link";
  // A hard-link pair.
  put(root, ".hermes/memory/hard-a.md", "same bytes\n");
  linkSync(join(home, "memory", "hard-a.md"), join(home, "memory", "hard-b.md"));
  included[".hermes/memory/hard-a.md"] = "state";
  included[".hermes/memory/hard-b.md"] = "state";
  // The stand-in approvald tenant directory, outside the home, with its daemon token files.
  const approvaldDir = join(base, "var-lib-approvald", TENANT);
  put(approvaldDir, "data/APPROVAL.md", "# attested policy\n");
  put(approvaldDir, "data/chain.jsonl", '{"seq":0}\n');
  put(approvaldDir, "sandbox-id", "old-sandbox\n");
  put(approvaldDir, "env", `AGENT_TOKEN=${PLANTED.approvaldEnv}\n`, 0o600);
  put(approvaldDir, "hook-token", PLANTED.approvaldHook, 0o600);
  const h: NapHome = { base, root, home, approvaldDir, included, excluded };
  stageStoreCopy(h);
  return h;
}

/** Every regular file and link under `dir` (relative path → sha256 or link target), for before/after compares. */
export function snapshotTree(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(rel ? join(dir, rel) : dir).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      const st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(join(dir, r))}`;
      else if (st.isDirectory()) walk(r);
      else if (st.isFile()) out[r] = createHash("sha256").update(readFileSync(join(dir, r))).digest("hex");
      else out[r] = "special";
    }
  };
  walk("");
  return out;
}

let keys: { publicPem: string; privatePem: string } | null = null;
/** One RSA-4096 pair per test process (the cp's). */
export function wrapKeys() {
  keys ??= (() => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
    return {
      publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  })();
  return keys;
}

export const runPrefix = (runId: string, date = "2026-11-08") => `nap/${TENANT}/${date}/${runId}/`;
export const newRunId = () => {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** The cp's PUT run file: `slots` chunk URLs and the manifest slot, staged 0600 in the nap dir. */
export function stagePutRun(stub: Stub, home: string, runId: string, slots = 64, ttlS = 3600): string {
  const prefix = runPrefix(runId);
  const doc = {
    schema: "nap_run.v1",
    direction: "put",
    tenant_id: TENANT,
    run_id: runId,
    prefix,
    manifest: { url: stub.url("PUT", `${prefix}state_manifest.json`, ttlS) },
    chunks: Array.from({ length: slots }, (_, n) => {
      const name = `chunk-${String(n).padStart(4, "0")}.bin`;
      return { name, url: stub.url("PUT", `${prefix}${name}`, ttlS) };
    }),
  };
  const dir = join(home, "av-events", "nap");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "run.json");
  writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export const napDir = (home: string) => join(home, "av-events", "nap");

/** The cp's copy of the path rules (from the pinned bundle), staged in the nap dir. */
export function stagePaths(home: string, doc: unknown = napStatePathsDocument()): string {
  const path = join(napDir(home), "nap-state-paths.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

/** The WAL fold, as the cp runs it: its own exec, before the root count (S-n1). */
export function runFold(script: string, h: { root: string; home: string }, runId: string) {
  const p = spawnSync(process.execPath, ["--no-env-file", "--no-install", script, "--run-id", runId, "--root", h.root, "--home", h.home], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: h.root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  return { code: p.status, line: p.stdout.trim() ? JSON.parse(p.stdout.trim().split("\n").pop()!) : null, stderr: p.stderr };
}

/** The cp's GET run file for a restore of the manifest at `manifestKey` (copied by the cp to the
 * content-addressed key, or read at the slot). */
export function stageGetRun(stub: Stub, home: string, manifestKey: string, chunks: number): string {
  const prefix = manifestKey.slice(0, manifestKey.lastIndexOf("/") + 1);
  const runId = prefix.split("/")[3];
  const doc = {
    schema: "nap_run.v1",
    direction: "get",
    tenant_id: TENANT,
    run_id: runId,
    prefix,
    manifest: { url: stub.url("GET", manifestKey) },
    chunks: Array.from({ length: chunks }, (_, n) => {
      const name = `chunk-${String(n).padStart(4, "0")}.bin`;
      return { name, url: stub.url("GET", `${prefix}${name}`) };
    }),
  };
  const dir = join(home, "av-events", "nap");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "run.json");
  writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** What the cp does after the box's line: copy the slot manifest to its content-addressed key. */
export function publishManifest(stub: Stub, manifestKey: string): Buffer {
  const prefix = manifestKey.slice(0, manifestKey.lastIndexOf("/") + 1);
  const bytes = stub.objects.get(`${prefix}state_manifest.json`);
  if (!bytes) throw new Error("no manifest at the slot");
  stub.objects.set(manifestKey, bytes);
  return bytes;
}

/** The cp's unwrap (in its own process; M2): the data key and IV a restore receives. */
export function unwrapKeyDoc(manifest: { wrapped_key_b64: string; iv_b64: string }): string {
  const key = privateDecrypt(
    { key: createPrivateKey(wrapKeys().privatePem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(manifest.wrapped_key_b64, "base64"),
  );
  return JSON.stringify({ schema: "nap_key.v1", data_key_b64: key.toString("base64"), iv_b64: manifest.iv_b64 });
}

export function stageKey(home: string, doc: string): string {
  const path = join(home, "av-events", "nap", "restore-key.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, doc, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** The cp's decrypt-and-list (data M1), done here independently of the restore script: chunks in order →
 * AES-GCM → gunzip → the tar's entries. */
export function decryptPayload(stub: Stub, manifest: any): { tar: Buffer; entries: Map<string, Buffer> } {
  const keyDoc = JSON.parse(unwrapKeyDoc(manifest));
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyDoc.data_key_b64, "base64"), Buffer.from(manifest.iv_b64, "base64"));
  d.setAuthTag(Buffer.from(manifest.gcm_tag_b64, "base64"));
  const parts = manifest.chunks.map((c: any) => d.update(stub.objects.get(`${manifest.prefix}${c.name}`)!));
  parts.push(d.final());
  const gz = Buffer.concat(parts);
  if (createHash("sha256").update(gz).digest("hex") !== manifest.payload.sha256) throw new Error("payload sha");
  const tar = gunzipSync(gz);
  const entries = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(h.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
    entries.set(name, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { tar, entries };
}

export function cleanup(dirs: string[]) {
  for (const d of dirs.splice(0)) {
    try {
      // a test may leave a directory without write permission
      spawnSync("chmod", ["-R", "u+rwx", d]);
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export const fileMode = (path: string) => statSync(path).mode & 0o777;
