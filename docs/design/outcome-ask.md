# The evening outcome ask: `outcome.asked` and the resident's answer (DATA-42, overlay half)

Status: **as built**, 2026-10-05, after the orchestrator's rulings on the design note (R2 and
rulings 1 to 7). Data-repo references are to `agentvillage-data` origin/main. Hermes references are
to `~/.hermes/hermes-agent` at tag `v2026.9.24`.

## What changed from the design note

On the base branch the 19:00 evening job asked no outcome question. It reminded the resident about
a *pending* match. The only outcome question was the 14:00 follow-up's line under each new
connection, "After you follow up, reply met, not useful, or missed", and one message could name up
to six people. Ruling R2 made the evening job the outcome ask and removed that line, so at most one
question is ever open.

## 1. The ask (the trigger's half)

**Announcement date.** The 14:00 follow-up already records each newly accepted connection it
announces, once (`negotiationSummary.reportedCompletedIds`). It now also records the village date
it announced each one: `negotiationSummary.announcedOn`, in
`skills/index-network/scripts/summarize-negotiations.ts` at the write near line 429. Connections
reported before this change have no date. The evening run dates them "today", so they become due
two days later (`backfillAnnounced`, `outcome-ask.ts:105`).

**The pick.** The evening action (`proactive.ts:626`, `eveningAction`) first tries the outcome ask
(`outcomeAskDecision`, `proactive.ts:586`). A subject is due (`dueSubjects`, `outcome-ask.ts:138`)
when all of these hold:

- the follow-up announced it `DUE_AFTER_DAYS` = 2 or more village days ago;
- it is not in the plugin's asked ledger `av-events/proactive/outcome-asked.json`;
- the trigger has not already staged it today;
- the trigger has staged it on fewer than `MAX_ATTEMPTS` = 3 evenings;
- its id can be an envelope id.

The oldest announcement goes first, then the lowest id. Only when something is due does the
evening read Index (`list_opportunities`, status `accepted`). It then takes the first due subject
that Index still lists as accepted.

**The question.** The name goes through `cleanName`, the same path as every other name. The
Script Output is `{job: "evening-note", date, outcomeQuestion}`, and `outcomeQuestion` is exactly
`Did you and <name> meet? Reply met, not useful, or missed.` (`outcomeQuestion`,
`outcome-ask.ts:49`). The evening prompt (`skills/edge-esmeralda/prompts/ask-questions.md`) says to
deliver it word for word and nothing else. It keeps the Script Error line every prompt now carries.
The text is scanned with the rest of the Script Output as before. The trigger's cleaning and
scanning are unchanged.

**Falling back.** The evening writes today's reminder, exactly as before, in each of these cases.
None of them records anything about the subject, which stays due:

- nothing is due;
- Index cannot be read;
- the due connection is no longer listed;
- no listed due subject has a name that cleans. A subject whose name does not clean is passed over that evening and the next due subject is asked. The skipped subject records no attempt, stays due, and is counted in the run log's `withheld`.

The reason is a code in `triggers.jsonl` (`detail`: `outcome-ask`, `outcome-ask-none-due`,
`outcome-ask-index-unavailable`, `outcome-ask-not-listed`, `outcome-ask-name-withheld`).

**The stage file.** When the trigger wakes the model with the question, it writes
`av-events/proactive/outcome-ask-evening.json` (`writeStage`, `outcome-ask.ts:179`). The file is
0600 in a 0700 directory, written by temp file and rename. It holds ids only:
`{v, action, date, staged_at, asked_by: "outcome_cron", window_days: 1, subjects: [{outcome_id, opportunity_id}]}`,
with `outcome_id` = `opp-outcome:<opportunity id>`.

The write happens inside the state lock, just before the day mark (`proactive.ts:701`). A stage
that cannot be written leaves the run silent with the day unmarked. The run records the attempt
(`outcomeAsk.attempts`), not an ask.

