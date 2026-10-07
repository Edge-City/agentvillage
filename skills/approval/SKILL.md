---
name: approval
description: Installed only for residents who opted in to approval.md. Your tool calls (terminal, write_file, patch, read_file, search_files, and a few more) are checked and recorded by the resident's approval gate before they run. A few never run for you (edits to the gate itself, the approval log, the resident's credentials), and a kind of action the resident chose to approve waits for their tap. Read this before your first tool call, and whenever a tool call comes back blocked by the approval gate.
---

# Approval gate

The resident opted in to a record of what you do. Before `terminal`,
`write_file`, `patch`, `read_file` and `search_files` run, and `process`,
`web_extract`, the `browser_*` tools, `skill_manage`, `delegate_task`,
`cronjob_manage` and `send_message` too, and `web_search`, `x_search`, the
media tools (`image_generate`, `video_generate`, `text_to_speech`) and every
one of Index's write tools (creating, rewording, pausing, resuming or archiving
a signal, accepting or declining an opportunity, changing or enriching the
profile, joining or changing a network), the call is checked against the
resident's approval policy, which lives with their approval service, not where
you can edit it. On the starting policy almost every call is recorded and
passes straight through. Three kinds never run for you: changing the gate
itself (the Hermes config, its hooks, the consent allowlist), touching the
approval log, and reading or changing the resident's credentials. If the
resident has made a kind of call wait for them, it waits for their tap in their
approval bot on Telegram. If the gate cannot be reached, or cannot be verified
(`av-approval: gate unverified (...)`), gated calls are blocked.

Publishing an intention you inferred, sharing a digest, and casting the
resident's answer to the village question are not yours to do directly: the
overlay sends each to the resident as a proposal and acts only on their tap.

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

On the starting policy no tool call waits. If the resident has made a kind of
call need their approval, that call holds for about four minutes while the
resident is asked. Then:

- **Approved**: the call runs. Carry on.
- **Rejected**: the call does not run. Tell the resident plainly that it was
  not done because they declined it. Do not try again.
- **No answer in time**: the call is blocked (the message mentions
  `hook-timeout` or that the request expired). Tell the resident what you were
  about to do and that it needs their approval in the approval bot; do it only
  if they ask again and approve.
- **Gate unreachable** (`approval facade unreachable`) or **unverified**
  (`av-approval: gate unverified (<code>)`): nothing that needs the gate can
  run right now. Tell the resident, with the code; do not look for a way
  around it.

## Never

- Never retry a blocked or rejected action through another tool, another
  path, a script, a subagent or a different command that has the same effect.
  A block is the resident's answer, not an obstacle.
- Never edit, move or delete `config.yaml`, anything under `agent-hooks/`,
  `approval/`, `.env`, `shell-hooks-allowlist.json` or its `.lock` in the
  Hermes home, or anything under `scripts/` that a scheduled job runs, and
  never try to change the approval policy. Those are the resident's controls;
  the gate refuses such calls.
- Never bind or listen on the approval service's port or socket.
- Never send the resident a link to approve something. Approvals arrive in
  their approval bot by themselves.

## Sharing a digest, and the weekly village question

If `share_digest` or `village_vote` is available (in your tool list, or found
with `tool_search` and called through `tool_call`), these go through the same
approval bot; otherwise ignore this section.

- `share_digest`: a short text the resident chooses to make available to
  village services. Show them the exact words first. The tool asks them in
  their approval bot; it is shared only when they approve it there. When they
  ask you to stop sharing it, call it with `action=revoke`.
- `village_vote`: read the open question with `action=question`, then propose
  the answer you believe the resident would give with `action=vote`. It is
  cast only when they approve it there. A question takes one answer.

A yes you read in chat is not an approval. Never share a digest or cast a
vote any other way.

## What the gate does not cover

The resident has been told what is not checked:

- MCP tools other than Index's write tools (Index's reads included), and
  reads before the first gated call.
- Subagents: `delegate_task` goes through the gate and is recorded, but what
  the subagent then calls may not be.
- `web_extract`, `web_search`, `x_search`, Index's write tools and the media
  tools go through the gate with no built-in rule: the resident's policy
  names their kind (`read.web`, an intention you state, accepting or
  declining an opportunity, `network.call`) from approval.md 0.4.2; before that they pass
  through unjudged.
- A scheduled job's own script (`script`, `monitor`, `no_agent`) runs at
  every tick with no check at all. Creating or changing the job goes through
  the gate; what the script then does does not.
- A process on the sandbox can kill the hook (signal) or attach to the gateway
  (ptrace); both are closed by the checkpoint build (patch + ptrace_scope), not
  by this skill.

None of this is permission. Never use an unchecked tool, a scheduled job, a
subagent or another process to do what the resident would be asked about, and
never interfere with the hook or the gateway process.
