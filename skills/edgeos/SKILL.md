---
name: edgeos
description: Talk to the EdgeOS popup-village platform — read the event schedule in the village's local time, RSVP (after asking the person), list venues and who is going to an event (all through the skill's own scripts, never a curl), search the attendee directory and read the person's own Edge City profile through the Agent Village control plane (the app reads EdgeOS with the person's own Edge City sign-in; the profile is read only). The current village's popup id is `$AV_POPUP_ID`; the current event is Edge City India (Oct 11 – Nov 1 2026, Mandrem, Goa). Agents cannot create or edit village events.
version: 1.8.0
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

You have access to the **EdgeOS** popup-village platform. You reach it **only through this skill's scripts** (`bun skills/edgeos/scripts/…`), never with `curl`, `wget` or code of your own: each script reads the key, the popup id and the EdgeOS address (`$EDGEOS_API_BASE`, default `https://api.edgeos.world/api/v1`) itself and refuses any other host. EdgeOS hosts events, RSVPs, venues, the attendee directory, and per-attendee profile lookup for one or more popups.

**The current village's popup id is `$AV_POPUP_ID`.** The current event is **Edge City India** (Mandrem, Goa, October 11 to November 1, 2026). The scripts use it for every event list, venue and directory call themselves; you never type it in. When a script exits 2 saying `AV_POPUP_ID is not set`, tell the person the village schedule isn't connected to their agent yet and point them to the Edge City portal or the organisers. Never substitute another popup's id and present the results as India.

## 0. What you can and cannot do

Your EdgeOS API key (`EDGEOS_API_KEY`, which the scripts read themselves) is a partner-app attendee key. EdgeOS limits partner apps to **`events:read`, `rsvp:write`, `venues:read`**. So:

- You **can** read the schedule, read venues, see who is going to an event, RSVP the person to an event, and cancel their RSVP.
- You **cannot** create, edit, cancel, or invite people to village events, and cannot create or change venues. Those calls fail with `403`. When the person wants to host or change an event, tell them plainly that agents can't create village events and send them to the Edge City portal (the events page, `$AV_PORTAL_URL` when set) to do it themselves. Don't attempt those calls.
- Your API key **cannot** reach the attendee directory or `/humans/me` on EdgeOS itself. EdgeOS lets `eos_live_` keys call only its event, event-participant, RSVP-eligibility, venue, track, event-settings and popup routes, plus `register` and `cancel-registration`; anything else answers `403` ("API keys are restricted to approved event automation routes"). So both come only through their scripts, never a curl: the person's own profile through the profile script (§8), the directory through the directory script (§9). Each sends your key to the Agent Village control plane, whose app reads EdgeOS with the person's own Edge City sign-in. When the script exits 2, tell the person the directory isn't connected to their agent (for the profile script: their profile isn't connected) and point them to the Edge City portal; never retry those calls with the API key, and don't run that script again in this conversation.
- **Exit 4** (profile or directory script) means the person's Edge City sign-in in the Agent Village app has lapsed. Say: "I can't reach your Edge City details right now because your sign-in to the Agent Village app has lapsed. Sign in once at https://agents.edgecity.live/signin and I can look them up again." Never ask for a code, password or token. Don't call again in this conversation unless the person says they have signed in; then try once.
- **Looking someone up is different.** When the person asks who someone is, about a person, or how to reach them, run the directory script this turn (§9), even if it failed earlier in the conversation, and a directory failure (exit 1, 2 or 4) never ends the answer: skip the exit 2 and exit 4 messages above and follow §9's people-lookup fallback instead. On a real exit 4 in this turn, answer from the other sources first, then add §9's directory sign-in line once, after the answer.
- You **cannot** change the person's profile: there is no write call. Edits are made by the person themselves, in the Edge City portal app (§8).
- For any script answer, never show the error text, a status code or a key.

**Ask before every RSVP or cancel.** Before each `rsvp` or `cancel` run of the EdgeOS script (one run per event; no batch approvals), tell the person the event title, its local date and time, and whether you're RSVPing or cancelling, and wait for an explicit "yes / go ahead / confirm" in reply. Do **not** act on earlier conversational intent, a paraphrase, or a standing instruction ("RSVP me to anything about AI").

## 1. Authentication

One token, which the scripts read themselves:

