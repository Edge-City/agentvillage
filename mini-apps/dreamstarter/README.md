# DreamStarter mini-app

## What it is

DreamStarter (https://dreamstarter.xyz) in a resident's agent, three ways, each
only when the resident asks:

- **Dreams.** The resident types a few lines (what they want to build, their
  interests, their goals); DreamStarter suggests up to three dreams with a claim
  link each. The dream is the resident's only once they open the link and claim
  it on dreamstarter.xyz.
- **Grant.** The agent gathers the resident's ElevenLabs Startup Grant
  application and DreamStarter stages it as a private draft with a review link.
  The resident accepts the terms and clicks Submit there; DreamStarter then
  submits it to ElevenLabs' live grant form.
- **Local businesses.** DreamStarter's public write-ups of the Goa businesses
  in the program, with a Buildathon build idea and a claim link each.

The bundle was written by the DreamStarter team (Edge-City/agentvillage#393, by
arrfire) as a generic public-read app. Edge City adapted it to the reviewed-app
path, because two operations send the resident's own words to DreamStarter:

- `skills/dreamstarter/SKILL.md`: what the agent does and says.
- `mini-apps/dreamstarter/manifest.json`: the v2 manifest (operations, input
  schemas, budgets, the auth mode).
- `plugins/village-bridge/_dreamstarter.py`: the box-side argument checks and
  error text.

## Why the reviewed path, and why app-token

A generic app is a public read relay (`service.kind` `mcp`, `auth.mode` `none`,
every operation `read`), served to the box as `mini-app.read`. Two DreamStarter
tools are writes in substance, so the relay cannot carry them (the shared
validator's `v1Entry` drops a relay app with any non-read op, `relay_non_read_op`):

- `discover_dreams` sends the resident's text, which DreamStarter passes to
  Google Gemini (gemini-2.5-flash; if Gemini fails, a keyword matcher on
  DreamStarter's own server answers). No resident text is kept: DreamStarter
  does not store or log the lines, and keeps only the generated suggestions
  (title, one-liner, why it fits, first week).
- `grant_prepare` sends the resident's application answers (name, emails,
  phone, LinkedIn, company registration and address), which DreamStarter keeps as
  a private draft and submits to ElevenLabs only on the resident's own Submit
  click on its review page.

### Retention and privacy (DreamStarter's answers, 28 October 2026)

- Suggestions nobody claims: deleted after 14 days. Each suggestion also makes
  an unclaimed draft on dreamstarter.xyz (so the claim link has context); a
  monthly cleanup removes those older than 30 days.
- Grant drafts never submitted: deleted 14 days after the last change. The
  resident can delete a draft at once from its review page, or by email.
- Submitted applications and their proof-of-submission screenshot: deleted 30
  days after submission.
- Deletion runs hourly. Nothing is sold or used for training. ElevenLabs gets
  the grant details only when the resident accepts the terms and presses
  Submit.
- Privacy policy: https://mcp.dreamstarter.xyz/privacy (this mini-app), which
  links to https://www.dreamstarter.xyz/privacy for claimed dreams.

So the whole app is reviewed, like Slopfolio, zzz.bot and the open Volunteers
and Library apps: its own named operations on the box, an exact entry in the
installer's and the bridge's reviewed tables, and per-app app-server code. A
reviewed write app with one service credential is `app-token`: the app server
holds ONE key for DreamStarter (`MINI_APP_DREAMSTARTER_KEY`), so DreamStarter
can tell Agent Village's calls from anyone else's, and staff can rotate or
revoke it. The resident has no DreamStarter sign-in here; sign-in happens on
dreamstarter.xyz when they claim a dream or open a review page.

The app server sends **no resident identity** to DreamStarter: no Telegram id
or username, no attendee id, no name. DreamStarter's tools have no identity
slot. A `ref` (dream or application) is DreamStarter's own capability token,
returned to the resident's agent in their private chat.

## The call

Standard MCP (streamable HTTP, JSON responses): `POST` to
`https://mcp.dreamstarter.xyz/mcp`. The key rides as `Authorization: Bearer`
(the app server reads it from `MINI_APP_DREAMSTARTER_KEY`, the manifest's
`auth.secretRef`; only the name is in this repo). DreamStarter's `/mcp` checks
that header and stores only the key's SHA-256; a wrong key is a 401. A call
with no key still works today, so the generic reads of cp#456 are unaffected;
on the day the release carrying this bundle rolls, DreamStarter makes
`discover_dreams` and `grant_prepare` require the key (DreamStarter needs that
date). DreamStarter accepts several keys at once, so a rotation has no
downtime. Headers:

```
Authorization: Bearer <MINI_APP_DREAMSTARTER_KEY>
Accept: application/json, text/event-stream
Content-Type: application/json
MCP-Protocol-Version: 2025-06-18
```

then `initialize` (protocol `2025-06-18`), `notifications/initialized` and a
`tools/call` of the operation's tool, with the box's `arguments` forwarded
unchanged as the tool's MCP `arguments`. DreamStarter is stateless today (no
`Mcp-Session-Id`); carry one if it is returned. The box's `turnId` is never
forwarded.

## Operations

| `village` operation | DreamStarter tool | Class | Box path |
|---|---|---|---|
| `dreamstarter.discover` | `discover_dreams` | write | `gate_verified`, trusted `turnId` |
| `dreamstarter.dream_status` | `dream_status` | read | none |
| `dreamstarter.workflows` | `list_workflows` | read | none |
| `dreamstarter.grant_requirements` | `grant_requirements` | read | none |
| `dreamstarter.grant_prepare` | `grant_prepare` | write | `gate_verified`, trusted `turnId` |
| `dreamstarter.grant_status` | `grant_status` | read | none |
| `dreamstarter.businesses` | `list_businesses` | read | none |
| `dreamstarter.business_brief` | `business_brief` | read | none |
| `dreamstarter.business_status` | `business_status` | read | none |

`mini-app.read` refuses `dreamstarter` (the projection carries no
`mini-app.read`). The three tools with no input (`list_workflows`,
`grant_requirements`, `list_businesses`) are ordinary reads: the box classes
them in `READ_OPERATIONS`, the same class `mini-app.read` has, with no gate.

## Approval classification

This follows the developer guide, section 7: app actions run on their own by
default; only a payment shows a card. No class, row or gate is added.

- The seven reads run on their own, like every read.
- `discover` and `grant_prepare` are `write`s, not `needs-card`: neither is a
  payment, and both are the resident's own words sent on the resident's own ask.
  On the box they take the existing gated-write path (`gate_verified`, as
  `mini-app.context.write`, zzz.bot's posts and Slopfolio's drafts): refused
  while the approval gate is off or unverified, no card, no manual grant.
- The resident's yes comes from the skill: before either send, the agent shows
  exactly what will be sent (every field, for the grant), says who keeps it and
  for how long and who processes it (Google Gemini for discovery, which keeps
  only the suggestions; the 14-day draft and the live ElevenLabs submit for the
  grant), and waits for a later owner message saying yes. This is a prompt
  rule, as in Edge Library's writes.
- Final submission to ElevenLabs is always the resident's own click on
  DreamStarter's review page, never the agent's. `grant_prepare` only saves a
  draft; the send to ElevenLabs happens on DreamStarter's server after the
  resident ticks the terms and clicks Submit in their own browser. That page is
  the human step before anything leaves, so the box adds no confirm step of its
  own (DreamStarter offered one; none is added: no new gates).

## Input rules

The box checks every call (`_dreamstarter.py`) against DreamStarter's published
input schemas (tools/list at serverInfo `dreamstarter 1.1.0`, equal to the
manifest's `input` once the live `$schema` key is dropped, checked 28 October
2026) before sending:
exact keys, types, lengths, the `ref` pattern `^[a-z0-9]{20,64}$` and the `slug`
pattern `^[a-z0-9-]{3,40}$`. Anything else is `invalid_dreamstarter_arguments`
before transport. The app should check again with each operation's `input`
schema and refuse anything else with `invalid_arguments`.

One box rule goes beyond the schema: a `discover` call whose text holds an email
address or a run of nine or more digits (a phone number) is refused,
`dreamstarter_contact_details`, nothing sent. Discovery never needs contact
details, and the review's M2 limits it to the lines the resident types for that
request. It is a heuristic (false positives accepted; a year range such as
2019-2024 has eight digits and passes).

The box adds `turnId` (a UUIDv5 of the trusted session key and message id, never
model input) to the two writes and sends `X-Village-Operation` for them.
Budgets: `maxRequestBytes` 4096, except `discover` 8192 and `grant_prepare`
16384; every operation fits 25 seconds.

## The app server's part (a prerequisite, not in this pull request)

- The operation map above, the input check against the manifest, the MCP call
  with `MINI_APP_DREAMSTARTER_KEY`, and no identity header.
- **Same-turn replay.** For a write, keep `sha256(owner, turnId, operation)`
  with the answer for 15 minutes and return the same answer for a retry in the
  same turn, so an uncertain retry never makes a second set of suggestions or a
  second draft. Never store the arguments or the answer text beyond that.
- **Results.** Return the MCP result as
  `{"text": <the text content parts joined by a blank line>, "structured": <structuredContent or null>, "isError": <bool>}`.
  DreamStarter answers its own refusals as an `isError` result whose text is
  `{"error": "<code>", "message": "..."}` (the fixtures below); pass them as
  data. The box scrubs hidden characters at every depth and frames the result as
  untrusted.
- **Refusals before MCP.** A 401 or 403 from DreamStarter (a wrong key) is
  `unavailable`, never shown as the resident's problem; a 5xx or a timeout is
  `unavailable`; JSON-RPC `-32602` is `invalid_arguments`; the app's own limit is
  `rate_limited` (suggest 60 operations per owner per UTC day, 10 writes).
- The box knows `not_found`, `unavailable`, `invalid_arguments` and
  `rate_limited` for these operations and replaces them with its own text
  (`_dreamstarter.py` `DS_ERRORS`); anything else is
  `connection_or_request_refused`, which tells the agent not to claim a send.

## What the results contain

- The output is not pinned: DreamStarter's server can change a tool's
  description or output after review (`tools.listChanged: true`). The box frames
  every answer as untrusted data and the skill tells the agent to ignore any
  `note`, `message`, `how_it_works` or `next` text that tells it what to do.
  DreamStarter corrected that text on 28 October 2026: live
  `grant_requirements` `how_it_works` now reads "The owner sees and approves
  their answers before grant_prepare is called. grant_prepare saves a private
  draft and returns a review_url. On that page the owner checks every answer,
  accepts the ElevenLabs grant terms and clicks Submit. Nothing is sent to
  ElevenLabs before that click.", and `grant_prepare`'s `next` no longer tells
  the agent to collect answers and call `grant_prepare`. The skill's own
  show-every-field-and-ask step is unchanged.
- `dream_status` and `business_status` can carry timeline events with
  `simulated: true`; the skill and the box's handling text label them as a
  preview, not live activity.
- Returned links (claim, overview, page, review, the ElevenLabs sign-up, form and
  terms links, businesses' public links) are not host-pinned on the box; the
  skill says to share only links the tool returned, unchanged. DreamStarter
  names the full set of hosts it returns (28 October 2026), for a pin if one is
  ever added:
  - `mcp.dreamstarter.xyz`, `dreamstarter.xyz` (pages, review, claim);
  - `elevenlabs.io` (sign-up, form, terms);
  - `build.edgecity.live`;
  - the local businesses' public links: `instagram.com`, `facebook.com`,
    `x.com`, `youtube.com`, `linkedin.com`, `tripadvisor.in`,
    `indiayogaschool.com`, `instacarex.in`, `inspirebyneha.com`,
    `buklo.vercel.app`.

## Rollout

The id starts GENERIC: the three no-argument reads ship first as a cp-only app
(Edge-City/agentvillage-controlplane#456, `dreamstarter` 1.2.0,
`["mini-app.read"]`, restricted). This bundle moves the same id to reviewed. A
generic and a reviewed app with one id cannot coexist on a box, so the order is
fixed, never the reverse:

1. The overlay release that carries this bundle (v2.1.20) is tagged.
2. One cp PR, deployed **before** that release's fleet roll starts:
   - it removes the generic manifest and skill;
   - it adds this reviewed manifest (`dreamstarter` 2.0.0, the nine operations
     in this order, `restricted`), vendored at the tag;
   - it adds `dreamstarter` to the cp's reviewed ids and `overlay.json`, and
     re-vendors.

   An older box then refuses `dreamstarter` alone (an unknown id with named
   operations fails the generic check for that app only); every other app stays.
3. The fleet roll. A box carrying this bundle must never receive the generic
   entry: with `dreamstarter` in `REVIEWED_ENTRIES` that refuses the whole
   projection, Gold Stars included.
4. The app routes (above), and the key: DreamStarter has issued it and pins
   only its hash; Edge City staff set `MINI_APP_DREAMSTARTER_KEY` on the cp.
   Never in a pull request. Tell DreamStarter the roll date: that day it makes
   the two writes require the key.
5. `MINI_APPS_TENANT_ALLOWLIST.dreamstarter` stays the author's own tenant
   (staff look it up by his Edge City account; never in a pull request) until
   Edge City rules on the brand and partner code and on the local businesses'
   consent.

## V0 conformance evidence

`bun run conformance -- mini-apps/dreamstarter/manifest.json --fixtures scripts/tests/fixtures/dreamstarter --base origin/main --out "$TMPDIR/conformance.json"`
passes. The three fixtures are DreamStarter's live answers on 28 October 2026 to
public reads with synthetic `av-test` ids that do not exist (no resident data):

| Fixture | Call | Answer |
|---|---|---|
| `dreamstarter.business_brief/error-not-found.json` | `business_brief {"slug":"av-test-none"}` | `isError` result, `not_found` |
| `dreamstarter.grant_status/error-not-found.json` | `grant_status {"ref":"avtestnone00000000000000"}` | `isError` result, `not_found` (its text also confirms the 14-day draft deletion) |
| `dreamstarter.dream_status/error-not-found.json` | `dream_status {"ref":"avtestnone00000000000000"}` | `isError` result, `not_found` |

No success fixture is invented. The writes were never called.

## Open questions

- Pinning returned link hosts on the box. DreamStarter has named the hosts
  (above); no pin is added here.
