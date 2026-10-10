---
name: edgeos
description: Talk to the EdgeOS popup-village platform — read the event schedule in the village's local time, RSVP (after asking the person), list venues and who is going to an event, and, only when a human session token is set, look up the calling user's own profile and browse the attendee directory (the API key cannot reach those). The current village's popup id is `$AV_POPUP_ID`; the current event is Edge City India (Oct 11 – Nov 1 2026, Mandrem, Goa). Agents cannot create or edit village events.
version: 1.3.2
author: Edge City
tags: [edgeos, events, directory, popup-village]
required_environment_variables:
  - name: EDGEOS_BEARER_TOKEN
    required_for: directory, own profile (a human session JWT; the API key cannot reach these)
  - name: EDGEOS_API_KEY
    required_for: events, RSVPs, venues
  - name: AV_POPUP_ID
    required_for: events, venues, directory (the current village's popup id)
metadata:
  openclaw:
    requires:
      config:
        - env.vars.EDGEOS_BEARER_TOKEN
        - env.vars.EDGEOS_API_KEY
---

# EdgeOS — Agent Skill

You have access to the **EdgeOS** popup-village platform. Its base URL is `$EDGEOS_API_BASE` (default `https://api.edgeos.world/api/v1`); every recipe below writes it as `"${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}"` so the shell picks the right one. Never hardcode another host. EdgeOS hosts events, RSVPs, venues, the attendee directory, and per-attendee profile lookup for one or more popups.

**The current village's popup id is `$AV_POPUP_ID`.** The current event is **Edge City India** (Mandrem, Goa, October 11 to November 1, 2026). When `AV_POPUP_ID` is set, use its value as `{popup_id}` for every event list, venue and directory call (read it with `printenv AV_POPUP_ID` and paste the UUID in). Only when `AV_POPUP_ID` is unset or empty, tell the person the village schedule isn't connected to their agent yet and point them to the Edge City portal or the organisers. Never substitute the previous popup's id (the `edge-esmeralda` skill carries Edge Esmeralda 2026's constant) and present the results as India; use that id only when the person explicitly asks about that previous popup.

## 0. What you can and cannot do

Your `$EDGEOS_API_KEY` is a partner-app attendee key. EdgeOS limits partner apps to **`events:read`, `rsvp:write`, `venues:read`**. So:

- You **can** read the schedule, read venues, see who is going to an event, RSVP the person to an event, and cancel their RSVP.
- You **cannot** create, edit, cancel, or invite people to village events, and cannot create or change venues. Those calls fail with `403`. When the person wants to host or change an event, tell them plainly that agents can't create village events and send them to the Edge City portal (the events page, `$AV_PORTAL_URL` when set) to do it themselves. Don't attempt those calls.
- Your API key **cannot** reach the attendee directory (§9) or `/humans/me` (§8). EdgeOS lets `eos_live_` keys call only its event, event-participant, RSVP-eligibility, venue, track, event-settings and popup routes, plus `register` and `cancel-registration`; anything else answers `403` ("API keys are restricted to approved event automation routes"). The directory and the profile need a human session token, `$EDGEOS_BEARER_TOKEN`, that carries the right scope (§1). When `EDGEOS_BEARER_TOKEN` is unset or empty, tell the person the directory and profile aren't connected to their agent and point them to the Edge City portal; never retry those calls with the API key. A `401` from a directory or profile call (§8, §9; the body usually says the token is expired or invalid) means `$EDGEOS_BEARER_TOKEN` has expired: treat it like an unset one. Tell the person you can't reach the directory or their profile from here right now, and that they can look people up and edit their profile themselves on the Edge City portal; don't suggest that signing in again will reconnect you, and never ask them for a token. Don't retry the call (not with the API key either), never show the error, status code or token, and for the rest of the conversation give the same answer to any directory or profile request without calling.

