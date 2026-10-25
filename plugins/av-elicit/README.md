# `av-elicit`: GC-ELICIT on the box

The box half of the GODCONST elicitation follow-up: after a pool closes, the resident's own agent asks
them a few short questions about ODIN's constitution over a few days, and records each question and
answer. The control plane decides when (contract v1 §1) and writes notice files; this plugin injects them
into the resident's Telegram DM session, reports how much the human has written, and gives the agent the
`elicitation_record` tool. Contract sections: 1 (quiet hours), 3a (files the control plane writes), 3b
(files this plugin writes), 3c (the tool's records), 12.1 (the human's exact words on answer records).

Python 3.9+, standard library only. No hooks, one daemon thread, one tool. Fail-open: every failure is a
log code; nothing raises into the gateway. Logs carry codes and counts only, never a notice's, question's
or answer's text.

```
plugins/av-elicit/
  plugin.yaml   manifest (kind: backend, provides_tools: elicitation_record)
  __init__.py   register(ctx), the inject pass, the probe, the tool
  tests/        pytest suite; a fake ctx and a temp state.db, never imports Hermes
```

## Files (all under `$HERMES_HOME/av-events/elicit/`)

| Path | Written by | Meaning |
|---|---|---|
| `inject/<unix_ms>-<open\|next\|replan>.txt` | control plane | One notice. An optional first line `#trigger=<opener\|answer\|idle\|human_message\|replan>` is metadata: stripped before injection, read back for records. |
| `inject/<file>.done` | this plugin | The gateway accepted the injection. A rename of the `.txt`, with mtime set to the accept time (the control plane reads it as `delivered_at` for `open`; it counts `.done` files as `nudges_sent`). |
| `inject/<file>.skipped` | this plugin | Not injected: the `closed` marker was present, the file was older than 24 h (by its `unix_ms` prefix), or it was unusable (empty after the trigger line, over 32 KiB, not UTF-8, not a regular file). |
| `closed` | control plane | Empty marker. Pending `.txt` files staged (mtime) at or before it become `.skipped`; the window whose newest `*-open.done` is not later than the marker is closed (the probe stops, the tool refuses). A `.txt` staged after the marker belongs to a new window and is handled normally. |
| `probe.json` | this plugin | `{"human_messages_since": <unix_ms>, "count": n, "last_human_at": <unix_ms>\|null}` (0600). |
| `window.json` | the tool | `{"window_ms": <the open file name's unix_ms>, "questions": n, "closed_at_ms", "close_reason", "stopped"}` (0600): questions recorded in the current window, for `question_no`. A `window_ms` other than the current window's counts as 0, so a new window starts again at 1. |
| `last_answer.json` | the tool | `{"at_ms": n}` (0600): when the last `answer` record was written, for the next question's trigger. |
| `records/<unix_ms>-<record_id>.json` | the tool | One record per call (0600, dir 0700), written by temp file and rename. The control plane forwards and renames them. |

## The inject pass (every 5 s)

1. No `.txt`: nothing to do.
2. `closed` present: every `.txt` whose mtime is at or before the marker's becomes `.skipped`.
3. Any `.txt` staged more than 24 h ago becomes `.skipped` (quiet hours and the ballot hold included).
4. 22:00 to 08:00 IST: hold (the file stays `.txt`).
5. `$HERMES_HOME/av-events/godconst/page-open` exists (av-godconst's empty marker while a sent ballot card
   page still has unrated cards): hold, exactly as in quiet hours. Nothing is consumed or skipped for this
   reason; only step 3's 24 h age cap skips a held file. av-godconst refreshes the marker's mtime on every
   page it sends; a marker older than 12 h is stale, no longer holds, and logs `stale_ballot_page` once.
6. No session key (`AV_ELICIT_SESSION_KEY`, else `agent:main:telegram:dm:<TELEGRAM_HOME_CHANNEL>`): wait.
7. No row in `state.db` `sessions` with `source='telegram'` and that `session_key`: wait (the gateway can
   inject only into a session it can look up; one exists after the human's first message to the bot).
8. Inject the oldest file only (one per pass) through `ctx.inject_message(text, session_key=...)`. Accepted:
   rename `.done`. Refused (flag off, no live gateway) or raised: the file stays and is retried next pass.

## The probe (every 60 s)

While any `.txt` or `.done` exists and a window is open (the newest `*-open.done` is later than any
`closed` marker): count the `user`-role messages in the resident's home DM (session rows with
`source='telegram'`, `chat_type='dm'` and the home session key, so a rotated session counts and groups and
other chats never do) with `timestamp` at or after the newest `*-open.done` mtime, excluding rows whose content starts with `[Agent Village notice` (our own
injected notices), and write `probe.json`. `state.db` is opened read-only (`mode=ro`); an unreadable store
writes nothing. The control plane may still run its own probe when the file is more than 5 minutes stale.

## The tool: `elicitation_record`

