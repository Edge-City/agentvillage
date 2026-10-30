"""The ONE generic approval card (mini-apps v2 Phase 1 item 6): any catalog app's `needs-card` operation gets the For
Kicks minimal card, four plain strings, then the For Kicks authorize path generalised.

Contract (CARD-COMMON; cp#352 context-card-cp; design MINIAPPS-PLATFORM-v2 section 3). Spec + golden vectors in
tests/vectors/mini-app-card.{md,json} (byte-identical copies in the app and the control plane).

- The four strings: `card_fields(declaration, preview, request=None)`, the cp's cardFields twin; the fit rule is For
  Kicks' own `card_value_fits` (imported, never copied), with NO line break in any of the four. A string that does not
  fit is refused, never cut, and a generic app has no technical-card fallback: nothing runs.
- Class and key (CARD-COMMON item 3): the parent `marketplace.app.action` is autonomous for everyone, so a needs-card op
  proposes under its MEMBER class `marketplace.app.action.<operation>` (the operation's full name; its first segment is
  the app id: the gold-stars.send member row's shape) with key `<class>:<draftId>`, payload = the four strings, summary =
  `What: ..\nTotal: ..\nWhen & where: ..\nShared with: ..` (the cp checks those bytes). The decision must be
  `requested`; `autonomous` (no member row yet) is refused `approval_card_unpinned` and nothing runs.
- The draft cache: `$HERMES_HOME/mini-apps/drafts/<appId>/<draftId>.json`, 0600, O_EXCL, owner + origin + hash, no links;
  the app's preview (carrying the platform keys appId, operation, draftId) is kept and sent BESIDE the payload on
  confirm, as For Kicks' flat card does.
- How the box learns the card op and its card: the cp's projection entry for a GENERIC app carries `approval: {prepare,
  card, fields: {item, total, when, shared}, bind}` (cp#352; `_mini_apps.projection` checks its shape). The box
  re-derives the four strings from the app's preview with that declaration and refuses any difference
  (`approval_card_invalid`), exactly as For Kicks does; the cp's re-derivation at request() is the second check, never
  the only one. No declaration (or no `approval`): `approval_card_undeclared`, never proposed (fail closed).
- Every For Kicks per-value rule applies to EACH of the four strings (imported): not empty or spaces only, no fake line
  mark (`card_name_fakes_line`), `card_value_fits` (<= 278 code points, refused characters, <= 2 combining marks), no
  newline (CARD-COMMON amendment 14:00Z).

For Kicks' module (`_forkicks.py`, `_forkicks_grant.py`) is not changed by this train.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import unicodedata
from pathlib import Path

from ._forkicks import (CARD_VALUE_MAX, SUMMARY_HTML_MAX_BYTES, SUMMARY_MAX_BYTES, canonical, card_name_fakes_line,
                        card_value_fits)
from ._mini_apps import APPROVALS_CHAT_LINE, approval_modules, projection

PARENT_CLASS = "marketplace.app.action"
SHOWN = ("item", "total", "when", "shared")
CARD_KEYS = frozenset(SHOWN)
DECLARATION_KEYS = frozenset((*SHOWN, "bind"))
SEGMENT = r"[A-Za-z_][A-Za-z0-9_]{0,63}"
PATH = re.compile(SEGMENT + r"(?:\." + SEGMENT + r"){0,7}")
SEGMENT_RE = re.compile(SEGMENT)
#: The preview's platform keys: bound by the approval key itself; never shown or bound by a declaration, skipped by
#: the shown-or-bound walk (the cp's CARD_PLATFORM_KEYS).
RESERVED = frozenset({"appId", "draftId", "operation"})
BIND_MAX = 32
#: The cp's CARD_DEPTH_MAX: a value at this depth that is not shown or bound is refused whole.
DEPTH_MAX = 8
PREVIEW_MAX_BYTES = 65536
#: The four rows' labels in the propose summary (approval L19771). The card's own row labels are the cp template's say entry.
LABELS = {"item": "What", "total": "Total", "when": "When & where", "shared": "Shared with"}
CARD_ERRORS = frozenset({"approval_card_invalid", "approval_card_not_minimal", "approval_card_too_long", "approval_card_undeclared"})

APP_ID = re.compile(r"[a-z][a-z0-9-]{0,39}")
OPERATION = re.compile(r"[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}")
DRAFT_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
TASK = re.compile(r"propose:[a-f0-9]{32}")
HASH = re.compile(r"[0-9a-f]{64}")
#: Apps with their own reviewed path in this overlay: never routed through the generic card (they flip in a later PR).
REVIEWED_APPS = frozenset({"gold-stars", "forkicks", "zzzbot", "slopfolio", "dreamstarter", "kismet", "library", "favorloop", "mini-app"})
MAX_PAYLOAD_BYTES = 60000
RECORD_MAX_BYTES = 131072

# ---- product owns the words ------------------------------------------------------------------------------------------
# Every resident-facing line and agent-facing instruction of the generic card, in one place. Lines are filled only from
# the projection's app name and the app's confirm answer (`receipt.summary`), never from agent text.
APP_NAME_FALLBACK = "mini-app"
PLACED_LINE = "Approved: your {appName} action is placed."
PLACED_LINE_RECEIPT = "Approved: your {appName} action is placed: {receipt}."
NOT_PLACED_LINE = "Your {appName} action wasn't placed: {reason}."
REASONS = {
    "denied": "the approval was declined",
    "withdrawn": "the approval request was withdrawn",
    "expired": "the approval or the draft expired",
    "failed": "the app couldn't take it",
}
ACTION_APPROVE_IN_BOT = ("Ask the owner to approve this exact action on its card in the approvals bot, then retry the same "
                         "operation with this SAME draftId. Never prepare another draft to retry an uncertain confirm."
                         + APPROVALS_CHAT_LINE)
ACTION_PLACED_ON_APPROVAL = ("The approval card for this exact action is in the owner's approvals bot. Tell the owner: "
                             "\"I'll do it as soon as you approve.\"" + APPROVALS_CHAT_LINE + " When they approve, it runs "
                             "automatically and they get a message in this chat; never ask them to approve or confirm here, "
                             "and never claim it was done before a receipt. If they ask later, retry the same operation with "
                             "this SAME draftId; never prepare another draft.")
ACTION_UNPINNED = ("This action has no approval card set up yet, so it cannot run. Nothing was done. Tell the owner the app "
                   "is not ready for this yet; never retry it or work around it.")
ACTION_CARD_REFUSED = ("This draft cannot be shown whole on a plain approval card, so it cannot be confirmed. Nothing was "
                       "done. Tell the owner; do not retry it or prepare it again in another form.")
ACTION_UNDECLARED = ("This app has no approval card for that action, so it cannot run here. Nothing was sent. Do not retry "
                     "it; tell the owner the app does not support it yet.")
ACTION_UNCLEAR = ("Do not claim it was done. To retry a confirm, use the SAME draftId; never prepare another draft after an "
                  "uncertain confirm.")
ACTION_CONFIRMATION_REQUIRED = "Show the exact saved preview and wait for a new owner reply confirming it."
ACTION_CONFIRM_IN_PROGRESS = ("That action is already being confirmed. Wait about two minutes, then confirm the SAME draft "
                              "again: if it went through you get the same receipt. Never prepare a new draft for it.")
# ---- end of product's words ------------------------------------------------------------------------------------------


def member_class(operation: str) -> str:
    return PARENT_CLASS + "." + operation


def action_key(operation: str, draft_id: str) -> str:
    return member_class(operation) + ":" + draft_id


# ---- the four strings --------------------------------------------------------------------------------------------------


def _segments(path):
    return tuple(path.split("."))


def _check_declaration(declaration):
    """The declaration's shown paths (in SHOWN order) and bind pairs, as segment tuples; or a card error."""
    if declaration is None:
        raise ValueError("approval_card_undeclared")
    if not isinstance(declaration, dict) or set(declaration) != DECLARATION_KEYS:
        raise ValueError("approval_card_invalid")
    shown = []
    for key in SHOWN:
        path = declaration[key]
        if not isinstance(path, str) or not PATH.fullmatch(path):
            raise ValueError("approval_card_invalid")
        shown.append(_segments(path))
    bind = declaration["bind"]
    if not isinstance(bind, list) or len(bind) > BIND_MAX:
        raise ValueError("approval_card_invalid")
    pairs = []
    for pair in bind:
        if (not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(p, str) and PATH.fullmatch(p) for p in pair)):
            raise ValueError("approval_card_invalid")
        pairs.append((_segments(pair[0]), _segments(pair[1])))
    for path in (*shown, *(previewPath for _, previewPath in pairs)):
        if path[0] in RESERVED:
            raise ValueError("approval_card_invalid")
    for i, a in enumerate(shown):
        for b in shown[i + 1:]:
            if a[:len(b)] == b or b[:len(a)] == a:  # equal, or one under the other
                raise ValueError("approval_card_invalid")
    return shown, pairs


