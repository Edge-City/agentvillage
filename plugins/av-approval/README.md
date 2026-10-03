# av-approval (Hermes backend plugin, opt-in)

The receipts half of approval.md for Agent Village (DATA-43; approval-md-hosted
`docs/03` section 3.3). Enabled by `install/install_approval.ts` for a tenant
with `AV_APPROVAL_ENABLED=1`, and left enabled when the switch is later turned
off (see Kill switch). The gate is not here: it is the shell-hook
shim the `skills/approval` step installs. This plugin decides nothing.

## Status: a documented stub

`register(ctx)` registers **no hook** and makes **no request**. It logs one of
two lines, once per process:

| `AV_APPROVAL_ENABLED` | Log line |
|---|---|
| `1/true/yes/on` | `av-approval: receipts disabled (no facade receipt surface at approval-md 6b74ca72)` |
| anything else | `av-approval: disabled (fail-open)` |

### Why a stub

docs/03 wants `post_tool_call` to post a receipt (tool, outcome, execution
token id) so the daemon closes the `execution.started` record and AV gets
`action.receipted` / `action.failed` rows. At approval-md core 6b74ca72 the
facade (`approval serve`) has no receipt endpoint; the agent credential
reaches only the catalog, `POST /hook/<harness>` and five verbs. A
`post_tool_call` envelope sent to `/hook/hermes` reaches the core's post half,
but the post half joins on a top-level `tool_use_id` (and reads
`tool_response`), while Hermes sends the call id as `extra.tool_call_id` and
the result as `extra.result`. The pre half mints a random task id for every
Hermes call, so a receipt can never be joined and the post half appends
nothing. The plugin does not send traffic that cannot record anything, and it
does not emit `action.*` events itself (that would duplicate av-events and
make the sandbox the source of a decision record).

What closes the gap, in order:

1. **DATA-43b** (the ingest follower) derives receipts from the daemon log.
2. A core change reading Hermes's `extra.tool_call_id` (and `extra.result`)
   in the hermes adapter; then this plugin's `post_tool_call` posts the
   Hermes post envelope to `/hook/hermes`, in a background worker so the agent
   loop is never held, and never raises.

## Kill switch

The fail-open line tracks the gate, not the plugin. It is logged once per process:

| `AV_APPROVAL_ENABLED` | `config.yaml` runs the shim | Log line |
|---|---|---|
| unset or blank | any | nothing (never opted in) |
| `1/true/yes/on` | any | `av-approval: receipts disabled (…)` |
| anything else | no (or unreadable) | `av-approval: disabled (fail-open)` |
| anything else | yes | `av-approval: AV_APPROVAL_ENABLED is off but config.yaml still runs the approval shim; …` |

The installer's kill switch removes the entries and keeps this plugin listed. So once the gate is really gone, every gateway start logs the fail-open line. This plugin belongs to a gate, so unlike `av-events` the gap is a fail-open event (AV spec section 7.1). At this version the gate does not depend on the plugin.

## Tests

`python3 -m pytest plugins/av-approval/tests` (listed in `pytest.ini`). A fake
facade (`http.server` on loopback) proves the plugin sends nothing in either
state, registers no hook, logs each line once and only in the right gate state, and never raises.
