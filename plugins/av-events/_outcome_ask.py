"""The evening outcome ask (DATA-42, ruling R2): `outcome.asked` and the answer.

The 19:00 trigger (`skills/index-network/scripts/outcome-ask.ts`) asks about
one accepted connection and, when it wakes the model with the question,
writes a stage file naming the subject: `av-events/proactive/
outcome-ask-evening.json`, 0600, ids only. Three steps here:

1. **Arm** (`post_llm_call` of a cron session; `arm`). Only for a run of the
   installer's "Edge — evening questions" job (its id in `installed_jobs.json`
   and its name in `jobs.json`, as for `cron.run`), whose Hermes task id is
   `cron:<job>:<execution>`, whose row in Hermes's executions ledger names
   that job, and whose stage was written after the run was claimed, before
   its reply, and under STAGE_MAX_AGE_S ago. A silent reply, or one that is
   not exactly the fixed question (QUESTION_PATTERN, from
   `outcome_question.json`), removes the stage and arms nothing. Otherwise the
   stage is renamed into `av-events/outcome-ask/armed/<execution>.json` (the
   rename is the claim) with the keyed hash of the reply (`message.out`'s
   `content_hash`).
2. **Confirm and emit** (the flusher; `tick`). When the ledger has the armed
   run terminal, completed and `delivery_outcome` `delivered` or `queued` (or
   completed, on a Hermes without that column), one `outcome.asked`, and the
   subject goes into `av-events/proactive/outcome-asked.json`, which the
   trigger reads (never overwritten when it is refused on read). Any other
   end drops the armed file; the subject stays due.
3. **The answer** (`pre_llm_call` of the resident's Telegram DM;
   `note_answer`, then `tick`). While an ask may be open, every resident
   message is noted in memory as a time; a message whose whole text,
   normalised, is in ANSWERS (and whose reply pointer, if any, quotes the
   question) is noted with its value. `tick` emits `outcome.reported` for it
   when the latest ask DELIVERED before it was the evening job's, is
   unanswered and under ANSWER_WINDOW_S old, and the message was the
   resident's next one after that delivery or replied to the question. No
   text and no hash of the reply goes into the event or onto disk.

**Trust boundary.** Everything in the agent's home is writable by the agent:
this module's files, Hermes's executions ledger, the event buffer, the
tenant's hash key and this plugin's own source. None of the file checks here
stops a forger; they catch accidents (a stale or half-written file, a run
never delivered, two processes racing). The only boundary is the data side:
a plugin token's events are capped at agent-asserted (`agent_report` asks)
and self-reported (`self_report` answers from `actor: participant`), and
never count as verified. See `docs/design/outcome-ask.md` §4.

Logs: codes and counts only. Python 3.11, standard library only.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import stat
import threading
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from ._core import DIR_MODE, FILE_MODE, MAX_BUFFER_AGE_S, derived_uuid7, epoch_from_iso, iso_from_epoch, iso_from_text, sqlite_read, uuid7
from ._cron import INSTALLED_JOBS_FILE, TERMINAL_EXECUTIONS_SQL, load_installed_job_ids, load_job_names
from ._messages import is_silent

try:  # POSIX only; on a platform without it the tick runs unlocked.
    import fcntl
except ImportError:  # pragma: no cover - Hermes tenants are Linux
    fcntl = None  # type: ignore[assignment]

#: The installer's job names that stage an ask, and the action each stages for.
STAGED_JOBS = {"Edge — evening questions": "evening"}
#: The one action that stages today.
ACTION = "evening"

#: Fixed by this code, never taken from a file.
ASKED_BY = "outcome_cron"
WINDOW_DAYS = 1
OUTCOME_PREFIX = "opp-outcome:"

#: A stage older than this when the run's reply arrives is not this run's.
STAGE_MAX_AGE_S = 15 * 60
#: Clock slack between the trigger (bun) and the plugin on one machine.
CLOCK_SLACK_S = 2.0
#: An answer counts for this long after its ask was delivered (`window_days: 1`).
ANSWER_WINDOW_S = 24 * 60 * 60
#: An armed run the ledger never finishes is dropped after this (the cron tail's horizon).
ARMED_MAX_AGE_S = MAX_BUFFER_AGE_S
#: Delivered asks are remembered this long, for the answers.
ASKS_KEEP_S = 48 * 60 * 60
#: Answers waiting in memory at most.
MAX_ANSWER_NOTES = 50
#: Resident message times kept in memory at most, and for how long (a note
#: waits at most ARMED_MAX_AGE_S, and its ask is at most ANSWER_WINDOW_S older).
MAX_MESSAGES = 500
MESSAGES_KEEP_S = ARMED_MAX_AGE_S + ANSWER_WINDOW_S
#: Subjects remembered in the asked ledger the trigger reads.
MAX_ASKED = 2000
#: Runs remembered in memory (`_SEEN`).
MAX_SEEN = 64

STAGE_MAX_BYTES = 2048
ARMED_MAX_BYTES = 2048
ASKS_MAX_BYTES = 16 * 1024
LEDGER_MAX_BYTES = 256 * 1024

MATCHER_VERSION = "outcome_reply_v2"
DELIVERED = frozenset({"delivered", "queued"})

#: The fixed question, shared with the bun test that pins the evening prompt's
#: sentence (`install/tests/proactive_jobs.test.ts`); both read every rule
#: from this file and both check its `cases`:
#: - `sentence`: the question; a reply arms when, after `normalise_reply`,
#:   it fully matches it (QUESTION_PATTERN), and a pointer's quote is searched
#:   for it (QUESTION_SEARCH);
#: - `marker`: what a Telegram reply pointer's quote must contain for the
#:   message to be an answer at all (QUESTION_MARKER);
#: - `normalise`: the spaces and the wrapper pairs `normalise_reply` uses.
QUESTION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outcome_question.json")


class _Question:
    """The rules in QUESTION_FILE. When it cannot be read, nothing arms and
    no pointer passes (fail closed)."""

    def __init__(self, path: str = QUESTION_FILE) -> None:
        self.pattern: Optional["re.Pattern[str]"] = None
        self.search: Optional["re.Pattern[str]"] = None
        self.marker: Optional["re.Pattern[str]"] = None
        self.spaces: tuple[str, ...] = ()
        self.wrappers: tuple[tuple[str, str], ...] = ()
        try:
            with open(path, encoding="utf-8") as handle:
                seed = json.load(handle)
            sentence, marker, rules = seed["sentence"], seed["marker"], seed["normalise"]
            spaces = tuple(s for s in rules["spaces"] if isinstance(s, str) and len(s) == 1)
            wrappers = tuple((o, c) for o, c in rules["wrappers"] if isinstance(o, str) and isinstance(c, str) and o and c)
            if not (isinstance(sentence, str) and isinstance(marker, str) and marker):
                return
            self.pattern = re.compile(f"^(?:{sentence})$")
            self.search = re.compile(sentence)
            self.marker = re.compile(marker)
            self.spaces, self.wrappers = spaces, wrappers
        except (OSError, ValueError, TypeError, KeyError, AttributeError, re.error):
            self.pattern = self.search = self.marker = None


_QUESTION = _Question()
QUESTION_PATTERN = _QUESTION.pattern
QUESTION_SEARCH = _QUESTION.search
QUESTION_MARKER = _QUESTION.marker
#: Removed from the question key (Telegram shows the markup, never sends it back in a quote).
_KEY_MARKUP = re.compile(r"[*_`~]")


def _emoji(ch: str) -> bool:
    """An emoji code point, or one of its joiners, selectors, skin tones or tags."""
    if ch in "‍︎️⃣":
        return True
    code = ord(ch)
    if 0x1F3FB <= code <= 0x1F3FF or 0xE0020 <= code <= 0xE007F:
        return True
    return unicodedata.category(ch) == "So"


def _strip_trailing_emoji(text: str) -> str:
    end = len(text)
    while end and (text[end - 1].isspace() or _emoji(text[end - 1])):
        end -= 1
    return text[:end]


def _plain_spaces(text: str) -> str:
    for space in _QUESTION.spaces:
        text = text.replace(space, " ")
    return text


def normalise_reply(text: str) -> str:
    """The `normalise` steps of QUESTION_FILE, for matching only: the special
    spaces as plain spaces; stripped; trailing emoji off; one wrapper pair
    around the whole reply off; stripped; trailing emoji off again."""
    text = _strip_trailing_emoji(_plain_spaces(text).strip())
    for opening, closing in _QUESTION.wrappers:
        if len(text) > len(opening) + len(closing) and text.startswith(opening) and text.endswith(closing):
            text = text[len(opening):len(text) - len(closing)]
            break
    return _strip_trailing_emoji(text.strip())


def is_the_question(reply: Any) -> bool:
    """The model's reply, normalised, is exactly the fixed question with one name."""
    return isinstance(reply, str) and QUESTION_PATTERN is not None and QUESTION_PATTERN.fullmatch(normalise_reply(reply)) is not None