- **`EDGEOS_API_KEY`** — long-lived `eos_live_...` automation key. Required for events, RSVPs, venues and event participants. It never works for the directory or `/humans/me` on EdgeOS (§0); the profile script (§8) and the directory script (§9) send it to the Agent Village control plane, which reads EdgeOS with the person's own Edge City sign-in (`portal:profile:read`, `portal:directory:read`).

Every command below is a script that reads the key from its own environment: no command names the key, and none needs it. Never print, echo or paste a token's value, never type one or a variable holding one into a command, never write your own `curl` to EdgeOS, and never put a token in a message: a pasted value ends up in the conversation log and the approval log, and a hand-written EdgeOS curl is refused by the approval gate.

## 2. Conventions

- Every list endpoint here returns `{ "results": T[], "paging": { "offset", "limit", "total" } }`; there is no `pagination` key. Single-resource endpoints return the resource directly. The events list is **not** paginated (§3). Event participants (§6) and venues (§7) page with `--skip` and `--limit` (`--limit` at most 1000), the directory (§9) with its own `--skip` and `--limit`; `paging.offset` echoes the skip.
- Times from the API are ISO-8601 in UTC (e.g. `2026-10-14T15:00:00Z`). **Before you show any event time, convert it to the village's local time and label it. Never read the UTC clock value out as the local time.** The village timezone is `$HERMES_TIMEZONE` (Edge City India: `Asia/Kolkata`, IST, UTC+5:30, no daylight saving): `15:00:00Z` is **8:30 PM IST**, not 3:00 PM. For "now" use the newest message stamp (`[Wed 2026-10-14 05:22:10 IST]`) or the schedule script's `Today is` line (§3), never the date in your system prompt: that is the day this chat began, which can be days ago. Every time you display, every reminder you set, and every "is it soon?" judgment must be in local time. UUIDs are RFC-4122.
- **"Today", "tomorrow", "this weekend" mean local dates.** For today, tomorrow and the weekend the schedule script does this for you (§3). Otherwise work out the local calendar day first, then convert its local midnight-to-midnight bounds to UTC for `--after` / `--before`. In IST, "today" on 2026-10-14 is `--after 2026-10-13T18:30:00Z --before 2026-10-14T18:30:00Z`. Don't use the UTC date: between midnight and 5:30 AM IST it is still yesterday in UTC.
- Recurring events expand into virtual occurrences inside a date window, so every events list takes one (§3). When RSVPing to one instance of a recurring event, pass that occurrence's `start_time` as `--occurrence` (a portal link to one session carries it as `?occ=<ISO>`, §3).
- **The EdgeOS script** (`bun skills/edgeos/scripts/edgeos.ts <verb> …`, §3, §6, §7) prints EdgeOS's JSON answer. **Exit 0** is that answer. **Exit 2** with "not set" means EdgeOS isn't connected to this agent (§0). **Exit 1** with a line starting `edgeos: EdgeOS` means EdgeOS was unreachable or answered an error; that line names the status and, when EdgeOS gave one, its short reason (`401` key refused · `403` not allowed for this key or popup · `404` not found or not visible · `409` conflict, e.g. already checked in · `422` invalid · `429` rate limited, retry later): say what that means in plain words, never the raw line. **Exit 3** is a usage error: fix the arguments. **Exit 5** (only an `rsvp` without `--occurrence`) means the event is recurring and nothing was booked: the lines after it list the next sessions; ask the person which one (§6). If bun answers that the script or module was not found, the command ran from the wrong folder: run it again with `workdir` set to your absolute `HERMES_HOME` directory; that is not EdgeOS being unreachable, so never tell the person it is.
- Run every `bun skills/edgeos/scripts/…` command from your Hermes folder (the paths are relative to it): call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else; the approval gate refuses a `terminal` call without that absolute `workdir`. Do not add `notify`, `heartbeat` or `background`: each call finishes in seconds and its output comes straight back. If the call returns an error about background commands, the request was not sent; make it once more without those arguments.

## 3. Reading events

**For "what's on today / tomorrow / this weekend / on a date", use the schedule script** rather than the events list and your own date arithmetic. It works out the local day window, reads the key itself, and prints local times with the zone label, the venue, the person's RSVP status and each event's id:

```sh
bun skills/edgeos/scripts/events.ts --when today
bun skills/edgeos/scripts/events.ts --when weekend
bun skills/edgeos/scripts/events.ts --when 2026-10-20 --days 3 --search yoga
bun skills/edgeos/scripts/events.ts --when today --days 7 --rsvped
```

