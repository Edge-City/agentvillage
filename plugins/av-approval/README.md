# av-approval (Hermes backend plugin, opt-in)

The approval gate's fail-closed backstop at every gateway start (DATA-234),
credential custody, the plugin inventory and unknown-plugin quarantine (SEC-3),
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

## Plugin inventory and unknown-plugin quarantine (SEC-3, every start)

`_plugins.py`, started by `register` after custody whatever `AV_APPROVAL_ENABLED`
says. Nothing on a box recorded which plugins were loaded, and nothing refused
a plugin that is not ours; residents may not install plugins (admin only).

**When.** `register` subscribes one `PluginManager.on_plugin_loaded` listener per
process (Hermes calls it after each discovery sweep, with the discovery lock
released) and starts a 15-minute daemon tick. Nothing is classified or unloaded
inside `register`. The first pass is `boot`, a later sweep `loaded`, the tick
`tick` (an inventory only when something changed) or `daily` (every 24 h). The
listener is removed through `ctx.on_unload`; a re-`register` after a forced
re-discovery subscribes it again, never twice. A tick takes Hermes's discovery
lock without waiting and is skipped while a sweep holds it, so it never reads a
half-reloaded registry.

**Gateway only.** All of this runs only in the process where Hermes set
`_HERMES_GATEWAY=1` (at import of `gateway/run.py`, before discovery; the
dashboard runs inside the gateway in 0.21.5). The TUI and a standalone `hermes`
CLI that also discover plugins publish nothing and log nothing. The marker is
inherited, so a `hermes` command run by the gateway's own children (the agent's
terminal) also carries it and runs its own inventory: expect an occasional extra
`plugin.inventory` row per box, de-duplicable by (box, trigger, window).

**Classification** (the expected set is `expected_plugins.json`, derived from the
installer and pinned by `install/tests/expected_plugins_parity.test.ts`):

| Class | Rule |
|---|---|
| expected | a `user` plugin named like one of the overlay plugins (`readdir(plugins/)` minus `NOT_STAGED_PLUGINS`), in a directory of that name, with no `.install-metadata.json` record for that directory; or `index-network` pinned at exactly `INDEX_PLUGIN_REF`. `edgecity-village` (`DASHBOARD_ONLY`: no `__init__.py` in the source tree, pinned by a test) counts when its directory is present; any other expected directory without `__init__.py` is a broken stage and counts as missing. `recall` and `index-network` are conditional: absent is not missing. |
| bundled | source `bundled` AND a manifest path under `<hermes_cli package>/../plugins` (`HERMES_BUNDLED_PLUGINS` can point the scan anywhere, so the path is checked) |
| unknown | everything else: a user directory overriding a bundled key, every `project` and `entrypoint` plugin, a bundled-sourced manifest outside Hermes's tree, `index-network` at another revision, an overlay name installed from git or from a directory of another name |

`expected_set_version` is the first 12 hex of sha256 over the canonical JSON of
the set (keys sorted, no spaces).

**Mode and allow-list** (`$HERMES_HOME/config.yaml`, the block that holds `custody`):

```yaml
av_approval:
  unknown_plugins: report        # report (default) | quarantine | off
  plugins_allow:                 # admin only: residents cannot write config.yaml (SEC-1)
    - name: fixture-echo
      revision: 0123456789abcdef0123456789abcdef01234567   # .install-metadata.json revision
    - name: my-local-experiment
      revision: local            # only a directory with NO install metadata
```

An unreadable config or a value other than the three modes runs as `report` and
logs `av-approval: plugins: av_approval.unknown_plugins unreadable or not
report|quarantine|off; mode report` once. A bare YAML `off` (read as false) is
`off`. An allow entry whose revision does not match the metadata leaves the plugin
unknown.

- `report` (this release): events and the log line only. Nothing is unlisted or
  unloaded; `plugins.disabled` is untouched.
- `quarantine` (L1, the flip one rc later once verify reads back zero unknown
  plugins fleet-wide): an unknown plugin that has not loaded is unlisted
  (`dashboard_set_agent_plugin_enabled(key, enabled=False)`: its key goes into
  `plugins.disabled`) before it loads; a loaded one is unloaded live
  (`PluginManager.unload`) and unlisted, so the next start is clean. The directory
  and its metadata stay as evidence. A key an expected, bundled or allow-listed
  plugin also holds is never unlisted. The `action` says what happened:
  `unloaded_unlisted` only when both the unload and the unlist succeeded;
  `unlisted` when the unlist succeeded and no unload was needed (or the unload
  failed: `state=loaded` then shows it is still live, and a line says so);
  `unlist_failed` whenever the key was not unlisted, whatever the unload did (an
  unload that did succeed is logged). No sticky gate block, no gateway exit.
