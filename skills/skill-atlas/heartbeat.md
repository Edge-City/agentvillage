# Skill Atlas — Heartbeat Tasks

For hosts with a heartbeat tick (OpenClaw, Hermes). Hosts without one get the same behavior from Step 0 of every skill-atlas run.

## Task: edge-book-capability-sync

**Cadence:** at most once per day. Skip silently on every other tick.

**Condition:** run only when BOTH are true:
1. `~/.agentvillage/capability-registry.json` exists and contains at least one record with `"registration": "pending"`.
2. The Edge Book CLI is available — `edge-book capability list` exits 0 (or `EDGE_BOOK_CLI` is set and works).

**Action:**

```
bun scripts/register_capability.ts sync
```

**Reporting:**
- If the sync advertised one or more capabilities: send the user one short message naming which skills are now advertised on their Edge Book agent.
- If everything is still pending or there was nothing to do: reply silently per the host's silent-turn convention. Do not message the user about pending records — they have already been told once at generation time.
- Never loop or retry within a single tick; the next tick is the retry.