`--when` is `today`, `tomorrow`, `weekend` or a local date `YYYY-MM-DD`; `--days N` (up to 14) extends it (for `weekend`, N-1 more days after Sunday); each line carries the event's id and `start <ISO>`, which is the `--occurrence` to pass when RSVPing to one occurrence of a recurring event (§6); `--search WORDS` and `--rsvped` narrow it; `--json` prints the raw events instead. Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat`, `background`, `watch_patterns`, `notify_on_complete` or `pty`: the script finishes in seconds and its output comes straight back. If the call returns an error about background commands, the script did not run; call it once more without those arguments. Exit 2 with "not set" means the schedule isn't connected to this agent (§0 above); exit 1 means EdgeOS was unreachable or refused, so say you can't reach the schedule right now. For anything the schedule script doesn't cover (a tag, venue or track filter, a single event, a longer window), use the EdgeOS script below.

Each event line ends with `link <url>`, its portal page: when asked for an event's link, give that one exactly as printed and never build one; if a line has no `link`, send them to the Edge City portal's events page (`$AV_PORTAL_URL` when set).

**Take the day from the script, never from your prompt.** For "today", "tomorrow" and "this weekend", pass the word (`--when today`, `--when tomorrow`, `--when weekend`), never a date you worked out. The script's first line, `Today is <Wkd YYYY-MM-DD> (IST)`, is today in the village, the second, `Now: <Wkd YYYY-MM-DD HH:MM> IST`, is the village clock, and the third, `Listing: ...`, names the days it listed: take the day from them and say it in your answer ("Today, Wed 14 Oct: ..."). Never take today's date from the conversation's start line in your prompt ("Conversation started: ..."): that is the day this chat began, which can be days ago.

**Check the Now line before offering a session; never offer one that has ended.** For today the script leaves out events that already ended and says how many; a cron run's prompt has no time of day, so take it from Now.

**The EdgeOS script** (`bun skills/edgeos/scripts/edgeos.ts <verb> …`) reads the key and the popup itself and makes one EdgeOS call per run (an `rsvp` without `--occurrence` reads the event first, §6), printing EdgeOS's JSON answer (exit codes in §2). Replace each `{…}` in the commands below with the literal value (an id from the schedule or a list, a time as an ISO-8601 UTC instant).

**Every events list is the current village's published events.** The script always sends the popup id (`$AV_POPUP_ID`) and `event_status=published`; your API key is bound to that popup, and `--popup <id>` naming any other popup answers `403` ("This API key does not have access to this popup"), so pass `--popup` only when the person asks about the previous popup. (Without a popup id, any token that is not bound to a popup ignores every filter except `search` and gets at most the 100 most recently created events across every popup it can see, which is why the script never leaves it out.)

**Give every list a date window.** `--after` (required) and `--before` bound the event's start time, as literal ISO-8601 UTC instants (e.g. `2026-10-11T00:00:00Z`): compute them yourself, counting from the day in the newest message stamp, not via shell substitution. With a window, a recurring series comes back as one row per occurrence inside it; without `--before` the list runs to every future event, however far ahead. Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat` or `background`. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

**List upcoming events (next 30 days):**
```sh
bun skills/edgeos/scripts/edgeos.ts list --after {current_iso_timestamp} --before {end_iso}
```
`{current_iso_timestamp}` is now and `{end_iso}` is 30 days later.

**List events in a date range:**
```sh
bun skills/edgeos/scripts/edgeos.ts list --after {start_iso} --before {end_iso}
```

Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat` or `background`. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

**Search events by title:**
```sh
bun skills/edgeos/scripts/edgeos.ts list --after {start_iso} --search "KEYWORD"
```

**Filter by tag, kind, venue, or track:**
```sh
bun skills/edgeos/scripts/edgeos.ts list --after {start_iso} --before {end_iso} --tag AI --tag Privacy
```
`--tag` (repeat it for several) matches events carrying any of the given tags. The other filters are `--kind KIND`, `--venue <venue id>` (a venue's `id` from §7; repeat it for several) and `--track <track id>` (an event's `track_id`; repeat it for several).

Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat` or `background`. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

**Only events you've RSVPed to:**
```sh
bun skills/edgeos/scripts/edgeos.ts list --after {current_iso_timestamp} --rsvped
```

