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
   the "wasn't placed" line instead. Only an earlier confirm whose answer was lost is retried after it, and a
   grant the wait shows spent while the marker still says awaiting (a start whose answer was lost, review-a N5) is
   confirmed after it (the merchant answers the same idempotency key with the existing order and refuses a new create).
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

import contextlib
import fcntl
import hashlib
import json
import logging
import os
import re
import stat
import time
import uuid
from datetime import date as _date, datetime, timedelta, timezone

from ._forkicks import cache_path, canonical, checked_payload, load_preview, order_preview, quote_expires as _expires
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
_EMIT_CARD = None


def set_emitter(emit) -> None:
    """`emit(payload)` publishes `forkicks.order_outcome` on the plugin bus (bridge register)."""
    global _EMIT
    _EMIT = emit


def set_card_emitter(emit) -> None:
    """`emit(payload)` publishes `forkicks.card_requested` on the plugin bus (bridge register)."""
    global _EMIT_CARD
    _EMIT_CARD = emit


def task_hash(task: str) -> str:
    """The join key for card latency (lead L20022): sha256 of the full task string, hex, first 16 characters."""
    return hashlib.sha256(task.encode("utf-8")).hexdigest()[:16]


def card_requested(task: str, now=None) -> dict:
    """FK-CARD-AT-PREPARE latency (lead L20022): once per draft, when its first propose answered `requested`.
    One codes-only log line and one plugin-bus event: the task's hash and the UTC time (ms). No ids, no text."""
    moment = datetime.fromtimestamp(now if now is not None else time.time(), timezone.utc)
    payload = {"task_hash": task_hash(task), "at": moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    LOG.info("village_bridge forkicks card_requested task_hash=%s at=%s", payload["task_hash"], payload["at"])
    if _EMIT_CARD is not None:
        try:
            _EMIT_CARD(payload)
        except Exception:  # noqa: BLE001 - an event never costs the card
            pass
    return payload


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


def card_task(home, draft_id):
    """FK-CARD-AT-PREPARE (approval L19920 (2)): the task this box already proposed for this draft, or None.
    `authorize_order` then only reads it, so one draft has at most one card however often confirm runs."""
    try:
        task = _read(_path(home, draft_id, ".card")).get("task")
    except FileNotFoundError:
        return None
    if not isinstance(task, str) or not TASK.fullmatch(task):
        raise ValueError("marker_invalid")
    return task


def record_card(home, draft_id, task) -> bool:
    """Record the first proposed task for this draft (O_EXCL), after the daemon answered `requested`."""
    if not isinstance(task, str) or not TASK.fullmatch(task):
        return False
    path = _path(home, draft_id, ".card")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return _create(path, {"task": task})


# ---- one live order per owner (S1, review-a RA41, lead L20080) --------------------------------------
# Every saved prepare raises a card, so a changed order would leave the earlier card tappable (two taps, two
# orders). The newest saved draft is recorded; at a new prepare the other drafts' waiting cards are withdrawn, and
# the pass never starts an older draft (belt and braces, e.g. when a withdraw could not reach the daemon).
LATEST = ".latest"  # a dot name: never a draft id (cache_path's [A-Za-z0-9_-])
SUPERSEDED_LINE = "Nothing was ordered from your earlier For Kicks preview: your newer one replaced it."


# Fail closed (security review of the S1 fold): an unreadable or corrupt `.latest` refuses every start.
LATEST_UNREADABLE_LINE = "Nothing was ordered: I couldn't check this is your newest For Kicks preview. Ask me for a new one."
LOCK_NAME = ".lock"


@contextlib.contextmanager
def drafts_lock(home):
    """One flock on forkicks-drafts/.lock: a prepare's set_latest and a start's newest-draft check + start are
    one step each, never interleaved (security review (3))."""
    folder = home / "forkicks-drafts"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if folder.is_symlink():
        raise ValueError("marker_invalid")
    fd = os.open(folder / LOCK_NAME, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def set_latest(home, draft_id) -> None:
    cache_path(home, draft_id)  # validates the id
    with drafts_lock(home):
        path = home / "forkicks-drafts" / LATEST
        if path.is_symlink():
            raise ValueError("marker_invalid")
        _replace(path, {"draftId": draft_id})


def newest_reason(home, draft_id):
    """None when `draft_id` may start; else why not: "superseded" (an older draft) or "latest_unreadable"
    (fail closed). No record at all (no prepare since this version) refuses nothing."""
    try:
        newest = latest(home)
    except Exception:  # noqa: BLE001 - fail closed
        return "latest_unreadable"
    return "superseded" if newest is not None and newest != draft_id else None


def tombstone(home, draft_id, code) -> None:
    """A durable `<draftId>.refused` (O_EXCL, the code inside): this draft is never placed, by any path."""
    path = _path(home, draft_id, ".refused")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    _create(path, {"code": code if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,40}", code) else "refused"})


def tombstone_code(home, draft_id):
    """The draft's tombstone code, None when it has none; an unreadable or corrupt one is "corrupt" (fail closed)."""
    try:
        doc = _read(_path(home, draft_id, ".refused"))
    except FileNotFoundError:
        return None
    except Exception:  # noqa: BLE001 - fail closed
        return "corrupt"
    code = doc.get("code")
    return code if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,40}", code) else "corrupt"


def tombstoned(home, draft_id) -> bool:
    """True when the draft has a tombstone; an unreadable or corrupt one counts (fail closed)."""
    return tombstone_code(home, draft_id) is not None


def guarded_start(home, draft_id, start):
    """(reason, None) when this draft may not start, else (None, start()). Check and start under drafts_lock.
    A refusal leaves a tombstone, so no later adoption of a grant can place this draft."""
    with drafts_lock(home):
        code = tombstone_code(home, draft_id)
        if code is not None:
            return ("expired" if code == EXPIRED else "refused"), None  # expired: the closed-card words
        reason = newest_reason(home, draft_id)
        if reason is not None:
            if reason == "superseded":  # an older draft never places (an unreadable record may be repaired)
                tombstone(home, draft_id, reason)
            return reason, None
        return None, start()


def guard_adopt(home, draft_id):
    """For adopting an already-started grant: refused only by a tombstone (read fail-closed under the lock).
    A started draft without one is an order in flight and keeps its confirm. So is one tombstoned `expired`: that
    tombstone is written only where nothing was started, so a spent grant means a start before it (an order that
    may exist); the app answers its idempotency key with that order and refuses a new create past the quote."""
    with drafts_lock(home):
        code = tombstone_code(home, draft_id)
        return None if code in (None, EXPIRED) else "refused"


def latest(home):
    """The newest saved draft id, or None (no record: no draft is refused as older)."""
    try:
        doc = _read(home / "forkicks-drafts" / LATEST)
    except FileNotFoundError:
        return None
    value = doc.get("draftId")
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        raise ValueError("marker_invalid")
    return value


def waiting_tasks(home, keep, now=None):
    """Other drafts' cards that may still be waiting, as (draftId, task): their `.await` task, else a recent `.card`
    with no `.placed`."""
    now = float(now if now is not None else time.time())
    folder = home / "forkicks-drafts"
    if folder.is_symlink() or not folder.is_dir():
        return []
    found = {}
    with os.scandir(folder) as entries:
        for index, entry in enumerate(entries):
            if index >= SCAN_LIMIT or len(found) >= MAX_PER_PASS:
                break
            for suffix in (".await", ".card"):
                if not entry.name.endswith(suffix) or not entry.is_file(follow_symlinks=False):
                    continue
                draft = entry.name[:-len(suffix)]
                if draft == keep or draft in found or (folder / (draft + ".placed")).exists():
                    continue
                if suffix == ".card" and now - entry.stat(follow_symlinks=False).st_mtime > TTL_S:
                    continue
                try:
                    task = _read(_path(home, draft, suffix)).get("task")
                except Exception:  # noqa: BLE001
                    continue
                if isinstance(task, str) and TASK.fullmatch(task):
                    found[draft] = task
    return list(found.items())


def supersede(home, keep) -> int:
    """Withdraw the owner's other waiting For Kicks cards (best effort, codes-only). The withdrawn drafts' markers
    stay: the pass closes each with SUPERSEDED_LINE."""
    tasks = waiting_tasks(home, keep)
    if not tasks:
        return 0
    ap = approval_modules()
    done = 0
    for draft, task in tasks:
        try:
            ap.withdraw(task, "superseded", KEY_PREFIX + draft)  # core withdraws by action key
            done += 1
        except Exception:  # noqa: BLE001 - the pass still refuses the older draft
            pass
    LOG.info("village_bridge forkicks superseded count=%d", done)
    return done


def awaiting_any(home) -> bool:
    folder = home / "forkicks-drafts"
    if folder.is_symlink() or not folder.is_dir():
        return False
    with os.scandir(folder) as entries:
        for index, entry in enumerate(entries):
            if index >= SCAN_LIMIT:
                break
            if entry.name.endswith(".await") and entry.is_file(follow_symlinks=False):
                return True
    return False


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


def _refuse_older(home, draft_id, task, owner, marker_path, reason, spent=False, own_start=False):
    """S1: never start an older draft (or any draft while `.latest` is unreadable). One line per draft, a code.
    The tombstone keeps every later path (the agent's confirm adopting a spent grant included) from placing it.
    `spent` (review-a ov#465 N8, product ruling (i)): the newest-draft check read this draft's grant spent, so the
    agent's confirm may have placed it and lost its answer: the tombstone and the withdraw are as always, but no
    SUPERSEDED_LINE ("Nothing was ordered from your earlier ...") is sent, since it could be false. `own_start`: the
    refusal of this pass's own start before any confirm (nothing was sent): a retry of an unwritable tombstone keeps
    today's line, without a wait read (its grant reads spent by that very start)."""
    try:
        with drafts_lock(home):
            tombstone(home, draft_id, reason)
    except Exception:  # noqa: BLE001 - fail closed (security review of 9e201d83)
        LOG.warning("village_bridge forkicks tombstone code=unwritable")
        # No line and no withdraw yet: the marker goes back to awaiting, so the next pass re-runs the newest check
        # first and retries the tombstone; a started marker would let the pass confirm this draft.
        try:
            _replace(marker_path, {**_read(marker_path), "phase": "awaiting", **({"ownStart": True} if own_start else {})})
        except Exception:  # noqa: BLE001 - the pass never places a draft without a marker
            try:
                _drop(marker_path)
            except Exception:  # noqa: BLE001 - logged above
                pass
        return "tombstone_unwritable"
    if reason != "latest_unreadable":
        try:
            approval_modules().withdraw(task, "superseded", KEY_PREFIX + draft_id)
        except Exception:  # noqa: BLE001 - this draft is never started from here on anyway
            pass
        if spent:  # an order may exist: refused for good, but no "nothing was ordered" line
            return _finish(home, draft_id, task, owner, marker_path, "failed", "uncertain_" + reason, None)
        return _finish(home, draft_id, task, owner, marker_path, "denied", reason, SUPERSEDED_LINE)
    LOG.warning("village_bridge forkicks newest_check code=%s", reason)
    return _finish(home, draft_id, task, owner, marker_path, "denied", reason, LATEST_UNREADABLE_LINE)


# Quote expiry (lead L20310, approval L20313): core knows only the policy's approval TTL (hours), so a card whose quote
# (~5 min) was gone stayed live: a daemon restart re-sent it, a tap placed nothing. Each not-placed outcome for time
# where nothing was started (awaiting: quote expired, TTL, a wait answering expired/void) withdraws the card and
# tombstones the draft `expired`, so a later confirm gets ORDER_CARD_CLOSED. Core's withdraw reasons are closed
# (0.4.7: timeout | cancelled | superseded); `timeout` is its "a decision on this request can no longer be consumed".
# Core refuses a withdraw of a granted, spent or lapsed request (already-decided / expired): never an order in flight.
EXPIRED = "expired"
WITHDRAW_EXPIRED = "timeout"


def close_expired(home, draft_id, task) -> None:
    """Best effort, codes-only: tombstone the draft `expired` (under drafts_lock), then withdraw its card (task)."""
    try:
        with drafts_lock(home):
            tombstone(home, draft_id, EXPIRED)
    except Exception:  # noqa: BLE001 - no start or first confirm happens past the quote anyway
        LOG.warning("village_bridge forkicks tombstone code=unwritable")
    if task is None:
        return
    try:
        done = approval_modules().withdraw(task, WITHDRAW_EXPIRED, KEY_PREFIX + draft_id)
        LOG.info("village_bridge forkicks expired_withdraw code=%s", "withdrawn" if done.ok else "refused")
    except Exception:  # noqa: BLE001 - the tombstone still closes the draft on this box
        LOG.info("village_bridge forkicks expired_withdraw code=unsent")


def _spent(waited, key) -> bool:
    """The wait shows this draft's grant spent by a start of this task (its own action `granted`): an order in flight."""
    mine = [a for a in (waited.doc.get("actions") or []) if isinstance(a, dict) and a.get("action_key") == key]
    return (waited.exit_code == 0 and waited.status in ("nothing-to-wait-for", "executed") and len(mine) == 1
            and mine[0].get("state") == "granted")


def _expired_awaiting(home, draft_id, task, key, owner, marker_path, code, ttl):
    """An awaiting marker past its quote (or the TTL). Review-a ov#465 N1 (probe X1): `awaiting` is only the pass's own
    progress, and the agent's confirm may have started the draft and lost its answer, so the wait is read FIRST. A
    spent grant is an order that may exist: no line, no tombstone, no withdraw. Past the TTL the marker ends there (as
    `uncertain_ttl` does for an attempted marker); the agent's confirm of the same draft adopts it. Past the quote, None:
    the caller sends the confirm with the same draftId and the app decides (review-a N5: the pass's own start may be the
    spent one, with its answer lost and no confirm ever sent; the app answers an existing order by its idempotency key
    and the merchant refuses a new create past the quote, so the owner gets the true line either way). An unreadable
    wait leaves the marker for the next pass; past the TTL, today's line without the close (nothing about the card is
    known)."""
    try:
        waited = approval_modules().wait(task)
    except Exception:  # noqa: BLE001 - approval_unavailable (or no answer)
        if not ttl:
            return "approval_unavailable"
        return _not_placed(home, draft_id, task, owner, marker_path, "expired", code, "expired")
    if _spent(waited, key):
        if not ttl:
            return None
        return _finish(home, draft_id, task, owner, marker_path, "failed", "uncertain_" + code, None)
    close_expired(home, draft_id, task)
    return _not_placed(home, draft_id, task, owner, marker_path, "expired", code, "expired")


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
    if phase != "attempted" and tombstoned(home, draft_id):
        _drop(marker_path)
        return "refused_earlier"
    if phase == "awaiting":
        reason = newest_reason(home, draft_id)
        if reason is not None:
            # Review-a ov#465 N8 (product ruling (i)): the wait first. A grant the agent's confirm spent (its answer
            # lost) may be a placed order: refused as always, without the "nothing was ordered" line. An unreadable
            # wait, or a retry of this pass's own refused start (`ownStart`), is today's refusal.
            spent = False
            if reason == "superseded" and marker.get("ownStart") is not True:
                try:
                    spent = _spent(approval_modules().wait(task), key)
                except Exception:  # noqa: BLE001 - unreadable: today's refusal, with its line
                    spent = False
            return _refuse_older(home, draft_id, task, owner, marker_path, reason, spent=spent)
    if now - since > TTL_S:
        if phase == "attempted":  # the order may exist: no line; the agent's confirm of this draft recovers it
            return _finish(home, draft_id, task, owner, marker_path, "failed", "uncertain_ttl", None)
        if phase == "awaiting":  # the card is withdrawn unless the wait shows a start (a started marker: spent)
            return _expired_awaiting(home, draft_id, task, key, owner, marker_path, "ttl", True)
        return _not_placed(home, draft_id, task, owner, marker_path, "expired", "ttl", "expired")
    expires = _expires(record)
    quote_live = expires is not None and now < expires
    started_now = False
    late = False  # a spent grant past the quote (N5): confirm with the same draftId, the app answers
    if phase == "awaiting" and not quote_live:
        closed = _expired_awaiting(home, draft_id, task, key, owner, marker_path, "quote_expired", False)
        if closed is not None:
            return closed
        # Safe past the quote (push-time security review of ov#468 (2), review-a CLAIMS L20800): the merchant's
        # createOrder (Edge-City/forkicks dd0b8918 lib/orders.ts:33-44) locks the idempotency key, returns the EXISTING
        # order for it before any quote check, and answers a key with no order 409 "Quote expired" past expiresAt. So
        # this confirm can only return an order already placed for this draftId, never create one. The app's
        # confirmForKicks forwards it with idempotencyKey = draftId (agentvillage-app forkicks.ts ~:207-213).
        late = True
    elif phase == "awaiting":
        ap = approval_modules()  # approval_unavailable: the marker waits for the next pass
        waited = ap.wait(task)
        status = waited.status
        mine = [a for a in (waited.doc.get("actions") or []) if isinstance(a, dict) and a.get("action_key") == key]
        human = len(mine) == 1 and mine[0].get("state") == "granted"
        if waited.exit_code == 0 and status == "granted" and human:
            # Security review (2)+(3): the newest-draft check again, under the lock, as the last step before the start.
            reason, started = guarded_start(home, draft_id, lambda: ap.start(task, key, held))
            if reason == EXPIRED:  # the agent's confirm closed it past the quote and told the owner: no second word
                _drop(marker_path)
                return "refused_earlier"
            if reason is not None:
                return _refuse_older(home, draft_id, task, owner, marker_path, reason)
            started_now = True
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
            close_expired(home, draft_id, task)
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
        if late:  # the order may exist (the agent's start): no line; the agent's confirm of this draft recovers it
            return _finish(home, draft_id, task, owner, marker_path, "failed", "uncertain_quote_expired", None)
        if phase == "started":
            return _not_placed(home, draft_id, task, owner, marker_path, "failed", "not_installed", "failed")
        return "not_installed"
    if started_now or late:
        # Review-a ov#465 N2: the agent's confirm read `granted` before this start, then found the quote gone and
        # closed the draft (`expired`) and told the owner nothing was ordered: the spent grant is dropped, no confirm.
        # Review-a ov#468 N9: the late confirm (N5) checks it too, so a merchant clock behind the box's never places
        # an order after the agent's "nothing was ordered".
        if tombstone_code(home, draft_id) == EXPIRED:
            _drop(marker_path)
            return "refused_earlier"
    if started_now:
        # Security review (2): a prepare that landed between this pass's start and its confirm still wins (the
        # spent grant places nothing). A start from an earlier pass is an order in flight and keeps its confirm.
        reason = newest_reason(home, draft_id)
        if reason is not None:
            return _refuse_older(home, draft_id, task, owner, marker_path, reason, own_start=True)
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
