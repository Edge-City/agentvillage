"""The suggestion rating cards' events, from av-rate's hand-off files (data docs/design/suggestion-rating.md).

`plugins/av-rate` sends the Telegram button cards and records the taps; it never posts an
event itself. For every card sent and every tap it writes one file into
`av-events/proactive/rating-events/` (0600 in a 0700 folder, by temp file and rename):

    {"v": 1, "written_at": "<ISO>", "records": [<record>]}

and this pass (`tick`, on the flusher's cron-tail cadence beside `_headline_flagged`) emits one event
per record and consumes the file. The record carries ids, codes, a value and times only; the
payload is built HERE, so the shape the door sees is this module's, not the file's:

| `event_type` | payload (closed, every key required) | actor |
|---|---|---|
| `opportunity.rating_asked` | `question_version` (`match_fit_5_v1`; `collab_interest_v1` for card 2), `card` (`fit` / `collab`; `planned` from older releases), `message_hash` (the card text's keyed hash, 64 hex), `window_hours` (24) | `system` |
| `opportunity.rated` | `value` (1..5), `scale` (`match_fit_5_v1`), `channel` (`telegram_button`), `revision` (1..), `rated_at` | `participant`, `self_report` |
| `opportunity.pre_planned` | `value` (`yes` / `no`), `channel`, `revision`, `answered_at` | `participant`, `self_report` |
| `opportunity.collab_interest` | `value` (`yes` / `no` / `unsure`), `scale` (`collab_interest_v1`), `channel`, `revision`, `answered_at` | `participant`, `self_report` |

Envelope: `opportunity_id` (the Index id, lower-cased when it is a UUID), `intention_id` (null unless
the stage named one). Event ids are derived from (type, opportunity, card, revision), so a file read
twice, or a card re-sent, gives the same id and ingest keeps one row.

Drops are counted, never silent (`rating_dropped_<reason>`): a file not private or not the shape,
a stale or future file, a record not exactly the shape, an emit that raises or is refused. Every
file read is consumed. Off with `rating_cards` in `AV_HOOKS_DISABLED`.

Logs: codes and counts only. Python 3.11, standard library only.
"""

from __future__ import annotations

import os
import re
import time
from typing import Any, Callable, Optional

from ._core import MAX_BUFFER_AGE_S, derived_uuid7, epoch_from_iso, iso_from_text
from ._outcome_ask import _listing, _unlink, private_dir, private_file

SWITCH = "rating_cards"
FILE_VERSION = 1
SCALE = "match_fit_5_v1"
CHANNEL = "telegram_button"
WINDOW_HOURS = 24
ASKED = "opportunity.rating_asked"
RATED = "opportunity.rated"
PRE_PLANNED = "opportunity.pre_planned"
COLLAB_INTEREST = "opportunity.collab_interest"
COLLAB_SCALE = "collab_interest_v1"
COLLAB_VALUES = ("yes", "no", "unsure")
EVENT_TYPES = frozenset({ASKED, RATED, PRE_PLANNED, COLLAB_INTEREST})
CARDS = frozenset({"fit", "planned", "collab"})
RECORD_KEYS = frozenset({"event_type", "opportunity_id", "intention_id", "card", "revision", "value", "at", "message_hash"})
FILE_KEYS = frozenset({"v", "written_at", "records"})
REVISION_MAX = 1000
#: An envelope id (agentvillage-data src/envelope.ts ID_PATTERN).
ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")

RECORDS_MAX = 50
FILE_MAX_BYTES = 32 * 1024
FILES_PER_TICK = 50
FILE_MAX_AGE_S = MAX_BUFFER_AGE_S
CLOCK_SLACK_S = 5 * 60
DROPPED = "rating_dropped_"


def events_dir(state_dir: str) -> str:
    return os.path.join(state_dir, "proactive", "rating-events")


def _count(codes: dict, code: str, n: int = 1) -> None:
    if n:
        codes[code] = codes.get(code, 0) + n


