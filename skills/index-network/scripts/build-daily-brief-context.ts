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
import { join } from "node:path";

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

const POPUP_ID = "43746fd0-bce2-472b-93e4-a438177b2dff";
const EDGEOS_BASE = "https://api.edgeos.world/api/v1";
const EDGE_ESMERALDA_EVENT_BASE_URL = "https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events";
const PACIFIC_TZ = "America/Los_Angeles";

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
  source: "open-meteo" | "nws" | "unavailable";
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
  timePacific: string;
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
  timezone: "America/Los_Angeles";
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
    warnings: string[];
    interestTags: string[];
  };
}

const HIGHLIGHTED_EVENT_LIMIT = 6;
const DISCOVERY_EVENT_TARGET = 6;
const RSVP_EVENT_LIMIT = 6;
/** How many pending questions to fetch per digest run (tool caps at 10). */
const QUESTION_FETCH_LIMIT = 5;
/** Hard cap on a question prompt interpolated into the digest body. */
const QUESTION_PROMPT_MAX_LENGTH = 300;
/** Marker-safe question id shape — ids are interpolated into <!-- digest-question:id=… --> markers. */
const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Days a delivered question stays out of the digest before being re-offered. */
export const QUESTION_COOLDOWN_DAYS = 3;

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

export function pacificDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TZ,
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
    timeZone: PACIFIC_TZ,
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

function pacificLocalTimeToUtc(date: string, hour = 0): Date {
  const { year, month, day } = parseDateParts(date);
  const utcGuess = Date.UTC(year, month - 1, day, hour);
  const firstPass = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess)));
  return new Date(utcGuess - timeZoneOffsetMs(firstPass));
}

export function displayDate(date: string): string {
  const d = pacificLocalTimeToUtc(date, 12);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(d);
}

export function pacificDayBounds(date: string): { startIso: string; endIso: string } {
  const start = pacificLocalTimeToUtc(date, 0);
  const end = pacificLocalTimeToUtc(addDays(date, 1), 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function formatPacificTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
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
  return event.id ? `${EDGE_ESMERALDA_EVENT_BASE_URL}/${event.id}` : null;
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
    timePacific: formatPacificTime(event.start_time),
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

    const field = line.trim().match(/^(status|profileUrl|acceptUrl|negotiationUrl|feedCategory|opportunityId|confidence|redelivery):\s*(.+)$/);
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
 * Read the cross-day question delivery log (`questionDelivery`:
 * `{ [questionId]: "YYYY-MM-DD" }`) from heartbeat state. Unlike
 * `deliveredToday`, entries persist across days — a question stays pending on
 * Index until answered, so dedup must outlive a single date. Defensive like
 * readDeliveredIds: missing/malformed state never blocks the brief.
 */
async function readQuestionDelivery(stateFile: string): Promise<Record<string, string>> {
  try {
    const raw = await Bun.file(stateFile).text();
    const parsed = JSON.parse(raw) as { questionDelivery?: unknown };
    if (parsed.questionDelivery && typeof parsed.questionDelivery === "object" && !Array.isArray(parsed.questionDelivery)) {
      return Object.fromEntries(
        Object.entries(parsed.questionDelivery as Record<string, unknown>)
          .filter((entry): entry is [string, string] =>
            Boolean(entry[0]) && typeof entry[1] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry[1])),
      );
    }
  } catch {
    // missing/malformed state should not block the brief
  }
  return {};
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
    latitude: String(HEALDSBURG_LAT),
    longitude: String(HEALDSBURG_LON),
    daily: "temperature_2m_max,weather_code",
    temperature_unit: "fahrenheit",
    timezone: PACIFIC_TZ,
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
    forecast: `Expect ${mapping.description} and a high of ${Math.round(high)}°F`,
    emoji: mapping.emoji,
    source: "open-meteo",
  };
}

function nwsEmoji(shortForecast: string): string {
  const text = shortForecast.toLowerCase();
  if (text.includes("thunder")) return "⛈️";
  if (text.includes("rain") || text.includes("shower")) return "🌦️";
  if (text.includes("snow")) return "❄️";
  if (text.includes("fog")) return "🌫️";
  if (text.includes("sunny") || text.includes("clear")) return "☀️";
  if (text.includes("cloud")) return text.includes("partly") || text.includes("mostly") ? "⛅" : "☁️";
  return "🌤️";
}

