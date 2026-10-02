# approval (opt-in skill)

The installer half of approval.md for Agent Village (DATA-43): it makes one
resident's Hermes sandbox ask the resident's hosted approval.md daemon before
gated tool calls run. Specified by approval-md-hosted `docs/03` sections 3.1 to
3.3, 5 and 6 and `docs/02` sections 5 to 7. MIT, like the rest of this
overlay; it writes config and carries no Bountify logic.

| File | What it is |
|---|---|
| `SKILL.md` | What the agent is told: absolute `workdir` and paths, no `execute_code`, what a block means, never route around one. |
| `scripts/hermes-hook-shim.sh` | The gate: vendored from approval-md-hosted `hermes-image/hermes-hook-shim.sh` (header names the origin commit). Installed as `$HERMES_HOME/agent-hooks/hermes-hook-shim.sh`, 0700. |
| `scripts/live_selfcheck.py` | The live half of the self-check, run with Hermes's own interpreter. It checks every gated matcher's first parsed entry is `fail_closed`, tests the signal patch by behaviour (a SIGKILLed `fail_closed` hook must block), reports how Hermes treats a `fail_closed` hook that exits 1 with no output (the exit-1 probe), checks the consent allowlist and its lock are usable, and fires one `terminal` call with no `workdir` through `agent.shell_hooks.run_once`, requiring a facade block. It also reports safe mode, managed scope and the `fail_closed` floor. Modelled on approval-md-hosted `hermes-image/selfcheck.py` item 8 and `patches/shell_hooks-signal-fail-closed.py`. |
| `templates/APPROVAL.md` | The resident's starting policy. Documentation only: the daemon holds the policy, so the installer does not write it into the sandbox. |

The installer step is `install/install_approval.ts`. The `plugins/av-approval`
plugin is the gate's fail-closed backstop at every gateway start (below) and
the receipts stub (see its README).

## How the gate works

