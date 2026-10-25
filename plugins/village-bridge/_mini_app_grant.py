"""Close the loop for the ONE generic approval card (approval L19757 gaps 3 + 4): `_forkicks_grant.py` generalised.

When `authorize_action` finds a needs-card op's card still waiting for its tap (wait exit 6), `track` writes
`mini-apps/drafts/<appId>/<draftId>.await` carrying the task, `appId` and `operation`. A pass on av-events' approval
poller (`_approval.register_pass`) then, per marker (newest first, at most MAX_PER_PASS):

1. Consent unchanged: acts only on `wait` = `granted` with this draft's member-class key `granted` (core's `grant` verb is
   human-only), then `start` must answer `authorization: grant`. A spent grant goes straight to confirm. Rejected /
   revoked / withdrawn / expired / void: the NOT_PLACED line, nothing runs. The pass never proposes.
2. One placer: the confirm is the marker's own needs-card `operation` with the SAME draftId, sent through `transport`
   once per pass; the first receipt is recorded once per draft in `<draftId>.placed` (O_EXCL), and the agent's later
   confirm of that draft answers that receipt and calls nothing. The app's lease (409 `mini_app_confirm_in_progress`)
   and idempotency key are the second guard.
3. Only drafts this box saved, for this owner and origin, re-checked against the op's declaration (`load_preview`).
4. The line: one of the product constants in `_mini_app_card` (the one place for the words), filled only from the
   projection's app name and ONE short receipt string from the app's confirm answer (`receipt.summary`, at most
   RECEIPT_MAX characters, cleaned as `_forkicks_grant._clean`), never agent text; sent only to the owner's own DM with
   Hermes's native sender, at most once per task (`<draftId>.line-<task>` O_EXCL claim).
5. Bounded: MAX_PER_PASS markers a pass, SCAN_LIMIT directory entries, TTL_S per marker.
6. Events: one per outcome with a code (`village-bridge:mini_app.action_outcome`), codes only.

Wake on decision: core 0.4.6 has NO push (approval L19771 (c)); the speed comes from ADAPTIVE polling instead: `busy()`
(any `.await` marker younger than its TTL) is registered with av-events (`_approval.register_busy`), which then runs every
pass every MIN_POLL_S (5 s) instead of AV_APPROVAL_POLL_S (30 s). `young_marker` is shared with For Kicks' markers.

Python 3.11, standard library only.
"""
from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime

from . import _mini_app_card as card
from ._forkicks_grant import _clean, _create, _drop, _read, _replace, _telegram_dm
from ._mini_apps import approval_modules

LOG = logging.getLogger("village_bridge")

PASS_NAME = "mini_app_actions"
TASK = re.compile(r"propose:[a-f0-9]{32}")
OWNER = re.compile(r"[1-9]\d{0,19}")
RECEIPT_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
RECEIPT_MAX = 120
MAX_PER_PASS = 8
SCAN_LIMIT = 2000
APP_SCAN_LIMIT = 64
TTL_S = 2 * 60 * 60
MAX_UNVERIFIED = 3
#: Markers whose `since` the busy probe reads per call (newest first).
BUSY_READS = 32
OUTCOMES = ("placed", "denied", "expired", "failed")

_EMIT = None


def set_emitter(emit) -> None:
    global _EMIT
    _EMIT = emit


def _event(outcome: str, code: str) -> None:
    payload = {"outcome": outcome, "code": code}
    LOG.info("village_bridge: mini_app_on_grant outcome=%s code=%s", outcome, code)
    if _EMIT is not None:
        try:
            _EMIT(payload)
        except Exception:  # noqa: BLE001 - an event never costs the outcome
            pass


# ---- markers ---------------------------------------------------------------------------------------


def _path(home, app_id, draft_id, suffix):
    base = card.cache_path(home, app_id, draft_id)  # validates both ids; refuses a linked folder or file
    path = base.with_name(draft_id + suffix)
    if path.is_symlink():
        raise ValueError("marker_invalid")
    return path


