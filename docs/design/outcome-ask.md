# The evening outcome ask: `outcome.asked` and the resident's answer (DATA-42, overlay half)

Status: **as built**, 2026-10-05, after the orchestrator's rulings on the design note (R2 and
rulings 1 to 7) and fix round 1 on PR #198 (F1 to F11). Data-repo references are to
`agentvillage-data` origin/main. Hermes references are to `~/.hermes/hermes-agent` at tag
`v2026.9.24`.

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
two days later (`backfillAnnounced` in `outcome-ask.ts`).

**The plugin must be on.** The evening action (`eveningAction` in `proactive.ts`) first tries the
outcome ask (`outcomeAskDecision`). Before anything else it checks that the av-events plugin would
record the ask (`outcomePluginOff`): `AV_EVENTS_TOKEN` must not be blank and `AV_HOOKS_DISABLED`
must not contain `outcome_ask`. Both are read like every other variable the trigger reads, from the
environment, else `$HERMES_HOME/.env`. A blank token is also how consent is revoked. Without this
check, a tenant whose plugin idles was asked the same question three evenings running, for every
connection, and nothing recorded it.

**The asked ledger must be readable.** The trigger reads the plugin's asked ledger
`av-events/proactive/outcome-asked.json` (`readAskedIds`) with the plugin's own refusal test: a
regular file, not a symlink; owned by this user; no group or other bits; at most 256 KB; in a
directory owned by this user that others cannot write; JSON of the form `{"asked": {...}}`. A
ledger that does not exist yet is empty. A ledger that exists but fails the test means no ask
tonight. The plugin never overwrites a ledger it refuses (§2), so it could record no new ask, and
asking anyway would ask the same subject again.

**The pick.** A subject is due (`dueSubjects`) when all of these hold:

- the follow-up announced it `DUE_AFTER_DAYS` = 2 or more village days ago;
- it is not in the asked ledger;
- the trigger has not already staged it today;
- the trigger has staged it on fewer than `MAX_ATTEMPTS` = 3 evenings;
- its id can be an envelope id.

The oldest announcement goes first, then the lowest id. Only when something is due does the
evening read Index (`list_opportunities`, status `accepted`). It then takes the first due subject
that Index still lists as accepted.

**The question.** The name goes through `cleanName`, the same path as every other name. The
Script Output is `{job: "evening-note", date, outcomeQuestion}`, and `outcomeQuestion` is exactly
`Did you and <name> meet? Reply met, not useful, or missed.` (`outcomeQuestion` in
`outcome-ask.ts`). The evening prompt (`skills/edge-esmeralda/prompts/ask-questions.md`) says to
deliver it word for word and nothing else. It keeps the Script Error line every prompt now carries.
The text is scanned with the rest of the Script Output as before. The trigger's cleaning and
scanning are unchanged.

**Falling back.** The evening writes today's reminder, exactly as before, in each of these cases.
None of them records anything about the subject, which stays due:

- the plugin is off;
- the asked ledger is unreadable;
- nothing is due;
- Index cannot be read;
- the due connection is no longer listed;
- no listed due subject has a name that cleans. A subject whose name does not clean is passed
  over that evening and the next due subject is asked. The skipped subject records no attempt,
  stays due, and is counted in the run log's `withheld`, on a fallback too.

The reason is a code in `triggers.jsonl` (`detail`: `outcome-ask`, `outcome-ask-plugin-off`,
`outcome-ask-ledger-unreadable`, `outcome-ask-none-due`, `outcome-ask-index-unavailable`,
`outcome-ask-not-listed`, `outcome-ask-name-withheld`).

**The stage file.** When the trigger wakes the model with the question, it writes
`av-events/proactive/outcome-ask-evening.json` (`writeStage`). The file is 0600 in a 0700
directory, written by temp file and rename. It holds ids only:
`{v, action, date, staged_at, asked_by: "outcome_cron", window_days: 1, subjects: [{outcome_id, opportunity_id}]}`,
with `outcome_id` = `opp-outcome:<opportunity id>`.

