# Index Network — Heartbeat Tasks

Per-tick tasks for Index Network. Walked from the heartbeat tick described in `AGENTS.md` (Heartbeat section). This is background maintenance, not a chat check-in. **Silence is the default.** On Hermes, a silent tick ends with exactly `[SILENT]`.

Hard gates for every tick:

1. Read `memory/heartbeat-state.json` once at the start. Track task last-runs under `heartbeatTasks.<taskName>.lastRunAt` as ISO timestamps, plus each task's own dedup state. If the file is missing, treat state as `{}`.
2. Run only tasks whose interval is due. If no task is due, end with `[SILENT]`.
3. Run tasks in the order listed below. **At most one user-facing message per tick.** If any task sends or asks the user something, record its state, then stop immediately; do not continue into later tasks.
4. Never message just to say you checked, synced, found nothing, updated memory, or had an internal problem. If a tool or file read fails and the task cannot safely continue, end with `[SILENT]`.
5. For tasks that are due but produce no user-facing message, update `heartbeatTasks.<taskName>.lastRunAt` before moving on so the 30-minute heartbeat does not rerun daily/weekly work every tick.

---

tasks:

- name: accepted-opportunities
  interval: 30m
  prompt: |
    Someone may have accepted a connection on the user's behalf — the user wants to know.

    1. Call `list_opportunities(status="accepted_unnotified")` (or the equivalent — read the tool description).
    2. Filter out any opportunity id already present in `acceptedOpportunities.notifiedIds` in `memory/heartbeat-state.json`; this local dedup prevents repeated Telegram pings if the ledger confirmation call fails.
    3. If empty after filtering, update `heartbeatTasks.accepted-opportunities.lastRunAt`, write state, and end with `[SILENT]` unless a later due task should run.
    4. For each accepted opportunity you will mention:
       - Embed `acceptUrl` on a verb phrase like "send {Name} a message". The URL is a short backend redirect — paste it verbatim, do not append query parameters, do not compose a `t.me` URL. The greeting and Telegram handle resolution happen server-side.
       - If `acceptUrl` is missing, embed `conversationUrl` on "continue the conversation".
    5. Frame the notification warmly — this is good news. This is the only 30-minute task allowed to proactively message, and only for newly accepted, unnotified opportunities.
    6. For every opportunity you mention, call `confirm_opportunity_delivery(opportunityId, trigger="accepted")` once. Regardless of confirmation success, append its id to `acceptedOpportunities.notifiedIds` (keep the last 100), update `heartbeatTasks.accepted-opportunities.lastRunAt`, write state, and stop.

- name: telegram-handle-reconciliation
  interval: 24h
  prompt: |
    Detect drift between the resident's independent Edge systems before Telegram handles route introductions to the wrong person. Do not choose a canonical source silently; when sources disagree, ask the resident which handle is correct and update only after they answer.

    This runs in a fresh session with no memory of past runs — every decision below comes from files, environment, and tool/API reads. Resolve "today" as the calendar day in America/Los_Angeles for `memory/<today>.md`.

    1. Gate on pending/asked state. Read `memory/heartbeat-state.json` and `memory/<today>.md`. Reply silently and stop if either is true:
       - `telegramHandleReconciliation.pending` exists — the user has already been asked; wait for their answer in a normal conversation turn.
       - `telegramHandleReconciliation.lastAskedDate` equals today — do not re-ask the same day.
    2. Read candidate sources without mutating anything:
       - Index: call `read_user_profiles()` and extract the user's `telegram` social if present.
       - EdgeOS: if `EDGEOS_BEARER_TOKEN` is available, use the `edgeos` skill recipe `GET /api/v1/humans/me` and read its `telegram` field. If the value is the hidden sentinel `"*"`, treat it as unavailable, not a conflict.
       - Runtime host: read `INDEX_TELEGRAM_HANDLE` from the environment if available; this is the Telegram handle currently forwarded in Index MCP headers.
    3. Normalize every non-empty candidate for comparison: trim, strip a leading `@`, strip `https://t.me/` or `https://telegram.me/`, drop query/hash/path suffixes, and require `[A-Za-z0-9_]{5,32}`, then lowercase the result (Telegram usernames are case-insensitive, so a case-only difference such as `seref` vs `@Seref` is the same handle and must not count as drift). Keep both the raw and normalized forms in notes. Values that fail validation (for example `Lauren Tannhauser`) are invalid candidates and should trigger reconciliation if any system stores them.
    4. Decide:
       - If there are zero valid candidates and no invalid candidates, reply silently.
       - If there is exactly one valid normalized handle and no invalid candidates, reply silently. No system is drifting from another known system.
       - If there are two or more distinct valid normalized handles, or any invalid candidate exists, ask exactly one concise question: "I found conflicting Telegram handles in your Edge setup: EdgeOS: `<x>`, Index: `<y>`, runtime: `<z>`. Which Telegram username should I use? Reply with the handle only, without @."
         Omit unavailable sources from the sentence; label invalid values as "not a valid Telegram username".
    5. Record and stop after asking. Update `memory/heartbeat-state.json` preserving all existing keys, under:
       `telegramHandleReconciliation = { pending: true, lastAskedDate: "YYYY-MM-DD", sources: { edgeos, index, runtime }, askedQuestion: "..." }`.
       Append `[gate] index-network: telegram-handle-reconciliation asked` to `memory/<today>.md`.

    Do not call `update_user_profile`, patch EdgeOS, rerun the installer, or edit config in this heartbeat task. The user's answer arrives later in a normal conversation turn; handle it using `tools.md`.

