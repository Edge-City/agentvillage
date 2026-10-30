# Favor Loop mini-app for Agent Village

Favor Loop is for residents of Edge City India. Two people rarely want exactly
what the other offers, so Favor Loop finds loops where three people help each
other even though no two of them could swap directly: A reviews C's code, C
teaches B yoga, B takes A's portrait. It also finds two-way swaps and gift
chains started by someone who only wants to give. Favors come from a fixed menu
of 12 free, 15-minute favors, done in a public place or online. A loop starts
only when every member says yes, and every favor is confirmed by the person who
received it. Maintainer: Bilgin Kocak (GitHub `bilgin-kocak`). Source:
https://github.com/bilgin-kocak/favor-loop

This is a reviewed app: it writes per-resident state, so like Kismet it needs
a bridge module, the app server's `subject` separation and the key set by
staff. The three public reads (`how_it_works`, `menu`, `board`) need no token
and no identity, so they could also ship first as a read-only bundle if that
is faster.

## The endpoint

`https://favorloop.fly.dev/mcp`, MCP protocol `2025-06-18`, stateless Streamable HTTP:

- `initialize` answers `protocolVersion` `2025-06-18`, `capabilities`
  `{"tools": {}}`, `serverInfo` `{"name": "favorloop", "version": "1.0.0"}`
  and short `instructions`. `notifications/initialized` (any notification)
  gets HTTP 202 with an empty body. `ping` answers `{}`. `tools/list`,
  `tools/call`. An unknown method is JSON-RPC error `-32601`; an unknown tool
  is `-32602`.
- JSON answers only, never an event stream. No session id, no cookies, no
  batching. Nothing redirects: an unknown path is a plain 404.
- `tools/list` serves each `inputSchema` byte for byte as this manifest's
  `operations[].input`: both are generated from one schema file
  (`src/schemas.ts`). The server applies the same check itself
  (`additionalProperties: false` at every level) before any tool runs.
- Every answer is at most 32,768 bytes. A larger one would be refused as a
  tool error (`unavailable`, ask for a smaller `limit`), never cut. The largest
  real answer is `my_loops` with ten loops, about 16 KB.
- Server time is a few milliseconds per call (one SQLite file, one process).
- A success is one text item, the data as JSON followed by a last line
  `Source: https://favorloop.fly.dev/board`, plus `structuredContent` whose first key,
  `text`, is one plain sentence for the resident.
- A tool error is `isError: true` with `structuredContent` exactly
  `{code, detail}` (and the same JSON as its one text item).

## Auth and identity

- `service.auth.mode` is `app-token`, `secretRef` `MINI_APP_FAVORLOOP_KEY`. The
  maintainer gives the key to the organisers privately. It is never in a
  file, an issue or a chat.
- Public tools (`how_it_works`, `menu`, `board`): no token and no subject
  needed, as with Kismet's public reads. A token, if sent, is ignored.
- Private tools (`join`, `my_loops`, `answer`, `confirm`, `leave`) need both
  `Authorization: Bearer <key>` (compared in constant time) and a non-empty
  `X-Village-Subject` of at most 200 characters. Missing or wrong: the tool
  error `not_authorized`, and nothing runs.
- Identity never comes from arguments: any key named `residentId`, `subject`,
  `userId`, `telegramId`, `username` or `X-Village-Subject`, in any spelling or
  case and at any depth, is refused with `invalid_arguments` before anything
  else is checked.

## Operations

Every operation: `maxRequestBytes` 4096, `maxResponseBytes` 32768, `timeoutMs`
25000, `framing` `data`.

| `village` operation | Tool | Class | Receives | Returns |
|---|---|---|---|---|
| `favorloop.how_it_works` | `how_it_works` | read | `{}` | steps, the three shapes, rules, privacy promises, board link |
| `favorloop.menu` | `menu` | read | `{}` | the 12 favor ids and labels, the 4 availability slot ids |
| `favorloop.board` | `board` | read | `{limit?}` 1 to 20, default 10 | anonymous counts and recent loops |
| `favorloop.join` | `join` | write | offers, wants, giftOnly, contactHandle?, availability? | the member's saved choices |
| `favorloop.my_loops` | `my_loops` | read | `{}` | the member's choices and loops |
| `favorloop.answer` | `answer` | write | `{loopId, decision}` | the loop as this member sees it |
| `favorloop.confirm` | `confirm` | write | `{loopId, received}` | the loop as this member sees it |
| `favorloop.leave` | `leave` | write | `{}` | whether anything was deleted |

