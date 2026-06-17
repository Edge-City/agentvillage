---
name: memory-workspace
description: Hermes memory workspace setup, session rendering, distilled forum/IRL notes, secret-safe scanning, and memory index maintenance for AgentVillage runtimes.
version: 0.1.0
---

# Memory Workspace

This is AgentVillage memory infrastructure, not Index Network procedural knowledge. Use it for runtime/admin work that installs or maintains the Hermes memory workspace under the active Hermes root.

## When To Use

- Setting up or checking `memory/` folders, rendered Hermes session Markdown, forum notes, IRL notes, or staged memory nudges.
- Installing or repairing the silent Hermes memory heartbeat cron.
- Checking provider environment presence without printing values.
- Running secret-safe scans over rendered memory output.
- Running explicit memory index status/init/refresh commands during operator bootstrap or maintenance.

## Runtime Rules

- Do not mention internal memory plumbing, Enzyme, paths, files, or commands in ordinary attendee-facing answers unless the user asks about internals.
- Treat the memory index as an evidence router only. Verify cited files or live sources before making factual claims, writing durable records, or sharing outward.
- Do not run unattended index refresh from the heartbeat path. Automatic refresh is a separate opt-in cron and must use provider env only.
- Never print secret values. Secret checks report presence, counts, kinds, and paths only.

## Scripts

Scripts live directly in `scripts/`:

- `setup_workspace.py` installs folders, config references, cron wrappers, and optional index refresh support.
- `cron_prepare.py` renders bounded context for the silent memory heartbeat.
- `workspace_loop.py` stages or skips optional memory nudges after heartbeat notes are written.
- `render_hermes_sessions.py` and `render_vault_sessions.py` materialize transcript-shaped provenance.
- `prepare_forum_context.py`, `prepare_irl_context.py`, `write_forum_observation.py`, and `write_irl_daily.py` handle distilled note preparation/writes.
- `scan_vault_secrets.py` and `secret_redaction.py` provide secret-safe validation.

See `README.md` for operator commands and rollout details.