Schema (what the agent sees): `kind` (required: `question` | `answer` | `stop`), `question_no` (required,
integer from 1), `category` (a category slug), `form` (question: `open` | `trade_off` | `direct_rating` |
`other`), `text` (required for question and answer, at most 4000 characters), `takeaway` (answer, at most
2000), `statement_ids` (answer, a list of ids such as `s004`).

The resident's Telegram progress bubble for a call reads "⚙️ Noting that", never the tool's name (contract
§10), in the `new` (fleet default) and `all` progress modes; `/verbose`, a mode the resident chooses, shows raw
tool calls by design. Hermes has no registration field for that text; av-display gives the tool its verb, drops
its argument preview, and adds a preview builder for this tool only, so a `stop` (no `text`) does not fall back
to the raw name. The tool keeps its name: the agent's notices and the records use it.

The tool is kept out of Hermes's `tool_search` bridge while av-events is loaded: its R-DEON list
(`plugins/av-events/_village_visible.py`, `VISIBLE_TOOLS`) keeps `elicitation_record` (toolset
`av-elicit`) in the model's tool list, so the agent calls it directly and the bubble above applies.
Deferred, it was never called in two live Haiku runs: the agent saved what it learned to memory
instead, even when the notice named `tool_search` and `tool_call`. `AV_VILLAGE_TOOLS_VISIBLE=0`
(av-events) defers it again.

`question_no` is assigned by the tool, never taken from the agent (contract 3c amended: an agent numbers
from its whole DM history, so its opener can come out as 8). A question is 1 + the questions recorded in the
current window (from `window.json`), so the opener is always 1. An answer or a stop is the window's latest
question, unless the agent names an earlier question of the same window (1..latest); before any question it
is 1. The agent's own number is kept as `agent_question_no`, for analysis; the confirmation line names the
stored number.

