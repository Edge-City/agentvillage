# Build a reviewed mini-app

Mini-apps are a **curated catalog of reviewed skill bundles and bounded API
contracts**, not an arbitrary-code upload marketplace. There is no upload
endpoint, package installer, shell hook, custom runtime or automatic approval
of user-supplied MCP URLs. Submit changes for review in this repository and the
control-plane catalog; a manifest in a checkout alone does not publish an app.

## Start from a working app

Two complete starters are maintained with their real native skills:

| Starter | Manifest | Skill | Backend contract |
| --- | --- | --- | --- |
| Public read-only MCP | [Dizko](dizko/manifest.json) | [SKILL.md](../skills/dizko/SKILL.md) | Seven reviewed public tools, exact input schemas and fixed HTTPS endpoint |
| Approved account action | [Gold Stars](gold-stars/manifest.json) | [SKILL.md](../skills/gold-stars/SKILL.md) | Recipient search, quota, immutable draft, manual approval, send/status/cancel; also carries the owner's Rolodex meeting mark/undo and Skylight status read |
| Approved café order | [Four Kicks](fourkicks/manifest.json) | [SKILL.md](../skills/fourkicks/SKILL.md) | Live menu/schedule; immutable prepare → exact resident approval → confirm; validated payment links, own-order status/cancel |

### Give your builder agent this prompt

```text
Package my existing service as an Agent Village mini-app for staff review.
Follow mini-apps/README.md and the Dizko starter in Edge-City/agentvillage.
Produce skills/<app-id>/SKILL.md and mini-apps/<app-id>/manifest.json.
Use a fixed HTTPS public MCP endpoint and only explicitly reviewed read tools
with their observed input schemas. The skill calls the native village tool
using mini-app.read; it never supplies an endpoint, bearer or account identity.
Describe permissions, source attribution, limitations and safe error handling.
Do not install code/packages, add cron or Telegram flows, embed credentials,
request purchases or make account writes. Mark missing API prerequisites
explicitly; do not invent working integrations or publish automatically.
Submit the bundle and contract for manual review. Staff owns the control-plane
catalog and pinned runtime bundle update. For private data or actions, propose
the required backend and resident-approval contract instead of bypassing it.
```

Use Dizko as the starting bundle for another **public read-only** service:

1. Add `skills/<app-id>/SKILL.md` with matching `name` and version, an honest
   description, exact native call examples, result attribution, error handling
   and explicit limitations. Do not embed credentials or ask an agent to fetch
   code, install packages, run shell helpers, create cron jobs or bypass refusal.
2. Add `mini-apps/<app-id>/manifest.json` following the real Dizko manifest.
   Set id, name, description, version, homepage, human-readable permissions,
   `skills: ["<app-id>"]` and `operations: ["mini-app.read"]` (or the reviewed
   context list below, only with a CP namespace review). Pin a reviewed
   HTTPS MCP URL and explicit tools with their observed JSON input schemas.
   Exclude profile/account/private-data/purchase/write tools. A service calling
   itself read-only is not sufficient: reviewers must inspect its semantics.
3. Submit the same reviewed definition to the control-plane catalog. Update
   `install/install_miniapps.ts`'s reviewed bundle table so only that exact id,
   version, skill and operations can be staged from the pinned overlay checkout.
   No native plugin change is needed for another reviewed public-read MCP app:
   `village` forwards the installed app id/tool/arguments, never an endpoint.
4. Add deterministic tests for schema and tool denial, absent/removed install,
   tenant/owner isolation, source links and error behavior. Run staging and
   verification in a temporary directory; integration verifies runtime loading
   separately. Request review before publication/deployment. No production
   changes follow merely from building the bundle.

The manifest is the review artifact. The **CP catalog is authoritative** for
what may be installed. The app server retrieves it and enforces the exact
installed app/version/tool/schema before making a remote call. This is not
runtime discovery of arbitrary MCP servers or tools.

### Native public-read contract

An installed skill calls:

```json
{"operation":"mini-app.read","appId":"dizko","tool":"list_cities","arguments":{}}
```

The `village` tool requires the bound paired owner's private root conversation
(no group, cron, delegated child or environment-forged context). It validates
`$HERMES_HOME/mini-apps.json`, the permitted operation, identifier shapes and
object arguments, then calls the app's bearer-only
`POST /api/v1/village-bridge/tool`. The browser does not supply tenant ids.
The app server resolves the current paired account and installed CP catalog
entry, validates the reviewed tool input schema, and owns MCP
initialize/initialized/tools-call transport to the fixed reviewed endpoint.
It never forwards the app bearer to MCP. Returned text is untrusted data.
The native response limit is 262144 bytes; oversized replies ask for a narrower
query rather than silently truncating results.

