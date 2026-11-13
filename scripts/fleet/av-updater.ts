/**
 * FLEET-AT-SCALE spike (DARK): the box-side pull updater, `av-updater` (design §2a "On-box
 * updater", "Health and rollback", "Holds"). Off unless AV_PULL_UPDATER is exactly "1": off, tick()
 * returns before it reads state or calls any dependency, and startUpdater() starts nothing.
 *
 * Nothing installs or starts this file today: no checkpoint, installer, cron or roll step names it,
 * and today's push roll is untouched. Every effect goes through an injected dependency, so the
 * spike is tested with a fake desired endpoint, fake downloads, a fake fs and a fake health check.
 *
 * One tick, when on:
 *   1. read the persisted state (current, previous, highest floor applied, refused version)
 *   2. ask the cp for the desired version (GET /v1/box/desired; box-key auth is the cp's stub).
 *      The reply is parsed against a strict schema; nothing in it is executed. `hold` = keep.
 *   3. same as current, refused, or applied < 10 min ago: do nothing
 *   4. download manifest, signature and bundle into staging/<v>/ from an allowlisted https host
 *   5. verifyRelease() (signature, sha256, size, not_before, expires, min_updater, floor)
 *   6. unpack into releases/<v>/, swap the `current` link atomically, run the bundle's installer
 *      from that tree, restart the gateway loop, soak (health check)
 *   7. healthy: record it, keep the previous release, prune older ones, report `applied`.
 *      unhealthy: swap back, re-install the previous release, restart, report `rolled_back`, and
 *      refuse that version until the cp names a different one. Never a cohort-wide revert (D2).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, parseVersion, verifyRelease, VERSION_RE, type Refusal } from "./release";

export const UPDATER_VERSION = "v0.1.0";
export const FLAG = "AV_PULL_UPDATER";
export const MIN_APPLY_INTERVAL_MS = 10 * 60_000;
export const POLL_MS = 10 * 60_000;
export const KEEP_RELEASES = 2;

export type UpdaterState = {
  current: string | null;
  previous: string | null;
  /** The highest floor_version of a release this box applied and kept; ratchets up only. */
  floor_seen: string | null;
  /** One version refused until the cp's desired version changes (design §2a). */
  refused: { version: string; reason: string } | null;
  last_apply_at: string | null;
};

export const EMPTY_STATE: UpdaterState = { current: null, previous: null, floor_seen: null, refused: null, last_apply_at: null };

export type Desired = { kind: "hold" } | { kind: "version"; version: string; releaseUrl: URL };

export type UpdaterFs = {
  readState(): Promise<UpdaterState | null>;
  /** Atomic (write a temp file, rename). */
  writeState(s: UpdaterState): Promise<void>;
  writeStaging(version: string, name: string, bytes: Uint8Array): Promise<void>;
  clearStaging(version: string): Promise<void>;
  /** Unpack a verified bundle into releases/<version>/ (root-owned, read-only in the real build). */
  unpack(version: string, bundle: Uint8Array): Promise<string>;
  /** Point `current` at releases/<version>/ atomically (a new link renamed over the old). */
  swapCurrent(version: string): Promise<void>;
  /** Remove every releases/<v>/ not named in `keep`. */
  prune(keep: string[]): Promise<void>;
};

export type Report = {
  outcome: "applied" | "rolled_back" | "failed" | "verify_refused";
  version: string;
  from: string | null;
  reason?: string;
};

export type UpdaterDeps = {
  env: Record<string, string | undefined>;
  /** GET /v1/box/desired with the box key (stub in the spike). Its answer is untrusted input. */
  getDesired(): Promise<unknown>;
  fetchBytes(url: URL): Promise<Uint8Array>;
  fs: UpdaterFs;
  /** Runs the bundle's installer as hermes from the release tree, plus the approvald root step. */
  install(version: string): Promise<{ ok: boolean }>;
  /** Signals the gateway's `while true; do hermes gateway run; ...` loop to restart on new code. */
  restartGateway(): Promise<void>;
  /** The soak: gateway pid stable, install-status clean, approvald answers, one hermes self-check. */
  healthCheck(version: string): Promise<{ ok: boolean; reason?: string }>;
  /** POST /v1/box/report (stub in the spike). A failed report never changes what was applied. */
  report(r: Report): Promise<void>;
  now(): Date;
  publicKeys: string[];
  allowedHosts: string[];
  updaterVersion?: string;
};

