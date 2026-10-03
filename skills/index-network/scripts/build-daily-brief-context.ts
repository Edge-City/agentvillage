#!/usr/bin/env bun
/**
 * Build deterministic source context for the daily morning brief.
 *
 * The prepare script writes the final prose, but this module owns the
 * mechanical fetching/ranking pieces: admin announcements, today's EdgeOS
 * highlighted events, interest-fill events, local user-model snippets, and
 * Index MCP people/community cards (direct MCP fetch when configured, with a
 * transcript fallback for tests/recovery).
 *
 * Usage (from $HERMES_HOME):
 *   bun skills/index-network/scripts/build-daily-brief-context.ts \
 *     --opportunities-file memory/digest-opportunities.txt \
 *     --state-file memory/heartbeat-state.json \
 *     --out memory/daily-brief-context.json
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { callIndexTool, indexMcpUrl, toolJsonArray, toolJsonObject } from "./index-mcp";
import { portalEventsBaseUrl } from "./validate-digest-urls";

/**
 * Resolve the Index API key.
 *
 * The hermes agent framework does not reliably pass environment variables to
 * cron subprocess chains, so `process.env.INDEX_API_KEY` can be missing (or
 * stale) when this script runs. Fall back to the persisted $HERMES_HOME/.env
 * file, which is the authoritative source written during tenant provisioning
 * and is always available on the pod volume.
 */
export function resolveIndexApiKey(): string | undefined {
  const fromEnv = process.env.INDEX_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const hermesHome = process.env.HERMES_HOME?.trim() || process.cwd();
  const envFile = join(hermesHome, ".env");
  if (!existsSync(envFile)) return undefined;

  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?INDEX_API_KEY\s*=\s*(.*)$/);
      if (!match?.[1]) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (value) {
        console.error("warning: INDEX_API_KEY resolved from .env fallback, not process.env");
        return value;
      }
    }
  } catch {
    // unreadable .env — treat as unavailable
  }
  return undefined;
}

const DEFAULT_EDGEOS_BASE = "https://api.edgeos.world/api/v1";
/** EdgeOS base URL: `$EDGEOS_API_BASE` (local dev points it at a tunnel), else production. */
export function edgeosBase(): string {
  return (process.env.EDGEOS_API_BASE?.trim() || DEFAULT_EDGEOS_BASE).replace(/\/+$/, "");
}
/** Edge City India 2026 — Mandrem, Goa. All brief/cron day boundaries and displayed times use this zone. */
const VILLAGE_TZ = "Asia/Kolkata";

const EDGE_TAGS = [
  "Consciousness",
  "Health & Longevity",
  "Wellbeing",
  "Bio & Neuro",
  "AI",
  "Governance & Coordination",
  "Hard Tech",
  "Privacy",
  "d/acc",
  "Art & Culture",
  "Decentralized Tech",
  "Creative AI & Technologies",
  "Spatial Computing",
  "New Urbanism",
  "Education",
  "Energy & Climate",
  "Food Systems",
];

const TAG_KEYWORDS: Record<string, string[]> = {
  "Health & Longevity": ["health", "longevity", "aging", "wellness", "medicine", "biotech"],
  "Bio & Neuro": ["bio", "biology", "neuro", "brain", "buck", "science", "lab"],
  AI: ["ai", "agent", "agents", "llm", "machine learning", "model", "automation"],
  "Governance & Coordination": ["governance", "coordination", "consent", "collective", "decision", "polis"],
  "Hard Tech": ["hardware", "robotics", "manufacturing", "hard tech", "engineering"],
  Privacy: ["privacy", "security", "cryptography", "zero knowledge", "zk"],
  "Decentralized Tech": ["decentralized", "protocol", "crypto", "web3", "network", "p2p"],
  "Creative AI & Technologies": ["creative", "art", "design", "media", "generative"],
  "Spatial Computing": ["spatial", "xr", "ar", "vr", "metaverse"],
  "New Urbanism": ["urban", "city", "town", "housing", "real estate"],
  Education: ["education", "learning", "school", "children", "kids"],
  "Energy & Climate": ["energy", "climate", "solar", "carbon", "environment"],
  "Food Systems": ["food", "agriculture", "farming", "nutrition"],
  Consciousness: ["consciousness", "meditation", "mindfulness", "meaning"],
  Wellbeing: ["wellbeing", "fitness", "workout", "sauna", "breathwork"],
  "d/acc": ["d/acc", "defensive acceleration", "biosecurity"],
  "Art & Culture": ["art", "culture", "music", "film", "storytelling"],
};