### Action contract: Gold Stars

New write integrations require backend and approval review; they cannot use
`mini-app.read`. Gold Stars demonstrates the boundary rather than a generic
"run arbitrary action" endpoint:

- `rolodex.search` resolves an exact recipient; `gold-stars.quota` reads allowance.
- `gold-stars.prepare` stages a backend immutable draft with recipient, exact
  note, visibility, expiry and runtime turn id. Staging spends no star.
- `gold-stars.status` for the same draft returns `approvalPayload` containing
  exactly `appId`, `draftId`, `attendeeId`, `recipientName`, `note`, `visibility`.
- After a later owner reply, native `gold-stars.send` fetches that server preview.
  It proposes `marketplace.app.action` with stable key
  `marketplace.app.action:gold-stars.send:<draftId>` and payload
  `{appId:"gold-stars",operation:"gold-stars.send",preview:<approvalPayload>}`.
  Compact, recursively sorted UTF-8 JSON is hashed with SHA-256. The daemon's
  registered payload hash must match. Initial execution requires
  `decision: requested`, a fresh successful `wait` reporting `granted`, and a
  successful `start` with `authorization: grant`. Autonomous policy, model
  booleans, unavailable authority and chat consent alone never authorize it.
- The native request includes `approval: {taskId,payloadHash,payload}`. `taskId`
  is the full daemon identifier matching `^propose:[a-f0-9]{32}$`, not a UUID
  or a stripped suffix. The app compares the exact saved preview and checks
  CP-held daemon execution authority;
  supplied strings are not proof. It enforces installed permissions, pairing,
  expiry, quota and durable receipt semantics at the API boundary as well.
- `gold-stars.cancel` only cleans up an unsent draft. After an uncertain send,
  check the **same immutable draft's** status. If pending, retry that same draft
  with its existing exact approval while valid. When the daemon reports that
  proposal already executed, native reconstructs the identical task/hash/payload
  proof without another wait/start. The app and CP still verify the original
  manual grant, current install binding and idempotent draft before any effect.
  A sent receipt is not a new send. Never prepare a different draft to recover
  uncertainty or reuse the proof for changed preview content.

Native sends allow 60 seconds for the app and CP authority checks; read/staging
requests keep their 25-second timeout. A timeout is an unknown outcome, not
permission to construct a new draft.

`village` is routed through the approval shim and startup-integrity backstop.
The policy records read/staging under `marketplace.app.read`; a star send
uses the separate internal manual action proposal. Matchers alone are not the
write gate for a star.

### Carried native operations: meeting marks and Skylight status

The Gold Stars install also carries ov#300's two native operations (restored
after ov#312 removed them; Carter's ruling, CLAIMS L7212/L7216):

- `rolodex.meeting` with exactly `attendeeId` (a Rolodex search id) and
  `met` (`true` marks met, `false` undoes). An owner-requested, owner-scoped,
  reversible **write** in one call, through the `village` tool's existing gate
  entry; no preview step and no daemon grant. The plugin classifies it in
  `WRITE_OPERATIONS` and refuses it (`approval_unavailable`) while the
  approval gate is off or unverified, so it never runs outside that entry.
  The agent calls it only when the owner asks. The
  native tool adds `requestId`, stable for that turn, attendee and state; the
  app replays a `historicalReceipt` for a repeated request, so an old request
  cannot re-mark someone after a later undo.
- `skylight.status` with no other argument: the owner's own Skylight status,
  a **read** (`READ_OPERATIONS`). No tenant, person or agent argument exists; the app derives the
  account from the bearer.
