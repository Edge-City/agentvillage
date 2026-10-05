# The outcome ask: `outcome.asked` and the resident's answer (DATA-42, overlay half)

Status: design note, 2026-10-05, for a ruling before any code. Stacked on PR #196
(brief-lite). Data-repo references are to `agentvillage-data` origin/main; Hermes
references are to `~/.hermes/hermes-agent` at tag `v2026.9.24`.

## 0. Read this first: the evening job asks no outcome question today

The premise was that the 19:00 evening-questions job asks "did you meet, was it
useful?". On the base branch it does not. `askQuestions` picks a **pending**
opportunity that has not been acted on (`skills/index-network/scripts/ask-questions.ts:127-143`),
`eveningView` hands the model a name and two links (`proactive.ts:360-368`), and the
prompt asks for "one warm line saying this person is still waiting to hear from the
user" (`skills/edge-esmeralda/prompts/ask-questions.md:9`). That is a reminder about a
match. Nothing has happened yet that could have an outcome. An `outcome.asked` on it
would be false.

The only outcome question the agent asks today is at 14:00. The people follow-up lists
newly **accepted** connections (`summarize-negotiations.ts:395-396`, each listed once,
`:410`). The prompt then adds, after each one, "After you follow up, reply met, not
useful, or missed" (`prompts/negotiation-summary.md:26`). One message can name up to six
people (`LIST_MAX`, `proactive.ts:70`). This is the catalogue's `connection_followup`
ask (`research/catalogue.md:100`, `B.connections_met`). Also: the DATA-42 task itself
is marked "CUT 2026-09-28 to the fallback: manual outcome.reported endpoint + operator
broadcast" (its notes, line 36).

So the first ruling needed is **which message is the ask** (section 6). The mechanism
below works the same whichever job it is.

## 1. What `outcome.asked@1` requires, and where each value comes from

The registration is `src/schemas/index.ts:1716-1727`:

- `message_hash` (required key, nullable string). Value: the plugin's keyed hash
  (`Collector.keyed_hash`, `_collector.py:1124`) of the model's final reply in the
  cron session. That is exactly the `content_hash` the same session's `message.out`
  already carries (`__init__.py:186-232`), so the two join. It is **not** a hash of the
  bytes Telegram showed. Unless `cron.wrap_response: false` is set, Hermes wraps the
  delivered text in a "Cronjob Response: <name>" header and footer
  (`cron/scheduler_delivery.py:1944-1963`). It can also prepend a fallback-model notice
  (`cron/scheduler.py:2531-2535`). The overlay sets neither, and I could not check the
  fleet's `config.yaml`. In `metadata` capture it is null, as `message.out`'s is.
- `window_days` (required, int32, cast `::integer` in staging). Value: the number of
  days the ask stays answerable under the answer rule in section 2. I propose `1`. The
  task text says `outcome.unknown` after 7 days, but that is the server's timeout job,
  which the plugin may not send (`src/evidence.ts:225-237`).
- `asked_by` (required, open string; §4.1 vocabulary `outcome_cron | connection_followup`).
  Value: `outcome_cron` for an evening ask, `connection_followup` for the 14:00 one.
- Envelope `outcome_id` (required ref, `REQUIRED_REFS`, `index.ts:2419`; an id of
  `^[A-Za-z0-9._:-]{1,128}$`). Value: deterministic per subject,
  `opp-outcome:<opportunity_id>`. A re-ask, the 14:00 and 19:00 asks about one person,
  and the answer all land on one outcome object. `core.outcomes` takes the earliest
  ask (`dbt/models/core/outcomes.sql`, `asked` CTE).
- Envelope `opportunity_id`: the Index opportunity id the trigger picked. It is the
  same raw object id the Index poller stamps (`src/jobs/index-poller.ts:3191`), so
  `opportunity_outcome` (`dbt/models/core/opportunity_outcome.sql`) links the outcome.
  The funnel then reaches the intention through the opportunity (`marts/intention_funnel.sql:498-500`).
  No `intention_id` is sent: the trigger does not know it, and guessing one would take
  ownership away from that path (pref 1 beats pref 3).