def question_key(sentence: str) -> str:
    """The `key` of QUESTION_FILE: markup removed, whitespace runs as one
    space, no final full stop, case-folded. Hashed, never stored as text."""
    key = " ".join(_KEY_MARKUP.sub("", _plain_spaces(sentence)).split())
    return (key[:-1] if key.endswith(".") else key).casefold()


def quoted_question_key(quote: str) -> Optional[str]:
    """The question key of the first question sentence in a pointer's quote,
    or None when the quote holds none (a truncated quote, the resident's own
    message that happens to contain the marker)."""
    if QUESTION_SEARCH is None:
        return None
    found = QUESTION_SEARCH.search(_plain_spaces(quote))
    return question_key(found.group(0)) if found else None

#: The whole message, normalised (`normalise`), and the §4.1 value it is
#: (`outcome.reported@1` `value`: met | useful | not_useful | missed |
#: did_not_happen; `core.outcomes` reads met and useful as reported_useful,
#: the other three as not_useful).
_ANSWER_GROUPS = {
    "met": ("met", "we met", "yes", "yes we met", "yep"),
    "useful": ("useful", "very useful", "met and useful"),
    "not_useful": ("not useful", "met not useful", "met but not useful"),
    "missed": ("missed", "missed it", "no", "nope", "not met", "did not meet", "didn't meet", "didnt meet"),
    "did_not_happen": ("didn't happen", "did not happen"),
}
#: A phone's keyboard types the apostrophe as U+2019: both spellings count.
ANSWERS = {
    spelling: value
    for value, phrases in _ANSWER_GROUPS.items()
    for phrase in phrases
    for spelling in {phrase, phrase.replace("'", "’")}
}
#: A message starting with one of these is a quote, not an answer.
_QUOTE_MARKS = frozenset("\"'“”‘’«»„‚‹›")