const INTERNAL_VISIBLE_WORD_PATTERN = /\b(?:bias|intents?|signals?|index|opportunit(?:y|ies)|match(?:es|ing)?|networking)\b/i;

export interface DailyBriefWeather {
  forecast: string;
  emoji: string;
  source: "open-meteo" | "unavailable";
}

export interface BriefAnnouncement {
  id?: string;
  body: string;
  priority?: number;
}

export interface BriefEvent {
  id?: string;
  title: string;
  startTime: string;
  endTime?: string | null;
  timeLocal: string;
  venue?: string | null;
  eventUrl?: string | null;
  tags: string[];
  highlighted: boolean;
  reasonHint: string;
}

export interface BriefQuestion {
  id: string;
  title: string;
  prompt: string;
  mode: string;
}

export interface BriefOpportunity {
  name: string;
  mainText?: string;
  status?: string;
  profileUrl?: string;
  acceptUrl?: string;
  /** Deep-link to the A2A negotiation trace that produced this opportunity. */
  negotiationUrl?: string;
  feedCategory?: string;
  opportunityId?: string;
  /** Counterpart user id, when the tool returned one or a `/u/<uuid>` profile URL. */
  userId?: string;
  /** Signal id, when the tool returned one. */
  intentId?: string;
  /** `https://index.network/u/<userId>`. */
  userUrl?: string;
  /** `https://index.network/o/<opportunityId>`. */
  opportunityUrl?: string;
  /** `https://index.network/i/<intentId>`. */
  intentUrl?: string;
  /** Short label from `list_opportunities`. */
  headline?: string;
  /** App state word, such as "waiting on you". */
  stateLabel?: string;
  confidence?: number;
  /** Cooldown re-show — the user has already seen this card in a previous digest. */
  redelivery?: boolean;
}

export interface BriefUserModel {
  phrases: string[];
  interestTags: string[];
}

export interface DailyBriefContext {
  date: string;
  displayDate: string;
  timezone: "Asia/Kolkata";
  announcements: BriefAnnouncement[];
  rsvpEvents: BriefEvent[];
  highlightedEvents: BriefEvent[];
  interestEvents: BriefEvent[];
  opportunities: BriefOpportunity[];
  connectionOpportunities: BriefOpportunity[];
  communityOpportunities: BriefOpportunity[];
  userModel: BriefUserModel;
  weather?: DailyBriefWeather;
  questions?: BriefQuestion[];
  diagnostics: {
    announcementsSource: "control-plane" | "unavailable";
    calendarSource: "edgeos" | "unavailable";
    rsvpSource: "edgeos" | "unavailable";
    opportunitySource: "mcp" | "file" | "unavailable";
    questionSource?: "mcp" | "unavailable";
    weatherSource?: "open-meteo" | "nws" | "unavailable";
    /** True only when today's discovery run finished. */
    dreamingFresh?: boolean;
    warnings: string[];
    interestTags: string[];
  };
}

const HIGHLIGHTED_EVENT_LIMIT = 6;
const DISCOVERY_EVENT_TARGET = 6;
const RSVP_EVENT_LIMIT = 6;
/** Days a delivered question stays out of the digest before being re-offered. */
export const QUESTION_COOLDOWN_DAYS = 3;
/** Direct conversations included in the morning brief. */
export const MORNING_CONNECTION_LIMIT = 3;
const INDEX_WEB = "https://index.network";
const USER_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]+$/;
const OPPORTUNITY_STATE: Record<string, string> = {
  pending: "waiting on you",
  negotiating: "agents talking",
  accepted: "connected",
  rejected: "passed",
  expired: "expired",
};

type EdgeEvent = Record<string, unknown> & {
  id?: string;
  title?: string;
  start_time?: string;
  end_time?: string | null;
  tags?: string[];
  highlighted?: boolean;
  venue_title?: string | null;
  custom_location_name?: string | null;
  host_display_name?: string | null;
};

