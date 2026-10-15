"""av-vote: record a referendum vote card tap in the chat (VOTE CALLBACK, rc42).

Carter, 15 Oct: "a resident taps a button on the vote card in Telegram and the vote is RECORDED IN
THE CHAT, with no browser and no sign-in."

The control plane sends the vote card through the resident's own agent bot. With its
``REFERENDUM_CARD_CALLBACK`` flag on, each option is a callback button whose data is

    avv:<optionIndex>:<token>

(the lanes' shared vote-callback contract): ``<token>`` is the app-signed,
per-resident, per-option vote token (base64url of ``0x01 || HMAC-SHA256``, 44 characters; 43 is
accepted too), so the whole value is ASCII and at most 51 bytes, inside Telegram's 64-byte
``callback_data`` limit. The referendum id does not fit; the app resolves it from the token. The
index is UX only: the token alone names the referendum, the resident and the option.

Wiring (Hermes v2026.9.24). ``ctx.register_platform_handler("telegram", factory)``
(``hermes_cli/plugins.py`` ``register_platform_handler``) queues the factory; the Telegram adapter's
``connect()`` calls ``_wire_plugin_handlers(app)`` BEFORE ``_register_handlers(app)``
(``plugins/platforms/telegram/adapter.py`` :3120-3121 and :3238-3239), and a factory wired late is
hoisted ahead of the core handlers (:2947). PTB dispatches the FIRST matching handler per group and
core registers an unscoped ``CallbackQueryHandler`` (:2938), so this handler is scoped with
``pattern=r"^avv:"``: every core button flow (``ea:`` exec approvals, ``cl:`` clarify, ``mp:``/``mpg:``
/``mm:``/``mc:``/``mb``/``mx``/``mg:`` model picker, ``cp:`` choice picker, ``sc:``, ``gt:``,
``update_prompt:``; :4706-4722) never reaches it and falls through to core.

On a tap:

1. Owner only. The tap must come from the box's own resident, in that resident's private chat with
   the bot (``message.chat.id == from_user.id``, ``chat.type == "private"`` when known). The resident
   is any of: the home channel the control plane writes after the pairing is approved
   (``platforms.telegram.home_channel``: its ``user_id`` and its positive ``chat_id``, from the adapter
   config), ``TELEGRAM_HOME_CHANNEL``, or a Telegram user in Hermes's approved pairings
   (``gateway.pairing.PairingStore().is_approved("telegram", id)``, the file
   ``$HERMES_HOME/platforms/pairing/telegram-approved.json``): the very list the control plane checks
   (``pairings.js`` ``isApproved``) before it sends the card to ``tenants.telegram_user_id``. The
   pairing read covers boxes whose home channel drifted from that id (an inherited env home, a
   ``/sethome`` elsewhere, a re-pair with another account). Anyone else: "This vote card is not yours".
2. ``POST <origin>/api/referenda/vote-token`` with ``{"token", "tenantId"}`` (``tenantId`` a hint only),
   10 s timeout, no redirects followed. ``<origin>`` is ``AV_APP_ORIGIN`` when it is an https
   ``edgecity.live`` origin, else ``https://agents.edgecity.live`` (the origin the other overlay
   plugins hardcode). The token is the only credential.
3. Success: answer "Recorded: <option label>" and rewrite the card's keyboard: the tapped option gets
   a leading check mark, every other ``avv:`` option loses it and stays tappable (the resident can
   change the vote before the close), every other button (the web row) is kept as it is.
4. Failure: a short answer ("Voting has closed." / "This vote button is no longer valid..." /
   "Could not record your vote...") and the card is left unchanged; the web row still works.

Non-blocking: the handler is registered with ``block=False``. Hermes builds its PTB Application with
the default update processor (one update at a time), so a blocking handler would hold every later
update (the resident's messages, exec-approval taps) for the length of the app call (up to 12 s).

Double taps: a second tap on the same card while the first is still being recorded is answered
"Still recording your vote..." and sends nothing; a tap after that goes to the app again, whose
record is idempotent (the same token again is the same vote). Logging: the tenant's first eight
characters and an outcome code, never the token, the callback data or the user id. Fail-open: any
exception answers the tap with an error and never reaches the gateway.

Not done here: a line into the live DM session. Injecting a synthetic message would start an agent
turn (a model call the resident did not ask for) through gateway internals; skipped for rc42.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

PREFIX = "avv:"
#: The PTB handler's pattern: scoped, so core callback flows fall through to Hermes.
HANDLER_PATTERN = r"^avv:"
CALLBACK_DATA = re.compile(r"^avv:(0|[1-9][0-9]?):([A-Za-z0-9_-]{43,44})$")
#: Telegram's limit on callback_data (bytes, UTF-8).
CALLBACK_DATA_MAX_BYTES = 64
#: Up to 12 options, 0-based.
MAX_OPTION_INDEX = 11
CHECK = "✅ "
TIMEOUT_S = 10.0
DEFAULT_ORIGIN = "https://agents.edgecity.live"
ORIGIN_ENV = "AV_APP_ORIGIN"
RECORD_PATH = "/api/referenda/vote-token"
HOME_CHANNEL_ENV = "TELEGRAM_HOME_CHANNEL"
TENANT_ENVS = ("AV_TENANT_ID", "TENANT_ID")
_TELEGRAM_USER = re.compile(r"[1-9][0-9]{0,19}")
_ALLOWED_HOST = re.compile(r"(?:[a-z0-9-]+\.)*edgecity\.live")
#: answerCallbackQuery text is at most 200 characters.
ANSWER_MAX = 200

NOT_YOURS = "This vote card is not yours"
BAD_BUTTON = "This vote button is not valid."
IN_FLIGHT = "Still recording your vote..."
CLOSED = "Voting has closed."
INVALID = "This vote button is no longer valid; use the web link."
FAILED = "Could not record your vote. Try again or use the web link on the card."

#: Outcome codes (the only thing logged besides the tenant's id8).
RECORDED = "recorded"
EXPIRED = "expired"
REJECTED = "invalid"
RATE_LIMITED = "rate_limited"
TIMEOUT = "timeout"
NETWORK = "network"
HTTP_ERROR = "http_error"
BAD_RESPONSE = "bad_response"

_FAILURE_TEXT = {EXPIRED: CLOSED, REJECTED: INVALID}

# Cards whose tap is being recorded right now: (chat id, message id).
_in_flight: set[tuple[str, str]] = set()


def parse_callback(data: Any) -> Optional[tuple[int, str]]:
    """``(optionIndex, token)`` for a well-formed ``avv:`` value inside 64 bytes, else None."""
    if not isinstance(data, str) or len(data.encode("utf-8")) > CALLBACK_DATA_MAX_BYTES:
        return None
    match = CALLBACK_DATA.fullmatch(data)
    if match is None:
        return None
    index = int(match.group(1))
    if index > MAX_OPTION_INDEX:
        return None
    return index, match.group(2)


def _positive_id(value: Any) -> Optional[str]:
    text = str(value).strip() if isinstance(value, (int, str)) and not isinstance(value, bool) else ""
    return text if _TELEGRAM_USER.fullmatch(text) else None


def owner_ids(adapter: Any = None) -> set[str]:
    """The resident's Telegram user ids the box names directly: the adapter config's home channel
    (``user_id``, and ``chat_id`` when it is a positive DM id) and ``TELEGRAM_HOME_CHANNEL``. Empty
    when none is a positive id."""
    found: set[str] = set()
    try:
        home = getattr(getattr(adapter, "config", None), "home_channel", None)
        for field in ("user_id", "chat_id"):
            value = home.get(field) if isinstance(home, dict) else getattr(home, field, None)
            ident = _positive_id(value) if value is not None else None
            if ident:
                found.add(ident)
    except Exception:  # noqa: BLE001 - an unreadable config falls back to the env
        pass
    env_id = _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))
    if env_id:
        found.add(env_id)
    return found


def paired_on_box(user: str) -> bool:
    """Hermes's approved Telegram pairings hold ``user`` (the list the control plane checks before it
    sends a card). False when Hermes's pairing store cannot be read (fail closed)."""
    try:
        from gateway.pairing import PairingStore  # noqa: PLC0415 - Hermes, in-process on a box

        return bool(PairingStore().is_approved("telegram", user))
    except Exception:  # noqa: BLE001
        return False