STAGE_KEYS = frozenset({"v", "action", "date", "staged_at", "asked_by", "window_days", "subjects"})
SUBJECT_KEYS = frozenset({"outcome_id", "opportunity_id"})
ARMED_KEYS = frozenset({"v", "execution_id", "job_id", "session_id", "staged_epoch", "armed_epoch", "message_hash", "question_hash", "subject"})
ASK_KEYS = frozenset({"execution_id", "outcome_id", "opportunity_id", "question_hash"})

_TASK = re.compile(r"^cron:([0-9a-f]{12}):([0-9a-f]{32})$")
_EXECUTION = re.compile(r"^[0-9a-f]{32}$")
_JOB = re.compile(r"^[0-9a-f]{12}$")
_OPPORTUNITY = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
#: The pointer Hermes puts in front of a message sent as a Telegram reply
#: (`gateway/run_inbound.py` `_prepend_inbound_reply_context` at v2026.9.24);
#: group 1 is the quoted message.
_REPLY_POINTER = re.compile(r'^\[Replying to(?: your previous message)?: "(.*?)"\]\n\n', re.DOTALL)
IST = timezone(timedelta(hours=5, minutes=30))

_LOCK = threading.Lock()
_MEMORY_LOCK = threading.Lock()
#: execution id -> what this process armed for it (None: it saw the reply and armed nothing).
_SEEN: dict[str, Optional[dict]] = {}
#: execution id -> the subject this process emitted `outcome.asked` for.
_EMITTED: dict[str, dict] = {}
#: execution id -> True once this process emitted the answer to its ask. After
#: a restart a second answer can be emitted again, with the same derived event
#: id, and ingest keeps the first.
_ANSWERED: dict[str, bool] = {}
#: Answers noted by this process, waiting for the tick. Never written to disk.
_ANSWERS: list[dict] = []
#: Every direct-chat message from the resident while an ask may be open, as
#: `(seq, time)`: never its text. An answer counts only when it is the first
#: of these after its ask was delivered (or it replies to the question).
_MESSAGES: list[tuple[int, float]] = []
#: The latest time of a message dropped from `_MESSAGES` (0: none dropped). An
#: ask delivered before it cannot be shown to have had no message after it.
_MESSAGES_FLOOR = 0.0
_SEQ = itertools.count(1)


def reset_memory() -> None:
    """Forget this process's runs and answers (a restart; tests)."""
    global _MESSAGES_FLOOR
    with _MEMORY_LOCK:
        _SEEN.clear()
        _EMITTED.clear()
        _ANSWERED.clear()
        _ANSWERS.clear()
        _MESSAGES.clear()
        _MESSAGES_FLOOR = 0.0


def _remember(store: dict, key: str, value: Any) -> None:
    with _MEMORY_LOCK:
        store.pop(key, None)
        store[key] = value
        while len(store) > MAX_SEEN:
            store.pop(next(iter(store)))


# -- paths --------------------------------------------------------------------


def stage_path(state_dir: str, action: str = ACTION) -> str:
    return os.path.join(state_dir, "proactive", f"outcome-ask-{action}.json")


def asked_ledger_path(state_dir: str) -> str:
    return os.path.join(state_dir, "proactive", "outcome-asked.json")


def _root(state_dir: str) -> str:
    return os.path.join(state_dir, "outcome-ask")


def armed_dir(state_dir: str) -> str:
    return os.path.join(_root(state_dir), "armed")


def asks_path(state_dir: str) -> str:
    return os.path.join(_root(state_dir), "asks.json")


# -- files, read as untrusted -------------------------------------------------


def _uid() -> Optional[int]:
    return os.getuid() if hasattr(os, "getuid") else None


def private_dir(path: str) -> bool:
    """A real directory (not a symlink), owned by this user, writable by no one else."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    uid = _uid()
    return stat.S_ISDIR(st.st_mode) and (uid is None or st.st_uid == uid) and not st.st_mode & 0o022


def private_file(path: str, max_bytes: int) -> tuple[Any, Optional[str]]:
    """`(data, None)`, or `(None, code)`: `missing`, `not_regular` (a symlink,
    a directory, ...), `foreign_owner`, `not_private` (any group or other
    bit), `too_big`, `bad_dir` or `unreadable` (including not JSON)."""
    if not private_dir(os.path.dirname(path)):
        return None, "missing" if not os.path.lexists(path) else "bad_dir"
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None, "missing"
    except OSError:
        return None, "unreadable"
    uid = _uid()
    if not stat.S_ISREG(st.st_mode):
        return None, "not_regular"
    if uid is not None and st.st_uid != uid:
        return None, "foreign_owner"
    if st.st_mode & 0o077:
        return None, "not_private"
    if st.st_size > max_bytes:
        return None, "too_big"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, encoding="utf-8") as handle:
            raw = handle.read(max_bytes + 1)
        if len(raw) > max_bytes:
            return None, "too_big"
        return json.loads(raw), None
    except (OSError, ValueError):
        return None, "unreadable"


def _write(path: str, data: Any) -> None:
    """By temp file and rename, 0600 in a 0700 directory. Raises OSError."""
    os.makedirs(os.path.dirname(path), mode=DIR_MODE, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), FILE_MODE)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _unlink(path: str) -> None:
    """Remove the entry itself (a symlink is removed, never followed)."""
    try:
        os.unlink(path)
    except OSError:
        pass


def _listing(path: str) -> list[str]:
    if not private_dir(path):
        return []
    try:
        return sorted(name for name in os.listdir(path) if name.endswith(".json"))
    except OSError:
        return []


def _number(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _subject(data: Any) -> Optional[dict]:
    """`{outcome_id, opportunity_id}`, exactly, with the outcome id the opportunity's own."""
    if not isinstance(data, dict) or set(data) != SUBJECT_KEYS:
        return None
    opportunity_id, outcome_id = data.get("opportunity_id"), data.get("outcome_id")
    if not (isinstance(opportunity_id, str) and _OPPORTUNITY.match(opportunity_id)):
        return None
    if outcome_id != f"{OUTCOME_PREFIX}{opportunity_id}":
        return None
    return {"outcome_id": outcome_id, "opportunity_id": opportunity_id}