_MISSING = object()


def _resolve(value, path):
    for segment in path:
        if not isinstance(value, dict) or segment not in value:
            return _MISSING
        value = value[segment]
    return value


def _unshown(value, at, shown, bound, depth):
    """The cp's walk: a path that is neither one of the four shown paths nor a bound preview path (whose whole subtree
    it covers) is refused when it is a leaf (not a non-empty object) or DEPTH_MAX deep; keys must be path segments."""
    if at in shown or at in bound:
        return False
    if depth >= DEPTH_MAX or not isinstance(value, dict) or not value:
        return True
    return any(not isinstance(key, str) or not SEGMENT_RE.fullmatch(key) or _unshown(child, at + "." + key, shown, bound, depth + 1)
               for key, child in value.items())


def card_fields(declaration, preview, request=None):
    """The four strings of the generic minimal card {item, total, when, shared}, or ValueError(<card code>).
    `request` (the prepare op's arguments) checks every bind pair; the control plane, which has none, passes None.
    Mirrored by the cp's cardFields and the app's drafts.ts cardFields; check order and codes:
    tests/vectors/mini-app-card.md. The summary budget is `card_summary`'s, checked apart (as the cp does)."""
    shown_paths, pairs = _check_declaration(declaration)
    if not isinstance(preview, dict):
        raise ValueError("approval_card_invalid")
    shown = {".".join(path) for path in shown_paths}
    bound = {".".join(preview_path) for _, preview_path in pairs}
    for key, value in preview.items():
        if key in RESERVED:
            continue
        if not isinstance(key, str) or not SEGMENT_RE.fullmatch(key) or _unshown(value, key, shown, bound, 1):
            raise ValueError("approval_card_invalid")
    fields = {}
    for key, path in zip(SHOWN, shown_paths):
        value = _resolve(preview, path)
        if not isinstance(value, str):
            raise ValueError("approval_card_invalid")
        fields[key] = value
    if request is not None:
        for request_path, preview_path in pairs:
            bound_value = _resolve(preview, preview_path)
            sent = _resolve(request, request_path) if isinstance(request, dict) else _MISSING
            if bound_value is _MISSING or sent is _MISSING or canonical(sent) != canonical(bound_value):
                raise ValueError("approval_card_invalid")
    if not all(value_fits(fields[key]) for key in SHOWN):
        raise ValueError("approval_card_not_minimal")
    return fields


