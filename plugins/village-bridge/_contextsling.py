"""Exact inline manual grants. Mirrored by contextsling-approval.js; no provider credentials."""
from __future__ import annotations
import fcntl
import hashlib
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from ._mini_apps import approval_modules, installed

# Runtime data ships beside this plugin, not in its excluded tests directory.
UNICODE_RULE = json.loads(Path(__file__).with_name("contextsling-unicode.json").read_text())
DEFAULT_IGNORABLE_RANGES = tuple(tuple(int(part, 16) for part in item.split("-")) for item in UNICODE_RULE["defaultIgnorableRanges"].split(","))

def in_ranges(cp, ranges):
    lo, hi = 0, len(ranges) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        parts = ranges[mid]
        if cp < parts[0]:
            hi = mid - 1
        elif cp > parts[-1]:
            lo = mid + 1
        else:
            return True
    return False

OPERATIONS = ("contextsling.publish", "contextsling.update", "contextsling.revoke")
MAX_PAYLOAD_BYTES = 16384
MAX_CARD_BYTES = 4096
MAX_ESCAPED_BYTES = 3000
DRAFT_WINDOW_MS = 3600000
CACHE_MAX_AGE_SECONDS = DRAFT_WINDOW_MS // 1000
OWNED_CACHE_NAME = re.compile(r"([A-Za-z0-9_-]{22,100})\.(json|tmp-[a-f0-9]{32})", re.ASCII)
CONTEXT_CEILING = "agentvillage/private"
APPROVE = "Approve this exact document action in the approvals bot, then retry the SAME operation and draftId on your next message. A tap alone does not dispatch. Do not prepare another draft to retry."