export function villageDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VILLAGE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function parseDateParts(date: string): { year: number; month: number; day: number } {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`expected YYYY-MM-DD date, got ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function addDays(date: string, days: number): string {
  const { year, month, day } = parseDateParts(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function timeZoneOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: VILLAGE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const zonedAsUtc = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(lookup.hour),
    Number(lookup.minute),
    Number(lookup.second),
  );
  return zonedAsUtc - instant.getTime();
}

function villageLocalTimeToUtc(date: string, hour = 0): Date {
  const { year, month, day } = parseDateParts(date);
  const utcGuess = Date.UTC(year, month - 1, day, hour);
  const firstPass = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess)));
  return new Date(utcGuess - timeZoneOffsetMs(firstPass));
}

export function displayDate(date: string): string {
  const d = villageLocalTimeToUtc(date, 12);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: VILLAGE_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(d);
}

export function villageDayBounds(date: string): { startIso: string; endIso: string } {
  const start = villageLocalTimeToUtc(date, 0);
  const end = villageLocalTimeToUtc(addDays(date, 1), 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function formatVillageTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: VILLAGE_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

export function extractInterestTags(text: string): string[] {
  const haystack = text.toLowerCase();
  const scored = EDGE_TAGS.map((tag) => {
    const keywords = TAG_KEYWORDS[tag] ?? [tag.toLowerCase()];
    const score = keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword.toLowerCase()) ? 1 : 0), 0);
    return { tag, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  return scored.map((entry) => entry.tag).slice(0, 6);
}

function stripMarkdownNoise(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*[-*]\s+/, " ")
    .replace(/[`*_>#]+/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractUserModelPhrases(text: string, interestTags: string[]): string[] {
  const keywords = new Set<string>();
  for (const tag of interestTags) {
    keywords.add(tag.toLowerCase());
    for (const keyword of TAG_KEYWORDS[tag] ?? []) keywords.add(keyword.toLowerCase());
  }
  if (keywords.size === 0) return [];

  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripMarkdownNoise(rawLine);
    if (line.length < 8 || line.length > 180) continue;
    if (/^(date|tags?|notes?|memory|user|today)\s*:/i.test(line)) continue;
    const lower = line.toLowerCase();
    if (INTERNAL_VISIBLE_WORD_PATTERN.test(lower)) continue;
    if (![...keywords].some((keyword) => lower.includes(keyword))) continue;
    const sentence = line.split(/(?<=[.!?])\s+/)[0]?.trim() ?? line;
    const phrase = sentence.length > 120 ? `${sentence.slice(0, 119).trimEnd()}…` : sentence;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
    if (phrases.length >= 3) break;
  }
  return phrases;
}

function eventVenue(event: EdgeEvent): string | null {
  return event.venue_title ?? event.custom_location_name ?? null;
}

function eventUrl(event: EdgeEvent): string | null {
  const base = portalEventsBaseUrl();
  return base && event.id ? `${base}/${event.id}` : null;
}

function eventScore(event: EdgeEvent, interestTags: string[]): number {
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const title = String(event.title ?? "").toLowerCase();
  let score = 0;
  for (const tag of interestTags) {
    if (tags.includes(tag)) score += 3;
    for (const keyword of TAG_KEYWORDS[tag] ?? []) {
      if (title.includes(keyword.toLowerCase())) score += 1;
    }
  }
  return score;
}

function toBriefEvent(event: EdgeEvent, reasonHint: string): BriefEvent | null {
  if (!event.title || !event.start_time) return null;
  return {
    id: event.id,
    title: event.title,
    startTime: event.start_time,
    endTime: event.end_time,
    timeLocal: formatVillageTime(event.start_time),
    venue: eventVenue(event),
    eventUrl: eventUrl(event),
    tags: Array.isArray(event.tags) ? event.tags : [],
    highlighted: event.highlighted === true,
    reasonHint,
  };
}

export function selectEvents(events: EdgeEvent[], interestTags: string[]): { highlightedEvents: BriefEvent[]; interestEvents: BriefEvent[] } {
  const byStart = [...events].sort((a, b) => String(a.start_time ?? "").localeCompare(String(b.start_time ?? "")));
  const highlightedEvents = byStart
    .filter((event) => event.highlighted === true)
    .map((event) => toBriefEvent(event, "Highlighted by the EdgeOS calendar."))
    .filter((event): event is BriefEvent => Boolean(event))
    .slice(0, HIGHLIGHTED_EVENT_LIMIT);

  const used = new Set(highlightedEvents.map((event) => event.id ?? `${event.title}:${event.startTime}`));
  const scored = byStart
    .filter((event) => !used.has(event.id ?? `${event.title}:${event.start_time}`))
    .map((event) => ({ event, score: eventScore(event, interestTags) }))
    .sort((a, b) => b.score - a.score || String(a.event.start_time ?? "").localeCompare(String(b.event.start_time ?? "")));

  const fillCount = Math.max(0, DISCOVERY_EVENT_TARGET - highlightedEvents.length);
  const interestEvents = scored
    .filter((entry) => highlightedEvents.length === 0 || entry.score > 0)
    .slice(0, fillCount)
    .map((entry) =>
      toBriefEvent(
        entry.event,
        entry.score > 0 ? "Selected because it overlaps with the user's known interests." : "Useful village event today.",
      ),
    )
    .filter((event): event is BriefEvent => Boolean(event));

  return { highlightedEvents, interestEvents };
}