The record adds `record_id` (uuid4), `recorded_at` (ISO, UTC) and `trigger` (question only, never the
agent's; contract 3c v3). A question recorded after an `answer` record, with no inject file accepted since
that answer, is `answer`: the agent asks questions 2..n in the same reply that records the answer, with no
file injected. Otherwise it is the trigger of the notice accepted last (its `#trigger=` line, else `open` ->
`opener`, `next` -> `answer`, `replan` -> `replan`), so only the window's first question is `opener`. The
time of the last answer is kept in `last_answer.json` (`{"at_ms": n}`, 0600); an answer from an earlier
window (before the current `*-open.done`) never counts. Fields that do not belong to the kind are written as `null` (`[]` for
`statement_ids`); a question without a `form` is `other`.

Late answers (contract v4): for 24 h after a window's `closed` marker (its mtime), `answer` and `stop`
records are still accepted and written to that window, numbered from its `window.json`, with `late: true`.
A `question` after close is refused. Every record carries `late` (boolean).

`text` for a question is the question sentence only, not the whole message (the description says so). A soft
check: a question whose text is over 60 words is kept and flagged `text_long: true` (every record carries
`text_long`; only questions can be true).

It refuses (returns `{"error": "..."}`, never raises) outside a Telegram DM session (the calling
`session_id`'s `state.db` row must be `source='telegram'`, `chat_type='dm'`, and the resident's own session
key when one is configured), when no window is open (beyond the late-answer rule above), on invalid arguments, and past 200 records.
Success returns one line, e.g. `Recorded question 2 (privacy_and_consent).`

### The human's exact words (answer records only, contract §12.1)

An answer's `text` is the agent's rendering and can paraphrase, so the tool also attaches the human's own
Telegram messages, read verbatim from `state.db` (read-only) when the record is written. The agent never
supplies or sees these fields. Its schema and the confirmation line are unchanged.

- Rows: `messages` joined to `sessions` with `source = 'telegram'`, `chat_type = 'dm'` and the home session
  key (every session under it), `active = 1` when the column exists (an older store has none), never a
  context-compaction summary row (`_compressed_summary = 1`, when the column exists), `timestamp` at or after
  the window's `window_ms`. Human rows are `user` rows whose content does not start with
  `[Agent Village notice` (our notices). Blank ones carry no words and are passed over.
- Span: the human rows after the latest `assistant` row with non-empty content (the agent's last reply) that
  precedes the newest human row, oldest first. A tool-call-only assistant row has empty content and does not
  end the span. The current turn's own rows come after the newest human row, so they do not end it either.
- Caps: at most 10 messages and 8000 characters of joined text, keeping the most recent whole messages. If
  the newest message alone is over 8000 characters, its first 8000 are kept. Any cut sets
  `human_text_truncated: true`.
- File bound: the control plane's pass leaves a record file over 65,536 bytes unread (`RECORD_FILE_MAX`,
  raised from 16,384 in agentvillage-controlplane #397), which would lose the whole answer. 8000 three-byte
  characters beside the agent's longest fields fit untruncated. If a record would still pass the bound, the
  oldest messages are dropped first, then the one left is cut from its end until the record fits. The agent's
  own fields are never cut. `RECORD_FILE_BYTES` must never be raised before the control plane's bound is.

| Field | Value |
|---|---|
| `human_text` | The messages' content joined with a blank line (`"\n\n"`), exactly as stored; `null` when there are none |
| `human_message_count` | 0..10 |
| `human_text_truncated` | boolean |
| `human_text_first_at` / `human_text_last_at` | ISO (UTC) times of the first and last message used, or `null` |

When `state.db` cannot be read, the record is still written with count 0 and `human_text: null`, and the log
code is `human_text_unavailable`. Question and stop records carry none of these keys. A late answer captures
by the same rule. The record's log line carries `human_messages=n human_truncated=0|1`, never the text.

## Configuration (set by the installer, `install/av_elicit.ts`)

| Key | Value | Why |
|---|---|---|
| `plugins.enabled` | contains `av-elicit` | Hermes loads it at the next gateway start. |
| `plugins.entries.av-elicit.allow_gateway_injection` | `true` | Without it Hermes refuses every `inject_message`; files wait as `.txt`. |
| `memory.memory_char_limit` | `8000` if lower | The agent's gap list needs the room (contract 3a; the control plane also sets it). |

Environment: `TELEGRAM_HOME_CHANNEL` (the resident's chat id, already written for the gateway) or
`AV_ELICIT_SESSION_KEY` (an explicit session key; tests and odd namespaces). Read from the process
environment, then `$HERMES_HOME/.env`. There is no on switch here: the control plane's gates
(`GODCONST_ELICIT_ENABLED`, `GODCONST_ELICIT_TENANTS`) decide whether any file is ever staged, and with no
files the plugin does nothing but list one empty directory every 5 s.

## Tests

```
python3 -m pytest plugins/av-elicit/tests
```

## Hardening (overlay review, contract §9)

- **Gateway only.** The inject/probe thread runs only in the gateway process (`gateway run` or a bare `gateway`
  in argv, or `_HERMES_GATEWAY=1`). In the TUI `inject_message` would hand the notice to the local operator. The
  tool is registered everywhere. Each registration gets its own stop event; an old thread is stopped and joined
  first. Every start is serialised by one lock, so no loop ever runs twice.
- **`gateway start|restart`.** These may or may not run the gateway in-process:
  - With no service manager (macOS, as the installer's final `gateway restart` leaves it), `restart` stops the
    old gateway and runs one in this process.
  - With a service manager, `restart` only asks it and exits. `start` never runs the gateway in-process.
  - Hermes sets `_HERMES_GATEWAY=1` when it imports `gateway/run.py`, which happens after plugins have
    registered. So under these two commands, `register` starts one waiter thread that checks the marker every
    second and starts the loop the first time it is `1`. A hand-off that exits without the marker never runs a
    loop. A direct start or an unload stops the waiter. Before this change, a foreground `restart` logged
    `loop_skipped reason=not_gateway` and never injected.
- **Claim before injecting.** `.txt` is renamed `.sending` first; a file that cannot be claimed is never injected.
  Accepted: `.sending` -> `.done` (mtime stamped). Refused or raised: back to `.txt`. A `.sending` older than 60 s
  (a process died mid-injection) becomes `.skipped`, since a second opener is worse than a missing one.
- **Only real notices.** Only `<ms>-(open|next|replan).txt` whose text (BOM and `#trigger=` line removed) starts with
  `[Agent Village notice` is injected; anything else becomes `.skipped` (code `invalid_inject`).
- **Never mid-reply.** Injection holds while a turn is running (an unexpired `session_turn_leases` row in state.db,
  or a `gateway_state.json` under 10 minutes old with `active_agents > 0`). `open` and `#trigger=idle` notices also
  hold while the human wrote in the home DM in the last 5 minutes; `#trigger=answer` notices wait only for the turn.
- **Window id.** `window_ms` is the unix_ms prefix of the open file's name: in every record, in `window.json`, and
  for matching the `closed` marker. The `.done` accept time is only T0 (probe.json's `human_messages_since`). When
  the mtime cannot be stamped, the accept time goes to `accepted.json` (`{"<file>.done": unix_ms}`) and is used instead.
- **Closure kept in state.** `closed` is `{"reason": "...", "window_ms": n}` from the control plane (an empty or
  unreadable legacy marker is reason `unknown` and applies to the window accepted at or before its mtime). The first
  time a marker for the current window is seen, its close time (the marker's mtime, never later than now) and
  reason are written into `window.json`. Deleting or re-touching the marker then never reopens the window or extends
  the 24 h late period. After closure, pending files staged before it, and anything but a new `open`, are skipped.
- **Late records.** `withdrawn` refuses every record, late ones included; a recorded `stop` (flag in `window.json`)
  refuses late records for that window.
- **Numbering.** `question_no` = max(`window.json` count, a recount of this window's question records in `records/`
  with any suffix: `.json`, `.sent`, `.refused-...`) + 1.
- **DM check.** `elicitation_record` fails closed when no home session key is configured.

`window.json` is now `{"window_ms", "questions", "closed_at_ms", "close_reason", "stopped"}`.