- `evidence_class`: the plugin's default `agent_report`. Asks never classify, so the
  class does not matter (`outcomes.sql`, header).
- `session_id`, `run_id`: from the cron session. Hermes's `task_id` is
  `cron:<job_id>:<execution_id>` (`cron/scheduler.py:2302`), which also gives the
  execution id.

**The hand-off.** The trigger knows the subject. The plugin sees the reply. A pre-run
script gets no job or execution id in its environment (`cron/scheduler_script.py`,
`build_subprocess_env`), so the link is by action name and time:

1. Trigger (`proactive.ts`, the asking action only). When it wakes the model, inside
   the existing lock and next to `markDone` (`proactive.ts:479-480`), it writes
   `$HERMES_HOME/av-events/proactive/outcome-ask-<action>.json`. The file is 0600,
   written by temp file and rename (the existing `writePrivateJson`). Contents:
   `{v, action, date, staged_at, asked_by, window_days, subjects: [{outcome_id, opportunity_id}]}`.
   Ids only, no names. The pick function returns its `opportunityId` (one added field,
   `ask-questions.ts:96-105` drops it today). Cleaning and scanning are not touched.
2. Plugin, `post_llm_call` of a cron session. It acts only when the job id is in
   `installed_jobs.json`, `jobs.json` gives it the installer's name for that action
   (`_cron.py` helpers, as for `cron.run`), and a stage file for the action exists
   with `staged_at` under 15 minutes old. Then it **renames** the stage file to
   `outcome-ask-armed/<execution_id>.json` and adds the message hash. The rename is
   atomic, so the gateway and an external cron worker cannot both take it.
3. Plugin, the flusher's cron tail (`_collector.py:1162-1171`). When that execution's
   terminal ledger row appears, it emits one `outcome.asked` per subject and deletes
   the armed file. This happens only when `delivery_outcome` is `delivered` or `queued`,
   or is null with `status = completed` on a Hermes without the column. The scheduler
   writes the outcome at `cron/scheduler.py:3076-3091`.

Edge cases:

- **`[SILENT]`** (`_messages.is_silent`, the same test Hermes applies at
  `scheduler.py:2985-2993`): the stage file is deleted at step 2 and nothing is armed.
  Log code `outcome_ask_silent`.
- **Delivery failed, suppressed or `not_configured`**: the armed file is deleted at
  step 3 with no event. The code goes to the log.
- **The run dies before `post_llm_call`**: the stale stage file is ignored after 15
  minutes and overwritten by the next stage.
- **A process exits between steps**: armed files are on disk, and the next process's
  tail finishes them. Armed files older than 72 hours are dropped, the same horizon
  the tail uses (`_cron.py`, `pending_runs`).
- **Two triggers race**: same action, same day, the second is `done-today`
  (`proactive.ts:472`) and stages nothing. Catch-up runs of different jobs back to
  back (`cron.catch_up_missed`) use separate files per action, bound by job name. A
  crash between buffering the event and deleting the file can send a second
  `outcome.asked` with a new uuid7. It has the same `outcome_id`, and `core.outcomes`
  keeps the earliest, so it does no harm.

One subject-loss caveat: the trigger marks the subject as used when it wakes the
model, as every job does today (`proactive.ts:21`). A silent or failed run then loses
that ask. I propose accepting this for v1.

## 2. The answer

**What carries it.** `outcome.reported@1` (`index.ts:1729-1741`): `value` (open string;
§4.1 `met | useful | not_useful | missed | did_not_happen`), `matcher_version`, and the
envelope's `outcome_id` and `in_reply_to_event_id`. `outcome_id` is deliberately not
required (`index.ts:2420-2423`): an answer that cannot say which ask it answers is
still stored, and skipped by `core.outcomes`. There is no `outcome.answered`.

**Can the overlay emit it honestly?** Yes, as the resident's own word. The plugin
claims `evidence_class: self_report` with `actor: participant`, which is below the
plugin cap, so the class is stored as sent (`evidence.ts`, `capFor`). The schema
already keeps it from touching the verified measure:

- `reported` maps only to `reported_useful` or `not_useful` (`outcomes.sql:125`).
- `verified_useful` requires an `outcome.verified` at `platform_record` or stronger,
  from a corroborating token (`outcomes.sql:145-146`).
- A plugin token may not send `outcome.verified`, `outcome.not_useful` or
  `outcome.unknown` at all (`evidence.ts:225-237`).

No new field is needed to mark it.

**How the agent knows a message is an answer.** The options:

- (a) **Telegram reply-to.** Hooks get no reply id (`pre_llm_call` kwargs,
  `agent/turn_context.py:757-769`). The only trace is the
  `[Replying to your previous message: "…"]` prefix the gateway puts on the user text
  (`gateway/run_inbound.py:1581-1590`). Matching the quote against the delivered text
  needs the wrapper reproduced, and the hook may be handed the clean words. Unverified.
  Few residents use reply. Wrong when the quote is truncated. It is a later precision
  boost, not a mechanism.
- (b) **The next resident message, matched strictly, in the plugin.** On a
  participant `message.in` (not cron, not a subagent, not an injected turn; the
  existing classification at `__init__.py:214-222`), normalise the whole message: lower case,
  punctuation and emoji stripped, whitespace collapsed. Match it against a short fixed
  table: `met`, `we met` → `met`; `useful` → `useful`; `not useful` → `not_useful`;
  `missed` → `missed`; `did not happen`, `didn't happen` → `did_not_happen`. Only a
  whole-message match counts. Cost: one small module and tests, no prompt change, no
  tool, nothing new for the model. It is wrong when a bare "met" is about something
  else (rare as a whole message). It misses sentences ("yes, great chat"): low recall,
  high precision.
- (c) **A tool the model calls** (`record_outcome(value)`). Better recall on
  sentences. But it is the model's reading, not the resident's word (so
  `agent_report`), and it can fire unprompted or credit the wrong person. It also needs
  a new tool and edits on every prompt path, and its behaviour drifts with the model.
- (d) **Buttons.** Hermes cron delivery sends plain text. Inline keyboards and callback
  handling are gateway changes we do not own at the pinned tag. Not before Oct 11.
- (e) **A server-side matcher over the archived text** (the data half). It would store
  as `derived`, which is what DATA-42 AC #1's wording expects. But it works only for
  consenting tenants in `full` capture, runs at the text loader's daily latency, and is
  the other orchestrator's work. Its precision is the same as (b).

**Recommendation: (b), one open ask at a time.** A reply counts only for the most
recent delivered ask message. That message must have named exactly one subject, and
the reply must come before the next ask message goes out and within 24 hours (hence
`window_days: 1`). The plugin keeps that one open ask in
`av-events/outcome-open.json`. On a match it emits `outcome.reported` with `value`,
`matcher_version: outcome_reply_v1`, `self_report`, `actor: participant`, the ask's
`outcome_id` and `opportunity_id`, and `in_reply_to_event_id` = the ask's event id, then
closes the ask. A matching reply while the last ask named several people is emitted
with `outcome_id` and `in_reply_to_event_id` null, which is AC #1's case. Nothing is
emitted in `metadata` capture, because the value is derived from content. No text and
no hash of the reply goes into the event: the reply's own `message.in` already carries
its hash.

## 3. Schema and data-repo changes

No new registration and no payload change: both payloads above fit `@1` as registered.
One data-repo change is needed, and it is not a schema change. The producer allowlist's
`plugin` row (`src/evidence.ts:409-451`) lacks `outcome.asked` and `outcome.reported`.
The comment at `:383-384` says §4.1 names the plugin for `outcome.asked` but the plugin
"emits none". Until both are added, ingest stores every one of these events in
quarantine as `producer_not_allowed` (`evidence.ts:223`). Quarantine drops nothing, and
`bun run quarantine:replay` re-checks the allowlist with the original token's
provenance (`src/ingest/replay.ts:155`), so events from Oct 11 can be re-admitted once
the row lands. The proposal for `agentvillage-d4`:

