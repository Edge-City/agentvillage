import { test, expect } from "bun:test";

import {
  DAILY_LOOP_CRON_SPECS,
  DIGEST_CRON_SPECS,
  buildIndexMcpHeaders,
  dailyLoopCronsEnabled,
  cronCreateArgs,
  cronEditArgs,
  fnv1a,
  isValidCron,
  resolveCronSchedule,
  staggeredSchedule,
  storedSchedule,
} from "../install_index";

test("three digest cron specs: signals (01:00), prepare (02:00, no deliver), send (08:00, deliver telegram)", () => {
  expect(DIGEST_CRON_SPECS).toHaveLength(3);
  const [signals, prepare, send] = DIGEST_CRON_SPECS;
  expect(signals.schedule).toBe("0 1 * * *");
  expect(signals.name).toBe("Edge — memory signal sync");
  expect(signals.promptFile).toBe("memory-signals.md");
  expect(signals.deliver).toBe(false);
  expect(prepare.schedule).toBe("0 2 * * *");
  expect(prepare.name).toBe("Edge — digest prepare");
  expect(prepare.promptFile).toBe("prepare.md");
  expect(prepare.deliver).toBe(false);
  expect(send.schedule).toBe("0 8 * * *");
  expect(send.name).toBe("Edge — daily digest");
  expect(send.promptFile).toBe("send.md");
  expect(send.deliver).toBe(true);
});

test("daily-loop crons are separate canary non-brief evaluation wakeups", () => {
  expect(DAILY_LOOP_CRON_SPECS).toHaveLength(2);
  const [prepare, send] = DAILY_LOOP_CRON_SPECS;

  expect(prepare.schedule).toBe("0 14,17,20 * * *");
  expect(prepare.name).toBe("Edge — daily loop prepare");
  expect(prepare.promptFile).toBe("daily-loop-prepare.md");
  expect(prepare.deliver).toBe(false);
  expect(prepare.overrideFlag).toBe("--daily-loop-prepare-cron");
  expect(prepare.overrideEnv).toBe("DAILY_LOOP_PREPARE_CRON");

  expect(send.schedule).toBe("0 15,18,21 * * *");
  expect(send.name).toBe("Edge — daily loop send");
  expect(send.promptFile).toBe("daily-loop-send.md");
  expect(send.deliver).toBe(true);
  expect(send.overrideFlag).toBe("--daily-loop-send-cron");
  expect(send.overrideEnv).toBe("DAILY_LOOP_SEND_CRON");
});

test("daily loop cron args are separate from unchanged digest prepare/send crons", () => {
  const home = "/home/x/.hermes";
  const [prepare, send] = DAILY_LOOP_CRON_SPECS;

  expect(cronCreateArgs(prepare, "DAILY_LOOP_PREPARE", home)).toEqual([
    "cron", "create", "0 14,17,20 * * *", "DAILY_LOOP_PREPARE",
    "--name", "Edge — daily loop prepare", "--workdir", home,
  ]);

  expect(cronCreateArgs(send, "DAILY_LOOP_SEND", home)).toEqual([
    "cron", "create", "0 15,18,21 * * *", "DAILY_LOOP_SEND",
    "--name", "Edge — daily loop send", "--deliver", "telegram", "--workdir", home,
  ]);
});

test("signals/prepare cron args omit --deliver; send cron args include --deliver telegram", () => {
  const home = "/home/x/.hermes";
  const [signals, prepare, send] = DIGEST_CRON_SPECS;

  expect(cronCreateArgs(signals, "SIGNALS_BODY", home)).toEqual([
    "cron", "create", "0 1 * * *", "SIGNALS_BODY",
    "--name", "Edge — memory signal sync", "--workdir", home,
  ]);

  expect(cronCreateArgs(prepare, "PREP_BODY", home)).toEqual([
    "cron", "create", "0 2 * * *", "PREP_BODY",
    "--name", "Edge — digest prepare", "--workdir", home,
  ]);

  expect(cronCreateArgs(send, "SEND_BODY", home)).toEqual([
    "cron", "create", "0 8 * * *", "SEND_BODY",
    "--name", "Edge — daily digest", "--deliver", "telegram", "--workdir", home,
  ]);
});

