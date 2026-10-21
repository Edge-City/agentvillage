# Kismet: the app-server contract (version 1.1.0)

This is what the Agent Village **app server** must expose for the four native
Kismet operations, and how each maps to Kismet's partner API. The resident's
agent never sees the partner key, Kismet's endpoints or the resident id; the
native plugin (`plugins/village-bridge/_kismet.py`) already enforces the
argument shapes, the owner-turn boundary and the reviewed answer shapes
below, and the app server enforces them again.

```
agent --village tool--> native plugin --POST /api/v1/village-bridge/tool (avb_ bearer)--> AV app server
      --POST https://kismet-village.vercel.app/api/village/<op> (Bearer VILLAGE_PARTNER_KEY)--> Kismet
```

## 1. Gatekeeping on the app server

For every `kismet.*` request the app server:

1. resolves the paired resident from the `avb_` bearer, exactly as for every
   other bridge operation (no tenant, resident or Telegram argument exists);
2. checks the resident's installed CP catalog entry is exactly
   `{id:"kismet", version:"1.1.0", operations:["mini-app.read","kismet.status","kismet.signup","kismet.decide","kismet.delete"], skills:["kismet"]}`
   and carries the operation (the 1.0.0 entry carries `mini-app.read` only:
   refuse every `kismet.*` with the existing not-installed answer);
3. checks the request body has exactly the keys listed in section 3 and
   refuses anything else (`400`, as for other operations);
4. calls Kismet with the server-side secret `VILLAGE_PARTNER_KEY` (Deon shares
   it privately; never in a repository, log, browser, CP catalog or agent
   box) and maps the answer as in section 3;
5. never logs request or response bodies (they carry private relationship
   fields and match Telegram handles); log the operation, status and timing.

`mini-app.read` for `appId:"kismet"` is unchanged: the reviewed MCP endpoint
`https://kismet-village.vercel.app/mcp` and the three tools in
`manifest.json`.

## 2. Identity

- `residentId`: the app server's stable, opaque id for the paired resident,
  1-128 characters `[A-Za-z0-9][A-Za-z0-9._:@-]*`, for example
  `av:<CP resident uuid>`. The same resident must always get the same id, and
  it is never derived from anything the agent sends. Kismet stores only
  `sha256("agent-dates:village:" + residentId)` (the prefix keeps its old
  name on purpose: changing it would orphan accounts), so one resident has
  at most one Kismet account. Tell Kismet before changing the scheme: a new
  id is a new account.
- `telegram` (sign-up only): the pairing's Telegram username, without `@`.
  Omit the key when the paired account has no username. An `answers.telegram`
  the owner volunteered wins on Kismet's side; with neither, Kismet answers
  `invalid_answers` naming `telegram`.

## 3. Operations

All Kismet calls are `POST`, `Content-Type: application/json`,
`Authorization: Bearer <VILLAGE_PARTNER_KEY>`, body at most 12,000
characters, unknown top-level fields refused. Use a 20-second timeout (the
native bridge waits 25 seconds; Kismet answers in about 0.25 seconds).
`requestId` is for the app server's own receipts and de-duplication: **never
forward it** to Kismet (its partner API refuses unknown fields). Every
successful bridge answer is `200` JSON with exactly the keys shown (drop
everything else Kismet returns, including its `text`).

### `kismet.status` (read)

| | |
|---|---|
| Bridge request | `{"operation":"kismet.status"}` |
| Kismet call | `POST /api/village/summary` `{"residentId":"<id>"}` |
| Kismet `200` | `{ok:true, text, summary:{profile, datesToday, datesLeftToday, running, topPick, recommendations[], recommendationCount, matches[], worldId}}` |
| Bridge `200` | see below |
| Kismet `404 not_signed_up` | Bridge `200` `{"signedUp":false}` |