# -- the answer table ---------------------------------------------------------


def _strippable_tail(ch: str) -> bool:
    """A trailing `.`, `!`, whitespace or emoji (with its joiners, variation
    selectors, skin tones and keycap mark)."""
    return ch in ".!" or ch.isspace() or _emoji(ch)


def normalise(text: Any) -> Optional[str]:
    """`outcome_reply_v2`: the message (without any reply pointer) trimmed,
    case-folded, and stripped of trailing `.`, `!`, whitespace and emoji only.
    None when it cannot be an answer: it contains `?`, or starts with `>` or a
    quote mark."""
    if not isinstance(text, str) or len(text) > 2000:
        return None
    text = text.strip()
    if not text or "?" in text or text[0] == ">" or text[0] in _QUOTE_MARKS:
        return None
    text = text.casefold()
    end = len(text)
    while end and _strippable_tail(text[end - 1]):
        end -= 1
    return text[:end]


def _parse(text: Any) -> Optional[tuple[str, bool, Optional[str]]]:
    """`(value, pointer, quote_key)` when the resident's whole message is an
    answer, else None. A message sent as a Telegram reply carries Hermes's
    pointer; it can be an answer only when the quote contains QUESTION_MARKER,
    and then `pointer` is True and `quote_key` is the question key of the
    question sentence in the quote (None when it holds none)."""
    if not isinstance(text, str) or len(text) > 2000:
        return None
    body = text.strip()
    found = _REPLY_POINTER.match(body)
    quote_key = None
    if found:
        if QUESTION_MARKER is None or QUESTION_MARKER.search(_plain_spaces(found.group(1))) is None:
            return None  # a reply to some other message is never an answer
        quote_key = quoted_question_key(found.group(1))
        body = body[found.end():]
    normalised = normalise(body)
    value = ANSWERS.get(normalised) if normalised is not None else None
    return (value, found is not None, quote_key) if value else None


def parse_answer(text: Any) -> Optional[tuple[str, bool]]:
    """`(value, pointer)` when the resident's whole message is an answer, else None (`_parse`)."""
    parsed = _parse(text)
    return parsed[:2] if parsed else None


def answer_value(text: Any) -> Optional[str]:
    """`outcome_reply_v2`: the value when the whole message is one of ANSWERS, else None."""
    parsed = parse_answer(text)
    return parsed[0] if parsed else None


# -- 1. arm -------------------------------------------------------------------


def valid_stage(data: Any) -> Optional[dict]:
    """The trigger's stage, exactly (`outcome-ask.ts` `stageFor`), or None:
    the expected keys and no others, the fixed values, a date that is the
    village date of `staged_at`, and exactly one subject."""
    if not isinstance(data, dict) or set(data) != STAGE_KEYS:
        return None
    if data.get("v") != 1 or data.get("action") != ACTION or data.get("asked_by") != ASKED_BY:
        return None
    window = data.get("window_days")
    if isinstance(window, bool) or window != WINDOW_DAYS:
        return None
    staged_at, date = data.get("staged_at"), data.get("date")
    if not isinstance(staged_at, str) or len(staged_at) > 40 or not isinstance(date, str) or not _DATE.match(date):
        return None
    staged = epoch_from_iso(iso_from_text(staged_at))
    if staged is None or datetime.fromtimestamp(staged, IST).date().isoformat() != date:
        return None
    subjects = data.get("subjects")
    if not isinstance(subjects, list) or len(subjects) != 1:
        return None
    subject = _subject(subjects[0])
    return {"staged": staged, "subject": subject} if subject else None


def staged_action(home: str, job_id: Any) -> Optional[str]:
    """The action a cron job stages for: an installer job by id and exact name, else None."""
    if not isinstance(job_id, str) or job_id not in load_installed_job_ids(os.path.join(home, INSTALLED_JOBS_FILE)):
        return None
    return STAGED_JOBS.get(load_job_names(os.path.join(home, "cron", "jobs.json")).get(job_id, ""))


def run_row(home: str, execution_id: str) -> Optional[dict]:
    """The run's row in Hermes's executions ledger, as Hermes wrote it."""
    rows = sqlite_read(os.path.join(home, "cron", "executions.db"), "SELECT * FROM executions WHERE id = ?", (execution_id,))
    return rows[0] if rows else None