test("cronEditArgs includes only the provided fields", () => {
  expect(cronEditArgs("abc123", { prompt: "NEW_BODY" })).toEqual([
    "cron", "edit", "abc123", "--prompt", "NEW_BODY",
  ]);
  expect(cronEditArgs("abc123", { schedule: "7 8 * * *" })).toEqual([
    "cron", "edit", "abc123", "--schedule", "7 8 * * *",
  ]);
  expect(cronEditArgs("abc123", { prompt: "P", schedule: "7 8 * * *" })).toEqual([
    "cron", "edit", "abc123", "--schedule", "7 8 * * *", "--prompt", "P",
  ]);
});

test("staggeredSchedule derives a deterministic minute inside the spec's window", () => {
  const [signals, prepare, send] = DIGEST_CRON_SPECS;

  for (const spec of [signals, prepare, send]) {
    const schedule = staggeredSchedule(spec, "ix_tenant_key");
    expect(staggeredSchedule(spec, "ix_tenant_key")).toBe(schedule); // deterministic
    const [minute, ...rest] = schedule.split(" ");
    expect(Number(minute)).toBeGreaterThanOrEqual(0);
    expect(Number(minute)).toBeLessThan(spec.staggerWindowMinutes);
    expect(rest.join(" ")).toBe(spec.schedule.split(" ").slice(1).join(" "));
    expect(isValidCron(schedule)).toBe(true);
  }

  // Different specs hash independently for the same tenant seed.
  expect(fnv1a(`seed:${prepare.name}`)).not.toBe(fnv1a(`seed:${send.name}`));
  expect(fnv1a(`seed:${signals.name}`)).not.toBe(fnv1a(`seed:${prepare.name}`));
});

test("staggered windows keep signals within 01:00–01:49, prepare within 02:00–02:49, send within 08:00–08:24", () => {
  const [signals, prepare, send] = DIGEST_CRON_SPECS;
  expect(signals.staggerWindowMinutes).toBe(50);
  expect(prepare.staggerWindowMinutes).toBe(50);
  expect(send.staggerWindowMinutes).toBe(25);
});

test("storedSchedule reads hermes jobs.json shapes", () => {
  expect(storedSchedule({ id: "a", name: "x", schedule: { expr: "0 8 * * *" } })).toBe("0 8 * * *");
  expect(storedSchedule({ id: "a", name: "x", schedule_display: "5 8 * * *" })).toBe("5 8 * * *");
  expect(storedSchedule({ id: "a", name: "x", schedule: "1 2 * * *" })).toBe("1 2 * * *");
  expect(storedSchedule({ id: "a", name: "x" })).toBe("");
});

test("index MCP headers include telegram surface and optional handle", () => {
  expect(buildIndexMcpHeaders("ix_test")).toEqual({
    "x-api-key": "ix_test",
    "x-index-surface": "telegram",
  });

  expect(buildIndexMcpHeaders("ix_test", " @alice ")).toEqual({
    "x-api-key": "ix_test",
    "x-index-surface": "telegram",
    "x-index-telegram-username": "@alice",
  });
});

test("each spec declares its install-time override flag + env var", () => {
  const [signals, prepare, send] = DIGEST_CRON_SPECS;
  expect(signals.overrideFlag).toBe("--digest-signals-cron");
  expect(signals.overrideEnv).toBe("DIGEST_SIGNALS_CRON");
  expect(prepare.overrideFlag).toBe("--digest-prepare-cron");
  expect(prepare.overrideEnv).toBe("DIGEST_PREPARE_CRON");
  expect(send.overrideFlag).toBe("--digest-send-cron");
  expect(send.overrideEnv).toBe("DIGEST_SEND_CRON");
});

test("daily loop cron schedules honor flag/env overrides", () => {
  const [prepare, send] = DAILY_LOOP_CRON_SPECS;

  expect(resolveCronSchedule(prepare, [], {})).toBe("0 14,17,20 * * *");
  expect(resolveCronSchedule(send, [], { DAILY_LOOP_SEND_CRON: "30 15,18,21 * * *" })).toBe("30 15,18,21 * * *");
  expect(
    resolveCronSchedule(
      prepare,
      ["bun", "--daily-loop-prepare-cron", "15 13,16,19 * * *"],
      { DAILY_LOOP_PREPARE_CRON: "0 12 * * *" },
    ),
  ).toBe("15 13,16,19 * * *");
});

