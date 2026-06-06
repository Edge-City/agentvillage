#!/usr/bin/env bun
/**
 * Build deterministic source context for the daily morning brief.
 *
 * The composer prompt still writes the final prose, but this script owns the
 * mechanical fetching/ranking pieces: admin announcements, today's EdgeOS
 * highlighted events, a simple interest-fill event, and parsed Index MCP
 * opportunity cards when the prompt provides a list_opportunities transcript.
 *
 * Usage (from $HERMES_HOME):
 *   bun skills/index-network/scripts/build-daily-brief-context.ts \
 *     --opportunities-file memory/digest-opportunities.txt \
 *     --state-file memory/heartbeat-state.json \
 *     --out memory/daily-brief-context.json
 */

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

export interface BriefOpportunity {
  name: string;
  mainText?: string;
  status?: string;
  profileUrl?: string;
  acceptUrl?: string;
  feedCategory?: string;
  opportunityId?: string;
  confidence?: number;
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
  weather?: DailyBriefWeather;
  diagnostics: {
    announcementsSource: "control-plane" | "unavailable";
    calendarSource: "edgeos" | "unavailable";
    rsvpSource: "edgeos" | "unavailable";
    opportunitySource: "file" | "unavailable";
    weatherSource?: "open-meteo" | "nws" | "unavailable";
    warnings: string[];
    interestTags: string[];
  };
}

const HIGHLIGHTED_EVENT_LIMIT = 6;
const DISCOVERY_EVENT_TARGET = 6;
const RSVP_EVENT_LIMIT = 6;

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

    const field = line.trim().match(/^(status|profileUrl|acceptUrl|feedCategory|opportunityId|confidence):\s*(.+)$/);
    if (field) {
      const key = field[1] as keyof BriefOpportunity;
      if (key === "confidence") {
        const val = parseFloat(field[2].trim());
        if (!isNaN(val)) current[key] = val;
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

  const [announcementResult, eventResult, rsvpResult, weather] = await Promise.all([
    fetchAnnouncements(date, warnings),
    fetchEvents(date, interestTags, warnings),
    fetchRsvps(date, warnings),
    fetchWeather(date, warnings),
  ]);

  let opportunities: BriefOpportunity[] = [];
  let opportunitySource: "file" | "unavailable" = "unavailable";
  if (options.opportunitiesFile) {
    const transcript = await readIfExists(options.opportunitiesFile);
    if (transcript.trim()) {
      opportunitySource = "file";
      const deliveredIds = await readDeliveredIds(options.stateFile ?? "memory/heartbeat-state.json", date);
      opportunities = filterDedupedOpportunities(parseOpportunityTranscript(transcript), deliveredIds);
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
    weather: weather.source !== "unavailable" ? weather : undefined,
    diagnostics: {
      announcementsSource: announcementResult.source,
      calendarSource: eventResult.source,
      rsvpSource: rsvpResult.source,
      opportunitySource,
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
