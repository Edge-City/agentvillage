# Village Pulse + Edge Companion — Crons & Triggers

Register in the Hermes dashboard cron jobs (or fold the pulse into the 08:00 morning brief). Track
last-run + dedup state in `memory/village-pulse.json`.

---

tasks:

- name: post-event-checkin
  interval: 30m
  prompt: |
    Check in after events the user actually chose to attend. This is the most valuable signal — be warm
    and brief, never naggy.

    1. Read `memory/village-pulse.json`. If `autoCompanion` is not `true`, reply silently with this host's
       no-reply marker.
    2. Use the `edgeos` skill to list the user's RSVP'd events that **ended in the last ~2 hours** and that
       aren't already in `checkedInEventIds`.
    3. If none, reply silently.
    4. For the most recent one:
       a. Before check-in, fetch a prediction if one doesn't exist yet:
          `GET $VILLAGE_API_BASE_URL/api/village/predict?human_id=<id>&event_id=<event_id>&event_context=<title>`
          This pre-event prediction will be scored when feedback is recorded.
       b. Run the §2 check-in script from SKILL.md: "Did you attend [session]? Y/N"
          → if no, why; if yes, highlights/changes (audio ok) + "would you attend again? Y/N — why".
    5. `POST $VILLAGE_API_BASE_URL/api/village/events/<event_id>/feedback` with their answers.
    6. Add `event_id` to `checkedInEventIds`. Only one check-in per tick — don't batch-spam.

- name: daily-pulse
  schedule: "0 9 * * *"   # 09:00 local; or merge into the 08:00 morning brief
  prompt: |
    Bring the resident today's Village Pulse — one quick question. 10 seconds, not a survey.

    1. If `autoPulse` is not `true` in `memory/village-pulse.json`, reply silently.
    2. `GET $VILLAGE_API_BASE_URL/api/village/pulse/today?human_id=<id>`. If `already_answered`, reply
       silently — don't nag.
    3. Present `text` in one warm line; ask Agree / Disagree / Skip (+ optional "why", + optional
       "what % of the village agrees?"). See exemplars.md.
    4. On reply, `POST .../pulse/answer` and show the result card in one line.
    5. Record today's date as `lastPulseDate`.

    Never fabricate a question — only deliver what the API returns. If the API is unreachable, reply
    silently and retry next tick.

- name: onboarding-profile
  trigger: first_run  # fires once; guard with memory/village-pulse.json consent check
  prompt: |
    Run the onboarding profiling flow (§1 of SKILL.md) on first activation after consent.
    1. Read memory/village-pulse.json. If consent not yet given, skip.
    2. Check the API — don't rely on local memory alone:
       GET $VILLAGE_API_BASE_URL/api/village/profile/$VILLAGE_HUMAN_ID
       If has_profile: true, skip the full survey and show a brief summary; ask if anything needs
       updating. The API is authoritative — profiles built via Telegram or another agent count.
    3. If has_profile: false AND profileCompleted is not set in local memory, run the full 5-7 question
       survey.
    4. POST $VILLAGE_API_BASE_URL/api/village/profile with {human_id, answers:{...}}, merging new
       answers over any existing ones (don't wipe data already stored).
    5. Set profileCompleted: true in memory/village-pulse.json.
