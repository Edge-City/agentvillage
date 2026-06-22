---
name: token-usage-audit
description: Deterministic tenant-local token usage audit for AgentVillage Hermes installs. Runs as a script cron and wakes the agent only when a clear actionable token-spend driver is found.
---

# Token Usage Audit

This skill owns the local token usage audit cron. It is operational plumbing for the resident's agent, not a chat skill the agent should mention by name.

## What It Does

The script at `scripts/audit_token_usage.py` reads only tenant-local operational metadata:

- Hermes dashboard session summaries from `http://127.0.0.1:9119/api/sessions?limit=500`
- local cron metadata from `cron/jobs.json`
- metadata-like local JSON/JSONL files only as a fallback when dashboard usage is unavailable

It does not call an LLM. It does not emit raw message content, prompts, raw session ids, private hosts, secrets, env values, or profile/memory prose. Session ids are used only for in-process grouping and become ordinal refs like `session_001`.

## Cron Contract

The AgentVillage installer creates one Hermes cron:

- name: `Edge — token usage audit`
- default schedule: `0 9 * * *` with deterministic per-tenant staggering
- delivery: Telegram only after the script wake gate returns `wakeAgent:true`
- skill: `token-usage-audit`
- script: `skills/token-usage-audit/scripts/audit_token_usage.py`

The script prints a final JSON line. When no action is needed, the line is:

```json
{"wakeAgent":false}
```

When action is needed, the script prints a short sanitized agent prompt plus a final JSON line with `wakeAgent:true`. The agent should use only the facts in that prompt, keep any user-facing message brief, name a likely cron only when confidence is high or medium, and suggest pausing/reporting the driver. If attribution is unknown or ambiguous, say that plainly instead of guessing.

## Alert Policy

Defaults:

- lookback: 24 hours
- cooldown: 72 hours per driver
- state file: `memory/token-usage-audit.json`
- total usage threshold: 100,000 tokens before spend-driver alerts

The script wakes only for actionable drivers, such as:

- cron-source usage is at least 60% of meaningful total usage
- one known cron is at least 40% of usage and at least 50,000 tokens
- one session is at least 250,000 tokens
- unknown scheduled-work bucket is very large, but emitted as unknown rather than guessed
- low-budget metadata is present and indicates a near-exhausted token budget

Operators can opt out at install/reconcile time with `TOKEN_USAGE_AUDIT_CRON=off` or `--skip-token-usage-audit-cron`.

## Manual Validation

From the Hermes root:

```bash
python3 skills/token-usage-audit/scripts/audit_token_usage.py --json-only
```

The output must be sanitized aggregate JSON. On quiet runs, normal cron output should end with `{"wakeAgent":false}`.