**Fetch a single event (includes caller's RSVP status):**
```sh
bun skills/edgeos/scripts/edgeos.ts event {event_id}
```

For a recurring event, scope the RSVP lookup to one instance with `--occurrence {occurrence_iso}`. **A recurring event read without `--occurrence` describes only the series' FIRST session:** its `my_rsvp_status` and `attendee_count` are that first session's, not the session the person RSVPed to, and the script says so on a line after the JSON (`recurring event: this is the FIRST occurrence (start …)`). So never conclude "no RSVP" or "nobody is going" from such a read: read it again with `--occurrence`, set to that session's start exactly as it was given to you: the schedule line's `start <ISO>`, a list row's `start_time`, or the `?occ=` value of a portal link (a portal link to one session of a recurring event ends in `?occ=<ISO>`; pass that value with `%3A` written as `:` and `%2B` as `+`, though the script also takes it still encoded). With `--occurrence`, the line after the JSON is `occurrence <ISO>`, the session the answer describes. Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat` or `background`. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

**No pagination:** the events list returns every matching event in one response. It takes no `skip` or `limit` (a `limit` you add is ignored), so don't loop over pages; narrow the call with `--after` / `--before`, `--search`, `--tag` and the other filters instead. Its `paging` is informational only: `paging.limit` is the number of results returned, and `paging.total` counts occurrences before visibility filtering, so it can be larger than `results.length`. Never fetch again because `total` looks bigger.

**Your own RSVPs:** EdgeOS has no route that lists one person's RSVPs across events. Use the list with `--rsvped` (above; it sends `rsvped_only=true`): it returns the events in the popup where the caller has an RSVP that isn't cancelled. Every event, in the list or a single read, also carries `my_rsvp_status`: null when the caller has no RSVP for it, otherwise `registered`, `checked_in` or `cancelled` (a cancelled RSVP keeps its row, so `cancelled` means they are not going). A single read also carries `attendee_count`, the number of RSVPs that aren't cancelled (for a recurring event, of the occurrence named by `--occurrence`, or of the first session without it).

**Highlighted events:** event records include a boolean `highlighted` field. The list has no `highlighted` filter; list the relevant date range and pick the events whose `highlighted` is `true`.

## 4. Creating or changing events: not available

Agents cannot create, edit, cancel, or send invitations for village events, and cannot create, edit, or delete venues: partner-app keys don't carry `events:write` or `venues:write`. Say so plainly and point the person to the Edge City portal (`$AV_PORTAL_URL` when set), where they can host an event themselves.

## 5. Showing the schedule

- Group events by local day and show local start and end times with the zone label (e.g. "Wed 14 Oct, 8:30–9:30 PM IST").
- Mention the venue and whether the person has already RSVPed (`my_rsvp_status` on each event, in the list or a single read; `--rsvped` narrows the list to their RSVPs).
- When offering to RSVP, name the event and its local time and ask; act only on a yes (§0).

## 6. RSVP (`rsvp:write`; ask first, every time, see §0)

Each RSVP or cancel is one run of the EdgeOS script, only after the person said yes to that event (§0). It prints EdgeOS's participant record (its `status` is `registered`, or `cancelled` after a cancel); exit 1 means it did not happen, so say so plainly. Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat` or `background`. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

**RSVP to a one-off event:**
```sh
bun skills/edgeos/scripts/edgeos.ts rsvp {event_id}
```

**RSVP to one occurrence of a recurring event:**
```sh
bun skills/edgeos/scripts/edgeos.ts rsvp {event_id} --occurrence {occurrence_iso}
```
`{occurrence_iso}` is the session's start exactly as the schedule line's `start <ISO>`, a list row's `start_time` or a portal link's `?occ=` value gives it (§3), never a time you work out or round yourself. **An `rsvp` without `--occurrence` on a recurring event books nothing:** the script exits 5 and lists the series' next sessions, one `start <ISO>` each; ask the person which one, then run the command above with that start. A session listed as `its own event <id>` was moved off the series: RSVP to it as a one-off, with that id and no `--occurrence`. If EdgeOS answers `400` with `does not match a scheduled occurrence`, that start is not one of the series' sessions: list the series with a window around that day and copy the row's `start_time`; with `not allowed for non-recurring events`, the event is a one-off: RSVP without `--occurrence`.

Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat` or `background`. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

**Cancel a previous RSVP:**
```sh
bun skills/edgeos/scripts/edgeos.ts cancel {event_id}
```
For one occurrence of a recurring event, add `--occurrence {occurrence_iso}` (the occurrence you RSVPed to).

**List who is going to one event (`event_id` is required):**
```sh
bun skills/edgeos/scripts/edgeos.ts participants {event_id} --skip 0 --limit 100
```

Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat` or `background`: each run finishes in seconds. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

This lists the participants of **one** event, the caller included if they RSVPed; it is not a list of the caller's own RSVPs. Each row carries a participation `status` (a cancelled RSVP stays in the list with its status). For a recurring event, always add `--occurrence {occurrence_iso}` (that occurrence's `start_time`, exactly). If you leave it out, the list holds only the RSVPs not tied to any occurrence (for an event with no host, it mixes the RSVPs of every occurrence instead); RSVPs are made per occurrence, so for a recurring event that list is usually empty or short, and it does **not** mean nobody is going. For the count alone, the single-event read with `--occurrence` returns `attendee_count` (§3). The event's host is not listed, and attendees who chose to hide their name on their application are left out entirely. It pages with `--skip` and `--limit` (default 100, at most 1000): run it again with a larger `--skip` only while `skip + results.length < paging.total`. To find the caller's own RSVPs, use the events list with `--rsvped` (§3).