- name: telegram-handle-reconciliation
  interval: 24h
  prompt: |
    Detect drift between the resident's independent Edge systems before Telegram handles route introductions to the wrong person. Do not choose a canonical source silently; when sources disagree, ask the resident which handle is correct and update only after they answer.

    This runs in a fresh session with no memory of past runs — every decision below comes from files, environment, and tool/API reads. Resolve "today" as the calendar day in America/Los_Angeles for `memory/<today>.md`.

    1. Gate on pending/asked state. Read `memory/heartbeat-state.json` and `memory/<today>.md`. Reply silently and stop if either is true:
       - `telegramHandleReconciliation.pending` exists — the user has already been asked; wait for their answer in a normal conversation turn.
       - `telegramHandleReconciliation.lastAskedDate` equals today — do not re-ask the same day.
    2. Read candidate sources without mutating anything:
       - Index: call `read_user_profiles()` and extract the user's `telegram` social if present.
       - EdgeOS: if `EDGEOS_BEARER_TOKEN` is available, use the `edgeos` skill recipe `GET /api/v1/humans/me` and read its `telegram` field. If the value is the hidden sentinel `"*"`, treat it as unavailable, not a conflict.
       - Runtime host: read `INDEX_TELEGRAM_HANDLE` from the environment if available; this is the Telegram handle currently forwarded in Index MCP headers.
    3. Normalize every non-empty candidate for comparison: trim, strip a leading `@`, strip `https://t.me/` or `https://telegram.me/`, drop query/hash/path suffixes, and require `[A-Za-z0-9_]{5,32}`, then lowercase the result (Telegram usernames are case-insensitive, so a case-only difference such as `seref` vs `@Seref` is the same handle and must not count as drift). Keep both the raw and normalized forms in notes. Values that fail validation (for example `Lauren Tannhauser`) are invalid candidates and should trigger reconciliation if any system stores them.
    4. Decide:
       - If there are zero valid candidates and no invalid candidates, reply silently.
       - If there is exactly one valid normalized handle and no invalid candidates, reply silently. No system is drifting from another known system.
       - If there are two or more distinct valid normalized handles, or any invalid candidate exists, ask exactly one concise question: "I found conflicting Telegram handles in your Edge setup: EdgeOS: `<x>`, Index: `<y>`, runtime: `<z>`. Which Telegram username should I use? Reply with the handle only, without @."
         Omit unavailable sources from the sentence; label invalid values as "not a valid Telegram username".
    5. Record and stop after asking. Update `memory/heartbeat-state.json` preserving all existing keys, under:
       `telegramHandleReconciliation = { pending: true, lastAskedDate: "YYYY-MM-DD", sources: { edgeos, index, runtime }, askedQuestion: "..." }`.
       Append `[gate] index-network: telegram-handle-reconciliation asked` to `memory/<today>.md`.

    Do not call `update_user_profile`, patch EdgeOS, rerun the installer, or edit config in this heartbeat task. The user's answer arrives later in a normal conversation turn; handle it using `tools.md`.

