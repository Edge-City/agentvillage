"""Native Telegram referendum callbacks and tool-free preference prediction.

The Telegram adapter remains the only update owner.  This module adds one
pattern-scoped PTB callback handler to that adapter; it never starts polling or
registers a webhook.  The callback is forwarded as a closed event using the
existing per-tenant AV_EVENTS_TOKEN.  No vote tool is exposed to the model.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ._core import NO_REDIRECT_OPENER

CALLBACK_PATTERN = r"^rv1\.[A-Za-z0-9_-]{22}$"
CALLBACK_RE = re.compile(CALLBACK_PATTERN)
EVENT_TYPE = "referendum.telegram_callback@1"
TIMEOUT_S = 8.0


def _enabled() -> bool:
    return os.environ.get("AV_REFERENDUM_RUNTIME", "").strip() == "1"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _record_handler_capability() -> None:
    """Record that the running Telegram adapter actually installed our handler."""
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    target = home / "state" / "referendum-runtime-capability.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(f".tmp-{os.getpid()}")
    try:
        process_start_ticks = Path(f"/proc/{os.getpid()}/stat").read_text(encoding="utf-8").split()[21]
    except (OSError, IndexError):
        process_start_ticks = ""
    temporary.write_text(json.dumps({
        "version": 1,
        "callbackPattern": CALLBACK_PATTERN,
        "registeredAt": _iso_now(),
        "pid": os.getpid(),
        "processStartTicks": process_start_ticks,
    }, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, target)


def callback_event(update: Any) -> dict[str, Any]:
    cq = getattr(update, "callback_query", None)
    message = getattr(cq, "message", None)
    sender = getattr(cq, "from_user", None)
    chat = getattr(message, "chat", None)
    data = str(getattr(cq, "data", "") or "")
    if not CALLBACK_RE.fullmatch(data):
        raise ValueError("callback_invalid")
    values = {
        "callbackId": str(getattr(cq, "id", "") or ""),
        "updateId": getattr(update, "update_id", None),
        "telegramUserId": str(getattr(sender, "id", "") or ""),
        "chatId": str(getattr(chat, "id", "") or ""),
        "messageId": getattr(message, "message_id", None),
    }
    if (not values["callbackId"] or not isinstance(values["updateId"], int)
            or not values["telegramUserId"].isdigit() or not values["chatId"].lstrip("-").isdigit()
            or not isinstance(values["messageId"], int)):
        raise ValueError("callback_invalid")
    return {
        "type": EVENT_TYPE,
        "callbackToken": data[4:],
        **values,
        "occurredAt": _iso_now(),
    }


def _post(event: dict[str, Any]) -> tuple[bool, str]:
    base = os.environ.get("AV_REFERENDUM_RUNTIME_URL", "").strip().rstrip("/")
    token = os.environ.get("AV_EVENTS_TOKEN", "").strip()
    if not base or not token:
        return False, "referendum_unavailable"
    body = json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        base + "/v1/referendum-runtime/callbacks",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with NO_REDIRECT_OPENER.open(request, timeout=TIMEOUT_S) as response:
            payload = json.loads(response.read(4097).decode("utf-8"))
            return 200 <= int(response.status) < 300 and payload.get("recorded") is True, str(payload.get("message") or "Vote recorded")
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read(4097).decode("utf-8"))
        except Exception:  # noqa: BLE001
            payload = {}
        return False, str(payload.get("error") or "Could not record your vote. Please tap again.")
    except Exception:  # noqa: BLE001
        return False, "Could not record your vote. Please tap again."


async def _handle(update: Any, context: Any) -> None:  # noqa: ARG001
    cq = getattr(update, "callback_query", None)
    if cq is None:
        return
    if not _enabled():
        await cq.answer(text="Voting is unavailable here. Open Agent Village to vote.", show_alert=True)
        return
    try:
        event = callback_event(update)
        ok, message = await asyncio.to_thread(_post, event)
    except Exception:  # noqa: BLE001
        ok, message = False, "Could not record your vote. Please tap again."
    # Answering the native callback is the only Telegram action here.  It is a
    # direct consequence of the human tap, never callable as an agent tool.
    await cq.answer(text=message[:200], show_alert=not ok)


def register_telegram_callback(ctx: Any) -> bool:
    """Register only when explicitly enabled and Hermes exposes the 0.21.5 API."""
    if not _enabled():
        return False
    register = getattr(ctx, "register_telegram_handler", None)
    if not callable(register):
        raise RuntimeError("referendum_runtime_requires_hermes_0_21_5_platform_handlers")

    def factory(application: Any, adapter: Any) -> None:  # noqa: ARG001
        from telegram.ext import CallbackQueryHandler
        application.add_handler(CallbackQueryHandler(_handle, pattern=CALLBACK_PATTERN))
        _record_handler_capability()

    register(factory)
    return True


def canonical_content_hash(value: dict[str, Any]) -> str:
    ordered = [
        value["referendumId"], value["frozenAt"], value["question"], value.get("context", ""),
        [[item["optionId"], item["label"]] for item in value["options"]],
    ]
    return hashlib.sha256(json.dumps(ordered, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