function decodeJsonStringLiteral(raw: string): string | null {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

function extractMessageFieldFromMalformedJson(text: string): string | null {
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/s);
  if (!match) return null;
  return decodeJsonStringLiteral(match[1]);
}

function unwrapOpportunityTranscript(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      data?: { message?: unknown };
    };
    const message = typeof parsed.data?.message === "string"
      ? parsed.data.message
      : typeof parsed.message === "string"
        ? parsed.message
        : "";
    return message || text;
  } catch {
    return extractMessageFieldFromMalformedJson(trimmed) ?? text;
  }
}

export function parseOpportunityTranscript(text: string): BriefOpportunity[] {
  const transcript = unwrapOpportunityTranscript(text);
  const cards: BriefOpportunity[] = [];
  let current: BriefOpportunity | null = null;

  const flush = () => {
    if (current?.name) cards.push(current);
    current = null;
  };

  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const header = line.match(/^\d+\.\s+(.+)$/);
    if (header) {
      flush();
      current = { name: header[1].trim() };
      continue;
    }
    if (!current) continue;

    const marker = line.trim().match(/^<!--\s*digest-opportunity:id=([^\s>]+)\s*-->$/);
    if (marker) {
      current.opportunityId = marker[1];
      continue;
    }

    const field = line.trim().match(/^(status|profileUrl|acceptUrl|negotiationUrl|feedCategory|opportunityId|userId|intentId|confidence|redelivery):\s*(.+)$/);
    if (field) {
      const key = field[1] as keyof BriefOpportunity;
      if (key === "confidence") {
        const val = parseFloat(field[2].trim());
        if (!isNaN(val)) current[key] = val;
      } else if (key === "redelivery") {
        current.redelivery = field[2].trim() === "true";
      } else {
        current[key] = field[2].trim();
      }
      continue;
    }

    const body = line.trim();
    if (body && !body.startsWith("Summarize ") && !body.startsWith("For each ")) {
      current.mainText = current.mainText ? `${current.mainText} ${body}` : body;
    }
  }
  flush();
  return cards;
}

export function filterDedupedOpportunities(opportunities: BriefOpportunity[], deliveredIds: Set<string>): BriefOpportunity[] {
  return opportunities.filter((opp) => !opp.opportunityId || !deliveredIds.has(opp.opportunityId));
}

/**
 * Statuses a digest card may carry and still be actionable for the recipient.
 * Live `list_opportunities` cards that are waiting on the user are `pending`.
 * `draft` and `latent` stay so older transcript files still render. Anything
 * else — notably `negotiating` (agents still talking), `stalled`, `expired`,
 * `rejected`, and `accepted` — stays out of the morning brief.
 */
const ACTIONABLE_DIGEST_STATUSES = new Set(["draft", "pending", "latent"]);

/**
 * Drop cards whose status is present and not digest-actionable.
 *
 * Cards with a missing status are kept: the fresh MCP path is already
 * status-filtered server-side, and legacy `--opportunities-file` transcripts
 * may predate the `status:` field — dropping them wholesale would silently
 * empty the brief. The guard exists chiefly for the file-replay path, where a
 * stale snapshot can carry cards that stalled/expired after it was written.
 */
export function filterActionableOpportunities(opportunities: BriefOpportunity[]): BriefOpportunity[] {
  return opportunities.filter(
    (opp) => !opp.status || ACTIONABLE_DIGEST_STATUSES.has(opp.status.trim().toLowerCase()),
  );
}

/** Fresh cards before cooldown re-shows, then highest confidence. Stable for ties. */
export function selectMorningConnections(opportunities: BriefOpportunity[]): BriefOpportunity[] {
  return opportunities
    .filter((opp) => opp.feedCategory === "connection")
    .sort((a, b) => {
      if (Boolean(a.redelivery) !== Boolean(b.redelivery)) return a.redelivery ? 1 : -1;
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    })
    .slice(0, MORNING_CONNECTION_LIMIT);
}