```json
{"signedUp":true,"name":"<summary.profile.name>","datesLeftToday":4,"running":1,"recommendationCount":2,
 "recommendations":[{"dateId":"<uuid>","name":"Ravi","summary":"<one-line bio>","sharedInterests":["AI"],
                     "reason":"<summary.recommendations[].myAgent.reason>","suggestedMeetup":"<...myAgent.suggestedMeetup>"}],
 "matches":[{"name":"Meera","telegram":"meera_goa","matchedAt":"2026-10-17T10:00:00.000Z"}]}
```

Map each recommendation from `summary.recommendations[]` (`dateId`, `name`,
`summary`, `sharedInterests`, `myAgent.reason` as `reason`,
`myAgent.suggestedMeetup` as `suggestedMeetup`; drop `createdAt`,
`interests`, `myAgent.score`, `worldVerified`, photos). Map each match from
`summary.matches[]` (`name`, `telegram`, `matchedAt`; drop `dateId`, `link`,
`kind`, relationship fields, agent names and transcripts). Drop `profile`
(except `name`), `topPick`, `datesToday` and `worldId`. Kismet never returns
the other agent's verdict or the other human's answer; the app server adds
nothing about the other side. The plugin rebuilds `link` itself as
`https://t.me/<telegram>`.

### `kismet.signup` (write)

| | |
|---|---|
| Bridge request | `{"operation":"kismet.signup","answers":{...},"requestId":"<uuid>"}` |
| Kismet call | `POST /api/village/signup` `{"residentId":"<id>","telegram":"<pairing username>","answers":{...}}` (`answers` byte for byte) |
| Kismet `201` / `200` | `{ok:true, created:true\|false, text}` |
| Bridge `200` | `{"created":true}` (new account) or `{"created":false}` (answers replaced) |
| Kismet `400 invalid_answers` | Bridge `400` `{"code":"kismet_invalid_answers","detail":"<Kismet's message>"}` |

`answers` holds only these keys (the plugin refuses any other, and every
value is already an id): `name`, `status`, `openness`, `lookingFor`,
`gender`, `interestedIn`, `interests`, `about`, `agentProfile`,
`publicQuotes`, `telegram`, `ageConfirmed`, `agreedToTerms`. Kismet checks
`ageConfirmed` and `agreedToTerms` are `true` (18+ and its Terms) before
anything else, and validates the rest exactly like its website sign-up. The
plugin forwards only the field name from `detail` (for example
`relStatus: ...` becomes `field: "status"`), never the message text.
Sign-up is idempotent per resident: a repeat replaces that resident's
answers and never creates a second account, so retrying the same request
after a timeout is safe.

### `kismet.decide` (write, final)

| | |
|---|---|
| Bridge request | `{"operation":"kismet.decide","dateId":"<uuid>","decision":"yes"\|"no","requestId":"<uuid>"}` |
| Kismet call | `POST /api/village/decide` `{"residentId":"<id>","dateId":"<uuid>","decision":"meet"\|"pass"}` (`yes` is `meet`, `no` is `pass`) |
| Kismet `200` | `{ok:true, decision:"meet"\|"pass", match, matchWith?:{name, telegram, link}, text}` |
| Bridge `200` | `{"decision":"yes"\|"no","match":false}` or `{"decision":"yes","match":true,"matchWith":{"name":"Ravi","telegram":"ravi_surf"}}` |
| Kismet `404 date_not_found` | Bridge `404` `{"code":"kismet_date_not_found"}` |
| Kismet `404 not_signed_up` | Bridge `404` `{"code":"kismet_not_signed_up"}` |

Map Kismet's `decision` back (`meet` is `yes`, `pass` is `no`); it is the
resident's **first** answer, which stands. `matchWith` is present only when
this answer completed a mutual match. `date_not_found` is one answer for an
unknown date, another resident's date, a running date or one their own agent
did not recommend, so nothing can be probed; pass it through unchanged.

### `kismet.delete` (write)

| | |
|---|---|
| Bridge request | `{"operation":"kismet.delete","requestId":"<uuid>"}` |
| Kismet call | `POST /api/village/delete` `{"residentId":"<id>"}` |
| Kismet `200` | `{ok:true, deleted:true\|false, text}` |
| Bridge `200` | `{"deleted":true}` or `{"deleted":false}` (there was no account) |

