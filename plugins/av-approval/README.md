# av-approval (Hermes backend plugin, opt-in)

The approval gate's fail-closed backstop at every gateway start (DATA-234),
and the receipts half of approval.md for Agent Village (DATA-43;
approval-md-hosted `docs/03` section 3.3), still a stub. Enabled by
`install/install_approval.ts` for a tenant with `AV_APPROVAL_ENABLED=1`, and
left enabled when the switch is later turned off (see Kill switch). The gate
itself is the shell-hook shim the `skills/approval` step installs; this plugin
decides nothing about a call, it only refuses gated calls while the gate
cannot be verified.

## The backstop (enforced-on mode only)

Hermes loads plugins before it registers shell hooks (gateway/run_startup.py
`_start_register_plugins_relay_hooks` at v2026.9.24), so `register(ctx)` sees
the gate as Hermes is about to. It checks, without reading the agent token:

- `config.yaml`: an entry running `$HERMES_HOME/agent-hooks/hermes-hook-shim.sh`
  for every gated matcher (`GATED_MATCHERS`, the installer's list), each
  `fail_closed: true` and `timeout: 300`, and `hooks_auto_accept` on;
- `.env` assigns `HERMES_ACCEPT_HOOKS=1` (only that line is matched) and the
  process environment has it;
- `shell-hooks-allowlist.json` and `.lock`: absent, or regular files of this
  uid it can read (the lock: read and write); an absent lock needs a writable
  home (Hermes's `open("a+")` would raise, the gateway would swallow it, and no
  hook would register);
- the shim present, executable, and its sha256 equal to `shim_sha256` in
  `agent-hooks/approval-surface.json` (written by the installer);
- `AV_APPROVAL_URL` set.

It then registers one `pre_tool_call` callback. For a tool a gated matcher
full-matches, while the check fails, the callback raises
`GateUnverified("av-approval: gate unverified (<code>)")`; Hermes's
`invoke_hook` turns a raising `pre_tool_call` callback into a block directive
(`hermes_cli/plugins_dispatch.py`, `_policy_error_block_directive`), so the
call does not run. Any other tool returns `None` at once. A failure found at
start is sticky for the process (only a restart re-registers shell hooks); a
gated call re-runs the check at most once a minute, re-parsing the config only
when its sha256 changed, and a later failure blocks while it lasts. Codes are
listed in `skills/approval/README.md`. `register` never raises; it registers
the callback before it logs anything.

## Receipts: a documented stub

No receipt is posted and no request is made. One line is logged once per
process:

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
| `1/true/yes/on` | any | `av-approval: receipts disabled (…)`, plus `av-approval: gate unverified at start (<codes>); …` when the check fails |
| anything else | no (or unreadable) | `av-approval: disabled (fail-open)` |
| anything else | yes | `av-approval: AV_APPROVAL_ENABLED is off but config.yaml still runs the approval shim; …` |

The installer's kill switch removes the entries and keeps this plugin listed. So once the gate is really gone, every gateway start logs the fail-open line. This plugin belongs to a gate, so unlike `av-events` the gap is a fail-open event (AV spec section 7.1). The gate does not depend on the plugin; the backstop only adds refusals. A gateway still running with the switch on while the kill switch removes the shim blocks gated calls (shim gone) until it restarts.

## Tests

`python3 -m pytest plugins/av-approval/tests` (listed in `pytest.ini`). A fake
facade (`http.server` on loopback) proves the plugin sends nothing in any
state; a fake ctx proves each broken gate state blocks every gated call and no
ungated one, the healthy state never blocks, the start failure is sticky, the
re-check runs at most once a minute, the token is never read, and `register`
never raises. `test_backstop_in_a_real_hermes` runs the plugin inside a real
Hermes (opt-in: `AV_HERMES_SRC=<Hermes source tree>
AV_HERMES_PYTHON=<its interpreter>`): healthy, 30 shell hooks register (13 before R3b) and
nothing blocks; with a mode-000 allowlist lock, `register_from_config` raises
`PermissionError` and the backstop blocks `terminal`.