function userIdFromProfile(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const id = new URL(url).pathname.match(/^\/u\/([0-9a-fA-F-]{36})\/?$/)?.[1];
    return id && USER_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** An Index page link of one kind: `/o/` opportunity, `/u/` person, `/i/` signal. */
const INDEX_LINK = /^https:\/\/index\.network\/([oui])\/[A-Za-z0-9_-]+$/;

/** A supplied link kept only when it is an Index link of this kind; else rebuilt from a valid id; else none. */
export function indexLink(kind: "o" | "u" | "i", supplied: string | undefined, id: string | undefined): string | undefined {
  if (typeof supplied === "string" && supplied.match(INDEX_LINK)?.[1] === kind) return supplied;
  return id && ENTITY_ID.test(id) ? `${INDEX_WEB}/${kind}/${id}` : undefined;
}

function setOrDrop<K extends keyof BriefOpportunity>(card: BriefOpportunity, key: K, value: BriefOpportunity[K] | undefined): void {
  if (value === undefined) delete card[key];
  else card[key] = value;
}

/**
 * Attach Index web links from ids the tool already returned. Every path that
 * emits a card (brief, drop, evening card, follow-up) goes through here, so
 * this is the one place a link or id from Index is checked: a link that is
 * not an Index page of its kind is rebuilt from a valid id or dropped, and an
 * id that is not a valid id is dropped.
 */
export function attachIndexLinks(opp: BriefOpportunity): BriefOpportunity {
  const next = { ...opp };
  const profileUrl = indexLink("u", opp.profileUrl, undefined);
  const userId = opp.userId && USER_ID.test(opp.userId) ? opp.userId : userIdFromProfile(profileUrl);
  const opportunityId = opp.opportunityId && ENTITY_ID.test(opp.opportunityId) ? opp.opportunityId : undefined;
  const intentId = opp.intentId && ENTITY_ID.test(opp.intentId) ? opp.intentId : undefined;
  setOrDrop(next, "profileUrl", profileUrl);
  setOrDrop(next, "userId", userId);
  setOrDrop(next, "opportunityId", opportunityId);
  setOrDrop(next, "intentId", intentId);
  setOrDrop(next, "userUrl", indexLink("u", opp.userUrl, userId));
  setOrDrop(next, "opportunityUrl", indexLink("o", opp.opportunityUrl, opportunityId));
  setOrDrop(next, "intentUrl", indexLink("i", opp.intentUrl, intentId));
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function listedCard(row: Record<string, unknown>): BriefOpportunity | null {
  const peer = asRecord(row.peer);
  const name = typeof peer?.name === "string" ? peer.name.trim() : "";
  if (!name) return null;
  const headline = typeof row.headline === "string" ? row.headline.trim() : "";
  const summary = typeof row.summary === "string" ? row.summary.trim() : "";
  const status = typeof row.status === "string" ? row.status.trim() : "";
  const viewerRole = typeof row.viewerRole === "string" ? row.viewerRole : "";
  const userUrl = typeof peer?.url === "string" ? peer.url : undefined;
  const opportunityUrl = typeof row.url === "string" ? row.url : undefined;
  const userId = typeof peer?.userId === "string" ? peer.userId : undefined;
  const opportunityId = typeof row.id === "string" ? row.id : undefined;
  return {
    name,
    headline: headline || undefined,
    mainText: summary || headline || "New match",
    status: status || undefined,
    stateLabel: OPPORTUNITY_STATE[status.toLowerCase()],
    userUrl,
    opportunityUrl,
    userId,
    opportunityId,
    profileUrl: userUrl,
    feedCategory: viewerRole === "agent" ? "connector-flow" : "connection",
  };
}

/**
 * Read a `list_opportunities` result: a markdown lead, then JSON
 * `{ success, opportunities: [...], pagination }` (an empty array when nothing
 * is waiting). Throws `mcp-tool-error` on `success: false` and `mcp-unparsed`
 * when the object or the array is missing, so a failure is never "no cards".
 */
export function parseListedOpportunities(text: string): BriefOpportunity[] {
  return toolJsonArray(text, "opportunities")
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map(listedCard)
    .filter((card): card is BriefOpportunity => Boolean(card));
}

export async function readDreamingDate(stateFile: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(stateFile).text()) as { dreaming?: { lastRunDate?: unknown } };
    return typeof parsed.dreaming?.lastRunDate === "string" ? parsed.dreaming.lastRunDate : undefined;
  } catch {
    return undefined;
  }
}