def track(home, app_id, operation, draft_id, task, now=None) -> bool:
    """The card for this draft waits for its tap: hand its task to the pass. The same task keeps its first time."""
    if not isinstance(task, str) or not TASK.fullmatch(task) or not isinstance(operation, str) or operation.split(".", 1)[0] != app_id:
        return False
    path = _path(home, app_id, draft_id, ".await")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    doc = {"task": task, "since": int(now if now is not None else time.time()), "phase": "awaiting", "unverified": 0,
           "appId": app_id, "operation": operation}
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
    """The app's receipt `{id, summary?, ...}` from an (unframed) confirm answer `{receipt, ...}`, or None."""
    receipt = result.get("receipt") if isinstance(result, dict) and "error" not in result else None
    if not isinstance(receipt, dict) or not isinstance(receipt.get("id"), str) or not RECEIPT_ID.fullmatch(receipt["id"]):
        return None
    return receipt


def placed(home, app_id, draft_id):
    try:
        doc = _read(_path(home, app_id, draft_id, ".placed"))
    except FileNotFoundError:
        return None
    if doc.get("by") not in ("pass", "agent") or receipt_of({"receipt": doc.get("receipt")}) is None:
        raise ValueError("marker_invalid")
    return doc


def record_placed(home, app_id, draft_id, receipt, by) -> bool:
    if receipt_of({"receipt": receipt}) is None:
        return False
    path = _path(home, app_id, draft_id, ".placed")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        return _create(path, {"by": by, "receipt": receipt})
    except ValueError:
        return False


# ---- the line ----------------------------------------------------------------------------------------


def placed_line(name, receipt) -> str:
    """The placed line: the app's name, and the app's own short receipt string when it is clean."""
    summary = _clean(receipt.get("summary"), RECEIPT_MAX) if isinstance(receipt, dict) else None
    if summary:
        return card.PLACED_LINE_RECEIPT.format(appName=name, receipt=summary.rstrip("."))
    return card.PLACED_LINE.format(appName=name)


def _deliver(home, app_id, draft_id, task, owner, text) -> str:
    if not isinstance(owner, str) or not OWNER.fullmatch(owner):
        return "line_owner_invalid"
    if not _create(_path(home, app_id, draft_id, ".line-" + task.split(":", 1)[1]), {"task": task}):
        return "line_already_sent"
    try:
        return "line_sent" if _telegram_dm(owner, text) else "line_failed"
    except Exception:  # noqa: BLE001 - at most once: a failed send is not retried
        return "line_failed"


# ---- the pass ----------------------------------------------------------------------------------------


def _expires(record):
    try:
        moment = datetime.fromisoformat(record["expiresAt"])
    except (KeyError, TypeError, ValueError):
        return None
    return moment.timestamp() if moment.tzinfo else None


def _awaiting(home, limit=MAX_PER_PASS):
    """(appId, draftId) of the newest `.await` markers under mini-apps/drafts/<appId>/."""
    root = card.drafts_root(home)
    if any(p.is_symlink() for p in (root, *root.parents)) or not root.is_dir():
        return []
    found, seen = [], 0
    with os.scandir(root) as apps:
        for index, app in enumerate(apps):
            if index >= APP_SCAN_LIMIT:
                break
            if not app.is_dir(follow_symlinks=False) or not card.APP_ID.fullmatch(app.name) or app.name in card.REVIEWED_APPS:
                continue
            with os.scandir(app.path) as entries:
                for entry in entries:
                    seen += 1
                    if seen > SCAN_LIMIT:
                        break
                    if entry.name.endswith(".await") and entry.is_file(follow_symlinks=False):
                        draft_id = entry.name[:-len(".await")]
                        if card.DRAFT_ID.fullmatch(draft_id):
                            found.append((entry.stat(follow_symlinks=False).st_mtime, app.name, draft_id))
    return [(app_id, draft_id) for _, app_id, draft_id in sorted(found, reverse=True)[:limit]]


def young_marker(folders, ttl_s, now=None, reads=BUSY_READS) -> bool:
    """Whether any `.await` marker in `folders` is younger than `ttl_s` (its own `since`), reading at most `reads`
    markers, newest first. The busy probe for adaptive polling, shared by the generic and For Kicks passes."""
    now = float(now if now is not None else time.time())
    found = []
    for folder in folders:
        try:
            if folder.is_symlink() or not folder.is_dir():
                continue
            with os.scandir(folder) as entries:
                for index, entry in enumerate(entries):
                    if index >= SCAN_LIMIT:
                        break
                    if entry.name.endswith(".await") and entry.is_file(follow_symlinks=False):
                        found.append((entry.stat(follow_symlinks=False).st_mtime, entry.path))
        except OSError:
            continue
    for _, path in sorted(found, reverse=True)[:reads]:
        try:
            since = _read(path).get("since")
        except Exception:  # noqa: BLE001 - an unreadable marker is not busy work
            continue
        if type(since) is int and now - since <= ttl_s:
            return True
    return False