- `off`: nothing subscribed, nothing sent.

**Events** (bare names through `ctx.emit`; the host namespaces them
`av-approval:`; av-events turns them into `plugin.inventory@1` and
`plugin.unknown@1` behind its `AV_PLUGIN_EVENTS` switch). The fields, their order
and their shapes are the contract file
`plugins/av-events/tests/vectors/plugin_events_contract.json`, which
`tests/test_plugins.py` reads:

- `plugin.inventory`: `trigger`, `mode`, `expected_loaded`, `expected_missing`,
  `bundled_loaded`, `unknown_count`, `allowed_count` (kept within 0..10000),
  `expected_set_version`, `hermes_version` (null when it is not data's shape);
- `plugin.unknown`, once per (plugin, source, state, action) per process: `name`
  (the plugin key, null when it is not the contract's shape), `name_hash`,
  `source`, `state` (`loaded`, `enabled_not_loaded`, `dir_only`,
  `overrides_bundled`), `install_host` (the host of the install source only),
  `revision`, `pinned`, `tools` and `hooks` (counts), `action` (`none` in report;
  `unlisted`, `unloaded_unlisted` or `unlist_failed` in quarantine).

**Privacy.** No path, no URL path, no tool name and no file text leaves this
plugin. `name_hash` is HMAC-SHA256 under this plugin's own key
`$HERMES_HOME/av-approval/hash.key` (64 hex, 0600, created once; never av-events'
key) over `av-approval|plugin|<key>`, so the small name set cannot be reversed by
a dictionary. If the key cannot be read or created, a per-process key is used and
`av-approval: plugins: hash key ephemeral` is logged once.

**Log lines** (no other new class):

- at boot and daily: `av-approval: plugins: <n> expected, <m> bundled, <u> unknown
  (mode <mode>)` (INFO; WARNING when `<u>` is not 0);
- `av-approval: plugins: inventory NOT running`, only when the listener could not
  be subscribed (no plugin manager, an unreadable or edited `expected_plugins.json`);
- quarantine mode only, never in report mode: `av-approval: plugins: quarantine: …`
  (unloaded but not unlisted; could not be unloaded; a key shared with a protected
  plugin). No plugin name is logged.

**What verify reads back after the roll** (design §4.4):

- every box: `plugins/av-approval/plugin.yaml` is `version: 0.4.0`; the gateway log
  has `av-approval: plugins: <n> expected, <m> bundled, 0 unknown (mode report)`
  and no `plugins: inventory NOT running`; `plugins.disabled` is unchanged (empty)
  in report mode;
- after data's release and the av-events switch: one `plugin.inventory` per live
  tenant per 24 h with `unknown_count = 0` fleet-wide, zero `plugin.unknown` rows,
  `plugin_inventory_silent` not firing;
- Carter's tenant only: an admin install of the test fixture gives one
  `plugin.unknown` with `state=loaded`, `action=none` in report mode
  (`unloaded_unlisted` in quarantine), then `hermes plugins remove <fixture>`;
- then verify's `box-plugins.sh` sweep, compared with the ingest counts.

**Rollback** (design §4.5): `av_approval.unknown_plugins: off` per box (admin), or
the previous rc's overlay; with `off` nothing is subscribed. Events: av-events'
`AV_PLUGIN_EVENTS` off. A plugin quarantined in `quarantine` mode stays in
`plugins.disabled` after a rollback by design: add an allow entry, then
`hermes plugins enable <key>` (admin).

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

`tests/test_plugins.py` (SEC-3): the classification table (impostor, override,
env-pointed bundled dir, the index pin, the allow-list binding), mode parsing,
subscribe-once and unsubscribe-on-unload, report mode inert, quarantine outcomes,
the closed payload (a sentinel in a directory name or install URL reaches no
field but `name`, and only in the contract's shape), the hash key, PARITY with
the contract file (every accept vector through the serializer, bus names, field
order, `hermes_version` character for character), and three mutation checks
(classification off, path check off, revision check off: each fails the table).
The Hermes-backed runs (an install from a local `git init` fixture registering
`fixture_echo`; `--no-enable` plus a hand-edited `enabled` unlisted by the tick;
an allow-listed revision, a bundled `web/ddgs`, a same-named override) run in a
subprocess when `hermes_cli` and `ruamel.yaml` import
(`PYTHONPATH=<Hermes source tree>[:<ruamel>]`) and skip otherwise.
