# Edge City Volunteers mini-app

## What it is

A volunteer's own schedule in their agent: their shifts, hours, plan, the open
shifts they could claim and their cover requests, plus the scheduling changes a
volunteer can already make in the Edge City Volunteers (ECV) app, each made only
after the owner says yes to its exact summary in chat.

- `skills/eci-volunteers/SKILL.md`: what the agent does and says.
- `mini-apps/eci-volunteers/manifest.json`: the v2 manifest (operations, input
  schemas, budgets, the auth mode).
- `plugins/village-bridge/_ecv.py`: the box-side argument checks, the confirm
  rule and the error text.

ECV is Edge City's own volunteer scheduling service
(https://edge-city-volunteers.vercel.app, repo `lucychen0103/Edge-City-Volunteers`).
Built by Naman Hajela (ov#450); the Agent Village integration follows the lead's
ruling L35456 (identity by `X-Village-Subject` plus a one-time link, the Favor
Loop pattern).

The id is `eci-volunteers` because the shared validator reserves the `edge-`
family. Edge City may prefer `edge-volunteers` as a first-party app (that needs a
FIRST_PARTY grant in the shared validator in all three repos); the rename is
mechanical.

## Identity: a private reference, linked once

Agent Village never sends ECV a Telegram id, a username or any other resident
identifier. The app server holds ONE token for ECV
(`MINI_APP_ECI_VOLUNTEERS_TOKEN`) and adds `X-Village-Subject` to every call: an
opaque, stable reference for this resident, different for every app (the app's
`subject` separation; an HMAC under Agent Village's `MINI_APPS_SUBJECT_SECRET`,
which never rotates). The box and the model never see the token, the endpoint,
the subject or a volunteer id.

ECV links a subject to a volunteer once:

1. The owner sends `/agentvillage` to the Edge City Volunteers bot on Telegram.
   The bot already knows which volunteer that Telegram account is, and replies
   with a one-time link code: 8 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`
   (no 0, 1, I, L, O or U), shown as `XXXX-XXXX`, valid 10 minutes, single use.
2. The owner gives the code to their agent in their private chat, and the agent
   calls `eci-volunteers.link {"code": "XXXXXXXX"}` (no hyphen).
3. ECV binds the subject to that volunteer, keeping only
   `HMAC-SHA256(ECV's own secret, "av:" + subject)`, never the subject itself,
   and the bot tells the volunteer "Agent Village is now linked" on Telegram.
   Linking again replaces the earlier link (the bot says so). The volunteer ends
   it in the bot or the volunteer app; a coordinator can revoke it.

Until a subject is linked, every operation but `link` answers `not_connected`.

## The call

Standard MCP (streamable HTTP, JSON responses), sent by Agent Village's generic
dispatcher: `POST` to `https://edge-city-volunteers.vercel.app/api/mcp` with

```
Authorization: Bearer <MINI_APP_ECI_VOLUNTEERS_TOKEN>
X-Village-Subject: <32 hex characters, per resident, per app>
Idempotency-Key: <64 hex characters>          (link and confirm only)
Accept: application/json, text/event-stream
Content-Type: application/json
```

then `initialize`, `notifications/initialized` and a `tools/call` of the
operation's tool, with the box's `arguments` forwarded unchanged as the tool's
MCP `arguments`.

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
| `eci-volunteers.propose` | `eciv_propose` | read (a check: nothing changes) |
| `eci-volunteers.confirm` | `eciv_confirm` | write |
| `eci-volunteers.link` | `eciv_link` | write |

Not exposed: `eciv_feedback`, every staff tool and action, and `brief`.

## Approval classification

App actions run on their own by default, reads and writes included; only a
payment shows a card.

- `propose` is a `read`. It is a check: it returns a summary and a code, and
  changes nothing the volunteer or anyone else can see.
- `confirm` is a `write`. It makes the volunteer's own scheduling change in
  their own volunteer account: claim a shift, move one, ask for cover, take a
  rest day, set their plan, or ask for extra hours. Each can be undone or
  changed again. It is not a payment, and it publishes nothing outside Edge City
  Volunteers.
- `link` is a `write`: it links this agent to the owner's own volunteer
  account, with a code only the owner's bot chat shows.
- The owner's explicit yes is enforced twice. The skill shows the summary and
  waits for a later message, and the box refuses a confirm that does not follow
  a propose from an earlier owner message (the confirm rule, below).
- On the box, both writes take the verified-gate path (zzz's), with no manual
  grant, card or class of their own.

## Input rules

The box checks every call (`_ecv.py`) against ECV's published volunteer input
schemas (ECV 0.45.0) before sending, and the app server checks each operation's
`input` schema in the manifest again:

- Reads: exactly the keys in the skill's table. Ids match ECV's uuid pattern,
  dates `YYYY-MM-DD`, `before` is 1–500 characters, `limit` and `days` are
  integers in the stated ranges, `topic` or `topics` (not both) from ECV's eight
  topics.
- `propose`: `{action, params, then?}`, each step one of the seven volunteer
  actions with exactly its params; `then` is 1–2 more steps (3 changes in all).
  The manifest gives `params` as a `oneOf` per action.
- `confirm`: `{code}`, printable ASCII, 20–50,000 characters.
- `link`: `{code}`, exactly 8 of the bot alphabet above.
- Any key naming a resident (a Telegram id or username, a user, volunteer or
  subject id), at any depth, is refused before anything is sent.

`maxRequestBytes` is 4096, except `propose` and `confirm` at 65536 (a code can be
~50 KB). Every operation fits 25 seconds.

## The confirm rule

ECV's propose returns a summary to show word for word and a code valid for 10
minutes; ECV's confirm makes the change and is idempotent per code. The box
makes "a later owner reply" a rule:

- When `propose` returns a code (`structuredContent.code`, absent when the
  change is refused), the box records `sha256(code)` with the conversation and
  the owner message it was shown in, for 15 minutes. Never the code itself, the
  summary or any ECV text.
- The box sends `confirm` only for such a code, in the same conversation, in a
  later owner message. Otherwise it answers
  `eci_volunteers_confirmation_required`, `eci_volunteers_proposal_unknown` or
  `eci_volunteers_proposal_expired`, and sends nothing.
- A propose carries no `turnId` (it is a read). A confirm's `turnId`, which the
  app turns into the `Idempotency-Key`, is fixed per code, so a retry is never a
  second change. A link's is fixed per request and owner message.

ECV still checks the code itself: it belongs to this volunteer, it is unexpired,
and it was not invalidated by a PIN reset.

## Answers and refusals

Every tool answers an MCP result whose `structuredContent` carries the facts as
fields and a `text` (the reply to quote). ECV puts the event's time now on every
reply. A propose's `structuredContent` also carries `summary`, `warnings` and
`code`.

Every refusal about the volunteer, the link or the request is an MCP result
with `isError: true` and `structuredContent` `{code, detail}`, HTTP 200, with a
code from the generic list:

| `code` | When |
|---|---|
| `not_connected` | The subject is not linked to a volunteer, or the link was ended |
| `not_found` | `link`: the code is wrong or used. Otherwise: no such shift or request for this volunteer, or the volunteer is not on the current event's roster |
| `expired` | `link` or `confirm`: the code is past its 10 minutes |
| `not_authorized` | The volunteer is withdrawn, or a coordinator turned Agent Village off for them |
| `conflict` | `propose`: ECV refuses the change (`detail` is `REFUSED (<rule>): <reason>`). `confirm`: the code no longer applies (PIN reset, another volunteer's, the change no longer fits) |
| `invalid_arguments` | The arguments break ECV's schema (`detail` says how) |
| `rate_limited` | Too many requests for this volunteer |
| `unavailable` | ECV's `MCP_ENABLED` kill switch is off |

Only a wrong or missing token is an HTTP 401. The box replaces every code with
its own text (`_ecv.py`), relaying `detail` only for `conflict` and
`invalid_arguments`, framed as untrusted. The response limit is 262,144 bytes; a
`plan_view` of 8 busy days fits.

## ECV side safety

- ECV pins the token's SHA-256 in its code and compares the hash of the token it
  is sent. Rotating the token is one ECV code change plus the staff variable.
- The token reaches only the volunteer tools above, never a staff tool.
- Each linked volunteer gets an "Agent Village" connection record that
  coordinators see and can revoke.
- Every change is audited as made via Agent Village.
- A proposal made before a volunteer's PIN reset can't be confirmed after it:
  propose again.
- ECV's `MCP_ENABLED` kill switch turns it off with every other assistant
  connection.

## Rollout

1. The overlay release (box side: allowlist, bridge, skill). Older boxes refuse
   a projection that names `eci-volunteers`, Gold Stars included, so it comes
   first.
2. The CP catalog row (`eci-volunteers` 1.0.0, the twelve operations in this
   order, `restricted`, at its own release floor) and the
   `MINI_APPS_TENANT_ALLOWLIST` entry for the sandbox tenants.
3. The app's vendored manifest and its `subject` declaration.
4. ECV's side (the link op, the subject lookup, the answers above).
5. The token, given to Edge City staff privately for the app server's
   `MINI_APP_ECI_VOLUNTEERS_TOKEN`. Never in a pull request.

## Conformance fixtures

The fixtures in
[`scripts/tests/fixtures/eci-volunteers/`](../../scripts/tests/fixtures/eci-volunteers/)
record the `{code, detail}` refusal bodies of the contract above, written from
this README (fictional, no live data). No success fixture is invented. Live
evidence (success bodies and the v1 `--service` checks) follows once ECV ships
the link op and a test token is configured.
