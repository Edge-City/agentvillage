/**
 * FLEET-AT-SCALE spike (DARK): the box-side pull updater (scripts/fleet/av-updater.ts) with a
 * fake desired endpoint, fake downloads, a fake fs and a fake health check. Keys are generated in
 * memory per test; nothing is read from or written to the repository except one temp-dir run of
 * the real fs adapter.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease, type Built } from "../fleet/release-bundle";
import { EMPTY_STATE, nodeUpdaterFs, parseDesired, startUpdater, tick, type UpdaterDeps, type UpdaterFs, type UpdaterState } from "../fleet/av-updater";

const HOST = "releases.example.test";
const NOW = new Date("2026-10-19T12:00:00Z");

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const k = generateKeyPairSync("ed25519");
const PUB = k.publicKey.export({ type: "spki", format: "pem" }).toString();

/** Releases built from a throwaway repo, one commit per version. */
function releases(versions: string[], over: Record<string, string> = {}): Map<string, Built> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-upd-"));
  const out = new Map<string, Built>();
  try {
    git(dir, "init", "-q");
    for (const v of versions) {
      writeFileSync(join(dir, "VERSION"), v + "\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", v);
      out.set(v, buildRelease({
        repoDir: dir, commit: git(dir, "rev-parse", "HEAD"), version: v, floorVersion: over.floor ?? "v2.0.0",
        minUpdater: "v0.1.0", notBefore: "2026-10-19T00:00:00Z", expires: over.expires ?? "2026-11-02T00:00:00Z", signingKey: k.privateKey, level: 1,
      }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

type Calls = string[];

function fakeFs(calls: Calls, initial: UpdaterState | null): UpdaterFs & { state: UpdaterState | null; staging: Map<string, Uint8Array>; current: string | null; trees: Set<string> } {
  const f = {
    state: initial ? { ...initial } : null,
    staging: new Map<string, Uint8Array>(),
    current: initial?.current ?? null,
    trees: new Set<string>([initial?.current, initial?.previous].filter((x): x is string => !!x)),
    async readState() { calls.push("fs.readState"); return f.state ? { ...f.state } : null; },
    async writeState(s: UpdaterState) { calls.push("fs.writeState"); f.state = { ...s }; },
    async writeStaging(v: string, name: string, bytes: Uint8Array) { calls.push(`fs.stage:${name}`); f.staging.set(`${v}/${name}`, bytes); },
    async clearStaging(v: string) { calls.push(`fs.clearStaging:${v}`); for (const key of [...f.staging.keys()]) if (key.startsWith(v + "/")) f.staging.delete(key); },
    async unpack(v: string) { calls.push(`fs.unpack:${v}`); f.trees.add(v); return `/opt/av/releases/${v}`; },
    async swapCurrent(v: string) { calls.push(`fs.swap:${v}`); if (!f.trees.has(v)) throw new Error("no tree"); f.current = v; },
    async prune(keep: string[]) { calls.push(`fs.prune:${keep.join(",")}`); for (const t of [...f.trees]) if (!keep.includes(t)) f.trees.delete(t); },
  };
  return f;
}

function deps(opts: {
  env?: Record<string, string | undefined>;
  desired?: unknown;
  rel: Map<string, Built>;
  state?: UpdaterState | null;
  healthy?: (v: string) => boolean;
  installOk?: (v: string) => boolean;
  tamper?: (name: string, bytes: Uint8Array) => Uint8Array;
}) {
  const calls: Calls = [];
  const reports: unknown[] = [];
  const fs = fakeFs(calls, opts.state === undefined ? { ...EMPTY_STATE, current: "v2.1.3", previous: "v2.1.2" } : opts.state);
  const d: UpdaterDeps = {
    env: opts.env ?? { AV_PULL_UPDATER: "1" },
    async getDesired() { calls.push("getDesired"); return opts.desired; },
    async fetchBytes(url: URL) {
      calls.push(`fetch:${url.pathname}`);
      const name = url.pathname.split("/").pop()!;
      const v = /(v\d+\.\d+\.\d+(?:-rc\d+)?)/.exec(name)![1];
      const b = opts.rel.get(v);
      if (!b) throw new Error("404");
      const bytes = name.endsWith(".sig") ? Buffer.from(b.signature + "\n") : name.endsWith(".json") ? b.manifestBytes : b.bundle;
      return opts.tamper ? opts.tamper(name, bytes) : bytes;
    },
    fs,
    async install(v) { calls.push(`install:${v}`); return { ok: opts.installOk ? opts.installOk(v) : true }; },
    async restartGateway() { calls.push("restartGateway"); },
    async healthCheck(v) { calls.push(`health:${v}`); const ok = opts.healthy ? opts.healthy(v) : true; return ok ? { ok } : { ok, reason: "gateway_crash_loop" }; },
    async report(r) { calls.push(`report:${r.outcome}`); reports.push(r); },
    now: () => NOW,
    publicKeys: [PUB],
    allowedHosts: [HOST],
  };
  return { d, calls, reports, fs };
}

const want = (v: string) => ({ version: v, release_url: `https://${HOST}/agentvillage/${v}` });

describe("flag off", () => {
  test("AV_PULL_UPDATER unset, 0, true, ' 1': tick touches nothing and startUpdater schedules nothing", async () => {
    const rel = releases(["v2.1.4"]);
    for (const env of [{}, { AV_PULL_UPDATER: "0" }, { AV_PULL_UPDATER: "true" }, { AV_PULL_UPDATER: " 1" }, { AV_PULL_UPDATER: "" }]) {
      const { d, calls, reports } = deps({ env, desired: want("v2.1.4"), rel });
      expect(await tick(d)).toEqual({ outcome: "off" });
      expect(calls).toEqual([]);
      expect(reports).toEqual([]);
      expect(startUpdater(d)).toBeNull();
    }
  });
});

describe("apply", () => {
  test("downloads to staging, verifies, unpacks, swaps, installs, restarts, soaks, reports applied", async () => {
    const rel = releases(["v2.1.4"]);
    const { d, calls, reports, fs } = deps({ desired: want("v2.1.4"), rel });
    expect(await tick(d)).toEqual({ outcome: "applied", version: "v2.1.4" });
    expect(calls).toEqual([
      "fs.readState", "getDesired",
      "fetch:/agentvillage/v2.1.4/release-v2.1.4.json", "fetch:/agentvillage/v2.1.4/release-v2.1.4.json.sig", "fetch:/agentvillage/v2.1.4/bundle-v2.1.4.tar.zst",
      "fs.stage:release-v2.1.4.json", "fs.stage:release-v2.1.4.json.sig", "fs.stage:bundle-v2.1.4.tar.zst",
      "fs.writeState", "fs.unpack:v2.1.4", "fs.swap:v2.1.4", "install:v2.1.4", "restartGateway", "health:v2.1.4",
      "fs.clearStaging:v2.1.4", "fs.writeState", "fs.prune:v2.1.4,v2.1.3", "report:applied",
    ]);
    expect(fs.current).toBe("v2.1.4");
    expect(fs.state).toMatchObject({ current: "v2.1.4", previous: "v2.1.3", floor_seen: "v2.0.0", refused: null });
    expect([...fs.trees].sort()).toEqual(["v2.1.3", "v2.1.4"]);
    expect(reports).toEqual([{ outcome: "applied", version: "v2.1.4", from: "v2.1.3" }]);
  });

  test("already current, hold, and a second apply inside 10 minutes do nothing", async () => {
    const rel = releases(["v2.1.3", "v2.1.4"]);
    let r = deps({ desired: want("v2.1.3"), rel });
    expect(await tick(r.d)).toEqual({ outcome: "current" });
    r = deps({ desired: { hold: true }, rel });
    expect(await tick(r.d)).toEqual({ outcome: "held" });
    expect(r.calls).toEqual(["fs.readState", "getDesired"]);
    r = deps({ desired: want("v2.1.4"), rel, state: { ...EMPTY_STATE, current: "v2.1.3", last_apply_at: new Date(NOW.getTime() - 5 * 60_000).toISOString() } });
    expect(await tick(r.d)).toEqual({ outcome: "rate_limited" });
    expect(r.calls.some((c) => c.startsWith("fetch:"))).toBe(false);
  });
});

describe("health check fails: local rollback", () => {
  test("swaps back, re-installs the previous release, restarts, reports rolled_back, refuses that version", async () => {
    const rel = releases(["v2.1.4"]);
    const { d, calls, reports, fs } = deps({ desired: want("v2.1.4"), rel, healthy: (v) => v !== "v2.1.4" });
    expect(await tick(d)).toEqual({ outcome: "rolled_back", version: "v2.1.4", reason: "health:gateway_crash_loop" });
    expect(calls.slice(calls.indexOf("health:v2.1.4"))).toEqual([
      "health:v2.1.4", "fs.clearStaging:v2.1.4", "fs.swap:v2.1.3", "install:v2.1.3", "restartGateway", "fs.writeState", "fs.prune:v2.1.3", "report:rolled_back",
    ]);
    expect(fs.current).toBe("v2.1.3");
    expect(fs.state).toMatchObject({ current: "v2.1.3", refused: { version: "v2.1.4", reason: "health:gateway_crash_loop" } });
    expect(reports).toEqual([{ outcome: "rolled_back", version: "v2.1.4", from: "v2.1.3", reason: "health:gateway_crash_loop" }]);
    // The next poll with the same desired version refuses it without downloading.
    const calls2: string[] = [];
    const d2 = { ...d, getDesired: async () => { calls2.push("getDesired"); return want("v2.1.4"); }, now: () => new Date(NOW.getTime() + 3600_000) };
    expect(await tick(d2)).toEqual({ outcome: "refused_version" });
    expect(calls2).toEqual(["getDesired"]);
  });

  test("an install failure rolls back too; a later different desired version clears the refusal", async () => {
    const rel = releases(["v2.1.4", "v2.1.5"]);
    const r = deps({ desired: want("v2.1.4"), rel, installOk: (v) => v !== "v2.1.4" });
    expect(await tick(r.d)).toMatchObject({ outcome: "rolled_back", reason: "install_failed" });
    expect(r.calls).not.toContain("health:v2.1.4");
    const later = { ...r.d, getDesired: async () => want("v2.1.5"), now: () => new Date(NOW.getTime() + 3600_000) };
    expect(await tick(later)).toEqual({ outcome: "applied", version: "v2.1.5" });
    expect(r.fs.state).toMatchObject({ current: "v2.1.5", previous: "v2.1.3", refused: null });
  });

  test("a first install that fails has nothing to roll back to: reports failed", async () => {
    const rel = releases(["v2.1.4"]);
    const r = deps({ desired: want("v2.1.4"), rel, state: null, healthy: () => false });
    expect(await tick(r.d)).toMatchObject({ outcome: "failed", version: "v2.1.4" });
  });
});

describe("refusals before anything is applied", () => {
  test("a tampered bundle is refused, staging cleared, nothing unpacked or installed", async () => {
    const rel = releases(["v2.1.4"]);
    const r = deps({ desired: want("v2.1.4"), rel, tamper: (name, b) => (name.endsWith(".zst") ? Buffer.concat([Buffer.from(b).subarray(0, b.length - 1), Buffer.from([b[b.length - 1] ^ 1])]) : b) });
    expect(await tick(r.d)).toEqual({ outcome: "verify_refused", reason: "sha256_mismatch" });
    expect(r.calls.filter((c) => /unpack|swap|install|restart|health/.test(c))).toEqual([]);
    expect(r.fs.staging.size).toBe(0);
    expect(r.fs.current).toBe("v2.1.3");
    expect(r.reports).toEqual([{ outcome: "verify_refused", version: "v2.1.4", from: "v2.1.3", reason: "sha256_mismatch" }]);
  });

  test("a release signed by another key is refused", async () => {
    const rel = releases(["v2.1.4"]);
    const r = deps({ desired: want("v2.1.4"), rel });
    r.d.publicKeys = [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()];
    expect(await tick(r.d)).toEqual({ outcome: "verify_refused", reason: "signature_invalid" });
  });

  test("an expired release is refused", async () => {
    const rel = releases(["v2.1.4"], { expires: "2026-10-19T06:00:00Z" });
    const r = deps({ desired: want("v2.1.4"), rel });
    expect(await tick(r.d)).toEqual({ outcome: "verify_refused", reason: "expired" });
  });

  test("a replayed older release below the box's applied floor is refused", async () => {
    const rel = releases(["v2.0.5"]);
    const r = deps({ desired: want("v2.0.5"), rel, state: { ...EMPTY_STATE, current: "v2.1.3", previous: "v2.1.2", floor_seen: "v2.1.0" } });
    expect(await tick(r.d)).toEqual({ outcome: "verify_refused", reason: "below_floor" });
  });

  test("the cp's reply is a strict schema: extra keys, other hosts, http, credentials, a command field are all bad_reply", async () => {
    const rel = releases(["v2.1.4"]);
    const bad = [
      null, "v2.1.4", [], { version: "v2.1.4" }, { ...want("v2.1.4"), cmd: "curl x | sh" },
      { version: "v2.1.4; rm -rf /", release_url: want("v2.1.4").release_url },
      { version: "v2.1.4", release_url: "https://evil.example/agentvillage/v2.1.4" },
      { version: "v2.1.4", release_url: `http://${HOST}/agentvillage/v2.1.4` },
      { version: "v2.1.4", release_url: `https://u:p@${HOST}/agentvillage/v2.1.4` },
      { version: "v2.1.4", release_url: `https://${HOST}:8443/agentvillage/v2.1.4` },
      { version: "v2.1.4", release_url: `https://${HOST}/agentvillage/v2.1.4?x=1` },
      { hold: "yes" }, { hold: true, version: "v2.1.4" },
    ];
    for (const desired of bad) {
      const r = deps({ desired, rel });
      expect(await tick(r.d)).toEqual({ outcome: "bad_reply" });
      expect(r.calls).toEqual(["fs.readState", "getDesired"]);
    }
    expect(parseDesired(want("v2.1.4"), [HOST])).toMatchObject({ kind: "version", version: "v2.1.4" });
  });

  test("the cp unreachable: the box keeps what it has", async () => {
    const rel = releases(["v2.1.4"]);
    const r = deps({ desired: want("v2.1.4"), rel });
    r.d.getDesired = async () => { throw new Error("ECONNREFUSED"); };
    expect(await tick(r.d)).toEqual({ outcome: "bad_reply" });
    expect(r.fs.current).toBe("v2.1.3");
  });
});

describe("real fs adapter (temp dir only)", () => {
  test("unpacks a verified bundle, swaps the current link atomically, prunes to two", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-root-"));
    try {
      const rel = releases(["v2.1.4", "v2.1.5", "v2.1.6"]);
      const fs = nodeUpdaterFs(root);
      for (const v of ["v2.1.4", "v2.1.5", "v2.1.6"]) {
        const dest = await fs.unpack(v, rel.get(v)!.bundle);
        expect(readFileSync(join(dest, "VERSION"), "utf8")).toBe(v + "\n");
        await fs.swapCurrent(v);
        expect(readlinkSync(join(root, "current"))).toBe(join(root, "releases", v));
      }
      await fs.prune(["v2.1.6", "v2.1.5"]);
      expect(existsSync(join(root, "releases", "v2.1.4"))).toBe(false);
      expect(existsSync(join(root, "releases", "v2.1.5"))).toBe(true);
      await fs.writeState({ ...EMPTY_STATE, current: "v2.1.6" });
      expect((await fs.readState())?.current).toBe("v2.1.6");
      await expect(fs.swapCurrent("../../etc")).rejects.toThrow();
      await expect(fs.swapCurrent("v9.9.9")).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