In detail:

- **`board`** returns `counts` (`members`, `loopsProposed`, `loopsAccepted`,
  `loopsCompleted`, `favorsConfirmed`) and `recentLoops`, each only `shape`
  (`swap`, `loop3` or `chain`), `favors` (menu ids in loop order) and `status`.
  No member, name or handle, ever.
- **`join`** receives `offers` (1 to 3 unique menu ids), `wants` (0 to 3
  unique menu ids; at least 1 unless `giftOnly` is true, and none when it is),
  `giftOnly` (boolean, "I only want to give"), `contactHandle` (optional,
  `^@?[A-Za-z0-9_]{5,32}$`: the Telegram handle the resident chooses to show
  only inside loops they accepted) and `availability` (optional, unique of
  `thu_evening`, `fri_morning`, `fri_afternoon`, `sat`). The same id in offers
  and wants is `invalid_arguments`. Joining again replaces every choice (an
  omitted handle is removed) and resumes matching. It returns the saved
  choices, `openLoops` and `newProposal` (true when the join completed a loop).
- **`my_loops`** returns the member's choices (`paused` is true when a
  Telegram member let a proposal expire; joining again resumes; an Agent
  Village member is never paused) and up to 10
  loops, newest first: open and completed ones, plus ones that dissolved or
  expired in the last 24 hours. Each loop has `loopId`, `shape`, `status`,
  `window` (the first availability slot every member who gave one shares, or
  "by Friday 13:00", later "before the village ends on 1 Nov"), `place`, `answerBy` (while proposed), `youGive` and `youReceive`
  (favor id, label and the other person), `steps` (the whole loop, other
  people as "a resident" and "another resident"), `yourAnswer`, `waitingFor`
  (how many have not answered, never who), `contacts`, `youReceived`,
  `favorsConfirmed` and `favorsTotal`.
- **`answer`** takes a `loopId` (lower-case UUID v4) of a loop the member sits
  in and `yes` or `no`. Every yes: `accepted`, and only then are handles
  revealed. Any no: `dissolved`; the others are told only that it did not go
  ahead, and that exact group is never proposed again (a no that arrives
  after the 6 hours still blocks the group). A repeated answer changes
  nothing; any other answer after the 6 hours is `expired`.
- **`confirm`** takes a `loopId` and `received`. Only the receiver of a
  favor can confirm it (a member who only gives in that loop gets
  `not_authorized`), only once the loop is accepted. `received: false` takes
  back an earlier confirmation. When every favor is confirmed the loop is
  `completed`; a confirmed favor leaves the receiver's wants.
- **`leave`** deletes everything held about the member (below) and dissolves
  their open loops.

Matching runs after every `join`, `answer` and `leave`, and every 10 minutes:
greedy and vertex-disjoint, three-way loops first, then gift chains (giver to
X to Y, or giver to X), then swaps, over members who are not already in a
proposed loop or in a loop accepted less than a day ago. A proposal expires
after 6 hours. Favor Loop cannot reach a resident's agent: an Agent Village
member hears of a proposal when their agent calls `my_loops`, or from
`newProposal` when their own `join` completed it. So when a proposal expires
unanswered by an Agent Village member, that member is not paused and stays in
the pool; the same group is just never proposed again. An accepted loop never
expires: it can complete whenever its receivers confirm, but after a day it
stops keeping its members out of new loops (never with the same group).

## What Favor Loop stores

- For each member: offers, wants, `giftOnly`, the optional handle,
  availability, a paused flag and two timestamps. The member is keyed by
  HMAC-SHA256, under a server secret, of `"av:" + X-Village-Subject` (Agent
  Village) or `"tg:" + Telegram user id` (the Telegram bot). The subject itself
  is never stored or logged.
- Loops: shape, status, suggested window and timestamps; each member's yes or
  no; each favor (giver key, receiver key, favor id, confirmed).