def value_fits(value):
    """For Kicks' per-value rules, for each of the four strings: drawn whole and unmarked by core's minimal card
    (`card_value_fits`, with no line break: no row carries lines), not blank, and no character that draws like core's
    line mark after NFKC (`card_name_fakes_line`)."""
    return isinstance(value, str) and card_value_fits(value) and bool(value.strip(" ")) and not card_name_fakes_line(value)


def card_summary(fields):
    """The text the box proposes beside the payload (the technical card's Full details), within For Kicks' budget."""
    summary = "\n".join(f"{LABELS[key]}: {fields[key]}" for key in SHOWN)
    escaped = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if len(summary.encode("utf-8")) > SUMMARY_MAX_BYTES or len(escaped.encode("utf-8")) > SUMMARY_HTML_MAX_BYTES:
        raise ValueError("approval_card_too_long")
    return summary


def unframe(result, app_id, operation):
    """The app's answer inside the dispatcher's frame `{kind: "mini-app", appId, operation, asOf, result}` (design 2.1.5),
    or the answer itself when unframed. A frame naming another app or operation is refused."""
    if isinstance(result, dict) and result.get("kind") == "mini-app":
        if result.get("appId") != app_id or result.get("operation") != operation or not isinstance(result.get("result"), dict):
            return {"error": "mini_app_frame_mismatch"}
        return result["result"]
    return result