def busy(home, now=None) -> bool:
    """Any generic `.await` marker younger than TTL_S."""
    root = card.drafts_root(home)
    try:
        if any(p.is_symlink() for p in (root, *root.parents)) or not root.is_dir():
            return False
        with os.scandir(root) as apps:
            folders = [root / app.name for index, app in enumerate(apps)
                       if index < APP_SCAN_LIMIT and app.is_dir(follow_symlinks=False) and card.APP_ID.fullmatch(app.name)]
    except OSError:
        return False
    return young_marker(folders, TTL_S, now)


def run_pass(home, config, transport, lookup, now=None) -> dict:
    """Advance at most MAX_PER_PASS awaited drafts once. `lookup(home, operation)` = `_mini_app_card.projected_operation`."""
    counts: dict = {}
    for app_id, draft_id in _awaiting(home):
        try:
            code = advance(home, config, transport, lookup, app_id, draft_id, now=now)
        except Exception as error:  # noqa: BLE001 - one draft never costs the others
            code = "error_" + type(error).__name__
        counts[code] = counts.get(code, 0) + 1
    if counts:
        LOG.info("village_bridge: mini_app_on_grant pass %s", " ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return counts


def _finish(home, app_id, draft_id, task, owner, marker_path, outcome, code, line):
    delivered = _deliver(home, app_id, draft_id, task, owner, line) if line is not None else None
    _event(outcome, code)
    _drop(marker_path)
    return outcome + ":" + code + ("" if delivered is None else ":" + delivered)


def _not_placed(home, app_id, draft_id, task, owner, marker_path, name, outcome, code, reason):
    line = card.NOT_PLACED_LINE.format(appName=name, reason=card.REASONS[reason])
    return _finish(home, app_id, draft_id, task, owner, marker_path, outcome, code, line)


def advance(home, config, transport, lookup, app_id, draft_id, now=None) -> str:
    now = float(now if now is not None else time.time())
    marker_path = _path(home, app_id, draft_id, ".await")
    try:
        marker = _read(marker_path)
    except FileNotFoundError:
        return "gone"
    task, since, phase, operation = marker.get("task"), marker.get("since"), marker.get("phase"), marker.get("operation")
    if (not isinstance(task, str) or not TASK.fullmatch(task) or type(since) is not int
            or phase not in ("awaiting", "started", "attempted") or marker.get("appId") != app_id
            or not isinstance(operation, str) or not card.OPERATION.fullmatch(operation) or operation.split(".", 1)[0] != app_id):
        _drop(marker_path)
        return "marker_invalid"
    owner = config.get("ownerTelegramId")
    projected = lookup(home, operation)
    entry = (projected[2] if projected is not None and projected[0] == app_id and projected[2].get("class") == "needs-card"
             and projected[2].get("card") is not None else None)  # no declaration: nothing may run (fail closed)
    name = card.app_name(projected[1]) if entry is not None else card.APP_NAME_FALLBACK
    done = placed(home, app_id, draft_id)
    if done is not None:
        if done["by"] == "pass":  # this pass placed it; a crash may have come before its line
            return _finish(home, app_id, draft_id, task, owner, marker_path, "placed", "on_grant", placed_line(name, done["receipt"]))
        return _finish(home, app_id, draft_id, task, owner, marker_path, "placed", "agent_retry", None)
    if entry is None:
        # The op is no longer projected as a needs-card op (uninstalled, or its card withdrawn): nothing may run.
        if phase == "awaiting" and now - since <= TTL_S:
            return "not_installed"  # the marker waits; a re-install within the TTL resumes it
        if phase == "attempted":
            return _finish(home, app_id, draft_id, task, owner, marker_path, "failed", "uncertain_not_installed", None)
        return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "failed", "not_installed", "failed")
    try:
        record = card.load_preview(home, app_id, draft_id, config, entry)
        held = card.checked_payload(record["payload"], record["payloadHash"], record.get("preview"), app_id, operation, draft_id,
                                    entry.get("card"), record.get("request"))
    except Exception:  # noqa: BLE001 - not this box's draft (or not this owner's, or no longer this card): ignored, no line
        _drop(marker_path)
        return "not_this_box"
    if now - since > TTL_S:
        if phase == "attempted":  # the action may have happened: no line; the agent's confirm of this draft recovers it
            return _finish(home, app_id, draft_id, task, owner, marker_path, "failed", "uncertain_ttl", None)
        return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "expired", "ttl", "expired")
    expires = _expires(record)
    live = expires is None or now < expires
    key = card.action_key(operation, draft_id)
    if phase == "awaiting":
        if not live:
            return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "expired", "draft_expired", "expired")
        ap = approval_modules()  # approval_unavailable: the marker waits for the next pass
        waited = ap.wait(task)
        status = waited.status
        mine = [a for a in (waited.doc.get("actions") or []) if isinstance(a, dict) and a.get("action_key") == key]
        human = len(mine) == 1 and mine[0].get("state") == "granted"
        if waited.exit_code == 0 and status == "granted" and human:
            started = ap.start(task, key, held)
            if not started.ok or started.doc.get("authorization") != "grant":
                return "start_refused"
        elif waited.exit_code == 0 and status in ("nothing-to-wait-for", "executed") and human:
            pass  # the grant was already spent by a start of this same task: confirm adopts it
        elif waited.exit_code == 6:
            return "pending"
        elif status in ("rejected", "revoked"):
            return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "denied", status, "denied")
        elif status == "withdrawn":
            return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "denied", "withdrawn", "withdrawn")
        elif waited.exit_code in (3, 7) or status in ("expired", "void"):
            return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "expired", status or "expired", "expired")
        elif waited.exit_code == 1:
            return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "failed", "not_registered", "failed")
        else:
            return "wait_unclear"
        phase = "started"
        _replace(marker_path, {**marker, "phase": phase})
    if phase == "started" and not live:
        return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "expired", "draft_expired", "expired")
    # Recorded BEFORE the confirm is sent: from here on a lost answer may be a placed action.
    _replace(marker_path, {**marker, "phase": "attempted"})
    proof = {"taskId": task, "payloadHash": record["payloadHash"], "payload": record["payload"], "preview": record["preview"]}
    try:
        result = card.unframe(transport(config, {"operation": operation, "arguments": {"draftId": draft_id}, "approval": proof},
                                        operation_class="needs-card"), app_id, operation)
    except Exception:  # noqa: BLE001 - no answer: retried next pass with the same draftId
        return "confirm_uncertain"
    receipt = receipt_of(result)
    if receipt is not None:
        if not record_placed(home, app_id, draft_id, receipt, "pass"):
            done = placed(home, app_id, draft_id)
            if done is not None and done["by"] == "agent":
                return _finish(home, app_id, draft_id, task, owner, marker_path, "placed", "agent_retry", None)
        return _finish(home, app_id, draft_id, task, owner, marker_path, "placed", "on_grant", placed_line(name, receipt))
    error = result.get("error") if isinstance(result, dict) else None
    status = result.get("status") if isinstance(result, dict) else None
    if error == "mini_app_confirm_in_progress":
        return "confirm_in_progress"
    if error == "mini_app_approval_required":
        unverified = marker.get("unverified") if type(marker.get("unverified")) is int else 0
        if unverified + 1 >= MAX_UNVERIFIED:
            return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "failed", "approval_not_verified", "failed")
        _replace(marker_path, {**marker, "phase": "attempted", "unverified": unverified + 1})
        return "approval_not_verified"
    if error == "mini_app_draft_expired":
        return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "expired", "draft_expired", "expired")
    if type(status) is int and 400 <= status < 500 and status != 429:
        # The app refused before any action could exist (its lease is released only then).
        return _not_placed(home, app_id, draft_id, task, owner, marker_path, name, "failed", "refused_" + str(status), "failed")
    return "confirm_uncertain"  # 5xx, 429, a 2xx without a receipt, or an unreadable answer: the same draftId next pass


def instruction_if_tracked(home, app_id, operation, draft_id, task, ensure) -> str | None:
    """`authorize_action`'s `on_requested`: track the task and make sure the pass runs; None when it cannot."""
    try:
        if ensure() and track(home, app_id, operation, draft_id, task):
            return card.ACTION_PLACED_ON_APPROVAL
    except Exception:  # noqa: BLE001 - the older instruction still works (the agent retries confirm)
        pass
    return None