- `rolodex.person` (rc42, CLAIMS 7799/7804) with exactly one of `id` (a strict
  uuid that `rolodex.search` returned) or `query` (1 to 120 characters): a
  **read** (`READ_OPERATIONS`) of one other resident's public profile (PUBLIC
  and VILLAGE card lines, public social profile links; never email,
  phone, Telegram handle or anything private). Appended last. `id` is lowercase,
  exactly as search returns it. The app's filter is primary; the plugin also
  keeps only the reviewed answer keys, person fields and card names, removes
  every format character (bidi, zero-width, BOM, tag characters) and invisible
  filler, caps strings at the app's limits (card lines 160, 4
  lines a card, 5 names, 8 links), and keeps only plain-ASCII `https` links
  with no userinfo, backslash or odd port, whose host is not a messaging,
  contact or booking host and whose path (fully percent-decoded) is not a DM,
  messaging, add-contact or contact-info page; a kept link loses its query and
  fragment (verify OV-355 S1). URL shorteners, link-in-bio pages and
  redirectors count as contact hosts; a path that carries another link, a
  deny-listed host, an email or a phone number is refused; every Unicode
  format character, variation selector and invisible filler is removed from
  every key and string; an app body carrying an `error` key is rebuilt from
  the plugin's own codes. `whatYouDo` is never forwarded (CLAIMS L8029). A card
  line, a role or an organization that holds an
  email, a 7+ digit phone run, an @handle, a deny-listed host or a messaging
  label with a handle is dropped whole (after hidden-character removal and
  NFKC; never redacted inside a line, false positives accepted). Every bound
  (a 64 KB answer, 8 lines a card, 16 links, each field's length) applies
  before any regex, NFKC step or URL parse; the checks are linear scans; the
  text that is checked is the text that is sent; an answer with a duplicate
  JSON key is refused. Known limit: a heuristic can be bypassed (a number
  spelled out in words); the app's filter and the skill rule are primary.

The reviewed gold-stars entry carries these nine operations in this order. The
helper and the plugin still accept the eight-operation entry (ov#350, the CP's
entry until it moves; `rolodex.person` refused under it) and the six-operation
entry from before the restore (meeting, Skylight and person refused under it),
so the overlay can roll out first. The order is one way only: overlay first,
then the catalog (cp#244's drift re-stage then re-stages installed rows); an
older overlay refuses a longer entry and loses every Gold Stars operation.

### Four Kicks: exact manual purchase approval

The first-party `fourkicks` 1.0.0 bundle carries only `fourkicks.menu`,
`fourkicks.schedule`, `fourkicks.order.prepare`, `fourkicks.order.confirm`,
`fourkicks.order.status`, `fourkicks.order.cancel`, in that order, and skill
`["fourkicks"]`. It has no MCP endpoint or credit. Installer, native plugin and
CP catalog must agree on this projection; a partial/reordered/planted operation
list is refused. It is optional, never baseline-installed.

Menu/schedule and own-order status are reads. Prepare obtains a server quote,
not an order. The native plugin saves the successful server-returned full
`approvalPayload` and `payloadHash` in owner-private
`$HERMES_HOME/fourkicks-drafts/<draftId>.json` (0600 files, 0700 directory),
with origin, owner and original conversation turn; it never reconstructs a
preview from model-provided input. A refused quote creates no confirmable draft.
The cache is recovery data, not authority: the app rechecks its immutable draft
and the CP re-reads the daemon's grant. Keep this cache for uncertain-order
recovery; removing it prevents native confirmation of that draft. Uninstall
revokes permission, not the resident's saved order previews.

Show every item/option, total, pickup place/time, payment method and the display
name shared with the café, then wait for a later owner reply. Native confirm
takes only `draftId`; a model-supplied `approval` is refused. The daemon must
propose `marketplace.app.action:fourkicks.order.confirm:<draftId>` over the
unaltered envelope, wait for a direct resident grant, and start that exact
payload with `authorization: grant`. Policy autonomy never purchases coffee.
An already-executed proposal reuses the exact proof for same-draft idempotent
recovery; it does not create a new draft or spend again. Permission is rechecked
after the daemon round trips. Cancel uses the returned `orderId`, not a draft.

Canonical payloads are capped at 60,000 UTF-8 bytes and native HTTP requests
at 64 KiB, including the complete proof. Confirm has a 60-second transport
timeout for the app's CP approval check. The bridge credential file's 2 KiB
limit does not apply to request bodies. Payment links/payee/amount are checked
by the app, never invented by the model. A simulated receipt preserves
`simulated: true` and the exact `Test payment, no money moved` label; never
claim mock funds arrived. Later test-paid notifications use CP's distinct
`fourkicks.paid_test` template.

### Per-app context: `mini-app.context.read` and `mini-app.context.write`

NEW-03 (rc44, P-013): an app whose CP catalog entry carries them may read and
save the owner's notes in **its own** context namespace (`apps.<appId>` on the
CP; private to the resident's agent by default). The app server dispatches
both to the CP namespace routes for the request's appId; the app owns the
`arguments` shape and the CP owns the namespace and its quota.

| Operation | Class | Native call | Plugin path |
| --- | --- | --- | --- |
| `mini-app.context.read` | read (`READ_OPERATIONS`); the gate classes `village` as `marketplace.app.read` | `{"operation":"mini-app.context.read","appId":"dizko","arguments":{}}` | forwarded unchanged, like `mini-app.read`; no gate check, no grant |
| `mini-app.context.write` | write (`WRITE_OPERATIONS`); the approval gate classes the whole `village` tool as `marketplace.app.read`, so no `marketplace.app.action` choice applies (default-open, RP-28: no first-write card) | `{"operation":"mini-app.context.write","appId":"dizko","arguments":{"claims":["Likes late jazz sets"],"mode":"add"}}` | `rolodex.meeting`'s path: gated only by `gate_verified()` (refused, `approval_unavailable`, while the approval gate is off or unverified); never the Gold Stars manual grant; then forwarded unchanged |

Both take exactly `operation`, `appId` and an object `arguments` (no `tool`).
The **app owns the `arguments` shape** (app#349 `context.ts`): a write's
`claims` is a list of plain strings (one line each), `mode` is `add` or
`replace`, and a read takes `{}`; the app refuses any other key (422/400), so
the plugin forwards `arguments` unchanged and checks only that it is an object.
The appId is the request's own (the one `mini-apps.json` was checked for); an
`arguments.appId` naming another app is refused, never forwarded. The agent
saves only when the owner asks.

The plugin (`_mini_apps.py` `APP_OPERATIONS_ACCEPTED`) and the helper accept a
non-Gold-Stars entry whose `operations` equal exactly one of
`["mini-app.read","mini-app.context.read","mini-app.context.write"]` or
`["mini-app.read"]`. Order is fixed; a duplicate, a missing op, a reordered
list or any other operation (`mini-app.context.delete`, `gold-stars.send` on
another app) refuses the whole projection. Gold Stars entries never carry a
context operation. Overlay first, then the CP projects the longer dizko list.

## Disk staging and lifecycle

The baseline installer stages the guarded native plugin and **grants no app**.
It ships the Gold Stars skill text to every box (a baseline skill, inert until
installed) and **does not install Dizko**. The CP writes desired install state durably and
reconciles after baseline install, under its runtime lease and sandbox binding.
Only the pinned local checkout's exact reviewed `SKILL.md` files are copied.

`bun install/install_miniapps.ts` reads this projection from stdin:

```json
{"version":1,"apps":[{"id":"gold-stars","version":"1.1.0","operations":["rolodex.search","gold-stars.quota","gold-stars.prepare","gold-stars.send","gold-stars.status","gold-stars.cancel","rolodex.meeting","skylight.status","rolodex.person"],"skills":["gold-stars"]}]}
```

`HERMES_HOME` selects the disk target. Add `--verify` to check without writing.
Both modes are local filesystem operations: no Hermes CLI, model calls,
network, package hooks, chat, cron or live services. The empty apps list is a
real opt-out; it removes each exact owned skill file and the managed
`village-bridge.json` bearer, not arbitrary directories or resident notes, and
never a skill the installer ships (`gold-stars` keeps its file and loses only its
permission). On a box with no mini-app state (no projection, no bearer, no owned
skill file) the empty list writes nothing at all.
Symlinks at source/target/ancestor paths, path escapes,
unknown versions, extra permissions and duplicate app ids are refused.

Staging atomically publishes an empty projection first (fail closed across an
interrupted change), reconciles only owned files, then atomically publishes the
full installed projection. The receipt is:

```json
{"version":1,"projectionSha256":"<sha256>","files":[{"path":"skills/gold-stars/SKILL.md","sha256":"<sha256>"}],"apps":[{"id":"gold-stars","version":"1.1.0"}],"staged":true}
```

The projection digest covers `JSON.stringify` of the validated projection with
keys `version,apps` and entry keys `id,version,operations,skills`, without a
newline. App order follows CP catalog order. Files have their byte SHA-256.
This is **staging evidence, not proof Hermes loaded the skill**. CP must verify
the restart and observed bytes, then bind applied generation to the same
sandbox. Unpaired or missing runtime stays pending; errors cannot become active.
Credential provisioning separately requires the enabled, gate-ready native
runtime. Removal immediately denies server access and revokes the last app's
bearer even if the old process has not restarted yet.

For deterministic regressions, run the install mini-app tests and native
`plugins/village-bridge/tests` with no real daemon or model. Full rollout
verification remains the integration owner's responsibility.
