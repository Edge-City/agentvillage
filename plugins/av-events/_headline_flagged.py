"""DATA-487: `opportunity.headline_flagged@1`, from the trigger's hand-off files.

Carter's ruling of 12 Oct 2026 18:25Z (ov#301): every Index headline the
proactive trigger's cleaner, scanner or shape check withholds or flags
is reported as an event with the Index opportunity id, the counterpart's Index
user id and a reason code, and no text, so the data side can spot a
counterpart who sends lures.

The trigger (`skills/index-network/scripts/proactive.ts` writeHeadlineFlags)
never writes an event itself: it writes one file per run into
`av-events/proactive/headline-flagged/` (0600 in a 0700 folder, by temp file
and rename, at most RECORDS_MAX records):

    {"v": 1, "written_at": "<ISO>", "records": [<record>, ...]}

and each record is exactly the closed payload below. The flusher's pass
(`tick`, on the cron tail's cadence beside the outcome ask) emits one
`opportunity.headline_flagged` (schema 1) per record and removes the file.

**Payload (closed, every key required, no text of any kind):**

- `opportunity_id`: the Index opportunity id, the trigger's shape
  (`[A-Za-z0-9_-]`, at most 64); also the envelope's `opportunity_id`;
- `counterpart_index_user_id`: the card's other party's Index user id, the id
  behind `https://index.network/u/<userId>`: a UUID, as the trigger's
  `attachIndexLinks` (USER_ID) and FLAG_USER_ID require;
- `reason_code`: `cleaner_withheld` | `scanner_flagged` | `shape_withheld` |
  `length_capped` (reserved: kept in the closed set, the trigger does not
  emit it, since a cut headline was checked whole before the cut);
- `stage`: `cleaner` | `scanner` | `shape`, in the pairs the trigger writes
  (PAIRS);
- `headline_length`: the raw headline's length in code points, an int 0..2000.

**Trust boundary (commit review flag 1).** The folder is in the agent's home,
and the agent runs as the same user as the trigger: it can write a
well-shaped file naming any Index user. Nothing on the box can tell the
trigger's file from a forged one: no ledger here records which cards the
trigger saw that the agent could not also write, and a nonce would sit in the
same home. So this module checks only what it can: a private regular file
(0600, this user, not a symlink) in a private folder, the closed shape and
the trigger's own id shapes. The events are `agent_report` like everything
this plugin sends; attributing a lure to a counterpart needs a check off the
box (the data side, against Index), not here.

**Drops are counted, never silent (commit review flag 2).** Each file is
handled alone and each record alone: a record not exactly the shape, or whose
emit raises or is refused, is dropped and counted, and the others still go; a
file that cannot be read, is not private, is too big, is not the shape, is
stale or is from the future is dropped and counted; past RECORDS_MAX the first
records go and the rest are counted. Every file read is consumed (removed),
so nothing is re-read forever, and nothing raises out of `tick`. A folder that
exists but is not private (group or other writable, another user's, a
symlink) is counted `folder` on each pass and left unread; a directory named
`*.json` is removed when empty and counted `not_regular` once. The codes are
`flag_dropped_<reason>` (and `emitted`); the collector logs them and keeps
them on its counters.

Off with `headline_flagged` in `AV_HOOKS_DISABLED` (the trigger then writes no
file either). An inert plugin (no token, `AV_EVENTS_ENABLED` off) does not run
the pass and leaves the files; the trigger stops writing past its folder cap
(proactive.ts HEADLINE_FLAG_FILES_MAX) and this pass drops a file older than
FILE_MAX_AGE_S.

Logs: codes and counts only. Python 3.11, standard library only.
"""

from __future__ import annotations

import os
import re
import stat
import time
from typing import Any, Callable, Optional

from ._core import MAX_BUFFER_AGE_S, derived_uuid7, epoch_from_iso, iso_from_epoch, iso_from_text
from ._outcome_ask import _listing, _unlink, private_dir, private_file

