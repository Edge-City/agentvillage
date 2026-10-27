# Edge Library mini-app

## What it is

Edge Library is the village knowledge graph of Edge City India 2026
(https://library.positivesumexperiments.com): typed nodes (people, projects,
tools, topics), typed links between them, each fact referenced to the source
text it came from, and a git-style history of every change. This mini-app lets
a resident's agent search and read it, and add to it when the owner asks: a
source for the Librarian to read, graph changes, or a proposal for an admin.

- `skills/library/SKILL.md`: what the agent does and says.
- `mini-apps/library/manifest.json`: the v2 manifest (operations, input schemas,
  budgets, the auth mode).
- `plugins/village-bridge/_library.py`: the box-side argument checks and error
  text.

The id is `library` because the shared validator reserves the `edge-` family; the
display name is still "Edge Library".

## Why app-token

The same link as Edge City Volunteers (`eci-volunteers`): one token between
Agent Village and Edge Library, and no second sign-in. Agent Village already
knows each owner's Telegram user id from pairing; Edge Library keys people on
their Telegram user id (it signs people in with Telegram). So the app server
holds ONE token for Edge Library (`MINI_APP_LIBRARY_TOKEN`) and names the owner on
each call; Edge Library acts as that resident (an outside agent acting on their
behalf, with their permissions). The owner only installs the mini-app. The box
never sees the token, the endpoint, the Telegram id or a person id.

## The call

Standard MCP (streamable HTTP, JSON responses): `POST` to
`https://library.positivesumexperiments.com/api/mcp` with

```
Authorization: Bearer <MINI_APP_LIBRARY_TOKEN>
X-Agent-Village-Telegram-User-Id: <the owner's numeric Telegram user id>
X-Agent-Village-Telegram-Username: <the owner's current username, no @>   (optional, recommended)
Accept: application/json, text/event-stream
Content-Type: application/json
```

then `initialize` (protocol `2025-06-18`), `notifications/initialized` and a
`tools/call` of the operation's tool, with the box's `arguments` forwarded
unchanged as the tool's MCP `arguments`. Carry `Mcp-Session-Id` if Edge Library
returns one (it is stateless, one server per request, and may not). The
Telegram id and username come from the owner's pairing, never from the box or
the model.

The Edge Library side of this contract is in the Edge Library repository,
`docs/MINIAPP.md` (code: `apps/web/src/services/mcp/agent-village.ts`).

## Identity on the Edge Library side

- The Telegram id is the person. An unknown id **creates** the person (any
  Telegram account can use Edge Library), so there is no "not linked yet" refusal
  and nothing for the owner to do first.
- The username header, when sent, refreshes the person's username. A different
  username is accepted (Agent Village's pairing is the source of truth), never
  refused. A malformed one (not 4-32 letters, digits or `_`) is a 401, so the
  app leaves it out rather than sending it.
- The Telegram id must be 1-16 digits and a safe integer; anything else is a 401.
- Every call acts as one "Agent Village" agent on behalf of the resident, with
  the resident's role. Commits and audit rows show actor Agent Village,
  `on_behalf_of` the resident, client `agent-village`.
- An admin revoking that agent switches the whole link off (403).
- **Rate limit: 60 tool calls a minute per resident** (`initialize` and
  `tools/list` do not count). Over it, the tool answers `rate_limited`.

## Operations

| `village` operation | Edge Library tool | Class | `maxRequestBytes` |
|---|---|---|---|
| `library.initialize` | `library_initialize` | read | 4096 |
| `library.search` | `library_search` | read | 4096 |
| `library.get` | `library_get` | read | 4096 |
| `library.source` | `library_source` | read | 4096 |
| `library.schema` | `library_schema` | read | 4096 |
| `library.history` | `library_history` | read | 4096 |
| `library.changes_since` | `library_changes_since` | read | 4096 |
| `library.proposals` | `library_proposals` | read | 4096 |
| `library.submit_source` | `library_submit_source` | write | 262144 |
| `library.write` | `library_write` | write | 262144 |
| `library.propose` | `library_propose` | write | 131072 |

Every operation: `maxResponseBytes` 262144, `timeoutMs` 25000, framing `data`.
Not exposed: the Librarian's tools (`library_jobs_claim`, `library_jobs_complete`,
`library_jobs_fail`, `library_queries`); Edge Library does not list them for anyone
but the Librarian either. `mini-app.read` refuses `library`.

## Approval classification