async function fetchNwsWeather(date: string): Promise<DailyBriefWeather> {
  const headers = { "User-Agent": "AgentVillage daily digest (https://github.com/Edge-City/agentvillage)" };
  const pointRes = await fetch(`https://api.weather.gov/points/${HEALDSBURG_LAT},${HEALDSBURG_LON}`, { headers });
  if (!pointRes.ok) throw new Error(`${pointRes.status} ${pointRes.statusText}`);
  const pointData = (await pointRes.json()) as { properties?: { forecast?: string } };
  if (!pointData.properties?.forecast) throw new Error("missing NWS forecast URL");

  const forecastRes = await fetch(pointData.properties.forecast, { headers });
  if (!forecastRes.ok) throw new Error(`${forecastRes.status} ${forecastRes.statusText}`);
  const forecastData = (await forecastRes.json()) as {
    properties?: {
      periods?: Array<{ startTime?: string; isDaytime?: boolean; temperature?: number; shortForecast?: string }>;
    };
  };
  const periods = forecastData.properties?.periods ?? [];
  const period = periods.find((p) => p.isDaytime === true && p.startTime && pacificDate(new Date(p.startTime)) === date)
    ?? periods.find((p) => p.isDaytime === true);
  if (!period?.shortForecast || period.temperature == null) throw new Error("missing NWS daytime forecast");
  const description = period.shortForecast.trim().toLowerCase();
  return {
    forecast: `Expect ${description} and a high of ${Math.round(period.temperature)}°F`,
    emoji: nwsEmoji(period.shortForecast),
    source: "nws",
  };
}

