# av-approval (Hermes backend plugin, opt-in)

The approval gate's fail-closed backstop at every gateway start (DATA-234),
credential custody, the plugin inventory and unknown-plugin quarantine (SEC-3),
the model observer (SEC-6 half 2, observe only),
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
gated call hashes the shim every time (ov#360 refute S1: a swap made and undone
between two checks is still caught) and re-runs the rest of the check at most
once a minute, re-parsing the config only when its sha256 changed, and a later
failure blocks while it lasts. `plugin.yaml` declares `requires_plugins:
av-events` so Hermes loads av-events first and the start event has a
subscriber (ov#360 refute S2). Codes are
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

**Gateway only.** All of this runs only in the gateway process: its argv says
`gateway run` or `gateway start` (`sys.argv[1:5]`, as av-events' `_gateway_argv`;
this covers the unit's `python -m hermes_cli.main [-p <profile>] gateway run`),
or Hermes's marker `_HERMES_GATEWAY=1` is set. The argv is what counts at boot:
`hermes gateway run` starts plugin discovery in a background thread BEFORE it
imports `gateway/run.py`, which is what sets the marker. The dashboard runs
inside the gateway in 0.21.5. The TUI and a standalone `hermes` CLI that also
discover plugins publish nothing and log nothing. The marker is inherited, so a
`hermes` command run by the gateway's own children (the agent's terminal) also
carries it, and an agent-terminal `hermes gateway run` matches the argv: either
runs its own inventory. Expect an occasional extra `plugin.inventory` row per
box, de-duplicable by (box, trigger, window).

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
- `off`: no inventory: nothing classified, nothing sent. The listener and the tick still run while
  the model observer is on (SEC-6 half 2 fix round 1, S1); with both off nothing is subscribed.

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
- DEBUG: `av-approval: plugins: tick skipped (a discovery sweep is running)`;
- quarantine mode only, never in report mode: `av-approval: plugins: quarantine: …`
  (unloaded but not unlisted; could not be unloaded; a key shared with a protected
  plugin). No plugin name is logged.

**What verify reads back after the roll** (design §4.4):

- every box: `plugins/av-approval/plugin.yaml` is `version: 0.4.0` or later (0.5.0 from rc41); the gateway log
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
the previous rc's overlay; with `off` no inventory runs (the tick stays for the model observer). Events: av-events'
`AV_PLUGIN_EVENTS` off. A plugin quarantined in `quarantine` mode stays in
`plugins.disabled` after a rollback by design: add an allow entry, then
`hermes plugins enable <key>` (admin).

## Model observer (SEC-6 half 2, 0.5.0, observe only)

`_models.py`, started by `register` after the inventory whatever `AV_APPROVAL_ENABLED` says, in
the gateway process only (the inventory's argv-or-marker gate). It reports which model id a box
actually uses. It never blocks or rewrites a request: no `llm_request` middleware, no enforce mode.

**Request half.** One `pre_api_request` callback per process (re-`register` keeps it; `ctx.on_unload`
drops it). It reads `request["body"]["model"]`, the id on the wire after any `llm_request`
middleware, else the `model` kwarg (a body too large for Hermes's hook payload arrives truncated,
without `body`). The cost per request is a dict read, a length check, one `re.fullmatch` and one set
lookup under one short lock, and the callback returns None. A first sight per distinct id per
process (a set of 256 ids, oldest dropped first) emits and logs. Every path is wrapped in
try/except; an error gives one DEBUG line per error type and is never raised.

**Config half.** The SEC-3 pass (boot, loaded, the 15-minute tick) hands its own parse of
config.yaml to `on_tick(config)`: `model.default` (or a bare `model` string), with no second read
and no state.db read. It reports at first sight, on any change of the id or of the local list,
and every 24 h unchanged (`trigger=daily`). `/model --global` and `hermes config set model.default`
both write that key, so the next tick sees either.

**Restart.** The first-sight set and the 24 h timer live in the process only; nothing is on disk.
Every gateway boot sends `model.observed` `source=config_default, trigger=first_sight` from the
boot pass, and `source=request, trigger=first_sight` at the first request. `trigger=daily` rows
come only from a gateway that has been up for more than 24 h. data's silence rule counts boot rows
as heartbeats (data#539); this is the contract.

**Events.** `ctx.emit("model.observed", payload)` per observation, and `model.offlist` with the same
fields next to it when the local list exists and does not hold the id. Bus
`av-approval:model.*`, actor `system`. The fields are exactly the `model_events` section of
`plugins/av-events/tests/vectors/plugin_events_contract.json` (ov#333), in its order: `model`,
`source`, `trigger`, `off_list_local`, `allowlist_version`, `hermes_version`, `ts`. Each emit gets
a fresh dict. `model` is null when it is longer than 100 characters, misses the cp's `MODEL_ID`
(never lower-cased), or is a string av-events' credential `sanitize` would rewrite (its
`_SECRET_PATTERNS`, copied and pinned by a test). That covers the three null vectors ov#336 added to the
contract (`openai/sk-proj-<16>`, `sk-or-v1-<20>/x`, and `model.offlist` with the sk-proj id),
which the parity test reads from main's file. av-events sends these events
only with `AV_MODEL_EVENTS` on.

**Privacy.** Ids only: no prompt text, session/task/turn id, provider, base URL or key.

**Trust boundary** (design §2). The box is agent-writable: config.yaml, this plugin, the
installer's env. It reports what it OBSERVED. The local verdict (`off_list_local`) only picks the
log word and whether `model.offlist` is sent. The alert is decided by data (DATA-477) against the
cp's list. `allowlist_version` exposes a tampered local list. A box that strips the plugin goes
silent, and data's silence rule catches that.

**Config** (`config.yaml`):

```yaml
av_approval:
  model_observer: on          # off (or a bare YAML off): nothing subscribed, nothing sent, nothing logged
  model_allow:                # written by the installer (configureModelAllow); absent = no local list
    - openai/gpt-4o-mini
    - openai/gpt-6-luna
```

`model_allow` holds the cp's `AV_MODEL_ALLOWLIST` (exec env only, never `.env`) plus the overlay's
`FALLBACK_MODEL`, each id checked and deduped, then sorted. At most 64 of the cp's ids other than
the fallback are kept, first come; the rest are dropped and counted in one line. The fallback is
added after the cap, so the list holds up to 65 ids, which data accepts (data#539 N7). The
observer reads the list with the same rule: it keeps at most 64 ids besides the fallback, in list
order, then adds `FALLBACK_MODEL`, so its ids are always that union. A list the installer wrote is
never cut. `allowlist_version` = sha256 hex[:12] of
`",".join(sorted(set(ids)))`, UTF-8, which is data's recipe byte for byte, pinned by
`tests/vectors/model-allowlist-version.v1.json`, including its 65-id edge row. That file is copied
from agentvillage-data data#539 at fa754673, `tests/fixtures/model-allowlist-version.v1.json`, blob
ad2df959, sha256 0d9e498b…a60c60d41, so CI needs no cross-repo access. With `AV_MODEL_ALLOWLIST` absent (a manual
install, a local runtime) the key is removed, so `off_list_local` and `allowlist_version` are null.
The installer step fails loudly (non-zero exit at the end of the run) on an unparseable config, a
YAML merge key, or an `av_approval` that is not a mapping. `model_observer: off` read at register
subscribes nothing. Read at a tick, it silences both halves until it is `on` again; the request
half then resumes only if it was subscribed at register. The config half no longer depends on
the inventory (fix round 1, S1). The 15-minute tick starts when EITHER `unknown_plugins` or
`model_observer` is not off, and each runs only under its own mode, so `unknown_plugins: off` does
not silence the observer. With both off, no tick starts.

**Log** (one new class: every line under the `av-approval: model:` prefix, three lines in all, fix round 1 N1):
`av-approval: model: <id> (<source>, <on-list|off-list|no-list>)` at
INFO (WARNING when off-list), at first sight and with the daily heartbeat only. `<id>` is printed
only when it passed the checks above; otherwise it is printed as `invalid`. Once per process:
`av-approval: model: av_approval.model_allow: <n> entries dropped (invalid or past the 64-id cap)`. DEBUG:
`av-approval: model: observer error (<type>)`.

**Layers** (design §7):

| Layer | What it stops | What it cannot stop |
|---|---|---|
| OpenRouter per-tenant key guardrail (release c34742a0 / cp#229) + key credit limit | any request for a model outside the guardrail's ids; spend past the per-key cap (the hard cost bound) | switches among those ids; a box holding another provider's key; nothing until `OPENROUTER_GUARDRAIL_ID` is set |
| SEC-6 half 1, slash allow-list (ov#330) | residents' `/model`, `/reasoning`, `/fast` and config commands in Telegram | the agent's own `hermes config set model.default`, direct config.yaml edits, the admin PTY |
| SEC-6 half 2, this observer | nothing: it DETECTS an off-list id within one turn (request) or 15 min (config), and a tampered local list | a box that strips the plugin or the event (caught as silence, not prevented); auxiliary-model traffic |

**Rollback.** Per box: `av_approval.model_observer: off` (admin). Fleet-wide: `AV_MODEL_EVENTS`
off at av-events (events dark; the log line stays). Or the previous rc's overlay.
`unknown_plugins: off`, SEC-3's rollback, no longer silences the observer. An installer failure
of the list step is recorded as `model_allow_failed` in `av-events/install-status.json`, printed as
`agentvillage-install: model_allow_failed=<reason>`, and exits 1 at the end of the run. It is inert until rc41
rolls `plugins/`. Events stay dark until `AV_MODEL_EVENTS=1`, after data's DATA-477 release is
live.

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
shim is hashed on every gated call and the rest of the re-check runs at most
once a minute, the token is never read, and `register` never raises. `test_backstop_in_a_real_hermes` runs the plugin inside a real
Hermes (opt-in: `AV_HERMES_SRC=<Hermes source tree>
AV_HERMES_PYTHON=<its interpreter>`): healthy, 36 shell hooks register (including `village`) and
nothing blocks; with a mode-000 allowlist lock, `register_from_config` raises
`PermissionError` and the backstop blocks `terminal`.
`test_the_start_event_reaches_av_events_in_a_real_hermes` (same opt-in) loads
av-approval and av-events through Hermes's `PluginManager` and checks the start
event reaches one subscriber.

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

`tests/test_model_observer.py` (SEC-6 half 2): hook payload shapes, nulling (the contract's null
vectors and av-events' credential shapes, the patterns pinned to av-events' `_core.py`), first-sight
dedupe with its 256 bound, the heartbeat and restart on a fake clock, list parsing, data's
`allowlist_version` fixture row by row, mode off, subscribe-once, never-raise on hostile input,
PARITY with the contract's `model_events` section (bus, types, field order, shapes, switch,
drop reasons, every accept and null vector), and three mutation checks (dedupe off, nulling off,
list parsing off). The Hermes-backed run, which needs `PYTHONPATH` as above, drives the ref's
`_fire_pre_api_request_hook` on the real `ApiRequestHooksMixin`, adds an `llm_request` middleware
that rewrites the id, and calls `persist_model_selection` before the next tick. The installer step
is tested by `bun test install/tests/model_allow.test.ts`.
