/**
 * The suggestion rating cards: the trigger's half (data docs/design/suggestion-rating.md).
 *
 * On the evening run, every connection Index lists as `accepted` that the av-rate plugin has not
 * asked about yet is staged for a card pair (card 1: how good a match the suggestion was, five
 * buttons; card 2: whether the meetup was already planned), the same evening it is first seen
 * accepted (the old outcome ask waited two days), oldest first, at most CARDS_PER_EVENING per
 * evening. The rest roll to the next evening; one first seen more than STALE_DAYS village days ago
 * and still unasked is dropped from due.
 *
 * The trigger writes ONE stage file per subject into `av-events/proactive/rating/` (0600 in a 0700
 * folder, by temp file and rename): `{v, opportunity_id, intention_id, name, headline, agent_name,
 * staged_at, date}`. The cleaned name and headline are the only text and they never reach an
 * event: `plugins/av-rate` reads the file, sends the card, records the subject on its ledger
 * `av-events/proactive/rated.json`, and the trigger reads that ledger as "asked". Nothing the model
 * says is involved: the evening job's model turn sends its reminder or closeout as before.
 *
 * State (`heartbeat-state.json` `ratingCards`): `firstSeen` = opportunity id -> the village date it
 * was first listed accepted by an evening run (the staleness and ordering clock); `staged` =
 * opportunity id -> the date it was last staged (never twice on one date).
 *
 * **The shared day budget** (wave 1, resident controls). The agreed ceiling is three proactive
 * messages per resident per day, all jobs together. The trigger has no delivery ledger, only the
 * once-a-day marks the other agent jobs write to `heartbeat-state.json` `proactiveRuns` when they
 * wake the model (brief, drop-midday, drop-evening, negotiation; the hourly pending alert writes
 * none, DAY_MARK_EXEMPT, so it is not counted). A mark says the model was woken, not that it
 * delivered: a run the model answered `[SILENT]` still carries a mark. The budget counts every mark
 * as a delivery (conservative, never over the ceiling): `cardBudget` = 3 minus the marks dated
 * today, and the evening stages at most that many card pairs. The data side reads the real count
 * (`marts.proactive_messages_per_resident_day`, rule `proactive_ceiling_v2`).
 *
 * **The resident's controls.** The cards go out under the "Evening questions" job: when the
 * resident has stopped that job (Hermes's job record, `cron/jobs.json`, read exactly as
 * `storedJobEnabled` reads it: `enabled: false`, `state: "paused"` or a `paused_at`), the trigger
 * stages nothing (`eveningJobState`), and the plugin sends nothing (its own mirror of the same
 * read). A team tenant (`AV_TEAM_TENANT=1`, job-settings.ts isTeamTenant) stages nothing. Quiet
 * hours are the plugin's: the trigger runs when the evening job fires (its own window, if the
 * resident set one, gates the whole run in proactive.ts), the plugin defers a send that would fall
 * outside the resident's evening window or, with none set, outside 08:00 to 22:00 village time.
 *
 * `--stage-test`: writes one stage file by hand, no Index call, for a developer testing the plugin
 * with their own bot (plugins/av-rate/README.md "Local test with your own bot").
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BriefOpportunity } from "./build-daily-brief-context";
import { villageDate } from "./build-daily-brief-context";
import { HERMES_JOB_ID_RE, MESSAGE_LABELS, installedJobsPath, readJobsStore, storedJobEnabled } from "./message-labels";
import { envOrDotenv } from "./proactive-text";

/** The on-switch, read like every other AV_* variable: the environment, else `$HERMES_HOME/.env`. */
export const CARDS_SWITCH = "AV_RATE_CARDS";
/** The old text ask's switch (default off): proactive.ts `outcomeAskDecision` runs only with it on. */
export const TEXT_ASK_SWITCH = "AV_OUTCOME_TEXT_ASK";
const TRUTHY = new Set(["1", "true", "yes", "on"]);
/** The agreed proactive ceiling per resident per day, all jobs together; the most card pairs one evening can stage. */
export const CARDS_PER_EVENING = 3;
/** The agent jobs whose day marks (`proactiveRuns`) count against the budget; the evening itself marks after staging. */
export const BUDGET_ACTIONS = ["brief", "drop-midday", "drop-evening", "negotiation"] as const;
/** proactive.ts RUNS_KEY, restated so this module does not import the trigger. */
const RUNS_KEY = "proactiveRuns";
/** `installed_jobs.json` over this is unreadable (pause-job.ts MAX_INSTALLED_IDS_BYTES). */
const MAX_INSTALLED_IDS_BYTES = 1024 * 1024;
/** The installer's name for the evening job (message-labels.ts). */
export const EVENING_JOB_NAMES: readonly string[] = MESSAGE_LABELS["Evening questions"];
/** An acceptance first seen more than this many village days ago and still unasked is no longer due. */
export const STALE_DAYS = 3;
export const RATING_STATE_KEY = "ratingCards";
export const STAGE_VERSION = 1;
export const QUESTION_VERSION = "match_fit_5_v1";
const NAME_MAX = 80;
const HEADLINE_MAX = 120;
const AGENT_NAME_MAX = 40;
/** An envelope id (agentvillage-data src/envelope.ts ID_PATTERN; the plugin's ID_PATTERN). */
const ENVELOPE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The plugin's size cap for its ledger (av-rate LEDGER_MAX_BYTES). */
const LEDGER_MAX_BYTES = 512 * 1024;

