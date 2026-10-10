import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_WINDOWS, TEMPLATE_NAMES, formatWindow } from "../../skills/index-network/scripts/job-settings";
import { MESSAGE_LABELS } from "../../skills/index-network/scripts/message-labels";
import {
  DIGEST_CRON_SPECS,
  KNOWLEDGE_SYNC_PROMPT,
  KNOWLEDGE_SYNC_SHIM,
  PREFETCH_PROMPT,
  PROACTIVE_SHIM,
  buildIndexMcpHeaders,
  cronCreateArgs,
  cronEditArgs,
  fnv1a,
  isValidCron,
  resolveCronSchedule,
  staggeredSchedule,
  storedSchedule,
  templateCronSpec,
  templateJobName,
  tokenUsageAuditCronDisabled,
} from "../install_index";

test("ten Index cron specs: digest jobs, opportunity drops, the pending alert, token audit, knowledge sync (heartbeat and Plaza selfie retired)", () => {
  expect(DIGEST_CRON_SPECS).toHaveLength(10);
  // The 30-minute "Edge — heartbeat" cron was retired (it drained OpenRouter
  // key budget fleet-wide); it must no longer be installed.
  expect(DIGEST_CRON_SPECS.some((s) => s.name === "Edge — heartbeat")).toBe(false);
  // The Agent Plaza selfie is an operator one-off, not a scheduled tenant cron.
  expect(DIGEST_CRON_SPECS.some((s) => s.name === "Edge — Agent Plaza selfie")).toBe(false);
  const [signals, prepare, send, negotiation, evening, dropMidday, dropEvening, pending, tokenAudit, knowledge] = DIGEST_CRON_SPECS;
  expect(pending.name).toBe("Edge — pending opportunity");
  expect(knowledge.name).toBe("Edge — knowledge sync");
  expect(knowledge.schedule).toBe("*/30 * * * *");
  expect(knowledge.staggerWindowMinutes).toBe(30);
  expect(knowledge.noAgent).toBe(true);
  expect(knowledge.deliver).toBe(false);
  expect(knowledge.failureDeliver).toBe("local");
  expect(knowledge.scriptFile).toBe(KNOWLEDGE_SYNC_SHIM);
  expect(knowledge.scriptInstallName).toBe("agentvillage_knowledge_sync.sh");
  expect(knowledge.promptBody).toBe(KNOWLEDGE_SYNC_PROMPT);
  expect(knowledge.overrideEnv).toBe("KNOWLEDGE_SYNC_CRON");
  expect(signals.schedule).toBe("0 1 * * *");
  expect(signals.name).toBe("Edge — memory signal sync");
  expect(signals.promptFile).toBe("index-network/prompts/memory-signals.md");
  expect(signals.scriptFile).toBe("index-network/scripts/memory_signal_gate.py");
  expect(signals.scriptInstallName).toBe("agentvillage_memory_signal_gate.py");
  expect(signals.deliver).toBe(false);
  expect(prepare.schedule).toBe("0 2 * * *");
  expect(prepare.name).toBe("Edge — digest prepare");
  expect(prepare.promptFile).toBeUndefined();
  expect(prepare.promptBody).toBe(PREFETCH_PROMPT);
  expect(prepare.scriptFile).toBe(PROACTIVE_SHIM);
  expect(prepare.scriptInstallName).toBe("agentvillage_proactive_prefetch.sh");
  expect(prepare.noAgent).toBe(true);
  expect(prepare.deliver).toBe(false);
  expect(send.schedule).toBe("0 8 * * *");
  expect(send.name).toBe("Edge — daily digest");
  expect(send.promptFile).toBe("index-network/prompts/brief.md");
  expect(send.scriptInstallName).toBe("agentvillage_proactive_brief.sh");
  expect(send.deliver).toBe(true);
  expect(negotiation.schedule).toBe("0 14 * * *");
  expect(negotiation.name).toBe("Edge — negotiation summary");
  expect(negotiation.promptFile).toBe("index-network/prompts/negotiation-summary.md");
  expect(negotiation.deliver).toBe(true);
  expect(evening.schedule).toBe("0 19 * * *");
  expect(evening.name).toBe("Edge — evening questions");
  expect(evening.promptFile).toBe("index-network/prompts/ask-questions.md");
  expect(evening.deliver).toBe(true);
  expect(dropMidday.schedule).toBe("0 12 * * *");
  expect(dropMidday.name).toBe("Edge — opportunity drop (midday)");
  expect(dropMidday.promptFile).toBe("index-network/prompts/opportunity-drop.md");
  expect(dropMidday.deliver).toBe(true);
  expect(dropEvening.schedule).toBe("0 17 * * *");
  expect(dropEvening.name).toBe("Edge — opportunity drop (evening)");
  expect(dropEvening.promptFile).toBe("index-network/prompts/opportunity-drop.md");
  expect(dropEvening.deliver).toBe(true);
  expect(tokenAudit.schedule).toBe("0 9 * * *");
  expect(tokenAudit.name).toBe("Edge — token usage audit");
  expect(tokenAudit.scriptFile).toBe("token-usage-audit/scripts/audit_token_usage.py");
  expect(tokenAudit.scriptInstallName).toBe("agentvillage_token_usage_audit.py");
  expect(tokenAudit.skill).toBe("token-usage-audit");
  expect(tokenAudit.deliver).toBe(true);
  // #272: the plan-limit answer links the script's usageSettingsUrl (Settings › Usage), never a guessed limit.
  expect(tokenAudit.promptBody).toContain(
    "For how much of the plan limit is spent or left, never guess or name a limit: link the script's usageSettingsUrl, exactly as given.",
  );
});