export type TickResult =
  | { outcome: "off" }
  | { outcome: "bad_reply" | "held" | "current" | "refused_version" | "rate_limited" | "download_failed" }
  | { outcome: "verify_refused"; reason: Refusal }
  | { outcome: "applied"; version: string }
  | { outcome: "rolled_back"; version: string; reason: string }
  | { outcome: "failed"; version: string; reason: string };

export function enabled(env: Record<string, string | undefined>): boolean {
  return env[FLAG] === "1";
}

/** The cp's reply, strictly: `{"hold":true}` or `{"version","release_url"}` and nothing else. */
export function parseDesired(value: unknown, allowedHosts: string[]): Desired | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys === "hold") return v.hold === true ? { kind: "hold" } : null;
  if (keys !== "release_url,version") return null;
  if (typeof v.version !== "string" || !VERSION_RE.test(v.version)) return null;
  if (typeof v.release_url !== "string" || v.release_url.length > 512) return null;
  let url: URL;
  try {
    url = new URL(v.release_url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) return null;
  if (!allowedHosts.includes(url.hostname)) return null;
  return { kind: "version", version: v.version, releaseUrl: url };
}

function fileUrl(base: URL, name: string): URL {
  const u = new URL(base.toString());
  u.pathname = u.pathname.replace(/\/?$/, "/") + name;
  return u;
}

async function safeReport(deps: UpdaterDeps, r: Report): Promise<void> {
  try {
    await deps.report(r);
  } catch {
    // The cp being unreachable never changes what the box runs.
  }
}

export async function tick(deps: UpdaterDeps): Promise<TickResult> {
  if (!enabled(deps.env)) return { outcome: "off" };
  const state: UpdaterState = { ...EMPTY_STATE, ...((await deps.fs.readState()) ?? {}) };

  let reply: unknown;
  try {
    reply = await deps.getDesired();
  } catch {
    return { outcome: "bad_reply" };
  }
  const desired = parseDesired(reply, deps.allowedHosts);
  if (!desired) return { outcome: "bad_reply" };
  if (desired.kind === "hold") return { outcome: "held" };
  const v = desired.version;
  if (state.refused && state.refused.version !== v) {
    state.refused = null; // the cp changed its desired version: the old refusal lapses
    await deps.fs.writeState(state);
  }
  if (v === state.current) return { outcome: "current" };
  if (state.refused?.version === v) return { outcome: "refused_version" };
  if (state.last_apply_at && deps.now().getTime() - Date.parse(state.last_apply_at) < MIN_APPLY_INTERVAL_MS) {
    return { outcome: "rate_limited" };
  }

  // 4. Download into staging.
  let manifestBytes: Uint8Array, sigBytes: Uint8Array, bundle: Uint8Array;
  try {
    manifestBytes = await deps.fetchBytes(fileUrl(desired.releaseUrl, `release-${v}.json`));
    sigBytes = await deps.fetchBytes(fileUrl(desired.releaseUrl, `release-${v}.json.sig`));
    bundle = await deps.fetchBytes(fileUrl(desired.releaseUrl, `bundle-${v}.tar.zst`));
    await deps.fs.writeStaging(v, `release-${v}.json`, manifestBytes);
    await deps.fs.writeStaging(v, `release-${v}.json.sig`, sigBytes);
    await deps.fs.writeStaging(v, `bundle-${v}.tar.zst`, bundle);
  } catch {
    await deps.fs.clearStaging(v).catch(() => {});
    return { outcome: "download_failed" };
  }

  // 5. Verify. A refusal is final for this desired version (no re-download every poll).
  const verdict = verifyRelease({
    manifestBytes,
    signature: Buffer.from(sigBytes).toString("utf8"),
    bundleBytes: bundle,
    publicKeys: deps.publicKeys,
    now: deps.now(),
    updaterVersion: deps.updaterVersion ?? UPDATER_VERSION,
    floorSeen: state.floor_seen,
    expectedVersion: v,
  });
  if (!verdict.ok) {
    await deps.fs.clearStaging(v).catch(() => {});
    state.refused = { version: v, reason: verdict.reason };
    await deps.fs.writeState(state);
    await safeReport(deps, { outcome: "verify_refused", version: v, from: state.current, reason: verdict.reason });
    return { outcome: "verify_refused", reason: verdict.reason };
  }

  // 6. Apply.
  const from = state.current;
  state.last_apply_at = deps.now().toISOString();
  await deps.fs.writeState(state);
  let failure: string | null = null;
  try {
    await deps.fs.unpack(v, bundle);
    await deps.fs.swapCurrent(v);
    const installed = await deps.install(v);
    if (!installed.ok) failure = "install_failed";
    else {
      await deps.restartGateway();
      const health = await deps.healthCheck(v);
      if (!health.ok) failure = `health:${health.reason ?? "failed"}`;
    }
  } catch {
    failure = failure ?? "apply_error";
  }
  await deps.fs.clearStaging(v).catch(() => {});

  if (!failure) {
    state.previous = from;
    state.current = v;
    const floor = verdict.manifest.floor_version;
    if (!state.floor_seen || compareVersions(floor, state.floor_seen) > 0) state.floor_seen = floor;
    state.refused = null;
    await deps.fs.writeState(state);
    await deps.fs.prune([v, from].filter((x): x is string => !!x).slice(0, KEEP_RELEASES)).catch(() => {});
    await safeReport(deps, { outcome: "applied", version: v, from });
    return { outcome: "applied", version: v };
  }

  // 7. Local rollback (per box, automatic; D2). Never changes the cohort's desired version.
  state.refused = { version: v, reason: failure };
  if (!from) {
    await deps.fs.writeState(state);
    await safeReport(deps, { outcome: "failed", version: v, from, reason: failure });
    return { outcome: "failed", version: v, reason: failure };
  }
  try {
    await deps.fs.swapCurrent(from);
    await deps.install(from);
    await deps.restartGateway();
  } catch {
    // Best effort: the previous tree is still on disk and `current` names it if the swap ran.
  }
  await deps.fs.writeState(state);
  await deps.fs.prune([from]).catch(() => {});
  await safeReport(deps, { outcome: "rolled_back", version: v, from, reason: failure });
  return { outcome: "rolled_back", version: v, reason: failure };
}