def read_ledger(home: str) -> Optional[list[dict]]:
    """Hermes's terminal executions, or None when the read failed (no file, a
    lock held past the timeout, a bad table): a failure, never "no runs"."""
    return sqlite_read(os.path.join(home, "cron", "executions.db"), TERMINAL_EXECUTIONS_SQL)


def _run_start(row: dict) -> Optional[float]:
    return epoch_from_iso(iso_from_text(row.get("claimed_at"))) or epoch_from_iso(iso_from_text(row.get("started_at")))


def arm(
    state_dir: str,
    home: str,
    *,
    session_id: Optional[str],
    task_id: Any,
    reply: Any,
    hasher: Callable[[str], Optional[str]],
    capture: str,
    now: float,
) -> Optional[str]:
    """Step 1, from a cron session's `post_llm_call`. Returns a code, or None
    when the run is not one that stages an ask."""
    found = _TASK.match(task_id) if isinstance(task_id, str) else None
    if not found:
        return None
    job_id, execution_id = found.group(1), found.group(2)
    if staged_action(home, job_id) != ACTION:
        return None
    # This process saw the evening run's reply: from here on, an armed file
    # for this run is accepted only if it is the one written below.
    _remember(_SEEN, execution_id, None)
    path = stage_path(state_dir)
    data, why = private_file(path, STAGE_MAX_BYTES)
    if why == "missing":
        return "no_stage"
    stage = valid_stage(data) if why is None else None
    if stage is None:
        _unlink(path)
        return "stage_refused"
    row = run_row(home, execution_id)
    start = _run_start(row) if row else None
    if row is None or row.get("job_id") != job_id or start is None:
        _unlink(path)
        return "stage_no_run"
    if stage["staged"] < start - CLOCK_SLACK_S:
        _unlink(path)
        return "stage_before_run"
    if stage["staged"] > now + CLOCK_SLACK_S:
        _unlink(path)
        return "stage_after_reply"
    if now - stage["staged"] > STAGE_MAX_AGE_S:
        _unlink(path)
        return "stale_stage"
    if not isinstance(reply, str) or not reply.strip() or is_silent(reply):
        _unlink(path)
        return "silent"
    if not is_the_question(reply):
        # Anything but the fixed question (a second person added, a reminder,
        # Hermes's error text) is treated as silent: no ask, the subject stays due.
        _unlink(path)
        return "not_the_question"
    claim = os.path.join(armed_dir(state_dir), f"{execution_id}.claim")
    try:
        os.makedirs(armed_dir(state_dir), mode=DIR_MODE, exist_ok=True)
        os.rename(path, claim)
    except FileNotFoundError:
        return "lost_race"
    session = session_id if isinstance(session_id, str) and re.match(rf"^cron_{job_id}_\d{{8}}_\d{{6}}$", session_id) else None
    message_hash = hasher(reply) if capture != "metadata" else None
    # The question's key, hashed, so a Telegram reply to it can be told from
    # a reply to another evening's question. Never the text.
    question_hash = hasher(question_key(normalise_reply(reply)))
    armed = {
        "v": 1,
        "execution_id": execution_id,
        "job_id": job_id,
        "session_id": session,
        "staged_epoch": stage["staged"],
        "armed_epoch": now,
        "message_hash": message_hash if isinstance(message_hash, str) and _HASH.match(message_hash) else None,
        "question_hash": question_hash if isinstance(question_hash, str) and _HASH.match(question_hash) else None,
        "subject": stage["subject"],
    }
    try:
        _write(os.path.join(armed_dir(state_dir), f"{execution_id}.json"), armed)
    finally:
        _unlink(claim)
    _remember(_SEEN, execution_id, armed)
    return "armed"


# -- 3a. note an answer ---------------------------------------------------------


def note_answer(
    state_dir: str,
    *,
    text: Any,
    session_id: Optional[str],
    turn_id: Any,
    now: float,
    hasher: Callable[[str], Optional[str]] = lambda text: None,
) -> Optional[str]:
    """Step 3, from every message of the resident's `pre_llm_call` (the
    caller has already decided it is the resident, in a Telegram DM). While an
    ask may be open, notes the message's time (never its text), and, when the
    whole message is an answer, the value too; in memory only. `tick` decides
    whether an answer counts. Returns a code or None."""
    parsed = _parse(text)
    if not _listing(armed_dir(state_dir)) and not os.path.exists(asks_path(state_dir)):
        return "answer_no_ask" if parsed else None
    with _MEMORY_LOCK:
        seq = next(_SEQ)
        _MESSAGES.append((seq, now))
        _prune_messages(now)
    if parsed is None:
        return None
    note = {
        "id": uuid7(),
        "value": parsed[0],
        "at_epoch": now,
        "session_id": session_id if isinstance(session_id, str) and _ID.match(session_id) else None,
        "turn_id": turn_id if isinstance(turn_id, str) and _ID.match(turn_id) else None,
        # Its place among the resident's messages, whether it replied to a
        # question, and the keyed hash of the question it quoted (`tick`
        # compares it with each ask's `question_hash`).
        "seq": seq,
        "pointer": parsed[1],
        "pointer_hash": _hash_or_none(hasher, parsed[2]),
    }
    with _MEMORY_LOCK:
        if len(_ANSWERS) >= MAX_ANSWER_NOTES:
            return "answer_backlog"
        _ANSWERS.append(note)
    return "answer_noted"


