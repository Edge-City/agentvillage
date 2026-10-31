# Build a reviewed mini-app

Mini-apps are a **curated catalog of reviewed skill bundles and bounded API
contracts**, not an arbitrary-code upload marketplace. There is no upload
endpoint, package installer, shell hook, custom runtime or automatic approval
of user-supplied MCP URLs. Submit changes for review in this repository and the
control-plane catalog; a manifest in a checkout alone does not publish an app.

**New here?** Read the [developer guide](../docs/MINI-APPS-DEVELOPER.md). It
covers how to get a sandbox, the v2 manifest field by field with one worked
example that passes the validator, how to run the checks before you open a pull
request, what still needs a human and a fleet roll, and what is not built yet.
This file is the reference for the rules and the native contracts below. Adding a generic (public read) app: the one-page [quickstart](../docs/MINI-APPS-QUICKSTART.md). How app actions are approved, the three install tiers and what mini-apps v2 does today: the [last three sections](#approvals-app-actions-run-on-their-own) of this file.
`MINI_APPS_MANIFESTS` is off in production: a manifest in this repo does not
change what a resident sees.

## Start from a working app

Two complete starters are maintained with their real native skills:

| Starter | Manifest | Skill | Backend contract |
| --- | --- | --- | --- |
| Public read-only MCP | [Dizko](dizko/manifest.json) | [SKILL.md](../skills/dizko/SKILL.md) | Seven reviewed public tools, exact input schemas and fixed HTTPS endpoint |
| Approved account action | [Gold Stars](gold-stars/manifest.json) | [SKILL.md](../skills/gold-stars/SKILL.md) | Recipient search, quota, immutable draft, chat confirmation of the exact preview, send/status/cancel; also carries the owner's Rolodex meeting mark/undo and Skylight status read |
| Approved café order | [For Kicks](forkicks/manifest.json) | [SKILL.md](../skills/forkicks/SKILL.md) | Live menu/schedule; immutable prepare → exact resident approval → confirm; validated payment links, own-order status/cancel |

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
2. Add `mini-apps/<app-id>/manifest.json` following the real Dizko manifest,
   and list the id in `mini-apps/catalog.json`. Manifests are **v2**
   (`"manifest": 2`; the closed JSON Schema is
   [manifest.v2.schema.json](manifest.v2.schema.json), validated by
   `scripts/mini-apps-manifests.cjs`, the same module the control plane uses):
   id, name, description, version, homepage, `visibility`, human-readable
   permissions, `service` (`mcp` with `auth.mode: "none"` for a public read
   app, and its reviewed HTTPS `baseUrl`), one op per reviewed tool
   (`<app-id>.<tool>`, `class: "read"`, `target.tool`, and the tool's observed
   JSON input schema as `input`), and `skills` (name, version and the sha256 of
   `skills/<app-id>/SKILL.md`). The control plane serves such an app exactly as
   today: `operations: ["mini-app.read"]` plus its tools (or the reviewed
   context list below, only with a CP namespace review and a `data.context`
   block). `bun test scripts/tests/mini-app-manifests.test.ts` checks it; a
   skill edit changes its sha256, so it is also a manifest edit. Two optional
   booleans mark the catalog entry: `"staff": true` (the app comes with every
   agent and is never removable) and `"listed": false` (kept off every install
   and discovery surface); absent means `false` and `true`, and any other type
   is refused. A `baseUrl`, and an OAuth `resource` and `discovery` (every URL
   the platform fetches), must be canonical (`new URL(s).href === s` exactly, so a bare origin is
   written with its `/`) lower-case ASCII `https://` with no port, userinfo,
   query, fragment, `%` in the host, `xn--` label, backslash or whitespace, and
   name a public DNS host: any IP literal, a single-label name, `localhost` and
   `*.localhost`, `*.internal`, `*.local`, `*.lan`, `*.home.arpa`, `*.intranet`
   and `*.corp` are refused. This static check cannot stop DNS rebinding or a
   public name that resolves to a private address: the fetcher must re-check
   the resolved IP at connect time. A `target.path` has no empty (`//`) or
   dot (`.`, `..`) segment. An `app-token` `secretRef` must be
   `MINI_APP_<ID>_<NAME>` (`-` as `_`, no `_` in NAME); nesting deeper than 64
   is refused; a relay app must have only `read` ops; `service.kind: "none"`
   (no service: a context-only app whose page writes the resident's own
   context namespace, served as `mini-app.read` plus its `data.context`) is a
   first-party grant pinned in the validator, to Mosaic alone, with no
   `baseUrl`, no `auth`, `operations: []` and a `data.context` block, while
   every other kind has at least one op; and each file must be
   canonical JSON (`JSON.stringify(value, null, 2)` plus a newline, so no
   duplicate keys).
   `bun run conformance -- mini-apps/<app-id>/manifest.json --fixtures <dir>
   [--base origin/main] [--out "$TMPDIR/conformance.json"]` (run from the repo
   root) is conformance v0: the manifest, skill hashes and version bump, the
   needs-card to prepare pairing, and the hygiene of your service's response
   fixtures (`<dir>/<operation>/<name>.json`; `error*.json` files are
   `{code, detail}` error bodies; for an MCP service an error fixture may
   instead be the MCP error answer itself, an `isError: true` result with a
   `content` array or a JSON-RPC error with an integer `code` and a string
   `message`, and such a file counts as an error fixture whatever its name;
   a `{code, ...}` it carries must still be exactly `{code, detail}` with a
   closed code). Exit 0 passed, 1 failed, 2 refused. Live-
   service checks come in Phase 1 and show as not run. The summary always goes
   to stdout; conformance.json is written only with `--out`, never by default,
   and `--out` is refused anywhere inside the repo or the tool's root, so point
   it at a temp dir (CI: `--out "$RUNNER_TEMP/conformance.json"`). Arguments
   are checked before any file is touched, and a file already at `--out` must
   be this manifest's own conformance.json (anything else is refused and left
   alone). On any other refusal, only this manifest's conformance.json is
   removed, so read the exit code, not the file. The file is self-attested
   (anyone can write one by hand): never commit it, and CI must regenerate it
   from the PR rather than trust a copy. With `--base`, a base manifest blob
   missing from a partial clone refuses; use a full clone. The header of
   `scripts/mini-apps-conformance.ts` documents every check.
   Exclude profile/account/private-data/purchase/write tools. A service calling
   itself read-only is not sufficient: reviewers must inspect its semantics.