def payload_hash(fields) -> str:
    return hashlib.sha256(canonical(fields).encode("utf-8")).hexdigest()


def fits(payload):
    """The four-string payload, each drawn whole and unmarked on the minimal card, within the summary budget."""
    if not isinstance(payload, dict) or set(payload) != CARD_KEYS or not all(isinstance(payload[key], str) for key in SHOWN):
        raise ValueError("approval_preview_unavailable")
    if not all(value_fits(payload[key]) for key in SHOWN):
        raise ValueError("approval_card_not_minimal")
    return card_summary(payload)


def checked_payload(payload, expected_hash, preview, app_id, operation, draft_id, declaration, request=None):
    """The app's four-string payload, checked; the canonical bytes the daemon holds. The preview is the app's own, with
    the platform keys naming this app, needs-card op and draft; the strings are re-derived from it with the projection's
    declaration and refused on any difference. No declaration: `approval_card_undeclared` (fail closed)."""
    if declaration is None:
        raise ValueError("approval_card_undeclared")
    fits(payload)
    if (not isinstance(preview, dict) or preview.get("appId") != app_id or preview.get("operation") != operation
            or preview.get("draftId") != draft_id or len(canonical(preview).encode("utf-8")) > PREVIEW_MAX_BYTES):
        raise ValueError("approval_preview_unavailable")
    if card_fields(declaration, preview, request) != payload:
        raise ValueError("approval_card_invalid")
    held = canonical(payload)
    if (not isinstance(expected_hash, str) or not HASH.fullmatch(expected_hash) or len(held.encode("utf-8")) > MAX_PAYLOAD_BYTES
            or hashlib.sha256(held.encode("utf-8")).hexdigest() != expected_hash):
        raise ValueError("approval_preview_unavailable")
    return held


# ---- the projection: how the box learns the card op -------------------------------------------------------


def projected_app(home: Path, app_id: str):
    """The validated projection's entry for a GENERIC app (`_mini_apps.projection`), or None."""
    if not isinstance(app_id, str) or not APP_ID.fullmatch(app_id) or app_id in REVIEWED_APPS:
        return None
    apps = projection(home)
    found = [app for app in apps or () if app.get("id") == app_id]
    return found[0] if len(found) == 1 else None


def operation_record(app, operation):
    """`{name, class, prepare?}` for the entry's declared prepare or needs-card op (its `approval`), or None."""
    approval = app.get("approval") if isinstance(app, dict) else None
    if not isinstance(approval, dict) or operation not in app.get("operations", ()):
        return None
    if operation == approval.get("prepare"):
        return {"name": operation, "class": "prepare"}
    if operation == approval.get("card"):
        record = {"name": operation, "class": "needs-card", "prepare": approval["prepare"]}
        if isinstance(approval.get("fields"), dict):  # the declaration (cp#352 commit 4); absent = undeclared
            record["card"] = {**approval["fields"], "bind": approval.get("bind")}
        return record
    return None