- Add `"outcome.asked"` and `"outcome.reported"` to `PRODUCER_ALLOWLIST.plugin`.
- Update `tests/token-class.test.ts`'s list of the plugin's emitted types, including
  any new plugin module it reads.
- Reword DATA-42 AC #1 from `derived` to `self_report`: a plugin token cannot store
  `derived` for a non-structural type.
- Confirm that quarantine rows are kept until replay.

## 4. Before Oct 11, with no schema change

Can ship:

- The stage, arm and emit path for whichever message is ruled the ask.
- The strict reply matcher.
- Tests for both.

Events quarantine until the allowlist row lands, then replay.

Cannot ship:

- Ingest accepting the events on day one without d4's allowlist change.
- `verified_useful` from anything the plugin does (by design).
- `outcome.unknown` (the server's timeout job).
- Reply-to precision, buttons, or recall on sentences.

## 5. Tests and the canary

**Bun** (`skills/index-network/scripts/tests/proactive.test.ts`, `ask-questions.test.ts`):

- The asking action stages one 0600 file with the ids when it wakes.
- It stages nothing when silent, `done-today`, `scan-blocked` or `name-withheld`.
- The Script Output still carries no id.
- The pick returns `opportunityId`.

**Pytest** (new `plugins/av-events/tests/test_outcome_ask.py`):

- Arming: an installed evening job arms, and its hash equals the session's
  `message.out` `content_hash`. A silent reply removes the stage. A stale stage, a job
  id outside `installed_jobs.json`, or a participant job carrying the installer's name
  arms nothing. Two collectors racing the rename arm once.
- The tail: `delivered`/`queued` emits one `outcome.asked` per subject with every key.
  `failed`/`suppressed`/`not_configured` emits none. An armed file survives a restart.
  Files older than 72 hours are dropped. In `metadata` capture `message_hash` is null.
- The matcher: the table, case and punctuation; sentences, injected, cron and subagent
  turns ignored. A multi-subject ask gives null refs. A reply after the next ask or
  after 24 hours gives nothing. `outcome.reported` carries `self_report`, `participant`
  and `in_reply_to_event_id`. Nothing in `metadata` capture. No payload value equals
  the reply text.
- Kill switches and fail-open, as the existing suites do.

**Live canary** (Carter's dogfood tenant, after the ruling's build is rolled):

1. Run the asking job with one known subject. `triggers.jsonl` shows `woke`, and the
   stage file appears and then is gone.
2. The buffer holds an `outcome.asked` whose `message_hash` equals that session's
   `message.out` `content_hash`, with the right `outcome_id`, `opportunity_id` and
   `asked_by`. The same execution's `cron.run` shows `delivery_outcome: delivered`.
3. Reply `met` in Telegram. One `outcome.reported` (`self_report`) follows, whose
   `in_reply_to_event_id` is the ask's event id.
4. Make a run reply `[SILENT]`. It produces no `outcome.asked`.
5. On the data side: `producer_not_allowed` quarantine rows until the allowlist lands.
   After replay, one `core.outcomes` row with `reported_useful`, linked through
   `opportunity_outcome`.
6. Incidentally: whether `pre_llm_call` sees the reply-to prefix, for option (a) later.

## 6. Rulings needed

1. **Which message is the ask.** Three choices:
   - (R1) Instrument only the 14:00 follow-up as it is. No product change, but most
     replies cannot be attributed when it names several people.
   - (R2) Make the evening job the outcome ask, as DATA-42 described: one accepted
     connection the follow-up announced at least two days earlier and not yet asked,
     the prompt "Did you and <name> meet? Reply met, not useful, or missed."
     Otherwise it falls back to today's reminder. Drop the "reply met, not useful, or
     missed" clause from the 14:00 line, so that only one question is ever open.
   - (R3) Both, accepting more unattributed replies.

   I recommend R2. It is a product change to the evening pick and two prompts. The
   trigger's cleaning and scanning are untouched.
2. The answer rule (b), with `window_days: 1`.
3. Carry the allowlist proposal in section 3 to `agentvillage-d4`.