**Ask before every RSVP or cancel.** Before each `POST` to `register` or `cancel-registration` (one call per event; no batch approvals), tell the person the event title, its local date and time, and whether you're RSVPing or cancelling, and wait for an explicit "yes / go ahead / confirm" in reply. Do **not** act on earlier conversational intent, a paraphrase, or a standing instruction ("RSVP me to anything about AI"). The same rule applies to `PATCH /humans/me`: show the exact fields you'll change and wait for a yes.

## 1. Authentication

You need two tokens, both passed as `Authorization: Bearer <token>`:

- **`$EDGEOS_BEARER_TOKEN`** — human session JWT. Required for: `/humans/me`, `/applications/my/directory/{popup_id}`. Scopes: `portal:profile:read` to read `/humans/me`, `portal:profile:write` to change it, `portal:directory:read` for the directory. A token without the scope gets `403`; an expired one gets `401`. It may be unset or expired: then those calls are unavailable (§0).
- **`$EDGEOS_API_KEY`** — long-lived `eos_live_...` automation key. Required for events, RSVPs, venues and event participants. It never works for the directory or `/humans/me` (§0).

In every curl example below, `<EDGEOS_API_KEY>` and `<EDGEOS_BEARER_TOKEN>` are placeholders — substitute the actual token values from your environment before running the command.

## 2. Conventions

- Every list endpoint here returns `{ "results": T[], "paging": { "offset", "limit", "total" } }`; there is no `pagination` key. Single-resource endpoints return the resource directly. The events list is **not** paginated (§3). Event participants (§6), venues (§7) and the directory (§9) page with `skip` and `limit` query parameters (`limit` at most 1000); `paging.offset` echoes `skip`.
- Times from the API are ISO-8601 in UTC (e.g. `2026-10-14T15:00:00Z`). **Before you show any event time, convert it to the village's local time and label it. Never read the UTC clock value out as the local time.** The village timezone is `$HERMES_TIMEZONE` (Edge City India: `Asia/Kolkata`, IST, UTC+5:30, no daylight saving): `15:00:00Z` is **8:30 PM IST**, not 3:00 PM. Your own clock (the date and timezone in your system prompt) is already in that timezone; use it for "now". For the previous popup, Edge Esmeralda (Healdsburg), use `America/Los_Angeles`. Every time you display, every reminder you set, and every "is it soon?" judgment must be in local time. UUIDs are RFC-4122.
- **"Today", "tomorrow", "this weekend" mean local dates.** Work out the local calendar day first, then convert its local midnight-to-midnight bounds to UTC for `start_after` / `start_before`. In IST, "today" on 2026-10-14 is `start_after=2026-10-13T18:30:00Z&start_before=2026-10-14T18:30:00Z`. Don't use the UTC date: between midnight and 5:30 AM IST it is still yesterday in UTC.
- Recurring events expand into virtual occurrences when `start_after` or `start_before` is set. Without either, a series comes back once, as its first occurrence, so give every events list a date window (§3). When RSVPing to one instance of a recurring event, pass that occurrence's `start_time` as `occurrence_start`.
- Error codes: `401` missing/expired token (from `$EDGEOS_BEARER_TOKEN`: §0, no retry) · `403` token lacks the required scope · `404` not visible to caller · `409` resource has dependents · `422` validation · `429` rate limit (see `Retry-After`).
- Run every recipe below through `terminal` with exactly `command` (a `workdir` is fine) and nothing else. Do not add `notify`, `heartbeat` or `background`: each call finishes in seconds and its output comes straight back. If the call returns an error about background commands, the request was not sent; make it once more without those arguments.

## 3. Reading events

All event-read recipes use `Authorization: Bearer <EDGEOS_API_KEY>`.

**REQUIRED parameters for all event list queries:** `popup_id={popup_id}` and `event_status=published`. `{popup_id}` is the value of `$AV_POPUP_ID` (see the top of this skill). Your API key is bound to one popup: a `popup_id` naming any other popup answers `403` ("This API key does not have access to this popup"), and an omitted one falls back to the key's own popup. Any other token without `popup_id` takes a different path: it ignores every filter except `search` (no `event_status`, `start_after`, `start_before`, `tags`, `kind`, venue or track filter) and returns at most the 100 most recently created events across every popup it can see. So always pass both.