def _hash_or_none(hasher: Callable[[str], Optional[str]], key: Optional[str]) -> Optional[str]:
    if key is None:
        return None
    digest = hasher(key)
    return digest if isinstance(digest, str) and _HASH.match(digest) else None


def _prune_messages(now: float) -> None:
    """Under _MEMORY_LOCK: drop message times past MESSAGES_KEEP_S, and the
    oldest past MAX_MESSAGES, raising the floor to each dropped time."""
    global _MESSAGES_FLOOR
    while _MESSAGES and (len(_MESSAGES) > MAX_MESSAGES or now - _MESSAGES[0][1] > MESSAGES_KEEP_S):
        _MESSAGES_FLOOR = max(_MESSAGES_FLOOR, _MESSAGES.pop(0)[1])


def _is_next_message(note: dict, delivered: float) -> bool:
    """The note is the resident's first message after `delivered`, as far as
    this process saw: no message between, and none dropped from memory since."""
    with _MEMORY_LOCK:
        if delivered < _MESSAGES_FLOOR:
            return False
        return not any(at > delivered and seq < note["seq"] for seq, at in _MESSAGES)


def pending_answers() -> list[dict]:
    with _MEMORY_LOCK:
        return [dict(note) for note in _ANSWERS]


# -- 2 and 3b. the tick -----------------------------------------------------------