- Groups in which someone said no (member keys only), so they are never
  proposed again.
- For Telegram bot users only: the chat id, encrypted (AES-256-GCM), so the
  bot can send them proposals. Agent Village members have none.
- Logs: the method, tool, result code and timing. Never arguments, subjects or
  handles.

## Who sees what

- The one third party is Telegram, and only through the Favor Loop Telegram
  bot. Loops mix Agent Village and bot members, so when someone in your loop
  uses the bot, Telegram carries that loop to them: its favors, time and
  place, and, once everyone said yes, your handle if you chose to share one.
  Nothing else reaches Telegram or anyone else: the rest stays on Favor
  Loop's own server (one Fly.io machine and its database).
- A member's handle is shown only to the people that member gives to or
  receives from, and only once everyone in that loop said yes. In a gift chain
  the giver and the last receiver never see each other's handle.
- A no is never shown to anyone. `waitingFor` is a count, never a name.
- The board (the `board` tool and the web page `https://favorloop.fly.dev/board`) is
  anonymous: counts, shapes, favor ids and statuses. The web board shows the
  pool as a number, never one id per member, and draws each member of a loop
  as a dot whose id is new for every loop. A ring starts at an arbitrary dot,
  not at its first joiner, and loop times are rounded down to the hour.

## How residents are kept apart

Every private call is scoped to the caller's member key. `my_loops` returns
only the caller's own choices and loops. `answer` and `confirm` act only on a
loop the caller sits in: any other `loopId` is `not_found`, so a loop id
reveals nothing. `confirm` touches only the favor the caller received. `leave`
deletes only the caller. Agent Village subjects and Telegram ids are keyed in
separate spaces, so no subject can ever collide with a Telegram member.

## Retention

`leave` deletes the member, their encrypted chat id (bot users) and every
blocked group naming them, immediately. Their open loops dissolve; their past
loops keep an anonymous placeholder so the board's counts stay true without
pointing at anyone. **All data is deleted on 30 Nov 2026**, and joins are
refused from then on.

## Error codes

| Code | When |
|---|---|
| `invalid_arguments` | the arguments fail the schema, name an identity, repeat an id in offers and wants, or list wants with `giftOnly` (or none without it) |
| `not_authorized` | a private tool without the right key or a usable `X-Village-Subject`; or `confirm` by a member who received nothing in that loop |
| `not_found` | no such member yet, or a `loopId` that does not include the caller |
| `conflict` | the loop is no longer waiting for that action (already accepted, completed, dissolved, or not accepted yet) |
| `expired` | `answer` on a proposal past its 6 hours |
| `rate_limited` | more than 60 calls a minute for one resident (private calls, and public reads that carry Agent Village's key and the resident's `X-Village-Subject`), or 600 public calls a minute from one address without the key. A public read with the key and no subject is not limited here |
| `unavailable` | Favor Loop could not do it right now (storage error), or Favor Loop has ended |

## The Telegram bot and the simulated village

Until this app is installed, residents use the Favor Loop Telegram bot, which
calls the same core: the same matcher, rules and storage. The bot can also
show a resident a prompt to ask their own Agent Village agent which favors
suit them; the agent suggests, and the resident confirms or edits.

A simulated village (150 synthetic members) shows behaviour at scale on
`https://favorloop.fly.dev/sim` and the board's Simulated view. It lives in a separate
in-memory database, is always labelled SIMULATED, never reaches the tools and
is never counted as real.

## Conformance and fixtures

The fixtures in `scripts/tests/fixtures/favorloop/` are real answers,
generated by running the tools against an in-memory database
(`bun run agentvillage` in the Favor Loop repository). The residents and
handles in them (`@fixture_alice`, `@fixture_bob`) are invented. Error
fixtures are the `{code, detail}` each `isError` result carries.

`bun run conformance ... --service https://favorloop.fly.dev/mcp`: because public reads
must work without a token (as Kismet's do), a token-less `initialize` answers
200. The advisory v1 probe expects 401 or 403 for an `app-token` service, so
it reports `service.reachability` as failed; that row is advisory and does
not change `passed`.
