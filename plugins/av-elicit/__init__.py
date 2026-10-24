"""av-elicit: the box half of GC-ELICIT (the agent asks its human about ODIN's constitution).

Contract: GC-ELICIT v1, sections 1 (timing and gates), 3a (what the control plane writes), 3b (what this
plugin writes) and 3c (what the agent's tool writes). Everything lives under
``$HERMES_HOME/av-events/elicit/``:

  inject/<unix_ms>-<name>.txt   written by the control plane (``open``, ``next``, ``replan``). The first line
                                may be ``#trigger=<opener|answer|idle|human_message|replan>``; it is metadata,
                                stripped before injection, and read back for the tool's records.
  inject/<file>.done            this plugin: the gateway accepted the injection (rename; mtime = accept time).
  inject/<file>.skipped         this plugin: ``closed`` marker present, older than the 24 h age cap, or unusable.
  closed                        the control plane's empty marker: inject nothing, skip what is pending.
  probe.json                    this plugin, every 60 s while a window is open: human messages since T0.
  records/<unix_ms>-<id>.json   the ``elicitation_record`` tool, one per call, 0600.

The inject loop injects one file per pass, oldest first, as a user-role turn into the resident's DM session
(``agent:main:telegram:dm:<TELEGRAM_HOME_CHANNEL>``, or ``AV_ELICIT_SESSION_KEY``) through
``ctx.inject_message``. Hermes refuses unless ``plugins.entries.av-elicit.allow_gateway_injection: true`` and
the session exists, so the loop waits until ``state.db`` has a Telegram session under that key. Nothing is
injected between 22:00 and 08:00 IST, nor while av-godconst's ``av-events/godconst/page-open`` marker
exists (a sent ballot card page still has unrated cards); the file is held, and only the 24 h age cap skips it.

Fail-open: no hooks, one daemon thread, one tool; every failure is a log code, never an exception into the
gateway. Logs carry codes and counts only, never a message's text. Python 3.9+, standard library only.
"""
from __future__ import annotations

import json
import logging
import os
import re
import stat
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger("av-elicit")

# --------------------------------------------------------------------------- constants

TOOL_NAME = "elicitation_record"
TOOLSET = "av-elicit"

SESSION_KEY_ENV = "AV_ELICIT_SESSION_KEY"
HOME_CHANNEL_ENV = "TELEGRAM_HOME_CHANNEL"

#: Every control-plane notice starts with this (contract §5); the probe never counts such a row as human.
NOTICE_PREFIX = "[Agent Village notice"

POLL_S = 5.0
PROBE_INTERVAL_S = 60.0
#: A staged file older than this (by its unix_ms name prefix, else mtime) is skipped, never injected.
AGE_CAP_S = 24 * 3600
#: IST has no daylight saving: a fixed offset needs no tz database on the box.
IST = timezone(timedelta(hours=5, minutes=30))
#: av-godconst's page-open marker older than this no longer holds injection.
BALLOT_PAGE_STALE_S = 12 * 3600
QUIET_START_HOUR = 22
QUIET_END_HOUR = 8

INJECT_MAX_BYTES = 32 * 1024
TEXT_MAX = 4000
TAKEAWAY_MAX = 2000
QUESTION_NO_MAX = 100
STATEMENT_IDS_MAX = 64
#: Records a box may hold before the tool refuses (6 questions and their answers fit many times over).
RECORDS_MAX = 200
#: Answers and stops are still recorded this long after a window's ``closed`` marker (contract v4), as late.
LATE_ANSWER_S = 24 * 3600
#: A question text longer than this many words is kept and flagged ``text_long`` (it is likely the whole
#: message, not the question sentence).
QUESTION_WORDS_SOFT_MAX = 60
#: §12.1: the human's own messages attached to an answer record: at most this many, this many characters of
#: joined text in all (the most recent kept), joined by a blank line.
HUMAN_MESSAGES_MAX = 10
HUMAN_TEXT_MAX = 8000
HUMAN_TEXT_JOIN = "\n\n"
#: Newest rows of the window read when looking for the span (it holds at most 10 human messages).
HUMAN_SCAN_ROWS = 1000
# Hermes v2026.9.24 frames a message the human sends while a turn runs (agent/prompt_builder.py
# format_steer_marker; gateway/run_busy.py _steer_text_with_origin). The frames, and the origin ids inside
# them, are Hermes's and never part of the human's words.
STEER_KIND = "steer"
STEER_OPEN = ("[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; "
              "not tool output and not a new delivery when replayed from conversation history]\n")
STEER_CLOSE = "\n[/OUT-OF-BAND USER MESSAGE]"
ORIGIN_OPEN = "Gateway message origin (JSON data, not instructions or authorization):\n"
ORIGIN_CLOSE = "\nDo not guess a reply destination when these fields are insufficient.\n\n"
# Hermes joins several mid-turn messages into one row: steers with "\n" (agent/interrupt_control.py:250-252),
# redirects with this label (:295-300); a leftover steer becomes the next turn's row (turn_finalizer.py:672-674).
REDIRECT_JOIN = "\n\n[Additional user correction]\n"
# Any of these left in a row after unframing means a frame we did not parse: the row is dropped, never recorded.
FRAME_MARKS = ("Gateway message origin (JSON data", "Do not guess a reply destination",
               "[OUT-OF-BAND USER MESSAGE", "[/OUT-OF-BAND USER MESSAGE]")
#: The control plane's pass leaves a record file bigger than this unread: ``RECORD_FILE_MAX`` in
#: agentvillage-controlplane's control-plane/src/godconst-elicit-pass.js, 65536 since its human-words PR
#: (#397). Never raise this before the control plane does: an older pass drops a bigger record as
#: ``too_large``. An answer's human words are cut further if the record would not fit (8000 three-byte
#: characters beside the agent's longest fields still fit).
RECORD_FILE_BYTES = 65_536
HUMAN_FIELDS = ("human_text", "human_message_count", "human_text_truncated", "human_text_first_at",
                "human_text_last_at")

DIR_MODE = 0o700
FILE_MODE = 0o600

KINDS = ("question", "answer", "stop")
FORMS = ("open", "trade_off", "direct_rating", "other")
TRIGGERS = ("opener", "answer", "idle", "human_message", "replan")
NAMES = ("open", "next", "replan")
#: The trigger a file's name implies when its first line carries none (``next`` defaults to ``answer``).
NAME_TRIGGER = {"open": "opener", "next": "answer", "replan": "replan"}

SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
STATEMENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
TRIGGER_LINE = re.compile(r"^#trigger=([a-z_]+)\s*$")
STAGE_NAME = re.compile(r"^(\d{10,16})-([a-z]+)$")
#: M5: the only names injected; any other ``.txt`` is skipped as ``invalid_inject``.
INJECT_NAME = re.compile(r"^\d{10,16}-(open|next|replan)\.txt$")
GATEWAY_MARKER = "_HERMES_GATEWAY"
#: A marker's ``window_ms`` matches a window within this much rounding.
WINDOW_MATCH_MS = 2000
CLOSE_REASONS_LOGGED = ("ballot_close", "withdrawn", "manual", "no_reply", "idle", "cap", "stopped", "not_delivered", "unknown")
#: M4: no injection while the human wrote in the home DM this recently.
HUMAN_RECENT_S = 5 * 60
GATEWAY_STATE_FRESH_S = 10 * 60
#: A ``.sending`` claim older than this was left by a process that died mid-injection.
ORPHAN_SENDING_S = 60
JOIN_TIMEOUT_S = 1.0
#: Under ``gateway start|restart``: how often the waiter checks for Hermes's gateway marker.
MARKER_POLL_S = 1.0

TOOL_DESCRIPTION = (
    "Record one step of the ODIN constitution conversation with your human: a question you sent them "
    "(kind question), their answer (kind answer: their words, what you learned, the statement ids it "
    "informed), or their 'not now' or 'stop' (kind stop). Call it every time you ask or they answer. For a "
    "question, text is the question sentence only, not your whole message (leave out the greeting and the "
    "lead-in). Questions are recorded only while the conversation is open; an answer or stop that arrives "
    "up to 24 hours after it closed is still recorded. It works only in your Telegram DM with your human."
)