3. Submit the same reviewed definition to the control-plane catalog (Phase 0:
   the cp vendors `mini-apps/` byte for byte and serves it only under
   `MINI_APPS_MANIFESTS=1`; its five reviewed constants stay the default). Update
   `install/install_miniapps.ts`'s reviewed bundle table so only that exact id,
   version, skill and operations can be staged from the pinned overlay checkout.
   No native plugin change is needed for another reviewed public-read MCP app:
   `village` forwards the installed app id/tool/arguments, never an endpoint.
4. Add deterministic tests for schema and tool denial, absent/removed install,
   tenant/owner isolation, source links and error behavior. Run staging and
   verification in a temporary directory; integration verifies runtime loading
   separately. Request review before publication/deployment. No production
   changes follow merely from building the bundle.

**The review bot (v0, advisory).** A pull request that touches `mini-apps/**`
or `skills/**` runs `.github/workflows/mini-apps-review.yml`, the deterministic
half of the PR-review bot. It runs `bun scripts/mini-apps-review.ts --base <sha>
--head <sha> --author <login>` and writes a JSON verdict (`PASS`, `FAIL` or
`NEEDS_HUMAN`) to the job summary and to an artifact. Run the same line
locally before you open the pull request. A pull request that stays inside one
app's `mini-apps/<id>/` and `skills/<id>/` is judged in the wider of that
app's base, base-tip and head `visibility` lane (lowering an app out of
`everyone` takes the human read). Anything else is core and goes to the human
gate, including a new app, listing a new id in `catalog.json`, any baseline
skill (`gold-stars` among them), and an app whose baseUrl host or op target is
another app's. Removing a needs-card op always takes the human read. CI runs
the bot from the base commit's tree with the pull request as data only (git
objects, never checked out or executed). It also reads the base branch's
current tip as data, so a needs-card op that main gained after the fork still
counts. The bot checks:

- the shared validator;
- the skill hash and the version bump;
- secret shapes in the added lines;
- `data.context`;
- the needs-card classes;
- P0-5's conformance suite (the tool's copy, on the head's bytes);
- the one-step visibility rule.

In Phase 0 it is not a required check and it posts no comment. A `FAIL`
turns the job red (exit 1); `NEEDS_HUMAN` exits 0 and stays green.

It must stay non-required until the gate itself changes. Two things stand in
the way:

- A pull request that edits the workflow file still runs its own copy.
- A pull request can add a workflow of its own with the same workflow, job
  and artifact names. A check required by name is then satisfied by a forgery,
  or by a green `NEEDS_HUMAN`.

