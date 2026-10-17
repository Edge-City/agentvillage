/**
 * Lead L9870: the managed loader's startup catch names its error. A failing `startResident` prints one
 * stderr JSON line (`error_name`, a bounded `error_message`, `stage`, and `code` / `http_status` when
 * the error carries them) and exits 1; never the stack, the error object, the environment or the
 * config. Everything else in the loader (marker, imports, config read, the `startResident` call, the
 * ready line and the signal handlers) is byte for byte the lifecycle-2 loader the control plane
 * already owns (moralmod-box.py `LEGACY_LOADER_SOURCES`).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedLoaderSource } from "../moralmod_host";

const DIGEST = "c".repeat(64);
const SECRET = "test-only-resident-credential-" + "z".repeat(16);

/** The lifecycle-2 loader as rc44 and earlier wrote it (the control plane's legacy bytes). */
function legacyLoader(home: string, directory: string): string {
  return `// Managed MoralMod lifecycle 2; see index/moralmod/active.json.\nimport {readFileSync} from 'node:fs';\nimport {startResident} from ${JSON.stringify(join(directory, "negotiator-runtime.js"))};\nconst config=JSON.parse(readFileSync(${JSON.stringify(join(home, "index/moralmod/resident.json"))},'utf8'));\ntry {\n const resident=await startResident({...process.env,...config,DECISION_JOURNAL_PATH:${JSON.stringify(join(home, "index/moralmod/fallback.sqlite"))}});\n const stop=()=>void resident.stop().finally(()=>process.exit(0));\n process.on('SIGTERM',stop);process.on('SIGINT',stop);\n console.log(JSON.stringify({ready:true,port:resident.port}));\n} catch { console.error(JSON.stringify({level:'warn',event:'moralmod_startup_unready'}));process.exit(1); }\n`;
}