- name: signal-freshness
  interval: 7d
  prompt: |
    Once a week, prune.

    1. Call `read_intents()` for the user.
    2. If any signal older than 60 days has no recent matches, ask about **one** stale signal only: whether it's still active. If they say no later, call `update_intent(id, status="archived")`. If they say yes, leave it. If they ignore, leave it — re-ask next cycle.
    3. Record the asked signal id/date under `signalFreshness` and update `heartbeatTasks.signal-freshness.lastRunAt` before stopping.

    Skip silently if nothing is stale. Do not invent things to ask about. Never ask more than one freshness question in a tick.

- name: signal-elicitation
  interval: 24h
  prompt: |
    A thin-signal user gets no opportunities until we draw more signal out of them. Once a day, while the user has nothing live, ask one contextual question to elicit a new signal. Track dedup state in `memory/heartbeat-state.json` under `signalElicitation`.

    This runs in a fresh session with no memory of past runs — every decision below comes from tool calls and files, never from recall. Resolve "today" as the calendar day in the village's timezone (America/Los_Angeles, Pacific) — the same day used for the `memory/<today>.md` filename — so the once-per-day gate, the recorded date, and the note all agree.

    1. Gate on opportunities. Call `list_opportunities()` and read what comes back (check the tool description for the exact status values). If the tool says setup/onboarding is required, read `memory/<today>.md` and `memory/heartbeat-state.json`; if neither suppression nor `signalElicitation.lastAskedDate === today` is present, ask exactly: "I need a quick setup before I can find relevant people for you. Want to do that now?" Then update `memory/heartbeat-state.json` as in step 4 and append `[gate] index-network: setup-nudge asked` to `memory/<today>.md`. Do not say "Index" or "onboarding" to the user. If suppressed or already asked today, reply silently and stop. If the user already has any live opportunity — internal status `pending` or `accepted` (as returned by the tool, not the user-facing labels) — discovery is already working: reply silently using this host's no-reply marker and stop. Ignore declined, archived, or expired ones; they do not count as live. Do not ask anything.
    2. Gate on suppression and once-per-day. Read `memory/<today>.md` and `memory/heartbeat-state.json`. Reply silently and stop if either holds:
       - `memory/<today>.md` contains `[gate] index-network: suppressed by user` (the user dismissed setup today).
       - `signalElicitation.lastAskedDate` already equals today's date (you have asked once today).
    3. Build one contextual question. Call `read_intents()` and `read_premises()` to see what the user already has, then compose a single question grounded in it:
       - If a signal is thin or vague, ask something that sharpens it — e.g. a bare "looking for collaborators" becomes "What kind of collaborator are you after, and on what specifically?"
       - If the user has almost nothing, ask a broad opener — "What are you working on this week?" or "Open to anything new — collaborators, hiring, advice?"
       - Do not repeat a question close to one already in `signalElicitation.recentQuestions`. Vary it.
       Ask exactly one question. Calm, direct, short — no preamble, no "Great question!", no filler.
    4. Record and stop. After asking, update `memory/heartbeat-state.json`: set `signalElicitation.lastAskedDate` to today's date, increment `signalElicitation.askCount` (start at 1 if absent), and append the question you asked to `signalElicitation.recentQuestions`, keeping only the last 5. Preserve every other key in the file (e.g. `prepared`, `deliveredToday`) — read the whole object, add to it, write it back. Append the line `[gate] index-network: signal-elicitation asked` to `memory/<today>.md`, matching the established gate-note format.

    Do not call `create_intent` or `create_premise` here. The user's answer arrives later, in a normal conversation turn, and is captured then — see the "Capturing new signal in conversation" section of tools.md.