def projected_operation(home: Path, operation):
    """`(appId, entry, op record)` for a generic app's declared prepare / needs-card op, or None (no `approval` on the
    entry: every projection today)."""
    if not isinstance(operation, str) or not OPERATION.fullmatch(operation):
        return None
    app_id = operation.split(".", 1)[0]
    app = projected_app(home, app_id)
    record = operation_record(app, operation)
    return None if record is None else (app_id, app, record)


def card_operation_for(app, prepare):
    """The needs-card op whose prepare is this op (the entry's `approval`), or None."""
    approval = app.get("approval") if isinstance(app, dict) else None
    if not isinstance(approval, dict) or approval.get("prepare") != prepare:
        return None
    return operation_record(app, approval.get("card"))


def undeclared_confirm(home: Path, operation, args) -> bool:
    """A confirm-shaped call (`{operation, arguments: {draftId}}`) for an installed generic app whose entry declares no
    card op by that name: refused `approval_card_undeclared`, nothing proposed or sent."""
    if not isinstance(operation, str) or not OPERATION.fullmatch(operation) or not isinstance(args, dict):
        return False
    arguments = args.get("arguments")
    if set(args) != {"operation", "arguments"} or not isinstance(arguments, dict) or set(arguments) != {"draftId"} \
            or not isinstance(arguments["draftId"], str):
        return False
    return projected_app(home, operation.split(".", 1)[0]) is not None


def app_name(app):
    """The app's display name for the line (letters, digits, spaces and plain punctuation, at most 40), or the fallback."""
    name = app.get("name") if isinstance(app, dict) else None
    if isinstance(name, str):
        kept = " ".join("".join(ch for ch in name if ch.isalnum() or ch in " .'&-").split())
        if kept and len(kept) <= 40 and "media:" not in kept.lower():
            return kept
    return APP_NAME_FALLBACK


# ---- the draft cache ---------------------------------------------------------------------------------------------------


def drafts_root(home: Path) -> Path:
    return home / "mini-apps" / "drafts"


def cache_path(home: Path, app_id, draft_id):
    if not isinstance(app_id, str) or not APP_ID.fullmatch(app_id) or app_id in REVIEWED_APPS:
        raise ValueError("invalid_app")
    if not isinstance(draft_id, str) or not DRAFT_ID.fullmatch(draft_id):
        raise ValueError("invalid_draft")
    path = drafts_root(home) / app_id / (draft_id + ".json")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("approval_preview_unavailable")
    return path


def _expires_ok(value):
    return value is None or (isinstance(value, str) and len(value) <= 64)


def save_preview(home, app_id, prepare, card_op, result, request, context, config):
    """Save the app's prepare answer for its needs-card op once its payload is checked (`checked_payload`; with a
    declaration, re-derived and every bind checked against the request this box sent). O_EXCL: the first preview of a
    draft is immutable."""
    if not isinstance(result, dict) or result.get("error") or not result.get("draftId"):
        return None  # a refused prepare has no draft and cannot be confirmed
    draft_id = result["draftId"]
    declaration = card_op.get("card") if isinstance(card_op, dict) else None
    preview = result.get("preview")
    held = checked_payload(result.get("approvalPayload"), result.get("payloadHash"), preview, app_id, card_op["name"], draft_id,
                           declaration, request)
    if not _expires_ok(result.get("expiresAt")):
        raise ValueError("approval_preview_unavailable")
    path = cache_path(home, app_id, draft_id)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = {"appId": app_id, "prepare": prepare, "operation": card_op["name"], "payload": json.loads(held),
              "payloadHash": result["payloadHash"], "preview": preview, "request": request,
              "owner": config["ownerTelegramId"], "origin": config["origin"],
              "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"],
              **({"expiresAt": result["expiresAt"]} if result.get("expiresAt") is not None else {})}
    data = canonical(record).encode("utf-8")
    if len(data) > RECORD_MAX_BYTES:
        raise ValueError("approval_preview_unavailable")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        previous = load_preview(home, app_id, draft_id, config, card_op)
        if previous["payloadHash"] != result["payloadHash"]:
            raise ValueError("approval_preview_unavailable")
        return previous
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return record


