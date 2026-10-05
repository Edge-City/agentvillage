/**
 * FROZEN FIXTURE. NEVER EDIT THIS FILE.
 *
 * rc13's delivery-window decision, copied verbatim from origin/main at commit
 * 9ff10b94739c2f3103bfdd863df60a1cd03dba69 (9ff10b9),
 * skills/index-network/scripts/proactive.ts:
 *   - `BRIEF_WINDOW` and its comment, lines 71-72;
 *   - `villageMinuteOfDay` and `inBriefWindow`, lines 695-706;
 *   - the decision itself, line 720 of `runAgentAction`, the first statement
 *     after `now` is read: `if (action === "brief" && !inBriefWindow(now)) return silent("outside-window");`
 *
 * The rc13 parity test (proactive-settings.test.ts) compares the trigger's
 * live decision path against this, so it can never drift with the source.
 * Only `rc13WindowDecision` below is not copied: it wraps line 720 so the test
 * can call it, returning the reason line 720 returns (`"outside-window"`) or
 * null where rc13 went on to the run. If rc13's behaviour is ever in doubt,
 * compare with `git show 9ff10b9:skills/index-network/scripts/proactive.ts`;
 * never change this file to match the source.
 */

// ── Copied verbatim from 9ff10b9 proactive.ts:71-72 ────────────────────────
/** The brief's delivery window, in minutes since village (IST) midnight. */
export const BRIEF_WINDOW = { start: 5 * 60, end: 11 * 60 };

// ── Copied verbatim from 9ff10b9 proactive.ts:695-706 ──────────────────────
/** Minutes since village (IST) midnight. */
export function villageMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

export function inBriefWindow(now: Date): boolean {
  const minute = villageMinuteOfDay(now);
  return minute >= BRIEF_WINDOW.start && minute < BRIEF_WINDOW.end;
}

// ── The wrapper (not copied): 9ff10b9 proactive.ts:720, as a function ──────
/** rc13's agent actions (9ff10b9 proactive.ts:61-63, without the prefetch). */
export type Rc13AgentAction = "brief" | "drop-midday" | "drop-evening" | "negotiation" | "evening";

export function rc13WindowDecision(action: Rc13AgentAction, now: Date): "outside-window" | null {
  if (action === "brief" && !inBriefWindow(now)) return "outside-window";
  return null;
}