## 7. Venues

**List active venues for a popup (the script sends the current village's popup id, `$AV_POPUP_ID`; your API key answers `403` for any other popup):**
```sh
bun skills/edgeos/scripts/edgeos.ts venues --limit 100
```

Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat` or `background`. If the call returns an error about background commands, the script did not run; call it once more without those arguments. It pages with `--skip` and `--limit` as §6's participants list does.

Creating, editing, or deleting venues needs `venues:write`, which agents don't have (§4).

## 8. Your own profile (`portal:profile:read`; through the Agent Village control plane; read only)

The person's own profile comes through the Agent Village control plane, which has the Agent Village app read it from EdgeOS (`/humans/me`) with the person's own Edge City sign-in (`portal:profile:read`; nothing is stored on the way). Only when the control plane isn't connected does the script also try EdgeOS itself with your API key, which EdgeOS refuses today; either way it prints the same fields. Use the script, never a curl:

```sh
bun skills/edgeos/scripts/profile.ts
bun skills/edgeos/scripts/profile.ts --json
```

Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat`, `background`, `watch_patterns`, `notify_on_complete` or `pty`: the script finishes in seconds and its output comes straight back. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

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

Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) and nothing else. Do not add `notify`, `heartbeat`, `background`, `watch_patterns`, `notify_on_complete` or `pty`: the script finishes in seconds and its output comes straight back. If the call returns an error about background commands, the script did not run; call it once more without those arguments.

`--search` (1-120 characters) matches the first name, last name, full name, email and Telegram fields, and only where the attendee has shared them. It does not search `role` or `organization`; to find people by those, list the directory and filter the rows yourself. Leave `--search` out to list everyone. `--hide-empty` sends `hide_empty_rows=true`, which drops rows with no shared name, email, Telegram, role or organization. The script uses the current village (`$AV_POPUP_ID`); pass `--popup <id>` only when the person gives you another popup's id and asks about it. Each line is one attendee, `hidden` where the attendee hid a field; `--json` prints the rows instead, as `{ results: Attendee[], paging: { offset, limit, total } }`.

**Pagination:** `--skip` (up to 5000) + `--limit` (default 20, at most 100). Fetch again with a larger `--skip` only while `skip + results < total` (the last line says `more: --skip N`). There is no week, family or other per-popup filter. The directory lists the main applicants and spouses of accepted applications who hold a ticket (children are not listed), newest first.

**Exit 2** means the directory isn't connected to this agent (or that popup has no directory): follow §0 (tell the person, point them to the Edge City portal, don't retry in this conversation). **Exit 4** means the person's sign-in to the Agent Village app has lapsed: follow §0. **Exit 1** means it can't be reached right now: say you can't reach the directory right now; you may try again later if asked again. Exit 3 is a usage error: fix the arguments. Never show the error text, a status code or a key.

