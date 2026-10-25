# Edge City Volunteers mini-app

## What it is

A volunteer's own schedule in their agent: their shifts, hours, plan, the open
shifts they could claim and their cover requests, plus the scheduling changes a
volunteer can already make in the Edge City Volunteers (ECV) app, each made only
after the owner says yes to its exact summary in chat.

- `skills/eci-volunteers/SKILL.md`: what the agent does and says.
- `mini-apps/eci-volunteers/manifest.json`: the v2 manifest (operations, input
  schemas, budgets, the auth mode).
- `plugins/village-bridge/_ecv.py`: the box-side argument checks and error text.

ECV is Edge City's own volunteer scheduling service
(https://edge-city-volunteers.vercel.app, repo `lucychen0103/Edge-City-Volunteers`).

The id is `eci-volunteers` because the shared validator reserves the `edge-`
family. Edge City may prefer `edge-volunteers` as a first-party app (that needs a
FIRST_PARTY grant in the shared validator in all three repos); the rename is
mechanical.

## Why app-token

One link between Agent Village and ECV, and no second sign-in for anyone. Agent
Village already knows each owner's Telegram user id from pairing, and Telegram
verified it. ECV knows each volunteer's Telegram user id once they have messaged
the Edge City Volunteers bot. So the app server holds ONE token for ECV
(`MINI_APP_ECI_VOLUNTEERS_TOKEN`) and names the owner on each call. The volunteer
only installs the mini-app. There is no OAuth, no PIN and no connect step. The
box never sees the token, the endpoint, the Telegram id or a volunteer id.

## The call

Standard MCP (streamable HTTP, JSON responses): `POST` to
`https://edge-city-volunteers.vercel.app/api/mcp` with

```
Authorization: Bearer <MINI_APP_ECI_VOLUNTEERS_TOKEN>
X-Agent-Village-Telegram-User-Id: <the owner's numeric Telegram user id>
X-Agent-Village-Telegram-Username: <the owner's current username, no @>   (optional, recommended)
Accept: application/json, text/event-stream
Content-Type: application/json
```

then `initialize` (protocol `2025-06-18`), `notifications/initialized` and a
`tools/call` of the operation's tool, with the box's `arguments` forwarded
unchanged as the tool's MCP `arguments`. Carry `Mcp-Session-Id` if ECV returns
one (it is stateless and may not). The Telegram id and username come from the
owner's pairing, never from the box or the model.

The username header is optional but recommended: send it whenever Agent Village
knows the username. When it is sent, ECV refuses unless it matches
(case-insensitive) the username ECV's bot recorded for that Telegram user id.
A Telegram username can be given up and taken by someone else; the pair of id
and current username stops a stale record from mapping one person to another
volunteer. A mismatch is `403 {"code":"not_connected"}`: the owner sends any
message to the Edge City Volunteers bot once, which refreshes ECV's record.

## Operations

| `village` operation | ECV tool | Class |
|---|---|---|
| `eci-volunteers.initialize` | `eciv_initialize` | read |
| `eci-volunteers.guide` | `eciv_guide` | read |
| `eci-volunteers.my_hours` | `eciv_my_hours` | read |
| `eci-volunteers.my_shifts` | `eciv_my_shifts` | read |
| `eci-volunteers.get_shift` | `eciv_get_shift` | read |
| `eci-volunteers.plan_view` | `eciv_plan_view` | read |
| `eci-volunteers.open_shifts` | `eciv_list_open_shifts` | read |
| `eci-volunteers.my_requests` | `eciv_my_requests` | read |
| `eci-volunteers.move_targets` | `eciv_move_targets` | read |
| `eci-volunteers.propose` | `eciv_propose` | read (a check: nothing changes; ECV writes one audit row) |
| `eci-volunteers.confirm` | `eciv_confirm` | write |

Not exposed: `eciv_feedback`, every staff tool and action, and `brief`.

## Approval classification

This follows the developer guide, section 7: app actions run on their own by
default, reads and writes included; only a payment shows a card, and a developer
marks only a genuinely payment-like operation `needs-card`.

- `propose` is a `read`. It is a check: it returns a summary and a code, and
  changes nothing.
- `confirm` is a `write`. It makes the volunteer's own scheduling change in
  their own volunteer account: claim a shift, move one, ask for cover, take a
  rest day, set their plan, or ask for extra hours. Each can be undone or
  changed again. It is not a payment, and it publishes nothing outside Edge City
  Volunteers.
- The owner's explicit yes is enforced twice. The skill shows the summary and
  waits for a later message. The app server's confirm rule (below) refuses a
  confirm from the propose's own turn, so this is a server rule, not only a
  prompt.
- On the box, `confirm` takes the verified-gate path (zzz's), with no manual
  grant. If Edge City later pins a member row to ask for it, nothing in this
  manifest needs to change.

This is not a generic app. Section 8 of the guide says token, OAuth and write
partner apps are mini-apps v3, with per-app app-server code. That is this app's
shape: its own named operations on the box, and reference app-server code for
Edge City's app server.

## Input rules

The box checks every call (`_ecv.py`) against ECV's published volunteer input
schemas (ECV 0.45.0) before sending. The app should check again with each
operation's `input` schema in the manifest and refuse anything else with
`invalid_arguments`:

- Reads: exactly the keys in the skill's table. Ids match ECV's uuid pattern,
  dates `YYYY-MM-DD`, `before` is 1–500 characters, `limit` and `days` are
  integers in the stated ranges, `topic` or `topics` (not both) from ECV's eight
  topics.
- `propose`: `{action, params, then?}`, each step one of the seven volunteer
  actions with exactly its params; `then` is 1–2 more steps (3 changes in all).
  The manifest gives `params` as a `oneOf` per action.
- `confirm`: `{code}`, printable ASCII, 20–50,000 characters.

The box adds `turnId` (a UUIDv5 of the trusted session key and message id, never
model input) to `propose` and `confirm`; it is for the app's confirm rule and is
not sent to ECV. `maxRequestBytes` is 4096, except `propose` and `confirm` at
65536 (a code can be ~50 KB); the box sends `X-Village-Operation:
eci-volunteers.confirm` for the larger body. Every operation fits 25 seconds.

## ECV's refusals before MCP

ECV checks the token and the Telegram id before any tool runs. The app maps:

| ECV answers | The app answers the box |
|---|---|
| HTTP 401 `{"code":"not_authorized"}` | `unavailable`. A wrong token is an Agent Village config problem: never show the volunteer text for `not_authorized` |
| HTTP 503 `{"code":"unavailable","detail":...}` | `unavailable` (ECV's MCP server is switched off, or the link is off) |
| HTTP 403 `{"code":"not_connected"}` | `not_connected`: ECV does not know this Telegram id yet (the owner has not messaged the bot), or the username header does not match ECV's record |
| HTTP 404 `{"code":"not_found"}` | `not_found`: no volunteer on the current event has this Telegram id |
| HTTP 403 `{"code":"not_authorized"}` | `not_authorized`: withdrawn, or a coordinator turned Agent Village off for them |
| HTTP 400 `{"code":"invalid_arguments"}` | `invalid_arguments`: the Telegram id header is not a numeric id (an app bug) |

ECV always answers these as exactly `{code, detail}`. The bodies are recorded
as conformance fixtures under
[`scripts/tests/fixtures/eci-volunteers/`](../../scripts/tests/fixtures/eci-volunteers/).

The app answers the box with HTTP 4xx/5xx and `{"code": "<code>"}`. The box
replaces it with its own text (`_ecv.py` `ECV_ERRORS`), never upstream wording.
The codes it knows for these operations: `not_connected`, `not_found`,
`not_authorized`, `unavailable`, `conflict`, `invalid_arguments` (also for
JSON-RPC `-32602`) and `rate_limited` (the app's own limit; suggest 300
operations per owner per UTC day). Anything else is
`connection_or_request_refused`, which tells the agent not to claim a change.

## The confirm rule

ECV's propose returns a summary to show word for word and a code valid for 10
minutes; ECV's confirm makes the change and is idempotent. The app makes "a
later owner reply" a server rule:

- When `propose` returns a code (`structuredContent.code`, null when the change
  is blocked), store `sha256(code) → {owner, turnId, expiresAt}` for 15 minutes.
- Refuse `confirm` with `conflict` (HTTP 409) when the code's record is missing,
  belongs to another owner, has expired, or carries the same `turnId` as this
  confirm.
- Never store the code itself, shift text or any ECV answer.

## Results

Return the MCP result as
`{"text": <the text content parts joined by a blank line>, "structured": <structuredContent or null>, "isError": <bool>}`.
ECV puts the event's time now on every reply and states each refusal as
`REFUSED (<rule>): <reason>` with `isError: true`. The box scrubs hidden
characters at every depth and frames the result as untrusted data. The response
limit is 262,144 bytes; a `plan_view` of 8 busy days fits.

## ECV side safety

- ECV needs no environment variable for the link. It pins the token's SHA-256
  in its code (`AGENT_VILLAGE_TOKEN_SHA256` in `src/server/mcp/agent-village.ts`)
  and compares the hash of the token it is sent. Rotating the token is one ECV
  code change plus the staff variable.
- The token reaches only the volunteer tools above, never a staff tool.
- Each volunteer gets an "Agent Village" connection record that coordinators see
  and can revoke.
- Every change is audited as made via Agent Village.
- A coordinator's revoke ends the Agent Village link for that volunteer and
  can't be undone yet. A PIN reset does not end the link.
- A proposal made before a volunteer's PIN reset can't be confirmed after it:
  propose again.
- ECV's `MCP_ENABLED` kill switch turns it off with every other assistant
  connection.
- A call costs ECV about 5 database queries.

## Rollout

1. This overlay roll (box side: allowlist, bridge, skill). Older boxes refuse a
   projection that names `eci-volunteers`, Gold Stars included, so it comes
   first.
2. The CP catalog row (`eci-volunteers` 1.0.0, the eleven operations in this
   order, `restricted`) and the `MINI_APPS_TENANT_ALLOWLIST` entry for the
   sandbox tenant.
3. The app routes: the operation map, the headers, the refusal mapping and
   the confirm rule (see the reference implementation).
4. The token. Naman holds it (on serenity, as `ECV_AGENT_VILLAGE_TOKEN`) and
   gives it to Edge City staff privately for the Agent Village app server's
   `MINI_APP_ECI_VOLUNTEERS_TOKEN`. ECV pins only its SHA-256 (see above), so
   ECV sets nothing. Never in a pull request.

### Sandbox test identity

Naman Hajela (Telegram @hiinaman), a rostered Edge City volunteer, is the
consented sandbox test identity (confirmed 25 Oct); he provides the test token
privately. Install the app on the Agent Village tenant paired with that
Telegram account.

## Reference implementation

[`docs/reference/eci-volunteers/app-server.ts`](../../docs/reference/eci-volunteers/app-server.ts)
is reference code for Edge City's app server: the operation map, the input
check against this manifest, the MCP call, the refusal mapping, the confirm rule
and the budgets, with tests (`app-server.test.ts`, a fake fetch, no network). It
is not run on any box. It lives under `docs/` because `mini-apps/` is a closed
tree of manifests and READMEs only.

## V0 conformance evidence

The 22 October probe (by jmilldotdev) called the live endpoint without the
`X-Agent-Village-Telegram-User-Id` header. That reached ECV's OAuth path, which
answers HTTP 401 `{error, error_description}`. That answer is correct for OAuth
clients. Agent Village's server never sees it: it always sends the identity
header.

With that header, ECV answers every refusal as exactly `{code, detail}`
(lucychen0103/Edge-City-Volunteers#112). The fixtures in
[`scripts/tests/fixtures/eci-volunteers/`](../../scripts/tests/fixtures/eci-volunteers/)
now record those bodies, taken from #112's code in a local run on 21 October:

| Fixture | HTTP | Body `code` |
|---|---|---|
| `eci-volunteers.initialize/error-unauthenticated.json` (wrong or missing token) | 401 | `not_authorized` |
| `eci-volunteers.initialize/error-not-connected.json` (never messaged the bot) | 403 | `not_connected` |
| `eci-volunteers.initialize/error-username-out-of-date.json` | 403 | `not_connected` |
| `eci-volunteers.initialize/error-no-volunteer.json` | 404 | `not_found` |
| `eci-volunteers.my_shifts/error-withdrawn.json` | 403 | `not_authorized` |
| `eci-volunteers.my_hours/error-switched-off.json` | 503 | `unavailable` |
| `eci-volunteers.confirm/error-telegram-id-not-numeric.json` | 400 | `invalid_arguments` |

ECV checks the token and identity before any tool runs, so each refusal is the
same for every operation; the fixtures are spread across a few. Every code is
in the generic list. Conformance v0 passes:

```sh
bun run conformance -- mini-apps/eci-volunteers/manifest.json \
  --fixtures scripts/tests/fixtures/eci-volunteers --base origin/main \
  --out "$TMPDIR/conformance.json"
```

No success fixture is invented. Live evidence (success bodies and the v1
`--service` checks) follows once #112 is deployed and a test token is
configured.

The reference app-server file is reference code, not an installed Agent Village
adapter. Edge City staff implement the real app and CP path, including the
trusted identity headers and the confirm rule. The manifest and skill do not
claim that generic app-token dispatch or an approval card exists today.