def is_owner_tap(adapter: Any, user: Optional[str], chat: Optional[str], chat_type: Optional[str]) -> bool:
    """The tap is the resident's, in the resident's own DM with the bot."""
    if user is None:
        return False
    if chat is not None and chat != user:
        return False
    if isinstance(chat_type, str) and chat_type and chat_type != "private":
        return False
    if user in owner_ids(adapter):
        return True
    # The pairing list only for a tap whose DM is known (chat id == the tapper's id).
    return chat is not None and paired_on_box(user)


def tenant_id() -> Optional[str]:
    for name in TENANT_ENVS:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


def tenant_id8() -> str:
    value = tenant_id()
    return re.sub(r"[^A-Za-z0-9-]", "", value)[:8] if value else "-"


def app_origin() -> str:
    """``AV_APP_ORIGIN`` when it is a bare https origin on ``edgecity.live``, else the default."""
    raw = os.environ.get(ORIGIN_ENV, "").strip()
    if not raw:
        return DEFAULT_ORIGIN
    try:
        parts = urllib.parse.urlsplit(raw)
        host = (parts.hostname or "").lower()
        if (parts.scheme == "https" and _ALLOWED_HOST.fullmatch(host) and not parts.username
                and not parts.password and parts.path in ("", "/") and not parts.query and not parts.fragment):
            port = f":{parts.port}" if parts.port else ""
            return f"https://{host}{port}"
    except ValueError:
        pass
    logger.warning("av-vote: %s is not an https edgecity.live origin; using the default", ORIGIN_ENV)
    return DEFAULT_ORIGIN


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401 - never follow
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _read_json(body: bytes) -> dict:
    try:
        value = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def record_vote(token: str, *, timeout: float = TIMEOUT_S, opener: Any = None) -> tuple[str, Optional[str]]:
    """POST the token to the app. ``(outcome code, option label or None)``; never raises, and nothing
    it returns or logs carries the token."""
    url = app_origin() + RECORD_PATH
    payload = json.dumps({"token": token, "tenantId": tenant_id()}).encode("utf-8")
    request = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "av-vote/0.1"})
    try:
        with (opener or _OPENER).open(request, timeout=timeout) as response:
            status = getattr(response, "status", 200)
            body = _read_json(response.read(65536))
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            body = _read_json(error.read(65536))
        except Exception:  # noqa: BLE001
            body = {}
    except TimeoutError:
        return TIMEOUT, None
    except urllib.error.URLError as error:
        return (TIMEOUT if isinstance(getattr(error, "reason", None), TimeoutError) else NETWORK), None
    except Exception:  # noqa: BLE001 - a socket error of any kind is a network failure
        return NETWORK, None
    state = body.get("state") if isinstance(body.get("state"), str) else None
    if 200 <= status < 300:
        if body.get("ok") is True and state in (None, RECORDED):
            label = body.get("optionLabel")
            return RECORDED, label.strip()[:120] if isinstance(label, str) and label.strip() else None
        return BAD_RESPONSE, None
    if status == 410 or state == EXPIRED:
        return EXPIRED, None
    if status in (400, 403, 404, 422) or state == REJECTED:
        return REJECTED, None
    if status == 429:
        return RATE_LIMITED, None
    return HTTP_ERROR, None