def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def closed(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("approval_card_invalid")

def text(value, empty=False):
    if not isinstance(value, str):
        raise ValueError("approval_card_invalid")
    for i, c in enumerate(value):
        selector = ord(c) in {0xFE0E, 0xFE0F} and i > 0 and in_ranges(ord(value[i - 1]), UNICODE_RULE["extendedPictographicRanges"])
        if in_ranges(ord(c), UNICODE_RULE["forbiddenRanges"]) or (in_ranges(ord(c), DEFAULT_IGNORABLE_RANGES) and not selector):
            raise ValueError("approval_card_invalid")
    # Exact Markdown lines may be blank; nonempty-required metadata needs visible content.
    if not empty and not any(in_ranges(ord(c), UNICODE_RULE["visibleRanges"]) for c in value):
        raise ValueError("approval_card_invalid")
    return json.dumps(value, ensure_ascii=False)

def jslen(value):
    return len(value.encode("utf-16-le")) // 2

def deadline(payload):
    return datetime.fromisoformat(payload["preview"]["expiresAt"].replace("Z", "+00:00"))

def validate_payload(payload):
    closed(payload, ["appId", "operation", "preview"])
    if payload["appId"] != "contextsling" or payload["operation"] not in OPERATIONS:
        raise ValueError("approval_card_invalid")
    p = payload["preview"]
    revoke, update = payload["operation"] == OPERATIONS[2], payload["operation"] == OPERATIONS[1]
    closed(p, ["appId", "draftId", "expiresAt", "connection"] + (["target"] if revoke else ["file", "target"] if update else ["file"]))
    if p["appId"] != "contextsling" or not isinstance(p["draftId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,100}", p["draftId"], re.ASCII) or type(p["connection"]) is not int or not 1 <= p["connection"] <= 9007199254740991:
        raise ValueError("approval_card_invalid")
    if not isinstance(p["expiresAt"], str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", p["expiresAt"]):
        raise ValueError("approval_card_invalid")
    try:
        deadline(payload)
    except ValueError as exc:
        raise ValueError("approval_card_invalid") from exc
    if revoke or update:
        closed(p["target"], ["bundleId", "title"] if revoke else ["bundleId", "expectedRevision"])
        text(p["target"]["bundleId"])
        field = "title" if revoke else "expectedRevision"
        if revoke:
            text(p["target"][field])
        elif type(p["target"][field]) is not int or not 1 <= p["target"][field] <= 9007199254740991:
            raise ValueError("approval_card_invalid")
        if jslen(p["target"]["bundleId"]) > 200 or (revoke and jslen(p["target"][field]) > 500):
            raise ValueError("approval_card_invalid")
    if not revoke:
        f = p["file"]
        closed(f, ["name", "bytes", "sha256", "lines", "finalNewline"])
        text(f["name"])
        if jslen(f["name"]) > 255 or not isinstance(f["lines"], list) or not f["lines"] or type(f["finalNewline"]) is not bool or type(f["bytes"]) is not int or not 0 <= f["bytes"] <= 9007199254740991 or not isinstance(f["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", f["sha256"]):
            raise ValueError("approval_card_invalid")
        for line in f["lines"]:
            text(line, True)
        body = ("\n".join(f["lines"]) + ("\n" if f["finalNewline"] else "")).encode("utf-8")
        if len(body) != f["bytes"] or hashlib.sha256(body).hexdigest() != f["sha256"]:
            raise ValueError("approval_card_invalid")
    if len(canonical(payload).encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ValueError("approval_card_invalid")
    return payload

def approval_summary(payload):
    validate_payload(payload)
    p, op = payload["preview"], payload["operation"].split(".")[1]
    if op == "revoke":
        card = ["Contextsling: revoke public link", f'Bundle: {text(p["target"]["title"])} ({text(p["target"]["bundleId"])})', "Revokes all revisions; copies already made are not recalled; restore only on contextsling.com."]
    else:
        card = [f"Contextsling: {op} 1 file to a public link", "Anyone with this link can read these files; copies cannot be recalled.", "It must not contain other residents' messages or details."]
        if op == "update":
            card.append(f'Replaces bundle {text(p["target"]["bundleId"])} at revision {p["target"]["expectedRevision"]}; earlier revisions stay readable until you revoke.')
        f = p["file"]
        card += [f'File: {text(f["name"])} ({f["bytes"]} bytes)'] + ["│ " + line for line in f["lines"]]
        card.append(f'Bytes: {f["bytes"]}; SHA256: {f["sha256"]}; final newline: {"yes" if f["finalNewline"] else "no"}')
    card.append(f'Valid until: {p["expiresAt"]} (UTC)')
    summary = "\n".join(card)
    escaped = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if len(summary.encode()) > MAX_CARD_BYTES or len(escaped.encode()) > MAX_ESCAPED_BYTES:
        raise ValueError("approval_card_too_long")
    return summary

def checked_payload(payload, draft_id, digest):
    validate_payload(payload)
    held = canonical(payload)
    if payload["preview"]["draftId"] != draft_id or hashlib.sha256(held.encode()).hexdigest() != digest:
        raise ValueError("approval_preview_unavailable")
    approval_summary(payload)
    return held

def cache_path(home, draft_id):
    if not isinstance(draft_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,100}", draft_id):
        raise ValueError("invalid_draft")
    path = home / "contextsling-drafts" / (draft_id + ".json")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("approval_preview_unavailable")
    return path

def write_record(path, record):
    data = canonical(record).encode()
    # No symlink following; mode and atomic replace preserve private local custody.
    temporary = path.with_suffix(".tmp-" + os.urandom(16).hex())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def save_preview(home, result, context, config):
    if not isinstance(result, dict) or result.get("error"):
        return
    held = checked_payload(result.get("approvalPayload"), result.get("draftId"), result.get("payloadHash"))
    payload = json.loads(held)
    if result.get("operation") != payload["operation"] or result.get("preview") != payload["preview"]:
        raise ValueError("approval_preview_unavailable")
    now = datetime.now(timezone.utc)
    if not 0 < (deadline(payload) - now).total_seconds() <= 3600:
        raise ValueError("contextsling_expired")
    path = cache_path(home, result["draftId"])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.stat().st_mode & 0o077:
        raise ValueError("approval_preview_unavailable")
    record = {"operation": payload["operation"], "draftId": result["draftId"], "payload": payload, "payloadHash": result["payloadHash"], "owner": config["ownerTelegramId"], "origin": config["origin"], "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"]}
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        previous = load_preview(home, result["draftId"], config)
        if previous.get("terminal") or previous["payloadHash"] != result["payloadHash"]:
            raise ValueError("approval_preview_unavailable")
        return
    with os.fdopen(fd, "wb") as handle:
        handle.write(canonical(record).encode())

def read_record(path, draft_id):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 20000 or info.st_mode & 0o077:
            raise ValueError("approval_preview_unavailable")
        record = json.load(handle)
    if (not isinstance(record, dict) or record.get("operation") not in OPERATIONS or record.get("draftId") != draft_id
            or not isinstance(record.get("owner"), str) or not isinstance(record.get("origin"), str)
            or not isinstance(record.get("payloadHash"), str) or not re.fullmatch(r"[a-f0-9]{64}", record["payloadHash"])):
        raise ValueError("approval_preview_unavailable")
    if not record.get("terminal"):
        checked_payload(record.get("payload"), draft_id, record.get("payloadHash"))
        if record["operation"] != record["payload"]["operation"]:
            raise ValueError("approval_preview_unavailable")
    return record

def load_record(home, draft_id):
    return read_record(cache_path(home, draft_id), draft_id)

def load_preview(home, draft_id, config):
    record = load_record(home, draft_id)
    if record["owner"] != config["ownerTelegramId"] or record["origin"] != config["origin"]:
        raise ValueError("approval_preview_unavailable")
    return record

def terminal(home, draft_id, record, code):
    safe = {k: record[k] for k in ("owner", "origin", "session", "message", "payloadHash", "operation", "draftId")}
    safe["terminal"] = code
    if record.get("taskId"):
        safe["taskId"] = record["taskId"]
    if record.get("pendingWithdrawal"):
        safe["pendingWithdrawal"] = True
    if record.get("pendingDecline"):
        safe["pendingDecline"] = True
    write_record(cache_path(home, draft_id), safe)

def expired(record):
    return datetime.now(timezone.utc) >= deadline(record["payload"])

def expire(home, draft_id, record, can_withdraw=True):
    task = record.get("taskId")
    record["pendingWithdrawal"] = bool(task)
    try:
        if task and can_withdraw:
            ap = approval_modules()
            status = ap.wait(task)
            if status.status in ("requested", "pending"):
                answer = ap.withdraw(task, "Contextsling draft expired")
                if answer.exit_code == 0 and answer.ok:
                    record["pendingWithdrawal"] = False
            else:
                # A structured CLI error is not evidence that the card is closed.
                closed_codes = {"granted": 0, "executed": 0, "rejected": 1, "revoked": 1,
                                "withdrawn": 1, "expired": 3, "void": 7,
                                "not-registered": 1, "nothing-to-wait-for": 0}
                if status.status in closed_codes and status.exit_code == closed_codes[status.status]:
                    record["pendingWithdrawal"] = False
    finally:
        # Byte deletion is local hygiene; authority to withdraw stays with the original owner.
        terminal(home, draft_id, record, "contextsling_expired")


def _authorize_action(home, record, draft_id):
    if record.get("terminal"):
        return None, {"error": record["terminal"], "retryable": False}
    if expired(record):
        expire(home, draft_id, record)
        return None, {"error": "contextsling_expired", "retryable": False, "instruction": "That draft expired; no further write will be dispatched. An earlier outcome may remain unconfirmed; recover this same draft before preparing another."}
    payload = record["payload"]
    held = checked_payload(payload, draft_id, record["payloadHash"])
    key = "marketplace.app.action:" + payload["operation"] + ":" + draft_id
    ap = approval_modules()
    # Never re-propose a pending or rejected draft: retain the first daemon task.
    task = record.get("taskId")
    if not task:
        answer = ap.propose("marketplace.app.action", key, approval_summary(payload), held)
        task = answer.doc.get("task")
        if not answer.ok or not isinstance(task, str) or not re.fullmatch(r"propose:[a-f0-9]{32}", task) or answer.doc.get("payload_hash") != record["payloadHash"] or answer.doc.get("decision") != "requested":
            return None, {"error": "approval_refused"}
        record["taskId"] = task
        write_record(cache_path(home, draft_id), record)
    proof = {"taskId": task, "payloadHash": record["payloadHash"], "payload": payload}
    granted = ap.wait(task)
    if granted.status in ("rejected", "revoked", "withdrawn", "expired", "void", "not-registered"):
        code = "contextsling_declined" if granted.status == "rejected" else "contextsling_approval_ended"
        if granted.status == "rejected":
            record["pendingDecline"] = True
        terminal(home, draft_id, record, code)
        return None, {"error": code, "retryable": False}
    if granted.exit_code != 0 or granted.status not in ("granted", "executed"):
        return None, {"error": "approval_required", "instruction": APPROVE}
    if expired(record):
        expire(home, draft_id, record)
        return None, {"error": "contextsling_expired", "retryable": False}
    if granted.status != "executed":
        started = ap.start(task, key, held)
        if not started.ok or started.doc.get("authorization") != "grant":
            return None, {"error": "approval_not_started"}
    return proof, None


def request_payload(op, args):
    """Only named operations and closed inputs, never a supplied proof or endpoint."""
    def keys(value, expected):
        if not isinstance(value, dict) or set(value) != set(expected):
            raise ValueError("invalid_arguments")
    if op in OPERATIONS:
        keys(args, ["operation", "draftId"])
        if not isinstance(args["draftId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,100}", args["draftId"]):
            raise ValueError("invalid_arguments")
    elif op == "contextsling.prepare":
        action = args.get("action")
        if action not in ("publish", "update", "revoke"):
            raise ValueError("invalid_arguments")
        keys(args, ["operation", "action"] + (["target"] if action == "revoke" else ["file", "target"] if action == "update" else ["file"]))
        if action != "revoke":
            f = args["file"]
            keys(f, ["name", "lines", "finalNewline"])
            # Build the same validation/renderer input without changing the original bytes.
            if not isinstance(f["lines"], list) or not all(isinstance(line, str) for line in f["lines"]):
                raise ValueError("invalid_arguments")
            for line in f["lines"]:
                text(line, True)
            if type(f["finalNewline"]) is not bool:
                raise ValueError("invalid_arguments")
            body = ("\n".join(f["lines"]) + ("\n" if f["finalNewline"] else "")).encode()
            file = {**f, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        preview = {"appId": "contextsling", "draftId": "a" * 22, "connection": 1, "expiresAt": "2099-01-01T00:00:00.000Z"}
        if action != "revoke":
            preview["file"] = file
        if action != "publish":
            preview["target"] = args["target"]
        approval_summary({"appId": "contextsling", "operation": "contextsling." + action, "preview": preview})
    elif op == "contextsling.usage":
        keys(args, ["operation"])
    elif op == "contextsling.list":
        if not isinstance(args, dict) or set(args) - {"operation", "limit", "cursor"}:
            raise ValueError("invalid_arguments")
        if "limit" in args and (type(args["limit"]) is not int or not 1 <= args["limit"] <= 25):
            raise ValueError("invalid_arguments")
        if "cursor" in args:
            if type(args["cursor"]) is not int or not 0 <= args["cursor"] <= 1000:
                raise ValueError("invalid_arguments")
    elif op in ("contextsling.manifest", "contextsling.read"):
        keys(args, ["operation", "bundleId", "revision"])
        text(args["bundleId"])
        if jslen(args["bundleId"]) > 200 or type(args["revision"]) is not int or not 1 <= args["revision"] <= 9007199254740991:
            raise ValueError("invalid_arguments")
    else:
        raise ValueError("invalid_arguments")
    return dict(args)


def cleanup_expired(home, config):
    """Bound every owned plaintext copy, including interrupted writes; no background dispatch."""
    folder = home / "contextsling-drafts"
    if any(path.is_symlink() for path in (folder, *folder.parents)) or not folder.is_dir():
        return
    for path in folder.iterdir():
        match = OWNED_CACHE_NAME.fullmatch(path.name)
        if not match:
            continue
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                continue
            draft_id, kind = match.groups()
            try:
                record = read_record(path, draft_id)
            except Exception:
                # A partial write has no usable authority. Preserve active fragments;
                # old recognized regular files are local custody, never daemon input.
                if datetime.now(timezone.utc).timestamp() - info.st_mtime >= CACHE_MAX_AGE_SECONDS:
                    path.unlink(missing_ok=True)
                continue
            if kind != "json":
                # A complete orphan's checked schema/bytes supplies its exact deadline.
                # Unexpired atomic writes stay untouched, regardless of cleanup turns.
                if ((not record.get("terminal") and expired(record)) or
                        (record.get("terminal") and datetime.now(timezone.utc).timestamp() - info.st_mtime >= CACHE_MAX_AGE_SECONDS)):
                    path.unlink(missing_ok=True)
                continue
            matching_owner = record["owner"] == config.get("ownerTelegramId") and record["origin"] == config.get("origin")
            if record.get("pendingWithdrawal") or (not record.get("terminal") and expired(record)):
                expire(home, draft_id, record, can_withdraw=matching_owner)
        except Exception:
            continue


def sync_declines(home, config, send):
    """Native-only restrictive cancellation: never sends proof or dispatches provider effects."""
    folder = home / "contextsling-drafts"
    if any(path.is_symlink() for path in (folder, *folder.parents)) or not folder.is_dir():
        return
    for path in folder.glob("*.json"):
        try:
            record = load_preview(home, path.stem, config)
            if record.get("terminal") != "contextsling_declined" or not record.get("pendingDecline"):
                continue
            if not installed(home, "contextsling", record["operation"]):
                continue
            result = send(config, {"operation": record["operation"], "draftId": record["draftId"], "declined": True})
            acknowledged = (isinstance(result, dict) and result.get("kind") == "contextsling.write" and result.get("state") == "declined"
                            and result.get("operation") == record["operation"] and result.get("draftId") == record["draftId"])
            # Only this restrictive cancellation path may treat a trusted closed
            # expired response as settled: no staged row/body remains to cancel.
            absent = isinstance(result, dict) and set(result) == {"error"} and result["error"] == "contextsling_expired"
            if acknowledged or absent:
                record.pop("pendingDecline", None)
                write_record(path, record)
        except Exception:
            # Terminal locally throughout uncertainty; the same cancellation can retry.
            continue


TERMINAL_CODES = frozenset({"contextsling_expired", "contextsling_declined", "contextsling_connection_changed", "contextsling_not_connected", "contextsling_reconnect_required", "contextsling_pairing_changed"})
PREPARE_ERRORS = {
    "contextsling_approval_card_too_long": "The inline card is too long. Ask for a smaller document; no draft was published.",
    "contextsling_invalid": "These staging arguments were refused. Correct the explicit file or target and prepare again only at the resident's request.",
    "contextsling_stale_revision": "The target revision changed. Read its current manifest before preparing a new update.",
    "contextsling_target_changed": "The target changed. Read its current manifest before preparing a new action.",
}
ERROR_CODES = TERMINAL_CODES | set(PREPARE_ERRORS) | {"contextsling_unconfirmed", "contextsling_in_progress", "contextsling_approval_required", "approval_card_too_long", "approval_card_invalid"}

def response(home, op, result, record=None, draft_id=None):
    """Upstream errors never become instructions; a receipt alone proves completion."""
    if not isinstance(result, dict):
        return {"error": "contextsling_unconfirmed"}
    if result.get("error"):
        code = result["error"]
        if not isinstance(code, str) or code not in ERROR_CODES:
            code = "contextsling_unconfirmed"
        if op == "contextsling.prepare" and code in PREPARE_ERRORS:
            return {"error": code, "retryable": False, "instruction": PREPARE_ERRORS[code]}
        if record and code in TERMINAL_CODES:
            terminal(home, draft_id, record, code)
            if code in {"contextsling_connection_changed", "contextsling_not_connected", "contextsling_reconnect_required", "contextsling_pairing_changed"}:
                for path in cache_path(home, draft_id).parent.glob("*.json"):
                    try:
                        other = load_preview(home, path.stem, {"ownerTelegramId": record["owner"], "origin": record["origin"]})
                        if not other.get("terminal"):
                            terminal(home, path.stem, other, code)
                    except Exception:
                        continue
        return {"error": code, "retryable": code not in TERMINAL_CODES,
                "instruction": "Do not claim success. Recover the SAME operation and draftId, including after expiry; recovery cannot dispatch a new write. Never prepare another draft to resolve an uncertain write."}
    if op in OPERATIONS:
        if result.get("kind") != "contextsling.write" or result.get("state") != "confirmed" or result.get("operation") != op or result.get("draftId") != draft_id or not isinstance(result.get("bundleId"), str):
            return {"error": "contextsling_unconfirmed"}
        terminal(home, draft_id, record, "contextsling_completed")
    return result


def authorize_action(home, record, draft_id):
    """Serialize task persistence so concurrent turns cannot re-propose a declined draft."""
    path = cache_path(home, draft_id).with_suffix(".lock")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("approval_preview_unavailable")
        fcntl.flock(handle, fcntl.LOCK_EX)
        current = load_preview(home, draft_id, {"ownerTelegramId": record["owner"], "origin": record["origin"]})
        record.clear()
        record.update(current)
        return _authorize_action(home, record, draft_id)