async function fetchWeather(date: string, warnings: string[]): Promise<DailyBriefWeather> {
  try {
    return await fetchOpenMeteoWeather(date);
  } catch (err) {
    warnings.push(`open-meteo weather unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    return await fetchNwsWeather(date);
  } catch (err) {
    warnings.push(`nws weather unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
  if (!token) return { source: "unavailable", highlightedEvents: [], interestEvents: [] };
  const { startIso, endIso } = pacificDayBounds(date);
  const params = new URLSearchParams({
    popup_id: POPUP_ID,
    event_status: "published",
    start_after: startIso,
    start_before: endIso,
    limit: "100",
  });
  try {
    const res = await fetch(`${EDGEOS_BASE}/events/portal/events?${params.toString()}`, {
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
  if (!token) return { source: "unavailable", rsvpEvents: [] };
  const { startIso, endIso } = pacificDayBounds(date);
  const params = new URLSearchParams({
    popup_id: POPUP_ID,
    event_status: "published",
    rsvped_only: "true",
    start_after: startIso,
    start_before: endIso,
    limit: "100",
  });
  try {
    const res = await fetch(`${EDGEOS_BASE}/events/portal/events?${params.toString()}`, {
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

/** Healdsburg, CA — Edge Esmeralda location. */
const HEALDSBURG_LAT = 38.6105;
const HEALDSBURG_LON = -122.8686;

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

type McpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

type McpToolResult = {
  content?: Array<{ type: string; text?: string }>;
};

async function postMcpMessage(mcpUrl: string, apiKey: string, body: unknown): Promise<McpJsonRpcResponse> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "x-api-key": apiKey,
      // The digest is always delivered over Telegram (Hermes). Without this
      // header the MCP server coerces the surface to "web", which stamps
      // minted connect links with preferredSurface=web and breaks the
      // click-time t.me deep-link redirect (links land on the web chat
      // fallback instead of opening Telegram). Mirrors install_index.ts's
      // buildIndexMcpHeaders.
      "x-index-surface": "telegram",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    let response: McpJsonRpcResponse | null = null;
    for (const line of text.split("\n")) {
      // SSE spec allows "data:value" with or without the space after the colon.
      const dataLine = line.startsWith("data: ") ? line.slice(6)
                     : line.startsWith("data:") ? line.slice(5)
                     : null;
      if (dataLine !== null) {
        try {
          const msg = JSON.parse(dataLine) as McpJsonRpcResponse;
          // Keep only JSON-RPC responses (have result or error); skip notifications.
          if ("result" in msg || "error" in msg) response = msg;
        } catch { /* skip non-JSON or comment lines */ }
      }
    }
    if (response) return response;
    throw new Error("no JSON-RPC response in MCP SSE stream");
  }

  return (await res.json()) as McpJsonRpcResponse;
}

/**
 * Fetch opportunities by calling the Index MCP server directly via JSON-RPC,
 * bypassing any LLM agent. Uses list_opportunities with includeDigestMarkers:true
 * to receive pre-built profileUrl, acceptUrl, and feedCategory in the text output,
 * then parses through parseOpportunityTranscript — no synthesis possible.
 */
export async function fetchOpportunitiesFromMcp(opts: {
  apiKey: string;
  mcpUrl: string;
}): Promise<BriefOpportunity[]> {
  // Per MCP spec, send initialize before any tool calls.
  const initResp = await postMcpMessage(opts.mcpUrl, opts.apiKey, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agentvillage-digest", version: "1.0.0" },
    },
  });
  if (initResp.error) throw new Error(`MCP initialize: ${initResp.error.message}`);

  const toolResp = await postMcpMessage(opts.mcpUrl, opts.apiKey, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_opportunities", arguments: { includeDigestMarkers: true } },
  });
  if (toolResp.error) throw new Error(`MCP list_opportunities: ${toolResp.error.message}`);

  const result = toolResp.result as McpToolResult | undefined;
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (!text.trim()) return [];

  try {
    const parsed = JSON.parse(text) as { success?: boolean; error?: unknown; message?: unknown };
    const errorText = typeof parsed.error === "string" ? parsed.error : "";
    const messageText = typeof parsed.message === "string" ? parsed.message : "";
    if (parsed.success === false && /onboarding required|not completed onboarding/i.test(`${errorText}\n${messageText}`)) {
      throw new Error("setup required before people suggestions");
    }
  } catch (err) {
    if (err instanceof Error && err.message === "setup required before people suggestions") throw err;
  }

  return parseOpportunityTranscript(text);
}

/**
 * Confirm digest delivery for a set of opportunity ids by calling the Index
 * MCP server's `confirm_opportunity_delivery` tool directly via JSON-RPC.
 *
 * Owned by the deterministic send script (not the LLM prompt) so the delivery
 * ledger is written reliably — a skipped confirm means the same opportunity
 * reappears in later digests. Each id is confirmed independently with one
 * retry; failures never throw, they are reported back for diagnostics.
 *
 * @returns per-id outcome: `confirmed` (includes already_delivered) or `failed` with reason.
 */
export async function confirmOpportunityDeliveriesViaMcp(opts: {
  apiKey: string;
  mcpUrl: string;
  opportunityIds: string[];
}): Promise<{ confirmed: string[]; failed: Array<{ opportunityId: string; reason: string }> }> {
  const confirmed: string[] = [];
  const failed: Array<{ opportunityId: string; reason: string }> = [];
  if (opts.opportunityIds.length === 0) return { confirmed, failed };

  try {
    const initResp = await postMcpMessage(opts.mcpUrl, opts.apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentvillage-digest", version: "1.0.0" },
      },
    });
    if (initResp.error) throw new Error(`MCP initialize: ${initResp.error.message}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { confirmed, failed: opts.opportunityIds.map((opportunityId) => ({ opportunityId, reason })) };
  }

  let rpcId = 2;
  for (const opportunityId of opts.opportunityIds) {
    let lastReason = "unknown";
    let ok = false;
    // `confirm_opportunity_delivery` is idempotent, so transient failures are
    // safe to retry. Permanent failures (opportunity deleted, caller not an
    // actor) carry `retryable: false` — retrying them never succeeds and only
    // hammers the MCP transport, so we stop early and report the reason.
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const resp = await postMcpMessage(opts.mcpUrl, opts.apiKey, {
          jsonrpc: "2.0",
          id: rpcId++,
          method: "tools/call",
          params: {
            name: "confirm_opportunity_delivery",
            arguments: { opportunityId, trigger: "digest" },
          },
        });
        if (resp.error) {
          lastReason = resp.error.message;
          continue;
        }
        const result = resp.result as McpToolResult | undefined;
        const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
        // The tool returns a success/error envelope; treat an explicit
        // success:false as failure so we don't silently drop ledger writes.
        try {
          const parsed = JSON.parse(text) as { success?: boolean; error?: unknown; code?: unknown; retryable?: unknown };
          if (parsed.success === false) {
            const code = typeof parsed.code === "string" ? parsed.code : "";
            lastReason = code
              ? `${code}: ${typeof parsed.error === "string" ? parsed.error : "tool reported failure"}`
              : (typeof parsed.error === "string" ? parsed.error : "tool reported failure");
            // Permanent failure — do not burn the second attempt on it.
            if (parsed.retryable === false) break;
            continue;
          }
        } catch {
          // Non-JSON tool text — the call itself succeeded; accept it.
        }
        ok = true;
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
      }
    }
    if (ok) confirmed.push(opportunityId);
    else failed.push({ opportunityId, reason: lastReason });
  }

  return { confirmed, failed };
}

/**
 * Sanitize an MCP-sourced question prompt before it is interpolated into the
 * digest body: drop HTML-comment sequences (so a hostile prompt cannot forge
 * digest-opportunity/digest-question markers), collapse all whitespace to a
 * single line (so it cannot inject section headers), and cap the length.
 */
function sanitizeQuestionPrompt(raw: string): string {
  const collapsed = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--|-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= QUESTION_PROMPT_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, QUESTION_PROMPT_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Fetch pending questions by calling the Index MCP server directly via
 * JSON-RPC with read_pending_questions. Mirrors fetchOpportunitiesFromMcp.
 *
 * NEVER throws — all errors are caught internally.
 * Returns `{ questions, source, reason? }`: `source: "mcp"` is reserved for
 * genuinely successful fetches (possibly empty); every failure path returns
 * `source: "unavailable"` with a `reason` for the diagnostics warning.
 */
export async function fetchPendingQuestionsFromMcp(opts: {
  apiKey: string;
  mcpUrl: string;
}): Promise<{ questions: BriefQuestion[]; source: "mcp" | "unavailable"; reason?: string }> {
  try {
    const initResp = await postMcpMessage(opts.mcpUrl, opts.apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentvillage-digest", version: "1.0.0" },
      },
    });
    if (initResp.error) {
      return { questions: [], source: "unavailable", reason: `MCP initialize: ${initResp.error.message}` };
    }

    const toolResp = await postMcpMessage(opts.mcpUrl, opts.apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_pending_questions", arguments: { limit: QUESTION_FETCH_LIMIT } },
    });
    if (toolResp.error) {
      return { questions: [], source: "unavailable", reason: `MCP read_pending_questions: ${toolResp.error.message}` };
    }

    const result = toolResp.result as McpToolResult | undefined;
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (!text.trim()) return { questions: [], source: "mcp" };

    const parsed = JSON.parse(text) as { success?: boolean; error?: unknown; data?: { questions?: unknown[] } };
    if (parsed.success === false) {
      const detail = typeof parsed.error === "string" && parsed.error.trim() ? parsed.error : "tool reported failure";
      return { questions: [], source: "unavailable", reason: `read_pending_questions: ${detail}` };
    }
    if (!parsed.data?.questions || !Array.isArray(parsed.data.questions)) return { questions: [], source: "mcp" };
    const questions = parsed.data.questions
      .filter((q): q is Record<string, unknown> => q !== null && typeof q === "object")
      .map((q) => ({
        id: String(q.id ?? ""),
        title: String(q.title ?? ""),
        prompt: sanitizeQuestionPrompt(String(q.prompt ?? "")),
        mode: String(q.mode ?? ""),
      }))
      .filter((q) => QUESTION_ID_PATTERN.test(q.id) && q.prompt);
    return { questions, source: "mcp" };
  } catch (err) {
    return { questions: [], source: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function buildDailyBriefContext(options: {
  date?: string;
  stateFile?: string;
  opportunitiesFile?: string;
  userFiles?: string[];
} = {}): Promise<DailyBriefContext> {
  const date = options.date ?? pacificDate();
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

  const apiKey = resolveIndexApiKey();
  const mcpUrl = process.env.INDEX_MCP_URL?.trim() || "https://protocol.index.network/mcp";

  if (apiKey) {
    try {
      const deliveredIds = await readDeliveredIds(options.stateFile ?? "memory/heartbeat-state.json", date);
      const fetched = await fetchOpportunitiesFromMcp({ apiKey, mcpUrl });
      opportunities = filterDedupedOpportunities(fetched, deliveredIds);
      opportunitySource = "mcp";
    } catch (err) {
      warnings.push(`opportunities MCP unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (options.opportunitiesFile) {
    const transcript = await readIfExists(options.opportunitiesFile);
    if (transcript.trim()) {
      opportunitySource = "file";
      const deliveredIds = await readDeliveredIds(options.stateFile ?? "memory/heartbeat-state.json", date);
      opportunities = filterDedupedOpportunities(parseOpportunityTranscript(transcript), deliveredIds);
    }
  }

  let questions: BriefQuestion[] = [];
  let questionSource: "mcp" | "unavailable" = "unavailable";

  if (apiKey) {
    const questionResult = await fetchPendingQuestionsFromMcp({ apiKey, mcpUrl });
    const questionDelivery = await readQuestionDelivery(options.stateFile ?? "memory/heartbeat-state.json");
    questions = filterCooldownQuestions(questionResult.questions, questionDelivery, date);
    questionSource = questionResult.source;
    if (questionResult.source === "unavailable") {
      warnings.push(`questions MCP unavailable: ${questionResult.reason ?? "unknown"}`);
    }
  }

  return {
    date,
    displayDate: displayDate(date),
    timezone: PACIFIC_TZ,
    announcements: announcementResult.announcements,
    rsvpEvents: rsvpResult.rsvpEvents,
    highlightedEvents: eventResult.highlightedEvents,
    interestEvents: eventResult.interestEvents,
    opportunities,
    connectionOpportunities: opportunities.filter((opp) => opp.feedCategory === "connection"),
    communityOpportunities: opportunities.filter((opp) => opp.feedCategory === "connector-flow"),
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
