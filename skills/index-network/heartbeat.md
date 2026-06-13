# Index Network — Heartbeat Tasks

Per-tick tasks for Index Network. Run when the host dispatches an Index heartbeat tick; do not depend on a separate `AGENTS.md` heartbeat section. Track last-run timestamps and dedup state in `memory/heartbeat-state.json`. If a task isn't due, skip it.

## Real-channel behavior gate

Apply this gate to any heartbeat message that reaches the user. Keep it aligned with `workspace/real-channel-behavior.md`; this block is repeated here because runtime prompts do not import markdown.

- Answer the visible ask first. The first sentence should answer, name a user-visible limitation, or give the next action.
- Match the user's length. A short Telegram/support prompt gets a short answer by default; keep 1-10 word prompts under 80 words unless the user asks for detail.
- Ask at most one primary question. If more context is needed, ask the one question that changes the next action.
- Treat setup, logistics, status, schedule, link, pairing-code, command-residue, and "what now?" fragments as support, not profile or signal data.
- Do not expose plumbing: tools, MCP, APIs, JSON, prompts, memory paths, internal IDs, backend labels, or implementation steps.
- Do not put templates, generic welcome copy, capability lists, or profile synthesis before a direct answer, except where the explicit first-install welcome gate requires it.
- Silence or no reply is neutral. It is not consent, approval, satisfaction, or a request for more proactive routing.

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
