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
   its reply, and under STAGE_MAX_AGE_S ago. A silent reply removes the stage
   and arms nothing. Otherwise the stage is renamed into
   `av-events/outcome-ask/armed/<execution>.json` (the rename is the claim)
   with the keyed hash of the reply (`message.out`'s `content_hash`).
2. **Confirm and emit** (the flusher; `tick`). When the ledger has the armed
   run terminal, completed and `delivery_outcome` `delivered` or `queued` (or
   completed, on a Hermes without that column), one `outcome.asked`, and the
   subject goes into `av-events/proactive/outcome-asked.json`, which the
   trigger reads. Any other end drops the armed file; the subject stays due.
3. **The answer** (`pre_llm_call` of the resident's Telegram DM;
   `note_answer`, then `tick`). A message whose whole text, normalised, is in
   ANSWERS is noted **in this process's memory only** (value and time).
   `tick` emits `outcome.reported` for it when the latest ask that started
   before it named one subject, was delivered, and is under ANSWER_WINDOW_S
   old. No text and no hash of the reply goes into the event.

**Trust boundary.** Every file here lives in the agent's own home, where the
model has terminal and file tools: anything on disk can be written by the
model, or by text that steered it. So, on every read:

- a file must be a regular file (not a symlink), owned by this user, with no
  group or other permission bits, under a size cap, in a directory owned by
  this user that no one else can write; it must have exactly the expected
  keys, each of the expected shape (ids by pattern, one subject, constants
  where the value is fixed); anything else is refused and removed;
- the event type, actor, evidence class, `asked_by`, `window_days`,
  `run_id` and every timestamp come from this code and from Hermes's ledger,
  never from a file;
- a stage must fall inside the run the plugin saw (claimed before it, reply
  after it), and an armed file inside its ledger row's window, for the
  installer's evening job, delivered, at most once per execution;
- when this process saw the run's reply, the armed file must be exactly what
  this process armed (a forged or altered one is refused), and when it saw
  the reply but armed nothing, no armed file for that run is accepted;
- answers never touch disk, so a file cannot create one; and the answer's
  event id is derived from the ask, so ingest keeps at most one answer per
  ask whatever a file says.

What remains file-asserted, an accepted limit: **which subject** a delivered
evening ask was about, when the run's arm happened in another process (an
external cron worker) or before a restart. The plugin cannot observe the
trigger's pick: the model's reply carries a name, not an id, and every store
that does carry the id is in the same home. A forger can therefore choose
the subject of a real, delivered evening ask, and a real resident answer to
that ask lands on that subject. That is no more than the data side already
assumes of a plugin: the ask is stored at the plugin cap (`agent_report`),
the answer as `self_report` from `actor: participant`, and `core.outcomes`
maps a report to `reported_useful` at most, never `verified_useful`.

Logs: codes and counts only. Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import os
import re
import stat
import threading
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from ._core import DIR_MODE, FILE_MODE, MAX_BUFFER_AGE_S, derived_uuid7, epoch_from_iso, iso_from_epoch, iso_from_text, sqlite_read, uuid7
from ._cron import INSTALLED_JOBS_FILE, load_installed_job_ids, load_job_names, read_terminal_executions
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
#: sentence (`install/tests/proactive_jobs.test.ts`): `pattern` is what a
#: reply must fully match, stripped, to arm; `marker` is the sentence a
#: Telegram reply pointer must quote for the message to be an answer.
QUESTION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outcome_question.json")


def _load_question(path: str = QUESTION_FILE) -> tuple[Optional["re.Pattern[str]"], Optional[str]]:
    """`(pattern, marker)` from QUESTION_FILE; `(None, None)` when it cannot
    be read, and then nothing arms and no pointer passes (fail closed)."""
    try:
        with open(path, encoding="utf-8") as handle:
            seed = json.load(handle)
        pattern, marker = seed.get("pattern"), seed.get("marker")
        if not (isinstance(pattern, str) and isinstance(marker, str) and marker):
            return None, None
        return re.compile(pattern), marker
    except (OSError, ValueError, AttributeError, re.error):
        return None, None


QUESTION_PATTERN, QUESTION_MARKER = _load_question()


def is_the_question(reply: Any) -> bool:
    """The model's reply, stripped, is exactly the fixed question with one name."""
    return isinstance(reply, str) and QUESTION_PATTERN is not None and QUESTION_PATTERN.fullmatch(reply.strip()) is not None

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
ARMED_KEYS = frozenset({"v", "execution_id", "job_id", "session_id", "staged_epoch", "armed_epoch", "message_hash", "subject"})
ASK_KEYS = frozenset({"execution_id", "outcome_id", "opportunity_id"})

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