Hermes runs the shim as a `pre_tool_call` shell hook for `terminal`,
`write_file`, `patch`, `read_file`, `search_files` and `execute_code`, and for
`process(_manage)?`, `web_extract`, `browser_.*`, `skill_manage`,
`delegate_task`, `cronjob(_manage)?` and `send_message` (which the core adapter
passes through unjudged today; they are routed now so a core change covers
them with no overlay release). The shim POSTs Hermes's envelope to
`$AV_APPROVAL_URL/hook/hermes` with the agent token in
`X-Approval-Authorization` (Maritime's proxy strips `Authorization`), passed
to curl through a config on stdin, never argv. The facade runs the core
decider and answers; the shim replays `{}` (allow) or the block directive at
exit 2. While the facade answers `hook-timeout` (a question is open and waiting
for the resident) the shim re-asks every 5 s for up to 280 s, inside Hermes's
300 s entry timeout. Every failure it can see (facade unreachable, non-200,
unparseable body, a missing program, a missing variable, a bad variable name,
an unreadable token file, a foreign listener) prints a block and exits 2: it
fails closed. It has no fatal shell path of its own left: a variable name
starting with a digit is refused before it reaches `eval` (it was a fatal "bad
substitution"), a clock that does not print digits reads as 0 instead of
failing `$(( ))`, and the interpreter stays `#!/bin/sh` without `set -u`
(an unset variable expands empty and is then refused by name). Only a signal
kill (or ptrace) can still end it without a directive; see the uncovered
surfaces.

### Facade URL forms

| `AV_APPROVAL_URL` | Who | How the shim dials it |
|---|---|---|
| `https://…` | a hosted facade (the dogfood) | curl `--proto =https` |
| `http://127.0.0.1:<port>` | the co-located daemon, tcp mode (DATA-233; `http://127.0.0.1:4682`) | plain http, no allow flag. Before EVERY post (re-asks too) the shim reads `/proc/net/tcp` and `/proc/net/tcp6` and requires a LISTEN socket on the port at a loopback or wildcard address, every one of them owned by `AV_APPROVAL_DAEMON_UID` (default `10001`). Otherwise it blocks with `facade_listener_foreign` and never sends the token: while the daemon is down any local process could bind the port and answer allow. |
| `unix:<absolute path>` | the co-located daemon, `APPROVALD_LISTEN=unix` (`unix:/var/lib/approvald/<tenant>/run/hook.sock`) | curl `--unix-socket <path>` and the request URL `http://localhost/hook/hermes`. Before every post the socket must be a socket (not a link) owned by the daemon uid, in a directory owned by it that no one else can write; otherwise `facade_listener_foreign`. |
| any other `http://` | local fakes only | refused unless `APPROVAL_FACADE_ALLOW_HTTP=1`; the installer refuses it outright |

The installer accepts exactly the first three. A residual of the tcp form: the
listener is read just before curl connects, so a process that binds in the
instant between the two (the daemon having died in that instant) is not seen.
The unix form has no such window (the directory is the daemon's).

### The agent token

By hand (every Agent Village sandbox), the shim reads the agent credential from
the file `AV_APPROVAL_TOKEN_FILE` names; when that is unset, from
`$HERMES_HOME/approval/agent-token` if that file exists; otherwise from
`AV_APPROVAL_TOKEN` (the variable `APPROVAL_HOOK_TOKEN_ENV` names). The file
must be a regular file (not a link) owned by the hook's user, mode 0600; a
named file that is missing or loose blocks, with no fallback to the variable.
Under co-location (DATA-233) the control plane writes the token to
`$HERMES_HOME/approval/agent-token` (directory 0700, file 0600, both
`hermes`), sets `AV_APPROVAL_TOKEN_FILE` to it and removes any
`AV_APPROVAL_TOKEN` line: the token is not in `.env`. `AV_APPROVAL_TOKEN` in
`.env` remains for the hosted dogfood only. The value is never printed or
logged by the shim, the installer or the plugin (the plugin never reads it).

## Fail-closed backstop at every gateway start (`av-approval`)

Hermes registers shell hooks once, at gateway start, and only with consent; it
loads plugins first. Several states at that moment leave a tenant ungated
without a word (DATA-234): consent gone from both channels, the hooks block
edited, the shim replaced, or a consent allowlist lock Hermes cannot open (a
lock of mode 000, another owner's, a directory or a link makes
`register_from_config` raise, the gateway swallows the exception, and no hook
registers). Hermes re-records a deleted allowlist by itself as long as consent
is on, so deleting the allowlist alone is not a hole; its lock is.

With `AV_APPROVAL_ENABLED` on, the plugin's `register()` checks the gate and
then registers a `pre_tool_call` callback that RAISES
`av-approval: gate unverified (<code>)` for every gated tool while the check
fails; Hermes turns a raising `pre_tool_call` callback into a block
(`hermes_cli/plugins_dispatch.py` `invoke_hook` at v2026.9.24). Ungated tools
are never touched. A failure found at start holds until the gateway restarts
(the hooks were registered, or not, at start). After start, a gated call
re-runs the check at most once a minute (the config is re-parsed only when its
sha256 changes), and a failure then blocks while it lasts. Codes only are
logged. Unset does nothing; off (the kill switch) stays fail-open, logged.

| Code | Meaning |
|---|---|
| `config-unreadable` | `config.yaml` missing or not YAML |
| `hooks-missing` | no `hooks.pre_tool_call` list |
| `hook-missing:<matcher>` | no entry running the shim for that gated matcher |
| `fail-closed-off:<matcher>` | an entry of ours without `fail_closed: true` (a real bool) |
| `entry-timeout:<matcher>` | an entry of ours without `timeout: 300` |
| `consent-missing:config` | `hooks_auto_accept` not on |
| `consent-missing:env-file` | `.env` does not assign `HERMES_ACCEPT_HOOKS=1` (only that line is read) |
| `consent-missing:env` | the gateway's environment lacks `HERMES_ACCEPT_HOOKS` |
| `allowlist-unusable` | `shell-hooks-allowlist.json` present but not a regular file of this uid it can read |
| `allowlist-lock-unusable` | `shell-hooks-allowlist.json.lock` present but not a regular file of this uid it can read and write |
| `allowlist-lock-uncreatable` | the lock is absent and the home is not writable |
| `shim-missing`, `shim-not-executable` | the shim is gone, not a regular file, or not executable |
| `manifest-missing` | `agent-hooks/approval-surface.json` has no `shim_sha256` (an install from before DATA-234: re-run the installer) |
| `shim-hash-mismatch` | the shim's sha256 differs from the one the installer recorded |
| `url-missing` | `AV_APPROVAL_URL` unset |
| `check-error` | the check itself failed |

The installer's own self-check names the same states at install and in
`--check` (`allowlist-unusable:<file>:<why>`, `shim-hash-mismatch`,
`manifest-missing`). `bun install/install_approval.ts --check` stays a hand
step: nothing runs it at start; the plugin's check is what runs at start.

The core adapter refuses `execute_code` outright and refuses `terminal`
without an absolute `workdir` (and the file tools without an absolute `path`).
The skill documents that; it does not reimplement it.

## Why no setuid launcher here

The gated Hermes image in approval-md-hosted runs the shim as a separate unix
user through `hermes-image/hook-launcher.c`, so nothing the agent controls
reaches the hook's environment. An Agent Village sandbox has one user
(`hermes`), and the launcher's protection depends on a second user that owns
the hook home and the credential file. With one user it would protect nothing,
so the shim runs "by hand" (its no-hook-home branch): the URL and token come
from the gateway's environment, which Hermes loads from `$HERMES_HOME/.env`.
The residual is the one docs/03 section 8 states: the agent runs as the
gateway's user. What keeps it from editing itself out of the gate is the core
classifier, which treats `.hermes/config.yaml`, `.hermes/agent-hooks/` and
`.hermes/hooks*` as `policy.core` and `.hermes/.env` as `account.credential`
(both human-only), provided `HERMES_HOME` ends in `.hermes`
(`/home/hermes/.hermes` on the sandboxes). ptrace against the gateway is not
closed by any hook (docs/03 section 8; HOSTED-16 case 4), and at the pinned
Hermes a hook killed by a signal counts as an allow even under `fail_closed`
(Bountify's image patches it). The install refuses a Hermes without that patch
(judged by behaviour) unless `AV_APPROVAL_ALLOW_UNPATCHED_HERMES=1` (dogfood
only). The residual, as the consent copy states it: a process on the sandbox
can kill the hook (signal) or attach to the gateway (ptrace); both are closed
by the checkpoint build (patch + ptrace_scope), not by this skill.

Under co-location (DATA-233) there is still no launcher: the sandbox gateway
runs with `NoNewPrivs=1`, so a setuid binary would be inert. The daemon runs as
its own uid (`approvald`, 10001); the hook still runs as `hermes` and reads its
token from a `hermes` file (above).

## Uncovered surfaces

What the gate does not see, or does not judge, today:

- **A hook killed by a signal** (SIGKILL, OOM, SIGTERM): empty stdout, a
  negative return code, which stock Hermes reads as an allow even under
  `fail_closed`. The shim cannot defend against its own death, and a wrapper
  process could itself be killed (and would re-key consent on a new command
  string), so there is none. Closed by the checkpoint's patch (the install
  requires it by behaviour); the widened patch (DATA-228: any non-zero exit
  without a directive, which also covers exit 1) closes the rest. The install
  prints which one this Hermes does (the exit-1 probe: `allowed` on stock
  Hermes, `blocked` on the patched checkpoint; `hermes_exit1` in `--check`).
- **Cron job scripts.** Hermes's scheduler runs a job's `script`, `monitor`
  and prerun scripts from `$HERMES_HOME/scripts/` with no `pre_tool_call` at
  all (`cron/scheduler_script.py`). Routing `cronjob(_manage)?` through the
  gate is the only control here: creating or changing a job is seen, what its
  script does at every tick is not, and a script already in place keeps
  running. A cron script runs as the gateway's user and can edit
  `config.yaml`, `.env`, the allowlist and its lock ungated; the backstop then
  blocks gated calls at the next start or within a minute, but the script
  itself is not stopped. The installer lists the scripts present at install
  and in `--check` (`cron_scripts`); the daily brief's own scripts live there.
- **MCP tools** (Index included): no matcher covers them.
- **Safe mode and plugin disable.** `HERMES_SAFE_MODE=1`, or removing
  `av-approval` from `plugins.enabled`, stops the plugin loading AND stops
  Hermes's `register_from_config`, so the tenant runs fully ungated with no
  record, and the backstop cannot catch its own absence. `--check` flags
  `hermes-safe-mode`; only a control-plane preflight or the checkpoint
  (DATA-228) closes it. The write that sets it is the same ungated cron-script
  route as above.
- **Native tool families with no matcher**: `computer_use`,
  `manage_connections`, `web_search`, `x_search`, `image_generate`,
  `video_generate`, `text_to_speech`, `memory` (all present at Hermes
  v2026.9.24). `computer_use` and `manage_connections` are real action
  channels; the gated list is a contract, not a discovery.
- **Recheck cadence.** After a healthy start the backstop re-runs its check at
  most once a minute, so a mid-run plugin force-reload that drops a shell hook
  can leave up to 60 s before the next gated call is refused. A failure seen
  at start is sticky until restart.
- **Config scope.** The integrity check reads the raw `config.yaml`; Hermes
  registers from the deep-merged config. On Agent Village sandboxes the
  installer refuses a managed `/etc/hermes` scope and the defaults carry no
  hook entries, so raw and effective are the same; the check assumes that.
- **Deploy order.** An install from before DATA-234 reads as `manifest-missing`
  and blocks every gated call under enforcement until the installer re-runs:
  ship the plugin and re-run the installer in the same update.
- **Subagents.** `delegate_task` is routed (recorded, not judged); the
  2026-10-01 harness saw a child's `terminal` reach the hook, but nothing here
  proves every subagent runtime fires it.
- **Routed but not judged.** `process(_manage)?` writes, `web_extract`,
  `browser_.*` (including `browser_exec`), `skill_manage`, `delegate_task`,
  `cronjob(_manage)?` and `send_message` reach the facade, but approval-md core
  6b74ca72 has no classifier rule for any of them: the adapter passes an
  unknown tool through (`{}`), so they are recorded under the core's default
  handling and fail closed only when the facade cannot be reached. The policy
  template's rows for them take effect once the core has rules (below).
  `send_message` is not an agent-callable tool at Hermes v2026.9.24; its
  entry covers any build or plugin that registers it.
- **The tcp listener window** (above) and ptrace against the gateway.

## Environment

| Name | Where | Meaning |
|---|---|---|
| `AV_APPROVAL_ENABLED` | `.env`, else environment | Unset: nothing happens. `1/true/yes/on`: install. Anything else: kill switch (fail-open, logged; removes the gate and restores the consent keys to what the first install found). The control plane writes `1`, or `0` as the explicit off. |
| `AV_APPROVAL_ALLOW_UNPATCHED_HERMES` | `.env`, else environment | `1`: dogfood only, accept a Hermes below the `fail_closed` floor or without the signal patch, logged loudly. |
| `AV_APPROVAL_URL` | `.env` | The tenant's facade: `https://…`, `http://127.0.0.1:<port>` or `unix:<absolute path>` (above). |
| `AV_APPROVAL_TOKEN_FILE` | `.env` | A file holding the AGENT credential, 0600, this user's (co-located: `$HERMES_HOME/approval/agent-token`, also the default when it exists). Read before `AV_APPROVAL_TOKEN`. |
| `AV_APPROVAL_TOKEN` | `.env` | The AGENT credential, the hosted dogfood's form. Never the tenant credential. |
| `AV_APPROVAL_DAEMON_UID` | `.env`, else environment | The uid that must own a loopback listener or the unix socket. Default `10001`. |
| `HERMES_ACCEPT_HOOKS=1` | `.env`, written | Headless consent, second form (the first is `hooks_auto_accept: true`). |
| `APPROVAL_HOOK_URL_ENV`, `APPROVAL_HOOK_TOKEN_ENV`, `APPROVAL_HOOK_WAIT_S` | `.env`, written | The shim's settings: `AV_APPROVAL_URL`, `AV_APPROVAL_TOKEN`, `280`. |

## Identity map

`$HERMES_HOME/agent-hooks/approval-surface.json` holds `{daemon_id, tenant_id,
installed_at, overrides, prior}` with `daemon_id: null`. `overrides` lists any
dogfood override in force; `prior` is what the first install found for each key
it sets, which the kill switch restores. It sits under `agent-hooks/` so a gated
write to it is `policy.core`, but it is still a file on attendee compute:
DATA-43b must not trust it for anything but a hint. The daemon instance id is reported only
on the facade's `GET /status`, which answers the tenant credential; the
sandbox holds the agent credential. The DATA-43b follower reads it and writes
the `approval_md` identity-map row.

## Enablement under co-location (DATA-233)

Two switches, in order. The control plane's `APPROVALD_ENFORCE` (a Railway
variable, tri-state) decides what it writes into each sandbox's `.env`; this
step reads only `AV_APPROVAL_ENABLED`:

1. `APPROVALD_ENFORCE` unset: the control plane touches no `AV_APPROVAL_*`
   line; a hand-wired hosted gate (the dogfood) keeps working.
2. `APPROVALD_ENFORCE=1`: every `.env` write sets `AV_APPROVAL_ENABLED=1`,
   `AV_APPROVAL_URL` (the daemon: `http://127.0.0.1:4682`, or the `unix:` form)
   and `AV_APPROVAL_TOKEN_FILE=/home/hermes/.hermes/approval/agent-token`, and
   removes any `AV_APPROVAL_TOKEN` line, before the overlay install; this step
   then installs the gate. With a local facade the install's live fire is
   best-effort: a facade that did not answer (`live-facade-unreachable`,
   `live-hook-timed-out`) is logged and the install stands, because the shim
   blocks while the facade is unreachable. Every other problem, and any
   problem with a remote https facade, still fails the install.
3. `APPROVALD_ENFORCE=0`: every `.env` write sets `AV_APPROVAL_ENABLED=0`,
   which this step reads as the kill switch.

## Classifier follow-up (approval-md core, Carter's repo)

The policy template carries rows for the routed tools, but they are inert
until the core's Hermes adapter emits these classes. The table the core lane
needs:

| Hermes tool (args) | Class | Template autonomy |
|---|---|---|
| `cronjob_manage` `create`/`update` with `script`, `monitor` or `no_agent`; `run` | `cron.manage` | manual |
| `cronjob_manage` other `create`/`update`, `pause`, `resume`, `remove` | `cron.manage` | manual |
| `cronjob_manage` `list` | a read class | autonomous |
| `process_manage` `write`, `submit` (stdin into a running process) | `process.write` | manual |
| `process_manage` `kill`, `close`, `handoff` | `process.write` | manual |
| `process_manage` `list`, `poll`, `log`, `wait` | a read class | autonomous |
| `browser_exec`, `browser_cdp` (code in the page) | `browser.exec` | manual |
| other `browser_*` (navigate, click, fill, vault) | `browser.exec` until split | manual |
| `skill_manage` | `skill.manage` | manual |
| `delegate_task` | `agent.delegate` | manual |
| `send_message` | `message.send` | manual |
| a `terminal`/`write_file`/`patch` write under `.hermes/scripts/` | `cron.manage` (or `policy.core`) | manual |
| a write to `.hermes/.env`, `.hermes/approval/`, `.hermes/shell-hooks-allowlist.json.lock` | `policy.core` / `account.credential` | human-only |