TOOL_SCHEMA: dict = {
    "name": TOOL_NAME,
    "description": TOOL_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": list(KINDS),
                     "description": "question (you asked), answer (they answered) or stop (they said not now or stop)."},
            "question_no": {"type": "integer", "minimum": 1,
                            "description": "Your number for the question in this conversation, 1 for the first; an "
                                           "answer or a stop uses the number of the question it answers. The tool "
                                           "numbers questions itself and tells you the number it stored."},
            "category": {"type": "string",
                         "description": "The category id the question or answer is about (e.g. privacy_and_consent)."},
            "form": {"type": "string", "enum": list(FORMS),
                     "description": "Question only: open, trade_off, direct_rating or other."},
            "text": {"type": "string",
                     "description": "Required for question and answer: for a question, the question sentence "
                                    "only, exactly as you sent it (not the whole message); for an answer, "
                                    "their answer in their own words."},
            "takeaway": {"type": "string", "description": "Answer only: what you learned, in one or two sentences."},
            "statement_ids": {"type": "array", "items": {"type": "string"},
                              "description": "Answer only: the statement ids (e.g. s004) this answer informs."},
        },
        "required": ["kind", "question_no"],
        "additionalProperties": False,
    },
}

# --------------------------------------------------------------------------- state

_CTX: Any = None
_THREAD: Optional[threading.Thread] = None
_STOP: Optional[threading.Event] = None
#: The one thread waiting for the gateway marker under ``gateway start|restart``, and its stop event.
_WAITER: Optional[threading.Thread] = None
_WAIT_STOP: Optional[threading.Event] = None
#: Serialises every start of the loop (register, a reload, the waiter): no loop ever runs twice.
_LOOP_LOCK = threading.Lock()
_REGISTERED = False
_LAST_PROBE = 0.0
_LAST_CODE: Optional[str] = None
_RECORD_LOCK = threading.Lock()
_STATE_LOCK = threading.RLock()
#: The mtime of the stale page-open marker already logged (one line per stale marker).
_STALE_BALLOT_LOGGED: Optional[float] = None

# --------------------------------------------------------------------------- env, paths, logging


def hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _dotenv(home: str) -> dict:
    parsed: dict = {}
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8-sig") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith("export "):
                    line = line[7:].strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                parsed[name.strip()] = value.strip().strip("'\"")
    except OSError:
        return {}
    return parsed


def env(name: str, home: Optional[str] = None) -> str:
    """The process environment (a present, blank value is authoritative), else ``$HERMES_HOME/.env``."""
    raw = os.environ.get(name)
    if raw is not None:
        return raw.strip()
    return str(_dotenv(home or hermes_home()).get(name, "")).strip()


def elicit_dir(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "av-events", "elicit")


def inject_dir(home: Optional[str] = None) -> str:
    return os.path.join(elicit_dir(home), "inject")


def records_dir(home: Optional[str] = None) -> str:
    return os.path.join(elicit_dir(home), "records")


def closed_path(home: Optional[str] = None) -> str:
    return os.path.join(elicit_dir(home), "closed")


def last_answer_path(home: Optional[str] = None) -> str:
    """This plugin's own note of when the tool last wrote an ``answer`` record (contract 3c v3 trigger rule)."""
    return os.path.join(elicit_dir(home), "last_answer.json")


def window_state_path(home: Optional[str] = None) -> str:
    """This plugin's per-window question count (contract 3c amended): ``{"window_ms": n, "questions": n}``."""
    return os.path.join(elicit_dir(home), "window.json")


def probe_path(home: Optional[str] = None) -> str:
    return os.path.join(elicit_dir(home), "probe.json")


def ballot_page_marker(home: Optional[str] = None) -> str:
    """av-godconst's empty marker, present while a sent ballot card page still has unrated cards."""
    return os.path.join(home or hermes_home(), "av-events", "godconst", "page-open")


def ballot_page_open(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """True while the marker exists and was refreshed in the last 12 h (av-godconst touches it on every page
    it sends). An older marker is stale: it no longer holds, and ``stale_ballot_page`` is logged once."""
    global _STALE_BALLOT_LOGGED
    try:
        mtime = os.lstat(ballot_page_marker(home)).st_mtime
    except OSError:
        return False
    stamp = time.time() if now is None else now
    if stamp - mtime > BALLOT_PAGE_STALE_S:
        if _STALE_BALLOT_LOGGED != mtime:
            _STALE_BALLOT_LOGGED = mtime
            _log("stale_ballot_page", logging.WARNING, age_h=int((stamp - mtime) // 3600))
        return False
    return True


def state_db(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "state.db")


def session_key(home: Optional[str] = None) -> Optional[str]:
    override = env(SESSION_KEY_ENV, home)
    if override:
        return override
    chat = env(HOME_CHANNEL_ENV, home)
    return f"agent:main:telegram:dm:{chat}" if chat else None


def _log(outcome: str, level: int = logging.INFO, **counts: Any) -> None:
    extra = "".join(f" {key}={value}" for key, value in sorted(counts.items()))
    logger.log(level, "av-elicit: outcome=%s%s", outcome, extra)


def _log_once(outcome: str, level: int = logging.INFO, **counts: Any) -> None:
    """Log a waiting state once until the state changes (the loop runs every few seconds)."""
    global _LAST_CODE
    if _LAST_CODE != outcome:
        _LAST_CODE = outcome
        _log(outcome, level, **counts)


def now_iso(epoch: Optional[float] = None) -> str:
    stamp = datetime.fromtimestamp(time.time() if epoch is None else epoch, tz=timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --------------------------------------------------------------------------- quiet hours, ages, names


def in_quiet_hours(epoch: float) -> bool:
    """True from 22:00 to 08:00 Asia/Kolkata (contract §1): no injection, the file is held."""
    hour = datetime.fromtimestamp(epoch, tz=IST).hour
    return hour >= QUIET_START_HOUR or hour < QUIET_END_HOUR


def parse_stage_name(filename: str) -> Optional[tuple]:
    """``<unix_ms>-<name>.<ext>`` -> ``(unix_ms, name)``, or None for anything else."""
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    match = STAGE_NAME.match(stem)
    if not match:
        return None
    return int(match.group(1)), match.group(2)


def staged_at(path: str) -> Optional[float]:
    """Seconds since the epoch the file was staged: its name's unix_ms, else its mtime."""
    parsed = parse_stage_name(os.path.basename(path))
    if parsed:
        return parsed[0] / 1000.0
    try:
        return os.stat(path).st_mtime
    except OSError:
        return None


def split_trigger(raw: str) -> tuple:
    """``(trigger_or_None, text)``: a ``#trigger=`` first line is removed from the text to inject."""
    first, _, rest = raw.partition("\n")
    match = TRIGGER_LINE.match(first.strip("\r"))
    if not match:
        return None, raw
    value = match.group(1)
    return (value if value in TRIGGERS else None), rest.lstrip("\r\n")


def trigger_for(filename: str, first_line_trigger: Optional[str]) -> Optional[str]:
    """The record's trigger for the last injected file: its ``#trigger=`` line, else its name's default."""
    if first_line_trigger in TRIGGERS:
        return first_line_trigger
    parsed = parse_stage_name(filename)
    return NAME_TRIGGER.get(parsed[1]) if parsed else None


# --------------------------------------------------------------------------- files


def _listing(directory: str, suffix: str) -> list:
    """Names in ``directory`` ending in ``suffix``, sorted (unix_ms names sort by staging time)."""
    try:
        return sorted(n for n in os.listdir(directory) if n.endswith(suffix) and not n.startswith("."))
    except OSError:
        return []


def _read_regular(path: str, max_bytes: int) -> tuple:
    """``(text, None)`` or ``(None, code)``: a regular file, never through a symlink, bounded."""
    try:
        st = os.lstat(path)
    except OSError:
        return None, "missing"
    if not stat.S_ISREG(st.st_mode):
        return None, "not_regular"
    if st.st_size > max_bytes:
        return None, "too_big"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError:
        return None, "unreadable"
    if len(raw) > max_bytes:
        return None, "too_big"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "not_utf8"


def _swap_suffix(path: str, suffix: str) -> str:
    for old in (".txt", ".sending"):
        if path.endswith(old):
            return path[: -len(old)] + suffix
    return path + suffix


def _rename_now(path: str, suffix: str, home: Optional[str] = None, now: Optional[float] = None) -> Optional[str]:
    """Rename ``x.txt`` / ``x.sending`` to ``x<suffix>`` and stamp its mtime now: the control plane reads the
    rename time as ``delivered_at`` (a rename alone keeps the staging mtime). When the stamp fails, the time
    goes to the ``accepted.json`` sidecar, which every reader of accept times prefers. Returns the new path,
    or None when the rename failed."""
    target = _swap_suffix(path, suffix)
    try:
        os.rename(path, target)
    except OSError:
        return None
    try:
        os.utime(target, None)
    except OSError:
        note_accept_time(os.path.basename(target), time.time() if now is None else now, home)
    return target


def write_private_json(path: str, data: Any) -> None:
    """By temp file and rename, 0600 in a 0700 directory; the temp name starts with a dot and never ends in
    ``.json``, so a reader listing ``*.json`` never sees a half-written file. Raises OSError."""
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=DIR_MODE, exist_ok=True)
    tmp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.{threading.get_ident()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), FILE_MODE)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, separators=(",", ":"), ensure_ascii=False)
        os.chmod(tmp, FILE_MODE)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path: str, max_bytes: int = 64 * 1024) -> Any:
    raw, _ = _read_regular(path, max_bytes)
    if raw is None:
        return None
    try:
        return json.loads(raw.lstrip("﻿"))
    except ValueError:
        return None


