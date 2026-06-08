# Index Network — Heartbeat Tasks

Per-tick tasks for Index Network. Walked from the heartbeat tick described in `AGENTS.md` (Heartbeat section). Track last-run timestamps and dedup state in `memory/heartbeat-state.json`. If a task isn't due, skip it.

---

tasks:

- name: accepted-opportunities
  interval: 30m
  prompt: |
    Someone may have accepted a connection on the user's behalf — the user wants to know.

    1. Call `list_opportunities(status="accepted_unnotified")` (or the equivalent — read the tool description).
    2. If empty, reply silently using this host's no-reply marker.
    3. For each accepted opportunity:
       - Embed `acceptUrl` on a verb phrase like "send {Name} a message". The URL is a short backend redirect — paste it verbatim, do not append query parameters, do not compose a `t.me` URL. The greeting and Telegram handle resolution happen server-side.
       - If `acceptUrl` is missing, embed `conversationUrl` on "continue the conversation".
    4. Frame the notification warmly — this is good news.
    5. For every opportunity you mention, call `confirm_opportunity_delivery(opportunityId, trigger="accepted")`.

- name: signal-freshness
  interval: 7d
  prompt: |
    Once a week, prune.

    1. Call `read_intents()` for the user.
    2. For each signal older than 60 days with no recent matches: ask the user (in their last-active channel) whether it's still active. If they say no, call `update_intent(id, status="archived")`. If they say yes, leave it. If they ignore, leave it — re-ask next cycle.

    Skip silently if nothing is stale. Do not invent things to ask about.

- name: signal-elicitation
  interval: 24h
  prompt: |
    A thin-signal user gets no opportunities until we draw more signal out of them. Once a day, while the user has nothing live, ask one contextual question to elicit a new signal. Track dedup state in `memory/heartbeat-state.json` under `signalElicitation`.

    This runs in a fresh session with no memory of past runs — every decision below comes from tool calls and files, never from recall. Resolve "today" as the calendar day in the village's timezone (America/Los_Angeles, Pacific) — the same day used for the `memory/<today>.md` filename — so the once-per-day gate, the recorded date, and the note all agree.

    1. Gate on opportunities. Call `list_opportunities()` and read what comes back (check the tool description for the exact status values). If the user already has any live opportunity — internal status `pending` or `accepted` (as returned by the tool, not the user-facing labels) — discovery is already working: reply silently using this host's no-reply marker and stop. Ignore declined, archived, or expired ones; they do not count as live. Do not ask anything.
    2. Gate on suppression and once-per-day. Read `memory/<today>.md` and `memory/heartbeat-state.json`. Reply silently and stop if either holds:
       - `memory/<today>.md` contains `[gate] index-network: suppressed by user` (the user dismissed Index Network today).
       - `signalElicitation.lastAskedDate` already equals today's date (you have asked once today).
    3. Build one contextual question. Call `read_intents()` and `read_premises()` to see what the user already has, then compose a single question grounded in it:
       - If a signal is thin or vague, ask something that sharpens it — e.g. a bare "looking for collaborators" becomes "What kind of collaborator are you after, and on what specifically?"
       - If the user has almost nothing, ask a broad opener — "What are you working on this week?" or "Open to anything new — collaborators, hiring, advice?"
       - Do not repeat a question close to one already in `signalElicitation.recentQuestions`. Vary it.
       Ask exactly one question. Calm, direct, short — no preamble, no "Great question!", no filler.
    4. Record and stop. After asking, update `memory/heartbeat-state.json`: set `signalElicitation.lastAskedDate` to today's date, increment `signalElicitation.askCount` (start at 1 if absent), and append the question you asked to `signalElicitation.recentQuestions`, keeping only the last 5. Preserve every other key in the file (e.g. `prepared`, `deliveredToday`) — read the whole object, add to it, write it back. Append the line `[gate] index-network: signal-elicitation asked` to `memory/<today>.md`, matching the established gate-note format.

    Do not call `create_intent` or `create_premise` here. The user's answer arrives later, in a normal conversation turn, and is captured then — see the "Capturing new signal in conversation" section of tools.md.