export function ratingCardsOn(home: string): boolean {
  return TRUTHY.has(envOrDotenv(CARDS_SWITCH, home).toLowerCase());
}

export function textAskOn(home: string): boolean {
  return TRUTHY.has(envOrDotenv(TEXT_ASK_SWITCH, home).toLowerCase());
}

export function ratingStageDir(home: string): string {
  return join(home, "av-events", "proactive", "rating");
}

/** Written by the plugin only; the trigger reads it. */
export function ratedLedgerPath(home: string): string {
  return join(home, "av-events", "proactive", "rated.json");
}

export interface RatingStage {
  v: typeof STAGE_VERSION;
  opportunity_id: string;
  intention_id: string | null;
  name: string;
  headline: string | null;
  agent_name: string;
  staged_at: string;
  date: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const UUID_SHAPE = /^[0-9a-fA-F-]{36}$/;

/**
 * An opportunity id as the plugin and the data side key it: a UUID-shaped id lower-cased (the
 * plugin's `valid_stage` and the marts lower-case on join), any other id as given. Null unless it
 * can be an envelope id.
 */
export function canonicalId(id: unknown): string | null {
  if (typeof id !== "string" || !ENVELOPE_ID.test(id)) return null;
  return UUID_SHAPE.test(id) ? id.toLowerCase() : id;
}

function dayNumber(date: string): number | null {
  if (!DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/**
 * Opportunity ids the plugin recorded as asked (its ledger's `cards` keys): empty when there is no
 * ledger yet, null when one exists but cannot be trusted (not a private regular file of this user
 * in a private folder, too big, not the shape). Null means "stage nothing tonight": the plugin never
 * writes over a ledger it refuses, so it could record nothing new and a card would go out again.
 */
export function readRatedIds(home: string): Set<string> | null {
  const path = ratedLedgerPath(home);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    let file;
    try {
      file = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      return null;
    }
    const dir = lstatSync(dirname(path));
    if (!dir.isDirectory() || (uid !== null && dir.uid !== uid) || dir.mode & 0o022) return null;
    if (!file.isFile() || (uid !== null && file.uid !== uid) || file.mode & 0o077 || file.size > LEDGER_MAX_BYTES) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const cards = data && typeof data === "object" && !Array.isArray(data) && data.v === 1 ? data.cards : undefined;
    if (!cards || typeof cards !== "object" || Array.isArray(cards)) return null;
    // The plugin's id-only tombstones for cards it evicted from the ledger: still asked.
    const evicted: unknown = data.evicted;
    const ids = [...Object.keys(cards), ...(Array.isArray(evicted) ? evicted.filter((id): id is string => typeof id === "string") : [])];
    return new Set(ids.flatMap((id) => (canonicalId(id) ? [canonicalId(id)!] : [])));
  } catch {
    return null;
  }
}

/** `ratingCards.firstSeen` and `.staged`, valid entries only. */
export function ratingState(state: Record<string, unknown>): { firstSeen: Record<string, string>; staged: Record<string, string> } {
  const raw = asRecord(state[RATING_STATE_KEY]);
  const dates = (value: unknown) => Object.fromEntries(Object.entries(asRecord(value)).filter((e): e is [string, string] => typeof e[1] === "string" && DATE.test(e[1])));
  return { firstSeen: dates(raw.firstSeen), staged: dates(raw.staged) };
}

/** The canonical ids of `ids` (ones that cannot be envelope ids dropped). */
function canonicalIds(ids: readonly string[]): Set<string> {
  return new Set(ids.flatMap((id) => (canonicalId(id) ? [canonicalId(id)!] : [])));
}

/**
 * The state with every listed accepted id first seen (`date` for the new ones), pruned to the ids
 * Index lists accepted now, and entries for ids the plugin has asked about dropped. Ids are
 * canonical (`canonicalId`). Pure.
 */
export function noteAccepted(state: Record<string, unknown>, acceptedIds: readonly string[], asked: Set<string>, date: string): Record<string, unknown> {
  const current = ratingState(state);
  const listed = canonicalIds(acceptedIds);
  const firstSeen: Record<string, string> = {};
  for (const [raw, on] of Object.entries(current.firstSeen)) {
    const id = canonicalId(raw);
    if (id && listed.has(id) && !asked.has(id) && !(id in firstSeen)) firstSeen[id] = on;
  }
  for (const id of listed) if (!asked.has(id) && !(id in firstSeen)) firstSeen[id] = date;
  const staged: Record<string, string> = {};
  for (const [raw, on] of Object.entries(current.staged)) {
    const id = canonicalId(raw);
    if (id && !asked.has(id) && id in firstSeen) staged[id] = on;
  }
  return { ...state, [RATING_STATE_KEY]: { ...asRecord(state[RATING_STATE_KEY]), firstSeen, staged } };
}

/** The ids staged on `date` so far (a second evening run on one date counts them against the cap). */
export function stagedOn(state: Record<string, unknown>, date: string): Set<string> {
  return new Set(Object.entries(ratingState(state).staged).flatMap(([id, on]) => (on === date && canonicalId(id) ? [canonicalId(id)!] : [])));
}

/**
 * The card pairs the evening may still stage on `date` under the shared ceiling: CARDS_PER_EVENING
 * minus the day marks dated `date` of the other agent jobs (BUDGET_ACTIONS), never below zero. A
 * mark is counted whether or not the model delivered (the header says why).
 */
export function cardBudget(state: Record<string, unknown>, date: string): number {
  const runs = asRecord(state[RUNS_KEY]);
  const marks = BUDGET_ACTIONS.filter((action) => runs[action] === date).length;
  return Math.max(0, CARDS_PER_EVENING - marks);
}

export type EveningJobState = "running" | "stopped" | "absent" | "unreadable";

/**
 * Whether Hermes will fire the installer's evening job: `stopped` when a job named as the evening
 * job, with an id `installed_jobs.json` lists, is paused or disabled (message-labels.ts
 * storedJobEnabled, Hermes's own rule); `running` when such a job is enabled; `absent` when no
 * installed evening job is in the store (a box before install, a developer's home); `unreadable`
 * when the store cannot be read. Only `running` and `absent` stage.
 */
export function eveningJobState(home: string): EveningJobState {
  const store = readJobsStore(home);
  if ("unreadable" in store) return "unreadable";
  let installed: Set<string>;
  try {
    const path = installedJobsPath(home);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_INSTALLED_IDS_BYTES) return "unreadable";
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const ids = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { ids?: unknown }).ids : undefined;
    installed = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && HERMES_JOB_ID_RE.test(id)) : []);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") installed = new Set();
    else return "unreadable";
  }
  let seen = false;
  for (const entry of store.jobs) {
    const job = asRecord(entry);
    if (typeof job.name !== "string" || !EVENING_JOB_NAMES.includes(job.name)) continue;
    if (typeof job.id !== "string" || !HERMES_JOB_ID_RE.test(job.id) || !installed.has(job.id)) continue;
    seen = true;
    if (!storedJobEnabled(job)) return "stopped";
  }
  return seen ? "running" : "absent";
}

