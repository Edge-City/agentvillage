---
name: village-pulse
description: one+1's collective-intelligence + per-human preference layer for Edge Esmeralda. Helps the resident's agent get to know them (a short profile, light daily questions, and a check-in after events they attend), predict what they'll choose and enjoy, and bring a daily "Village Pulse" — plus ask "what would the village think of X?" Read on first run, on the daily pulse cron, after an RSVP'd event ends, or when the user says "village pulse", "Edge check-in", "what does the village think", "ask the village", or "should I…".
version: 0.2.0
author: one+1 (Thursday Strategy)
tags: [village, collective-intelligence, preferences, prediction, feedback, edge-esmeralda]
required_environment_variables:
  - name: VILLAGE_API_BASE_URL
    required_for: all calls (the deployed one+1 Village API, e.g. the staging backend URL)
  - name: VILLAGE_HUMAN_ID
    required_for: attributing the resident's answers (default to the user's name if unset)
  - name: X_VILLAGE_KEY
    required_for: optional shared key sent as the X-Village-Key header, if the deployment requires it
metadata:
  openclaw:
    requires:
      config:
        - env.vars.VILLAGE_API_BASE_URL
---

# Village Pulse + Edge Companion — Edge Esmeralda

one+1 helps your agent understand its human and use that to shape a **better Edge** — and aggregates those
understandings into the village's collective judgment. **Edge is the product**: gather the resident's
feedback and preferences, predict what they'll choose and enjoy, and learn from how those predictions
compare to what actually happens. This skill carries the Edge-flavored conversation; the one+1 Village API
does the prediction (real-LLM, grounded in the resident's own history) and the measurement.

Base URL: `$VILLAGE_API_BASE_URL`. No login. Send `X-Village-Key: $X_VILLAGE_KEY` only if set.
Identify the resident with `human_id` = `$VILLAGE_HUMAN_ID` (fall back to the user's name).

## When to read each file
- **First-run consent + profiling** → §1.
- **After an RSVP'd event ends (cron/trigger or "Edge check-in")** → §2. *This is the most valuable flow.*
- **Daily Village Pulse (cron or "run my village pulse")** → §3.
- **"What would the village think of X?"** → §4.
- **Cron + post-event trigger** → [heartbeat.md](heartbeat.md). **Exact Telegram wording** → [exemplars.md](exemplars.md).

## 0. Consent + dignity (read first)
- **First run only:** ask once — *"Want me to get to know you so we can shape a better Edge for you? A quick
  profile now, a light question a day, and a check-in after events you attend. (yes / no)"* Store the
  answer in `memory/village-pulse.json` (`autoCompanion`, `autoPulse`). Re-ask only if they raise it.
- **Frequency caps:** at most one daily drop + check-ins only for events the user **RSVP'd to**. Never nag;
  everything is skippable; offer audio instead of typing.
- The human owns this data and it helps *them*. Never paste anything they marked private. No destructive
  operations exist in this skill — these are the user's own opinions + reads.

## 1. Onboarding profiling (after consent)
Before asking anything, call `GET $VILLAGE_API_BASE_URL/api/village/profile/$VILLAGE_HUMAN_ID`.
- If `has_profile: true` — show a one-line summary of the existing answers (*"You told me: …"*) and ask
  if there's anything to update. Skip any questions already answered unless the resident wants to revisit
  them. Profiles built by the Telegram bot or other agents count — the API is the source of truth, not local
  memory.
- If `has_profile: false` — run a short, warm survey (5–7 questions: what they're here to do, topics they
  care about, how they like to spend a day, what a great Edge week looks like). Accept audio.

Either way, merge the new/updated answers over any existing ones and:
`POST $VILLAGE_API_BASE_URL/api/village/profile` with `{ human_id, answers:{...} }`. This primes the twin;
predictions start rough and sharpen as input grows — that's expected.

## 2. Post-event check-in (the core loop)
Triggered after an event the user **RSVP'd to** ends (see heartbeat.md), or on "Edge check-in".
1. *"Checking in! Did you attend **[session]**? (Y/N)"*
2. If **no** → *"No worries — why didn't you make it to this one?"*
3. If **yes** → *"What did you think? Highlights, and anything you'd change? (you can record audio if you'd
   rather not type)"* → then *"If you could go back, would you attend again? (Y/N) — why?"*
4. `POST $VILLAGE_API_BASE_URL/api/village/events/<event_id>/feedback` with
   `{ human_id, attended, why?, highlights?, would_repeat?, audio_url? }`.
Before the event the twin already predicted attendance/enjoyment/would-repeat; this feedback is the ground
truth it's scored against. Keep it light — one or two messages, not an interrogation.

## 3. Daily Village Pulse
1. `GET $VILLAGE_API_BASE_URL/api/village/pulse/today?human_id=<id>` → `{question_id, text, village_context,
   already_answered}`. If `already_answered` and this is the cron → reply silently.
2. Present `text` warmly (it's generated from today's calendar/wiki, so it's timely). Ask **Agree /
   Disagree / Skip**; accept natural language. Optionally invite one line of "why" and *"what % of the
   village do you think agrees?"*.
3. `POST .../pulse/answer` with `{question_id, human_id, answer, why?, predicted_village_support_pct?}`.
4. Show the card: `{village_split, your_answer, your_prediction_vs_actual, participation_count}` in a line
   or two.

## 4. Ask the village about anything
When the user floats a decision: `POST $VILLAGE_API_BASE_URL/api/agent/review` with
`{agent_id, human_id, proposal, context, decision_type, desired_output}` (`decision_type` ∈ `event|
governance|resource|opportunity|intro|norm|other`; `desired_output` ∈ `quick_review|full_jury|
objections_only|framing_help`, default `quick_review`). Lead with `agent_summary` + `support_score`, then
the top objection + `recommended_framing`; offer the shareable proposal URL. Don't dump every field.

## Host-neutral silence
Reply-silently marker: Hermes → `[SILENT]`; OpenClaw → `NO_REPLY`; Claude Code → no user-facing text if the
host supports a silent turn, else stop without commentary.
