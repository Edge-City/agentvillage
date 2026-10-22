/**
 * U-1a (ONBOARDING-WELCOME-spec, "Revision after F1 + F2"): the `--draft`
 * trailer of an unreachable welcome says why, behind AV_WELCOME_REASON.
 *
 *   bun test skills/index-network/scripts/tests/welcome-reason.test.ts
 *
 * With the switch on, the unreachable branch's trailer ends with `reason`, one
 * of `no_key | list_failed | bad_answer` (codes only); no other branch ever
 * carries it. With the switch off (unset, or anything but `1`) every trailer
 * is byte-identical to fixtures/welcome-trailers-today.json, the lines
 * origin/main printed before U-1a. The welcome text itself never changes
 * (fixtures/welcome-texts.json).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IndexMcpError } from "../index-mcp";
// A namespace import, so the switch-off block also runs against a welcome.ts from before U-1a.
import * as W from "../welcome";
import { FAKE_API_KEY, type ToolHandler, indexMcpFake } from "./index-mcp-fake";
import { failureInputs } from "./index-failure-inputs";
import golden from "./fixtures/welcome-texts.json";
import today from "./fixtures/welcome-trailers-today.json";

const SCRIPT = join(import.meta.dir, "..", "welcome.ts");
const VARS = ["INDEX_API_KEY", "INDEX_MCP_URL", "AV_CONNECTIONS_URL", "HERMES_HOME", "AV_WELCOME_REASON", "AV_SEED_TRAILER_V2", "AV_WELCOME_SEED_MODE"];
const saved: Record<string, string | undefined> = {};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-welcome-reason-"));
  for (const key of VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function intentsText(rows: unknown[]): string {
  return `Your signals:\n\n${JSON.stringify({ success: true, intents: rows, pagination: { limit: 20, offset: 0, count: rows.length } }, null, 2)}`;
}
const intent = (summary: string, n: number) => ({
  id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
  summary,
  status: "active",
  url: `https://index.network/i/aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
});
const TWO = [intent("Looking for people building agent memory", 1), intent("Open to co-hosting a village dinner", 2)];

const writeContext = () =>
  writeFileSync(join(home, "USER.md"), "# Profile\n\n## Context supplied by the participant\n\n### Pasted notes\nBuilding agent memory; keen to meet researchers.\n");

/** main() with `--draft` and captured streams; `handler` null: no key (no call). */
async function draft(handler: ToolHandler | null, argv: string[] = ["--draft"]) {
  const fake = indexMcpFake({ tools: { list_intents: handler ?? (() => intentsText([])) } });
  process.env.INDEX_API_KEY = handler === null ? "" : FAKE_API_KEY;
  process.env.INDEX_MCP_URL = fake.url;
  const out = { stdout: "", stderr: "" };
  await W.main(["--home", home, ...argv], { stdout: (x) => (out.stdout += x), stderr: (x) => (out.stderr += x) }, (a) =>
    W.welcomeRun(a, { fetch: fake.fetch, timeoutMs: 50 }),
  );
  return { ...out, calls: fake.calls.length };
}

const http503: ToolHandler = () => ({ response: new Response("down", { status: 503 }) });
const timeout: ToolHandler = () => ({ hang: true });
const rpcError: ToolHandler = (_args, request) => ({ response: Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "internal" } }) });
const notComplete: ToolHandler = () => ({ result: { resultType: "input_required", content: [{ type: "text", text: intentsText([]) }] } });
const noJson: ToolHandler = () => "no json at all";

/** Every unreachable cause this file drives, with the reason it must carry. */
const UNREACHABLE_CASES: Array<[string, ToolHandler | null, "no_key" | "list_failed" | "bad_answer"]> = [
  ["no key", null, "no_key"],
  ["an HTTP 503", http503, "list_failed"],
  ["a timeout", timeout, "list_failed"],
  ["a JSON-RPC error", rpcError, "list_failed"],
  ["a result that is not complete", notComplete, "bad_answer"],
  ["a text with no JSON", noJson, "bad_answer"],
  ...failureInputs("intents").map(
    (input): [string, ToolHandler, "list_failed" | "bad_answer"] => [input.label, input.handler, input.code === "mcp-tool-error" ? "list_failed" : "bad_answer"],
  ),
];

const withReason = (line: string, reason: string) => `${line.slice(0, -1)},"reason":"${reason}"}`;