def valid_record(data: Any) -> Optional[dict]:
    """The record, checked key by key, or None unless exactly the shape. The returned dict carries
    `event_type`, `opportunity_id` (lower-cased UUID), `intention_id`, `card`, `revision`,
    `value`, `at` (UTC ISO) and `message_hash`."""
    if not isinstance(data, dict) or set(data) != RECORD_KEYS:
        return None
    event_type = data["event_type"]
    if event_type not in EVENT_TYPES:
        return None
    opportunity = data["opportunity_id"]
    if not (isinstance(opportunity, str) and ID_PATTERN.fullmatch(opportunity)):
        return None
    intention = data["intention_id"]
    if intention is not None and not (isinstance(intention, str) and ID_PATTERN.fullmatch(intention)):
        return None
    card = data["card"]
    if card not in CARDS:
        return None
    revision = data["revision"]
    if type(revision) is not int or not 1 <= revision <= REVISION_MAX:
        return None
    at = iso_from_text(data["at"])
    if at is None:
        return None
    value, message_hash = data["value"], data["message_hash"]
    if event_type == ASKED:
        if value is not None or not (isinstance(message_hash, str) and HEX64.fullmatch(message_hash)) or revision != 1:
            return None
    elif event_type == RATED:
        if card != "fit" or type(value) is not int or not 1 <= value <= 5 or message_hash is not None:
            return None
    elif event_type == PRE_PLANNED:
        if card != "planned" or value not in ("yes", "no") or message_hash is not None:
            return None
    else:
        if card != "collab" or not isinstance(value, str) or value not in COLLAB_VALUES or message_hash is not None:
            return None
    return {
        "event_type": event_type,
        "opportunity_id": opportunity.lower() if UUID.fullmatch(opportunity) else opportunity,
        "intention_id": intention,
        "card": card,
        "revision": revision,
        "value": value,
        "at": at,
        "message_hash": message_hash,
    }


def valid_file(data: Any) -> Optional[tuple[float, list]]:
    if not isinstance(data, dict) or set(data) != FILE_KEYS or type(data["v"]) is not int or data["v"] != FILE_VERSION:
        return None
    written = epoch_from_iso(iso_from_text(data["written_at"]))
    records = data["records"]
    if written is None or not isinstance(records, list) or not records:
        return None
    return written, records


def payload_for(record: dict) -> dict:
    """The closed payload for a valid record, keys in the contract's order."""
    kind = record["event_type"]
    if kind == ASKED:
        version = COLLAB_SCALE if record["card"] == "collab" else SCALE
        return {"question_version": version, "card": record["card"], "message_hash": record["message_hash"], "window_hours": WINDOW_HOURS}
    if kind == RATED:
        return {"value": record["value"], "scale": SCALE, "channel": CHANNEL, "revision": record["revision"], "rated_at": record["at"]}
    if kind == COLLAB_INTEREST:
        return {"value": record["value"], "scale": COLLAB_SCALE, "channel": CHANNEL, "revision": record["revision"], "answered_at": record["at"]}
    return {"value": record["value"], "channel": CHANNEL, "revision": record["revision"], "answered_at": record["at"]}


def event_id_for(record: dict) -> str:
    ms = int((epoch_from_iso(record["at"]) or 0.0) * 1000)
    return derived_uuid7(ms, f"av-rate|{record['event_type']}|{record['opportunity_id']}|{record['card']}|{record['revision']}")


def emit_record(record: dict, emit: Callable[..., Optional[dict]]) -> Optional[dict]:
    kind = record["event_type"]
    refs: dict[str, Any] = {
        "event_id": event_id_for(record),
        "occurred_at": record["at"],
        "occurred_at_earliest": record["at"],
        "occurred_at_latest": record["at"],
        "opportunity_id": record["opportunity_id"],
        "intention_id": record["intention_id"],
    }
    if kind == ASKED:
        refs["actor"] = "system"
    else:
        refs["actor"] = "participant"
        refs["evidence_class"] = "self_report"
    return emit(kind, payload_for(record), **refs)


def _one_file(path: str, emit: Callable[..., Optional[dict]], now: float, codes: dict) -> None:
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
    for raw in records[:RECORDS_MAX]:
        record = valid_record(raw)
        if record is None:
            _count(codes, DROPPED + "bad_record")
            continue
        try:
            event = emit_record(record, emit)
        except Exception:  # noqa: BLE001 - one record never stops the others
            _count(codes, DROPPED + "emit_error")
            continue
        _count(codes, "emitted" if event is not None else DROPPED + "emit_refused")


def tick(state_dir: str, emit: Callable[..., Optional[dict]], now: Optional[float] = None) -> dict:
    """Emit the waiting records and consume their files. Returns code -> count. Never raises."""
    now = time.time() if now is None else now
    codes: dict[str, int] = {}
    try:
        folder = events_dir(state_dir)
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
            _one_file(path, emit, now, codes)
        except Exception:  # noqa: BLE001 - one file never stops the others
            _count(codes, DROPPED + "error")
        finally:
            _unlink(path)
    return codes


__all__ = ["ASKED", "CHANNEL", "COLLAB_INTEREST", "COLLAB_SCALE", "DROPPED", "EVENT_TYPES", "PRE_PLANNED", "RATED", "SCALE", "SWITCH", "WINDOW_HOURS",
           "event_id_for", "events_dir", "payload_for", "tick", "valid_file", "valid_record"]
