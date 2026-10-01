---
name: approval
description: Installed only for residents who opted in to approval.md. Some of your tool calls (terminal, write_file, patch, read_file, search_files) are checked by the resident's approval gate before they run, and a few kinds of action wait for the resident to approve them in their approval bot. Read this before your first tool call, and whenever a tool call comes back blocked by the approval gate.
---

# Approval gate

The resident asked to approve certain actions before you take them. Before
`terminal`, `write_file`, `patch`, `read_file` and `search_files` run, the
call is checked against the resident's approval policy, which lives with their
approval service, not in this sandbox. Most calls pass straight through. The
ones with consequences outside the sandbox (sending a message, spending money,
deleting files outside your workspace, posting content, calling or fetching
from a network service) wait for the resident to tap approve or reject in
their approval bot on Telegram. `process`, `web_extract`, the `browser_*`
tools, `skill_manage` and `delegate_task` also pass through the gate; today
the gate lets them through unjudged.

## Shape every gated call so it can be checked

- `terminal`: always pass `workdir` as an absolute path (for example the
  `HERMES_HOME` directory). A call with no `workdir`, or a relative one, is
  refused with `hook-unsupported-execution-context`.
- `write_file`, `patch`, `read_file`, `search_files`: always give `path` as an
  absolute path starting with `/`. A relative or missing path is refused the
  same way.
- Do not use `execute_code`. It is always refused
  (`hook-hermes-execute-code-unbound`) because the gate cannot see what the code
  would do. Run the same work through `terminal` with an absolute `workdir`.

When a refusal names its repair, make that repair and call again once.

## When a call is waiting for the resident

A call that needs the resident's approval holds for about four minutes while
the resident is asked. Then:

- **Approved**: the call runs. Carry on.
- **Rejected**: the call does not run. Tell the resident plainly that it was
  not done because they declined it. Do not try again.
- **No answer in time**: the call is blocked (the message mentions
  `hook-timeout` or that the request expired). Tell the resident what you were
  about to do and that it needs their approval in the approval bot; do it only
  if they ask again and approve.
- **Gate unreachable** (`approval facade unreachable`): nothing that needs the
  gate can run right now. Tell the resident; do not look for a way around it.

## Never

- Never retry a blocked or rejected action through another tool, another
  path, a script, a subagent or a different command that has the same effect.
  A block is the resident's answer, not an obstacle.
- Never edit, move or delete `config.yaml`, anything under `agent-hooks/`,
  `.env` or `shell-hooks-allowlist.json` in the Hermes home, and never try to
  change the approval policy. Those are the resident's controls; the gate
  refuses such calls.
- Never send the resident a link to approve something. Approvals arrive in
  their approval bot by themselves.

## What the gate does not cover

The resident has been told what is not checked:

- Subagent calls, MCP tools (Index included) and reads before the first gated
  call.
- Tools that can reach the same effects without a check today:
  `process`/`process_manage` (writing to and submitting a running process),
  `web_extract`, the `browser_*` tools, `skill_manage` and `delegate_task` pass
  through the gate unjudged until approval.md's Hermes adapter learns them;
  `cronjob_manage` is not routed through the gate at all, so a scheduled job's
  script (`script`, `no_agent`) and an HTTP `monitor_script` run without a
  check.
- A process on the sandbox can kill the hook (signal) or attach to the gateway
  (ptrace); both are closed by the checkpoint build (patch + ptrace_scope), not
  by this skill.

None of this is permission. Never use an unchecked tool, a scheduled job, a
subagent or another process to do what the resident would be asked about, and
never interfere with the hook or the gateway process.