/**
 * Opportunity ids due a card pair on `date`, oldest first seen first, then by id, at most `limit`
 * (CARDS_PER_EVENING, or tonight's `cardBudget`): listed accepted now, not asked, not staged today,
 * first seen within STALE_DAYS. The state must already carry tonight's `noteAccepted`.
 */
export function dueRatingSubjects(state: Record<string, unknown>, acceptedIds: readonly string[], asked: Set<string>, date: string, limit = CARDS_PER_EVENING): string[] {
  const today = dayNumber(date);
  // One rule for the cap, whatever the run: tonight's budget less what this date already staged
  // (a second evening run on one date, a re-run after a crash) never exceeds CARDS_PER_EVENING.
  const room = Math.min(limit, CARDS_PER_EVENING) - stagedOn(state, date).size;
  if (today === null || room <= 0) return [];
  const { firstSeen, staged } = ratingState(state);
  const listed = canonicalIds(acceptedIds);
  return Object.entries(firstSeen)
    .flatMap(([raw, on]) => {
      const id = canonicalId(raw);
      const day = dayNumber(on);
      if (!id || day === null || !listed.has(id) || asked.has(id) || staged[id] === date) return [];
      if (today - day > STALE_DAYS) return [];
      return [[id, on] as const];
    })
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : 1))
    .map(([id]) => id)
    .slice(0, room);
}