#: The event this module emits (`opportunity.headline_flagged@1`: schema 1, the envelope's).
EVENT_TYPE = "opportunity.headline_flagged"
#: Its name in `AV_HOOKS_DISABLED`.
SWITCH = "headline_flagged"
FILE_VERSION = 1

#: The payload's keys, in this order, and no other.
PAYLOAD_KEYS = ("opportunity_id", "counterpart_index_user_id", "reason_code", "stage", "headline_length")
FILE_KEYS = frozenset({"v", "written_at", "records"})
REASON_CODES = frozenset({"cleaner_withheld", "scanner_flagged", "shape_withheld", "length_capped"})
STAGES = frozenset({"cleaner", "scanner", "shape"})
#: (reason_code, stage) as the trigger writes them (proactive-text.ts matchFieldVerdict), and the
#: reserved `length_capped` pair the trigger no longer writes (kept in the registered closed set).
PAIRS = frozenset({
    ("cleaner_withheld", "cleaner"),
    ("scanner_flagged", "scanner"),
    ("scanner_flagged", "shape"),
    ("shape_withheld", "shape"),
    ("length_capped", "cleaner"),
})
#: The trigger's FLAG_OPPORTUNITY_ID (build-daily-brief-context.ts ENTITY_ID, at most 64).
OPPORTUNITY_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
#: The trigger's FLAG_USER_ID (build-daily-brief-context.ts USER_ID): an Index user id is a UUID.
USER_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
HEADLINE_LENGTH_MAX = 2000

#: The trigger writes at most this many records per file (proactive.ts HEADLINE_FLAG_RECORDS_MAX); past it the rest are counted.
RECORDS_MAX = 50
FILE_MAX_BYTES = 32 * 1024
#: Files read per pass at most; the rest wait for the next.
FILES_PER_TICK = 50
#: A file older than this is dropped unsent (the buffer's own horizon).
FILE_MAX_AGE_S = MAX_BUFFER_AGE_S
#: Clock slack between the trigger (bun) and the plugin on one machine.
CLOCK_SLACK_S = 5 * 60

#: The drop codes: `flag_dropped_<reason>`.
DROPPED = "flag_dropped_"
#: Directories named `*.json` already counted by this process (device, inode): one that cannot be
#: removed (not empty) is counted once, never on every pass (fix round 4, recheck af3ef6ae N2).
_COUNTED_DIRS: set[tuple[int, int]] = set()


def flag_dir(state_dir: str) -> str:
    return os.path.join(state_dir, "proactive", "headline-flagged")


def valid_record(data: Any) -> Optional[dict]:
    """The payload, keys in order, or None unless `data` is exactly the closed shape."""
    if not isinstance(data, dict) or set(data) != set(PAYLOAD_KEYS):
        return None
    opportunity, counterpart, length = data["opportunity_id"], data["counterpart_index_user_id"], data["headline_length"]
    if not (isinstance(opportunity, str) and OPPORTUNITY_ID.fullmatch(opportunity)):
        return None
    if not (isinstance(counterpart, str) and USER_ID.fullmatch(counterpart)):
        return None
    if (data["reason_code"], data["stage"]) not in PAIRS:
        return None
    if type(length) is not int or not 0 <= length <= HEADLINE_LENGTH_MAX:
        return None
    return {key: data[key] for key in PAYLOAD_KEYS}


def valid_file(data: Any) -> Optional[tuple[float, list]]:
    """(written, the raw records), or None unless the file's own keys are exactly the shape.
    The records are checked one by one (valid_record)."""
    if not isinstance(data, dict) or set(data) != FILE_KEYS or type(data["v"]) is not int or data["v"] != FILE_VERSION:
        return None
    written = epoch_from_iso(iso_from_text(data["written_at"]))
    records = data["records"]
    if written is None or not isinstance(records, list) or not records:
        return None
    return written, records


