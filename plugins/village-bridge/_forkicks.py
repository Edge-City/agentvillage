"""Persist server previews, not model-supplied purchase proofs. The app/CP are authority."""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import unicodedata
from pathlib import Path
from ._mini_apps import approval_modules, ORDER_APPROVE_IN_BOT

MAX_PAYLOAD_BYTES = 60000
SUMMARY_MAX_BYTES = 4096
# Telegram technical cards reserve the rest of a 3600-character segment for labels.
SUMMARY_HTML_MAX_BYTES = 3000

def approval_summary(payload):
    """Mirrored by CP forkicksSummary; never shorten the order the human approves."""
    def text(value, allow_empty=False):
        if not isinstance(value, str) or (not allow_empty and not value.strip()) or any(unicodedata.category(c) in {"Cc", "Cf", "Cs", "Zl", "Zp"} for c in value):
            raise ValueError("approval_card_invalid")
        return json.dumps(value, ensure_ascii=False)

    def money(value):
        if type(value) is not int or not 0 <= value <= 1000000000:
            raise ValueError("approval_card_invalid")
        return str(value)

    try:
        p = payload["preview"]
        quote, fulfilment = p["quote"], p["fulfilment"]
        lines, items = quote["lines"], p["items"]
        if not isinstance(lines, list) or not lines or len(lines) != len(items):
            raise ValueError("approval_card_invalid")
        card = ["For Kicks order"]
        for line, item in zip(lines, items):
            qty = line["qty"]
            if type(qty) is not int or not 1 <= qty <= 1000000000 or qty != item["qty"] or not isinstance(line["options"], list):
                raise ValueError("approval_card_invalid")
            options = ", ".join(text(option) for option in line["options"]) or "none"
            card.append(f'{qty} × {text(line["name"])}; options: {options}; unit ₹{money(line["unitInr"])}; line ₹{money(line["lineInr"])}')
        card.append("Total: ₹" + money(quote["totalInr"]))
        kind = fulfilment["type"]
        if kind not in ("pickup", "delivery"):
            raise ValueError("approval_card_invalid")
        location = quote["location"]
        card.append("Fulfilment: " + kind)
        card.append(f'Location: {text(location["name"])} ({text(fulfilment["locationId"])}); address: {text(location["address"])}')
        date = fulfilment.get("date") or location["opens"][:10]
        if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date, flags=re.ASCII):
            raise ValueError("approval_card_invalid")
        card.append("Date (IST): " + date)
        if kind == "delivery":
            card.append("Delivery address: " + text(fulfilment["deliveryAddress"]))
        method = p["paymentMethod"]
        if method not in ("upi", "card_on_pickup"):
            raise ValueError("approval_card_invalid")
        card.append("Payment: " + ("UPI" if method == "upi" else "Card at pickup (honor system)") + "; if simulated: Test payment, no money moved")
        card.append("Café display name: " + text(p["displayName"]))
        if "note" in p:
            card.append("Note: " + text(p["note"], allow_empty=True))
        summary = "\n".join(card)
        escaped = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if len(summary.encode("utf-8")) > SUMMARY_MAX_BYTES or len(escaped.encode("utf-8")) > SUMMARY_HTML_MAX_BYTES:
            raise ValueError("approval_card_too_long")
        return summary
    except (KeyError, TypeError, IndexError, AttributeError) as error:
        raise ValueError("approval_card_invalid") from error

def canonical(payload):
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def checked_payload(payload, draft_id, expected_hash):
    if not isinstance(payload, dict) or set(payload) != {"appId", "operation", "preview"} or payload["appId"] != "forkicks" or payload["operation"] != "forkicks.order.confirm":
        raise ValueError("approval_preview_unavailable")
    preview = payload["preview"]
    keys = {"appId", "draftId", "quote", "displayName", "items", "fulfilment", "paymentMethod"}
    if not isinstance(preview, dict) or set(preview) not in (keys, keys | {"note"}) or preview["appId"] != "forkicks" or preview["draftId"] != draft_id:
        raise ValueError("approval_preview_unavailable")
    held = canonical(payload)
    if len(held.encode("utf-8")) > MAX_PAYLOAD_BYTES or hashlib.sha256(held.encode("utf-8")).hexdigest() != expected_hash:
        raise ValueError("approval_preview_unavailable")
    return held

def cache_path(home: Path, draft_id):
    if not isinstance(draft_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", draft_id):
        raise ValueError("invalid_draft")
    folder = home / "forkicks-drafts"
    path = folder / (draft_id + ".json")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("approval_preview_unavailable")
    return path

def save_preview(home, result, context, config):
    if not isinstance(result, dict) or result.get("error") or not result.get("draftId"):
        return  # A refused quote has no draft and cannot be confirmed.
    held = checked_payload(result.get("approvalPayload"), result["draftId"], result.get("payloadHash"))
    path = cache_path(home, result["draftId"])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = {"payload": json.loads(held), "payloadHash": result["payloadHash"], "owner": config["ownerTelegramId"],
              "origin": config["origin"], "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"]}
    data = canonical(record).encode("utf-8")
    # O_EXCL keeps the first immutable preview/turn across retries; a prepare replay cannot move its consent boundary.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        previous = load_preview(home, result["draftId"], config)
        if previous["payloadHash"] != result["payloadHash"]:
            raise ValueError("approval_preview_unavailable")
        return
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)

def load_preview(home, draft_id, config):
    path = cache_path(home, draft_id)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
            raise ValueError("approval_preview_unavailable")
        record = json.load(handle)
    if record.get("owner") != config["ownerTelegramId"] or record.get("origin") != config["origin"]:
        raise ValueError("approval_preview_unavailable")
    checked_payload(record.get("payload"), draft_id, record.get("payloadHash"))
    return record

def authorize_order(record, draft_id):
    payload = record["payload"]
    held = checked_payload(payload, draft_id, record["payloadHash"])
    key = "marketplace.app.action:forkicks.order.confirm:" + draft_id
    try:
        summary = approval_summary(payload)
    except ValueError as error:
        return None, {"error": str(error)}
    ap = approval_modules()
    answer = ap.propose("marketplace.app.action", key, summary, held)
    task = answer.doc.get("task")
    # Purchases ALWAYS require a human grant, even when Gold Stars uses autonomous policy.
    if not answer.ok or not isinstance(task, str) or not re.fullmatch(r"propose:[a-f0-9]{32}", task) or answer.doc.get("payload_hash") != record["payloadHash"] or answer.doc.get("decision") != "requested":
        return None, {"error": "approval_refused"}
    proof = {"taskId": task, "payloadHash": record["payloadHash"], "payload": payload}
    if answer.doc.get("state") == "executed":
        return proof, None  # The CP re-reads the direct grant/start; same draft is merchant-idempotent.
    granted = ap.wait(task)
    if granted.exit_code != 0 or granted.status != "granted":
        return None, {"error": "approval_required", "instruction": ORDER_APPROVE_IN_BOT}
    started = ap.start(task, key, held)
    if not started.ok or started.doc.get("authorization") != "grant":
        return None, {"error": "approval_not_started"}
    return proof, None
