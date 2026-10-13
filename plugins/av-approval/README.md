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

## Credential custody (every start, whatever the gate's switch)

`_custody.py` keeps the service keys in `FLOOR` (`INDEX_API_KEY`,
`INDEX_SESSION_TOKEN`, `AV_EVENTS_TOKEN`, `AV_BACKUP_TOKEN`, `ADMIN_TOKEN`), plus
any more `custody_keys.json` marks `strip`, out of every child the agent's code
runs in, while
the gateway (the Index MCP client, av-events) keeps them. Three levers, each
fail-soft and reported in one line on the `av-approval.custody` logger:

- **provider**: a strip-only `TerminalEnvironmentProvider` (`av_custody`; never
  available, never a backend). Hermes strips every provider's `strip_env_keys`
  from the background/PTY terminal, cron and user scripts, search workers and
  non-terminal spawns.
- **foreground**: Hermes v2026.9.24's foreground terminal
  (`tools.environments.local._make_run_env`, every command and the session
  snapshot) passes an empty plugin key set, so the provider does not reach it;
  the builder is wrapped to drop the same names.
- **execute_code**: `tools.code_execution_env._scrub_child_env` is wrapped so a
  skill's `required_environment_variables` cannot re-admit a stripped name.

After wrapping, a probe checks the real path: one child spawned through the
foreground builder must not see a canary under a strip name, `_scrub_child_env`
must drop it even when declared passthrough, and `LocalEnvironment._run_bash` and
`_build_child_env` must still call the wrapped names. A Hermes other than the
measured 0.21.5 is named in a warning.

`register` applies it after the backstop, on every box (the config step lists the
plugin whatever `AV_APPROVAL_ENABLED` says; with the switch unset the backstop
registers no hook), and never touches `ctx`. Every failure is a warning:
`av-approval: custody: NOT covered: <surface>` (a missing lever, a failed probe,
or `_custody` failing to load), and a decisions file that no longer marks a floor
name (`... does not mark ... strip ...; they are stripped anyway`). The only off
switch is `av_approval: {custody: false}` in `$HERMES_HOME/config.yaml`, read
with Hermes's raw config loader. No environment variable is read: Hermes loads
dotenv files the agent can write (`hermes-agent/.env`, `.op.env`) into the
gateway. What the hook protects today: a write to config.yaml spelled
`~/.hermes/config.yaml` or `$HOME/.hermes/config.yaml` is `policy.core`
(human-only); the `$HERMES_HOME/config.yaml` spelling and the plugin directory
(this module, which holds `FLOOR`) classify `files.write.workspace` and are
covered by approval-md APRV-511 (0.4.5). Until then an agent can turn custody off
or shrink the list through those spellings; an edit of `custody_keys.json` alone
cannot shrink it.
Not closed: `$HERMES_HOME/.env` and `/proc/<gateway pid>/environ` stay readable
by the agent's user; see `skills/approval/README.md`.

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
AV_HERMES_PYTHON=<its interpreter>`): healthy, 35 shell hooks register (13 before R3b) and
nothing blocks; with a mode-000 allowlist lock, `register_from_config` raises
`PermissionError` and the backstop blocks `terminal`.

`tests/test_custody.py`: the decisions file, each lever against fake Hermes
modules, the switch, the inventory scan (every credential-shaped name the
overlay reads has a decision; no stale decisions), and the skills (no pasted
key placeholder, every `Authorization: Bearer` names a variable, no recipe
names a stripped one). `test_against_real_hermes` runs when Hermes is
importable (`PYTHONPATH=<Hermes source tree>`; it skips in CI): the real
foreground, background and non-terminal builders, `execute_code` with the
names registered as passthrough, and a real bash child and its snapshot file.
