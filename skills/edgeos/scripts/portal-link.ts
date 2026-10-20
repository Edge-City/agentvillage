/**
 * An event's link on the Edge City portal (B-138 EVENT-LINKS), for the schedule script's lines.
 *
 * The base is `AV_PORTAL_URL` (the portal events base, e.g. `https://portal.edgecity.live/portal/edge-india/events`),
 * checked by the morning brief's rule (skills/index-network/scripts/proactive.ts portalBase: https, no user name,
 * password, query or fragment, no character that could break a message) plus one more: the host must be the
 * portal's (`PORTAL_HOSTS`). Anything else gives no base, and then no link is printed, never a guessed one.
 *
 * The link is the base and the event's own id from the EdgeOS answer, which must be a UUID. For an occurrence
 * of a recurring event (`occurrence_id` set) it adds `?occ=<start_time>`, as the portal's own calendar does
 * (edgeos portal PublicCalendarClient: `?occ=${encodeURIComponent(event.start_time)}`).
 */

/** Hosts an event link may point at: the Edge City portal. */
export const PORTAL_HOSTS = ["portal.edgecity.live"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The portal events base without a trailing slash when `raw` passes the rule above; else null. */
export function portalBase(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) return null;
  if (!(PORTAL_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())) return null;
  if (url.port && url.port !== "443") return null;
  const href = url.href.replace(/\/+$/, "");
  return /^https:\/\/[^\s"'`<>()[\]]+$/.test(href) ? href : null;
}

export interface LinkableEvent {
  id?: string;
  start_time?: string;
  occurrence_id?: string | null;
}

/** The event's portal link, or null when there is no valid base, the id is not a UUID, or an occurrence has no start. */
export function eventLink(event: LinkableEvent, base: string | null): string | null {
  if (!base || typeof event.id !== "string" || !UUID.test(event.id)) return null;
  const link = `${base}/${event.id}`;
  if (!event.occurrence_id) return link;
  if (typeof event.start_time !== "string" || !event.start_time) return null;
  return `${link}?occ=${encodeURIComponent(event.start_time)}`;
}