/** The poll loop: every POLL_MS ±50% jitter. Off = null, nothing scheduled. */
export function startUpdater(deps: UpdaterDeps, random: () => number = Math.random): { stop(): void } | null {
  if (!enabled(deps.env)) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tick(deps);
      } finally {
        schedule();
      }
    }, POLL_MS * (0.5 + random()));
  };
  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * The real filesystem under one root (design: /opt/av, state in /etc/av at 0600 root). Used only by
 * the spike's own tests in a temp dir; the real build would set owners and modes here.
 */
export function nodeUpdaterFs(root: string, statePath = join(root, "updater-state.json")): UpdaterFs {
  const releases = join(root, "releases");
  const staging = join(root, "staging");
  const safe = (v: string) => {
    if (!parseVersion(v)) throw new Error("bad version");
    return v;
  };
  return {
    async readState() {
      try {
        return JSON.parse(readFileSync(statePath, "utf8")) as UpdaterState;
      } catch {
        return null;
      }
    },
    async writeState(s) {
      const tmp = `${statePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
      renameSync(tmp, statePath);
    },
    async writeStaging(v, name, bytes) {
      const dir = join(staging, safe(v));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name.replace(/[/\\]/g, "_")), bytes);
    },
    async clearStaging(v) {
      rmSync(join(staging, safe(v)), { recursive: true, force: true });
    },
    async unpack(v, bundle) {
      const dest = join(releases, safe(v));
      const tmp = `${dest}.unpack-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      const tar = Bun.zstdDecompressSync(bundle);
      // git archive output only; --no-same-owner so the tree is owned by the unpacking user (root).
      const r = spawnSync("tar", ["-x", "--no-same-owner", "-C", tmp, "-f", "-"], { input: tar });
      if (r.status !== 0) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error("unpack failed");
      }
      rmSync(dest, { recursive: true, force: true });
      renameSync(tmp, dest);
      return dest;
    },
    async swapCurrent(v) {
      const target = join(releases, safe(v));
      if (!existsSync(target)) throw new Error("no such release");
      const link = join(root, "current");
      const tmp = `${link}.tmp-${process.pid}`;
      rmSync(tmp, { force: true });
      symlinkSync(target, tmp);
      renameSync(tmp, link);
    },
    async prune(keep) {
      if (!existsSync(releases)) return;
      for (const name of readdirSync(releases)) {
        if (!keep.includes(name)) rmSync(join(releases, name), { recursive: true, force: true });
      }
    },
  };
}