def _count(codes: dict, code: str, n: int = 1) -> None:
    if n:
        codes[code] = codes.get(code, 0) + n


def _one_file(path: str, name: str, emit: Callable[..., Optional[dict]], now: float, codes: dict) -> None:
    data, why = private_file(path, FILE_MAX_BYTES)
    if why is not None:
        _count(codes, DROPPED + why)
        return
    valid = valid_file(data)
    if valid is None:
        _count(codes, DROPPED + "bad_file")
        return
    written, records = valid
    if written > now + CLOCK_SLACK_S:
        _count(codes, DROPPED + "future")
        return
    if now - written > FILE_MAX_AGE_S:
        _count(codes, DROPPED + "stale")
        return
    _count(codes, DROPPED + "over_cap", max(0, len(records) - RECORDS_MAX))
    occurred = iso_from_epoch(written)
    for index, record in enumerate(records[:RECORDS_MAX]):
        payload = valid_record(record)
        if payload is None:
            _count(codes, DROPPED + "bad_record")
            continue
        try:
            event = emit(
                EVENT_TYPE,
                payload,
                # Derived from the file and the record: the same file read
                # twice gives the same ids, and ingest keeps one row per id.
                event_id=derived_uuid7(int(written * 1000), f"headline_flagged:{name}:{index}"),
                occurred_at=occurred,
                actor="system",
                opportunity_id=payload["opportunity_id"],
            )
        except Exception:  # noqa: BLE001 - one record never stops the others
            _count(codes, DROPPED + "emit_error")
            continue
        _count(codes, "emitted" if event is not None else DROPPED + "emit_refused")


def _directory(path: str, codes: dict) -> bool:
    """True when `path` is a directory (named `*.json`): removed when empty, counted
    `not_regular` once (when removed, or the first time this process sees it), and never
    read or counted again (fix round 4, recheck af3ef6ae N2)."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if not stat.S_ISDIR(st.st_mode):
        return False
    key = (st.st_dev, st.st_ino)
    try:
        os.rmdir(path)
        removed = True
    except OSError:
        removed = False
    if removed or key not in _COUNTED_DIRS:
        _count(codes, DROPPED + "not_regular")
    if not removed:
        _COUNTED_DIRS.add(key)
    return True


def tick(state_dir: str, emit: Callable[..., Optional[dict]], now: Optional[float] = None) -> dict:
    """Emit the waiting records and consume their files. Returns code -> count:
    `emitted` (events) and `flag_dropped_<reason>` (files or records dropped:
    the private_file codes, `bad_file`, `future`, `stale`, `over_cap`,
    `bad_record`, `emit_error`, `emit_refused`, `error`; `folder` once per
    pass while the folder exists but is not private: group or other
    writable, another user's, or a symlink, whose files are left unread).
    Never raises."""
    now = time.time() if now is None else now
    codes: dict[str, int] = {}
    try:
        folder = flag_dir(state_dir)
        # Fix round 4 (recheck af3ef6ae N1): a folder that exists but is not private is a visible
        # drop, not silence. Its files are not read (a symlinked folder is never followed).
        if os.path.lexists(folder) and not private_dir(folder):
            _count(codes, DROPPED + "folder")
            return codes
        names = _listing(folder)[:FILES_PER_TICK]
    except Exception:  # noqa: BLE001
        _count(codes, DROPPED + "error")
        return codes
    for name in names:
        path = os.path.join(folder, name)
        try:
            if _directory(path, codes):
                continue
            _one_file(path, name, emit, now, codes)
        except Exception:  # noqa: BLE001 - one file never stops the others
            _count(codes, DROPPED + "error")
        finally:
            # Consumed whatever happened: a file is read once, never again.
            _unlink(path)
    return codes


__all__ = ["DROPPED", "EVENT_TYPE", "PAIRS", "PAYLOAD_KEYS", "REASON_CODES", "RECORDS_MAX", "STAGES", "SWITCH", "flag_dir", "tick", "valid_file", "valid_record"]
