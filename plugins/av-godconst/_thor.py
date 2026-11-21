"""av-godconst, third mode: the THOR daily nudge card (pure logic: copy, callback data, the read's checks, rendering).

Product copy: lanes-product/THOR-NUDGE-CARD-COPY-2026-10-29.md, verbatim. Contract (data's cp module, ODIN-THOR-NUDGES
design section 5, CLAIMS L33039): ``GET /tenants/:id/thor/today`` serves at most one item per person per UTC day and marks
it carded; ``POST /tenants/:id/thor/:item_key/answer`` records ``do_it | not_now | not_for_me``. The I/O (the pass, the
tap, the ledger, the control-plane call) lives in ``__init__``; nothing here reads the environment, the disk or the
network. Standard library only.
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from typing import Any, Callable, Optional

# --------------------------------------------------------------------------- copy (verbatim, the copy file's constants)

THOR_NUDGE_SIGNOFF = "From ODIN, one a day at most."
THOR_NUDGE_WHY = "Why you: "
THOR_NUDGE_DO = "Do it"
THOR_NUDGE_LATER = "Not now"
THOR_NUDGE_NEVER = "Not for me"
THOR_NUDGE_DONE = "Done: {title}."
THOR_NUDGE_NOTED = "Noted."
THOR_NUDGE_INTRO_ASKED = "Asked. ODIN will check with {b} too."
THOR_NUDGE_INTRO_MIRROR = "{a} would like an intro."
THOR_NUDGE_INTRO_MATCH = "It's a match: {a} and {b} both said yes."
THOR_NUDGE_LATER_OK = "OK. ODIN may bring this back another day."
THOR_NUDGE_NEVER_OK = "OK. You won't see this one again."

#: The card's last line: the fixed sign-off and the three choices, as the copy file's card shows it.
SIGNOFF_LINE = f"{THOR_NUDGE_SIGNOFF} {THOR_NUDGE_DO} · {THOR_NUDGE_LATER} · {THOR_NUDGE_NEVER}"

# Tap answers (not in the copy file; short, plain, the ballot cards' pattern).
NOT_YOURS = "This card is not yours"
BAD_BUTTON = "This button is not valid."
INVALID = "This card is no longer valid."
CLOSED = "This card has closed."
ALREADY = "Already noted."
IN_FLIGHT = "Still saving…"
FAILED = "Could not save that. Tap again in a moment."

# --------------------------------------------------------------------------- the three answers

#: callback letter -> the value the answer route takes, and the button label.
ANSWERS = {"d": "do_it", "l": "not_now", "n": "not_for_me"}
LABELS = {"d": THOR_NUDGE_DO, "l": THOR_NUDGE_LATER, "n": THOR_NUDGE_NEVER}
#: An intro item carries ``intro: true`` and ``role`` ("a": the one asked first; "b": the mirror card the control
#: plane serves once A said Do it), plus ``other_first_name`` (the other party's first name for whoever receives the
#: card), present only when that person will actually be asked (data's cp#493 contract).
ROLES = ("a", "b")
FIRST_NAME_MAX = 64

PREFIX = "avt:"
HANDLER_PATTERN = r"^avt:"
NONCE_CHARS = 8
CALLBACK_DATA_MAX_BYTES = 64
_CALLBACK = re.compile(r"^avt:([dln]):([A-Za-z0-9_-]{8})$")
CHECK = "✅ "


def callback(choice: str, nonce: str) -> str:
    if choice not in ANSWERS or not re.fullmatch(r"[A-Za-z0-9_-]{8}", nonce or ""):
        raise ValueError("av-godconst: bad thor callback parts")
    return f"{PREFIX}{choice}:{nonce}"


def parse_callback(data: Any) -> Optional[tuple]:
    """``(choice letter, nonce)`` for a well-formed ``avt:`` value, else None."""
    if not isinstance(data, str) or len(data.encode("utf-8")) > CALLBACK_DATA_MAX_BYTES:
        return None
    match = _CALLBACK.fullmatch(data)
    return (match.group(1), match.group(2)) if match else None


def card_rows(nonce: str, make_button: Callable, chosen: Optional[str] = None) -> list:
    """One row of three buttons. Once answered, the chosen one alone, marked (a re-tap answers "Already noted.")."""
    if chosen in ANSWERS:
        return [[make_button(CHECK + LABELS[chosen], callback(chosen, nonce))]]
    return [[make_button(LABELS[c], callback(c, nonce)) for c in ("d", "l", "n")]]


def follow_up(choice: str, intro: bool, other_first_name: Optional[str] = None, role: Optional[str] = None) -> str:
    """The line the resident sees after a recorded tap (the copy file's "three answers").

    Do it, non-intro: nothing performs the action on our side yet (ODIN answers and explains only), so just "Noted."
    (never a promised pick-up). Do it on A's intro card (``intro`` true, ``role`` "a") with ``other_first_name``:
    "Asked. ODIN will check with {b} too." B's mirror card (role "b"), an intro with no name, or a role not given: the
    plain "Noted.". Never a name the route did not give."""
    if choice == "l":
        return THOR_NUDGE_LATER_OK
    if choice == "n":
        return THOR_NUDGE_NEVER_OK
    if intro and role == "a" and isinstance(other_first_name, str) and other_first_name.strip():
        return THOR_NUDGE_INTRO_ASKED.format(b=other_first_name.strip())
    return THOR_NUDGE_NOTED


# --------------------------------------------------------------------------- the read's checks

_ITEM_KEY = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
CHANNEL_MAX = 64  # any non-empty channel up to this length: it is never rendered (review-b S1)
TITLE_MAX_IN = 2000
DRAFT_MAX_IN = 16000
EVIDENCE_MAX_IN = 4000


def epoch_from_iso(value: Any) -> Optional[float]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return None if stamp.tzinfo is None else stamp.timestamp()


def utc_day(now: float) -> str:
    return datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y-%m-%d")


def valid_item(raw: Any) -> Optional[dict]:
    """One item, checked; None when unusable. Only the fields the card needs are kept: item_key, title, draft, channel,
    intro (exactly true), role ("a"/"b", else None), other_first_name (a short non-empty string, else None), expires_at
    (epoch), and evidence ONLY when ``show_evidence`` is exactly true and the text is there (while it is false the route
    sends no evidence at all: no "Why you:" line). Other keys are ignored, never rendered.

    A role-b item (B's mirror card, cp#493) carries title null and draft null: B never gets A's surfacing text. Its
    title, draft, channel and evidence are not read at all (stored as empty), so null or present they can neither break
    nor reach the card; it renders from ``other_first_name`` only (``mirror_text``). Every other item needs a non-empty
    title and draft and a non-empty channel of at most CHANNEL_MAX characters (never rendered)."""
    if not isinstance(raw, dict):
        return None
    key = raw.get("item_key")
    if not isinstance(key, str) or not _ITEM_KEY.fullmatch(key):
        return None
    expires = epoch_from_iso(raw.get("expires_at"))
    if expires is None:
        return None
    intro = raw.get("intro") is True
    role = raw.get("role") if raw.get("role") in ROLES else None
    other = raw.get("other_first_name")
    other = other.strip() if isinstance(other, str) and 0 < len(other.strip()) <= FIRST_NAME_MAX else None
    base = {"item_key": key, "intro": intro, "role": role, "other_first_name": other, "expires_at": expires}
    if role == "b":
        return {**base, "title": "", "draft": "", "channel": "", "evidence": ""}
    title, draft, channel = raw.get("title"), raw.get("draft"), raw.get("channel")
    if not isinstance(title, str) or not title.strip() or len(title) > TITLE_MAX_IN:
        return None
    if not isinstance(draft, str) or not draft.strip() or len(draft) > DRAFT_MAX_IN:
        return None
    if not isinstance(channel, str) or not channel.strip() or len(channel) > CHANNEL_MAX:
        return None
    show = raw.get("show_evidence") is True
    evidence = raw.get("evidence")
    evidence = evidence.strip() if show and isinstance(evidence, str) and len(evidence) <= EVIDENCE_MAX_IN else ""
    return {**base, "title": title.strip(), "draft": draft.strip(), "channel": channel, "evidence": evidence}


def today_item(data: Any, now: float) -> tuple:
    """The read's answer -> ``(item or None, code)``. Accepts ``{"items": [...]}`` or ``{"item": {...} | null}`` (the
    route's envelope is data's to fix; the report asks). At most ONE item is ever used: the first usable, unexpired one
    in the route's order (best rank first). Codes: ``served``, ``empty``, ``expired`` (every item past its expiry: never
    rendered), ``invalid`` (items present, none usable), ``bad_response`` (no known envelope)."""
    if not isinstance(data, dict):
        return None, "bad_response"
    if isinstance(data.get("items"), list):
        raws = data["items"]
    elif "item" in data:
        raws = [] if data["item"] is None else [data["item"]]
    else:
        return None, "bad_response"
    if not raws:
        return None, "empty"
    items = [valid_item(r) for r in raws[:10]]
    usable = [i for i in items if i is not None]
    if not usable:
        return None, "invalid"
    live = [i for i in usable if i["expires_at"] > now]
    if not live:
        return None, "expired"
    return live[0], "served"


# --------------------------------------------------------------------------- rendering

TELEGRAM_MAX = 4096
_SENTENCE_END = re.compile(r"[.!?…](?=\s)")


def trim(text: str, limit: int) -> str:
    """At most `limit` characters, cut at the last sentence end inside the limit, else the last space, else hard."""
    text = text.strip()
    if len(text) <= limit:
        return text
    head = text[: limit]
    ends = [m.end() for m in _SENTENCE_END.finditer(head + " ")]
    if ends and ends[-1] >= limit // 3:
        return head[: ends[-1]].strip()
    space = head.rfind(" ")
    return (head[:space] if space >= limit // 3 else head).strip()


def card_text(item: dict, limit: int = TELEGRAM_MAX) -> str:
    """The card (the copy file's shape, HTML-escaped for parse_mode HTML). A role-b card is ``mirror_text``.

        {title}

        {draft}

        Why you: {evidence}        (only with show_evidence and evidence text)

        From ODIN, one a day at most. Do it · Not now · Not for me

    Each field is trimmed at a sentence boundary so the whole message fits Telegram's 4096 characters."""
    if item.get("role") == "b":
        return mirror_text(item)
    title_cap, evidence_cap, draft_cap = 300, 600, limit
    while True:
        parts = [trim(item["title"], title_cap), trim(item["draft"], draft_cap)]
        if item.get("evidence"):
            parts.append(THOR_NUDGE_WHY + trim(item["evidence"], evidence_cap))
        parts.append(SIGNOFF_LINE)
        text = "\n\n".join(html.escape(p, quote=False) for p in parts)
        if len(text) <= limit or draft_cap <= 40:
            return text
        draft_cap = int(draft_cap * 0.8)
        evidence_cap = max(80, int(evidence_cap * 0.8))


def mirror_text(item: dict) -> str:
    """B's mirror card (role b): ONLY the copy file's mirror line with ``other_first_name`` (A's first name), with the
    same three taps as buttons. Never a title, draft or evidence: those are A's surfacing text and reasons (review-b
    S3; the control plane sends title and draft null on role b). The caller skips a role-b item with no name.

        {a} would like an intro."""
    return html.escape(THOR_NUDGE_INTRO_MIRROR.format(a=item.get("other_first_name") or ""), quote=False)
