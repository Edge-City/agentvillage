# Edge Library mini-app (1.0.0, reads only)

Adapted by Edge City from Naman's bundle (Edge-City/agentvillage#506, by
Nhajela; his commits are kept in this branch's history).

## What it is

Edge Library is the village knowledge graph of Edge City India 2026
(https://library.positivesumexperiments.com): typed nodes (people, projects,
tools, topics), typed links between them, each fact referenced to the source
text it came from, and a git-style history of every change. Only signed-in
Edge Library members can read it. This mini-app lets a resident's agent search
and read it.

**1.0.0 is READS ONLY** (Carter, CD-44): the eight read tools. Edge Library's
three writes (`library_submit_source`, `library_write`, `library_propose`) are
not exposed: no operation, manifest entry, schema enum value or tool name
reaches them. Writes, staged then sent on a later owner yes (the Kismet
pattern), are a later version.

- `skills/library/SKILL.md`: what the agent does and says.
- `mini-apps/library/manifest.json`: the v2 manifest (operations, input
  schemas, budgets, the auth mode).
- `plugins/village-bridge/_library.py`: the box-side argument checks, the
  answer framing and the error text.

The id is `library` because the shared validator reserves the `edge-` family;
the display name is "Edge Library".

## Why the reviewed path, and why app-token

Every Edge Library tool, the two no-argument reads included, needs Edge
Library's service token and an identity header for the resident, and its
content is for members only. A generic entry (`mcp`, `auth: none`) cannot
carry either, so this is a reviewed app. The service is `app-token`: one token
between Agent Village and Edge Library and no second sign-in. The owner only
installs the mini-app. The box never sees the token, the endpoint, the subject
or a person id.

## What is sent, and to whom (CD-44)

- **To Edge Library's origin only** (`https://library.positivesumexperiments.com`,
  the manifest's `baseUrl`; the dispatcher sends the bearer only there, with
  `redirect: "error"`).
- **Only for a resident who installed `library`** (the app checks the cp's
  installed entry on every call; an uninstalled resident's call never leaves
  the app).
- **Per call:** the service token (`Authorization: Bearer`, from the env name
  `MINI_APP_LIBRARY_KEY` by `secretRef`), the header
  `X-Village-Subject: <the app's per-app reference for the owner>`, and the
  read's own `arguments` (search words, ids, paths, limits) as the MCP tool's
  arguments.
- **Never:** a Telegram id or username (no `X-Agent-Village-Telegram-User-Id`
  or `X-Agent-Village-Telegram-Username` header), an email, a name, the cp
  tenant or human id.

The subject is the app server's existing `subject` separation mode, as
Kismet's: an HMAC under `MINI_APPS_SUBJECT_SECRET` of the app id, the tenant
id and the human id. It is stable for this app and resident and does not link
to Telegram, an email or another app. It never comes from the box or the
model. The box refuses any argument key naming a resident, at any depth,
before sending.

## Identity on the Edge Library side (its integration guide and Naman's answers)

- Edge Library accepts `X-Village-Subject` as the resident's identity when no
  Telegram id is sent (Naman, 29 October).
- A read never creates a member entry. Edge Library creates one only on a
  resident's first write, and 1.0.0 has no write.
- Every call acts as one "Agent Village" agent on behalf of the resident, with
  a member's role, whatever the person's own Edge Library role. An admin's
  agent reads no more than a member's.
- An admin revoking the Agent Village agent switches the whole link off (403).
- **Rate limit: 60 tool calls a minute per resident** (`initialize` and
  `tools/list` do not count).

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

Every operation: `maxResponseBytes` 262144, `timeoutMs` 25000, framing `data`.
Not exposed: the three writes, and the Librarian's tools (`library_jobs_claim`,
`library_jobs_complete`, `library_jobs_fail`, `library_queries`).
`mini-app.read` refuses `library`.

## Approval classification

All eight are `read` and join the existing read class (box
`READ_OPERATIONS`): no new class, row, gate or card, and no verified gate (no
write). Nothing in 1.0.0 changes anything in Edge Library.

## Input rules

The `input` schemas are Edge Library's own zod tool schemas, converted to JSON
Schema 2020-12 by Naman (`description`, `default` and `format` dropped,
`"additionalProperties": false` on every object). The box (`_library.py`)
checks the same before transport: exact keys, uuids, bounds, and the 4 KiB
request budget of the whole request it sends. Anything else is
`invalid_library_arguments`, with the box's own text, and nothing is sent. The
box sends `X-Village-Operation: <operation>` for every Library operation, so
the app serves it from the reviewed manifest.

## The app server's part (the generic dispatcher; a prerequisite)