def _button_fields(button: Any) -> tuple[str, Any]:
    if isinstance(button, dict):
        return str(button.get("text", "")), button.get("callback_data")
    return str(getattr(button, "text", "") or ""), getattr(button, "callback_data", None)


def _unchecked(text: str) -> str:
    return text[len(CHECK):] if text.startswith(CHECK) else text


def tapped_label(rows: Any, data: str, index: int) -> str:
    """The tapped button's own text (without a check mark), else "option <n>"."""
    for row in rows or ():
        for button in row or ():
            text, callback = _button_fields(button)
            if callback == data and _unchecked(text).strip():
                return _unchecked(text).strip()
    return f"option {index + 1}"


def mark_keyboard(rows: Any, data: str, make_button: Callable[[str, str], Any]) -> Optional[list[list[Any]]]:
    """The card's keyboard with a check mark on the tapped ``avv:`` button only. Non-``avv:`` buttons
    (the web row) are the same objects. None when nothing changes or the tapped button is absent."""
    if not rows:
        return None
    found = False
    changed = False
    out: list[list[Any]] = []
    for row in rows:
        new_row = []
        for button in row or ():
            text, callback = _button_fields(button)
            if isinstance(callback, str) and callback.startswith(PREFIX):
                want = CHECK + _unchecked(text) if callback == data else _unchecked(text)
                found = found or callback == data
                if want != text:
                    changed = True
                    new_row.append(make_button(want, callback))
                    continue
            new_row.append(button)
        out.append(new_row)
    return out if found and changed else None


def _truncate(text: str) -> str:
    return text if len(text) <= ANSWER_MAX else text[: ANSWER_MAX - 3] + "..."


async def _answer(query: Any, text: str) -> None:
    try:
        await query.answer(text=_truncate(text))
    except Exception:  # noqa: BLE001 - an expired query id cannot be answered; nothing to do
        logger.debug("av-vote: answerCallbackQuery failed", exc_info=True)


def _log(outcome: str) -> None:
    logger.info("av-vote: tenant=%s outcome=%s", tenant_id8(), outcome)