**Give every list a date window.** `start_after` and `start_before` bound the event's start time. With either set, a recurring series comes back as one row per occurrence inside the window; with neither, it comes back once, as its first occurrence, and an RSVP to a later occurrence shows up neither in `rsvped_only=true` nor in `my_rsvp_status`.

**List upcoming events (next 30 days):**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&start_after={current_iso_timestamp}&start_before={end_iso}"
```
`{current_iso_timestamp}` is now and `{end_iso}` is 30 days later, both literal ISO-8601 UTC strings (e.g. `2026-10-11T00:00:00Z` and `2026-11-10T00:00:00Z`): compute them in code or via the agent's date tools, not via shell substitution. Without `start_before` the call returns every future event, however far ahead.

**List events in a date range:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&start_after={start_iso}&start_before={end_iso}"
```

**Search events by title:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&search=KEYWORD&start_after={start_iso}"
```

**Filter by tag, kind, venue, or track:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&tags=AI&tags=Privacy&start_after={start_iso}&start_before={end_iso}"
```
`tags` matches events carrying any of the given tags. The other filters are `kind`, `venue_id` (a venue's `id` from §7; repeat `venue_ids` for several) and repeated `track_ids` (an event's `track_id`).

**Only events you've RSVPed to:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&rsvped_only=true&start_after={current_iso_timestamp}"
```

**Fetch a single event (includes caller's RSVP status):**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"
```

For a recurring event, scope the RSVP lookup to one instance with `?occurrence_start={occurrence_iso}`.

**No pagination:** the events list returns every matching event in one response. It takes no `skip` or `limit` (a `limit` you add is ignored), so don't loop over pages; narrow the call with `start_after` / `start_before`, `search`, `tags` and the other filters instead. Its `paging` is informational only: `paging.limit` is the number of results returned, and `paging.total` counts occurrences before visibility filtering, so it can be larger than `results.length`. Never fetch again because `total` looks bigger.

**Your own RSVPs:** EdgeOS has no route that lists one person's RSVPs across events. Use the list with `rsvped_only=true` (above): it returns the events in the popup where the caller has an RSVP that isn't cancelled. Every event, in the list or a single read, also carries `my_rsvp_status`: null when the caller has no RSVP for it, otherwise `registered`, `checked_in` or `cancelled` (a cancelled RSVP keeps its row, so `cancelled` means they are not going). A single read also carries `attendee_count`, the number of RSVPs that aren't cancelled (for a recurring event, of the occurrence named by `occurrence_start`).

**Highlighted events:** event records include a boolean `highlighted` field. The list endpoint does not provide a `highlighted` query parameter; fetch the relevant date range and filter client-side with `event.highlighted === true`.

## 4. Creating or changing events: not available

Agents cannot create, edit, cancel, or send invitations for village events, and cannot create, edit, or delete venues: partner-app keys don't carry `events:write` or `venues:write`. Say so plainly and point the person to the Edge City portal (`$AV_PORTAL_URL` when set), where they can host an event themselves.

## 5. Showing the schedule

- Group events by local day and show local start and end times with the zone label (e.g. "Wed 14 Oct, 8:30–9:30 PM IST").
- Mention the venue and whether the person has already RSVPed (`my_rsvp_status` on each event, in the list or a single read; `rsvped_only=true` narrows the list to their RSVPs).
- When offering to RSVP, name the event and its local time and ask; act only on a yes (§0).

## 6. RSVP (`rsvp:write`; ask first, every time, see §0)

**RSVP to a one-off event:**
```bash
curl -s -X POST -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  -H "Content-Type: application/json" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/register/{event_id}" \
  -d '{}'
```