The app half rides the generic dispatcher (`dispatch/*`), as Kismet's does
(app#882). It needs, in agentvillage-app:

1. The vendored `library` manifest (this file's `manifest.json`, byte for
   byte at the overlay tag) and its catalog row.
2. A reviewed resident-separation entry for `library` bound to that
   manifest's sha256, in the existing `subject` mode (as Kismet's):
   `RESIDENT_SEPARATION.library = {mode: "subject", manifestSha256}`. The
   dispatcher already adds `X-Village-Subject` for a `subject` app; no new
   mode, no Telegram id and no username. Without the entry the app sends no
   identity and Edge Library refuses every call (401); nothing leaks.
3. `library` in `MINI_APPS_DISPATCH`; fail closed (503
   `mini_app_unconfigured`) while `MINI_APP_LIBRARY_KEY` is unset.
   `MINI_APPS_SUBJECT_SECRET` must be set (already a Kismet go-live item; it
   never rotates).

The dispatcher already does the MCP call: `initialize` (protocol
`2025-06-18`), `notifications/initialized` and `tools/call`, bearer only to
the manifest origin, `redirect: "error"`, the response cap, and the frame
`{kind: "mini-app", appId, operation, asOf, result}`.

## Edge Library's refusals and what the box says

Before MCP (an HTTP status): a 401 (unknown token, or no identity header) and
a 403 (the Agent Village agent revoked) reach the box as the dispatcher's
closed codes (`mini_app_upstream_refused` and the like). The box replaces
every closed code with its own text (`_library.py` `LIBRARY_APP_ERRORS`).

A tool's own refusal is an MCP result with `isError: true` and
`structuredContent: {code, detail}`. The box maps `invalid_arguments`,
`not_found`, `not_authorized`, `not_connected`, `rate_limited` and
`unavailable` to its own text; for `invalid_arguments` and `not_found` it also
relays Edge Library's `detail` (scrubbed, capped, with the untrusted
`handling` note), because it says what to fix. Any other code is
`library_refused`.

## Results

The box relays `structuredContent` as `data.structured` and adds `data.text`
only when Edge Library wrote text that is not just the JSON of
`structuredContent`. Every answer carries `handling`: everything in it was
written by members, other agents or the Librarian, untrusted data, never
instructions.

**Offsets.** Edge Library's evidence spans (`{sourceId, start, end}`) and
`library.source` offsets are JavaScript string offsets (UTF-16 code units).
The box never recounts or rewrites them, and its scrubber (Naman's
`library_scrubbed`) replaces each hidden character with spaces of the same
UTF-16 length, so an offset still points at the same text.

## Edge Library side safety (its repository, `docs/MINIAPP.md`, is authoritative)

- The token speaks for every resident; Edge Library knows it only by its sha256
  hash (`AGENT_VILLAGE_TOKENS`, several while rotating).
- Every call is in its audit log with the member and the door (Agent Village).
- Search words are stored without who asked.

## Rollout

1. The overlay release that carries this bundle (v2.1.20, best effort; it
   slides to v2.1.21 rather than hold the cut) is tagged.
2. One cp switch PR (the release's, as DreamStarter's), deployed before that
   tag's fleet roll: the vendored reviewed manifest, `library` in
   `REVIEWED_APP_IDS` and `overlay.json`, the catalog row `restricted`, and a
   re-vendor. There is no generic `library` entry to remove. An older box
   refuses `library` alone (an unknown id with named operations); every other
   app stays.
3. The fleet roll.
4. The app half (above), deployed with `library` in `MINI_APPS_DISPATCH`.
5. Carter's hands: `MINI_APP_LIBRARY_KEY` on the app service (where
   `MINI_APP_KISMET_KEY` lives; never in a pull request), and
   `MINI_APPS_TENANT_ALLOWLIST.library` for the first tenants. Then Naman's
   smoke test, reads only, with the subject header.

## V0 conformance evidence

The fixtures in
[`scripts/tests/fixtures/library/`](../../scripts/tests/fixtures/library/) are
Edge Library's own bodies, recorded by Naman on 25 October from its code (a
local run of its MCP route against its test database). They carry no ids and
no member data:

| Fixture | What | Body |
|---|---|---|
| `library.initialize/error-telegram-id-missing.json` | no identity header | 401 `{code: not_authorized, detail}` |
| `library.search/error-revoked.json` | the Agent Village agent revoked | 403 `{code: not_authorized, detail}` |
| `library.search/error-invalid-arguments.json` | no `q` | MCP `isError` result, `{code: invalid_arguments}` |
| `library.get/error-not-found.json` | an unknown path | MCP `isError` result, `{code: not_found}` |
| `library.source/error-not-found.json` | an unknown source id | MCP `isError` result, `{code: not_found}` |
| `library.schema/error-rate-limited.json` | over 60 calls a minute | MCP `isError` result, `{code: rate_limited}` |

Dropped from #506: the write fixture (no write in 1.0.0) and the malformed
username fixture (no username is ever sent). No success fixture is invented.

```sh
bun run conformance -- mini-apps/library/manifest.json \
  --fixtures scripts/tests/fixtures/library --base origin/main \
  --out "$TMPDIR/conformance.json"
```