This follows the developer guide, section 7: app actions run on their own by
default; only a payment shows a card.

- The eight reads change nothing.
- `submit_source`, `write` and `propose` are `write`. Each is recorded as one
  commit (or one proposal) under the owner's name, and people can revert it in
  Edge Library. None is a payment. They add to a graph the whole village reads,
  which is the purpose of the app: the permission card says so ("visible to the
  whole village").
- An attribution (`said_by`) from a resident, and any type Edge Library marks as
  needing approval, is not written: Edge Library files it as a proposal for an
  admin. Schema changes are proposals only.
- On the box, the three writes take the verified-gate path (zzz.bot's and
  `eci-volunteers.confirm`'s), with no manual grant. If Edge City later pins a
  member row to ask for one, nothing in this manifest needs to change.
- There is no propose/confirm step on the Agent Village side: the owner's ask
  in chat is the instruction, and the skill says to write only what the owner
  asked for or agreed to.

This is not a generic app (section 8 of the guide: token and write partner
apps are mini-apps v3, with per-app app-server code). Reference app-server
code is below.

## Input rules

The `input` schemas are Edge Library's own zod tool schemas
(`apps/web/src/services/mcp/schemas.ts` and `ops.ts` in the Edge Library repo),
converted to JSON Schema 2020-12 with `z.toJSONSchema` (input side), with
`description`, `default` and `format` dropped and `"additionalProperties":
false` on every object that is not a free-form record (node `properties` and a
proposal's `payload` stay open, as in Edge Library). The app should check each
call against them and its `maxRequestBytes` (UTF-8 bytes of the compact JSON
arguments) and refuse anything else with `invalid_arguments`.

The box (`_library.py`) checks the same, and adds three rules for agents that
Edge Library enforces too (its recorder refuses an agent operation without them):

- every graph op in `library.write`, and in a proposal's `heldWork`, carries a
  `confidence` (0 to 1) and a non-empty `rationale`;
- `library.propose` carries a `confidence`;
- no op says `how: "confirmed"` (only a person confirms a fact), including a
  node, edge or attribution proposal's `payload.op`.

Anything else is `invalid_library_arguments` before transport, with the box's
own text. The box sends `X-Village-Operation: <operation>` for the three writes
(the larger request budgets).

The schemas keep Edge Library's own bounds; the byte budgets are the real limit
on a long source (a 2,000,000-character source is valid in Edge Library but does
not fit 262,144 bytes). The skill tells the agent to split a longer source.

## Edge Library's refusals

Before MCP (the response body, before any tool runs), always `{code, detail}`:

| Edge Library answers | When | The app answers the box |
|---|---|---|
| HTTP 401 `not_authorized` | The token is unknown (the body also carries OAuth's `error` and `error_description`), or the Telegram id header is missing or not a positive integer, or the username header is malformed | `unavailable`: an Agent Village configuration problem; never show the resident text for `not_authorized` |
| HTTP 403 `not_authorized` | An Edge Library admin revoked the Agent Village agent: the link is off for everyone | `not_authorized` |

Anything else before MCP (a 5xx, an unexpected body) is `unavailable` for a
503 and otherwise `connection_or_request_refused`, which tells the agent not to
claim a write landed and to read before writing again. JSON-RPC `-32602` is
`invalid_arguments`.

A tool's own refusal is an MCP result with `isError: true`, the text part
`CODE: message`, and `structuredContent: {code, detail}`, with Edge Library's
mapping of its `ServiceError` codes:

| Edge Library code | `code` | The app |
|---|---|---|
| `INVALID` | `invalid_arguments` | passes the result through as data (the detail says what to fix) |
| `UNAUTHENTICATED` | `not_connected` | answers the box `not_connected` |
| `FORBIDDEN` (the resident may not) | `not_authorized` | passes it through as data |
| `NOT_FOUND`, `GONE` | `not_found` | passes it through as data |
| `CONFLICT`, `STALE_VERSION` | `conflict` | passes it through as data |
| `RATE_LIMITED` | `rate_limited` | answers the box `rate_limited` |
| anything unexpected | `unavailable` | answers the box `unavailable` |

So the codes the box sees as refusals are `not_connected`, `not_authorized`,
`unavailable`, `invalid_arguments` (the app's own input check) and
`rate_limited`; it replaces each with its own text (`_library.py`
`LIBRARY_ERRORS`), never upstream wording. A tool refusal passed as data reaches
the agent framed as untrusted, with Edge Library's `detail`.

## Results

Return the MCP result as
`{"text": <the text content parts joined by a blank line>, "structured": <structuredContent or null>, "isError": <bool>}`.
Edge Library writes most results only as JSON (its text part is then exactly
`JSON.stringify(structuredContent)`); the app sends `text: ""` in that case so
the answer is not carried twice. The box frames the result as untrusted data
and scrubs hidden characters at every depth, replacing each with spaces.

**Offsets.** Edge Library's evidence spans (`{sourceId, start, end}`) and
`library.source` offsets are JavaScript string offsets: UTF-16 code units, end
exclusive. The box never recounts or rewrites them: it passes `start`, `end`
and `offset` through as numbers, and its scrubber keeps the UTF-16 length of
every string (a hidden character outside the BMP becomes two spaces), so an
offset Edge Library returned still points at the same text. The skill tells the
agent to copy `start` and `end` from passage hits, never to count them. Responses are capped at
262,144 bytes; the skill reads sources in 20,000-character slices.

## Edge Library side safety (its repository, `docs/MINIAPP.md`, is authoritative)

- The token speaks for every resident; Edge Library knows it only by its sha256
  hash (`AGENT_VILLAGE_TOKENS`, several while rotating).
- An Agent Village call acts as the Agent Village agent on behalf of the person
  with that Telegram id, with that person's role: only the eleven resident
  tools are listed or run, never the Librarian's.
- Every change is a commit with the person, the door (Agent Village) and the
  agent's confidence and rationale in the audit log; people can revert it.
- Search words are stored without who asked.

## Rollout

1. This overlay roll (box side: allowlist, bridge, skill). Older boxes refuse a
   projection that names `library`, Gold Stars included, so it comes first.
2. The CP catalog row (`library` 1.0.0, the eleven operations in this order,
   `restricted`) and the `MINI_APPS_TENANT_ALLOWLIST` entry for the sandbox
   tenant.
3. The app routes: the operation map, the headers, the refusal mapping and the
   budgets (see the reference implementation).
4. The token. Naman holds it and gives it to Edge City staff privately for the
   Agent Village app server's `MINI_APP_LIBRARY_TOKEN`. Never in a pull request.

## Reference implementation

[`docs/reference/library/app-server.ts`](../../docs/reference/library/app-server.ts)
is reference code for Edge City's app server: the operation map, the input
check against this manifest, the MCP call, the refusal mapping and the
budgets, with tests (`app-server.test.ts`, a fake fetch, no network). It is
not run on any box. It lives under `docs/` because `mini-apps/` is a closed
tree of manifests and READMEs only.

## V0 conformance evidence

The fixtures in
[`scripts/tests/fixtures/library/`](../../scripts/tests/fixtures/library/) are
Edge Library's own bodies, recorded on 25 October from its code (Edge Library main
`24fc444`, a local run of its MCP route against its test database, the way its
`agent-village.db.test.ts` calls it):

| Fixture | What | Body |
|---|---|---|
| `library.initialize/error-telegram-id-missing.json` | no identity header | 401 `{code: not_authorized, detail}` |
| `library.initialize/error-username-malformed.json` | a malformed username header | 401 `{code: not_authorized, detail}` |
| `library.search/error-revoked.json` | the Agent Village agent revoked | 403 `{code: not_authorized, detail}` |
| `library.search/error-invalid-arguments.json` | no `q` | MCP `isError` result, `{code: invalid_arguments}` |
| `library.get/error-not-found.json` | an unknown path | MCP `isError` result, `{code: not_found}` |
| `library.source/error-not-found.json` | an unknown source id | MCP `isError` result, `{code: not_found}` |
| `library.write/error-no-confidence.json` | a graph op without a confidence | MCP `isError` result, `{code: invalid_arguments}` |
| `library.schema/error-rate-limited.json` | over 60 calls a minute | MCP `isError` result, `{code: rate_limited}` |

The rate-limit body was recorded with the limit lowered for the run; its text
says 60, as production does. Not a fixture: the unknown-token 401, because its
body adds OAuth's `error` and `error_description` beside `{code, detail}`
(conformance takes exactly `{code, detail}`); the app maps every 401 to
`unavailable` anyway. No success fixture is invented.

```sh
bun run conformance -- mini-apps/library/manifest.json \
  --fixtures scripts/tests/fixtures/library --base origin/main \
  --out "$TMPDIR/conformance.json"
```