def make_handler(adapter: Any = None, *, make_button: Optional[Callable[[str, str], Any]] = None,
                 make_markup: Optional[Callable[[list], Any]] = None,
                 record: Optional[Callable[[str], tuple[str, Optional[str]]]] = None,
                 timeout: float = TIMEOUT_S) -> Callable[[Any, Any], Awaitable[None]]:
    """The PTB callback for ``avv:`` taps. ``make_button``/``make_markup`` build PTB keyboard objects
    (``InlineKeyboardButton``/``InlineKeyboardMarkup`` in the gateway); ``record`` posts the token."""
    record_fn = record or (lambda token: record_vote(token, timeout=timeout))

    async def on_vote_tap(update: Any, context: Any = None) -> None:
        query = getattr(update, "callback_query", None)
        if query is None:
            return
        key: Optional[tuple[str, str]] = None
        try:
            data = getattr(query, "data", None)
            user = _positive_id(getattr(getattr(query, "from_user", None), "id", None))
            message = getattr(query, "message", None)
            chat_obj = getattr(message, "chat", None) if message is not None else None
            raw_chat = getattr(chat_obj, "id", None)
            chat = None if raw_chat is None else str(raw_chat).strip()
            chat_type = getattr(chat_obj, "type", None)
            chat_type = getattr(chat_type, "value", chat_type)  # PTB ChatType enum or plain str
            if not is_owner_tap(adapter, user, chat, chat_type):
                _log("not_owner")
                await _answer(query, NOT_YOURS)
                return
            parsed = parse_callback(data)
            if parsed is None:
                _log("bad_data")
                await _answer(query, BAD_BUTTON)
                return
            index, token = parsed
            key = (str(chat), str(getattr(message, "message_id", ""))) if message is not None else ("-", str(data))
            if key in _in_flight:
                key = None  # the first tap owns the slot
                _log("in_flight")
                await _answer(query, IN_FLIGHT)
                return
            _in_flight.add(key)
            try:
                outcome, label = await asyncio.wait_for(asyncio.to_thread(record_fn, token), timeout + 2.0)
            except asyncio.TimeoutError:
                outcome, label = TIMEOUT, None
            _log(outcome)
            if outcome != RECORDED:
                await _answer(query, _FAILURE_TEXT.get(outcome, FAILED))
                return
            rows = getattr(getattr(message, "reply_markup", None), "inline_keyboard", None)
            await _answer(query, f"Recorded: {label or tapped_label(rows, data, index)}")
            if make_button is None or make_markup is None:
                return
            marked = mark_keyboard(rows, data, make_button)
            if marked is None:
                return
            try:
                await query.edit_message_reply_markup(reply_markup=make_markup(marked))
            except Exception:  # noqa: BLE001 - recorded already; a stale card is cosmetic
                logger.info("av-vote: tenant=%s outcome=edit_failed", tenant_id8())
        except Exception:  # noqa: BLE001 - fail-open: never raise into the gateway
            logger.warning("av-vote: tenant=%s outcome=handler_error", tenant_id8())
            await _answer(query, FAILED)
        finally:
            if key is not None:
                _in_flight.discard(key)

    return on_vote_tap


def _wire_telegram(application: Any, adapter: Any) -> None:
    """Factory Hermes calls at Telegram connect with the PTB ``Application``; SDK imports stay here."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup  # noqa: PLC0415
    from telegram.ext import CallbackQueryHandler  # noqa: PLC0415

    handler = make_handler(
        adapter,
        make_button=lambda text, data: InlineKeyboardButton(text=text, callback_data=data),
        make_markup=lambda rows: InlineKeyboardMarkup(rows),
    )
    # block=False: Hermes's Application processes one update at a time, so a blocking handler would
    # hold the resident's messages and every other button for the whole app call (OV-358 S1).
    application.add_handler(CallbackQueryHandler(handler, pattern=HANDLER_PATTERN, block=False))
    logger.info("av-vote: vote card buttons wired (pattern %s)", HANDLER_PATTERN)


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint: one scoped Telegram callback handler. No tools, no hooks."""
    try:
        wire = getattr(ctx, "register_platform_handler", None)
        if callable(wire):
            wire("telegram", _wire_telegram)
            return
        legacy = getattr(ctx, "register_telegram_handler", None)
        if callable(legacy):
            legacy(_wire_telegram)
            return
        logger.info("av-vote: this Hermes has no platform handler registry; vote buttons not wired")
    except Exception:  # noqa: BLE001 - never stop the plugin load
        logger.warning("av-vote: could not register the vote card handler", exc_info=True)
