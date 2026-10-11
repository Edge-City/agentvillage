"""`approval.card_requested@1` and `approval.card_resolved@1` (DATA-470 family).

The ambient-intent telemetry contract (`AMBIENT-CONTRACT.md`, "Event types"
item 3) asks the box to report every approval card an intention publish puts
in front of the resident, and how each one ended, with ids, codes and times
only: never the card's text, never the summary, never the payload.

**What a card is.** A question approval.md asks a human: a `propose` that
core answered `decision: requested` (a manual class). One proposal can raise
more than one card over its life: core asks again under the same task when a
question expired or was voided by a policy re-attest, and `_intent_approval`
re-proposes the same bytes then (at most `MAX_EXPIRED_REPROPOSALS` /
`MAX_VOID_REPROPOSALS` times). Each ask is its own card with its own
`card_id` (a uuid v7 minted here), so "one requested and one resolved event per
card" holds across re-asks. A class the policy clears (`autonomous`,
`supervised`) asks nobody and raises no card.

**Where the cards are kept.** On the intention's approval entry in the
plugin's map (`approval.cards`, a short list), written inside the same
compare-and-set that moves the proposal's state (`_intent_approval._cas`), so
a card is opened by exactly the one caller whose `unfiled -> requested` (or
`-> rejected`, `-> start_unconfirmed`) transition won, and closed by the one
caller whose transition out of `requested` won. Each card holds its id, its
`requested_at` / `resolved_at`, the resolution and the decider, and two sent
marks. Nothing in it is text.

**Emission and idempotency.** `flush` emits each card's two events once, under
the map's lock, and marks them sent in the same locked read-modify-write; a
mark that could not be saved (or a crash between the buffer append and the
save) re-sends the same event later. Every event id is derived, not random
(`_core.derived_uuid7`, the plugin's idempotency key pattern for `cron.run`
and `digest.shared`): `derived_uuid7(<ms of the card's own timestamp>,
"av-events|<event type>|<card_id>")`, so a re-send is the same row at ingest.
`sweep` (from every approval pass) sends whatever a crash or an inactive
collector left unsent.

**The switch.** `AV_APPROVAL_CARD_EVENTS` (`1|true|yes|on`), process
environment only like the rest of Lane B, default OFF. Off, nothing is
recorded on the map and nothing is emitted: the map's bytes are exactly what
they were before this module existed. Turn it on only after the data release
that registers both event types is live (the door goes first: ingest
quarantines an unknown type). A card opened while the switch was off is never
reported, not even when it resolves after the switch goes on.

**`kind` and `origin`.** `kind` is `intent_publish_inferred` for the inferred
class on an ambient entry, `intent_publish_stated` for the stated class on a
stated source, `other` for anything else. `origin` is the entry's `origin`
when the capture recorded one (`note_origin`, the memory-signal lane's hook),
else null.

**`decided_by`.** Core's `wait` answer names a state, not the actor. Reject
and revoke are human-only in core and the box's daemon has one human, the
resident (`APPROVAL_HUMAN=human:resident`): `resident`. A lapse is `timeout`.
A withdrawal, a void (a policy re-attest), a task the log no longer knows and
the agent's own withdraw are `system`. Nothing on the box can tell an
operator's hand from the resident's, so this producer never sends `operator`.

Python 3.11, standard library only.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Optional

from . import _approval
from ._core import derived_uuid7, iso_from_epoch, uuid7

logger = logging.getLogger("av-events")

SWITCH = "AV_APPROVAL_CARD_EVENTS"
TRUTHY = frozenset({"1", "true", "yes", "on"})

REQUESTED = "approval.card_requested"
RESOLVED = "approval.card_resolved"

CARDS_KEY = "cards"
ORIGIN_KEY = "origin"
#: The contract's closed lists.
ORIGINS = ("memory_signal_sync", "context_goal", "chat", "other")
KINDS = ("intent_publish_inferred", "intent_publish_stated", "other")
RESOLUTIONS = ("granted", "declined", "expired", "withdrawn")
DECIDERS = ("resident", "operator", "timeout", "system")

INFERRED_CLASS = "intent.publish.inferred.index"
STATED_CLASS = "intent.publish.stated.index"
STATED_SOURCES = frozenset({"message", "onboarding", "note"})

#: The contract's `uuid`: canonical, lowercase. The map is the agent's to write
#: (same uid), so nothing read back from it is sent unchecked.
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: One per ask: the first, two re-asks after a lapse, ten after a void, with room.
MAX_CARDS = 16

#: (resolution, decided_by) for each way a card ends.
GRANTED = ("granted", "resident")
DECLINED = ("declined", "resident")
EXPIRED = ("expired", "timeout")
WITHDRAWN = ("withdrawn", "system")

_emit_fn: Optional[Callable[..., bool]] = None


def set_emitter(fn: Optional[Callable[..., bool]]) -> None:
    """`fn(event_type, payload, *, event_id, occurred_at, intention_id) -> bool`,
    True when the event was buffered."""
    global _emit_fn
    _emit_fn = fn


def on() -> bool:
    return _approval.process_env(SWITCH).lower() in TRUTHY


def _ri():
    from . import _record_intention

    return _record_intention


def _clock() -> float:
    return float(_ri()._clock())


def resolution_of(status: Any) -> tuple[str, str]:
    """A card's end from core's `wait` status (or `propose` state)."""
    if status in ("granted", "executed", "nothing-to-wait-for"):
        return GRANTED
    if status in ("rejected", "revoked"):
        return DECLINED
    if status == "expired":
        return EXPIRED
    return WITHDRAWN


def kind_for(cls: Any, source: Any) -> str:
    if cls == INFERRED_CLASS and source == "ambient":
        return "intent_publish_inferred"
    if cls == STATED_CLASS and source in STATED_SOURCES:
        return "intent_publish_stated"
    return "other"


def _cards(ap: dict) -> list:
    cards = ap.get(CARDS_KEY)
    return cards if isinstance(cards, list) else []


def _open_card(ap: dict) -> Optional[dict]:
    """The latest card when it is still unresolved."""
    cards = _cards(ap)
    last = cards[-1] if cards else None
    return last if isinstance(last, dict) and last.get("resolution") is None else None


def _close(card: dict, end: tuple[str, str], now: float) -> None:
    card["resolution"], card["decided_by"] = end
    card["resolved_at"] = now


def mark(ap: dict, op: str, end: Optional[tuple[str, str]] = None) -> None:
    """Record a card change on the approval dict `ap`, inside the caller's
    locked compare-and-set. `op`: `open` (a new ask), `open_close` (an ask
    whose answer arrived in the same reply), `close` (the open card ended).
    A no-op with the switch off, and never raises."""
    if not on():
        return
    try:
        now = _clock()
        if op in ("open", "open_close"):
            cards = _cards(ap)
            stale = _open_card(ap)
            if stale is not None:
                # A card left open (a crash between a re-ask and its close): ended.
                _close(stale, WITHDRAWN, now)
            card = {"id": uuid7(), "requested_at": now, "resolution": None, "decided_by": None,
                    "resolved_at": None, "requested_sent": False, "resolved_sent": False}
            if op == "open_close" and end is not None:
                _close(card, end, now)
            cards.append(card)
            ap[CARDS_KEY] = cards[-MAX_CARDS:]
        elif op == "close" and end is not None:
            card = _open_card(ap)
            if card is not None:
                _close(card, end, now)
    except Exception as exc:  # noqa: BLE001 - telemetry never costs a transition
        logger.warning("av-events: card_events mark_failed=%s", type(exc).__name__)


def note_origin(intention_id: str, origin: Any) -> bool:
    """Record where an intention came from (`memory_signal_sync`,
    `context_goal`, `chat`, `other`) on its map entry, so its cards carry it.
    Call it after `open_entry` and before the proposal is advanced. True when
    it was written; an origin outside the contract's list is not."""
    if not on() or origin not in ORIGINS:
        return False
    ri = _ri()
    try:
        with ri._Locked():
            entries, publishes = ri._load_locked()
            entry = entries.get(intention_id)
            if not isinstance(entry, dict):
                return False
            entry[ORIGIN_KEY] = origin
            ri._save_locked(entries, publishes)
            return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: card_events origin_write_failed=%s", type(exc).__name__)
        return False