The write happens inside the state lock, just before the day mark (`beforeWake` in
`runAgentAction`). A stage that cannot be written leaves the run silent with the day unmarked. The
run records the attempt (`outcomeAsk.attempts`), not an ask.

Every evening run first removes any stage left by an earlier run (`clearStage`). Without that, a
reminder written later could be armed as an ask. Two triggers racing leave one stage: the second is
`done-today` under the lock. The once-per-day mark now counts a mark of today or tomorrow
(`doneToday`), so a clock that moved back is silent and stages nothing. A corrupt state file is
renamed aside (`readStateHealing`). The run then starts from empty, which drops the announcement
dates and attempts with it, and nothing is due until the follow-up announces again.

## 2. Arm, confirm, emit (the plugin's half)

This is `plugins/av-events/_outcome_ask.py`, wired in `__init__.py` (`_outcome_arm`,
`_outcome_note_answer`) and `_collector.py` (`outcome_tick`, run on the cron tail's one-minute
cadence).

**Arm** (`arm`, from `post_llm_call`). Cron sessions are handled explicitly: arming runs only in a
cron session (`_is_cron_session`), and only for a Hermes task id of the form
`cron:<12 hex>:<32 hex>` (`cron/scheduler.py:2302`). The job must be the installer's "Edge —
evening questions": its id has to be in `installed_jobs.json` and its name has to match exactly in
`jobs.json`, the same test as for `cron.run`. A participant's job with the same name never arms.

These cases remove the stage and arm nothing:

- the stage file is refused on read;
- Hermes's ledger has no row for the run, or its row names another job;
- the stage was written before Hermes claimed the run, after the reply, or over 15 minutes ago;
- the reply is Hermes's silence marker (`is_silent`, the same test as `scheduler.py:2985-2993`);
- the reply, stripped, is not exactly the fixed question (`is_the_question`): it must fully match
  `^Did you and .{1,64} meet\? Reply met, not useful, or missed\.$`. A second person added, a
  reminder about someone else, or Hermes's "Sorry, I hit an error" text is treated as silent: no
  event, and the subject stays due. The pattern is in `plugins/av-events/outcome_question.json`,
  which the bun test that pins the evening prompt's sentence reads too.

Otherwise the stage is renamed to `av-events/outcome-ask/armed/<execution>.claim`. The rename is
the claim, so two processes cannot both take it. The claim is then written as `<execution>.json`
with the reply's keyed hash. The flusher's stale-stage sweep also removes a stage no run reached.

**Confirm and emit** (`tick`). The tick holds an exclusive non-blocking `flock`, because every
plugin-loading process ticks. It reads Hermes's executions ledger (`read_ledger`), which tells a
failed read (no file, a lock held past the timeout) from an empty one.

The armed file is re-checked against the ledger row. Then, when the run is terminal, `completed`
and `delivery_outcome` is `delivered` or `queued`, the tick does three things:

- emits one `outcome.asked` per subject;
- records the subject in `av-events/proactive/outcome-asked.json`, the only thing that makes the
  trigger treat a subject as asked;
- removes the armed file.

When the asked ledger exists but is refused on read (wrong mode after a restore, say), is not
JSON, or is not the ledger's shape, the tick leaves it alone and logs `asked_ledger_refused`.
Replacing it with only the new entry would make every subject in it due again. The event is
emitted as usual, and the trigger asks nobody while the ledger stays unreadable (§1). A write that
fails is logged as `asked_ledger_unwritable`.

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

**Noting** (`_outcome_note_answer` in `__init__.py`, then `note_answer`). Only these turns are
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

While an ask may be open (an armed file or a delivered ask on file), **every** such message is
noted in this process's memory as a time and a sequence number, never its text. That is what lets
the tick tell whether an answer was the resident's next message.

