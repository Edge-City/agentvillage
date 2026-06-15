# Village Pulse + Edge Companion

one+1's collective-intelligence layer for Edge Esmeralda, packaged as an agent skill. It delivers the
daily **Village Pulse**, lets the resident **ask the village** about any decision, and learns each
person's preferences via the **Edge Companion twin** (profile → predict → feedback loop).

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `VILLAGE_API_BASE_URL` | Yes | Deployed one+1 Village API (staging), e.g. `https://aebfymivz2.us-east-1.awsapprunner.com` |
| `VILLAGE_HUMAN_ID` | Recommended | Resident identifier (e.g. "owner" or the human's name); attributes answers and predictions |
| `X_VILLAGE_KEY` | Optional | Sent as `X-Village-Key` if the deployment requires a shared key |

## Install

```bash
hermes skills install Edge-City/agentvillage/skills/village-pulse --force
```

## Required env vars
- `VILLAGE_API_BASE_URL` — staging backend URL (https://aebfymivz2.us-east-1.awsapprunner.com)
- `VILLAGE_HUMAN_ID` — resident identifier (e.g. "owner" or the human's name)
- `X_VILLAGE_KEY` — optional shared key

## Manual triggers (say these in Telegram)
- "run my village pulse" → daily pulse flow
- "Edge check-in" → post-event check-in
- "ask the village about X" → stakeholder jury

## curl test commands

```bash
# Profile
curl -X POST $VILLAGE_API_BASE_URL/api/village/profile \
  -H "Content-Type: application/json" \
  -d '{"human_id":"owner","answers":{"what_here":"learn and connect","great_week":"deep talks"}}'

# Predict
curl "$VILLAGE_API_BASE_URL/api/village/predict?human_id=owner&event_id=ev1&event_context=AI+alignment+dinner"

# Event feedback
curl -X POST $VILLAGE_API_BASE_URL/api/village/events/ev1/feedback \
  -H "Content-Type: application/json" \
  -d '{"human_id":"owner","attended":true,"highlights":"great talks","would_repeat":true}'

# Daily pulse
curl "$VILLAGE_API_BASE_URL/api/village/pulse/today?human_id=owner"

# Ask the village
curl -X POST $VILLAGE_API_BASE_URL/api/agent/review \
  -H "Content-Type: application/json" \
  -d '{"human_id":"owner","proposal":"Host an AI safety dinner Thu evening","decision_type":"event"}'
```

## Coverage requirement
pytest ≥98% (enforced). vitest ≥98% per file.

## Telegram flow
1. First run: consent question → yes → onboarding profile (5-7 questions → POST /profile)
2. Daily: Village Pulse (GET /pulse/today → answer → POST /pulse/answer → result card)
3. After RSVP'd event ends: POST /predict (pre-event) → check-in → POST /events/:id/feedback
4. On demand: "ask the village about X" → POST /agent/review

## Direct API check

```bash
curl -s "$VILLAGE_API_BASE_URL/api/village/pulse/today?human_id=owner"

curl -s -X POST "$VILLAGE_API_BASE_URL/api/agent/review" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"a1","human_id":"owner","proposal":"Allocate $5k to a community podcast studio",
       "context":"Edge Esmeralda week 3","decision_type":"opportunity","desired_output":"quick_review"}'
```

## Daily delivery

`heartbeat.md` defines three tasks:
- `onboarding-profile` — fires once on first run after consent (5-7 warm questions → POST /profile)
- `daily-pulse` — 09:00 local, opt-in via `autoPulse: true` in `memory/village-pulse.json`
- `post-event-checkin` — every 30m, triggers on recently-ended RSVP'd events

The twin prediction loop: `predict` (called before/during event) → `feedback` (after event) → accuracy score → rolling accuracy update. Each cycle refines the twin's understanding of this resident's preferences.