test("cron create args handle delivered and scripted specs", () => {
  const home = "/home/x/.hermes";
  const [signals, prepare, send] = DIGEST_CRON_SPECS;
  const tokenAudit = DIGEST_CRON_SPECS.find((spec) => spec.name === "Edge — token usage audit")!;

  expect(cronCreateArgs(signals, "SIGNALS_BODY", home)).toEqual([
    "cron", "create", "0 1 * * *", "SIGNALS_BODY",
    "--name", "Edge — memory signal sync", "--script", "agentvillage_memory_signal_gate.py", "--workdir", home,
  ]);

  expect(cronCreateArgs(prepare, "PREP_BODY", home)).toEqual([
    "cron", "create", "0 2 * * *", "PREP_BODY",
    "--name", "Edge — digest prepare", "--failure-deliver", "local",
    "--script", "agentvillage_proactive_prefetch.sh", "--no-agent", "--workdir", home,
  ]);

  expect(cronCreateArgs(send, "SEND_BODY", home)).toEqual([
    "cron", "create", "0 8 * * *", "SEND_BODY",
    "--name", "Edge — daily digest", "--deliver", "telegram", "--failure-deliver", "local",
    "--script", "agentvillage_proactive_brief.sh", "--workdir", home,
  ]);

  const tokenAuditArgs = cronCreateArgs(tokenAudit, "AUDIT_PROMPT", home);
  expect(tokenAuditArgs).toContain("--deliver");
  expect(tokenAuditArgs).toContain("--skill");
  expect(tokenAuditArgs).toContain("token-usage-audit");
  expect(tokenAuditArgs).toContain("--script");
  expect(tokenAuditArgs).toContain("agentvillage_token_usage_audit.py");
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
  expect(cronEditArgs("abc123", { script: "gate.py" })).toEqual([
    "cron", "edit", "abc123", "--script", "gate.py",
  ]);
  expect(cronEditArgs("abc123", { prompt: "P", script: "s.sh", noAgent: false, failureDeliver: "local" })).toEqual([
    "cron", "edit", "abc123", "--prompt", "P", "--script", "s.sh", "--agent", "--failure-deliver", "local",
  ]);
  expect(cronEditArgs("abc123", { noAgent: true })).toEqual(["cron", "edit", "abc123", "--no-agent"]);
});

test("staggeredSchedule derives a deterministic minute inside the spec's window", () => {
  const [signals, prepare, send] = DIGEST_CRON_SPECS;

  for (const spec of [signals, prepare, send]) {
    const schedule = staggeredSchedule(spec, "ix_tenant_key");
    expect(staggeredSchedule(spec, "ix_tenant_key")).toBe(schedule); // deterministic
    const [minute, ...rest] = schedule.split(" ");
    const firstMinute = Number(minute.split(",")[0]);
    expect(firstMinute).toBeGreaterThanOrEqual(0);
    expect(firstMinute).toBeLessThan(spec.staggerWindowMinutes);
    if (spec.schedule.startsWith("*/30 ")) {
      expect(minute).toBe(`${firstMinute},${firstMinute + 30}`);
    }
    expect(rest.join(" ")).toBe(spec.schedule.split(" ").slice(1).join(" "));
    expect(isValidCron(schedule)).toBe(true);
  }

  // Different specs hash independently for the same tenant seed.
  expect(fnv1a(`seed:${signals.name}`)).not.toBe(fnv1a(`seed:${prepare.name}`));
  expect(fnv1a(`seed:${prepare.name}`)).not.toBe(fnv1a(`seed:${send.name}`));
});

