"""The evening outcome ask (DATA-42, ruling R2): `outcome.asked` and the answer.

The 19:00 trigger (`skills/index-network/scripts/outcome-ask.ts`) asks about
one accepted connection and, when it wakes the model with the question,
writes a stage file naming the subject: `av-events/proactive/
outcome-ask-evening.json`, 0600, ids only. Three steps here:

1. **Arm** (`post_llm_call` of a cron session; `arm`). Only for a run of the
   installer's "Edge — evening questions" job (its id in `installed_jobs.json`
   and its name in `jobs.json`, as for `cron.run`), whose Hermes task id is
   `cron:<job>:<execution>`, with a stage file under STAGE_MAX_AGE_S old. A
   reply that is Hermes's silence marker removes the stage and arms nothing;
   so does a stale stage. Otherwise the stage is renamed into
   `av-events/outcome-ask/armed/<execution>.json` (the rename is the claim:
   two processes cannot both take it) with the keyed hash of the reply,
   which is `message.out`'s `content_hash` for the same turn.
2. **Confirm and emit** (the flusher, beside the cron tail; `tick`). When
   Hermes's executions ledger has the armed run in a terminal state, it emits
   one `outcome.asked` per subject only when the run completed and
   `delivery_outcome` is `delivered` or `queued` (or, on a Hermes without
   that column, the run completed), then records the subject in
   `av-events/proactive/outcome-asked.json`, which is the only thing that
   makes the trigger treat a subject as asked. A failed or suppressed
   delivery removes the armed file and emits nothing; the subject stays due.
3. **The answer** (`pre_llm_call` of the resident's Telegram DM;
   `note_answer`, then `tick`). A message whose whole text, trimmed and
   case-folded, is one of ANSWERS is noted as a file holding only the value
   and the time. `tick` emits `outcome.reported` for it only when the latest
   ask armed before it named exactly one subject, was delivered, is not yet
   answered, and the message came within ANSWER_WINDOW_S of it. Anything
   else is not an answer and is dropped. No text and no hash of the reply
   goes into the event or the file.

The hash is of the model's reply. Hermes may wrap a cron delivery in a
header and footer (`cron.wrap_response`, default on) or prepend a fallback
notice, so it is not a hash of the bytes Telegram showed.

Logs: codes and counts only. Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import os
import re
import threading
from typing import Any, Callable, Optional

from ._core import DIR_MODE, FILE_MODE, MAX_BUFFER_AGE_S, derived_uuid7, epoch_from_iso, iso_from_epoch, iso_from_text, uuid7
from ._cron import INSTALLED_JOBS_FILE, load_installed_job_ids, load_job_names, read_terminal_executions
from ._messages import is_silent

try:  # POSIX only; on a platform without it the tick runs unlocked.
    import fcntl
except ImportError:  # pragma: no cover - Hermes tenants are Linux
    fcntl = None  # type: ignore[assignment]

#: The installer's job names that stage an ask, and the action each stages
#: for (the stage file's name). The name must be exactly the installer's and
#: the id one it recorded, so a participant's own job never arms.
STAGED_JOBS = {"Edge — evening questions": "evening"}

#: A stage older than this when the run's reply arrives is not this run's:
#: removed, never armed. The trigger stops itself at 100 s; the model writes
#: one sentence.
STAGE_MAX_AGE_S = 15 * 60
#: A stage dated further in the future than this (a wrong clock) is stale too.
STAGE_FUTURE_SLACK_S = 120
#: An answer counts for this long after its ask was delivered (`window_days: 1`).
ANSWER_WINDOW_S = 24 * 60 * 60
#: An armed run the ledger never finishes is dropped after this (the cron tail's horizon).
ARMED_MAX_AGE_S = MAX_BUFFER_AGE_S
#: Delivered asks are remembered this long, for the answers.
ASKS_KEEP_S = 48 * 60 * 60
#: Unprocessed answer notes kept at most (the flusher normally takes them within a minute).
MAX_ANSWER_NOTES = 50
#: Subjects remembered in the asked ledger the trigger reads.
MAX_ASKED = 2000

MATCHER_VERSION = "outcome_reply_v1"
DELIVERED = frozenset({"delivered", "queued"})

#: The whole message, normalised (`normalise`), and the §4.1 value it is.
ANSWERS = {
    "met": "met",
    "we met": "met",
    "useful": "useful",
    "not useful": "not_useful",
    "missed": "missed",
    "did not happen": "did_not_happen",
    "didnt happen": "did_not_happen",
}

_TASK = re.compile(r"^cron:([0-9a-f]{12}):([0-9a-f]{32})$")
_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_CODE = re.compile(r"^[a-z_]{1,32}$")
_APOSTROPHES = re.compile(r"['’‘`]")
#: The pointer Hermes puts in front of a message sent as a Telegram reply
#: (`gateway/run_inbound.py` `_prepend_inbound_reply_context` at v2026.9.24).
#: It is Hermes's text, not the resident's, so it is not part of "the whole message".
_REPLY_POINTER = re.compile(r'^\[Replying to(?: your previous message)?: ".*?"\]\n\n', re.DOTALL)

_LOCK = threading.Lock()


# -- paths --------------------------------------------------------------------


def stage_path(state_dir: str, action: str) -> str:
    return os.path.join(state_dir, "proactive", f"outcome-ask-{action}.json")


def asked_ledger_path(state_dir: str) -> str:
    return os.path.join(state_dir, "proactive", "outcome-asked.json")


def _root(state_dir: str) -> str:
    return os.path.join(state_dir, "outcome-ask")


def armed_dir(state_dir: str) -> str:
    return os.path.join(_root(state_dir), "armed")


def answers_dir(state_dir: str) -> str:
    return os.path.join(_root(state_dir), "answers")


def asks_path(state_dir: str) -> str:
    return os.path.join(_root(state_dir), "asks.json")


# -- small file helpers -------------------------------------------------------


def _read(path: str) -> Any:
    try:
        if os.path.getsize(path) > 256 * 1024:
            return None
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _write(path: str, data: Any) -> None:
    """By temp file and rename, 0600 in a 0700 directory. Raises OSError."""
    os.makedirs(os.path.dirname(path), mode=DIR_MODE, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
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
    try:
        os.unlink(path)
    except OSError:
        pass


def _listing(path: str) -> list[str]:
    try:
        return sorted(name for name in os.listdir(path) if name.endswith(".json"))
    except OSError:
        return []


# -- the answer table ---------------------------------------------------------


def normalise(text: Any) -> str:
    """The resident's whole message, case-folded, apostrophes dropped, every
    other non-alphanumeric character a space, whitespace collapsed. A leading
    Telegram reply pointer (Hermes's, not theirs) is removed first."""
    if not isinstance(text, str):
        return ""
    text = _REPLY_POINTER.sub("", text.strip(), count=1)
    text = _APOSTROPHES.sub("", text.casefold())
    return " ".join("".join(ch if ch.isalnum() else " " for ch in text).split())


def answer_value(text: Any) -> Optional[str]:
    """`outcome_reply_v1`: the value when the whole message is one of ANSWERS, else None."""
    return ANSWERS.get(normalise(text))


# -- 1. arm -------------------------------------------------------------------


def _valid_stage(data: Any, action: str) -> Optional[dict]:
    if not isinstance(data, dict) or data.get("v") != 1 or data.get("action") != action:
        return None
    staged = epoch_from_iso(iso_from_text(data.get("staged_at")))
    window = data.get("window_days")
    asked_by = data.get("asked_by")
    subjects = data.get("subjects")
    if staged is None or isinstance(window, bool) or not isinstance(window, int) or not 1 <= window <= 30:
        return None
    if not isinstance(asked_by, str) or not _CODE.match(asked_by):
        return None
    if not isinstance(subjects, list) or not 1 <= len(subjects) <= 6:
        return None
    clean = []
    for subject in subjects:
        if not isinstance(subject, dict):
            return None
        outcome_id, opportunity_id = subject.get("outcome_id"), subject.get("opportunity_id")
        if not (isinstance(outcome_id, str) and _ID.match(outcome_id) and isinstance(opportunity_id, str) and _ID.match(opportunity_id)):
            return None
        clean.append({"outcome_id": outcome_id, "opportunity_id": opportunity_id})
    return {"staged": staged, "window_days": window, "asked_by": asked_by, "subjects": clean}


def staged_action(home: str, job_id: str) -> Optional[str]:
    """The action a cron job stages for: an installer job by id and exact name, else None."""
    if job_id not in load_installed_job_ids(os.path.join(home, INSTALLED_JOBS_FILE)):
        return None
    return STAGED_JOBS.get(load_job_names(os.path.join(home, "cron", "jobs.json")).get(job_id, ""))


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
    action = staged_action(home, job_id)
    if action is None:
        return None
    path = stage_path(state_dir, action)
    if not os.path.exists(path):
        return "no_stage"
    stage = _valid_stage(_read(path), action)
    if stage is None or not (now - STAGE_MAX_AGE_S <= stage["staged"] <= now + STAGE_FUTURE_SLACK_S):
        _unlink(path)
        return "stale_stage"
    if not isinstance(reply, str) or not reply.strip() or is_silent(reply):
        _unlink(path)
        return "silent"
    claim = os.path.join(armed_dir(state_dir), f"{execution_id}.claim")
    try:
        os.makedirs(armed_dir(state_dir), mode=DIR_MODE, exist_ok=True)
        os.rename(path, claim)
    except FileNotFoundError:
        return "lost_race"
    armed = {
        "v": 1,
        "execution_id": execution_id,
        "job_id": job_id,
        "session_id": session_id if isinstance(session_id, str) and _ID.match(session_id) else None,
        "run_id": task_id,
        "armed_epoch": now,
        "asked_by": stage["asked_by"],
        "window_days": stage["window_days"],
        "subjects": stage["subjects"],
        "message_hash": hasher(reply) if capture != "metadata" else None,
    }
    try:
        _write(os.path.join(armed_dir(state_dir), f"{execution_id}.json"), armed)
    finally:
        _unlink(claim)
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
    decided it is the resident, in a Telegram DM). Writes a note holding the
    value and the time only when the whole message is an answer and an ask
    may be open; `tick` decides whether it counts. Returns a code or None."""
    value = answer_value(text)
    if value is None:
        return None
    if not _listing(armed_dir(state_dir)) and not os.path.exists(asks_path(state_dir)):
        return "answer_no_ask"
    if len(_listing(answers_dir(state_dir))) >= MAX_ANSWER_NOTES:
        return "answer_backlog"
    note = {
        "v": 1,
        "value": value,
        "at_epoch": now,
        "session_id": session_id if isinstance(session_id, str) and _ID.match(session_id) else None,
        "turn_id": turn_id if isinstance(turn_id, str) and _ID.match(turn_id) else None,
    }
    _write(os.path.join(answers_dir(state_dir), f"{uuid7()}.json"), note)
    return "answer_noted"


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
        self.handle = os.open(self.path, os.O_RDWR | os.O_CREAT, FILE_MODE)
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


def _load_asks(state_dir: str) -> list[dict]:
    data = _read(asks_path(state_dir))
    asks = data.get("asks") if isinstance(data, dict) else None
    return [a for a in asks if isinstance(a, dict)] if isinstance(asks, list) else []


def _record_asked(state_dir: str, opportunity_ids: list[str], when: str) -> None:
    data = _read(asked_ledger_path(state_dir))
    asked = data.get("asked") if isinstance(data, dict) else None
    asked = {k: v for k, v in asked.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(asked, dict) else {}
    for opportunity_id in opportunity_ids:
        asked.pop(opportunity_id, None)
        asked[opportunity_id] = when
    while len(asked) > MAX_ASKED:
        asked.pop(next(iter(asked)))
    _write(asked_ledger_path(state_dir), {"v": 1, "asked": asked})


def _delivered(row: dict) -> bool:
    if row.get("status") != "completed":
        return False
    if "delivery_outcome" not in row:  # a Hermes without the column
        return True
    return row.get("delivery_outcome") in DELIVERED


def _count(codes: dict, code: str) -> None:
    codes[code] = codes.get(code, 0) + 1


def tick(state_dir: str, home: str, emit: Callable[..., Optional[dict]], now: float) -> dict:
    """Steps 2 and 3b, on the flusher thread. Returns code -> count."""
    codes: dict[str, int] = {}
    with _LOCK, _FileLock(os.path.join(_root(state_dir), ".lock")) as lock:
        if not lock.held:
            return {"contended": 1}
        for action in STAGED_JOBS.values():
            path = stage_path(state_dir, action)
            stage = _valid_stage(_read(path), action) if os.path.exists(path) else {"staged": now}
            if stage is None or now - stage["staged"] > STAGE_MAX_AGE_S:
                _unlink(path)
                _count(codes, "stale_stage")
        asks = _load_asks(state_dir)
        changed = False

        armed_names = _listing(armed_dir(state_dir))
        rows = {}
        if armed_names:
            rows = {r.get("id"): r for r in read_terminal_executions(os.path.join(home, "cron", "executions.db"))}
        pending: list[float] = []
        for name in armed_names:
            path = os.path.join(armed_dir(state_dir), name)
            armed = _read(path)
            if not isinstance(armed, dict) or not isinstance(armed.get("armed_epoch"), (int, float)) or not isinstance(armed.get("subjects"), list):
                _unlink(path)
                _count(codes, "bad_armed")
                continue
            row = rows.get(armed.get("execution_id"))
            if row is None:
                if now - armed["armed_epoch"] > ARMED_MAX_AGE_S:
                    _unlink(path)
                    _count(codes, "armed_expired")
                else:
                    pending.append(float(armed["armed_epoch"]))
                continue
            if not _delivered(row):
                _unlink(path)
                _count(codes, "not_delivered")
                continue
            finished = iso_from_text(row.get("finished_at"))
            asked_epoch = epoch_from_iso(finished) or now
            asked_at = iso_from_epoch(asked_epoch)
            event_ids: dict[str, str] = {}
            emitted = True
            for subject in armed["subjects"]:
                event_id = derived_uuid7(int(asked_epoch * 1000), f"av-events|outcome.asked|{armed['execution_id']}|{subject['outcome_id']}")
                event = emit(
                    "outcome.asked",
                    {"message_hash": armed.get("message_hash"), "window_days": armed.get("window_days"), "asked_by": armed.get("asked_by")},
                    event_id=event_id,
                    occurred_at=asked_at,
                    occurred_at_earliest=iso_from_epoch(armed["armed_epoch"]),
                    occurred_at_latest=asked_at,
                    actor="agent",
                    session_id=armed.get("session_id"),
                    run_id=armed.get("run_id"),
                    outcome_id=subject["outcome_id"],
                    opportunity_id=subject["opportunity_id"],
                )
                if event is None:
                    emitted = False
                    break
                event_ids[subject["outcome_id"]] = event_id
            if not emitted:
                # The sink is off: keep the armed file and try again next pass.
                pending.append(float(armed["armed_epoch"]))
                _count(codes, "emit_refused")
                continue
            asks.append({
                "execution_id": armed["execution_id"],
                "armed_epoch": float(armed["armed_epoch"]),
                "asked_epoch": asked_epoch,
                "subjects": armed["subjects"],
                "event_ids": event_ids,
                "answered": False,
            })
            changed = True
            _record_asked(state_dir, [s["opportunity_id"] for s in armed["subjects"]], asked_at or "")
            _unlink(path)
            _count(codes, "asked")

        for name in _listing(answers_dir(state_dir)):
            path = os.path.join(answers_dir(state_dir), name)
            note = _read(path)
            at = note.get("at_epoch") if isinstance(note, dict) else None
            if not isinstance(at, (int, float)) or note.get("value") not in ANSWERS.values():
                _unlink(path)
                _count(codes, "bad_answer")
                continue
            confirmed = [a for a in asks if isinstance(a.get("armed_epoch"), (int, float)) and a["armed_epoch"] <= at]
            latest = max(confirmed, key=lambda a: a["armed_epoch"]) if confirmed else None
            newer_pending = [p for p in pending if p <= at and (latest is None or p > latest["armed_epoch"])]
            if newer_pending:
                if now - at > ARMED_MAX_AGE_S:
                    _unlink(path)
                    _count(codes, "answer_expired")
                continue  # its ask is armed but not yet confirmed: wait
            if latest is None:
                _unlink(path)
                _count(codes, "answer_no_ask")
                continue
            subjects = latest.get("subjects") or []
            if len(subjects) != 1 or latest.get("answered") or at > float(latest.get("asked_epoch") or 0) + ANSWER_WINDOW_S:
                _unlink(path)
                _count(codes, "answer_not_counted")
                continue
            subject = subjects[0]
            ask_event_id = (latest.get("event_ids") or {}).get(subject["outcome_id"])
            event = emit(
                "outcome.reported",
                {"value": note["value"], "matcher_version": MATCHER_VERSION},
                event_id=derived_uuid7(int(at * 1000), f"av-events|outcome.reported|{name}"),
                occurred_at=iso_from_epoch(at),
                occurred_at_earliest=iso_from_epoch(at),
                occurred_at_latest=iso_from_epoch(at),
                actor="participant",
                evidence_class="self_report",
                session_id=note.get("session_id"),
                turn_id=note.get("turn_id"),
                outcome_id=subject["outcome_id"],
                opportunity_id=subject["opportunity_id"],
                in_reply_to_event_id=ask_event_id,
            )
            if event is None:
                _count(codes, "emit_refused")
                break
            latest["answered"] = True
            changed = True
            _unlink(path)
            _count(codes, "answered")

        kept = [a for a in asks if now - float(a.get("asked_epoch") or 0) <= ASKS_KEEP_S][-20:]
        if changed or len(kept) != len(asks):
            if kept:
                _write(asks_path(state_dir), {"v": 1, "asks": kept})
            else:
                _unlink(asks_path(state_dir))
    return codes


__all__ = [
    "ANSWERS",
    "ANSWER_WINDOW_S",
    "MATCHER_VERSION",
    "STAGED_JOBS",
    "STAGE_MAX_AGE_S",
    "answer_value",
    "arm",
    "armed_dir",
    "answers_dir",
    "asked_ledger_path",
    "asks_path",
    "normalise",
    "note_answer",
    "stage_path",
    "staged_action",
    "tick",
]