**The reply pointer.** A message sent as a Telegram reply carries Hermes's
`[Replying to (your previous message): "…"]` pointer (`gateway/run_inbound.py:1563-1572`). When it
is present, the message can be an answer only if the quoted text contains
`Reply met, not useful, or missed.` (the `marker` in `outcome_question.json`). A reply to the
14:00 follow-up, the brief or anything else is not an answer. The pointer is then removed and the
rest is matched.

**The matcher** (`outcome_reply_v2`, `parse_answer`). The message is trimmed, case-folded, and
stripped of trailing `.`, `!`, whitespace and emoji only. A message containing `?`, or starting
with `>` or a quote mark, is not an answer. The whole normalised message must be one of these:

| Normalised message | Value |
|---|---|
| `met`, `we met`, `yes`, `yes we met`, `yep` | `met` |
| `useful`, `very useful`, `met and useful` | `useful` |
| `not useful`, `met not useful`, `met but not useful` | `not_useful` |
| `missed`, `missed it`, `no`, `nope`, `not met`, `did not meet`, `didn't meet`, `didnt meet` | `missed` |
| `didn't happen`, `did not happen` | `did_not_happen` |

The values are the registered `outcome.reported@1` list (`src/schemas/index.ts:1729-1741`).
`core.outcomes` reads `met` and `useful` as `reported_useful`, and `not_useful`, `missed` and
`did_not_happen` as `not_useful` (`dbt/models/core/outcomes.sql:125-126`). A phone types the
apostrophe as `’`; both spellings count. Anything else is not an answer: "met, and it was great",
"met?", "> met", "met\n\nthanks".

A match is noted in memory with the value, the time, its sequence number, whether it carried a
passing pointer, and the session and turn ids. A restart drops notes the tick has not taken yet.

**Counting** (in `tick`). An answer note counts for the latest ask **delivered** before it, ordered
and compared by the ledger's finish, and only when that ask meets all of these:

- it is the installer's evening job and was delivered, re-checked against the ledger;
- it is not yet answered;
- the message came within 24 hours of it;
- the message is the resident's first message after the ask was delivered, or it carries a
  pointer that passes the test above.

A note whose candidate ask is armed but not yet confirmed waits, when that ask armed before the
message and after the latest delivered ask. An armed ask is delivered after its arm time, so a
message before its arm time can never be its answer.

When the tick's ledger read failed, no answer is judged: each pending answer is kept for the next
tick, up to 24 hours after it was sent (`ledger_unreadable`, then `answer_expired`).

It then emits `outcome.reported@1`:

- `value` and `matcher_version: outcome_reply_v2`;
- `evidence_class: self_report`, `actor: participant`;
- the ask's `outcome_id` and `opportunity_id`;
- `in_reply_to_event_id` = the ask's event id;
- an event id derived from the ask, so ingest keeps at most one answer per ask.

There is no text and no hash of the reply. These cases emit nothing:

- a note older than 24 hours;
- a second answer to the same ask;
- a note with no ask delivered before it;
- a note whose ask was never delivered;
- a match that is not the resident's next message and does not reply to the question
  (`answer_not_next`). When message times were dropped from memory after the ask (more than 500
  kept), a plain match does not count either.

An answer to yesterday's question sent while tonight's run is in progress stays with yesterday's
subject: tonight's run has asked nothing until Hermes delivers it. An answer sent after a newer
ask was delivered belongs to the newer ask.

**Self-report never raises a verified measure.** `core.outcomes` maps `reported` only to
`reported_useful` or `not_useful` (`dbt/models/core/outcomes.sql:125`). `verified_useful` needs an
`outcome.verified` at `platform_record` or stronger from a corroborating token (`outcomes.sql:145-146`),
and a plugin token may not send `outcome.verified` at all (`src/evidence.ts:225-237`).

## 4. Trust boundary