/** The state with `ids` (canonical) recorded as staged on `date`. */
export function recordStaged(state: Record<string, unknown>, ids: readonly string[], date: string): Record<string, unknown> {
  const current = ratingState(state);
  const staged = { ...current.staged };
  for (const id of canonicalIds(ids)) staged[id] = date;
  return { ...state, [RATING_STATE_KEY]: { ...asRecord(state[RATING_STATE_KEY]), firstSeen: current.firstSeen, staged } };
}

/**
 * The stage for one subject. `name`, `headline` and `agentName` are already cleaned (proactive.ts
 * Withheld / agentNameFor): this only bounds them. Null when the id cannot be an envelope id.
 */
export function ratingStageFor(
  card: Pick<BriefOpportunity, "opportunityId" | "matchedIntentIds">,
  cleaned: { name: string; headline: string | null; agentName: string },
  date: string,
  now: Date,
): RatingStage | null {
  const id = canonicalId(card.opportunityId);
  if (!id) return null;
  const intentIds = Array.isArray(card.matchedIntentIds) ? Array.from(new Set(card.matchedIntentIds)) : [];
  const intention = intentIds.length === 1 && typeof intentIds[0] === "string" && ENVELOPE_ID.test(intentIds[0]) ? intentIds[0] : null;
  const name = cleaned.name.trim().slice(0, NAME_MAX);
  if (!name) return null;
  const headline = cleaned.headline ? cleaned.headline.slice(0, HEADLINE_MAX) : null;
  return {
    v: STAGE_VERSION,
    opportunity_id: id,
    intention_id: intention,
    name,
    headline: headline || null,
    agent_name: cleaned.agentName.slice(0, AGENT_NAME_MAX) || "Edge",
    staged_at: now.toISOString(),
    date,
  };
}

/**
 * Stages still waiting on disk from an earlier date (the plugin deferred them for quiet hours or a
 * failed send): their opportunity ids. They go out alongside tonight's, so tonight's budget is cut
 * by their count and their ids are never staged again. A file that cannot be read is counted too
 * (conservative: a card that may go out counts against the ceiling). Never throws.
 */
export function carriedStages(home: string, date: string): Set<string> {
  const carried = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(ratingStageDir(home));
  } catch {
    return carried;
  }
  for (const name of names) {
    if (!/^stage-.+\.json$/.test(name)) continue;
    let stage: Record<string, unknown> = {};
    try {
      stage = asRecord(JSON.parse(readFileSync(join(ratingStageDir(home), name), "utf8")));
    } catch {
      carried.add(`unreadable:${name}`);
      continue;
    }
    if (stage.date === date) continue;
    const id = typeof stage.opportunity_id === "string" ? canonicalId(stage.opportunity_id) : null;
    carried.add(id ?? `unreadable:${name}`);
  }
  return carried;
}

export function ratingStagePath(home: string, opportunityId: string): string {
  return join(ratingStageDir(home), `stage-${opportunityId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** Write the stage by temp file and rename (0600, its directory 0700). Throws on failure. */
export function writeRatingStage(home: string, stage: RatingStage): string {
  const path = ratingStagePath(home, stage.opportunity_id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stage)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

/**
 * `--stage-test --opportunity <id> [--name Maya] [--headline "..."] [--agent Edge] [--home <dir>]`:
 * one stage file, no Index call, no state change. For a developer's own bot. The home is `--home`,
 * else `HERMES_HOME`; never the working directory (a stage written into a checkout is never picked
 * up and would hold a name in a world-readable tree). Returns the lines to print.
 */
export function stageTest(args: string[], home: string | undefined, now = new Date()): string[] {
  if (!home) return ["stage-test: set HERMES_HOME or pass --home <dir>"];
  const id = argValue(args, "--opportunity");
  if (!id || !ENVELOPE_ID.test(id)) return ["stage-test: --opportunity <id> is required (letters, digits, . _ : -)"];
  const stage = ratingStageFor(
    { opportunityId: id },
    { name: argValue(args, "--name") ?? "Maya", headline: argValue(args, "--headline") ?? null, agentName: argValue(args, "--agent") ?? "Edge" },
    villageDate(now),
    now,
  );
  if (!stage) return ["stage-test: nothing staged"];
  const path = writeRatingStage(home, stage);
  return [`stage-test: wrote ${path}`, "stage-test: the av-rate plugin sends the card within about a minute when AV_RATE_CARDS is on"];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--stage-test")) {
    const home = argValue(args, "--home")?.trim() || process.env.HERMES_HOME?.trim() || undefined;
    for (const line of stageTest(args, home)) console.log(line);
  } else {
    console.log("usage: bun skills/index-network/scripts/rating-cards.ts --stage-test --opportunity <id> [--name <name>] [--headline <text>] [--agent <name>] [--home <dir>]");
  }
}