test("daily-loop cron schedules keep legacy check-in override aliases during rename", () => {
  const [prepare, send] = DAILY_LOOP_CRON_SPECS;

  expect(
    resolveCronSchedule(prepare, ["bun", "--checkin-prepare-cron", "15 13,16,19 * * *"], {}),
  ).toBe("15 13,16,19 * * *");
  expect(resolveCronSchedule(send, [], { CHECKIN_SEND_CRON: "30 15,18,21 * * *" })).toBe("30 15,18,21 * * *");
});

test("daily loop cron install gate is disabled by default and opt-in by flag/env aliases", () => {
  expect(dailyLoopCronsEnabled([], {})).toBe(false);
  expect(dailyLoopCronsEnabled(["bun", "--enable-daily-loop-crons"], {})).toBe(true);
  expect(dailyLoopCronsEnabled(["bun", "--enable-checkin-crons"], {})).toBe(true);
  expect(dailyLoopCronsEnabled([], { ENABLE_DAILY_LOOP_CRONS: "true" })).toBe(true);
  expect(dailyLoopCronsEnabled([], { ENABLE_CHECKIN_CRONS: "true" })).toBe(true);
  expect(dailyLoopCronsEnabled([], { ENABLE_DAILY_LOOP_CRONS: "1" })).toBe(true);
  expect(dailyLoopCronsEnabled([], { ENABLE_DAILY_LOOP_CRONS: "false" })).toBe(false);
});

test("isValidCron accepts 5-field expressions and rejects malformed ones", () => {
  expect(isValidCron("0 2 * * *")).toBe(true);
  expect(isValidCron("30 9 * * 1-5")).toBe(true);
  expect(isValidCron("*/15 0 1,15 * *")).toBe(true);
  expect(isValidCron("0 2 * *")).toBe(false); // too few fields
  expect(isValidCron("0 2 * * * *")).toBe(false); // too many fields
  expect(isValidCron("not a cron")).toBe(false);
  expect(isValidCron("")).toBe(false);
});

test("resolveCronSchedule returns the default when no override is set", () => {
  const [signals, prepare] = DIGEST_CRON_SPECS;
  expect(resolveCronSchedule(signals, [], {})).toBe("0 1 * * *");
  expect(resolveCronSchedule(prepare, [], {})).toBe("0 2 * * *");
});

test("resolveCronSchedule staggers from the seed when no override is set, but override wins", () => {
  const [, prepare, send] = DIGEST_CRON_SPECS;
  const seed = "ix_tenant_key";

  expect(resolveCronSchedule(prepare, [], {}, seed)).toBe(staggeredSchedule(prepare, seed));
  expect(resolveCronSchedule(send, [], {}, seed)).toBe(staggeredSchedule(send, seed));

  // Explicit override beats the staggered default; invalid override falls back to it.
  expect(resolveCronSchedule(send, [], { DIGEST_SEND_CRON: "0 9 * * *" }, seed)).toBe("0 9 * * *");
  expect(resolveCronSchedule(send, [], { DIGEST_SEND_CRON: "garbage" }, seed)).toBe(
    staggeredSchedule(send, seed),
  );
});

test("resolveCronSchedule honors flag, then env, with flag winning over env", () => {
  const [signals, prepare, send] = DIGEST_CRON_SPECS;

  expect(
    resolveCronSchedule(signals, ["bun", "install", "--digest-signals-cron", "30 0 * * *"], {}),
  ).toBe("30 0 * * *");

  expect(resolveCronSchedule(signals, [], { DIGEST_SIGNALS_CRON: "45 0 * * *" })).toBe("45 0 * * *");

  expect(
    resolveCronSchedule(prepare, ["bun", "install", "--digest-prepare-cron", "0 3 * * *"], {}),
  ).toBe("0 3 * * *");

  expect(resolveCronSchedule(send, [], { DIGEST_SEND_CRON: "0 9 * * *" })).toBe("0 9 * * *");

  expect(
    resolveCronSchedule(
      prepare,
      ["bun", "--digest-prepare-cron", "15 4 * * *"],
      { DIGEST_PREPARE_CRON: "0 6 * * *" },
    ),
  ).toBe("15 4 * * *");
});

test("resolveCronSchedule ignores an invalid override and uses the default", () => {
  const [, prepare] = DIGEST_CRON_SPECS;
  expect(resolveCronSchedule(prepare, ["bun", "--digest-prepare-cron", "garbage"], {})).toBe("0 2 * * *");
  expect(resolveCronSchedule(prepare, [], { DIGEST_PREPARE_CRON: "0 2 * *" })).toBe("0 2 * * *");
});