def reset_memory() -> None:
    """Forget this process's runs and answers (a restart; tests)."""
    with _MEMORY_LOCK:
        _SEEN.clear()
        _EMITTED.clear()
        _ANSWERED.clear()
        _ANSWERS.clear()


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
    if ch in ".!" or ch.isspace() or ch in "‍︎️⃣":
        return True
    code = ord(ch)
    if 0x1F3FB <= code <= 0x1F3FF or 0xE0020 <= code <= 0xE007F:
        return True
    return unicodedata.category(ch) == "So"


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


def parse_answer(text: Any) -> Optional[tuple[str, bool]]:
    """`(value, pointer)` when the resident's whole message is an answer, else
    None. A message sent as a Telegram reply carries Hermes's pointer; it can
    be an answer only when the quoted message contains the question's sentence
    (QUESTION_MARKER), and then `pointer` is True."""
    if not isinstance(text, str) or len(text) > 2000:
        return None
    body = text.strip()
    found = _REPLY_POINTER.match(body)
    if found:
        if QUESTION_MARKER is None or QUESTION_MARKER not in found.group(1):
            return None  # a reply to some other message is never an answer
        body = body[found.end():]
    normalised = normalise(body)
    value = ANSWERS.get(normalised) if normalised is not None else None
    return (value, found is not None) if value else None


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
    armed = {
        "v": 1,
        "execution_id": execution_id,
        "job_id": job_id,
        "session_id": session,
        "staged_epoch": stage["staged"],
        "armed_epoch": now,
        "message_hash": message_hash if isinstance(message_hash, str) and _HASH.match(message_hash) else None,
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
) -> Optional[str]:
    """Step 3, from the resident's `pre_llm_call` (the caller has already
    decided it is the resident, in a Telegram DM). Notes the value and the
    time, in memory only, when the whole message is an answer and an ask may
    be open; `tick` decides whether it counts. Returns a code or None."""
    parsed = parse_answer(text)
    if parsed is None:
        return None
    value = parsed[0]
    if not _listing(armed_dir(state_dir)) and not os.path.exists(asks_path(state_dir)):
        return "answer_no_ask"
    note = {
        "id": uuid7(),
        "value": value,
        "at_epoch": now,
        "session_id": session_id if isinstance(session_id, str) and _ID.match(session_id) else None,
        "turn_id": turn_id if isinstance(turn_id, str) and _ID.match(turn_id) else None,
    }
    with _MEMORY_LOCK:
        if len(_ANSWERS) >= MAX_ANSWER_NOTES:
            return "answer_backlog"
        _ANSWERS.append(note)
    return "answer_noted"


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
    message_hash = data.get("message_hash")
    if message_hash is not None and not (isinstance(message_hash, str) and _HASH.match(message_hash)):
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
        if not (isinstance(execution_id, str) and _EXECUTION.match(execution_id)) or subject is None or execution_id in seen:
            _count(codes, "ask_refused")
            continue
        seen.add(execution_id)
        asks.append({"execution_id": execution_id, **subject})
    return asks


def _record_asked(state_dir: str, opportunity_id: str, when: str) -> None:
    data, why = private_file(asked_ledger_path(state_dir), LEDGER_MAX_BYTES)
    asked = data.get("asked") if why is None and isinstance(data, dict) else None
    asked = {k: v for k, v in asked.items() if isinstance(k, str) and _OPPORTUNITY.match(k) and isinstance(v, str) and len(v) <= 40} if isinstance(asked, dict) else {}
    asked.pop(opportunity_id, None)
    asked[opportunity_id] = when
    while len(asked) > MAX_ASKED:
        asked.pop(next(iter(asked)))
    _write(asked_ledger_path(state_dir), {"v": 1, "asked": asked})


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
        if armed_names or asks:
            rows = {r.get("id"): r for r in read_terminal_executions(os.path.join(home, "cron", "executions.db"))}

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
            asks.append({"execution_id": execution_id, **subject})
            asked_executions.add(execution_id)
            rows[execution_id] = row
            changed = True
            _record_asked(state_dir, subject["opportunity_id"], asked_at or "")
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
        for note in sorted(answers, key=lambda n: n["at_epoch"]):
            at = note["at_epoch"]
            before = [a for a in confirmed if a["start"] <= at]
            latest = max(before, key=lambda a: a["start"]) if before else None
            if any(p <= at and (latest is None or p > latest["start"]) for p in pending):
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
        kept = [{"execution_id": a["execution_id"], "outcome_id": a["outcome_id"], "opportunity_id": a["opportunity_id"]} for a in asks if a["execution_id"] in kept_ids][-20:]
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
