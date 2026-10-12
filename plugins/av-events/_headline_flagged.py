"""DATA-487: `opportunity.headline_flagged@1`, from the trigger's hand-off files.

Carter's ruling of 12 Oct 2026 18:25Z (ov#301): every Index headline the
proactive trigger's cleaner, scanner or shape check withholds, flags or cuts
is reported as an event with the Index opportunity id, the counterpart's Index
user id and a reason code, and no text, so the data side can spot a
counterpart who sends lures.

The trigger (`skills/index-network/scripts/proactive.ts` writeHeadlineFlags)
never writes an event itself: it writes one file per run into
`av-events/proactive/headline-flagged/` (0600 in a 0700 folder, by temp file
and rename):

    {"v": 1, "written_at": "<ISO>", "records": [<record>, ...]}

and each record is exactly the closed payload below. The flusher's pass
(`tick`, on the cron tail's cadence beside the outcome ask) emits one
`opportunity.headline_flagged` (schema 1) per record and removes the file.

**Payload (closed, every key required, no text of any kind):**

- `opportunity_id`: the Index opportunity id (at most 64 of `[A-Za-z0-9_-]`);
  also the envelope's `opportunity_id`;
- `counterpart_index_user_id`: the card's other party's Index user id, the id
  behind `https://index.network/u/<userId>` (same shape);
- `reason_code`: `cleaner_withheld` | `scanner_flagged` | `shape_withheld` |
  `length_capped`;
- `stage`: `cleaner` | `scanner` | `shape`, in the pairs the trigger writes
  (PAIRS);
- `headline_length`: the raw headline's length in code points, an int 0..2000.

**Trust boundary.** The folder is in the agent's home, where the model can
write. A file that is not exactly this shape (an extra or missing key, a value
out of its set, not private, a symlink, too big, stale or from the future) is
refused whole and removed, and nothing of it is emitted or logged. That catches
accidents and keeps text out of the event; it does not stop a forger, who could
write a well-shaped file: the events are `agent_report` like everything this
plugin sends.

Off with `headline_flagged` in `AV_HOOKS_DISABLED` (the trigger then writes no
file either). An inert plugin (no token, `AV_EVENTS_ENABLED` off) leaves the
files for a later pass; the trigger stops writing past FILES_MAX (proactive.ts
HEADLINE_FLAG_FILES_MAX) and this pass drops a file older than FILE_MAX_AGE_S.

Logs: codes and counts only. Python 3.11, standard library only.
"""

from __future__ import annotations

import os
import re
import time
from typing import Any, Callable, Optional

from ._core import MAX_BUFFER_AGE_S, derived_uuid7, epoch_from_iso, iso_from_epoch, iso_from_text
from ._outcome_ask import _listing, _unlink, private_file

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
#: (reason_code, stage) as the trigger writes them (proactive-text.ts matchFieldVerdict).
PAIRS = frozenset({
    ("cleaner_withheld", "cleaner"),
    ("scanner_flagged", "scanner"),
    ("scanner_flagged", "shape"),
    ("shape_withheld", "shape"),
    ("length_capped", "cleaner"),
})
#: An Index id: the trigger's FLAG_ID.
INDEX_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
HEADLINE_LENGTH_MAX = 2000

#: A run flags at most a few cards (one drop, the pending alert's cards, the follow-up's rows).
RECORDS_MAX = 50
FILE_MAX_BYTES = 16 * 1024
#: Files read per pass at most; the rest wait for the next.
FILES_PER_TICK = 50
#: A file older than this is dropped unsent (the buffer's own horizon).
FILE_MAX_AGE_S = MAX_BUFFER_AGE_S
#: Clock slack between the trigger (bun) and the plugin on one machine.
CLOCK_SLACK_S = 5 * 60


def flag_dir(state_dir: str) -> str:
    return os.path.join(state_dir, "proactive", "headline-flagged")


def _index_id(value: Any) -> bool:
    return isinstance(value, str) and INDEX_ID.fullmatch(value) is not None


def valid_record(data: Any) -> Optional[dict]:
    """The payload, keys in order, or None unless `data` is exactly the closed shape."""
    if not isinstance(data, dict) or set(data) != set(PAYLOAD_KEYS):
        return None
    length = data["headline_length"]
    if not (_index_id(data["opportunity_id"]) and _index_id(data["counterpart_index_user_id"])):
        return None
    if (data["reason_code"], data["stage"]) not in PAIRS:
        return None
    if type(length) is not int or not 0 <= length <= HEADLINE_LENGTH_MAX:
        return None
    return {key: data[key] for key in PAYLOAD_KEYS}


def valid_file(data: Any) -> Optional[tuple[float, list[dict]]]:
    """(written, records), or None unless every key and every record is exactly the shape."""
    if not isinstance(data, dict) or set(data) != FILE_KEYS or data["v"] != FILE_VERSION or type(data["v"]) is not int:
        return None
    written = epoch_from_iso(iso_from_text(data["written_at"]))
    records = data["records"]
    if written is None or not isinstance(records, list) or not 1 <= len(records) <= RECORDS_MAX:
        return None
    payloads = [valid_record(record) for record in records]
    if any(payload is None for payload in payloads):
        return None
    return written, payloads  # type: ignore[return-value]


def _count(codes: dict, code: str, n: int = 1) -> None:
    codes[code] = codes.get(code, 0) + n


def tick(state_dir: str, emit: Callable[..., Optional[dict]], now: Optional[float] = None) -> dict:
    """Emit the waiting records, remove their files. Returns code -> count:
    `emitted` (events), `refused` and `stale` (files removed unsent),
    `emit_refused` (the plugin is inert: the file waits)."""
    now = time.time() if now is None else now
    codes: dict[str, int] = {}
    folder = flag_dir(state_dir)
    for name in _listing(folder)[:FILES_PER_TICK]:
        path = os.path.join(folder, name)
        data, why = private_file(path, FILE_MAX_BYTES)
        valid = valid_file(data) if why is None else None
        if valid is None:
            _unlink(path)
            _count(codes, "refused")
            continue
        written, payloads = valid
        if written > now + CLOCK_SLACK_S:
            _unlink(path)
            _count(codes, "refused")
            continue
        if now - written > FILE_MAX_AGE_S:
            _unlink(path)
            _count(codes, "stale")
            continue
        occurred = iso_from_epoch(written)
        emitted = 0
        for index, payload in enumerate(payloads):
            event = emit(
                EVENT_TYPE,
                payload,
                # Derived from the file and the record: a pass that stops
                # half-way emits the same ids again, and ingest keeps one.
                event_id=derived_uuid7(int(written * 1000), f"headline_flagged:{name}:{index}"),
                occurred_at=occurred,
                actor="system",
                opportunity_id=payload["opportunity_id"],
            )
            if event is None:
                break
            emitted += 1
        if emitted:
            _count(codes, "emitted", emitted)
        if emitted < len(payloads):
            _count(codes, "emit_refused")
            break  # the plugin is inert: every file waits for a later pass
        _unlink(path)
    return codes


__all__ = ["EVENT_TYPE", "PAIRS", "PAYLOAD_KEYS", "REASON_CODES", "STAGES", "SWITCH", "flag_dir", "tick", "valid_file", "valid_record"]