Every evening run first removes any stage left by an earlier run (`clearStage`, `proactive.ts:629`).
Without that, a reminder written later could be armed as an ask. Two triggers racing leave one
stage: the second is `done-today` under the lock. The once-per-day mark now counts a mark of today
or tomorrow (`doneToday`, `proactive.ts:244`), so a clock that moved back is silent and stages
nothing. A corrupt state file is renamed aside (`readStateHealing`, `proactive.ts:197`). The run
then starts from empty, which drops the announcement dates and attempts with it, and nothing is
due until the follow-up announces again.

## 2. Arm, confirm, emit (the plugin's half)

This is `plugins/av-events/_outcome_ask.py`, wired in `__init__.py:185-290` and
`_collector.py:1199` (`outcome_tick`, run on the cron tail's one-minute cadence).

**Arm** (`arm`, `_outcome_ask.py:230`, from `post_llm_call`). Cron sessions are handled
explicitly: arming runs only in a cron session (`_is_cron_session`), and only for a Hermes task id
of the form `cron:<12 hex>:<32 hex>` (`cron/scheduler.py:2302`). The job must be the installer's
"Edge — evening questions": its id has to be in `installed_jobs.json` and its name has to match
exactly in `jobs.json`, the same test as for `cron.run`. A participant's job with the same name
never arms.

These cases remove the stage and arm nothing:

- the stage file is refused on read (§4);
- Hermes's ledger has no row for the run, or its row names another job;
- the stage was written before Hermes claimed the run, after the reply, or over 15 minutes ago;
- the reply is Hermes's silence marker (`is_silent`, the same test as `scheduler.py:2985-2993`).

Otherwise the stage is renamed to `av-events/outcome-ask/armed/<execution>.claim`. The rename is
the claim, so two processes cannot both take it. The claim is then written as `<execution>.json`
with the reply's keyed hash. The flusher's stale-stage sweep also removes a stage no run reached.

**Confirm and emit** (`tick`, `_outcome_ask.py:380`). The tick holds an exclusive non-blocking
`flock`, because every plugin-loading process ticks. It reads Hermes's executions ledger.

The armed file is re-checked against the ledger row (§4). Then, when the run is terminal,
`completed` and `delivery_outcome` is `delivered` or `queued`, the tick does three things:

- emits one `outcome.asked` per subject;
- records the subject in `av-events/proactive/outcome-asked.json`, the only thing that makes the
  trigger treat a subject as asked;
- removes the armed file.

On a Hermes without the column, any completed run counts. Every other end drops the armed file
with no event (`not_delivered`), and the subject stays due the next evening: `failed`,
`suppressed`, `not_configured`, a null outcome, or a `failed`/`unknown` status. An armed run the
ledger never finishes is dropped after 72 hours.

The `outcome.asked@1` fields (`src/schemas/index.ts:1716-1727`):

- `message_hash`: the keyed hash of the model's reply, equal to that turn's `message.out`
  `content_hash`. Null in `metadata` capture.
- `window_days`: 1.
- `asked_by`: `outcome_cron`.
- Envelope `outcome_id` (required, `REQUIRED_REFS`) and `opportunity_id`, so
  `opportunity_outcome` links it and the funnel reaches the intention through the opportunity.
- `session_id`: the cron run's, accepted only in Hermes's `cron_<that job>_<stamp>` form.
- `run_id`: built from the ledger row.
- `occurred_at`: the ledger's `finished_at`; `occurred_at_earliest` is the ledger's claim time.
- `evidence_class`: `agent_report`. An ask never classifies.
- `event_id`: a uuid7 derived from the execution and the outcome (`derived_uuid7`), so a second
  process derives the same row.

**The hash is of the reply, not of the Telegram text.** Unless `cron.wrap_response: false` is set,
Hermes wraps a cron delivery in a "Cronjob Response: <name>" header and a footer
(`cron/scheduler_delivery.py:1944-1963`). It may also prepend a fallback-model notice
(`cron/scheduler.py:2531-2535`). The overlay sets neither, and the fleet's setting is unknown.

## 3. The answer

**Noting** (`_outcome_note_answer`, `__init__.py:262`, then `note_answer`). Only these turns are
considered: the resident's own message (`pre_llm_call`) in a Telegram session whose Hermes chat
type is `dm` (`HERMES_SESSION_CHAT_TYPE` from `gateway/session_context.py`, else the environment).
Never these:

- a cron run;
- a subagent's goal;
- a turn Hermes injected;
- another platform;
- a group, channel or thread;
- a chat whose type is unknown;
- anything in `metadata` capture.

The whole message is normalised: trimmed, case-folded, apostrophes dropped, other punctuation and
emoji turned into spaces, whitespace collapsed. A leading `[Replying to …]` pointer, which Hermes
adds to a Telegram reply (`gateway/run_inbound.py:1581-1590`), is removed first.

The normalised message must be one of these:

| Normalised message | Value |
|---|---|
| `met`, `we met` | `met` |
| `useful` | `useful` |
| `not useful` | `not_useful` |
| `missed` | `missed` |
| `did not happen`, `didnt happen` | `did_not_happen` |

A match is noted **in this process's memory only**, never on disk: the value, the time and the
session and turn ids. It is noted only while an ask might be open, and a restart drops notes the
tick has not taken yet. Anything else is not an answer and writes nothing; "met, and it was
great" is not an answer.

**Counting** (in `tick`). An answer note counts for the latest ask whose run started before it
(start and end as Hermes's ledger recorded them), and only when that ask meets all of these:

- it is the installer's evening job and was delivered, re-checked against the ledger;
- it is not yet answered;
- the message came within 24 hours of it.

It then emits `outcome.reported@1` (`src/schemas/index.ts:1729-1741`):

- `value` and `matcher_version: outcome_reply_v1`;
- `evidence_class: self_report`, `actor: participant`;
- the ask's `outcome_id` and `opportunity_id`;
- `in_reply_to_event_id` = the ask's event id;
- an event id derived from the ask, so ingest keeps at most one answer per ask.

There is no text and no hash of the reply. These cases emit nothing:

- a note older than 24 hours;
- a second answer to the same ask;
- a note with no ask before it;
- a note whose ask was never delivered.

"Before the next ask" follows from "the latest ask whose run started before it". An answer sent after a newer
ask went out belongs to the newer ask, never the older. An answer sent before the newer ask still
belongs to its own ask, even when the tick sees it later. A note whose ask is armed but not yet
confirmed waits for the confirmation.

**Self-report never raises a verified measure.** `core.outcomes` maps `reported` only to
`reported_useful` or `not_useful` (`dbt/models/core/outcomes.sql:125`). `verified_useful` needs an
`outcome.verified` at `platform_record` or stronger from a corroborating token (`outcomes.sql:145-146`),
and a plugin token may not send `outcome.verified` at all (`src/evidence.ts:225-237`).

## 4. Trust boundary: forged or altered files

Every file here is in the agent's own home, where the model has terminal and file tools. Anything
on disk can be written by the model, or by text that steered it, not only by the trigger or the
plugin. That includes Hermes's own ledger and the tenant's hash key. So the plugin treats every file
as untrusted, bounds what a forged one can cause, and states the one thing it cannot bind.

**Refused on read** (`private_file`, `valid_stage`, `valid_armed`, `_load_asks` in
`_outcome_ask.py`):

- anything that is not a regular file: a symlink is removed, never followed;
- a file not owned by this user, with any group or other permission bit, over its size cap (2 KB
  for a stage or armed file, 16 KB for the asks), or in a directory that is not this user's or that
  others can write;
- a file with any key beyond the expected ones, or a missing key;
- any field of the wrong shape:
  - ids by pattern, with exactly one subject whose `outcome_id` is `opp-outcome:` plus its own
    `opportunity_id`;
  - `asked_by`, `window_days`, `v` and `action` equal to their constants;
  - a stage `date` that is the village date of its `staged_at`;
  - a hash of 64 hex characters;
  - an armed file named for its own execution, with a session id of its own job's form.

**Never from a file.** These come from this code and from Hermes's ledger as the plugin reads it:

- the event type, `actor`, `evidence_class`, `asked_by` and `window_days`;
- `run_id`;
- every timestamp.

**Bound to what the plugin observed:**

- *Stage.* It must fall inside the run the plugin saw: the evening job by recorded id and exact
  name; a ledger row for that execution naming that job; written after Hermes claimed the run and
  before the reply; at most 15 minutes old.
- *Armed file.* It must fall inside its ledger row: the installer's evening job; staged after the
  claim; armed before the finish; delivered; at most one ask per execution.
- *In-process cross-check.* When this process saw the run's reply, the armed file must be exactly
  what it armed. If it saw the reply and armed nothing (a reminder evening), no armed file for that
  run is accepted (`armed_tampered`).
- *Asks on file.* Each is re-checked against the ledger (evening job, delivered) every time it
  could take an answer. An ask this process emitted cannot have its subject switched on file
  (`ask_tampered`).
- *Answers.* Answers never touch disk, so no file can create one. Each answer's event id is derived
  from its ask, so a forged "not answered yet" yields at most a duplicate that ingest drops.

**Accepted limit: the subject.** When the arm happened in another process (an external cron worker
under systemd) or before a restart, the subject of a real, delivered evening ask is file-asserted.
The plugin cannot observe the trigger's pick:

- the model's reply carries a name, not an id;
- every store that carries the id is in the same home;
- the tenant's HMAC key, which could sign a file, is readable there too.

So a forger with file access can choose which opportunity a delivered evening ask was about, and a
real resident answer to that ask lands on that subject. That is no more than what the data side
already assumes of anything a plugin sends:

- the ask is stored at the plugin cap, `agent_report`, and never classifies;
- the answer is `self_report` from `actor: participant`;
- `core.outcomes` maps a report to `reported_useful` at most;
- `verified_useful` needs a corroborating token at `platform_record` or stronger, and a plugin
  token may not send `outcome.verified` at all.

In the funnel, an outcome is owned through the opportunity's link to an eligible intention.

**The asked ledger.** A forged `outcome-asked.json` can mark a subject asked, so it is never asked
(denial). Or it can drop one, so it is asked again, which the trigger caps at three evenings.

## 5. The data half

No schema change and no new registration: both payloads fit `@1` as registered. The plugin's
producer-allowlist row (`src/evidence.ts:409-451`) lacks `outcome.asked` and `outcome.reported`;
`agentvillage-d4` has taken that change. **Until it is released, ingest quarantines both types as
`producer_not_allowed`.** `quarantine:replay` re-checks the allowlist with the original token's
provenance (`src/ingest/replay.ts:155`), so they are replayed after it.

## 6. Switches, logs, files

- `outcome_ask` in `AV_HOOKS_DISABLED` turns off arming, answers and the tick. A failure in any of
  them never costs the turn's `message.*` event.
- Logs carry codes and counts only: `outcome_ask armed`, `outcome_ask_tick asked=1 answered=1`,
  and the trigger's `detail` codes.
- Files, all under `$HERMES_HOME/av-events/`, ids, times and codes only:
  - `proactive/outcome-ask-evening.json`: the stage, written by the trigger.
  - `proactive/outcome-asked.json`: the asked ledger, written by the plugin and read by the trigger.
  - `outcome-ask/armed/`, `outcome-ask/asks.json` (delivered asks, execution and subject only,
    kept for 48 hours) and `outcome-ask/.lock`: the plugin's own.
  - Answers are never written to disk.

## 7. Tests and the canary

**Bun:**

- `skills/index-network/scripts/tests/outcome-ask.test.ts`:
  - the question exactly, with the cleaned name, and the 0600 ids-only stage;
  - each fallback, with the subject staying due;
  - an unconfirmed ask due again, up to three evenings;
  - an asked subject never asked again;
  - an old stage removed;
  - `done-today` leaving the earlier stage, and two racing triggers leaving one stage;
  - the backfill.
- `install/tests/proactive_jobs.test.ts`: the 14:00 prompt no longer asks; the evening prompt
  carries the fixed sentence; no prompt of the six needs a tool call.
- `delivery-cooldown.test.ts`: the follow-up records `announcedOn`.

**Pytest** (`plugins/av-events/tests/test_outcome_ask.py`):

- The ask:
  - emitted only when the run is delivered or queued, with the hash equal to `message.out`'s;
  - nothing on `[SILENT]`;
  - nothing on any failed delivery, and the subject stays due;
  - no delivery column means a completed run counts;
  - a stale or future stage is removed;
  - two runs arm one stage once;
  - only the installer's evening job arms;
  - cron sessions are handled explicitly;
  - `metadata` capture sends a null hash;
  - an armed run survives a restart;
  - the kill switch; fail-open.
- The answer:
  - every value in the table, with the right ids and `self_report`;
  - the note's keys;
  - the reply pointer;
  - "met, and it was great" and other sentences emit nothing;
  - nothing after 24 hours;
  - after a newer ask, it goes to the newer ask, never the older;
  - an earlier answer keeps its own ask;
  - no ask open; a second answer; an answer before confirmation; an undelivered ask;
  - group, channel, thread or unknown chat; CLI, subagent and injected turns;
  - nothing in `metadata` capture;
  - after a restart, a second answer reuses the first one's event id.
- Forged stage files, the review flag "integrity / trust boundary (forged stage file)": each of
  these is refused and removed, and no ask follows:
  - every bad field (unknown key, two subjects, mismatched outcome id, extra subject key, bad id,
    another asker, window, version or action, a date not the stamp's, a non-time stamp);
  - too big;
  - a symlink (never followed);
  - group- or other-accessible;
  - in a directory others can write;
  - older than the job run, or newer than the reply;
  - a run Hermes never recorded, or a row of another job.
- Forged armed files, asks and answers, the review flag "integrity / trust boundary": each of
  these emits nothing:
  - an armed file for another job's run, or claiming the evening job for another job's run;
  - an armed file for an evening run this process saw arm nothing;
  - an armed file altered after arming;
  - after a restart, an armed file outside its ledger row (staged before the run, armed after the
    end, an unknown key, a non-hash, another job's session, the wrong file name);
  - a symlinked or shared armed file;
  - a second ask for one run;
  - a forged answer file;
  - an ask on file for another job's run, for an undelivered run, with extra keys, with a switched
    subject, or as a symlink.

  One test pins the accepted limit: after a restart, a well-formed armed file names the subject,
  and the ask stays `agent_report` and the answer `self_report` from the participant.

**Live canary** (Carter's dogfood tenant, after the roll):

1. Have an accepted connection announced at 14:00 two days earlier. At 19:00, `triggers.jsonl`
   shows `detail: outcome-ask`, and the stage file appears and is gone within the run.
2. The buffer holds one `outcome.asked` whose `message_hash` equals that session's `message.out`
   `content_hash`. The same execution's `cron.run` shows `delivered`, and the subject is in
   `outcome-asked.json`.
3. Reply `met` in the DM. One `outcome.reported` follows with `in_reply_to_event_id` = the ask.
4. Reply `met` again. Nothing more is emitted.
5. On the data side, `producer_not_allowed` quarantine rows until d4's release. After the replay,
   one `core.outcomes` row with `reported_useful`, linked through `opportunity_outcome`.
6. Check one thing only a live gateway can show: that `HERMES_SESSION_CHAT_TYPE` reads `dm` inside
   `pre_llm_call`. If it does not, no answer is ever noted.