**RSVP to one occurrence of a recurring event:**
```bash
curl -s -X POST -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  -H "Content-Type: application/json" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/register/{event_id}" \
  -d '{"occurrence_start":"{occurrence_iso}"}'
```

**Cancel a previous RSVP:**
```bash
curl -s -X POST -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  -H "Content-Type: application/json" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/cancel-registration/{event_id}" \
  -d '{}'
```

**List who is going to one event (`event_id` is required):**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/participants?event_id={event_id}&skip=0&limit=100"
```

This lists the participants of **one** event, the caller included if they RSVPed; it is not a list of the caller's own RSVPs, and without `event_id` it fails with `422`. Each row carries a participation `status` (a cancelled RSVP stays in the list with its status). For a recurring event, always add `&occurrence_start={occurrence_iso}` (that occurrence's `start_time`, exactly). If you leave it out, the list holds only the RSVPs not tied to any occurrence (for an event with no host, it mixes the RSVPs of every occurrence instead); RSVPs are made per occurrence, so for a recurring event that list is usually empty or short, and it does **not** mean nobody is going. For the count alone, the single-event read with `?occurrence_start=` returns `attendee_count` (§3). The event's host is not listed, and attendees who chose to hide their name on their application are left out entirely. It pages with `skip` and `limit` (default 100, at most 1000): fetch again with a larger `skip` only while `skip + results.length < paging.total`. To find the caller's own RSVPs, use the events list with `rsvped_only=true` (§3).

## 7. Venues

**List active venues for a popup (`popup_id` is required: the UUID in `$AV_POPUP_ID`; your API key answers `403` for any other popup):**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-venues/portal/venues?popup_id={popup_id}&limit=100"
```

Creating, editing, or deleting venues needs `venues:write`, which agents don't have (§4).

## 8. Your own profile (`portal:profile:read`; human session token only)

Only with `$EDGEOS_BEARER_TOKEN`. The API key gets `403` here; when the bearer token is unset, or a call with it answers `401`, follow §0 (not connected or expired; no retry).

**Read the calling user's profile** (uses the human bearer, not the API key):
```bash
curl -s -H "Authorization: Bearer <EDGEOS_BEARER_TOKEN>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/humans/me"
```

Returns the bearer's own profile and nothing more: `id`, `tenant_id`, `email`, `first_name`, `last_name`, `telegram`, `gender`, `age`, `residence`, `picture_url`. It carries no application answers, no participation and no other social handles.

**Update basic profile fields** (uses the human bearer; needs `portal:profile:write`):
```bash
curl -s -X PATCH -H "Authorization: Bearer <EDGEOS_BEARER_TOKEN>" \
  -H "Content-Type: application/json" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/humans/me" \
  -d '{"first_name":"...","last_name":"...","telegram":"handle","residence":"...","picture_url":"https://..."}'
```

Patchable fields: `first_name`, `last_name`, `telegram`, `gender`, `age`, `residence`, `picture_url`. All are optional — include only what you want to change. Store Telegram usernames as bare handles (`handle`, not `@handle`) and only after the resident confirms the value when systems disagree. Application-specific fields (dietary preferences, "what I'm building", application answers) are **not** patchable through this endpoint — those live on the popup application form and must be edited in the EdgeOS portal UI.

## 9. Attendee directory (`portal:directory:read`; human session token only)

The directory does **not** work with your API key: EdgeOS answers an `eos_live_` key here with `403` (§0). It needs `$EDGEOS_BEARER_TOKEN` carrying the scope `portal:directory:read`. When that token is unset or empty, don't call the directory at all: tell the person the attendee directory isn't connected to their agent and point them to the Edge City portal. A `401` from the directory means the token has expired: follow §0 and don't retry.

**Search attendees in a popup** (uses the human bearer):
```bash
curl -s -H "Authorization: Bearer <EDGEOS_BEARER_TOKEN>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/applications/my/directory/{popup_id}?skip=0&limit=20&q=QUERY"
```