# --------------------------------------------------------------------------- accept times (L3)


def accepted_sidecar_path(home: Optional[str] = None) -> str:
    """Accept times this plugin could not stamp as an mtime: ``{"<file>.done": <unix_ms>}``."""
    return os.path.join(elicit_dir(home), "accepted.json")


def _accepted_sidecar(home: Optional[str] = None) -> dict:
    body = _read_json(accepted_sidecar_path(home))
    return body if isinstance(body, dict) else {}


def note_accept_time(name: str, at: float, home: Optional[str] = None) -> None:
    body = _accepted_sidecar(home)
    body[name] = int(at * 1000)
    try:
        write_private_json(accepted_sidecar_path(home), body)
    except OSError as exc:
        _log("accept_time_write_failed", logging.WARNING, error=type(exc).__name__)


def done_files(home: Optional[str] = None) -> list:
    """``(accept_time_s, name)`` for every ``.done``, oldest first: the sidecar's time when it has one,
    else the mtime."""
    directory = inject_dir(home)
    sidecar = _accepted_sidecar(home)
    out = []
    for name in _listing(directory, ".done"):
        noted = sidecar.get(name)
        if isinstance(noted, int) and not isinstance(noted, bool) and noted > 0:
            out.append((noted / 1000.0, name))
            continue
        try:
            out.append((os.stat(os.path.join(directory, name)).st_mtime, name))
        except OSError:
            continue
    return sorted(out)


def open_done_times(home: Optional[str] = None) -> list:
    """Accept times (seconds) of every ``*-open.done``, oldest first."""
    return [at for at, _ in open_dones(home)]


def open_dones(home: Optional[str] = None) -> list:
    """``(accept_time_s, window_ms)`` of every ``*-open.done``, oldest accepted first. ``window_ms`` is the
    unix_ms prefix of the open file's name (contract §9): the window's id everywhere; the accept time is
    only T0 for the probe."""
    out = []
    for at, name in done_files(home):
        parsed = parse_stage_name(name)
        if parsed and parsed[1] == "open":
            out.append((at, parsed[0]))
    return out


def last_injected(home: Optional[str] = None) -> Optional[tuple]:
    """``(accept_time_s, path)`` of the ``.done`` file accepted last, or None."""
    files = done_files(home)
    if not files:
        return None
    at, name = files[-1]
    return at, os.path.join(inject_dir(home), name)


def current_trigger(home: Optional[str] = None) -> Optional[str]:
    """The trigger of the notice injected last: what a question recorded now answers to."""
    last = last_injected(home)
    if not last:
        return None
    text, _ = _read_regular(last[1], INJECT_MAX_BYTES)
    first = split_trigger(text.lstrip("﻿"))[0] if text is not None else None
    return trigger_for(os.path.basename(last[1]), first)


# --------------------------------------------------------------------------- windows and closure (M1, M2)


def is_closed(home: Optional[str] = None) -> bool:
    """The ``closed`` marker is on disk (it may belong to an earlier window; see ``window_state``)."""
    return os.path.lexists(closed_path(home))


def read_closed_marker(home: Optional[str] = None) -> Optional[dict]:
    """The control plane's marker as ``{"reason", "window_ms", "mtime"}``, or None without one. The marker
    is ``{"reason": "...", "window_ms": n}``; an empty or unreadable (legacy) marker is reason ``unknown``."""
    path = closed_path(home)
    try:
        mtime = os.lstat(path).st_mtime
    except OSError:
        return None
    body = _read_json(path, 4096)
    reason, window_ms = "unknown", None
    if isinstance(body, dict):
        raw_reason = body.get("reason")
        if isinstance(raw_reason, str) and SLUG.match(raw_reason.strip()):
            reason = raw_reason.strip()
        raw_window = body.get("window_ms")
        if isinstance(raw_window, int) and not isinstance(raw_window, bool) and raw_window > 0:
            window_ms = raw_window
    return {"reason": reason, "window_ms": window_ms, "mtime": mtime}


def closed_time(home: Optional[str] = None) -> Optional[float]:
    """The ``closed`` marker's mtime, or None without one."""
    marker = read_closed_marker(home)
    return marker["mtime"] if marker else None


def marker_applies(marker: dict, window_ms: int, accepted_s: Optional[float] = None) -> bool:
    """A marker naming a window applies to exactly that window (the open file's unix_ms); a legacy marker
    without one applies to the window accepted at or before it."""
    if marker.get("window_ms") is not None:
        return marker["window_ms"] == window_ms
    return marker["mtime"] >= (accepted_s if accepted_s is not None else window_ms / 1000.0)


def current_window(home: Optional[str] = None) -> Optional[tuple]:
    """``(window_ms, accept_time_s)`` of the newest accepted opener, or None."""
    opens = open_dones(home)
    return (opens[-1][1], opens[-1][0]) if opens else None


def current_window_ms(home: Optional[str] = None) -> Optional[int]:
    current = current_window(home)
    return current[0] if current else None


def _fresh_state(window_ms: int) -> dict:
    return {"window_ms": window_ms, "questions": 0, "closed_at_ms": None, "close_reason": None, "stopped": False}


def load_window_state(window_ms: int, home: Optional[str] = None) -> dict:
    """``window.json`` for this window; a file left by another window (or unreadable) is a fresh state."""
    body = _read_json(window_state_path(home), 4096)
    state = _fresh_state(window_ms)
    if not isinstance(body, dict) or body.get("window_ms") != window_ms:
        return state
    count = body.get("questions")
    if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
        state["questions"] = count
    closed = body.get("closed_at_ms")
    if isinstance(closed, int) and not isinstance(closed, bool) and closed > 0:
        state["closed_at_ms"] = closed
        reason = body.get("close_reason")
        state["close_reason"] = reason if isinstance(reason, str) and reason else "unknown"
    state["stopped"] = body.get("stopped") is True
    return state


def save_window_state(state: dict, home: Optional[str] = None) -> bool:
    try:
        write_private_json(window_state_path(home), state)
        return True
    except OSError as exc:
        _log("window_state_write_failed", logging.WARNING, error=type(exc).__name__)
        return False


