# Edge City Volunteers mini-app

## What it is

A volunteer's own schedule in their agent: their shifts, hours, plan, the open
shifts they could claim and their cover requests, plus the scheduling changes a
volunteer can already make in the Edge City Volunteers (ECV) app, each made only
after the owner says yes to its exact summary in chat.

- `skills/edge-volunteers/SKILL.md`: what the agent does and says.
- `mini-apps/edge-volunteers/manifest.json`: the v2 manifest (operations, input
  schemas, budgets, the auth mode).
- `plugins/village-bridge/_ecv.py`: the box-side argument checks and error text.

ECV is Edge City's own volunteer scheduling service
(https://edge-city-volunteers.vercel.app, repo `lucychen0103/Edge-City-Volunteers`).

## Why app-token

One link between Agent Village and ECV, and no second sign-in for anyone. Agent
Village already knows each owner's Telegram user id from pairing, and Telegram
verified it. ECV knows each volunteer's Telegram user id once they have messaged
the Edge City Volunteers bot. So the app server holds ONE token for ECV
(`MINI_APP_EDGE_VOLUNTEERS_TOKEN`) and names the owner on each call. The volunteer
only installs the mini-app. There is no OAuth, no PIN and no connect step. The
box never sees the token, the endpoint, the Telegram id or a volunteer id.

## The call

Standard MCP (streamable HTTP, JSON responses): `POST` to
`https://edge-city-volunteers.vercel.app/api/mcp` with

```
Authorization: Bearer <MINI_APP_EDGE_VOLUNTEERS_TOKEN>
X-Agent-Village-Telegram-User-Id: <the owner's numeric Telegram user id>
```

and a `tools/call` of the operation's tool, with the box's `arguments` forwarded
unchanged as the tool's MCP `arguments`. The Telegram id comes from the owner's
pairing, never from the box or the model.

## Operations

| `village` operation | ECV tool | Class |
|---|---|---|
| `edge-volunteers.initialize` | `eciv_initialize` | read |
| `edge-volunteers.guide` | `eciv_guide` | read |
| `edge-volunteers.my_hours` | `eciv_my_hours` | read |
| `edge-volunteers.my_shifts` | `eciv_my_shifts` | read |
| `edge-volunteers.get_shift` | `eciv_get_shift` | read |
| `edge-volunteers.plan_view` | `eciv_plan_view` | read |
| `edge-volunteers.open_shifts` | `eciv_list_open_shifts` | read |
| `edge-volunteers.my_requests` | `eciv_my_requests` | read |
| `edge-volunteers.move_targets` | `eciv_move_targets` | read |
| `edge-volunteers.propose` | `eciv_propose` | read (a check: nothing changes; ECV writes one audit row) |
| `edge-volunteers.confirm` | `eciv_confirm` | write |

`confirm` is `write`, not `needs-card`: each change is one the volunteer can
undo or that the volunteer app already lets them make, and the generic approval
card is not built. On the box it takes the verified-gate path (zzz's), no manual
grant. Not exposed: `eciv_feedback`, every staff tool and action, and `brief`.

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
edge-volunteers.confirm` for the larger body. Every operation fits 25 seconds.

## ECV's refusals before MCP

ECV checks the token and the Telegram id before any tool runs. The app maps:

| ECV answers | The app answers the box |
|---|---|
| HTTP 401 `{"code":"not_authorized"}` | `unavailable`. A wrong token is an Agent Village config problem: never show the volunteer text for `not_authorized` |
| HTTP 503 | `unavailable` (ECV's `MCP_ENABLED` is off, or the link is off) |
| HTTP 403 `{"code":"not_connected"}` | `not_connected`: ECV does not know this Telegram id yet (the owner has not messaged the bot) |
| HTTP 404 `{"code":"not_found"}` | `not_found`: no volunteer on the current event has this Telegram id |
| HTTP 403 `{"code":"not_authorized"}` | `not_authorized`: withdrawn, or a coordinator turned Agent Village off for them |

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

- The token is compared in constant time; ECV can hold two tokens at once, so
  rotation needs no downtime.
- The token reaches only the volunteer tools above, never a staff tool.
- Each volunteer gets an "Agent Village" connection record that coordinators see
  and can revoke.
- Every change is audited as made via Agent Village.
- ECV's `MCP_ENABLED` kill switch turns it off with every other assistant
  connection.

## Rollout

1. This overlay roll (box side: allowlist, bridge, skill). Older boxes refuse a
   projection that names `edge-volunteers`, Gold Stars included, so it comes
   first.
2. The CP catalog row (`edge-volunteers` 1.0.0, the eleven operations in this
   order, `restricted`) and the `MINI_APPS_TENANT_ALLOWLIST` entry for the
   sandbox tenant.
3. The app routes: the operation map, the two headers, the refusal mapping and
   the confirm rule.
4. ECV sets the token: Naman generates it, stores it in ECV's Vercel env and
   gives it to Edge City staff for the Agent Village app server's
   `MINI_APP_EDGE_VOLUNTEERS_TOKEN`. Never in a pull request.