class _FileLock:
    """An exclusive, non-blocking lock across processes (every plugin-loading
    process ticks). `held` is False when another process has it."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.handle: Optional[int] = None
        self.held = False

    def __enter__(self) -> "_FileLock":
        os.makedirs(os.path.dirname(self.path), mode=DIR_MODE, exist_ok=True)
        self.handle = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), FILE_MODE)
        if fcntl is None:
            self.held = True
            return self
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.held = True
        except OSError:
            self.held = False
        return self

    def __exit__(self, *exc: Any) -> None:
        if self.handle is not None:
            if self.held and fcntl is not None:
                fcntl.flock(self.handle, fcntl.LOCK_UN)
            os.close(self.handle)


def valid_armed(data: Any, name: str, now: float) -> Optional[dict]:
    """An armed file exactly as `arm` writes it, named for its own execution."""
    if not isinstance(data, dict) or set(data) != ARMED_KEYS or data.get("v") != 1:
        return None
    execution_id, job_id, session_id = data.get("execution_id"), data.get("job_id"), data.get("session_id")
    if not (isinstance(execution_id, str) and _EXECUTION.match(execution_id) and name == f"{execution_id}.json"):
        return None
    if not (isinstance(job_id, str) and _JOB.match(job_id)):
        return None
    if session_id is not None and not (isinstance(session_id, str) and re.match(rf"^cron_{job_id}_\d{{8}}_\d{{6}}$", session_id)):
        return None
    staged, armed_at = _number(data.get("staged_epoch")), _number(data.get("armed_epoch"))
    if staged is None or armed_at is None or not staged <= armed_at + CLOCK_SLACK_S or armed_at > now + CLOCK_SLACK_S:
        return None
    for name in ("message_hash", "question_hash"):
        value = data.get(name)
        if value is not None and not (isinstance(value, str) and _HASH.match(value)):
            return None
    subject = _subject(data.get("subject"))
    if subject is None:
        return None
    return {**data, "subject": subject, "staged_epoch": staged, "armed_epoch": armed_at}


def _load_asks(state_dir: str, codes: dict) -> list[dict]:
    """The delivered asks on file: exactly their keys, one per execution."""
    data, why = private_file(asks_path(state_dir), ASKS_MAX_BYTES)
    if why == "missing":
        return []
    entries = data.get("asks") if why is None and isinstance(data, dict) and set(data) == {"v", "asks"} and data.get("v") == 1 else None
    if not isinstance(entries, list):
        _unlink(asks_path(state_dir))
        _count(codes, "asks_refused")
        return []
    asks, seen = [], set()
    for entry in entries[:40]:
        if not isinstance(entry, dict) or set(entry) != ASK_KEYS:
            _count(codes, "ask_refused")
            continue
        execution_id = entry.get("execution_id")
        subject = _subject({"outcome_id": entry.get("outcome_id"), "opportunity_id": entry.get("opportunity_id")})
        question_hash = entry.get("question_hash")
        if question_hash is not None and not (isinstance(question_hash, str) and _HASH.match(question_hash)):
            subject = None
        if not (isinstance(execution_id, str) and _EXECUTION.match(execution_id)) or subject is None or execution_id in seen:
            _count(codes, "ask_refused")
            continue
        seen.add(execution_id)
        asks.append({"execution_id": execution_id, **subject, "question_hash": question_hash})
    return asks


def _record_asked(state_dir: str, opportunity_id: str, when: str) -> Optional[str]:
    """Add the subject to the asked ledger the trigger reads. Returns None, or
    a code when the ledger was left alone: `asked_ledger_refused` (it exists
    but is refused on read or is not the ledger's shape; replacing it would
    make every subject in it due again, so it is never overwritten, and the
    trigger asks nobody while it stays so) or `asked_ledger_unwritable`."""
    path = asked_ledger_path(state_dir)
    data, why = private_file(path, LEDGER_MAX_BYTES)
    if why == "missing":
        asked: Any = {}
    else:
        asked = data.get("asked") if why is None and isinstance(data, dict) else None
        if not isinstance(asked, dict):
            return "asked_ledger_refused"
    asked = {k: v for k, v in asked.items() if isinstance(k, str) and _OPPORTUNITY.match(k) and isinstance(v, str) and len(v) <= 40}
    asked.pop(opportunity_id, None)
    asked[opportunity_id] = when
    while len(asked) > MAX_ASKED:
        asked.pop(next(iter(asked)))
    try:
        _write(path, {"v": 1, "asked": asked})
    except OSError:
        return "asked_ledger_unwritable"
    return None


def _delivered(row: dict) -> bool:
    if row.get("status") != "completed" or iso_from_text(row.get("finished_at")) is None:
        return False
    if "delivery_outcome" not in row:  # a Hermes without the column
        return True
    return row.get("delivery_outcome") in DELIVERED


def _ask_event_id(execution_id: str, outcome_id: str, finished: float) -> str:
    return derived_uuid7(int(finished * 1000), f"av-events|outcome.asked|{execution_id}|{outcome_id}")


def _answer_event_id(execution_id: str, outcome_id: str, finished: float) -> str:
    """One per ask, whatever any file says: ingest keeps one row per event id."""
    return derived_uuid7(int(finished * 1000), f"av-events|outcome.reported|{execution_id}|{outcome_id}")


def _count(codes: dict, code: str) -> None:
    codes[code] = codes.get(code, 0) + 1


def _evening_delivered(home: str, row: Optional[dict]) -> bool:
    return row is not None and staged_action(home, row.get("job_id")) == ACTION and _delivered(row)


def tick(state_dir: str, home: str, emit: Callable[..., Optional[dict]], now: float) -> dict:
    """Steps 2 and 3b, on the flusher thread. Returns code -> count."""
    codes: dict[str, int] = {}
    with _LOCK, _FileLock(os.path.join(_root(state_dir), ".lock")) as lock:
        if not lock.held:
            return {"contended": 1}
        stage = stage_path(state_dir)
        if os.path.lexists(stage):
            data, why = private_file(stage, STAGE_MAX_BYTES)
            valid = valid_stage(data) if why is None else None
            if valid is None or now - valid["staged"] > STAGE_MAX_AGE_S:
                _unlink(stage)
                _count(codes, "stale_stage")

        asks = _load_asks(state_dir, codes)
        asked_executions = {a["execution_id"] for a in asks}
        changed = False
        answers = pending_answers()
        armed_names = _listing(armed_dir(state_dir))
        rows: dict = {}
        ledger_failed = False
        if armed_names or asks:
            ledger = read_ledger(home)
            ledger_failed = ledger is None
            if ledger_failed:
                _count(codes, "ledger_unreadable")
            rows = {r.get("id"): r for r in ledger or []}

        pending: list[float] = []
        for name in armed_names:
            path = os.path.join(armed_dir(state_dir), name)
            data, why = private_file(path, ARMED_MAX_BYTES)
            armed = valid_armed(data, name, now) if why is None else None
            if armed is None:
                _unlink(path)
                _count(codes, "armed_refused")
                continue
            execution_id = armed["execution_id"]
            with _MEMORY_LOCK:
                seen_here, mine = execution_id in _SEEN, _SEEN.get(execution_id)
            if seen_here and mine != armed:
                # This process saw the run's reply: the file must be what it armed.
                _unlink(path)
                _count(codes, "armed_tampered")
                continue
            row = rows.get(execution_id)
            if row is None:
                if now - armed["armed_epoch"] > ARMED_MAX_AGE_S:
                    _unlink(path)
                    _count(codes, "armed_expired")
                else:
                    pending.append(armed["armed_epoch"])
                continue
            start, finished = _run_start(row), epoch_from_iso(iso_from_text(row.get("finished_at")))
            if (
                row.get("job_id") != armed["job_id"]
                or staged_action(home, row.get("job_id")) != ACTION
                or execution_id in asked_executions
                or start is None
                or finished is None
                or not (start - CLOCK_SLACK_S <= armed["staged_epoch"] and armed["armed_epoch"] <= finished + CLOCK_SLACK_S)
            ):
                _unlink(path)
                _count(codes, "armed_refused")
                continue
            if not _delivered(row):
                _unlink(path)
                _count(codes, "not_delivered")
                continue
            subject = armed["subject"]
            asked_at = iso_from_epoch(finished)
            event = emit(
                "outcome.asked",
                {"message_hash": armed["message_hash"], "window_days": WINDOW_DAYS, "asked_by": ASKED_BY},
                event_id=_ask_event_id(execution_id, subject["outcome_id"], finished),
                occurred_at=asked_at,
                occurred_at_earliest=iso_from_epoch(start),
                occurred_at_latest=asked_at,
                actor="agent",
                session_id=armed["session_id"],
                run_id=f"cron:{row.get('job_id')}:{execution_id}",
                outcome_id=subject["outcome_id"],
                opportunity_id=subject["opportunity_id"],
            )
            if event is None:
                pending.append(armed["armed_epoch"])
                _count(codes, "emit_refused")
                continue
            _remember(_EMITTED, execution_id, subject)
            asks.append({"execution_id": execution_id, **subject, "question_hash": armed["question_hash"]})
            asked_executions.add(execution_id)
            rows[execution_id] = row
            changed = True
            ledger_code = _record_asked(state_dir, subject["opportunity_id"], asked_at or "")
            if ledger_code:
                _count(codes, ledger_code)
            _unlink(path)
            _count(codes, "asked")

        # Every ask on file, re-checked against the ledger: the installer's
        # evening job, delivered; its start and end as Hermes recorded them.
        confirmed = []
        for ask in asks:
            row = rows.get(ask["execution_id"])
            with _MEMORY_LOCK:
                mine = _EMITTED.get(ask["execution_id"])
            if mine is not None and mine != {"outcome_id": ask["outcome_id"], "opportunity_id": ask["opportunity_id"]}:
                _count(codes, "ask_tampered")
                continue
            if not _evening_delivered(home, row):
                continue
            start, finished = _run_start(row), epoch_from_iso(iso_from_text(row.get("finished_at")))
            if start is not None and finished is not None:
                confirmed.append({**ask, "start": start, "finished": finished})

        done: set[str] = set()
        with _MEMORY_LOCK:
            answered = set(_ANSWERED)
        for note in sorted(answers, key=lambda n: (n["at_epoch"], n["seq"])):
            at = note["at_epoch"]
            if ledger_failed:
                # No ask can be confirmed this tick: keep the answer for the
                # next one, for as long as it could still count.
                if now - at > ANSWER_WINDOW_S:
                    done.add(note["id"])
                    _count(codes, "answer_expired")
                continue
            # The open ask is the latest DELIVERED before the message (the
            # ledger's finish), never the latest started: a run in progress
            # has not asked anything yet.
            before = [a for a in confirmed if a["finished"] <= at]
            latest = max(before, key=lambda a: a["finished"]) if before else None
            # An armed ask not yet confirmed was delivered after its arm time,
            # so it may be the open one only when it armed before the message
            # and after the latest delivered ask.
            if any(p <= at and (latest is None or p > latest["finished"]) for p in pending):
                if now - at > ARMED_MAX_AGE_S:
                    done.add(note["id"])
                    _count(codes, "answer_expired")
                continue  # its ask is armed but not yet confirmed: wait
            done.add(note["id"])
            if latest is None:
                _count(codes, "answer_no_ask")
                continue
            if latest["execution_id"] in answered or at > latest["finished"] + ANSWER_WINDOW_S:
                _count(codes, "answer_not_counted")
                continue
            quoted = note["pointer_hash"]
            if quoted is not None and quoted == latest["question_hash"]:
                pass  # a Telegram reply to the open ask's own question
            elif quoted is not None and any(quoted == a["question_hash"] for a in confirmed if a is not latest):
                # A reply to another evening's question is never counted for this one.
                _count(codes, "answer_other_ask")
                continue
            elif not _is_next_message(note, latest["finished"]):
                # Not the resident's next message after the ask, and not a reply to its question.
                _count(codes, "answer_not_next")
                continue
            event = emit(
                "outcome.reported",
                {"value": note["value"], "matcher_version": MATCHER_VERSION},
                event_id=_answer_event_id(latest["execution_id"], latest["outcome_id"], latest["finished"]),
                occurred_at=iso_from_epoch(at),
                occurred_at_earliest=iso_from_epoch(at),
                occurred_at_latest=iso_from_epoch(at),
                actor="participant",
                evidence_class="self_report",
                session_id=note["session_id"],
                turn_id=note["turn_id"],
                outcome_id=latest["outcome_id"],
                opportunity_id=latest["opportunity_id"],
                in_reply_to_event_id=_ask_event_id(latest["execution_id"], latest["outcome_id"], latest["finished"]),
            )
            if event is None:
                done.discard(note["id"])
                _count(codes, "emit_refused")
                break
            answered.add(latest["execution_id"])
            _remember(_ANSWERED, latest["execution_id"], True)
            _count(codes, "answered")
        if done:
            with _MEMORY_LOCK:
                _ANSWERS[:] = [n for n in _ANSWERS if n["id"] not in done]

        kept_ids = {a["execution_id"] for a in confirmed if now - a["finished"] <= ASKS_KEEP_S}
        kept_ids |= {a["execution_id"] for a in asks if a["execution_id"] not in rows}  # not yet re-readable: keep
        kept = [{key: a[key] for key in sorted(ASK_KEYS)} for a in asks if a["execution_id"] in kept_ids][-20:]
        if changed or len(kept) != len(asks):
            if kept:
                _write(asks_path(state_dir), {"v": 1, "asks": kept})
            else:
                _unlink(asks_path(state_dir))
    return codes


__all__ = [
    "ANSWERS",
    "ANSWER_WINDOW_S",
    "ASKED_BY",
    "MATCHER_VERSION",
    "STAGED_JOBS",
    "STAGE_MAX_AGE_S",
    "WINDOW_DAYS",
    "answer_value",
    "QUESTION_MARKER",
    "QUESTION_PATTERN",
    "QUESTION_SEARCH",
    "normalise_reply",
    "question_key",
    "quoted_question_key",
    "arm",
    "armed_dir",
    "is_the_question",
    "asked_ledger_path",
    "asks_path",
    "normalise",
    "note_answer",
    "pending_answers",
    "private_dir",
    "private_file",
    "reset_memory",
    "run_row",
    "stage_path",
    "staged_action",
    "tick",
    "valid_armed",
    "valid_stage",
]
