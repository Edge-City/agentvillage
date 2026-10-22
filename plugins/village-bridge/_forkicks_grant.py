"""FK-ON-GRANT: place a For Kicks order on the resident's grant, then tell them in their own agent chat.

Why (CLAIMS L17710): `authorize_order` reads the task once (`wait --timeout 0`). On the first confirm the
card was only just sent, so the agent's turn ends with `approval_required`, and after the resident taps
Approve nothing woke up: the order was placed only on the resident's next message.

What: a pass on av-events' approval poller (`_approval.register_pass`, every `AV_APPROVAL_POLL_S`). When
`authorize_order` finds the card still waiting (wait exit 6), `track` writes `forkicks-drafts/<draftId>.await`
(the task id and when). Each pass reads at most MAX_PER_PASS of those markers, newest first:

1. Consent unchanged (nonav (1), approval B1): acts only when `wait` answers `granted` (exit 0) with this
   draft's action key `granted`, and only on a task whose propose answered `requested` (a manual class:
   `track` is called from no other branch). Core's `grant` verb is human-only, so a `granted` action is a
   human's decision on the approvals channel; the start must then answer `authorization: grant`, the same
   check `authorize_order` relies on. A spent grant (`nothing-to-wait-for` with the action still `granted`:
   the agent's retry, or this pass before a lost write, already started it) goes straight to confirm, as
   `authorize_order`'s `state == "executed"` path does. Rejected / revoked / withdrawn / expired / void /
   unknown task: one plain line, no order. The pass never proposes (B3): no new card is ever raised.
2. One placer (nonav (2), approval B2): the start is the SAME `ap.start(task, key, held)` with the saved held
   bytes (core's payload-hash binding and single spend stay the guard), the confirm is the agent's own
   confirm (same draftId, so the app's idempotency key and its confirm lease, 409
   `forkicks_confirm_in_progress`, are the second guard), and a receipt is recorded once per draft in
   `<draftId>.placed` (O_EXCL). The agent's later confirm of that draft returns that receipt and calls nothing.
3. Only drafts this box saved (nonav (3)): `load_preview` (owner + origin + the saved payload's hash).
   A start or first confirm never happens at or after the quote's `expiresAt` (no re-quote, no re-propose):
   the "wasn't placed" line instead. Only an earlier confirm whose answer was lost is retried after it
   (the merchant answers the same idempotency key with the existing order and refuses a new create).
4. The line (nonav (4), approval B4): one of the two product constants below, filled only from the approved
   preview (place, date, opening hours), sent ONLY to `telegram:<ownerTelegramId>`, the resident's own DM
   with their agent (the chat `bound_context` requires for every order: CHAT_ID == USER_ID == the paired
   owner), never asking them to approve anything. Sent with Hermes's own native sender, the one cron
   delivery uses (`tools/send_message_tool._send_to_platform`, no model and no session mirror), at most
   once per task (`<draftId>.line-<task>` O_EXCL claim before the send).
5. Bounded (nonav (5)): MAX_PER_PASS markers a pass, SCAN_LIMIT directory entries, and a marker older than
   TTL_S is closed (an unanswered card: the "expired" line; a lost confirm answer: no line, since the order
   may exist, and the agent's confirm of the same draft still recovers its receipt).
6. Events (nonav (6), approval B5): one per outcome (`placed` / `denied` / `expired` / `failed`) with a code,
   on the plugin bus (`village-bridge:forkicks.order_outcome`) and as one codes-only log line. No resident
   text, no ids.

Python 3.11, standard library only.
"""
from __future__ import annotations

import json
import logging
import os
import re
import stat
import time
import uuid
from datetime import date as _date, datetime, timedelta, timezone

from ._forkicks import cache_path, canonical, checked_payload, load_preview, order_preview
from ._mini_apps import ORDER_PLACED_ON_APPROVAL, approval_modules

LOG = logging.getLogger("village_bridge")