describe("switch off (AV_WELCOME_REASON unset or not 1): every trailer is byte-identical to today's", () => {
  for (const [label, handler] of UNREACHABLE_CASES) {
    test(`unreachable, ${label}: today's line, today's text`, async () => {
      const out = await draft(handler);
      expect(out.stdout).toBe(`${golden.unreachable}\n`);
      expect(out.stderr).toBe(`${today.unreachable}\n`);
    });
  }

  test("each listed branch: today's line", async () => {
    expect((await draft(() => intentsText(TWO))).stderr).toBe(`${today.two}\n`);
    expect((await draft(() => intentsText([]))).stderr).toBe(`${today.zero}\n`);
    writeContext();
    expect((await draft(() => intentsText([]))).stderr).toBe(`${today.context}\n`);
  });

  for (const value of ["0", "true", "yes", " ", "", "11"]) {
    test(`AV_WELCOME_REASON=${JSON.stringify(value)} (environment or .env) is off`, async () => {
      process.env.AV_WELCOME_REASON = value;
      expect((await draft(null)).stderr).toBe(`${today.unreachable}\n`);
      delete process.env.AV_WELCOME_REASON;
      writeFileSync(join(home, ".env"), `AV_WELCOME_REASON=${value}\n`);
      expect((await draft(http503)).stderr).toBe(`${today.unreachable}\n`);
    });
  }

  test("AV_SEED_TRAILER_V2 on, AV_WELCOME_REASON off: still no reason", async () => {
    process.env.AV_SEED_TRAILER_V2 = "1";
    expect((await draft(null)).stderr).toBe(`${today.unreachable}\n`);
  });

  test("without --draft nothing is on stderr, as today", async () => {
    expect(await draft(null, [])).toEqual({ stdout: `${golden.unreachable}\n`, stderr: "", calls: 0 });
  });
});

describe("switch on (AV_WELCOME_REASON=1): the unreachable trailer ends with why", () => {
  for (const [label, handler, reason] of UNREACHABLE_CASES) {
    test(`unreachable, ${label}: reason ${reason}, last; the text unchanged`, async () => {
      process.env.AV_WELCOME_REASON = "1";
      const out = await draft(handler);
      expect(out.stdout).toBe(`${golden.unreachable}\n`);
      expect(out.stderr).toBe(`${withReason(today.unreachable, reason)}\n`);
      const parsed = JSON.parse(out.stderr);
      expect(Object.keys(parsed)).toEqual(["welcome", "fallback", "intents_listed", "intents_seeded", "seed_failed", "reason"]);
      if (handler === null) expect(out.calls).toBe(0);
    });
  }

  test("a new resident's FIRST read carries Index's onboarding paragraph after the object (Index ec439c4b): listed, never bad_answer", async () => {
    process.env.AV_WELCOME_REASON = "1";
    const onboarding = "This is the first time they've connected me, so onboard them now:\n1. Tell them how I work.\n2. Call get_my_profile and list_intents.";
    const zero = await draft(() => `No intents.\n\n${JSON.stringify({ success: true, intents: [], pagination: { limit: 20, offset: 0, count: 0 } })}\n\n${onboarding}`);
    expect(zero.stderr).toBe(`${today.zero}\n`);
    expect(zero.stdout).not.toBe(`${golden.unreachable}\n`);
    const two = await draft(() => `${intentsText(TWO)}\n\n${onboarding}`);
    expect(two.stderr).toBe(`${today.two}\n`);
    writeContext();
    expect((await draft(() => `${intentsText([])}\n\n${onboarding}`)).stderr).toBe(`${today.context}\n`);
  });

  test("no key gives no_key and nothing else (never list_failed or bad_answer)", async () => {
    process.env.AV_WELCOME_REASON = "1";
    const out = await draft(null);
    expect(JSON.parse(out.stderr).reason).toBe("no_key");
    expect(out.calls).toBe(0);
  });

  test("read from $HERMES_HOME/.env when the environment does not set it", async () => {
    writeFileSync(join(home, ".env"), "AV_WELCOME_REASON=1\n");
    expect((await draft(null)).stderr).toBe(`${withReason(today.unreachable, "no_key")}\n`);
    expect((await draft(noJson)).stderr).toBe(`${withReason(today.unreachable, "bad_answer")}\n`);
  });

  test("no other branch ever carries reason: listed, questions, context are today's lines", async () => {
    process.env.AV_WELCOME_REASON = "1";
    process.env.AV_SEED_TRAILER_V2 = "1";
    const two = await draft(() => intentsText(TWO));
    expect(two).toEqual({ stdout: `${golden.two}\n`, stderr: `${today.two}\n`, calls: 1 });
    expect((await draft(() => intentsText([]))).stderr).toBe(`${today.zero}\n`);
    writeContext();
    expect((await draft(() => intentsText([]))).stderr).toBe(`${today.context}\n`);
  });

  test("a run that threw: the unreachable text and today's line, never a reason (script_failed is the control plane's)", async () => {
    process.env.AV_WELCOME_REASON = "1";
    const out = { stdout: "", stderr: "" };
    await W.main(["--home", home, "--draft"], { stdout: (x) => (out.stdout += x), stderr: (x) => (out.stderr += x) }, async () => {
      throw new Error("boom");
    });
    expect(out).toEqual({ stdout: `${golden.unreachable}\n`, stderr: `${today.unreachable}\n` });
    expect(out.stderr).not.toContain("script_failed");
  });

  test("the trailer never carries text: only the code", async () => {
    process.env.AV_WELCOME_REASON = "1";
    for (const [, handler] of UNREACHABLE_CASES) {
      const { stderr } = await draft(handler);
      expect(JSON.parse(stderr).reason).toMatch(/^(no_key|list_failed|bad_answer)$/);
      for (const word of ["mcp-", "down", "internal", "boom", "http", FAKE_API_KEY]) expect(stderr).not.toContain(word);
    }
  });

  test("the script, as a process, with AV_WELCOME_REASON=1 in $HERMES_HOME/.env and no key: reason no_key on stderr", async () => {
    writeFileSync(join(home, ".env"), "AV_WELCOME_REASON=1\n");
    const env = { ...process.env, HERMES_HOME: home, INDEX_API_KEY: "", INDEX_MCP_URL: "http://127.0.0.1:9/mcp", AV_CONNECTIONS_URL: "" };
    const proc = Bun.spawn(["bun", SCRIPT, "--draft"], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: `${golden.unreachable}\n`, stderr: `${withReason(today.unreachable, "no_key")}\n` });
  });
});