def window_state(home: Optional[str] = None, now: Optional[float] = None) -> Optional[dict]:
    """The newest window's state, or None before any opener was accepted. The first time a ``closed`` marker
    that applies to this window is seen, its close time (the marker's mtime, never later than now) and reason
    are written into ``window.json``: from then on the window stays closed, whatever happens to the marker,
    and the 24 h late period runs from that time."""
    current = current_window(home)
    if current is None:
        return None
    window_ms, accepted = current
    with _STATE_LOCK:
        state = load_window_state(window_ms, home)
        state["accepted_ms"] = int(round(accepted * 1000))
        if state["closed_at_ms"] is None:
            marker = read_closed_marker(home)
            if marker is not None and marker_applies(marker, window_ms, accepted):
                stamp = time.time() if now is None else now
                state["closed_at_ms"] = int(min(marker["mtime"], stamp) * 1000)
                state["close_reason"] = marker["reason"]
                save_window_state({k: v for k, v in state.items() if k != "accepted_ms"}, home)
                _log("window_closed", reason=marker["reason"] if marker["reason"] in CLOSE_REASONS_LOGGED else "other")
    return state


def window_start(home: Optional[str] = None, now: Optional[float] = None) -> Optional[float]:
    """The open window's T0 (the newest ``*-open.done`` accept time), or None when none is open."""
    state = window_state(home, now)
    if state is None or state["closed_at_ms"] is not None:
        return None
    return state["accepted_ms"] / 1000.0


def late_window_start(home: Optional[str] = None, now: Optional[float] = None) -> Optional[float]:
    """The start of the window closed last, while late answers and stops may still go to it: closed at most
    24 h ago (from the time persisted at first sight), not withdrawn, and no stop recorded. Else None."""
    state = window_state(home, now)
    if state is None or state["closed_at_ms"] is None:
        return None
    stamp = time.time() if now is None else now
    if state["close_reason"] == "withdrawn" or state["stopped"]:
        return None
    if stamp - state["closed_at_ms"] / 1000.0 > LATE_ANSWER_S:
        return None
    return state["accepted_ms"] / 1000.0