let home: string;
let directory: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mm-loader-diag-"));
  directory = join(home, "index", "moralmod", DIGEST);
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(home, "plugins", "index-network", "runtime", "dist"), { recursive: true });
  writeFileSync(join(home, "index", "moralmod", "resident.json"), JSON.stringify({ VILLAGE_INSTALLATION_CREDENTIAL: SECRET }), { mode: 0o600 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run the generated loader against a stand-in release runtime whose `startResident` is `body`. */
function runLoader(body: string) {
  writeFileSync(join(directory, "negotiator-runtime.js"), `export async function startResident(env){\n${body}\n}\n`);
  const loader = join(home, "plugins", "index-network", "runtime", "dist", "negotiator.js");
  writeFileSync(loader, managedLoaderSource(home, directory));
  const result = Bun.spawnSync([process.execPath, loader], {
    env: { PATH: process.env.PATH ?? "", HOME: home, OTHER_PRIVATE_SETTING: SECRET },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** The one stderr line, parsed; also checks nothing private or stack-shaped is in it. */
function diagnostic(run: ReturnType<typeof runLoader>): Record<string, unknown> {
  expect(run.exitCode).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr.endsWith("\n")).toBe(true);
  expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(run.stderr).not.toContain("stack");
  expect(run.stderr).not.toContain("negotiator-runtime.js");
  expect(run.stderr).not.toMatch(/\bat .*:\d+:\d+/);
  expect(run.stderr).not.toContain(SECRET);
  expect(run.stderr).not.toContain(home);
  return JSON.parse(run.stderr);
}

test("a thrown Error with code and status: error_name, a 200-char single-line message, stage, code, http_status; no stack; exit 1", () => {
  const run = runLoader(
    `const e = new TypeError(${JSON.stringify("decision service refused\n\tthe enrollment " + "x".repeat(1000))});\n` +
      `e.code = "moralmod_enrollment_refused"; e.status = 503; e.config = env; throw e;`,
  );
  const line = diagnostic(run);
  expect(Object.keys(line)).toEqual(["level", "event", "error_name", "error_message", "stage", "code", "http_status"]);
  expect(line).toMatchObject({ level: "warn", event: "moralmod_startup_unready", error_name: "TypeError", stage: "startup", code: "moralmod_enrollment_refused", http_status: 503 });
  const message = line.error_message as string;
  expect(message).toHaveLength(200);
  expect(message.startsWith("decision service refused the enrollment xxx")).toBe(true);
  expect(message).not.toMatch(/[\r\n\t]/);
});

test("error_message is masked: a bearer token, a 64-hex secret, a uuid, key=/token=/credential= values, URL userinfo and a token query never reach the line; the placeholders do", () => {
  const bearer = "eyJhbGciOiJIUzI1NiJ9.payload-part.sig_part";
  const hex = "0123456789abcdef".repeat(4);
  const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const queryToken = "qt-" + "Q".repeat(20);
  const password = "hunter2-" + "p".repeat(8);
  const message =
    `POST failed: Authorization Bearer ${bearer}\nsecret ${hex} for experiment ${uuid}; ` +
    `retry https://admin:${password}@decision.example/v1/enroll?token=${queryToken}&experiment=${uuid} ` +
    `api_key=${SECRET}&mode=x CREDENTIAL=${SECRET}`;
  const run = runLoader(`const e = new Error(${JSON.stringify(message)}); e.code = "decision_http"; e.status = 401; throw e;`);
  const line = diagnostic(run);
  expect(line).toMatchObject({ level: "warn", event: "moralmod_startup_unready", error_name: "Error", stage: "startup", code: "decision_http", http_status: 401 });
  for (const raw of [bearer, "payload-part", hex, uuid, queryToken, password, "admin:", SECRET]) expect(run.stderr).not.toContain(raw);
  const masked = line.error_message as string;
  expect(masked.length).toBeLessThanOrEqual(200);
  expect(masked).toBe(
    "POST failed: Authorization Bearer <redacted> secret <hex> for experiment <uuid>; retry https://<redacted>@decision.example/v1/enroll?<redacted> api_key=<redacted>&mode=x CREDENTIAL=<redacted>",
  );
});

test("each mask on its own: secret=, password=, a bare 32-hex run and a query after a path", () => {
  const run = runLoader(
    `throw new Error("secret=abc&x=1 password=pw1 id ${"A".repeat(32)} at https://cp.example/v1/claims?sig=zzz done");`,
  );
  expect((diagnostic(run).error_message as string)).toBe("secret=<redacted>&x=1 password=<redacted> id <hex> at https://cp.example/v1/claims?<redacted> done");
});

test("a numeric code and http_status (no status) are kept; a 1,000-char name is cut to 64", () => {
  const run = runLoader(`const e = new Error("bad gateway"); e.name = "N".repeat(1000); e.code = 42; e.http_status = 502; throw e;`);
  const line = diagnostic(run);
  expect(line).toEqual({ level: "warn", event: "moralmod_startup_unready", error_name: "N".repeat(64), error_message: "bad gateway", stage: "startup", code: 42, http_status: 502 });
});

test("code and status that are not a string or a finite number are left out; the error object is never printed", () => {
  const run = runLoader(`const e = new RangeError("out of range"); e.code = { secret: env.VILLAGE_INSTALLATION_CREDENTIAL }; e.status = "503"; throw e;`);
  expect(diagnostic(run)).toEqual({ level: "warn", event: "moralmod_startup_unready", error_name: "RangeError", error_message: "out of range", stage: "startup" });
});

test("non-Error throws: a string names String, null and an anonymous object say unknown", () => {
  expect(diagnostic(runLoader(`throw "plain failure";`))).toEqual({ level: "warn", event: "moralmod_startup_unready", error_name: "String", error_message: "plain failure", stage: "startup" });
  expect(diagnostic(runLoader(`throw null;`))).toEqual({ level: "warn", event: "moralmod_startup_unready", error_name: "unknown", error_message: "null", stage: "startup" });
  expect(diagnostic(runLoader(`throw Object.assign(Object.create(null), { message: "no prototype" });`))).toEqual({ level: "warn", event: "moralmod_startup_unready", error_name: "unknown", error_message: "no prototype", stage: "startup" });
});

test("an error whose fields throw while being read still leaves the bare event with its stage, and exits 1", () => {
  const run = runLoader(`throw { get name() { throw Error("hostile name"); }, message: "never read" };`);
  expect(diagnostic(run)).toEqual({ level: "warn", event: "moralmod_startup_unready", stage: "startup" });
  const unprintable = runLoader(`throw Object.create(null);`);
  expect(diagnostic(unprintable)).toEqual({ level: "warn", event: "moralmod_startup_unready", stage: "startup" });
});

test("a resident that starts still prints the ready line and exits through stop", () => {
  const run = runLoader(`return { port: 4123, stop: async () => {} };`);
  expect(run.stderr).toBe("");
  expect(run.stdout).toBe('{"ready":true,"port":4123}\n');
  expect(run.exitCode).toBe(0);
});

test("only the catch changed: the marker, imports, config read and startResident call (up to `try {`) and the stop, signal and ready lines are byte for byte the lifecycle-2 loader", () => {
  const source = managedLoaderSource(home, directory);
  const legacy = legacyLoader(home, directory);
  const tryAt = source.indexOf("try {\n") + "try {\n".length;
  expect(source.slice(0, tryAt)).toBe(legacy.slice(0, legacy.indexOf("try {\n") + "try {\n".length));
  expect(source.startsWith("// Managed MoralMod lifecycle 2; see index/moralmod/active.json.\n")).toBe(true);
  const segment = (text: string) => text.slice(text.indexOf(" const stop="), text.indexOf("} catch"));
  expect(segment(source)).toBe(segment(legacy));
  expect(segment(source)).toBe(" const stop=()=>void resident.stop().finally(()=>process.exit(0));\n process.on('SIGTERM',stop);process.on('SIGINT',stop);\n console.log(JSON.stringify({ready:true,port:resident.port}));\n");
  // Everything before the catch is the legacy loader; the catch is still the last line.
  expect(source.slice(0, source.indexOf("} catch"))).toBe(legacy.slice(0, legacy.indexOf("} catch")));
  expect(source.endsWith("console.error(JSON.stringify(d));process.exit(1); }\n")).toBe(true);
  expect(source.split("\n").filter((l) => l.startsWith("} catch"))).toHaveLength(1);
  expect(source).not.toBe(legacy);
});
