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
| `scripts/live_selfcheck.py` | The live half of the self-check, run with Hermes's own interpreter. It checks every gated matcher's first parsed entry is `fail_closed`, tests the signal patch by behaviour (a SIGKILLed `fail_closed` hook must block), and fires one `terminal` call with no `workdir` through `agent.shell_hooks.run_once`, requiring a facade block. It also reports safe mode, managed scope and the `fail_closed` floor. Modelled on approval-md-hosted `hermes-image/selfcheck.py` item 8 and `patches/shell_hooks-signal-fail-closed.py`. |
| `templates/APPROVAL.md` | The resident's starting policy. Documentation only: the daemon holds the policy, so the installer does not write it into the sandbox. |

The installer step is `install/install_approval.ts`; the receipts plugin is
`plugins/av-approval` (a documented stub at this core version, see its README).

## How the gate works

Hermes runs the shim as a `pre_tool_call` shell hook for `terminal`,
`write_file`, `patch`, `read_file`, `search_files` and `execute_code`, and for
`process(_manage)?`, `web_extract`, `browser_.*`, `skill_manage` and
`delegate_task` (which the core adapter passes through unjudged today; they are
routed now so a core change covers them with no overlay release). The shim
POSTs Hermes's envelope to `$AV_APPROVAL_URL/hook/hermes` with the agent token
in `X-Approval-Authorization` (Maritime's proxy strips `Authorization`), passed
to curl through a config on stdin, never argv. The facade runs the core
decider and answers; the shim replays `{}` (allow) or the block directive at
exit 2. While the facade answers `hook-timeout` (a question is open and waiting
for the resident) the shim re-asks every 5 s for up to 280 s, inside Hermes's
300 s entry timeout. Every failure it can see (facade unreachable, non-200,
unparseable body, a missing program, a missing variable) prints a block and
exits 2: it fails closed.

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
marker unless `AV_APPROVAL_ALLOW_UNPATCHED_HERMES=1` (dogfood only). The
residual, as the consent copy states it: a process on the sandbox can kill the
hook (signal) or attach to the gateway (ptrace); both are closed by the
checkpoint build (patch + ptrace_scope), not by this skill.

## Environment

| Name | Where | Meaning |
|---|---|---|
| `AV_APPROVAL_ENABLED` | `.env`, else environment | Unset: nothing happens. `1/true/yes/on`: install. Anything else: kill switch (fail-open, logged; removes the gate and restores the consent keys to what the first install found). |
| `AV_APPROVAL_ALLOW_UNPATCHED_HERMES` | `.env`, else environment | `1`: dogfood only, accept a Hermes below the `fail_closed` floor or without the signal patch, logged loudly. |
| `AV_APPROVAL_URL` | `.env` | The tenant's facade, https. |
| `AV_APPROVAL_TOKEN` | `.env` | The AGENT credential. Never the tenant credential. |
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