test("staggered windows keep signals, prepare, and send in bounded windows", () => {
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

test("index MCP headers include telegram surface and optional bare handle", () => {
  expect(buildIndexMcpHeaders("ix_test")).toEqual({
    "x-api-key": "ix_test",
    "x-index-surface": "telegram",
  });

  expect(buildIndexMcpHeaders("ix_test", " @alice ")).toEqual({
    "x-api-key": "ix_test",
    "x-index-surface": "telegram",
    "x-index-telegram-username": "alice",
  });
});

test("invalid telegram MCP handle is omitted", () => {
  expect(buildIndexMcpHeaders("ix_test", "Alice Example")).toEqual({
    "x-api-key": "ix_test",
    "x-index-surface": "telegram",
  });
});

test("each spec declares its install-time override flag + env var", () => {
  const [signals, prepare, send, , , dropMidday, dropEvening, pending, tokenAudit] = DIGEST_CRON_SPECS;
  expect(signals.overrideFlag).toBe("--digest-signals-cron");
  expect(signals.overrideEnv).toBe("DIGEST_SIGNALS_CRON");
  expect(prepare.overrideFlag).toBe("--digest-prepare-cron");
  expect(prepare.overrideEnv).toBe("DIGEST_PREPARE_CRON");
  expect(send.overrideFlag).toBe("--digest-send-cron");
  expect(send.overrideEnv).toBe("DIGEST_SEND_CRON");
  expect(dropMidday.overrideFlag).toBe("--opportunity-drop-midday-cron");
  expect(dropMidday.overrideEnv).toBe("OPPORTUNITY_DROP_MIDDAY_CRON");
  expect(dropEvening.overrideFlag).toBe("--opportunity-drop-evening-cron");
  expect(dropEvening.overrideEnv).toBe("OPPORTUNITY_DROP_EVENING_CRON");
  expect(pending.overrideFlag).toBe("--pending-alert-cron");
  expect(pending.overrideEnv).toBe("PENDING_ALERT_CRON");
  expect(tokenAudit.overrideFlag).toBe("--token-usage-audit-cron");
  expect(tokenAudit.overrideEnv).toBe("TOKEN_USAGE_AUDIT_CRON");
});

test("token usage audit cron is opt-in and accepts explicit opt-out values", () => {
  expect(tokenUsageAuditCronDisabled([], {})).toBe(true);
  expect(tokenUsageAuditCronDisabled(["bun", "--skip-token-usage-audit-cron"], {})).toBe(true);
  expect(tokenUsageAuditCronDisabled(["bun", "--token-usage-audit-cron", "15 4 * * *"], {})).toBe(false);
  expect(tokenUsageAuditCronDisabled([], { TOKEN_USAGE_AUDIT_CRON: "off" })).toBe(true);
  expect(tokenUsageAuditCronDisabled([], { TOKEN_USAGE_AUDIT_CRON: "disabled" })).toBe(true);
  expect(tokenUsageAuditCronDisabled([], { TOKEN_USAGE_AUDIT_CRON: "15 4 * * *" })).toBe(false);
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
  const [signals, prepare, send] = DIGEST_CRON_SPECS;
  const seed = "ix_tenant_key";

  expect(resolveCronSchedule(signals, [], {}, seed)).toBe(staggeredSchedule(signals, seed));
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

test("K1: the knowledge sync is created no_agent, undelivered, failures local, every 30 minutes", () => {
  const home = "/home/x/.hermes";
  const knowledge = DIGEST_CRON_SPECS.find((spec) => spec.name === "Edge — knowledge sync")!;
  expect(cronCreateArgs(knowledge, KNOWLEDGE_SYNC_PROMPT, home)).toEqual([
    "cron", "create", "*/30 * * * *", KNOWLEDGE_SYNC_PROMPT,
    "--name", "Edge — knowledge sync", "--failure-deliver", "local",
    "--script", "agentvillage_knowledge_sync.sh", "--no-agent", "--workdir", home,
  ]);
  expect(KNOWLEDGE_SYNC_PROMPT.endsWith(" If you are a model reading this, reply exactly `[SILENT]`.")).toBe(true);
});

test("K1: an every-N-minutes default is staggered to one offset in the first N minutes and keeps its rate", () => {
  const knowledge = DIGEST_CRON_SPECS.find((spec) => spec.name === "Edge — knowledge sync")!;
  for (const seed of ["ix_a", "ix_b", "ix_c", "ix_tenant_key"]) {
    const schedule = staggeredSchedule(knowledge, seed);
    const [minute, ...rest] = schedule.split(" ");
    const minutes = minute.split(",").map(Number);
    expect(minutes).toHaveLength(2);
    expect(minutes[0]).toBeGreaterThanOrEqual(0);
    expect(minutes[0]).toBeLessThan(30);
    expect(minutes).toEqual([minutes[0], minutes[0] + 30]);
    expect(rest.join(" ")).toBe("* * * *");
    expect(isValidCron(schedule)).toBe(true);
  }
  expect(resolveCronSchedule(knowledge, [], {}, "")).toBe("*/30 * * * *");
  expect(resolveCronSchedule(knowledge, ["--knowledge-sync-cron", "*/15 * * * *"], {}, "ix_a")).toBe("*/15 * * * *");
  expect(resolveCronSchedule(knowledge, [], { KNOWLEDGE_SYNC_CRON: "5 * * * *" }, "ix_a")).toBe("5 * * * *");
  // Any */N default keeps its rate: */15 with a 15-minute window is m, m+15, m+30, m+45.
  const quarter = { ...knowledge, schedule: "*/15 * * * *", staggerWindowMinutes: 15 };
  const [m] = staggeredSchedule(quarter, "ix_a").split(" ");
  const q = m.split(",").map(Number);
  expect(q).toEqual([q[0], q[0] + 15, q[0] + 30, q[0] + 45]);
});

// DATA-361: the cron prompts and the memory-signal gate moved from
// skills/edge-esmeralda to skills/index-network. Installed jobs are matched by
// name (templates by templateJobName) and their scripts installed under
// scriptInstallName, so the move must change neither: this list is the
// snapshot taken at the move.
test("DATA-361: every prompt and script a spec names exists under its new home, none under edge-esmeralda, and job names, schedules and installed script names are unchanged", () => {
  const skills = join(import.meta.dir, "..", "..", "skills");
  const specs = [...DIGEST_CRON_SPECS, ...TEMPLATE_NAMES.map((template) => templateCronSpec(template, "0 10 * * *"))];
  for (const spec of specs) {
    for (const file of [spec.promptFile, spec.scriptFile]) {
      if (!file) continue;
      expect({ name: spec.name, file, under: file.startsWith("edge-esmeralda/") }).toEqual({ name: spec.name, file, under: false });
      expect({ name: spec.name, file, exists: existsSync(join(skills, file)) }).toEqual({ name: spec.name, file, exists: true });
    }
  }
  const oldPrompts = join(skills, "edge-esmeralda", "prompts");
  expect(existsSync(oldPrompts) ? readdirSync(oldPrompts) : []).toEqual([]);
  expect(existsSync(join(skills, "edge-esmeralda", "scripts", "memory_signal_gate.py"))).toBe(false);
  expect(DIGEST_CRON_SPECS.map((spec) => [spec.name, spec.schedule, spec.scriptInstallName ?? null])).toEqual([
    ["Edge — memory signal sync", "0 1 * * *", "agentvillage_memory_signal_gate.py"],
    ["Edge — digest prepare", "0 2 * * *", "agentvillage_proactive_prefetch.sh"],
    ["Edge — daily digest", "0 8 * * *", "agentvillage_proactive_brief.sh"],
    ["Edge — negotiation summary", "0 14 * * *", "agentvillage_proactive_negotiation.sh"],
    ["Edge — evening questions", "0 19 * * *", "agentvillage_proactive_evening.sh"],
    ["Edge — opportunity drop (midday)", "0 12 * * *", "agentvillage_proactive_drop-midday.sh"],
    ["Edge — opportunity drop (evening)", "0 17 * * *", "agentvillage_proactive_drop-evening.sh"],
    ["Edge — pending opportunity", "20 * * * *", "agentvillage_proactive_pending.sh"],
    ["Edge — token usage audit", "0 9 * * *", "agentvillage_token_usage_audit.py"],
    ["Edge — knowledge sync", "*/30 * * * *", "agentvillage_knowledge_sync.sh"],
  ]);
  expect(TEMPLATE_NAMES.map((template) => [templateJobName(template), templateCronSpec(template, "0 10 * * *").promptFile])).toEqual([
    ["Edge — template: brief", "index-network/prompts/brief.md"],
    ["Edge — template: digest-preview", "index-network/prompts/opportunity-drop.md"],
    ["Edge — template: evening-ask", "index-network/prompts/ask-questions.md"],
  ]);
});

describe("DATA-430: the hourly pending-opportunity alert", () => {
  const pending = DIGEST_CRON_SPECS.find((spec) => spec.name === "Edge — pending opportunity")!;

  test("the spec: hourly at :20, a 10-minute stagger, its prompt, the proactive shim as `pending`, delivered, failures local, its override", () => {
    expect(pending).toEqual({
      schedule: "20 * * * *",
      staggerWindowMinutes: 10,
      promptFile: "index-network/prompts/pending-alert.md",
      scriptFile: PROACTIVE_SHIM,
      scriptInstallName: "agentvillage_proactive_pending.sh",
      failureDeliver: "local",
      name: "Edge — pending opportunity",
      deliver: true,
      overrideFlag: "--pending-alert-cron",
      overrideEnv: "PENDING_ALERT_CRON",
    });
    // Right after the two drops, before the opt-in audit.
    const names = DIGEST_CRON_SPECS.map((spec) => spec.name);
    expect(names.indexOf("Edge — pending opportunity")).toBe(names.indexOf("Edge — opportunity drop (evening)") + 1);
    expect(cronCreateArgs(pending, "P", "/home/x")).toEqual([
      "cron", "create", "20 * * * *", "P", "--name", "Edge — pending opportunity",
      "--deliver", "telegram", "--failure-deliver", "local",
      "--script", "agentvillage_proactive_pending.sh", "--workdir", "/home/x",
    ]);
  });

  test("its label is Pending opportunity, and its default window is 08:00-22:00", () => {
    expect(MESSAGE_LABELS["Pending opportunity"]).toEqual(["Edge — pending opportunity"]);
    expect(formatWindow(DEFAULT_WINDOWS.pending!)).toBe("08:00-22:00");
  });

  test("staggered over :20 to :29 of every hour, deterministic per tenant; every `0 ...` default keeps its old slot", () => {
    const minutes = new Set<number>();
    for (let n = 0; n < 200; n++) {
      const schedule = staggeredSchedule(pending, `ix_tenant_${n}`);
      expect(staggeredSchedule(pending, `ix_tenant_${n}`)).toBe(schedule);
      const [minute, ...rest] = schedule.split(" ");
      expect(rest.join(" ")).toBe("* * * *");
      expect(/^\d+$/.test(minute)).toBe(true);
      minutes.add(Number(minute));
    }
    expect([...minutes].sort((a, b) => a - b)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    // The base minute is counted from only for this spec: a `0` default is offset from 0, as before.
    for (const spec of DIGEST_CRON_SPECS.filter((s) => s.schedule.startsWith("0 "))) {
      const minute = Number(staggeredSchedule(spec, "ix_tenant_key").split(" ")[0]);
      expect(minute).toBe(fnv1a(`ix_tenant_key:${spec.name}`) % spec.staggerWindowMinutes);
    }
  });

  test("the override flag wins over the env, which wins over the staggered default", () => {
    expect(resolveCronSchedule(pending, ["bun", "--pending-alert-cron", "45 * * * *"], { PENDING_ALERT_CRON: "50 * * * *" }, "seed")).toBe("45 * * * *");
    expect(resolveCronSchedule(pending, [], { PENDING_ALERT_CRON: "50 * * * *" }, "seed")).toBe("50 * * * *");
    expect(resolveCronSchedule(pending, [], {}, "seed")).toBe(staggeredSchedule(pending, "seed"));
    expect(resolveCronSchedule(pending, [], {}, "")).toBe("20 * * * *");
  });
});