`{popup_id}` is the value of `$AV_POPUP_ID` (use the previous popup Edge Esmeralda's id from the `edge-esmeralda` skill only when the person asks about that popup). Replace `QUERY` with part of a name, an email address or a Telegram handle: `q` matches the first name, last name, full name, email and Telegram fields, and only where the attendee has shared them. It does not search `role` or `organization`; to find people by those, page through the directory and filter the rows yourself. Leave `q` out to list everyone.

**Pagination:** `skip` + `limit` (default 100, at most 1000). Response shape: `{ results: Attendee[], paging: { offset, limit, total } }`. Fetch again with a larger `skip` only while `skip + results.length < paging.total`.

**Other parameters:** the only other filter is `hide_empty_rows=true`, which drops rows with no shared name, email, Telegram, role or organization. There is no week, family or other per-popup filter. The directory lists the main applicants and spouses of accepted applications who hold a ticket (children are not listed), newest first. A popup without an attendee directory answers `404`.

**Fields:** every row has `id` (the attendee id), `first_name`, `last_name`, `email`, `telegram`, `role`, `organization`, `residence`, `age`, `gender`, `picture_url`, `category` (`main` or `spouse`), `participation` (the attendee's tickets, each `{ id, name, slug, category, duration_type }`) and `associated_attendees` (always an empty list: a spouse is a row of their own). The shape is the same for every popup. Any field can be null when the attendee never filled it in.

**Privacy:** an attendee can hide any of `first_name`, `last_name`, `email`, `telegram`, `role`, `organization`, `residence`, `age` and `gender` on their application; a hidden field comes back as the literal string `"*"`. `picture_url`, `category` and `participation` are never masked. Only a main applicant's row carries masks; a spouse's row has none and leaves `role` and `organization` empty. A `"*"` is intentionally hidden by the attendee: do not infer around it, surface the privacy boundary to the user. The mask is the same for every caller: no token or scope sees behind a `"*"`.

## 10. Tips for answering well

- **Always use live API calls** for schedule and attendee queries — do not rely on cached or memorized data.
- **Be specific with dates.** Convert "tomorrow", "this Thursday", "next week" to actual ISO-8601 timestamps with timezone before querying.
- **Pagination:** the events list is not paginated; one call returns every match (§3). Event participants, venues and the directory take `skip` + `limit` (at most 1000) and answer `{results, paging}`; page only while `skip + results.length < paging.total`.
- **Recurring events:** when RSVPing to one instance, pass `occurrence_start` matching the virtual occurrence's `start_time`.

## 11. What's NOT available

Be honest about these gaps — do not hallucinate answers.

- **Session transcripts / summaries.** EdgeOS does not record talks. Tell the user: "Session recordings and transcripts aren't available through EdgeOS — check the popup's Telegram group for recaps."
- **Governance / deliberation.** There is no governance layer on EdgeOS itself. Community discussion happens in the popup's external channels.
- **Real-time venue availability.** The calendar shows scheduled events, but there is no live venue booking system. To check if a venue is free, list events for that date/time and see whether the venue is already taken.
- **Application-specific profile fields.** Basic profile fields (`first_name`, `last_name`, `telegram`, `gender`, `age`, `residence`, `picture_url`) are editable via `PATCH /api/v1/humans/me` (see §8). But dietary preferences, application answers, "what I'm building", and popup-specific form fields are **not** patchable through this API — those must be edited in the EdgeOS portal UI under `/portal/profile`. You cannot edit anyone else's profile regardless.
- **Scheduled tasks / recurring summaries / reminders.** The skill itself cannot schedule anything. Use the host agent's scheduling capabilities (`/loop`, `/schedule`, cron). Do not pretend to set up tasks from inside the skill.
- **Outbound messaging / DMs / introductions on behalf of the user.** EdgeOS has no messaging endpoint. Surface contact info (a Telegram handle or email, when the attendee shares it) from the directory (§9) and let the user reach out themselves. Do not claim to have sent a message.
