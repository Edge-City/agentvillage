---
name: edgeos
description: Talk to the EdgeOS popup-village platform — read the event schedule in the village's local time, RSVP (after asking the person), list venues and who is going to an event, search the attendee directory and read the person's own Edge City profile through the Agent Village control plane (two scripts; the app reads EdgeOS with the person's own Edge City sign-in; the profile is read only). The current village's popup id is `$AV_POPUP_ID`; the current event is Edge City India (Oct 11 – Nov 1 2026, Mandrem, Goa). Agents cannot create or edit village events.
version: 1.7.0
author: Edge City
tags: [edgeos, events, directory, popup-village]
required_environment_variables:
  - name: EDGEOS_API_KEY
    required_for: events, RSVPs, venues, directory, own profile (the directory and profile scripts send it to the Agent Village control plane only)
  - name: CONTROL_PLANE_URL
    required_for: directory, own profile (the Agent Village control plane)
  - name: TENANT_ID
    required_for: directory, own profile (this agent's tenant on the control plane)
  - name: AV_POPUP_ID
    required_for: events, venues, directory (the current village's popup id)
metadata:
  openclaw:
    requires:
      config:
        - env.vars.EDGEOS_API_KEY
---

# EdgeOS — Agent Skill

You have access to the **EdgeOS** popup-village platform. Its base URL is `$EDGEOS_API_BASE` (default `https://api.edgeos.world/api/v1`); every recipe below writes it as `--url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/…"` so the shell picks the right one. Keep the `--url`: the approval gate holds a curl whose URL word starts with `$` (no `--url` in front) as human-only, and it never runs. Never hardcode another host. EdgeOS hosts events, RSVPs, venues, the attendee directory, and per-attendee profile lookup for one or more popups.

**The current village's popup id is `$AV_POPUP_ID`.** The current event is **Edge City India** (Mandrem, Goa, October 11 to November 1, 2026). When `AV_POPUP_ID` is set, use its value as `{popup_id}` for every event list, venue and directory call (read it with `printenv AV_POPUP_ID` and paste the UUID in). Only when `AV_POPUP_ID` is unset or empty, tell the person the village schedule isn't connected to their agent yet and point them to the Edge City portal or the organisers. Never substitute the previous popup's id (the `edge-esmeralda` skill carries Edge Esmeralda 2026's constant) and present the results as India; use that id only when the person explicitly asks about that previous popup.

## 0. What you can and cannot do

Your `$EDGEOS_API_KEY` is a partner-app attendee key. EdgeOS limits partner apps to **`events:read`, `rsvp:write`, `venues:read`**. So:

- You **can** read the schedule, read venues, see who is going to an event, RSVP the person to an event, and cancel their RSVP.
- You **cannot** create, edit, cancel, or invite people to village events, and cannot create or change venues. Those calls fail with `403`. When the person wants to host or change an event, tell them plainly that agents can't create village events and send them to the Edge City portal (the events page, `$AV_PORTAL_URL` when set) to do it themselves. Don't attempt those calls.
- Your API key **cannot** reach the attendee directory or `/humans/me` on EdgeOS itself. EdgeOS lets `eos_live_` keys call only its event, event-participant, RSVP-eligibility, venue, track, event-settings and popup routes, plus `register` and `cancel-registration`; anything else answers `403` ("API keys are restricted to approved event automation routes"). So both come only through their scripts, never a curl: the person's own profile through the profile script (§8), the directory through the directory script (§9). Each sends your key to the Agent Village control plane, whose app reads EdgeOS with the person's own Edge City sign-in. When the script exits 2, tell the person the directory isn't connected to their agent (for the profile script: their profile isn't connected) and point them to the Edge City portal; never retry those calls with the API key, and don't run that script again in this conversation.
- **Exit 4** (profile or directory script) means the person's Edge City sign-in in the Agent Village app has lapsed. Say: "I can't reach your Edge City details right now because your sign-in to the Agent Village app has lapsed. Sign in once at https://agents.edgecity.live/signin and I can look them up again." Never ask for a code, password or token. Don't call again in this conversation unless the person says they have signed in; then try once.
- **Looking someone up is different.** When the person asks who someone is, about a person, or how to reach them, run the directory script this turn (§9), even if it failed earlier in the conversation, and a directory failure (exit 1, 2 or 4) never ends the answer: skip the exit 2 and exit 4 messages above and follow §9's people-lookup fallback instead. On a real exit 4 in this turn, answer from the other sources first, then add §9's directory sign-in line once, after the answer.
- You **cannot** change the person's profile: there is no write call. Edits are made by the person themselves, in the Edge City portal app (§8).
- For any script answer, never show the error text, a status code or a key.

**Ask before every RSVP or cancel.** Before each `POST` to `register` or `cancel-registration` (one call per event; no batch approvals), tell the person the event title, its local date and time, and whether you're RSVPing or cancelling, and wait for an explicit "yes / go ahead / confirm" in reply. Do **not** act on earlier conversational intent, a paraphrase, or a standing instruction ("RSVP me to anything about AI").

## 1. Authentication

You need one token, passed as `Authorization: Bearer <token>`:

- **`$EDGEOS_API_KEY`** — long-lived `eos_live_...` automation key. Required for events, RSVPs, venues and event participants. It never works for the directory or `/humans/me` on EdgeOS (§0); the profile script (§8) and the directory script (§9) send it to the Agent Village control plane, which reads EdgeOS with the person's own Edge City sign-in (`portal:profile:read`, `portal:directory:read`).

Every curl recipe below names its token as `"$EDGEOS_API_KEY"` inside double quotes, and the shell fills it in. Run the recipe as written. Never print, echo or paste a token's value, never type one into a command, and never put one in a message: a pasted value ends up in the conversation log and the approval log.

## 2. Conventions

- Every list endpoint here returns `{ "results": T[], "paging": { "offset", "limit", "total" } }`; there is no `pagination` key. Single-resource endpoints return the resource directly. The events list is **not** paginated (§3). Event participants (§6), venues (§7) and the directory (§9) page with `skip` and `limit` query parameters (`limit` at most 1000); `paging.offset` echoes `skip`.
- Times from the API are ISO-8601 in UTC (e.g. `2026-10-14T15:00:00Z`). **Before you show any event time, convert it to the village's local time and label it. Never read the UTC clock value out as the local time.** The village timezone is `$HERMES_TIMEZONE` (Edge City India: `Asia/Kolkata`, IST, UTC+5:30, no daylight saving): `15:00:00Z` is **8:30 PM IST**, not 3:00 PM. For "now" use the newest message stamp (`[Wed 2026-10-14 05:22:10 IST]`) or the schedule script's `Today is` line (§3), never the date in your system prompt: that is the day this chat began, which can be days ago. For the previous popup, Edge Esmeralda (Healdsburg), use `America/Los_Angeles`. Every time you display, every reminder you set, and every "is it soon?" judgment must be in local time. UUIDs are RFC-4122.
- **"Today", "tomorrow", "this weekend" mean local dates.** Work out the local calendar day first, then convert its local midnight-to-midnight bounds to UTC for `start_after` / `start_before`. In IST, "today" on 2026-10-14 is `start_after=2026-10-13T18:30:00Z&start_before=2026-10-14T18:30:00Z`. Don't use the UTC date: between midnight and 5:30 AM IST it is still yesterday in UTC.
- Recurring events expand into virtual occurrences when `start_after` or `start_before` is set. Without either, a series comes back once, as its first occurrence, so give every events list a date window (§3). When RSVPing to one instance of a recurring event, pass that occurrence's `start_time` as `occurrence_start`.
- Error codes: `401` missing or invalid key · `403` token lacks the required scope · `404` not visible to caller · `409` resource has dependents · `422` validation · `429` rate limit (see `Retry-After`).
- Run every recipe below through `terminal` with exactly `command` (a `workdir` is fine) and nothing else. Do not add `notify`, `heartbeat` or `background`: each call finishes in seconds and its output comes straight back. If the call returns an error about background commands, the request was not sent; make it once more without those arguments.

## 3. Reading events

**For "what's on today / tomorrow / this weekend / on a date", use the schedule script** rather than a curl and your own date arithmetic. It works out the local day window, reads the key itself, and prints local times with the zone label, the venue, the person's RSVP status and each event's id:

```sh
bun skills/edgeos/scripts/events.ts --when today
bun skills/edgeos/scripts/events.ts --when weekend
bun skills/edgeos/scripts/events.ts --when 2026-10-20 --days 3 --search yoga
bun skills/edgeos/scripts/events.ts --when today --days 7 --rsvped
```

`--when` is `today`, `tomorrow`, `weekend` or a local date `YYYY-MM-DD`; `--days N` (up to 14) extends it (for `weekend`, N-1 more days after Sunday); each line carries the event's id and `start <ISO>`, which is the `occurrence_start` to send when RSVPing to one occurrence of a recurring event (§6); `--search WORDS` and `--rsvped` narrow it; `--json` prints the raw events instead. Call `terminal` with exactly `command` (a `workdir` is fine) and nothing else. Do not add `notify`, `heartbeat`, `background`, `watch_patterns`, `notify_on_complete` or `pty`: the script finishes in seconds and its output comes straight back. If the call returns an error about background commands, the script did not run; call it once more without those arguments. Exit 2 with "not set" means the schedule isn't connected to this agent (§0 above); exit 1 means EdgeOS was unreachable or refused, so say you can't reach the schedule right now. For anything the script doesn't cover (a tag, venue or track filter, a single event), use the recipes below.

Each event line ends with `link <url>`, its portal page: when asked for an event's link, give that one exactly as printed and never build one; if a line has no `link`, send them to the Edge City portal's events page (`$AV_PORTAL_URL` when set).

**Take the day from the script, never from your prompt.** For "today", "tomorrow" and "this weekend", pass the word (`--when today`, `--when tomorrow`, `--when weekend`), never a date you worked out. The script's first line, `Today is <Wkd YYYY-MM-DD> (IST)`, is today in the village, the second, `Now: <Wkd YYYY-MM-DD HH:MM> IST`, is the village clock, and the third, `Listing: ...`, names the days it listed: take the day from them and say it in your answer ("Today, Wed 14 Oct: ..."). Never take today's date from the conversation's start line in your prompt ("Conversation started: ..."): that is the day this chat began, which can be days ago.

**Check the Now line before offering a session; never offer one that has ended.** For today the script leaves out events that already ended and says how many; a cron run's prompt has no time of day, so take it from Now.

All event-read recipes use `Authorization: Bearer $EDGEOS_API_KEY`.

**REQUIRED parameters for all event list queries:** `popup_id={popup_id}` and `event_status=published`. `{popup_id}` is the value of `$AV_POPUP_ID` (see the top of this skill). Your API key is bound to one popup: a `popup_id` naming any other popup answers `403` ("This API key does not have access to this popup"), and an omitted one falls back to the key's own popup. Any other token without `popup_id` takes a different path: it ignores every filter except `search` (no `event_status`, `start_after`, `start_before`, `tags`, `kind`, venue or track filter) and returns at most the 100 most recently created events across every popup it can see. So always pass both.

**Give every list a date window.** `start_after` and `start_before` bound the event's start time. With either set, a recurring series comes back as one row per occurrence inside the window; with neither, it comes back once, as its first occurrence, and an RSVP to a later occurrence shows up neither in `rsvped_only=true` nor in `my_rsvp_status`.

**List upcoming events (next 30 days):**
```bash
curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&start_after={current_iso_timestamp}&start_before={end_iso}"
```
`{current_iso_timestamp}` is now and `{end_iso}` is 30 days later, both literal ISO-8601 UTC strings (e.g. `2026-10-11T00:00:00Z` and `2026-11-10T00:00:00Z`): compute them in code or via the agent's date tools, not via shell substitution. Without `start_before` the call returns every future event, however far ahead.

**List events in a date range:**
```bash
curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&start_after={start_iso}&start_before={end_iso}"
```

**Search events by title:**
```bash
curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&search=KEYWORD&start_after={start_iso}"
```

**Filter by tag, kind, venue, or track:**
```bash
curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&tags=AI&tags=Privacy&start_after={start_iso}&start_before={end_iso}"
```
`tags` matches events carrying any of the given tags. The other filters are `kind`, `venue_id` (a venue's `id` from §7; repeat `venue_ids` for several) and repeated `track_ids` (an event's `track_id`).

**Only events you've RSVPed to:**
```bash
curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events?popup_id={popup_id}&event_status=published&rsvped_only=true&start_after={current_iso_timestamp}"
```

**Fetch a single event (includes caller's RSVP status):**
```bash
curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"
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
curl -s -X POST -H "Authorization: Bearer $EDGEOS_API_KEY" \
  -H "Content-Type: application/json" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/register/{event_id}" \
  -d '{}'
```

**RSVP to one occurrence of a recurring event:**
```bash
curl -s -X POST -H "Authorization: Bearer $EDGEOS_API_KEY" \
  -H "Content-Type: application/json" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/register/{event_id}" \
  -d '{"occurrence_start":"{occurrence_iso}"}'
```

**Cancel a previous RSVP:**
```bash
curl -s -X POST -H "Authorization: Bearer $EDGEOS_API_KEY" \
  -H "Content-Type: application/json" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/cancel-registration/{event_id}" \
  -d '{}'
```

**List who is going to one event (`event_id` is required):**
```bash
curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/participants?event_id={event_id}&skip=0&limit=100"
```

This lists the participants of **one** event, the caller included if they RSVPed; it is not a list of the caller's own RSVPs, and without `event_id` it fails with `422`. Each row carries a participation `status` (a cancelled RSVP stays in the list with its status). For a recurring event, always add `&occurrence_start={occurrence_iso}` (that occurrence's `start_time`, exactly). If you leave it out, the list holds only the RSVPs not tied to any occurrence (for an event with no host, it mixes the RSVPs of every occurrence instead); RSVPs are made per occurrence, so for a recurring event that list is usually empty or short, and it does **not** mean nobody is going. For the count alone, the single-event read with `?occurrence_start=` returns `attendee_count` (§3). The event's host is not listed, and attendees who chose to hide their name on their application are left out entirely. It pages with `skip` and `limit` (default 100, at most 1000): fetch again with a larger `skip` only while `skip + results.length < paging.total`. To find the caller's own RSVPs, use the events list with `rsvped_only=true` (§3).

## 7. Venues

**List active venues for a popup (`popup_id` is required: the UUID in `$AV_POPUP_ID`; your API key answers `403` for any other popup):**
```bash
curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \
  --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-venues/portal/venues?popup_id={popup_id}&limit=100"
```

Creating, editing, or deleting venues needs `venues:write`, which agents don't have (§4).

## 8. Your own profile (`portal:profile:read`; through the Agent Village control plane; read only)

The person's own profile comes through the Agent Village control plane, which has the Agent Village app read it from EdgeOS (`/humans/me`) with the person's own Edge City sign-in (`portal:profile:read`; nothing is stored on the way). Only when the control plane isn't connected does the script also try EdgeOS itself with your API key, which EdgeOS refuses today; either way it prints the same fields. Use the script, never a curl:

```sh
bun skills/edgeos/scripts/profile.ts
bun skills/edgeos/scripts/profile.ts --json
```

Call `terminal` with exactly `command` (a `workdir` is fine) and nothing else. Do not add `notify`, `heartbeat`, `background`, `watch_patterns`, `notify_on_complete` or `pty`: the script finishes in seconds and its output comes straight back. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

**Private chat only.** Read and share the person's profile only in your private chat with them (or in your own scheduled job delivering to that private chat); never in a group or shared chat, and never for anyone but the person whose agent you are.

It prints the person's own profile and nothing more, one line per filled-in field: `first_name`, `last_name`, `email`, `telegram`, `gender`, `age`, `residence`, `picture_url`. `--json` prints the same eight fields as one object, `null` where the person never filled one in. It carries no application answers, no participation and no other social handles.

**Edits are made in the Edge City portal app, never by you.** There is no write call: you cannot change the profile. When the person wants to change their name, Telegram handle, picture or any other field, tell them to edit it themselves in the Edge City portal app (`$AV_PORTAL_URL` when set); application answers and popup form fields are edited there too. Don't offer to make the change for them.

**Exit 4** means the person's sign-in to the Agent Village app has lapsed: follow §0 (ask them to sign in once). **Exit 2** means the profile isn't connected to this agent: follow §0 (tell the person, point them to the Edge City portal, don't retry in this conversation). **Exit 1** means it can't be reached right now: say you can't reach their profile right now; you may try again later if asked again. Exit 3 is a usage error. Never show the error text, a status code or a key.

## 9. Attendee directory (`portal:directory:read`; through the Agent Village control plane)

The directory comes through the Agent Village control plane, which has the Agent Village app read it from EdgeOS with the person's own Edge City sign-in (`portal:directory:read`; nothing is stored on the way). Only when the control plane isn't connected does the script also try EdgeOS's own directory with your API key, which EdgeOS refuses today; either way it prints the same rows. Use the script, never a curl:

```sh
bun skills/edgeos/scripts/directory.ts --search "Priya"
bun skills/edgeos/scripts/directory.ts --search "priya@example.com" --json
bun skills/edgeos/scripts/directory.ts --limit 100 --skip 100
```

Call `terminal` with exactly `command` (a `workdir` is fine) and nothing else. Do not add `notify`, `heartbeat`, `background`, `watch_patterns`, `notify_on_complete` or `pty`: the script finishes in seconds and its output comes straight back. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

`--search` (1-120 characters) matches the first name, last name, full name, email and Telegram fields, and only where the attendee has shared them. It does not search `role` or `organization`; to find people by those, list the directory and filter the rows yourself. Leave `--search` out to list everyone. `--hide-empty` sends `hide_empty_rows=true`, which drops rows with no shared name, email, Telegram, role or organization. The script uses the current village (`$AV_POPUP_ID`); pass `--popup <id>` only when the person asks about the previous popup (the `edge-esmeralda` skill's id). Each line is one attendee, `hidden` where the attendee hid a field; `--json` prints the rows instead, as `{ results: Attendee[], paging: { offset, limit, total } }`.

**Pagination:** `--skip` (up to 5000) + `--limit` (default 20, at most 100). Fetch again with a larger `--skip` only while `skip + results < total` (the last line says `more: --skip N`). There is no week, family or other per-popup filter. The directory lists the main applicants and spouses of accepted applications who hold a ticket (children are not listed), newest first.

**Exit 2** means the directory isn't connected to this agent (or that popup has no directory): follow §0 (tell the person, point them to the Edge City portal, don't retry in this conversation). **Exit 4** means the person's sign-in to the Agent Village app has lapsed: follow §0. **Exit 1** means it can't be reached right now: say you can't reach the directory right now; you may try again later if asked again. Exit 3 is a usage error: fix the arguments. Never show the error text, a status code or a key.

**People-lookup fallback: never stop at the directory.** For who is X, tell me about a person, or how do I reach someone, always call a source this turn: the directory script (`--search` the name), or `village` `rolodex.search`, or `ask_village`. Index matches are not a people search. Never report a source as unavailable, expired or not connected from memory or from earlier in the conversation: an earlier failure is stale, so call it again now. Only a failure in this turn counts. When the directory really fails this turn (exit 1, 2 or 4, whatever it says: expired, lapsed, unavailable, refused, not connected), move on in the same turn to the sources you have not tried yet, in this order: 1. `village` `rolodex.search`, when that tool is installed (find it with `tool_search` "rolodex"); 2. `ask_village`: ask what people said about them in the main village group, never for their contact details (find it with `tool_search` "ask_village"); 3. the public website copy in the `edge-india` skill. The chain ends there. For how do I reach someone, never look up contact details anywhere else: share only what the directory or Rolodex shows, and otherwise suggest their Rolodex card or a village intro instead. Answer from what those find. Apart from the one line allowed below, never say the directory or its access expired or is unavailable, never give a failure as the reason you can't find someone, and never end the answer on it. At most add one short line: "the directory isn't reachable right now". The one exception is a real exit 4 in this turn (the person's Edge City sign-in isn't connected): still answer from the other sources first, then add this directory sign-in line once, after the answer, instead of the short line: "To let me search the attendee directory too, sign in once at https://agents.edgecity.live/signin." No other line about the directory. Only when every source comes up empty, say you couldn't find them in the village sources and suggest asking in the village group or the Edge City portal.

**Fields:** every row has `id` (the attendee id), `first_name`, `last_name`, `email`, `telegram`, `role`, `organization`, `residence`, `age`, `gender`, `picture_url`, `category` (`main` or `spouse`), `participation` (the attendee's tickets, each `{ id, name, slug, category, duration_type }`) and `associated_attendees` (always an empty list: a spouse is a row of their own). The shape is the same for every popup. Any field can be null when the attendee never filled it in.

**Privacy:** an attendee can hide any of `first_name`, `last_name`, `email`, `telegram`, `role`, `organization`, `residence`, `age` and `gender` on their application; a hidden field comes back as the literal string `"*"`. `picture_url`, `category` and `participation` are never masked. Only a main applicant's row carries masks; a spouse's row has none and leaves `role` and `organization` empty. A `"*"` is intentionally hidden by the attendee: do not infer around it, surface the privacy boundary to the user. The mask is the same for every caller: no token or scope sees behind a `"*"`.

## 10. Tips for answering well

- **Always use live API calls** for schedule and attendee queries — do not rely on cached or memorized data.
- **Be specific with dates.** For today, tomorrow and this weekend use the schedule script (§3). For a curl recipe, convert "this Thursday" or "next week" to actual ISO-8601 timestamps with timezone before querying, counting from the day in the newest message stamp.
- **Pagination:** the events list is not paginated; one call returns every match (§3). Event participants and venues take `skip` + `limit` (at most 1000), the directory script `--skip` + `--limit` (at most 100); all answer `{results, paging}`; page only while `skip + results.length < paging.total`.
- **Recurring events:** when RSVPing to one instance, pass `occurrence_start` matching the virtual occurrence's `start_time`.

## 11. What's NOT available

Be honest about these gaps — do not hallucinate answers.

- **Session transcripts / summaries.** EdgeOS does not record talks. Tell the user: "Session recordings and transcripts aren't available through EdgeOS — check the popup's Telegram group for recaps."
- **Governance / deliberation.** There is no governance layer on EdgeOS itself. Community discussion happens in the popup's external channels.
- **Real-time venue availability.** The calendar shows scheduled events, but there is no live venue booking system. To check if a venue is free, list events for that date/time and see whether the venue is already taken.
- **Profile edits.** You can read the person's own profile (§8) but not change it: basic fields (`first_name`, `last_name`, `telegram`, `gender`, `age`, `residence`, `picture_url`), dietary preferences, application answers, "what I'm building" and popup-specific form fields are all edited by the person themselves in the Edge City portal app (under `/portal/profile`). You cannot edit anyone else's profile regardless.
- **Scheduled tasks / recurring summaries / reminders.** The skill itself cannot schedule anything. Set them up with your own scheduling tool (`cronjob_manage`), which goes through the approval gate like any other action. Do not tell the user to type a slash command for this: commands such as `/loop` are not available to residents. Do not pretend to set up tasks from inside the skill.
- **Outbound messaging / DMs / introductions on behalf of the user.** EdgeOS has no messaging endpoint. Surface contact info (a Telegram handle or email, when the attendee shares it) from the directory (§9) and let the user reach out themselves. Do not claim to have sent a message.