def window_open(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    return window_start(home, now) is not None


# --------------------------------------------------------------------------- the tool's notes


def last_answer_time(home: Optional[str] = None) -> Optional[float]:
    """Seconds since the epoch of the last ``answer`` record the tool wrote, or None."""
    body = _read_json(last_answer_path(home), 4096)
    value = body.get("at_ms") if isinstance(body, dict) else None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value / 1000.0


def window_questions(window_ms: int, home: Optional[str] = None) -> int:
    """Questions recorded in the window starting at ``window_ms`` per ``window.json`` (0 for another window)."""
    return load_window_state(window_ms, home)["questions"]


RECORD_FILE = re.compile(r"^\d{10,16}-[0-9a-f-]{36}\.json")


def recount_questions(window_ms: int, home: Optional[str] = None) -> int:
    """Question records in ``records/`` with any suffix (``.json``, ``.sent``, ``.refused-...``) whose
    ``window_ms`` is this window's (M3: the control plane renames records, so the file count alone can't be
    trusted; this recount backs up ``window.json``)."""
    directory = records_dir(home)
    try:
        names = os.listdir(directory)
    except OSError:
        return 0
    count = 0
    for name in names:
        if not RECORD_FILE.match(name):
            continue
        body = _read_json(os.path.join(directory, name), 16 * 1024)
        if isinstance(body, dict) and body.get("kind") == "question" and body.get("window_ms") == window_ms:
            count += 1
    return count


def assign_question_no(kind: str, agent_no: int, asked: int) -> int:
    """The stored ``question_no``, never the agent's own count (it numbers from its whole DM history): a
    question is ``asked + 1``; an answer or a stop is the window's latest question, unless the agent names an
    earlier question of this window (1..asked). Before any question, an answer or stop is 1."""
    if kind == "question":
        return asked + 1
    if 1 <= agent_no <= asked:
        return agent_no
    return max(asked, 1)


def question_trigger(home: Optional[str] = None, window_ms: Optional[int] = None) -> Optional[str]:
    """The trigger of a question recorded now (contract 3c v3). The agent asks questions 2..n in the same
    reply that records the answer, with no file injected: a question after an ``answer`` record, with no
    inject file accepted since that answer, is ``answer``. Otherwise the last accepted file's trigger (so
    only the window's first question is ``opener``)."""
    answered = last_answer_time(home)
    if answered is not None:
        last = last_injected(home)
        start = window_ms / 1000.0 if window_ms is not None else None
        if (last is None or answered > last[0]) and (start is None or answered > start):
            return "answer"
    return current_trigger(home)


# --------------------------------------------------------------------------- state.db (read-only)


def _sqlite_rows(path: str, sql: str, params: tuple = ()) -> Optional[list]:
    """Rows from a Hermes store opened read-only, or None on any failure (missing file, table, lock)."""
    if not os.path.isfile(path):
        return None
    import sqlite3
    import urllib.parse

    conn = None
    try:
        conn = sqlite3.connect("file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=ro", uri=True, timeout=2)
        return conn.execute(sql, params).fetchall()
    except sqlite3.Error:
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


def dm_session_exists(key: str, home: Optional[str] = None) -> bool:
    """True when state.db holds a Telegram session under this key (the gateway injects only into a session
    it can look up; one appears after the human's first message to the bot)."""
    rows = _sqlite_rows(state_db(home), "SELECT 1 FROM sessions WHERE source='telegram' AND session_key=? LIMIT 1", (key,))
    return bool(rows)


def human_messages_since(since_s: float, home: Optional[str] = None) -> Optional[tuple]:
    """``(count, last_ms_or_None)`` of human user-role messages in the resident's home DM (every session row
    under the home session key with ``chat_type='dm'``) at or after ``since_s``, notice-prefixed rows
    excluded; None without a home key or when state.db cannot be read."""
    key = session_key(home)
    if not key:
        return None
    rows = _sqlite_rows(
        state_db(home),
        "SELECT COUNT(*), MAX(m.timestamp) FROM messages m JOIN sessions s ON s.id = m.session_id "
        "WHERE s.source = 'telegram' AND s.chat_type = 'dm' AND s.session_key = ? AND m.role = 'user' "
        "AND m.timestamp >= ? AND (m.content IS NULL OR substr(m.content, 1, ?) <> ?)",
        (key, float(since_s), len(NOTICE_PREFIX), NOTICE_PREFIX),
    )
    if not rows:
        return None
    count, last = rows[0]
    return int(count or 0), (int(round(float(last) * 1000)) if last is not None else None)


def _message_columns(path: str) -> Optional[set]:
    """The ``messages`` table's column names (an older Hermes store has no ``active``); None when the store
    cannot be read or has no such table."""
    rows = _sqlite_rows(path, "PRAGMA table_info(messages)")
    if not rows:
        return None
    return {row[1] for row in rows if len(row) > 1}


def _filled(content: Any) -> bool:
    return isinstance(content, str) and bool(content.strip())


def _unframed(content: str, kind: Any) -> Optional[str]:
    """The human's own text inside Hermes's mid-turn frames: a steer row loses its out-of-band marker, and
    every gateway origin header (which carries chat, user and message ids) comes off with the joiner before
    it; the messages Hermes joined into the row are rejoined with ``HUMAN_TEXT_JOIN``. None (the row is
    dropped, never recorded) for a steer row of another shape, a header without its closing line, or any
    frame text left after that (``FRAME_MARKS``)."""
    if kind == STEER_KIND:
        if not (content.startswith(STEER_OPEN) and content.endswith(STEER_CLOSE)):
            return None
        content = content[len(STEER_OPEN):-len(STEER_CLOSE)]
    if ORIGIN_OPEN in content:
        head, *blocks = content.split(ORIGIN_OPEN)
        pieces = [head]
        for block in blocks:
            end = block.find(ORIGIN_CLOSE)
            if end < 0:
                return None
            pieces.append(block[end + len(ORIGIN_CLOSE):])
        for i in range(len(pieces) - 1):  # the joiner Hermes put before the next header
            if pieces[i].endswith(REDIRECT_JOIN):
                pieces[i] = pieces[i][:-len(REDIRECT_JOIN)]
            elif pieces[i].endswith("\n"):
                pieces[i] = pieces[i][:-1]
        content = HUMAN_TEXT_JOIN.join(piece for piece in pieces if _filled(piece))
    if any(mark in content for mark in FRAME_MARKS):
        return None
    return content


def human_words(window_ms: int, home: Optional[str] = None) -> Optional[tuple]:
    """The human's own messages for an ``answer`` record (contract §12.1), read verbatim from state.db.

    Rows: user and assistant messages of the home DM (every session under the home key with
    ``source = 'telegram'`` and ``chat_type = 'dm'``), ``active = 1`` when the column exists (and never a
    context-compaction summary row), at or after ``window_ms``. Human rows are user rows whose content does
    not start with ``NOTICE_PREFIX`` (blank ones carry no words and are passed over) and, when the store has
    ``display_kind``, whose kind is NULL or ``steer``: Hermes persists every self-injected turn (a plugin's
    ``inject_message`` such as av-rate's "[Rating recorded]" line, our own notices, heartbeats) with a
    machinery kind (``internal_notification``), and never redirects or steers one into a running turn, while
    what the human typed has none (a Telegram message, a redirect sent mid-request, ``/retry``) or ``steer``
    (sent mid-tool). Hermes's frames around a mid-turn message come off (``_unframed``). The span is the human
    rows after the latest assistant row with non-empty content that precedes the newest human row (the agent's
    last reply; a tool-call-only row has empty content and does not end it), oldest first. Caps: at most 10
    messages and 8000 characters of joined text, keeping the most recent whole messages; a newest message
    longer than the cap alone keeps its first 8000 characters.

    Returns ``(messages, truncated)``, ``messages`` a list of ``(content, epoch_s)`` oldest first and
    ``truncated`` true when a cap cut anything; None when there is no home key or state.db cannot be read."""
    key = session_key(home)
    if not key:
        return None
    path = state_db(home)
    columns = _message_columns(path)
    if columns is None:
        return None
    where = ""
    if "active" in columns:
        where += " AND m.active = 1"
    if "_compressed_summary" in columns:
        where += " AND m._compressed_summary = 0"  # a context-compaction summary is neither side's words
    kind = "NULL"
    if "display_kind" in columns:
        kind = "m.display_kind"  # an injected user row is not the human's; a steer row is, inside its marker
        where += " AND (m.role = 'assistant' OR m.display_kind IS NULL OR m.display_kind = '" + STEER_KIND + "')"
    rows = _sqlite_rows(
        path,
        "SELECT m.role, m.content, m.timestamp, " + kind + " FROM messages m JOIN sessions s ON s.id = m.session_id "
        "WHERE s.source = 'telegram' AND s.chat_type = 'dm' AND s.session_key = ? "
        "AND m.role IN ('user', 'assistant') AND m.timestamp >= ?" + where
        + " ORDER BY m.timestamp DESC, m.id DESC LIMIT ?",
        (key, window_ms / 1000.0, HUMAN_SCAN_ROWS),
    )
    if rows is None:
        return None
    span: list = []  # newest first
    more = False
    anchored = False  # a human row was seen, kept or dropped: the agent's reply before it ends the span
    for role, content, at, row_kind in rows:
        if role == "assistant":
            if anchored and _filled(content):
                break  # the agent's last reply before the newest human row
            continue  # the current turn's own rows, or a tool-call-only row
        if not _filled(content) or content.startswith(NOTICE_PREFIX):
            continue
        anchored = True
        content = _unframed(content, row_kind)
        if not _filled(content):
            more = more or content is None  # a dropped row: the record says words were left out
            continue
        if len(span) == HUMAN_MESSAGES_MAX:
            more = True
            break
        span.append((content, float(at)))
    kept: list = []
    size = 0
    for content, at in span:
        grown = size + len(content) + (len(HUMAN_TEXT_JOIN) if kept else 0)
        if grown > HUMAN_TEXT_MAX:
            more = True
            if not kept:
                kept.append((content[:HUMAN_TEXT_MAX], at))
            break
        kept.append((content, at))
        size = grown
    kept.reverse()
    return kept, more


def human_fields(messages: list, truncated: bool) -> dict:
    """§12.1's five record fields from ``human_words``'s messages (none: count 0, text null)."""
    return {
        "human_text": HUMAN_TEXT_JOIN.join(c for c, _ in messages) if messages else None,
        "human_message_count": len(messages),
        "human_text_truncated": bool(truncated),
        "human_text_first_at": now_iso(messages[0][1]) if messages else None,
        "human_text_last_at": now_iso(messages[-1][1]) if messages else None,
    }


def record_bytes(record: dict) -> int:
    """The record's size on disk, encoded exactly as ``write_private_json`` writes it."""
    return len(json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def fit_human_words(record: dict, messages: list, truncated: bool, limit: Optional[int] = None) -> dict:
    """Keep an answer record within the control plane's per-file bound (``RECORD_FILE_BYTES`` unless ``limit``
    says otherwise; its pass leaves a bigger file unread, so the whole answer would be lost): drop the oldest
    messages, then cut the one left from its end, until the record fits. Any cut sets
    ``human_text_truncated``. Returns the record, updated in place."""
    limit = RECORD_FILE_BYTES if limit is None else limit
    while len(messages) > 1 and record_bytes(record) > limit:
        messages = messages[1:]
        truncated = True
        record.update(human_fields(messages, truncated))
    if messages and record_bytes(record) > limit:
        content, at = messages[0]
        low, high = 0, len(content) - 1  # the longest prefix that fits (binary search; a prefix of 0 empties)
        while low < high:
            mid = (low + high + 1) // 2
            record.update(human_fields([(content[:mid], at)], True))
            if record_bytes(record) <= limit:
                low = mid
            else:
                high = mid - 1
        messages = [(content[:low], at)] if content[:low].strip() else []
        record.update(human_fields(messages, True))
    return record


def turn_active(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """A turn is running: an unexpired row in state.db ``session_turn_leases``, or the gateway's own
    ``gateway_state.json`` reporting ``active_agents > 0`` (ignored when older than 10 minutes)."""
    stamp = time.time() if now is None else now
    rows = _sqlite_rows(state_db(home), "SELECT COUNT(*) FROM session_turn_leases WHERE expires_at > ?", (float(stamp),))
    if rows and rows[0][0]:
        return True
    body = _read_json(os.path.join(home or hermes_home(), "gateway_state.json"), 256 * 1024)
    if not isinstance(body, dict):
        return False
    active = body.get("active_agents")
    if isinstance(active, bool) or not isinstance(active, int) or active <= 0:
        return False
    updated = body.get("updated_at")
    try:
        at = datetime.fromisoformat(str(updated).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return False
    return stamp - at <= GATEWAY_STATE_FRESH_S


def busy_reason(home: Optional[str] = None, now: Optional[float] = None, human_hold: bool = True) -> Optional[str]:
    """``held_human_recent`` (the human wrote in the home DM in the last 5 minutes; only when ``human_hold``),
    ``held_turn_active``, or None: a notice must never land in the middle of a reply."""
    stamp = time.time() if now is None else now
    recent = human_messages_since(stamp - HUMAN_RECENT_S, home) if human_hold else None
    if recent is not None and recent[0] > 0:
        return "held_human_recent"
    if turn_active(home, stamp):
        return "held_turn_active"
    return None


def telegram_dm_session(session_id: Any, home: Optional[str] = None) -> bool:
    """True when ``session_id`` is the resident's own Telegram DM (the home session key). Without a home key
    this fails closed."""
    sid = str(session_id or "").strip()
    home_key = session_key(home)
    if not sid or not home_key:
        return False
    rows = _sqlite_rows(state_db(home), "SELECT source, chat_type, session_key FROM sessions WHERE id=? LIMIT 1", (sid,))
    if not rows:
        return False
    source, chat_type, key = rows[0]
    return source == "telegram" and chat_type == "dm" and key == home_key


# --------------------------------------------------------------------------- the inject pass


def valid_inject_name(name: str) -> bool:
    return bool(INJECT_NAME.match(name))


def inject_text(raw: str) -> Optional[str]:
    """The text to inject from a staged file (BOM and ``#trigger=`` line removed), or None when it does not
    start with the notice prefix (M5)."""
    _, text = split_trigger(raw.lstrip("﻿"))
    text = text.lstrip("﻿")
    return text if text.startswith(NOTICE_PREFIX) else None


def _mtime(path: str) -> Optional[float]:
    try:
        return os.lstat(path).st_mtime
    except OSError:
        return None


def inject_pass(ctx: Any = None, home: Optional[str] = None, now: Optional[float] = None) -> str:
    """One pass, at most one injection. In order: orphaned claims and invalid names are skipped; a closed
    window skips what was staged before its close (and anything but a new ``open`` after it); files past the
    24 h age cap are skipped; quiet hours, an open ballot page, a recent human message or a running turn
    hold; then the oldest file is claimed (``.sending``), checked, injected, and renamed ``.done`` or back to
    ``.txt``. Returns an outcome code."""
    global _LAST_CODE
    stamp = time.time() if now is None else now
    directory = inject_dir(home)
    for name in _listing(directory, ".sending"):
        path = os.path.join(directory, name)
        at = _mtime(path)
        if at is not None and stamp - at > ORPHAN_SENDING_S:
            # A claim left by a process that died mid-injection: whether it was delivered is unknown, and a
            # second opener is worse than a missing one.
            _rename_now(path, ".skipped", home, stamp)
            _log("skipped_orphan_sending", logging.WARNING)
    pending = _listing(directory, ".txt")
    if not pending:
        return "idle"
    invalid = [n for n in pending if not valid_inject_name(n)]
    for name in invalid:
        _rename_now(os.path.join(directory, name), ".skipped", home, stamp)
    if invalid:
        _log("skipped", logging.WARNING, reason="invalid_inject", skipped=len(invalid))
    pending = [n for n in pending if valid_inject_name(n)]
    state = window_state(home, stamp)
    cutoff: Optional[float] = None
    if state is not None and state["closed_at_ms"] is not None:
        cutoff = state["closed_at_ms"] / 1000.0
    elif state is None:
        marker = read_closed_marker(home)  # closed before any opener was accepted
        cutoff = marker["mtime"] if marker else None
    if cutoff is not None:
        later, skipped = [], 0
        for name in pending:
            path = os.path.join(directory, name)
            staged = _mtime(path)
            if staged is None:
                continue
            if staged <= cutoff or parse_stage_name(name)[1] != "open":
                skipped += 1 if _rename_now(path, ".skipped", home, stamp) else 0
            else:
                later.append(name)  # a new window's opener
        if skipped:
            _log("skipped_closed", skipped=skipped)
        if not later:
            return "skipped_closed"
        pending = later
    fresh, aged = [], 0
    for name in pending:
        path = os.path.join(directory, name)
        at = staged_at(path)
        if at is not None and stamp - at > AGE_CAP_S:
            aged += 1 if _rename_now(path, ".skipped", home, stamp) else 0
        else:
            fresh.append(name)
    if aged:
        _log("skipped_aged", skipped=aged)
    if not fresh:
        return "skipped_aged"
    if in_quiet_hours(stamp):
        _log_once("held_quiet_hours", pending=len(fresh))
        return "held_quiet_hours"
    if ballot_page_open(home, stamp):
        # A ballot card page is open with unrated cards: hold, as in quiet hours (only the age cap skips).
        _log_once("held_ballot_page", pending=len(fresh))
        return "held_ballot_page"
    key = session_key(home)
    if not key:
        _log_once("no_session_key", logging.WARNING)
        return "no_session_key"
    if not dm_session_exists(key, home):
        _log_once("waiting_dm_session", pending=len(fresh))
        return "waiting_dm_session"
    path = os.path.join(directory, fresh[0])
    peek, _ = _read_regular(path, INJECT_MAX_BYTES)
    first = split_trigger(peek.lstrip("\ufeff"))[0] if peek is not None else None
    file_trigger = trigger_for(fresh[0], first)
    # §9: the 5-minute "human typed" hold is for open and idle notices; an answer notice waits only for a turn.
    busy = busy_reason(home, stamp, human_hold=file_trigger in ("opener", "idle"))
    if busy:
        _log_once(busy, pending=len(fresh))
        return busy
    context = ctx if ctx is not None else _CTX
    inject_fn = getattr(context, "inject_message", None)
    if not callable(inject_fn):
        _log_once("inject_no_ctx", logging.WARNING)
        return "inject_no_ctx"
    claimed = _swap_suffix(path, ".sending")
    try:
        os.rename(path, claimed)  # H2: claim first; never inject a file this pass could not claim
    except OSError:
        _log_once("claim_failed", logging.WARNING)
        return "claim_failed"
    try:
        os.utime(claimed, None)  # the 60 s orphan rule runs from the claim, not from staging
    except OSError:
        pass
    raw, code = _read_regular(claimed, INJECT_MAX_BYTES)
    text = inject_text(raw) if raw is not None else None
    if text is None or not text.strip():
        _rename_now(claimed, ".skipped", home, stamp)
        _log("skipped", logging.WARNING, reason=code if raw is None else "invalid_inject")
        return "skipped_invalid"
    try:
        accepted = bool(inject_fn(text, session_key=key))
    except Exception as exc:  # noqa: BLE001
        accepted = False
        _log_once("inject_error", logging.WARNING, error=type(exc).__name__)
        code = "inject_error"
    else:
        code = "inject_refused"
    if not accepted:
        # Hermes said no (the config flag is off, no live gateway, no session) or raised: unclaim, retry later.
        try:
            os.rename(claimed, path)
        except OSError:
            _log("unclaim_failed", logging.WARNING)
        if code == "inject_refused":
            _log_once("inject_refused", logging.WARNING, pending=len(fresh))
        return code
    _rename_now(claimed, ".done", home, stamp)
    parsed = parse_stage_name(fresh[0])
    _log("injected", name=parsed[1] if parsed and parsed[1] in NAMES else "other", pending=len(fresh) - 1)
    _LAST_CODE = None
    return "injected"


# --------------------------------------------------------------------------- the probe


def probe_payload(home: Optional[str] = None, now: Optional[float] = None) -> Optional[dict]:
    """``probe.json``'s body (contract 3b), or None when no window is open or state.db is unreadable."""
    since = window_start(home, now)
    if since is None:
        return None
    counted = human_messages_since(since, home)
    if counted is None:
        return None
    count, last = counted
    return {"human_messages_since": int(round(since * 1000)), "count": count, "last_human_at": last}


def probe_pass(home: Optional[str] = None, now: Optional[float] = None, force: bool = False) -> str:
    """Rewrite ``probe.json`` at most every 60 s while a window is open. Returns a code."""
    global _LAST_PROBE
    stamp = time.time() if now is None else now
    if not force and stamp - _LAST_PROBE < PROBE_INTERVAL_S:
        return "probe_not_due"
    directory = inject_dir(home)
    if not (_listing(directory, ".txt") or _listing(directory, ".done")):
        return "probe_no_files"
    payload = probe_payload(home, stamp)
    if payload is None:
        return "probe_no_window"
    try:
        write_private_json(probe_path(home), payload)
    except OSError as exc:
        _log_once("probe_write_failed", logging.WARNING, error=type(exc).__name__)
        return "probe_write_failed"
    _LAST_PROBE = stamp
    return "probe_written"


# --------------------------------------------------------------------------- the tool


class Refused(ValueError):
    """A record the tool will not write; ``code`` is what is logged, ``str()`` what the agent reads."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _opt_str(args: dict, name: str, limit: int) -> Optional[str]:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise Refused("bad_" + name, f"{name} must be a string.")
    value = value.strip()
    if not value:
        return None
    if len(value) > limit:
        raise Refused("long_" + name, f"{name} is longer than {limit} characters; shorten it.")
    return value


def validate_record(args: Any) -> dict:
    """The agent's arguments -> the record's agent-supplied fields. Raises Refused."""
    if not isinstance(args, dict):
        raise Refused("bad_args", "Arguments must be an object.")
    kind = args.get("kind")
    if kind not in KINDS:
        raise Refused("bad_kind", "kind must be question, answer or stop.")
    number = args.get("question_no")
    if isinstance(number, float) and number.is_integer():
        number = int(number)
    if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= QUESTION_NO_MAX:
        raise Refused("bad_question_no", f"question_no must be a whole number from 1 to {QUESTION_NO_MAX}.")
    category = _opt_str(args, "category", 64)
    if category is not None and not SLUG.match(category):
        raise Refused("bad_category", "category must be a category id such as privacy_and_consent.")
    form = _opt_str(args, "form", 32)
    if form is not None and form not in FORMS:
        raise Refused("bad_form", "form must be open, trade_off, direct_rating or other.")
    text = _opt_str(args, "text", TEXT_MAX)
    if kind in ("question", "answer") and text is None:
        raise Refused("missing_text", f"text is required for kind {kind}.")
    takeaway = _opt_str(args, "takeaway", TAKEAWAY_MAX)
    raw_ids = args.get("statement_ids")
    ids: list = []
    if raw_ids is not None:
        if not isinstance(raw_ids, list) or len(raw_ids) > STATEMENT_IDS_MAX:
            raise Refused("bad_statement_ids", f"statement_ids must be a list of at most {STATEMENT_IDS_MAX} ids.")
        for item in raw_ids:
            if not isinstance(item, str) or not STATEMENT_ID.match(item.strip()):
                raise Refused("bad_statement_ids", "statement_ids must be statement ids such as s004.")
            if item.strip() not in ids:
                ids.append(item.strip())
    return {
        "kind": kind,
        "question_no": number,
        "category": category,
        # Question only; a question without a form is "other" (the app's column is the closed enum).
        "form": (form or "other") if kind == "question" else None,
        "text": text,
        "takeaway": takeaway if kind == "answer" else None,
        "statement_ids": ids if kind == "answer" else [],
    }


def build_record(fields: dict, trigger: Optional[str], now: Optional[float] = None,
                 record_id: Optional[str] = None, human: Optional[dict] = None) -> dict:
    """The full 3c record: ``record_id`` uuid4, ``window_ms``, ``trigger`` from the plugin (question only),
    ``recorded_at`` now; an answer also carries ``human``, §12.1's five fields (never from the agent).
    Question and stop records carry none of them."""
    record = {
        "record_id": record_id or str(uuid.uuid4()),
        "window_ms": fields.get("window_ms"),
        "kind": fields["kind"],
        "question_no": fields["question_no"],
        "agent_question_no": fields.get("agent_question_no", fields["question_no"]),
        "category": fields["category"],
        "form": fields["form"],
        "trigger": trigger if fields["kind"] == "question" else None,
        "text": fields["text"],
        "takeaway": fields["takeaway"],
        "statement_ids": fields["statement_ids"],
        "late": bool(fields.get("late")),
        "text_long": bool(fields["kind"] == "question" and fields["text"]
                          and len(fields["text"].split()) > QUESTION_WORDS_SOFT_MAX),
        "recorded_at": now_iso(now),
    }
    if fields["kind"] == "answer" and isinstance(human, dict):
        record.update({name: human.get(name) for name in HUMAN_FIELDS})
    return record


def confirmation(record: dict) -> str:
    where = f" ({record['category']})" if record.get("category") else ""
    if record["kind"] == "question":
        return f"Recorded question {record['question_no']}{where}."
    if record["kind"] == "answer":
        n = len(record["statement_ids"])
        return f"Recorded the answer to question {record['question_no']}{where}, informing {n} statement(s)."
    return "Recorded stop: send a one-line thanks and ask nothing more about the constitution."


NO_WINDOW = "No ODIN constitution conversation is open; nothing was recorded."


def record_elicitation(args: Any, session_id: Any, home: Optional[str] = None, now: Optional[float] = None) -> str:
    """Gate, validate and write one record. Returns the line the agent reads; raises Refused."""
    if not telegram_dm_session(session_id, home):
        raise Refused("not_dm", "elicitation_record works only in your Telegram DM with your human.")
    fields = validate_record(args)
    stamp = time.time() if now is None else now
    directory = records_dir(home)
    with _RECORD_LOCK:
        if len(_listing(directory, ".json")) >= RECORDS_MAX:
            raise Refused("records_full", "This conversation already holds the most records allowed.")
        state = window_state(home, stamp)
        if state is None:
            raise Refused("no_window", NO_WINDOW)
        late = state["closed_at_ms"] is not None
        if late:
            if state["close_reason"] == "withdrawn":
                raise Refused("withdrawn", "This conversation was withdrawn; nothing was recorded.")
            if fields["kind"] == "question":
                raise Refused("no_window", NO_WINDOW)
            if state["stopped"]:
                raise Refused("stopped", "Your human already said stop; nothing more is recorded for this conversation.")
            if stamp - state["closed_at_ms"] / 1000.0 > LATE_ANSWER_S:
                raise Refused("no_window", NO_WINDOW)
        window_ms = state["window_ms"]
        asked = max(state["questions"], recount_questions(window_ms, home))
        fields["late"] = late
        fields["window_ms"] = window_ms
        fields["agent_question_no"] = fields["question_no"]
        fields["question_no"] = assign_question_no(fields["kind"], fields["question_no"], asked)
        trigger = question_trigger(home, state["accepted_ms"]) if fields["kind"] == "question" else None
        words = None
        if fields["kind"] == "answer":
            try:
                words = human_words(window_ms, home)
            except Exception as exc:  # noqa: BLE001 - the record is still written, without the words
                _log("human_text_error", logging.WARNING, error=type(exc).__name__)
            if words is None:
                _log("human_text_unavailable", logging.WARNING)
                words = ([], False)
        record = build_record(fields, trigger, stamp, human=human_fields(*words) if words else None)
        if words:
            fit_human_words(record, *words)
        path = os.path.join(directory, f"{int(stamp * 1000)}-{record['record_id']}.json")
        try:
            write_private_json(path, record)
        except OSError as exc:
            raise Refused("write_failed", "Could not record that right now; try once more.") from exc
        with _STATE_LOCK:
            latest = load_window_state(window_ms, home)
            latest["questions"] = max(latest["questions"], asked + 1 if record["kind"] == "question" else asked)
            if record["kind"] == "stop":
                latest["stopped"] = True
            save_window_state(latest, home)  # a failure is logged; the recount backs the next number up
        if record["kind"] == "answer":
            try:
                write_private_json(last_answer_path(home), {"at_ms": int(stamp * 1000)})
            except OSError as exc:  # the record is written; only the next question's trigger may be off
                _log("last_answer_write_failed", logging.WARNING, error=type(exc).__name__)
    _log("recorded", kind=record["kind"], question_no=record["question_no"], late=int(record["late"]),
         text_long=int(record["text_long"]),
         agent_question_no=record["agent_question_no"], statements=len(record["statement_ids"]),
         **({"human_messages": record["human_message_count"], "human_truncated": int(record["human_text_truncated"])}
            if record["kind"] == "answer" else {}))
    return confirmation(record)


def elicitation_record_tool(args: Any = None, **kwargs: Any) -> str:
    """The Hermes handler: a one-line confirmation, or ``{"error": ...}``. Never raises."""
    try:
        return record_elicitation(args, kwargs.get("session_id"))
    except Refused as refused:
        _log("refused", reason=refused.code)
        return json.dumps({"error": str(refused)})
    except Exception as exc:  # noqa: BLE001 - fail open
        try:
            _log("record_error", logging.WARNING, error=type(exc).__name__)
        except Exception:  # noqa: BLE001
            pass
        return json.dumps({"error": "Could not record that right now; try once more."})


# --------------------------------------------------------------------------- loop and registration


def _gateway_subcommand(argv: Optional[list] = None) -> Optional[str]:
    """The word after ``gateway`` in ``sys.argv[1:5]`` (``""`` for a bare ``hermes gateway``), else None."""
    args = [str(a) for a in (sys.argv if argv is None else argv)][1:5]
    if "gateway" not in args:
        return None
    rest = args[args.index("gateway") + 1:]
    return rest[0] if rest else ""


def gateway_argv(argv: Optional[list] = None) -> bool:
    """``hermes gateway run`` (or a bare ``hermes gateway``): a command line that always runs the gateway in
    this process."""
    return _gateway_subcommand(argv) in ("", "run")


def gateway_handoff_argv(argv: Optional[list] = None) -> bool:
    """``hermes gateway start`` or ``restart``: a command line that may or may not run the gateway here. With
    no service manager, ``restart`` stops the old gateway and runs one in this process (``run_gateway``); with
    one, ``start`` and ``restart`` only ask the service manager and exit. Only Hermes's ``_HERMES_GATEWAY=1``,
    which ``gateway/run.py`` sets when it is imported (after plugins have registered), tells the two apart."""
    return _gateway_subcommand(argv) in ("start", "restart")


def gateway_process(argv: Optional[list] = None) -> bool:
    """H1: this process is the gateway (``gateway run`` in argv, or Hermes's ``_HERMES_GATEWAY=1``). In the TUI
    or a CLI, ``inject_message`` goes to the local input queue, so the loop must never run there."""
    return gateway_argv(argv) or os.environ.get(GATEWAY_MARKER) == "1"


def run_once(ctx: Any = None, home: Optional[str] = None, now: Optional[float] = None) -> tuple:
    """One loop iteration: the inject pass, then the probe. Never raises; returns both codes."""
    try:
        injected = inject_pass(ctx, home, now)
    except Exception as exc:  # noqa: BLE001
        injected = "pass_failed"
        _log_once("pass_failed", logging.WARNING, error=type(exc).__name__)
    try:
        probed = probe_pass(home, now)
    except Exception as exc:  # noqa: BLE001
        probed = "probe_failed"
        _log_once("probe_failed", logging.WARNING, error=type(exc).__name__)
    return injected, probed


def _loop(stop: threading.Event) -> None:
    while not stop.is_set():
        run_once()
        stop.wait(POLL_S)


def _on_unload() -> None:
    global _REGISTERED
    if _STOP is not None:
        _STOP.set()
    if _WAIT_STOP is not None:
        _WAIT_STOP.set()
    _REGISTERED = False


def register_record_tool(ctx: Any) -> bool:
    """Register ``elicitation_record``; a Hermes without plugin tools gets one log line and no tool."""
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        _log("tool_skipped", reason="no_register_tool")
        return False
    try:
        try:
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=elicitation_record_tool,
                          description=TOOL_DESCRIPTION)
        except TypeError:
            # An older register_tool without `description`.
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=elicitation_record_tool)
    except Exception as exc:  # noqa: BLE001 - the tool must never cost the loop
        _log("tool_register_failed", logging.WARNING, error=type(exc).__name__)
        return False
    return True


def start_loop() -> bool:
    """L1: a fresh stop Event per registration; an old thread is stopped and joined (briefly) first, so a
    reload never leaves two loops on one event. Only in the gateway process (H1).

    Under ``hermes gateway start|restart`` the process may become the gateway only after plugins registered
    (Hermes sets ``_HERMES_GATEWAY=1`` when it imports ``gateway/run.py``): one waiter thread then checks the
    marker every second and starts the loop the first time it is ``1``. A restart that only hands off to the
    service manager exits without the marker, so it never runs a loop. Returns True when the loop started now."""
    with _LOOP_LOCK:
        if gateway_process():
            _start_loop_locked()
            return True
        if gateway_handoff_argv():
            _start_waiter_locked()
            _log("loop_waiting", reason="gateway_marker")
            return False
        _log("loop_skipped", reason="not_gateway")
        return False


def _await_gateway(stop: threading.Event) -> None:
    """The waiter: start the loop once, the first time Hermes's gateway marker is ``1`` (never when the loop
    already runs, or after unload or a direct start stopped this waiter)."""
    while True:
        if os.environ.get(GATEWAY_MARKER) == "1":
            with _LOOP_LOCK:
                if not stop.is_set() and not (_THREAD is not None and _THREAD.is_alive()):
                    _start_loop_locked()
                    _log("loop_started", reason="gateway_marker")
            return
        if stop.wait(MARKER_POLL_S):
            return


def _start_waiter_locked() -> None:
    """At most one waiter per process (caller holds ``_LOOP_LOCK``)."""
    global _WAITER, _WAIT_STOP
    if _WAITER is not None and _WAITER.is_alive() and _WAIT_STOP is not None and not _WAIT_STOP.is_set():
        return
    stop = threading.Event()
    _WAIT_STOP = stop
    _WAITER = threading.Thread(target=_await_gateway, args=(stop,), name="av-elicit-wait", daemon=True)
    _WAITER.start()


def _start_loop_locked() -> None:
    """Start the inject/probe thread (caller holds ``_LOOP_LOCK``); a waiting waiter is stopped first."""
    global _THREAD, _STOP
    if _WAIT_STOP is not None:
        _WAIT_STOP.set()
    old_thread, old_stop = _THREAD, _STOP
    if old_stop is not None:
        old_stop.set()
    if old_thread is not None and old_thread.is_alive():
        old_thread.join(timeout=JOIN_TIMEOUT_S)
    try:
        os.makedirs(inject_dir(), mode=DIR_MODE, exist_ok=True)
    except OSError:
        pass
    stop = threading.Event()
    _STOP = stop
    _THREAD = threading.Thread(target=_loop, args=(stop,), name="av-elicit", daemon=True)
    _THREAD.start()


def register(ctx: Any) -> None:
    """Hermes entrypoint (synchronous): the tool everywhere, the inject/probe thread in the gateway only.
    Idempotent; never raises."""
    global _CTX, _REGISTERED
    _CTX = ctx
    if _REGISTERED:
        return
    try:
        register_record_tool(ctx)
        start_loop()
        on_unload = getattr(ctx, "on_unload", None)
        if callable(on_unload):
            try:
                on_unload(_on_unload)
            except Exception:  # noqa: BLE001
                pass
        _REGISTERED = True
        _log("registered")
    except Exception as exc:  # noqa: BLE001
        _log("register_failed", logging.WARNING, error=type(exc).__name__)


__all__ = [
    "AGE_CAP_S", "FORMS", "KINDS", "NOTICE_PREFIX", "TOOL_NAME", "TOOL_SCHEMA", "TRIGGERS", "Refused",
    "assign_question_no", "ballot_page_marker", "ballot_page_open", "build_record", "busy_reason", "closed_path",
    "closed_time", "confirmation", "current_trigger", "current_window", "current_window_ms", "open_dones", "dm_session_exists", "done_files",
    "elicitation_record_tool", "gateway_argv", "gateway_handoff_argv", "gateway_process", "human_messages_since", "human_words", "human_fields", "fit_human_words", "in_quiet_hours", "inject_dir",
    "inject_pass", "inject_text", "is_closed", "last_answer_time", "last_injected", "late_window_start",
    "load_window_state", "marker_applies", "open_done_times", "parse_stage_name", "probe_pass", "probe_path",
    "probe_payload", "question_trigger", "read_closed_marker", "record_elicitation", "records_dir",
    "recount_questions", "register", "register_record_tool", "run_once", "session_key", "split_trigger",
    "start_loop", "telegram_dm_session", "trigger_for", "turn_active", "validate_record", "window_open",
    "window_questions", "window_start", "window_state",
]