PASS_NAME = "forkicks_orders"
KEY_PREFIX = "marketplace.app.action:forkicks.order.confirm:"
TASK = re.compile(r"propose:[a-f0-9]{32}")
OWNER = re.compile(r"[1-9]\d{0,19}")
ORDER_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
ORDER_NUMBER = re.compile(r"#[0-9]{3,6}")
#: Markers read per pass, directory entries looked at per pass, and a marker's life.
MAX_PER_PASS = 8
SCAN_LIMIT = 2000
TTL_S = 2 * 60 * 60
MARKER_MAX_BYTES = 16384
#: A CP that has not yet read the daemon's start answers 403 forkicks_approval_required; this many confirms, then the failure line.
MAX_UNVERIFIED = 3
IST = timezone(timedelta(hours=5, minutes=30))

# Product's words (nonav (4)): one constant each. Filled only from the approved preview, never agent text.
PLACED_LINE = "Approved: your For Kicks order is placed. Pickup: {place} · {time}."
PLACED_LINE_PLAIN = "Approved: your For Kicks order is placed."
NOT_PLACED_LINE = "Your For Kicks order wasn't placed: {reason}."
REASONS = {
    "denied": "the approval was declined",
    "withdrawn": "the approval request was withdrawn",
    "expired": "the approval or the price quote expired",
    "failed": "For Kicks couldn't take it",
}
OUTCOMES = ("placed", "denied", "expired", "failed")

_EMIT = None


def set_emitter(emit) -> None:
    """`emit(payload)` publishes `forkicks.order_outcome` on the plugin bus (bridge register)."""
    global _EMIT
    _EMIT = emit


def _event(outcome: str, code: str) -> None:
    payload = {"outcome": outcome, "code": code}
    LOG.info("village_bridge: forkicks_on_grant outcome=%s code=%s", outcome, code)
    if _EMIT is not None:
        try:
            _EMIT(payload)
        except Exception:  # noqa: BLE001 - an event never costs the outcome
            pass


# ---- markers ---------------------------------------------------------------------------------------


def _path(home, draft_id, suffix):
    base = cache_path(home, draft_id)  # validates the id; refuses a linked folder or preview
    path = base.with_name(draft_id + suffix)
    if path.is_symlink():
        raise ValueError("marker_invalid")
    return path


def _read(path) -> dict:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MARKER_MAX_BYTES:
            raise ValueError("marker_invalid")
        doc = json.load(handle)
    if not isinstance(doc, dict):
        raise ValueError("marker_invalid")
    return doc


def _create(path, doc) -> bool:
    """Write once (O_EXCL). False when the file already exists."""
    data = canonical(doc).encode("utf-8")
    if len(data) > MARKER_MAX_BYTES:
        raise ValueError("marker_too_large")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return True