def _iso(value: Any) -> Optional[str]:
    return iso_from_epoch(value)


def _uuid(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and UUID.fullmatch(value) else None


def requested_payload(intention_id: str, entry: dict, ap: dict, card: dict) -> Optional[dict]:
    requested_at = _iso(card.get("requested_at"))
    if requested_at is None or _uuid(card.get("id")) is None:
        return None
    origin = entry.get(ORIGIN_KEY)
    return {
        "card_id": card["id"],
        "intent_id": _uuid(intention_id),
        "origin": origin if origin in ORIGINS else None,
        "kind": kind_for(ap.get("class"), entry.get("source")),
        "requested_at": requested_at,
    }


def resolved_payload(intention_id: str, card: dict) -> Optional[dict]:
    requested_at, resolved_at = _iso(card.get("requested_at")), _iso(card.get("resolved_at"))
    if (requested_at is None or resolved_at is None or _uuid(card.get("id")) is None
            or card.get("resolution") not in RESOLUTIONS or card.get("decided_by") not in DECIDERS):
        return None
    return {
        "card_id": card["id"],
        "intent_id": _uuid(intention_id),
        "resolution": card["resolution"],
        "decided_by": card["decided_by"],
        "requested_at": requested_at,
        "resolved_at": resolved_at,
    }


def event_id(event_type: str, card: dict) -> str:
    """Fixed by the card: a re-send is the same row at ingest."""
    at = card.get("resolved_at") if event_type == RESOLVED else card.get("requested_at")
    return derived_uuid7(int(float(at) * 1000), f"av-events|{event_type}|{card['id']}")


def _send(event_type: str, payload: dict, card: dict, at_key: str, intention_id: str) -> bool:
    fn = _emit_fn
    if fn is None:
        return False
    try:
        return bool(fn(event_type, payload, event_id=event_id(event_type, card),
                       occurred_at=_iso(card.get(at_key)), intention_id=intention_id))
    except Exception as exc:  # noqa: BLE001 - left unsent; the next sweep tries again
        logger.warning("av-events: card_events emit_failed=%s", type(exc).__name__)
        return False


def _pending(entry: Any) -> bool:
    ap = entry.get("approval") if isinstance(entry, dict) else None
    if not isinstance(ap, dict):
        return False
    for card in _cards(ap):
        if isinstance(card, dict) and (not card.get("requested_sent")
                                       or (card.get("resolution") is not None and not card.get("resolved_sent"))):
            return True
    return False


def _flush_entry(intention_id: str, entry: dict) -> bool:
    """Send what this entry's cards still owe. True when a mark changed."""
    ap = entry.get("approval")
    if not isinstance(ap, dict):
        return False
    changed = False
    for card in _cards(ap):
        if not isinstance(card, dict):
            continue
        if not card.get("requested_sent"):
            body = requested_payload(intention_id, entry, ap, card)
            if body is None:
                card["requested_sent"] = card["resolved_sent"] = True  # malformed: never sendable
                changed = True
                continue
            if not _send(REQUESTED, body, card, "requested_at", intention_id):
                continue  # never a resolved before its requested
            card["requested_sent"] = changed = True
        if card.get("resolution") is not None and not card.get("resolved_sent"):
            body = resolved_payload(intention_id, card)
            if body is None:
                card["resolved_sent"] = changed = True
                continue
            if _send(RESOLVED, body, card, "resolved_at", intention_id):
                card["resolved_sent"] = changed = True
    return changed


def flush(intention_id: Optional[str] = None) -> None:
    """Emit every card event still owed (one intention's, or every one's),
    under the map's lock so two processes never send the same one twice."""
    if not on() or _emit_fn is None:
        return
    ri = _ri()
    try:
        if intention_id is not None:
            if not _pending(ri.lookup(intention_id)):
                return
        elif not any(_pending(e) for e in ri._load_map().values()):
            return
        with ri._Locked():
            entries, publishes = ri._load_locked()
            ids = [intention_id] if intention_id is not None else list(entries)
            changed = False
            for iid in ids:
                entry = entries.get(iid)
                if _pending(entry):
                    changed = _flush_entry(iid, entry) or changed
            if changed:
                ri._save_locked(entries, publishes)
    except Exception as exc:  # noqa: BLE001 - never into Hermes, never kills the poller
        logger.warning("av-events: card_events flush_failed=%s", type(exc).__name__)


def sweep() -> None:
    """From every approval pass: whatever a crash or an inactive collector left."""
    flush(None)


__all__ = [
    "DECIDERS",
    "KINDS",
    "ORIGINS",
    "REQUESTED",
    "RESOLUTIONS",
    "RESOLVED",
    "SWITCH",
    "event_id",
    "flush",
    "kind_for",
    "mark",
    "note_origin",
    "on",
    "resolution_of",
    "set_emitter",
    "sweep",
]