export async function writeDreamingDate(stateFile: string, date: string): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await Bun.file(stateFile).text()) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw as Record<string, unknown>;
  } catch {
    // missing state starts as an empty object
  }
  const dreaming = parsed.dreaming && typeof parsed.dreaming === "object" && !Array.isArray(parsed.dreaming)
    ? { ...(parsed.dreaming as Record<string, unknown>) }
    : {};
  dreaming.lastRunDate = date;
  parsed.dreaming = dreaming;
  await Bun.write(stateFile, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

async function readDeliveredIds(stateFile: string, date: string): Promise<Set<string>> {
  try {
    const raw = await Bun.file(stateFile).text();
    const parsed = JSON.parse(raw) as { deliveredToday?: { date?: string; ids?: unknown } };
    if (parsed.deliveredToday?.date === date && Array.isArray(parsed.deliveredToday.ids)) {
      return new Set(parsed.deliveredToday.ids.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    // missing/malformed state should not block the brief
  }
  return new Set();
}

/** Whole days from `earlier` to `later` (both YYYY-MM-DD); negative when `earlier` is after `later`. */
function daysBetween(earlier: string, later: string): number {
  const a = parseDateParts(earlier);
  const b = parseDateParts(later);
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.floor(ms / 86_400_000);
}

/**
 * Drop questions delivered within the last QUESTION_COOLDOWN_DAYS days.
 * A question with a future-dated delivery entry (clock skew) is also dropped —
 * never re-spam on ambiguity. Undelivered questions always pass.
 */
export function filterCooldownQuestions(
  questions: BriefQuestion[],
  delivery: Record<string, string>,
  date: string,
): BriefQuestion[] {
  return questions.filter((q) => {
    const deliveredOn = delivery[q.id];
    if (!deliveredOn) return true;
    return daysBetween(deliveredOn, date) >= QUESTION_COOLDOWN_DAYS;
  });
}

async function fetchOpenMeteoWeather(date: string): Promise<DailyBriefWeather> {
  const params = new URLSearchParams({
    latitude: String(MANDREM_LAT),
    longitude: String(MANDREM_LON),
    daily: "temperature_2m_max,weather_code",
    temperature_unit: "celsius",
    timezone: VILLAGE_TZ,
    start_date: date,
    end_date: date,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    daily?: { temperature_2m_max?: number[]; weather_code?: number[] };
  };
  const high = data.daily?.temperature_2m_max?.[0];
  const code = data.daily?.weather_code?.[0];
  if (high == null || code == null) throw new Error("missing daily forecast data");
  const mapping = WEATHER_CODE_MAP[code] ?? { description: "mixed conditions", emoji: "🌤️" };
  return {
    forecast: `Expect ${mapping.description} and a high of ${Math.round(high)}°C`,
    emoji: mapping.emoji,
    source: "open-meteo",
  };
}

async function fetchWeather(date: string, warnings: string[]): Promise<DailyBriefWeather> {
  try {
    return await fetchOpenMeteoWeather(date);
  } catch (err) {
    warnings.push(`open-meteo weather unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { forecast: "", emoji: "", source: "unavailable" };
  }
}

async function fetchAnnouncements(date: string, warnings: string[]): Promise<{ source: "control-plane" | "unavailable"; announcements: BriefAnnouncement[] }> {
  const base = process.env.EDGE_AGENT_CONTROL_PLANE_URL?.replace(/\/$/, "");
  const token = process.env.ADMIN_TOKEN;
  if (!base || !token) return { source: "unavailable", announcements: [] };
  try {
    const res = await fetch(`${base}/brief/announcements?date=${encodeURIComponent(date)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = (await res.json()) as { announcements?: Array<{ id?: string; body?: string; priority?: number }> };
    return {
      source: "control-plane",
      announcements: (data.announcements ?? [])
        .filter((item) => typeof item.body === "string" && item.body.trim())
        .map((item) => ({ id: item.id, body: item.body!.trim(), priority: item.priority })),
    };
  } catch (err) {
    warnings.push(`announcements unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { source: "unavailable", announcements: [] };
  }
}

async function fetchEvents(date: string, interestTags: string[], warnings: string[]): Promise<{ source: "edgeos" | "unavailable"; highlightedEvents: BriefEvent[]; interestEvents: BriefEvent[] }> {
  const token = process.env.EDGEOS_API_KEY;
  const popupId = process.env.AV_POPUP_ID?.trim();
  if (!token || !popupId) return { source: "unavailable", highlightedEvents: [], interestEvents: [] };
  const { startIso, endIso } = villageDayBounds(date);
  const params = new URLSearchParams({
    popup_id: popupId,
    event_status: "published",
    start_after: startIso,
    start_before: endIso,
    limit: "100",
  });
  try {
    const res = await fetch(`${edgeosBase()}/events/portal/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = (await res.json()) as { results?: EdgeEvent[] };
    const { highlightedEvents, interestEvents } = selectEvents(data.results ?? [], interestTags);
    return { source: "edgeos", highlightedEvents, interestEvents };
  } catch (err) {
    warnings.push(`calendar unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { source: "unavailable", highlightedEvents: [], interestEvents: [] };
  }
}

async function fetchRsvps(date: string, warnings: string[]): Promise<{ source: "edgeos" | "unavailable"; rsvpEvents: BriefEvent[] }> {
  const token = process.env.EDGEOS_API_KEY;
  const popupId = process.env.AV_POPUP_ID?.trim();
  if (!token || !popupId) return { source: "unavailable", rsvpEvents: [] };
  const { startIso, endIso } = villageDayBounds(date);
  const params = new URLSearchParams({
    popup_id: popupId,
    event_status: "published",
    rsvped_only: "true",
    start_after: startIso,
    start_before: endIso,
    limit: "100",
  });
  try {
    const res = await fetch(`${edgeosBase()}/events/portal/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = (await res.json()) as { results?: EdgeEvent[] };
    const rsvpEvents = [...(data.results ?? [])]
      .sort((a, b) => String(a.start_time ?? "").localeCompare(String(b.start_time ?? "")))
      .map((event) => toBriefEvent(event, "You RSVPed to this."))
      .filter((event): event is BriefEvent => Boolean(event))
      .slice(0, RSVP_EVENT_LIMIT);
    return { source: "edgeos", rsvpEvents };
  } catch (err) {
    warnings.push(`rsvps unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { source: "unavailable", rsvpEvents: [] };
  }
}

/** Mandrem, Goa, India — Edge City India 2026 location. */
const MANDREM_LAT = 15.66;
const MANDREM_LON = 73.71;

/**
 * Map WMO weather codes to human-readable descriptions and emojis.
 * https://www.nodc.noaa.gov/archive/arc0021/0002199/1.1/data/0-data/HTML/WMO-CODE/WMO4677.HTM
 */
const WEATHER_CODE_MAP: Record<number, { description: string; emoji: string }> = {
  0: { description: "sunshine all day", emoji: "☀️" },
  1: { description: "mostly clear skies", emoji: "🌤️" },
  2: { description: "partly cloudy skies", emoji: "⛅" },
  3: { description: "overcast skies", emoji: "☁️" },
  45: { description: "fog", emoji: "🌫️" },
  48: { description: "depositing rime fog", emoji: "🌫️" },
  51: { description: "light drizzle", emoji: "🌧️" },
  53: { description: "moderate drizzle", emoji: "🌧️" },
  55: { description: "dense drizzle", emoji: "🌧️" },
  56: { description: "light freezing drizzle", emoji: "🌧️" },
  57: { description: "dense freezing drizzle", emoji: "🌧️" },
  61: { description: "light rain", emoji: "🌧️" },
  63: { description: "moderate rain", emoji: "🌧️" },
  65: { description: "heavy rain", emoji: "🌧️" },
  66: { description: "light freezing rain", emoji: "🌧️" },
  67: { description: "heavy freezing rain", emoji: "🌧️" },
  71: { description: "light snow", emoji: "❄️" },
  73: { description: "moderate snow", emoji: "❄️" },
  75: { description: "heavy snow", emoji: "❄️" },
  77: { description: "snow grains", emoji: "❄️" },
  80: { description: "rain showers", emoji: "🌦️" },
  81: { description: "moderate rain showers", emoji: "🌦️" },
  82: { description: "violent rain showers", emoji: "🌦️" },
  85: { description: "light snow showers", emoji: "🌨️" },
  86: { description: "heavy snow showers", emoji: "🌨️" },
  95: { description: "thunderstorms", emoji: "⛈️" },
  96: { description: "thunderstorms with light hail", emoji: "⛈️" },
  99: { description: "thunderstorms with heavy hail", emoji: "⛈️" },
};

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

/**
 * Fetch opportunities by calling Index `list_opportunities` directly.
 * Pending cards are the ones waiting on the user. The tool returns a markdown
 * lead plus JSON cards (`url`, `peer.url`, `headline`, `summary`). Any failure
 * throws (see parseListedOpportunities); an empty array is the only "none".
 */
export async function fetchOpportunitiesFromMcp(opts: {
  apiKey: string;
  mcpUrl: string;
}): Promise<BriefOpportunity[]> {
  const text = await callIndexTool(opts, "list_opportunities", { statuses: ["pending"], limit: 20 });
  const root = toolJsonObject(text);
  if (root?.success === false) {
    const errorText = typeof root.error === "string" ? root.error : "";
    const messageText = typeof root.message === "string" ? root.message : "";
    if (/onboarding required|not completed onboarding/i.test(`${errorText}\n${messageText}`)) {
      throw new Error("setup required before people suggestions");
    }
  }
  return parseListedOpportunities(text);
}

export async function buildDailyBriefContext(options: {
  date?: string;
  stateFile?: string;
  opportunitiesFile?: string;
  userFiles?: string[];
} = {}): Promise<DailyBriefContext> {
  const date = options.date ?? villageDate();
  const warnings: string[] = [];
  const userFiles = options.userFiles ?? ["USER.md", "MEMORY.md", `memory/${date}.md`];
  const interestText = (await Promise.all(userFiles.map(readIfExists))).join("\n");
  const interestTags = extractInterestTags(interestText);
  const userModel: BriefUserModel = {
    phrases: extractUserModelPhrases(interestText, interestTags),
    interestTags,
  };

  const [announcementResult, eventResult, rsvpResult, weather] = await Promise.all([
    fetchAnnouncements(date, warnings),
    fetchEvents(date, interestTags, warnings),
    fetchRsvps(date, warnings),
    fetchWeather(date, warnings),
  ]);

  let opportunities: BriefOpportunity[] = [];
  let opportunitySource: "mcp" | "file" | "unavailable" = "unavailable";
  let dreamingFresh = false;

  const apiKey = resolveIndexApiKey();
  const mcpUrl = indexMcpUrl();
  const stateFile = options.stateFile ?? "memory/heartbeat-state.json";

  if (apiKey) {
    try {
      const deliveredIds = await readDeliveredIds(stateFile, date);
      const fetched = await fetchOpportunitiesFromMcp({ apiKey, mcpUrl });
      const deduped = filterDedupedOpportunities(fetched, deliveredIds);
      opportunities = filterActionableOpportunities(deduped);
      if (opportunities.length < deduped.length) {
        warnings.push(
          `dropped ${deduped.length - opportunities.length} non-actionable opportunity card(s) (status outside draft/pending/latent)`,
        );
      }
      opportunitySource = "mcp";
      dreamingFresh = true;
      if ((await readDreamingDate(stateFile)) !== date && (existsSync(stateFile) || existsSync(dirname(stateFile)))) {
        try {
          await writeDreamingDate(stateFile, date);
        } catch (err) {
          warnings.push(`dreaming state not written: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      warnings.push(`opportunities MCP unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (options.opportunitiesFile) {
    const transcript = await readIfExists(options.opportunitiesFile);
    if (transcript.trim()) {
      opportunitySource = "file";
      const deliveredIds = await readDeliveredIds(stateFile, date);
      const deduped = filterDedupedOpportunities(parseOpportunityTranscript(transcript), deliveredIds);
      opportunities = filterActionableOpportunities(deduped);
      if (opportunities.length < deduped.length) {
        warnings.push(
          `dropped ${deduped.length - opportunities.length} non-actionable opportunity card(s) (status outside draft/pending/latent)`,
        );
      }
    }
  }

  const questions: BriefQuestion[] = [];
  const questionSource: "mcp" | "unavailable" = "unavailable";

  const connectionOpportunities = selectMorningConnections(opportunities).map(attachIndexLinks);
  const communityOpportunities = opportunities
    .filter((opp) => opp.feedCategory === "connector-flow")
    .map(attachIndexLinks);

  return {
    date,
    displayDate: displayDate(date),
    timezone: VILLAGE_TZ,
    announcements: announcementResult.announcements,
    rsvpEvents: rsvpResult.rsvpEvents,
    highlightedEvents: eventResult.highlightedEvents,
    interestEvents: eventResult.interestEvents,
    opportunities: [...connectionOpportunities, ...communityOpportunities],
    connectionOpportunities,
    communityOpportunities,
    userModel,
    weather: weather.source !== "unavailable" ? weather : undefined,
    questions,
    diagnostics: {
      announcementsSource: announcementResult.source,
      calendarSource: eventResult.source,
      rsvpSource: rsvpResult.source,
      opportunitySource,
      questionSource,
      weatherSource: weather.source,
      dreamingFresh,
      warnings,
      interestTags,
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const context = await buildDailyBriefContext({
    date: argValue(args, "--date"),
    stateFile: argValue(args, "--state-file"),
    opportunitiesFile: argValue(args, "--opportunities-file"),
    userFiles: args.includes("--user-file")
      ? args
          .flatMap((arg, idx) => (arg === "--user-file" ? [args[idx + 1]] : []))
          .filter((path): path is string => Boolean(path))
      : undefined,
  });

  const json = `${JSON.stringify(context, null, 2)}\n`;
  const out = argValue(args, "--out");
  if (out) {
    await Bun.write(out, json);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.main) {
  await main();
}