describe("the pieces", () => {
  test("unreachableReason: what Index could not be asked or did not answer is list_failed; an answer that could not be read is bad_answer", () => {
    for (const code of ["mcp-unreachable", "mcp-http-503", "mcp-http-400:-32022", "mcp-rpc-error", "mcp-rpc-error:-32603", "mcp-tool-error"]) {
      expect({ code, reason: W.unreachableReason(new IndexMcpError(code)) }).toEqual({ code, reason: "list_failed" });
    }
    for (const code of ["mcp-bad-response", "mcp-result-type", "mcp-unparsed"]) {
      expect({ code, reason: W.unreachableReason(new IndexMcpError(code)) }).toEqual({ code, reason: "bad_answer" });
    }
    expect(W.unreachableReason(new TypeError("x"))).toBe("bad_answer");
    expect(W.unreachableReason("x")).toBe("bad_answer");
    expect([...W.UNREACHABLE_REASONS]).toEqual(["no_key", "list_failed", "bad_answer"]);
  });

  test("welcomeBranch carries reason on the unreachable branch only", () => {
    expect(W.welcomeBranch({ kind: "unreachable", reason: "no_key" })).toEqual({ fallback: "unreachable", intents_listed: 0, intents_seeded: 0, seed_failed: 0, reason: "no_key" });
    expect(W.welcomeBranch({ kind: "unreachable" })).toEqual({ fallback: "unreachable", intents_listed: 0, intents_seeded: 0, seed_failed: 0 });
    for (const read of [
      { kind: "listed", titles: [] },
      { kind: "listed", titles: ["a"] },
    ] as const) {
      for (const context of [false, true]) expect("reason" in W.welcomeBranch({ ...read, titles: [...read.titles] }, undefined, context)).toBe(false);
    }
  });

  test("draftTrailer: reason only with the switch, only on unreachable, only a known code, always last", () => {
    const S0 = { intents_seeded: 0, seed_failed: 0 };
    const un = { fallback: "unreachable" as const, intents_listed: 0, ...S0, reason: "list_failed" as const };
    expect(W.draftTrailer(un)).toBe(today.unreachable);
    expect(W.draftTrailer(un, true)).toBe(today.unreachable);
    expect(W.draftTrailer(un, false, false)).toBe(today.unreachable);
    expect(W.draftTrailer(un, false, true)).toBe(withReason(today.unreachable, "list_failed"));
    // Never on another branch, even when a branch somehow carries one.
    for (const fallback of ["none", "questions", "context"] as const) {
      const listed = fallback === "none" ? 2 : 0;
      const line = W.draftTrailer({ fallback, intents_listed: listed, ...S0, reason: "no_key" }, true, true);
      expect(line).not.toContain("reason");
      expect(line).toBe(W.draftTrailer({ fallback, intents_listed: listed, ...S0 }));
    }
    // A code outside the closed set is never printed.
    expect(W.draftTrailer({ ...un, reason: "script_failed" as unknown as "no_key" }, false, true)).toBe(today.unreachable);
    // After the v2 keys.
    const v2 = W.draftTrailer({ ...un, seed_codes: ["create-timeout"] }, true, true);
    expect(Object.keys(JSON.parse(v2))).toEqual(["welcome", "fallback", "intents_listed", "intents_seeded", "seed_failed", "seed_codes", "reason"]);
  });

  test("welcomeReasonOn: exactly 1, from the environment else $HERMES_HOME/.env", () => {
    expect(W.welcomeReasonOn(home)).toBe(false);
    writeFileSync(join(home, ".env"), "AV_WELCOME_REASON=1\n");
    expect(W.welcomeReasonOn(home)).toBe(true);
    process.env.AV_WELCOME_REASON = "0";
    expect(W.welcomeReasonOn(home)).toBe(false);
    process.env.AV_WELCOME_REASON = " 1 ";
    expect(W.welcomeReasonOn(home)).toBe(true);
  });
});
