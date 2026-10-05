---
name: edgeos
description: Talk to the EdgeOS popup-village platform — read the event schedule in the village's local time, RSVP (after asking the person), list venues, look up the calling user's own profile, and browse the attendee directory. The current village's popup id is `$AV_POPUP_ID`; the current event is Edge City India (Oct 11 – Nov 1 2026, Mandrem, Goa). Agents cannot create or edit village events.
version: 1.2.0
author: Edge City
tags: [edgeos, events, directory, popup-village]
required_environment_variables:
  - name: EDGEOS_BEARER_TOKEN
    required_for: directory, own profile
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

- You **can** read the schedule, read venues, RSVP the person to an event, and cancel their RSVP.
- You **cannot** create, edit, cancel, or invite people to village events, and cannot create or change venues. Those calls fail with `403`. When the person wants to host or change an event, tell them plainly that agents can't create village events and send them to the Edge City portal (the events page, `$AV_PORTAL_URL` when set) to do it themselves. Don't attempt those calls.

**Ask before every RSVP or cancel.** Before each `POST` to `register` or `cancel-registration` (one call per event; no batch approvals), tell the person the event title, its local date and time, and whether you're RSVPing or cancelling, and wait for an explicit "yes / go ahead / confirm" in reply. Do **not** act on earlier conversational intent, a paraphrase, or a standing instruction ("RSVP me to anything about AI"). The same rule applies to `PATCH /humans/me`: show the exact fields you'll change and wait for a yes.

## 1. Authentication

You need two tokens, both passed as `Authorization: Bearer <token>`:

- **`$EDGEOS_BEARER_TOKEN`** — human session JWT. Required for: `/humans/me`, `/applications/my/directory/{popup_id}`. Scopes: `portal:self_read`, `portal:directory_read`.
- **`$EDGEOS_API_KEY`** — long-lived `eos_live_...` automation key. Required for events, RSVPs, venues.

In every curl example below, `<EDGEOS_API_KEY>` and `<EDGEOS_BEARER_TOKEN>` are placeholders — substitute the actual token values from your environment before running the command.

## 2. Conventions

- List endpoints return a `results: T[]` array plus a paging object whose key name varies by endpoint (`paging` for events, `pagination` for the directory). Single-resource endpoints return the resource directly. When in doubt, consult the response shape documented in the relevant section, or the OpenAPI spec via §11.
- Times from the API are ISO-8601 in UTC (e.g. `2026-10-14T15:00:00Z`). **Before you show any event time, convert it to the village's local time and label it. Never read the UTC clock value out as the local time.** The village timezone is `$HERMES_TIMEZONE` (Edge City India: `Asia/Kolkata`, IST, UTC+5:30, no daylight saving): `15:00:00Z` is **8:30 PM IST**, not 3:00 PM. Your own clock (the date and timezone in your system prompt) is already in that timezone; use it for "now". For the previous popup, Edge Esmeralda (Healdsburg), use `America/Los_Angeles`. Every time you display, every reminder you set, and every "is it soon?" judgment must be in local time. UUIDs are RFC-4122.
- **"Today", "tomorrow", "this weekend" mean local dates.** Work out the local calendar day first, then convert its local midnight-to-midnight bounds to UTC for `start_after` / `start_before`. In IST, "today" on 2026-10-14 is `start_after=2026-10-13T18:30:00Z&start_before=2026-10-14T18:30:00Z`. Don't use the UTC date: between midnight and 5:30 AM IST it is still yesterday in UTC.
- Recurring events expand into virtual occurrences when `start_after` is set. When RSVPing to one instance of a recurring event, pass that occurrence's `start_time` as `occurrence_start`.
- Error codes: `401` missing/expired token · `403` token lacks the required scope · `404` not visible to caller · `409` resource has dependents · `422` validation · `429` rate limit (see `Retry-After`).
- Run every recipe below through `terminal` with exactly `command` (a `workdir` is fine) and nothing else. Do not add `notify`, `heartbeat` or `background`: each call finishes in seconds and its output comes straight back. If the call returns an error about background commands, the request was not sent; make it once more without those arguments.

## 3. Reading events

All event-read recipes use `Authorization: Bearer <EDGEOS_API_KEY>`.

**REQUIRED parameters for all event list queries:** `popup_id={popup_id}` and `event_status=published`. Without `popup_id`, the API filters by `created_at` instead of `start_time`, returning wrong results. `{popup_id}` is the value of `$AV_POPUP_ID` (see the top of this skill).

**List upcoming events (next 30 days):**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&start_after={current_iso_timestamp}&limit=50"
```
`{current_iso_timestamp}` must be a literal ISO-8601 UTC string (e.g. `2026-05-26T21:00:00Z`) — compute it in code or via the agent's date tools, not via shell substitution.

**List events in a date range:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&start_after={start_iso}&start_before={end_iso}&limit=100"
```

**Search events by title:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&search=KEYWORD&start_after={start_iso}&limit=50"
```

**Filter by tag, kind, venue, or track:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&tags=AI&tags=Privacy&limit=50"
```

**Only events you've RSVPed to:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&rsvped_only=true&limit=50"
```

**Fetch a single event (includes caller's RSVP status):**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"
```

For a recurring event, scope the RSVP lookup to one instance with `?occurrence_start={occurrence_iso}`.

**Pagination:** use `skip` and `limit` (max `100`). Stop when `results.length < limit`.