**Everything in the agent's home is writable by the agent.** The model has terminal and file
tools there, and text that steered it can use them. That covers every file this module reads or
writes: the stage, the armed files, the asks on file and the asked ledger. It covers Hermes's
executions ledger, the event buffer, the tenant's hash key, and the plugin's own source. None of
the file checks below stops a forger. A forger who can write the home can write a well-formed file,
insert a ledger row, drop a finished event into the buffer, or edit the plugin.

**The only boundary is the data side.** Events sent with a plugin token are capped there:

- an ask is stored at the plugin cap, `agent_report`, and never classifies;
- an answer is `self_report` from `actor: participant`;
- `core.outcomes` maps a report to `reported_useful` at most;
- `verified_useful` needs an `outcome.verified` at `platform_record` or stronger from a
  corroborating token, and a plugin token may not send `outcome.verified` at all
  (`src/evidence.ts:225-237`).

So the most a forger in the home can produce is agent-asserted asks and self-reported answers,
which never count as verified.

**What the file checks still do.** They catch accidents, not forgers: a stale stage from an
earlier run, a stage no run reached, a half-written file, a run that was never delivered, two
processes racing for one stage. These checks remain (whether to cut any is the owner's decision):

- a file must be a regular file (a symlink is removed, never followed), owned by this user, with no
  group or other bits, under a size cap (2 KB for a stage or armed file, 16 KB for the asks,
  256 KB for the asked ledger), in a directory owned by this user that others cannot write;
- exactly the expected keys, each of the expected shape: ids by pattern, one subject whose
  `outcome_id` is `opp-outcome:` plus its own `opportunity_id`, constants where the value is fixed,
  a stage `date` that is the village date of its `staged_at`, a 64-hex hash, an armed file named
  for its own execution with a session id of its own job's form;
- the event type, `actor`, `evidence_class`, `asked_by`, `window_days`, `run_id` and every
  timestamp come from this code and from Hermes's ledger, not from this module's files;
- a stage must fall inside the run the plugin saw, and an armed file inside its ledger row's
  window, for the installer's evening job, delivered, at most once per execution;
- in memory, when this process saw a run's reply, the armed file must be what it armed, and an ask
  it emitted cannot have its subject switched on file;
- each ask on file is re-checked against the ledger every time it could take an answer;
- each answer's event id is derived from its ask, so ingest keeps at most one answer per ask.

**The asked ledger.** An altered `outcome-asked.json` can mark a subject asked, so it is never
asked (denial). Or it can drop one, so it is asked again, which the trigger caps at three
evenings. One the plugin refuses stops every ask until it is fixed (§1, §2).

## 5. The data half

No schema change and no new registration: both payloads fit `@1` as registered. The plugin's
producer-allowlist row (`src/evidence.ts:409-451`) lacks `outcome.asked` and `outcome.reported`;
`agentvillage-d4` has taken that change. **Until it is released, ingest quarantines both types as
`producer_not_allowed`.** `quarantine:replay` re-checks the allowlist with the original token's
provenance (`src/ingest/replay.ts:155`), so they are replayed after it.

## 6. Switches, logs, files

- `outcome_ask` in `AV_HOOKS_DISABLED` turns off arming, answers and the tick, and the trigger
  then asks nobody. A blank `AV_EVENTS_TOKEN` idles the plugin, and the trigger asks nobody either.
  A failure in any of them never costs the turn's `message.*` event.
- Logs carry codes and counts only: `outcome_ask armed`, `outcome_ask not_the_question`,
  `outcome_ask_tick asked=1 answered=1`, `answer_not_next`, `ledger_unreadable`,
  `asked_ledger_refused`, and the trigger's `detail` codes.
- Files, all under `$HERMES_HOME/av-events/`, ids, times and codes only:
  - `proactive/outcome-ask-evening.json`: the stage, written by the trigger.
  - `proactive/outcome-asked.json`: the asked ledger, written by the plugin and read by the trigger.
  - `outcome-ask/armed/`, `outcome-ask/asks.json` (delivered asks, execution and subject only,
    kept for 48 hours) and `outcome-ask/.lock`: the plugin's own.
  - Answers and the resident's message times are never written to disk.
- `plugins/av-events/outcome_question.json`: the fixed question's pattern and its marker sentence,
  shipped with the plugin.

## 7. Tests and the canary

**Bun:**

- `skills/index-network/scripts/tests/outcome-ask.test.ts`:
  - the question exactly, with the cleaned name, and the 0600 ids-only stage;
  - each fallback, with the subject staying due, including the plugin off (blank token in the
    environment or `.env`, token nowhere, `outcome_ask` disabled) and an asked ledger the plugin
    would refuse (mode, not JSON, wrong shape, symlink, shared directory);
  - the `withheld` count on a fallback;
  - an unconfirmed ask due again, up to three evenings;
  - an asked subject never asked again;
  - an old stage removed;
  - `done-today` leaving the earlier stage, and two racing triggers leaving one stage;
  - the backfill.
- `install/tests/proactive_jobs.test.ts`: the 14:00 prompt no longer asks; the evening prompt
  carries the fixed sentence, and it and `outcomeQuestion` match the shared pattern in
  `outcome_question.json`; no prompt of the six needs a tool call.
- `delivery-cooldown.test.ts`: the follow-up records `announcedOn`.

**Pytest** (`plugins/av-events/tests/test_outcome_ask.py`):

- The ask:
  - emitted only when the run is delivered or queued, with the hash equal to `message.out`'s;
  - nothing on `[SILENT]`, and nothing on a reply that is not exactly the fixed question;
  - nothing on any failed delivery, and the subject stays due;
  - a refused asked ledger left alone, with the ask still emitted;
  - no delivery column means a completed run counts;
  - a stale or future stage is removed;
  - two runs arm one stage once;
  - only the installer's evening job arms;
  - cron sessions are handled explicitly;
  - `metadata` capture sends a null hash;
  - an armed run survives a restart;
  - the kill switch; fail-open.
- The answer:
  - every value in the table, with the right ids and `self_report`, and the non-answers;
  - the note's keys, and the resident's message times held as times only;
  - a reply pointer quoting the question counts; a reply to any other message does not;
  - only the resident's next message after the ask counts, unless it replies to the question;
  - nothing after 24 hours;
  - after a newer ask was delivered, it goes to the newer ask; while the newer run is in
    progress, it stays with the ask the resident saw; a message before a delivery is not its answer;
  - an earlier answer keeps its own ask;
  - an answer kept through a failed ledger read, and dropped after 24 hours;
  - no ask open; a second answer; an answer before confirmation; an undelivered ask;
  - group, channel, thread or unknown chat; CLI, subagent and injected turns;
  - nothing in `metadata` capture;
  - after a restart, a second answer reuses the first one's event id.
- The file checks (§4): forged or altered stage files, armed files and asks on file are refused.
  Each forged armed-file case builds its times from the finish it writes, and a control case shows
  the same file without its fault is accepted.

**Live canary** (Carter's dogfood tenant, after the roll):

1. Have an accepted connection announced at 14:00 two days earlier. At 19:00, `triggers.jsonl`
   shows `detail: outcome-ask`, and the stage file appears and is gone within the run.
2. The buffer holds one `outcome.asked` whose `message_hash` equals that session's `message.out`
   `content_hash`. The same execution's `cron.run` shows `delivered`, and the subject is in
   `outcome-asked.json`.
3. Reply `met` in the DM as the next message. One `outcome.reported` follows with
   `in_reply_to_event_id` = the ask.
4. Reply `met` again. Nothing more is emitted.
5. On the data side, `producer_not_allowed` quarantine rows until d4's release. After the replay,
   one `core.outcomes` row with `reported_useful`, linked through `opportunity_outcome`.
6. Check one thing only a live gateway can show: that `HERMES_SESSION_CHAT_TYPE` reads `dm` inside
   `pre_llm_call`. If it does not, no answer is ever noted.