Real gating needs a ruleset-required workflow pinned to the base
(`pull_request_target` alone is not enough). The verdict must be read from that
run's JSON artifact by run id, never from a check's name or colour.

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
  It proposes the member class `marketplace.app.action.gold-stars.send` (B-133)
  with stable key `marketplace.app.action.gold-stars.send:<draftId>` (the daemon
  requires the key to start with `<class>:`) and payload
  `{appId:"gold-stars",operation:"gold-stars.send",preview:<approvalPayload>}`.
  Compact, recursively sorted UTF-8 JSON is hashed with SHA-256. The daemon's
  registered payload hash must match. The shipped resident policy sets the
  member class autonomous, so the send runs after the owner confirms the exact
  preview in chat, with no approval card: initial execution then requires
  `decision: autonomous` and a successful `start` with `authorization: policy`
  (the daemon-recorded start). A policy that still says manual for the class
  requires `decision: requested`, a fresh successful `wait` reporting `granted`,
  and a successful `start` with `authorization: grant`. The only action
  proposed under the parent class `marketplace.app.action` is the For Kicks payment, which asks (below); every other app action runs on its own ([Approvals](#approvals-app-actions-run-on-their-own)). Model booleans and
  unavailable authority never authorize it.
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
uses its own member-class action proposal (above). Matchers alone are not the
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

### For Kicks: exact manual purchase approval

The first-party `forkicks` 1.0.0 bundle carries only `forkicks.menu`,
`forkicks.schedule`, `forkicks.order.prepare`, `forkicks.order.confirm`,
`forkicks.order.status`, `forkicks.order.cancel`, in that order, and skill
`["forkicks"]`. It has no MCP endpoint or credit. Installer, native plugin and
CP catalog must agree on this projection; a partial/reordered/planted operation
list is refused. The overlay's baseline installer never installs it; it is a default app, removable ([install tier 2](#install-tiers)).

Menu/schedule and own-order status are reads. Prepare obtains a server quote,
not an order. The native plugin saves the successful server-returned full
`approvalPayload` and `payloadHash` in owner-private
`$HERMES_HOME/forkicks-drafts/<draftId>.json` (0600 files, 0700 directory),
with origin, owner and original conversation turn; it never reconstructs a
preview from model-provided input. A refused quote creates no confirmable draft.
The cache is recovery data, not authority: the app rechecks its immutable draft
and the CP re-reads the daemon's grant. Keep this cache for uncertain-order
recovery; removing it prevents native confirmation of that draft. Uninstall
revokes permission, not the resident's saved order previews.

Show every item/option, total, pickup place/time, payment method and the display
name shared with the café, then wait for a later owner reply. Native confirm
takes only `draftId`; a model-supplied `approval` is refused. The daemon must
propose `marketplace.app.action:forkicks.order.confirm:<draftId>` (the parent class today; ov#457 moves it to the member class `marketplace.app.action.forkicks.order.confirm` in v2.1.13, and the cp already accepts both keys, cp#351) over the
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
`forkicks.paid_test` template.

#### On-request menu board attachments

The same installed **read** operation `forkicks.menu` accepts optional
`format: "image"` and `theme: "forkicks" | "chalk" | "paper"` (theme requires image
format; default forkicks, the café's own menu design; chalk and paper are earlier
concepts, paper provisional). Omitting format leaves the text call unchanged.
No operation, install projection, bundle version, CP sender or purchase gate changes.
AV uses its existing merchant bearer for `GET /api/agent/menu-image`, forwarding
date/location filters and theme. The exact response is
`{kind:"forkicks-menu-image",revision,theme,provisional,menu,pages}` with pages
`{mimeType:"image/png",filename,width,height,altText,base64}`. The full canonical
menu snapshot and page alternatives carry the same revision; no public asset URL.

Both bridge and native client enforce bounded envelopes: 24 MiB JSON, at most
12 pages, 4 MiB PNG per page, 16 MiB decoded total, dimensions at most 4096 each
and 12 million pixels. Unknown keys, duplicate filenames, malformed base64,
wrong MIME/signature/IHDR dimensions or theme are refused. Native additionally
checks every PNG chunk boundary and CRC before writing any page. Excess menus
fail explicitly rather than truncating or shrinking text. A media failure
returns `forkicks_menu_image_unavailable` and current text where available,
otherwise explicitly offers the text menu read; never claims an image was sent.

The native plugin writes 0600 files inside private 0700 request directories in
`$HERMES_HOME/cache/images/forkicks/`, opening each cache component without
following symlinks and ignoring merchant filenames for filesystem paths.
This is a fresh render per request, not a stale poster cache. Files remain local
until cache cleanup; this feature adds no retention timer. Uninstall revokes
future reads, not prior files.
No private merchant bearer or browser/session token reaches the returned text.
Success returns **raw** `MEDIA:"<absolute PNG path>"` lines plus accessible text;
the skill instructs the agent to repeat all lines verbatim in its final reply.

Transport evidence: actual Hermes source at local runtime pin
[`118984d7a02f8a8baec11255002cbbab7c202e06`](https://github.com/NousResearch/hermes-agent/tree/118984d7a02f8a8baec11255002cbbab7c202e06),
`gateway/platforms/base.py:3023–3082` masks markers inside JSON string values
and parses raw lines; `:674–679` allows the cache image root; `:4002–4038`
dispatches images and reports failed attachments; `:4162–4175` extracts final
response media. `gateway/run.py:1313–1410` auto-appends only speech/image-generation
producer results, **not village**, so tool success alone is not a delivery receipt.
The reviewed v2026.9.24 tag has the same convention. No Telegram send is added.

Opt-in isolated local fixture smoke, run only after preview integration:

```sh
python3 scripts/forkicks-menu-media-smoke.py \
  --fixture-home "$HOME/.local/state/sdj/agentvillage-local/fake-agents/8b3aa9f5-79f4-4a1e-adcc-3ed800c1c105/.hermes" \
  --origin https://jmill-desktop.tail587341.ts.net:8472 \
  --theme forkicks --evidence-dir /absolute/private/evidence/forkicks
```

Repeat with chalk and paper, each with a distinct evidence directory. It copies only the fixture
credential/install projection into a temporary `HERMES_HOME`, changes the origin
only in that copy (native HTTP remains forbidden), binds an explicit simulated
private-owner session, and calls the actual native handler/HTTPS transport to
the existing AV preview and configured merchant. It asserts raw attachment
extraction, real private PNG bytes and the JSON-string masking regression.
Without `--hermes-source`, it downloads the pinned source above, records its
SHA-256, and AST-executes the exact PNG extraction methods/helpers: this is
**source-derived parser proof, not a running Hermes or full path-policy proof**.
With a prepared Hermes checkout/dependencies, pass `--hermes-source /opt/hermes`
to import the actual runtime parser and validate media path policy too.
Neither mode starts a model, gateway, Telegram sender, order or payment.

Preview integration: AV's declared frontend is `wt-mini-apps-canary` on :8472,
local CP/tools are `wt-mini-apps-canary-runtime/control-plane` and
`wt-mini-apps-canary-tools`, merchant preview is the separate For Kicks service
on :8478. Integrate app feature changes into the existing local preview branch,
overlay plugin/skill into its tools preview, and canonical renderer into the
merchant preview; use each declared service lifecycle, not an ad hoc server.
Re-stage the existing installed skill through mini-app reconciliation and reload
the managed agent plugin normally. Do not merge/push main or promote production.
The local fake CP has no model/Hermes Telegram receipt; the smoke cannot prove
model forwarding or Telegram acceptance. Unit entry points:
`pytest plugins/village-bridge/tests/test_forkicks_media.py` (optional real parser
half with `HERMES_AGENT_SRC`) and AV's `forkicks.test.ts` Vitest suite.


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

## zzz.bot: connected rooms and posts

The [reviewed manifest](zzzbot/manifest.json) and the native bundle allowlist
(`_mini_apps.py` `ZZZBOT`, exact equality, in this order) expose exactly
`zzz.list_rooms`, `zzz.read_thread`, `zzz.changes`, `zzz.reply`,
`zzz.create_thread`, `zzz.tag_thread` and `zzz.edit_post` (1.1.0; the last two
edit only the agent's own posts and topics), never an arbitrary MCP call,
`set_thread_state` or `doctor`; `mini-app.read` refuses `zzzbot`. The five of
1.0.0 stay accepted until the CP serves 1.1.0 (overlay first). Each resident connects their own
zzz.bot account in the Mini-apps sheet (OAuth 2.1 + PKCE, held by the app
server); the box never sees a token, endpoint or account id. The CP lists
zzz.bot only for tenants in `MINI_APPS_TENANT_ALLOWLIST`.

Input rides the existing `arguments` object, so the every-box `village` schema
(description and properties) is unchanged. Since v2.1.5 the five operation
names are in the every-box enum, like For Kicks' and Slopfolio's, and
`installed()` decides per call (`mini_app_not_installed` without the zzzbot
install). Before, they joined the enum only at registration on a box that
installed zzzbot, which a chat already open never saw: Hermes keeps a
continuing chat's saved tools. Ids match `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`, cursors are
decimal strings, `limit` is 1–25 (`zzz.read_thread`) or 1–50 (`zzz.changes`),
a `body` is 1–8,000 characters and at most 16,000 UTF-8 bytes, a `title` 1–200
characters. Anything else is refused before transport.

The two writes are posts as the owner's connected zzz.bot agent. The private-only
AV OAuth client on ZZZ excludes Public. They
need the box's verified approval gate (`gate_verified`, the
`mini-app.context.write` path) but no manual grant; zzz.bot's room rules and
moderation apply. The overlay adds `turnId` from the trusted session and
message, never model input, and sends `X-Village-Operation` so the app admits
the larger post body. All returned strings and keys pass through
`scrubbed_tree`/`visible` and are framed as untrusted reference data. zzz.bot's
error codes map to zzz-only instructions; no Gold Star or meeting wording.

Overlay first: the CP must not project zzzbot to a box below the overlay roll
that carries this entry (v2.1.3), since an older box refuses the whole
projection, Gold Stars included. See [zzzbot/README.md](zzzbot/README.md).

The feature-gated `zzz.pairs` read borrows `zzz.list_rooms` installedness and
returns current enabled private-pair room IDs plus request/consent epoch. It
does not add a CP catalog operation. The mini-app helper installs the
Hermes-managed `Edge — zzz pairs` job only when the strict CP projection has
both `zzzbot` and the separate empty-operation `zzz-bridge` entry (a cp catalog/allowlist entry granted per tenant at activation, like Mosaic; no overlay constant or environment variable turns it on, and an unreadable or malformed projection is off). A zzzbot
install by itself stages only the ordinary interactive skill: no job, shim,
state directory or poll. Removing either entry revokes native access at once;
the helper removes the job, shim and cursor state. It removes only what was
written for it: a regular file whose bytes are a version the installer shipped
(the shim, `participate.md`) or the plugin's own state file; anything else at
those names (a resident's file, a symlink, a directory, a FIFO) is left in place
and never starts a teardown. If teardown fails after
authority disappears, `zzz_job_*` is an operator alert and the next reconcile
retries removal. Its pre-run
script keeps only per-pair cursors/IDs and wakes the agent for one exact new
post when app-supplied `isOwn:false` proves it came from another agent. A
revoked/re-paired room loses its pending reply and cursor scope. The cron root
can use only pairs/changes/read_thread/reply/create_thread through the native tool;
replies are exact-thread reservations and an empty newly enabled pair can receive
one fixed introduction per epoch. All writes share a two-per-UTC-day budget. The job does not
deliver pair content to the resident or copy it into other surfaces.

## DreamStarter: dreams, the grant draft, Goa's local businesses

The [v2 manifest](dreamstarter/manifest.json) and the native bundle allowlist
(`_mini_apps.py` `DREAMSTARTER`, exact equality, in this order) expose nine
named operations, each mapped by the app to one DreamStarter MCP tool: seven
reads (`dreamstarter.dream_status`, `.workflows`, `.grant_requirements`,
`.grant_status`, `.businesses`, `.business_brief`, `.business_status`) and two
owner-asked writes, `dreamstarter.discover` (the lines the owner types for that
request; DreamStarter passes them to Google Gemini and keeps only the
suggestions, never the lines) and `dreamstarter.grant_prepare` (the owner's confirmed
application answers, a private 14-day draft that DreamStarter submits to
ElevenLabs' live form only when the owner clicks Submit on its review page).
`mini-app.read` refuses `dreamstarter`.

The bundle is the DreamStarter team's
([PR #393](https://github.com/Edge-City/agentvillage/pull/393), arrfire),
adapted from a generic read relay to a reviewed app because those two
operations send the owner's own words. The service is `app-token`: the app
server holds one key (`MINI_APP_DREAMSTARTER_KEY`) and sends no resident
identity. Input rides the existing `arguments` object and is checked in
`plugins/village-bridge/_dreamstarter.py` against DreamStarter's published
schemas; a discovery call holding an email address or a phone number is refused
before transport. Both writes take the verified gate (`gate_verified`, zzz's
path), no card and no manual grant, and carry the trusted `turnId`; the skill
shows exactly what will be sent and waits for the owner's yes. Results are
scrubbed and framed as untrusted.

Overlay first, then the CP catalog row and sandbox allowlist, then the app
routes, then Edge City staff set `MINI_APP_DREAMSTARTER_KEY`. The app-server
contract is in [dreamstarter/README.md](dreamstarter/README.md).

## Edge Library: the village knowledge graph (reads only)

Adapted from Naman's bundle (Edge-City/agentvillage#506). Version 1.0.0 is
READS ONLY (Carter, CD-44). The [v2 manifest](library/manifest.json) and the
native bundle allowlist (`_mini_apps.py` `LIBRARY`, exact equality, in this
order) expose eight named reads, each mapped by the app to one Edge Library
MCP tool: `library.initialize`, `.search`, `.get`, `.source`, `.schema`,
`.history`, `.changes_since` and `.proposals`. Edge Library's three writes
(`library_submit_source`, `library_write`, `library_propose`) are not exposed:
no operation, schema entry or tool reaches them. `mini-app.read` refuses
`library`. The reads join the existing read class: no new class, row, gate or
card.

There is no per-resident sign-in. The service is `app-token`: the app server
holds one token for Edge Library (`MINI_APP_LIBRARY_KEY`, by `secretRef`) and,
through the generic dispatcher, sends `X-Village-Subject`: the app's private,
stable, per-app reference for the owner (the existing `subject` separation
mode, as Kismet's). Never a Telegram id or username, never from the box, and
only for a resident who installed `library`, only to the manifest's origin.
Edge Library acts as its Agent Village agent on behalf of that resident, with
a member's role (a read never creates a member entry; 60 tool calls a minute
per resident). The id is `library` because the
validator reserves `edge-`.

Input rides the existing `arguments` object and is checked in
`plugins/village-bridge/_library.py` against Edge Library's own tool schemas
(the manifest's `input` schemas say the same): exact keys, uuids, bounds and the
4 KiB request budget. A key naming a resident (a Telegram id or username, a
user, resident or subject id) at any depth is refused. Anything else is
`invalid_library_arguments` before transport. Every operation is framed
(`X-Village-Operation`). Every answer is scrubbed (hidden characters become
spaces of the same UTF-16 length, so Edge Library's JavaScript-string offsets
hold) and framed as untrusted with `handling`; the app's closed `mini_app_*`
codes and Edge Library's own tool codes map to Edge Library-only text, for
these operations only.

Overlay tag first, then the one cp switch PR (vendored manifest, reviewed id,
catalog row `restricted`) deployed before that tag's roll, then the app half
(the `subject` separation entry and the vendored manifest), then Edge City staff
set `MINI_APP_LIBRARY_KEY` on the app service. The app-server contract and the
prerequisites are in [library/README.md](library/README.md).

## Favor Loop: loops of 15-minute favors

By Bilgin Kocak (Edge-City/agentvillage#556). The [v2 manifest](favorloop/manifest.json)
and the native bundle allowlist (`_mini_apps.py` `FAVORLOOP`, exact equality, in
the manifest's order) expose eight named operations, each mapped by the app to
one Favor Loop MCP tool: three public reads (`favorloop.how_it_works`, `.menu`,
`.board`), the owner's own read (`.my_loops`) and four owner writes (`.join`,
`.answer`, `.confirm`, `.leave`). `mini-app.read` refuses `favorloop`. The reads
join the existing read class; the writes take the existing gated-write path
(`gate_verified()`, as `mini-app.context.write`): no new class, row, gate, card or
stage-then-send.

The service is `app-token`: the app server holds one token for Favor Loop
(`MINI_APP_FAVORLOOP_KEY`, by `secretRef`) and, for the five private tools, sends
`X-Village-Subject` (the `subject` separation mode, as Kismet's and Edge
Library's). Never a Telegram id or username, never from the box.

Input rides the existing `arguments` object and is checked in
`plugins/village-bridge/_favorloop.py` against the manifest's `input` schemas
(exact keys, the closed favor and slot lists, the loopId and handle patterns,
the 4 KiB request budget). A key naming a resident (a Telegram id or username,
a user, resident or subject id) at any depth is refused. Anything else is
`invalid_favorloop_arguments` before transport. Every operation is framed
(`X-Village-Operation`); every answer is scrubbed and framed as untrusted with
`handling`; the app's closed `mini_app_*` codes and Favor Loop's own tool codes
map to Favor Loop-only text, for these operations only.

The manifest says `sandbox`, so the cp serves it restricted (allowlisted tenants
only), and only to a box at or after the overlay release that reviews it (the
cp's `FAVORLOOP_FLOOR_TAG`). Overlay tag and roll first, then the cp row, then the
app half (the `subject` separation entry and the vendored manifest), then Edge
City staff set `MINI_APP_FAVORLOOP_KEY` on the app service. The contract is in
[favorloop/README.md](favorloop/README.md).

## Edge City Volunteers: a volunteer's own schedule

The [v2 manifest](eci-volunteers/manifest.json) and the native bundle
allowlist (`_mini_apps.py` `ECI_VOLUNTEERS`, exact equality, in this order)
expose twelve named operations, each mapped by the app to one ECV volunteer MCP
tool: nine reads (`eci-volunteers.initialize`, `.guide`, `.my_hours`,
`.my_shifts`, `.get_shift`, `.plan_view`, `.open_shifts`, `.my_requests`,
`.move_targets`), `eci-volunteers.propose` (ECV's check: a summary and a code,
nothing changes) and two writes, `eci-volunteers.confirm` and
`eci-volunteers.link`. `mini-app.read` refuses `eci-volunteers`. The id is
`eci-volunteers` because the validator reserves `edge-`.

Identity is Favor Loop's (lead RULING L35456): the service is `app-token`
(`MINI_APP_ECI_VOLUNTEERS_TOKEN`) with the app's `subject` separation, so every
call carries `X-Village-Subject`, an opaque per-app reference, and never a
Telegram id or username. ECV links that reference to a volunteer once: the
owner sends `/agentvillage` to the Edge City Volunteers bot, which replies with a
one-time 8-character code, and the agent sends it with `eci-volunteers.link`.
Until then every operation answers `not_connected`.

Input rides the existing `arguments` object and is checked in
`plugins/village-bridge/_ecv.py` against ECV's published volunteer schemas (the
manifest's `input` schemas say the same): exact keys, ECV's uuid/date/time
patterns and ranges, the link-code pattern, and only the seven volunteer actions
(at most three changes under one yes). Any key naming a resident is refused at
any depth. Anything else is `invalid_ecv_arguments` before transport.

The confirm rule is on the box (the Kismet shown-date pattern): the overlay
remembers the sha256 of each code a propose answer showed (never the code), and
sends `eci-volunteers.confirm` only for such a code, in the same conversation, in
a later owner message, within 15 minutes; otherwise it answers
`eci_volunteers_confirmation_required`, `eci_volunteers_proposal_unknown` or
`eci_volunteers_proposal_expired` and sends nothing. A propose carries no
`turnId` (it is a read); confirm's `turnId`, the app's Idempotency-Key, is fixed
per code. Both writes need the verified gate (`gate_verified`, zzz's path), no
manual grant, card or class of their own. Results are scrubbed and framed as
untrusted; v2's generic codes map to ECV-only text, for these operations only.

`confirm` is a `write`, not `needs-card`: the volunteer's own reversible
scheduling change, not a payment. Overlay first, then the CP catalog row
(restricted, at its own release floor), then the app's vendored manifest and
`subject` declaration, then staff set `MINI_APP_ECI_VOLUNTEERS_TOKEN`. The ECV
contract is in [eci-volunteers/README.md](eci-volunteers/README.md).

## Slopfolio: connected private drafts

The [reviewed manifest](slopfolio/manifest.json) and native bundle allowlist
expose exactly `slopfolio.prepare` and `slopfolio.status`, never an arbitrary
MCP call or `publish_slopfolio_post`. Both require the installed app and the
paired owner's private root Telegram conversation. Preparing a private draft
and reading status do not request a manual approval tap. Publishing is solely
the resident's action on Slopfolio at the returned `reviewUrl`.

Prepare accepts only `draftId`, `paste`, `artifactUrl`, `medium` and `fixes`
(`title`, `oneLiner`, `tools`, `iterations`, `howItWasMade`, `bestDeadEnd`,
`promptingApproach`, `tags`). Every prepare, including a fixes-only revision,
requires the exact original or corrected nonempty `paste` (at most 100,000
UTF-8 bytes). The app always sends complete capture metadata plus `raw`; it never
sends null or metadata-only capture. Omission preserves supplement/override fields,
and explicit null clears an individual field; the `fixes` object itself cannot be
null. `draftId` must be the returned lowercase v1–5 UUID; omit/null creates a new
draft. `medium` is `code`, `image`, `video`, `audio`, `workflow`, or null.
`iterations` is `one_shot`, `a_few_tries`, `many_attempts`, or null, never a count.
Text limits are 100 characters for `title`, 200 for `oneLiner`, 20,000 for
`howItWasMade`/`promptingApproach`, and 10,000 for `bestDeadEnd`. `tools`/`tags`
allow at most 16 strings of at most 80 characters each. `artifactUrl` must be
credential-free HTTPS, at most 2,048 characters. The complete compact UTF-8
prepare payload, including trusted metadata and JSON escaping, must not exceed
256 KiB; oversize input is refused before transport, not truncated.
Only prepare transport adds `X-Village-Operation: slopfolio.prepare`, allowing
the app's bounded large-body parser; status and other operations retain the
small-body path.

The overlay adds `turnId` from trusted session/message context, never model
input. Retries in that turn retain the same identity; later turns differ.
Status accepts only the exact returned lowercase v1–5 UUID `draftId`.
The app server derives operation ids, checks that existing drafts are owned
private drafts before revision, owns OAuth and refresh, validates the upstream
contract and performs the two reviewed MCP operations. Models cannot supply
a turn id, token, endpoint, account id or tool name. Both operations' returned
strings and keys pass through the bridge's recursive `scrubbed_tree`/`visible`
sanitizer (including hidden/bidi characters and controls) and remain explicitly
untrusted reference data, never instructions.
The app accepts the live provider's operation-specific outcome-code enums,
including status `STATUS`; a status error may omit `status`, but a `STATUS`
success must include a reviewed state. `missing` is a list of
`title`/`one_liner`/`artifact_url`/`medium`/`tools`. `findings`/`warnings` contain
strict `{code, message, severity}` objects (code 1–80 characters, message 1–240,
severity `block` or `warn`), with a local safety cap of 20 items per list.

`DRAFT_NOT_EDITABLE` and `DRAFT_NOT_FOUND` are known terminal bridge errors,
returned as errors rather than success data with `retryable: false`. Do not retry
that `draftId`: the former means the post is already published or deleted, so
start a new draft instead; the latter means no draft with that id on your account.
The app retains the draft-status preflight as defence in depth, while Slopfolio
enforces the published/deleted rejection in its database: it changes nothing,
never edits a live post and never forks a new draft from that call. Only prepare
without `draftId` creates a new post.
`CAPABILITY_NOT_GRANTED` and `RATE_LIMITED` are also preserved as named errors
without provider text: reconnect through Mini-apps for the former, and try later
or use the manual Slopfolio page for the latter rather than retrying immediately.

The provider-authored skill and manifest from
[PR #389](https://github.com/Edge-City/agentvillage/pull/389) are integrated here.
The installer stages `skills/slopfolio/SKILL.md` byte for byte only from the validated
installed projection, with parity coverage against the catalog and standalone skills
mirror. Slopfolio is not a baseline skill and remains tenant-restricted in the CP;
see the control-plane README rollout configuration. The provider guide's retry and
authority wording remains subject to the integration review on #389.

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
{"version":1,"projectionSha256":"<sha256>","files":[{"path":"skills/gold-stars/SKILL.md","sha256":"<sha256>"}],"apps":[{"id":"gold-stars","version":"1.1.0"}],"staged":true,"skills":{"offer":null,"served":[],"fallback":[]}}
```

**Skill delivery (v2 Phase 2; the cp's `MINI_APPS_SKILL_DELIVERY`, default off).**
The cp may hand the installer each app's reviewed `SKILL.md` beside the projection,
in two environment variables on the installer process: `MINI_APPS_SKILLS_OFFER`
(a 64-hex digest, echoed as `skills.offer`) and `MINI_APPS_SKILLS`
(`{"version":1,"skills":[{"id","sha256","bytes":<base64>}]}`, at most 96 KiB).
The projection on stdin, `mini-apps.json` and the plugin's `installed()` check are
unchanged, and an older installer ignores both variables.
- An app's served bytes are written only when they are strict base64, at most 32 KiB,
  UTF-8, and hash to the entry's `sha256`. The cp offers only bytes whose hash equals
  the validated manifest's `skills[0].sha256`.
- Any failure falls back to this checkout's copy for that app alone, with a code in
  `skills.fallback`: `mini_apps_skill_hash_mismatch`, `mini_apps_skill_oversize`,
  `mini_apps_skill_not_utf8` or `mini_apps_skill_invalid_entry`. A bad bundle falls
  back for every app (`mini_apps_skill_bundle_invalid`). A skill problem never fails
  the stage, so Gold Stars and the other apps stay installed.
- The installer fetches nothing and opens no path the cp names.

The projection digest covers `JSON.stringify` of the validated projection with
keys `version,apps` and entry keys `id,version,operations,skills`, without a
newline. App order follows CP catalog order. Files have their byte SHA-256.
This is **staging evidence, not proof Hermes loaded the skill**. CP must verify
the restart and observed bytes, then bind applied generation to the same
sandbox. Unpaired or missing runtime stays pending; errors cannot become active.
Credential provisioning separately requires the enabled, gate-ready native
runtime. Removal immediately denies server access and revokes the last app's
bearer even if the old process has not restarted yet.

**Open chats (v2.1.5, MINIAPP-PICKUP).** An install or removal reaches a chat
that is already open at its next turn, without `/new`: every new prompt
carries a `Mini-apps epoch` stamp (a hash of the installed entries and their
SKILL.md bytes), and av-events rebuilds a session's prompt once when the stamp
no longer matches the projection on disk (`plugins/av-events/README.md`,
"Mini-app pick-up"). The `village` enum names every reviewed operation on
every box, so a chat's saved tools need no refresh either.

For deterministic regressions, run the install mini-app tests and native
`plugins/village-bridge/tests` with no real daemon or model. Full rollout
verification remains the integration owner's responsibility.

## Approvals: app actions run on their own

The full rules, with their sources, are the developer guide's
[section 7](../docs/MINI-APPS-DEVELOPER.md#7-approvals-what-your-apps-actions-feel-like).
In short:

- **App actions run on their own by default.** Reads, writes and context lines
  already do (the `village` tool reaches the policy as `marketplace.app.read`,
  autonomous), and so does a Gold Star send (its member row, above). The parent
  row `marketplace.app.action` still asks today; the only partner action that
  reaches it is the For Kicks checkout, which is meant to ask. It turns
  autonomous, and the setting's label ("Act through an installed app") with it,
  once For Kicks moves to its own member row (v2.1.13). A developer never adds
  a class, a row or a gate.
- **Only a payment shows a card, and that card is first-class.** Today exactly
  one partner action is gated: a payment, the For Kicks checkout
  (`forkicks.order.confirm`). Its card arrives fast and is a simplified friendly
  card of four plain strings; the loop closes in the resident's own chat with a
  fixed line once the order is placed, and the resident is never asked to
  confirm again in chat ([For Kicks](#for-kicks-exact-manual-purchase-approval)).
  The ONE generic card a later `needs-card` op will reuse keeps that shape:
  four strings shown as What, Total, When & where and Shared with (dark today,
  see below).
- **How we gate more later.** If Edge City later needs to gate a specific
  action, or wants finer-grained approval for one, it does so the same way as
  the For Kicks payment: by pinning that exact operation with a member row,
  which the platform then proposes that operation under (the row alone changes
  nothing). Edge City decides that, not the developer, and the default for
  everything else stays on its own. Your part: mark a genuinely payment-like
  operation `needs-card` in the manifest, and Edge City reviews it.
- **A generic app never shows a card.** In v2 a generic app is public reads
  plus its own context namespace, so nothing it does is gated.

## Install tiers

Every catalog app is in one of three tiers (developer guide
[section 9](../docs/MINI-APPS-DEVELOPER.md#9-install-tiers) has the detail):

1. **Core**: `"staff": true`. The app comes with every agent and is never
   removable. Platform apps: Gold Stars today, and the coming approval.md
   mini-app.
2. **Default**: installed for every agent, removable; an uninstall is
   respected and the app is never installed again over it. Mosaic and For
   Kicks. Until the flag exists, a one-time backfill run after the v2.1.12
   roll installs them for paired residents in the mini-apps cohort who have not uninstalled them; the catalog flag for this
   tier, `"default": true` beside `"staff"`, is v2.1.13 scope and is not in the
   manifest schema yet (the schema is closed, so it is refused today).
3. **Optional**: the resident installs it from the catalog. Every other app,
   and every generic app.

## Mini-apps v2 today

The developer guide's
[section 8](../docs/MINI-APPS-DEVELOPER.md#8-mini-apps-v2-today-what-works-what-ships-dark-what-needs-a-roll)
has the table. In short (v2.1.12 is the overlay tag of 22 Oct, v2.1.13 the
next):

- **Works on a box at v2.1.12:** a generic read app, a public MCP read relay
  (`service.kind` `mcp`, `auth.mode` `none`, every op `read`), taken from the
  control plane's pinned catalog with a sha256-bound SKILL.md (ov#455, ov#460).
  The cp half (cp#337) is open and dark, and no generic app enters the cp
  catalog before the v2.1.12 roll covers the whole fleet. How to add one: the
  [quickstart](../docs/MINI-APPS-QUICKSTART.md).
- **Ships dark:** the Phase 1 generic dispatcher (app#532) and generic OAuth
  (app#534) in the app server, and the generic approval card (ov#458 on the
  overlay, cp#352 open on the control plane).
- **Needs a roll:** the generic card needs v2.1.13 on the fleet, the box
  installer passing a projection entry's `approval` through, and the cp's card
  floor (`CARD_FLOOR_TAG`) before any card app can land. For Kicks proposing
  its own member row (ov#457) also rides v2.1.13.
- **Mini-apps v3:** token, OAuth and write partner apps, with per-app
  app-server code.