**People-lookup fallback: never stop at the directory.** For who is X, tell me about a person, or how do I reach someone, always call a source this turn: the directory script (`--search` the name), or `village` `rolodex.search`, or `ask_village`. Index matches are not a people search. Never report a source as unavailable, expired or not connected from memory or from earlier in the conversation: an earlier failure is stale, so call it again now. Only a failure in this turn counts. When the directory really fails this turn (exit 1, 2 or 4, whatever it says: expired, lapsed, unavailable, refused, not connected), move on in the same turn to the sources you have not tried yet, in this order: 1. `village` `rolodex.search`, when that tool is installed (find it with `tool_search` "rolodex"); 2. `ask_village`: ask what people said about them in the main village group, never for their contact details (find it with `tool_search` "ask_village"); 3. the public website copy in the `edge-india` skill. The chain ends there. For how do I reach someone, never look up contact details anywhere else: share only what the directory or Rolodex shows, and otherwise suggest their Rolodex card or a village intro instead. Answer from what those find. Apart from the one line allowed below, never say the directory or its access expired or is unavailable, never give a failure as the reason you can't find someone, and never end the answer on it. At most add one short line: "the directory isn't reachable right now". The one exception is a real exit 4 in this turn (the person's Edge City sign-in isn't connected): still answer from the other sources first, then add this directory sign-in line once, after the answer, instead of the short line: "To let me search the attendee directory too, sign in once at https://agents.edgecity.live/signin." No other line about the directory. Only when every source comes up empty, say you couldn't find them in the village sources and suggest asking in the village group or the Edge City portal.

**Fields:** every row has `id` (the attendee id), `first_name`, `last_name`, `email`, `telegram`, `role`, `organization`, `residence`, `age`, `gender`, `picture_url`, `category` (`main` or `spouse`), `participation` (the attendee's tickets, each `{ id, name, slug, category, duration_type }`) and `associated_attendees` (always an empty list: a spouse is a row of their own). The shape is the same for every popup. Any field can be null when the attendee never filled it in.

**Privacy:** an attendee can hide any of `first_name`, `last_name`, `email`, `telegram`, `role`, `organization`, `residence`, `age` and `gender` on their application; a hidden field comes back as the literal string `"*"`. `picture_url`, `category` and `participation` are never masked. Only a main applicant's row carries masks; a spouse's row has none and leaves `role` and `organization` empty. A `"*"` is intentionally hidden by the attendee: do not infer around it, surface the privacy boundary to the user. The mask is the same for every caller: no token or scope sees behind a `"*"`.

## 10. Tips for answering well

- **Always use live API calls** for schedule and attendee queries — do not rely on cached or memorized data.
- **Be specific with dates.** For today, tomorrow and this weekend use the schedule script (§3). For the EdgeOS script's `list`, convert "this Thursday" or "next week" to actual ISO-8601 timestamps with timezone before querying, counting from the day in the newest message stamp.
- **Pagination:** the events list is not paginated; one call returns every match (§3). Event participants and venues take `--skip` + `--limit` (at most 1000), the directory script `--skip` + `--limit` (at most 100); all answer `{results, paging}`; page only while `skip + results.length < paging.total`.
- **Recurring events:** when RSVPing to one instance, pass `--occurrence` with the virtual occurrence's `start_time` (a portal link's `?occ=` value is that start); a read without it describes the first session only, and an `rsvp` without it books nothing (exit 5, §6).

## 11. What's NOT available

Be honest about these gaps — do not hallucinate answers.

- **Session transcripts / summaries.** EdgeOS does not record talks. Tell the user: "Session recordings and transcripts aren't available through EdgeOS — check the popup's Telegram group for recaps."
- **Governance / deliberation.** There is no governance layer on EdgeOS itself. Community discussion happens in the popup's external channels.
- **Real-time venue availability.** The calendar shows scheduled events, but there is no live venue booking system. To check if a venue is free, list events for that date/time and see whether the venue is already taken.
- **Profile edits.** You can read the person's own profile (§8) but not change it: basic fields (`first_name`, `last_name`, `telegram`, `gender`, `age`, `residence`, `picture_url`), dietary preferences, application answers, "what I'm building" and popup-specific form fields are all edited by the person themselves in the Edge City portal app (under `/portal/profile`). You cannot edit anyone else's profile regardless.
- **Scheduled tasks / recurring summaries / reminders.** The skill itself cannot schedule anything. Set them up with your own scheduling tool (`cronjob_manage`), which goes through the approval gate like any other action. Do not tell the user to type a slash command for this: commands such as `/loop` are not available to residents. Do not pretend to set up tasks from inside the skill.
- **Outbound messaging / DMs / introductions on behalf of the user.** EdgeOS has no messaging endpoint. Surface contact info (a Telegram handle or email, when the attendee shares it) from the directory (§9) and let the user reach out themselves. Do not claim to have sent a message.
