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
| Approved account action | [Gold Stars](gold-stars/manifest.json) | [SKILL.md](../skills/gold-stars/SKILL.md) | Recipient search, quota, immutable draft, manual approval, send/status/cancel |

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
   `skills: ["<app-id>"]` and `operations: ["mini-app.read"]`. Pin a reviewed
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
The policy records read/staging under `marketplace.app.read`; actual effects
use the separate internal manual action proposal. Matchers alone are not the
write gate. Gold Stars grants neither meeting changes nor Skylight access.

## Disk staging and lifecycle

The baseline installer stages the guarded native plugin but **does not install
Gold Stars or Dizko skills**. The CP writes desired install state durably and
reconciles after baseline install, under its runtime lease and sandbox binding.
Only the pinned local checkout's exact reviewed `SKILL.md` files are copied.

`bun install/install_miniapps.ts` reads this projection from stdin:

```json
{"version":1,"apps":[{"id":"gold-stars","version":"1.1.0","operations":["rolodex.search","gold-stars.quota","gold-stars.prepare","gold-stars.send","gold-stars.status","gold-stars.cancel"],"skills":["gold-stars"]}]}
```

`HERMES_HOME` selects the disk target. Add `--verify` to check without writing.
Both modes are local filesystem operations: no Hermes CLI, model calls,
network, package hooks, chat, cron or live services. The empty apps list is a
real opt-out; it removes each exact owned skill file and the managed
`village-bridge.json` bearer, not arbitrary directories or resident notes.
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
