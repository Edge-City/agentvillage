# Slopfolio mini-app for Agent Village

The Slopfolio mini-app for Edge City's Agent Village
(`Edge-City/agentvillage`), in that repository's layout, so the files copy
across unchanged:

- `skills/slopfolio/SKILL.md` — what a resident's agent does and says.
- `mini-apps/slopfolio/manifest.json` — what the owner installs and grants.

Written against upstream commit `944244c31d257fc561130208cdc8c594f2ac3a1d`,
modelled on its Gold Stars mini-app. Slopfolio maintains these files: changes
start on Slopfolio's side and reach `Edge-City/agentvillage` as pull requests.
The first, adding these files, is
https://github.com/Edge-City/agentvillage/pull/389.

## The contract Edge City's app server implements

The agent never talks to Slopfolio. It calls the `village` tool; Edge City's
app server holds the owner's Slopfolio connection and calls Slopfolio's MCP server.

**Connection.** OAuth 2.1 against the MCP resource `https://slopfolio.com/mcp`.
Discovery starts at
`https://slopfolio.com/.well-known/oauth-protected-resource/mcp`, which names
the authorization server. Register one OAuth client for Agent Village and
use a client name residents will recognise on the consent screen, such as
"Edge City Agent Village". If the first call with a new client's token
returns 403 `client_not_allowed`, send Slopfolio the client id and it is added
to Slopfolio's allow-list. Refresh the access token with the
refresh token when it expires; if refresh fails, return
`CAPABILITY_NOT_GRANTED` so the skill tells the owner to reconnect.

**Operations.**

| `village` operation | Slopfolio MCP tool |
|---|---|
| `slopfolio.prepare` | `prepare_slopfolio_post` |
| `slopfolio.status` | `get_slopfolio_draft_status` |

`publish_slopfolio_post` is deliberately not exposed: the owner publishes
on the review page.

**`slopfolio.prepare` argument mapping.**

| Skill argument | MCP input |
|---|---|
| `draftId` | `draft_id` (`null` for a new post) |
| `paste` | `capture.raw`, with `capture.kind: "process-summary"`, `capture.version: "v1"`, `capture.content_type: "text/markdown"` |
| `artifactUrl` | `supplements.artifact_url` |
| `medium` | `supplements.medium` |
| `fixes.title`, `fixes.oneLiner`, `fixes.tools`, `fixes.iterations`, `fixes.howItWasMade`, `fixes.bestDeadEnd`, `fixes.promptingApproach`, `fixes.tags` | `projection_overrides.title`, `.one_liner`, `.tools`, `.iterations`, `.how_it_was_made`, `.best_dead_end`, `.prompting_approach`, `.tags` |

Every call also carries these fixed values:

| Field | Value |
|---|---|
| `contract_version` | `v1` |
| `schema_id` (prepare) | `urn:slopfolio:schema:prepare-slopfolio-post-input:v1` |
| `capture.schema_id` | `urn:slopfolio:schema:capture:process-summary:v1` |
| `schema_id` (status) | `urn:slopfolio:schema:get-slopfolio-draft-status-input:v1` |

**Arguments.** `paste` is required on every prepare, revisions included,
as a string of 1 to 100,000 bytes; it is never `null` or omitted, and
`fixes`, when sent, is never `null`. A `null` clears only an individual
member: one field of `fixes`, or `artifactUrl` or `medium`. `draftId` is a
lowercase v1 to v5 UUID returned by an earlier prepare, omitted or `null`
for a new draft. `artifactUrl` is an `https://` URL of at most 2,048
characters with no credentials. `medium` is one of `code`, `image`,
`video`, `audio`, `workflow` or `null`; `fixes.iterations` is one of
`one_shot`, `a_few_tries`, `many_attempts` or `null`. Text and list bounds
are in the skill. Pass through only what the agent sent. On a revision,
`artifactUrl` and `medium` left out are kept on the draft; the other fields
come from the paste unless `fixes` overrides them, which is why the skill
re-sends every fix the owner has made.

**Results.** The app server returns the MCP result's `structuredContent`
with keys in camelCase:

| Key | Shape |
|---|---|
| `code` | prepare: `PREPARED`, `INPUT_REQUIRED`, `PRIVACY_BLOCKED`, `UNSUPPORTED_POST_SHAPE`, `CAPABILITY_NOT_GRANTED`, `INVALID_ARGUMENT`, `UNSUPPORTED_CAPTURE_SCHEMA`, `CAPTURE_VERSION_MISMATCH`, `DRAFT_NOT_FOUND`, `DRAFT_NOT_EDITABLE`, `OPERATION_ID_CONFLICT`, `RATE_LIMITED`, `TEMPORARY_UNAVAILABLE`, `INTERNAL_ERROR`; status: `STATUS`, `CAPABILITY_NOT_GRANTED`, `INVALID_ARGUMENT`, `TEMPORARY_UNAVAILABLE` |
| `draftId` | lowercase UUID, or `null` |
| `reviewUrl`, `postUrl` | URL on the exact origin `https://slopfolio.com`, when present |
| `status` | status only, on `STATUS`: `draft`, `published`, `deleted`, `not_found`. A status error may omit it. A nonexistent id returns `STATUS` with `not_found`. |
| `missing` | string list from `title`, `one_liner`, `artifact_url`, `medium`, `tools` |
| `findings`, `warnings` | lists of `{code, message, severity}`: `code` 1 to 80 characters, `message` 1 to 240, `severity` `block` or `warn` |

Agent Village caps each list at 20 items. Its own validation and upstream
failures are not MCP codes: they reach the agent as
`connection_or_request_refused` with HTTP 422 or 502. `DRAFT_NOT_FOUND` and
`DRAFT_NOT_EDITABLE` reach the agent with `retryable: false`.

**Draft ownership.** Slopfolio lets a connection revise any draft on the
owner's account. Agent Village narrows that: it revises only drafts its
agent created under the current connection grant, and checks the draft's
status before each revision, so a revision costs two operations. Drafts
made on the website or before a reconnect are edited on Slopfolio.

**`operation_id` (safe retries).** The agent does not send one. Agent
Village derives it as `av-` plus the first 40 hex characters of
`sha256(canonical_json([owner_id, grant_generation, trusted_originating_turn_id, arguments]))`.
A retry in the same turn, on the same connection, with identical arguments
reuses the id, so Slopfolio replays the first result instead of creating a
second draft. A later message or a reconnect changes the id and is a new
request; Agent Village's local receipts also expire after 24 hours. The
skill therefore retries only within the turn and never re-sends a new
post's prepare later. Slopfolio rejects one `operation_id` with a
different payload as `OPERATION_ID_CONFLICT`, which this derivation cannot
produce. The id must match `^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$`.

**Timing.** Measured over the last 30 days of production prepares (n=7):
0.10 s typical, 0.17 s slowest, database time only. Both operations fit
the 25 s read/staging timeout comfortably.

**Limits.** Slopfolio allows 100 MCP operations per account in any rolling
24 hours, counted across all of the account's connections; Agent Village
also allows 100 per UTC day. Beyond either, the result is `RATE_LIMITED`, a
daily quota that the skill never retries. The paste is capped at 100,000
bytes.

## Changing these files

Changes start on Slopfolio's side, which keeps the skill's rules aligned
with its server: the field list above comes from its MCP contract, the voice
rules from its authoring guidance, and the prompt the agent links to is
https://slopfolio.com/prompt.