**Highlighted events:** event records include a boolean `highlighted` field. The list endpoint does not provide a `highlighted` query parameter; fetch the relevant date range and filter client-side with `event.highlighted === true`.

## 4. Creating or changing events: not available

Agents cannot create, edit, cancel, or send invitations for village events, and cannot create, edit, or delete venues: partner-app keys don't carry `events:write` or `venues:write`. Say so plainly and point the person to the Edge City portal (`$AV_PORTAL_URL` when set), where they can host an event themselves.

## 5. Showing the schedule

- Group events by local day and show local start and end times with the zone label (e.g. "Wed 14 Oct, 8:30–9:30 PM IST").
- Mention the venue and whether the person has already RSVPed (`my_rsvp_status` on a single-event read, or `rsvped_only=true` on the list).
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

**List your own RSVPs across events:**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/participants"
```

## 7. Venues

**List active venues for a popup (`popup_id` is required, must be a UUID — the active popup skill supplies it):**
```bash
curl -s -H "Authorization: Bearer <EDGEOS_API_KEY>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-venues/portal/venues?popup_id={popup_id}&limit=100"
```

Creating, editing, or deleting venues needs `venues:write`, which agents don't have (§4).

## 8. Your own profile (`portal:self_read`)

**Read the calling user's profile** (uses the human bearer, not the API key):
```bash
curl -s -H "Authorization: Bearer <EDGEOS_BEARER_TOKEN>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/humans/me"
```

Returns the human record for the bearer's owner — your own application content, registered participation, profile fields, and platform handles.

**Update basic profile fields** (uses the human bearer):
```bash
curl -s -X PATCH -H "Authorization: Bearer <EDGEOS_BEARER_TOKEN>" \
  -H "Content-Type: application/json" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/humans/me" \
  -d '{"first_name":"...","last_name":"...","telegram":"handle","residence":"...","picture_url":"https://..."}'
```

Patchable fields: `first_name`, `last_name`, `telegram`, `gender`, `age`, `residence`, `picture_url`. All are optional — include only what you want to change. Store Telegram usernames as bare handles (`handle`, not `@handle`) and only after the resident confirms the value when systems disagree. Application-specific fields (dietary preferences, "what I'm building", application answers) are **not** patchable through this endpoint — those live on the popup application form and must be edited in the EdgeOS portal UI.

## 9. Attendee directory (`portal:directory_read`)

**Search attendees in a popup** (uses the human bearer):
```bash
curl -s -H "Authorization: Bearer <EDGEOS_BEARER_TOKEN>" \
  "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/applications/my/directory/{popup_id}?skip=0&limit=20&q=QUERY"
```

`{popup_id}` is the popup UUID supplied by the active operator skill (e.g. `edge-esmeralda` carries the previous popup Edge Esmeralda's constant). Replace `QUERY` with a name, organization, or role.

**Pagination:** `skip` + `limit` (default 20, check the OpenAPI spec via §11 for the per-popup max). Response shape: `{ results: Attendee[], pagination: { skip, limit, total } }`.

**Filters beyond `search`** depend on the popup's application form (e.g. participation weeks, families-with-kids). The set varies by popup. To discover supported filters for a given popup, fetch the OpenAPI spec (§11) and look up the directory endpoint's query parameters.

**Privacy:** the attendee response shape and which fields are hidden are popup-curated. Look up the field semantics in the active operator skill, not here. As a universal rule: a field whose value is the literal string `"*"` is intentionally hidden by the attendee — do not infer around it, surface the privacy boundary to the user.

## 10. Tips for answering well

- **Always use live API calls** for schedule and attendee queries — do not rely on cached or memorized data.
- **Be specific with dates.** Convert "tomorrow", "this Thursday", "next week" to actual ISO-8601 timestamps with timezone before querying.
- **Pagination:** events endpoints accept `skip` + `limit` (max 100); the directory uses the same pattern. Loop until `results.length < limit`.
- **Recurring events:** when RSVPing to one instance, pass `occurrence_start` matching the virtual occurrence's `start_time`.

## 11. What's NOT available

Be honest about these gaps — do not hallucinate answers.

- **Session transcripts / summaries.** EdgeOS does not record talks. Tell the user: "Session recordings and transcripts aren't available through EdgeOS — check the popup's Telegram group for recaps."
- **Governance / deliberation.** There is no governance layer on EdgeOS itself. Community discussion happens in the popup's external channels.
- **Real-time venue availability.** The calendar shows scheduled events, but there is no live venue booking system. To check if a venue is free, list events for that date/time and see whether the venue is already taken.
- **Application-specific profile fields.** Basic profile fields (`first_name`, `last_name`, `telegram`, `gender`, `age`, `residence`, `picture_url`) are editable via `PATCH /api/v1/humans/me` (see §8). But dietary preferences, application answers, "what I'm building", and popup-specific form fields are **not** patchable through this API — those must be edited in the EdgeOS portal UI under `/portal/profile`. You cannot edit anyone else's profile regardless.
- **Scheduled tasks / recurring summaries / reminders.** The skill itself cannot schedule anything. Use the host agent's scheduling capabilities (`/loop`, `/schedule`, cron). Do not pretend to set up tasks from inside the skill.
- **Outbound messaging / DMs / introductions on behalf of the user.** EdgeOS has no messaging endpoint. Surface contact info (Telegram, X handles) from the directory (§9) and let the user reach out themselves. Do not claim to have sent a message.