A hard delete of the profile, dates, answers, matches and photos;
idempotent.

## 4. Errors

| Kismet answer | Bridge answer |
|---|---|
| `429 rate_limited` | `429` `{"code":"kismet_rate_limited"}` |
| `401 unauthorized`, `503 partner_api_disabled`, `400 invalid_request`, `413 too_large`, `5xx`, timeout | `502` `{"code":"kismet_unavailable"}` (log the Kismet status; it is a key, scheme or outage problem, never the resident's) |
| `404 not_signed_up` on status | `200` `{"signedUp":false}` |
| `404 not_signed_up` on decide | `404` `{"code":"kismet_not_signed_up"}` |
| `404 date_not_found` | `404` `{"code":"kismet_date_not_found"}` |
| `400 invalid_answers` on signup | `400` `{"code":"kismet_invalid_answers","detail":"<message>"}` |

Kismet's limits: sign-up 20 per resident per hour (300 new accounts per hour
overall), summary 120 and decide 120 per resident per hour. The native
plugin never retries in the same turn.

## 5. Approval

`village` stays classed `marketplace.app.read` by the approval gate. The
three writes take the sibling writes' `gate_verified()` (like
`forkicks.order.prepare`, `mini-app.context.write` and `rolodex.meeting`):
refused with `approval_unavailable` while the gate is off or unverified. No
daemon proposal or new member class is needed, because the native plugin
enforces the consent boundary itself, before any network call:

- `kismet.signup` and `kismet.delete` stage locally first: the plugin saves
  the exact answers (owner-private `$HERMES_HOME/kismet-drafts/<draftId>.json`,
  0600 in a 0700 folder, bound to the owner, origin, conversation and turn,
  one hour) and returns the preview text. Only a **later owner message** in
  the same conversation may send that `draftId`, and the plugin sends the
  saved answers, never model-supplied ones. Sent answers are removed from
  the box.
- `kismet.decide` accepts only a `dateId` that `kismet.status` returned
  (server data, cached in `$HERMES_HOME/kismet-shown/` with the first turn
  it was shown in) and only in a later owner message.

Precedent: B-133 made the Gold Star send's member class autonomous because
the owner's chat confirmation of the exact server-held preview is the
consent for a non-purchase social action; For Kicks keeps a manual grant
because it spends money. Kismet spends nothing, a no is never told to
anyone and a yes reveals only a mutual match, so chat confirmation of an
exact preview, enforced natively, fits the gold-stars precedent without a
CP policy change. If staff prefer a daemon grant for sign-up or delete, the
staged record is already the exact payload to propose.

`requestId` values are stable per staged draft (sign-up, delete) and per
`dateId` and decision (decide), so a retry after an unclear result is the
same request.

## 6. What Kismet changes for this (Kismet side, not this repository)

1. **Dates start on their own.** Residents never start dates in chat, so
   Kismet runs `startDates` for every signed-up, visible resident with
   allowance left: right after a village sign-up and then hourly (Vercel
   cron), inside the existing caps (3 a call, 6 per resident per India day,
   600 a day for the village).
2. **Rename** the MCP `ORIGIN`, `SERVER_INFO.name` and `Source:` lines to
   Kismet; tool names and input schemas stay byte for byte.
3. Nothing else: the partner API already has every route and field above.

## 7. Optional: nudges through the paired bot (staff decision)

The agent nudges in conversation (the skill checks status once a day when
the owner talks to it); the `village` tool refuses cron sessions. If staff
want push nudges too, the For Kicks pattern fits: a CP template
`kismet.recommendation` ("Kismet: your agent has a new recommendation for
you. Reply 'kismet' to see it.") and `kismet.match` ("Kismet: you have a new
match. Reply 'kismet' to see it.") sent through the owner's own paired bot,
with no names in the template. Kismet would call an app-server webhook
`POST {residentId, kind:"recommendation"|"match"}` signed with a second
shared secret; that route is not part of this version.