def load_preview(home, app_id, draft_id, config, card_op):
    """A draft this box saved, for this owner and origin and this needs-card op, its payload checked again."""
    path = cache_path(home, app_id, draft_id)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > RECORD_MAX_BYTES:
            raise ValueError("approval_preview_unavailable")
        record = json.load(handle)
    if (not isinstance(record, dict) or record.get("owner") != config["ownerTelegramId"] or record.get("origin") != config["origin"]
            or record.get("appId") != app_id or not isinstance(card_op, dict) or record.get("operation") != card_op.get("name")
            or record.get("prepare") != card_op.get("prepare")):
        raise ValueError("approval_preview_unavailable")
    checked_payload(record.get("payload"), record.get("payloadHash"), record.get("preview"), app_id, card_op["name"], draft_id,
                    card_op.get("card"), record.get("request"))
    return record


# ---- authorize ---------------------------------------------------------------------------------------------------------


def authorize_action(record, app_id, operation, draft_id, declaration, on_requested=None):
    """`authorize_order` generalised: propose the op's member class with the four-string payload, require `requested`
    (a human card), read the decision once, start with `authorization: grant`. `(proof, None)` or `(None, refusal)`; the
    proof is `{taskId, payloadHash, payload, preview}` (the cp's generic body: the preview BESIDE the payload)."""
    if (not isinstance(record, dict) or record.get("appId") != app_id or record.get("operation") != operation
            or not isinstance(operation, str) or operation.split(".", 1)[0] != app_id):
        return None, {"error": "approval_preview_unavailable"}
    try:
        held = checked_payload(record.get("payload"), record.get("payloadHash"), record.get("preview"), app_id, operation, draft_id,
                               declaration, record.get("request"))
        summary = card_summary(record["payload"])
    except ValueError as error:
        return None, {"error": str(error)}
    key = action_key(operation, draft_id)
    ap = approval_modules()
    answer = ap.propose(member_class(operation), key, summary, held)
    task = answer.doc.get("task")
    if not answer.ok or not isinstance(task, str) or not TASK.fullmatch(task) or answer.doc.get("payload_hash") != record["payloadHash"]:
        return None, {"error": "approval_refused"}
    decision = answer.doc.get("decision")
    if decision == "autonomous":
        # No member row pins this op to ask: the parent class is autonomous, so a start here would spend money with no
        # card. Fail closed (CARD-COMMON item 3): nothing is started, nothing is sent to the app.
        return None, {"error": "approval_card_unpinned", "instruction": ACTION_UNPINNED}
    if decision != "requested":
        return None, {"error": "approval_refused"}
    proof = {"taskId": task, "payloadHash": record["payloadHash"], "payload": record["payload"], "preview": record["preview"]}
    if answer.doc.get("state") == "executed":
        return proof, None  # an earlier start of this draft: the cp re-reads the grant; the app replays its receipt
    granted = ap.wait(task)
    if granted.exit_code != 0 or granted.status != "granted":
        tracked = on_requested(task) if on_requested is not None and granted.exit_code == 6 else None
        return None, {"error": "approval_required", "instruction": tracked or ACTION_APPROVE_IN_BOT}
    started = ap.start(task, key, held)
    if not started.ok or started.doc.get("authorization") != "grant":
        return None, {"error": "approval_not_started"}
    return proof, None