def _replace(path, doc) -> None:
    tmp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(canonical(doc).encode("utf-8"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _drop(path) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def track(home, draft_id, task, now=None) -> bool:
    """The card for this draft is waiting for its tap: hand its task to the pass. True when tracked.
    The same task keeps its first time; a new task (a later re-ask of this draft) replaces it."""
    if not isinstance(task, str) or not TASK.fullmatch(task):
        return False
    path = _path(home, draft_id, ".await")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    doc = {"task": task, "since": int(now if now is not None else time.time()), "phase": "awaiting", "unverified": 0}
    if _create(path, doc):
        return True
    try:
        if _read(path).get("task") == task:
            return True
    except Exception:  # noqa: BLE001 - an unreadable marker is replaced by this one
        pass
    _replace(path, doc)
    return True


def receipt_of(result):
    """A successful confirm answer (the app's receipt), or None."""
    if (not isinstance(result, dict) or "error" in result or not isinstance(result.get("orderId"), str)
            or not ORDER_ID.fullmatch(result["orderId"]) or not isinstance(result.get("number"), str)
            or not ORDER_NUMBER.fullmatch(result["number"])):
        return None
    return result


def placed(home, draft_id):
    """The receipt recorded for this draft (`{"by", "receipt"}`), or None."""
    try:
        doc = _read(_path(home, draft_id, ".placed"))
    except FileNotFoundError:
        return None
    if doc.get("by") not in ("pass", "agent") or receipt_of(doc.get("receipt")) is None:
        raise ValueError("marker_invalid")
    return doc


def record_placed(home, draft_id, receipt, by) -> bool:
    """Record the first receipt for this draft (O_EXCL). False when one is already recorded."""
    if receipt_of(receipt) is None:
        return False
    path = _path(home, draft_id, ".placed")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        return _create(path, {"by": by, "receipt": receipt})
    except ValueError:
        return False  # too large to keep: the app's own replay still answers the same receipt


# ---- the line ----------------------------------------------------------------------------------------


def _clean(text, cap):
    """Approved-preview text for the line: letters, digits, spaces and plain punctuation only (no
    Markdown, no MEDIA: directive, no control or format characters), or None."""
    if not isinstance(text, str):
        return None
    kept = "".join(ch for ch in text if ch.isalnum() or ch in " ,.'&()-/")
    kept = " ".join(kept.split())
    if not kept or len(kept) > cap or "media:" in kept.lower():
        return None
    return kept


def _ist(value):
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return moment.astimezone(IST) if moment.tzinfo else None


def placed_line(record) -> str:
    """The placed line from the approved preview (pickup: place, IST date, opening hours that day). The preview is
    read with `order_preview`: inside a legacy payload, beside a flat (card) one (approval L17927)."""
    try:
        preview = order_preview(record)
        fulfilment, location = preview["fulfilment"], preview["quote"]["location"]
        if fulfilment["type"] != "pickup" or not isinstance(location, dict):
            return PLACED_LINE_PLAIN
        place = _clean(location.get("name"), 80)
        day = fulfilment.get("date") or (location.get("opens") or "")[:10]
        when = _date.fromisoformat(day)
        time_text = f"{when:%a} {when.day} {when:%b}"
        opens, closes = _ist(location.get("opens")), _ist(location.get("closes"))
        if opens is not None and closes is not None and opens.date() == when and closes > opens:
            time_text += ", " + opens.strftime("%H:%M") + "–" + closes.strftime("%H:%M")
    except (KeyError, TypeError, ValueError, AttributeError):
        return PLACED_LINE_PLAIN
    return PLACED_LINE.format(place=place, time=time_text) if place else PLACED_LINE_PLAIN


def _telegram_dm(owner: str, text: str) -> bool:
    """Hermes's native Telegram sender, as cron delivery uses it: the gateway's own bot to `owner`'s
    private chat. No model, no session mirror. True when Telegram accepted it."""
    import asyncio
    from gateway.config import load_gateway_config
    from tools.send_message_tool import _authorize_relay_target, _resolve_platform_config, _send_to_platform

    platform, pconfig, _entry, error = _resolve_platform_config("telegram", load_gateway_config())
    if error or pconfig is None:
        return False
    if _authorize_relay_target("telegram", owner, None, native_token=getattr(pconfig, "token", None)):
        return False

    async def send():
        return await asyncio.wait_for(_send_to_platform(platform, pconfig, owner, text), timeout=30)

    result = asyncio.run(send())
    return isinstance(result, dict) and result.get("success") is True


def _deliver(home, draft_id, task, owner, text) -> str:
    """At most one line per task: claim `<draftId>.line-<task>` (O_EXCL), then send. A code."""
    if not isinstance(owner, str) or not OWNER.fullmatch(owner):
        return "line_owner_invalid"
    if not _create(_path(home, draft_id, ".line-" + task.split(":", 1)[1]), {"task": task}):
        return "line_already_sent"
    try:
        return "line_sent" if _telegram_dm(owner, text) else "line_failed"
    except Exception:  # noqa: BLE001 - at most once: a failed send is not retried
        return "line_failed"


# ---- the pass ----------------------------------------------------------------------------------------


def _expires(record):
    try:
        moment = datetime.fromisoformat(order_preview(record)["quote"]["expiresAt"])
    except (KeyError, TypeError, ValueError):
        return None
    return moment.timestamp() if moment.tzinfo else None


def _awaiting(home, limit=MAX_PER_PASS):
    folder = home / "forkicks-drafts"
    if folder.is_symlink() or not folder.is_dir():
        return []
    found = []
    with os.scandir(folder) as entries:
        for index, entry in enumerate(entries):
            if index >= SCAN_LIMIT:
                break
            if entry.name.endswith(".await") and entry.is_file(follow_symlinks=False):
                found.append((entry.stat(follow_symlinks=False).st_mtime, entry.name[:-len(".await")]))
    return [name for _, name in sorted(found, reverse=True)[:limit]]


def run_pass(home, config, transport, installed, now=None) -> dict:
    """Advance at most MAX_PER_PASS awaited drafts once. Counts by code (for the log line)."""
    counts: dict = {}
    for draft_id in _awaiting(home):
        try:
            code = advance(home, config, transport, installed, draft_id, now=now)
        except Exception as error:  # noqa: BLE001 - one draft never costs the others
            code = "error_" + type(error).__name__
        counts[code] = counts.get(code, 0) + 1
    if counts:
        LOG.info("village_bridge: forkicks_on_grant pass %s", " ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return counts


def _finish(home, draft_id, task, owner, marker_path, outcome, code, line):
    delivered = _deliver(home, draft_id, task, owner, line) if line is not None else None
    _event(outcome, code)
    _drop(marker_path)
    return outcome + ":" + code + ("" if delivered is None else ":" + delivered)


def _not_placed(home, draft_id, task, owner, marker_path, outcome, code, reason):
    return _finish(home, draft_id, task, owner, marker_path, outcome, code, NOT_PLACED_LINE.format(reason=REASONS[reason]))


def advance(home, config, transport, installed, draft_id, now=None) -> str:
    now = float(now if now is not None else time.time())
    marker_path = _path(home, draft_id, ".await")
    try:
        marker = _read(marker_path)
    except FileNotFoundError:
        return "gone"
    task, since, phase = marker.get("task"), marker.get("since"), marker.get("phase")
    if (not isinstance(task, str) or not TASK.fullmatch(task) or type(since) is not int
            or phase not in ("awaiting", "started", "attempted")):
        _drop(marker_path)
        return "marker_invalid"
    owner = config.get("ownerTelegramId")
    key = KEY_PREFIX + draft_id
    done = placed(home, draft_id)
    if done is not None:
        if done["by"] == "pass":  # this pass placed it; a crash may have come before its line
            try:
                line = placed_line(load_preview(home, draft_id, config))
            except Exception:  # noqa: BLE001 - the plain line needs no preview fact
                line = PLACED_LINE_PLAIN
            return _finish(home, draft_id, task, owner, marker_path, "placed", "on_grant", line)
        return _finish(home, draft_id, task, owner, marker_path, "placed", "agent_retry", None)
    try:
        # Only a draft this box saved for this owner and origin, with its exact approved bytes.
        record = load_preview(home, draft_id, config)
        # A flat (card) payload is checked against the order preview saved beside it (approval L17927).
        held = checked_payload(record["payload"], draft_id, record["payloadHash"], record.get("preview"))
    except Exception:  # noqa: BLE001 - not this box's draft (or not this owner's): ignored, no line
        _drop(marker_path)
        return "not_this_box"
    if now - since > TTL_S:
        if phase == "attempted":  # the order may exist: no line; the agent's confirm of this draft recovers it
            return _finish(home, draft_id, task, owner, marker_path, "failed", "uncertain_ttl", None)
        return _not_placed(home, draft_id, task, owner, marker_path, "expired", "ttl", "expired")
    expires = _expires(record)
    quote_live = expires is not None and now < expires
    if phase == "awaiting":
        if not quote_live:
            return _not_placed(home, draft_id, task, owner, marker_path, "expired", "quote_expired", "expired")
        ap = approval_modules()  # approval_unavailable: the marker waits for the next pass
        waited = ap.wait(task)
        status = waited.status
        mine = [a for a in (waited.doc.get("actions") or []) if isinstance(a, dict) and a.get("action_key") == key]
        human = len(mine) == 1 and mine[0].get("state") == "granted"
        if waited.exit_code == 0 and status == "granted" and human:
            started = ap.start(task, key, held)
            if not started.ok or started.doc.get("authorization") != "grant":
                return "start_refused"  # the next wait says why (spent, expired, void)
        elif waited.exit_code == 0 and status in ("nothing-to-wait-for", "executed") and human:
            pass  # the grant was already spent by a start of this same task: confirm adopts it
        elif waited.exit_code == 6:
            return "pending"
        elif status in ("rejected", "revoked"):
            return _not_placed(home, draft_id, task, owner, marker_path, "denied", status, "denied")
        elif status == "withdrawn":
            return _not_placed(home, draft_id, task, owner, marker_path, "denied", "withdrawn", "withdrawn")
        elif waited.exit_code in (3, 7) or status in ("expired", "void"):
            return _not_placed(home, draft_id, task, owner, marker_path, "expired", status or "expired", "expired")
        elif waited.exit_code == 1:
            return _not_placed(home, draft_id, task, owner, marker_path, "failed", "not_registered", "failed")
        else:
            return "wait_unclear"
        phase = "started"
        _replace(marker_path, {**marker, "phase": phase})
    if phase == "started" and not quote_live:
        # A start is spent, but no confirm was ever sent: nothing was placed, and no re-quote is made.
        return _not_placed(home, draft_id, task, owner, marker_path, "expired", "quote_expired", "expired")
    if not installed(home, "forkicks", "forkicks.order.confirm"):
        if phase == "started":
            return _not_placed(home, draft_id, task, owner, marker_path, "failed", "not_installed", "failed")
        return "not_installed"
    # Recorded BEFORE the confirm is sent: from here on a lost answer may be a placed order.
    _replace(marker_path, {**marker, "phase": "attempted"})
    proof = {"taskId": task, "payloadHash": record["payloadHash"], "payload": record["payload"]}
    try:
        result = transport(config, {"operation": "forkicks.order.confirm", "draftId": draft_id, "approval": proof})
    except Exception:  # noqa: BLE001 - no answer: retried next pass with the same draftId
        return "confirm_uncertain"
    receipt = receipt_of(result)
    if receipt is not None:
        if not record_placed(home, draft_id, receipt, "pass"):
            done = placed(home, draft_id)
            if done is not None and done["by"] == "agent":  # the agent's confirm recorded it first and told them
                return _finish(home, draft_id, task, owner, marker_path, "placed", "agent_retry", None)
        return _finish(home, draft_id, task, owner, marker_path, "placed", "on_grant", placed_line(record))
    error = result.get("error") if isinstance(result, dict) else None
    status = result.get("status") if isinstance(result, dict) else None
    if error == "forkicks_confirm_in_progress":
        return "confirm_in_progress"  # the agent's confirm holds the app's lease; read again next pass
    if error == "forkicks_approval_required":
        unverified = marker.get("unverified") if type(marker.get("unverified")) is int else 0
        if unverified + 1 >= MAX_UNVERIFIED:
            return _not_placed(home, draft_id, task, owner, marker_path, "failed", "approval_not_verified", "failed")
        _replace(marker_path, {**marker, "phase": "attempted", "unverified": unverified + 1})
        return "approval_not_verified"
    if isinstance(error, str) and error.startswith("pickup_only:"):
        return _not_placed(home, draft_id, task, owner, marker_path, "failed", "pickup_only", "failed")
    if error == "forkicks_order_rejected":
        return _not_placed(home, draft_id, task, owner, marker_path, "failed", "order_rejected", "failed")
    if error == "connection_or_request_refused" and type(status) is int and 400 <= status < 500 and status != 429:
        # The app refused before any order could exist (it releases its lease only then).
        return _not_placed(home, draft_id, task, owner, marker_path, "failed", "refused_" + str(status), "failed")
    return "confirm_uncertain"  # 5xx, 429 or an unreadable answer: the same draftId again next pass


def instruction_if_tracked(home, draft_id, task, ensure) -> str | None:
    """`authorize_order`'s `on_requested`: track the task and make sure the pass runs; the agent then
    tells the owner the order is placed on their tap. None (the older instruction) when it cannot."""
    try:
        if ensure() and track(home, draft_id, task):
            return ORDER_PLACED_ON_APPROVAL
    except Exception:  # noqa: BLE001 - the older instruction still works (the agent retries confirm)
        pass
    return None
