"""`message.in` / `message.out` payloads (spec §4.1, §7.1). Pure.

A message leaves as its channel, its length in characters and a SHA-256 of
its exact text, plus flags derived from punctuation — never the text, in any
capture mode. The text itself is in the archive only (§7.5); the training
export reads it from there (§8), never from events.

Python 3.11, standard library only.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

#: The rule the `flags` were derived by. A better rule is a new version, so a
#: consumer can tell the two apart rather than mixing them.
FLAGS_RULE = "message_flags_v1"

#: Channels pass through when they look like a platform name; anything else is
#: `other`, so an unexpected platform string cannot carry text.
_CHANNEL = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")

_URL = re.compile(r"\bhttps?://\S+", re.IGNORECASE)
#: A question mark that ends a sentence: followed by whitespace, a closing
#: quote or bracket, `!`, or the end of the text. `?` inside a URL's query string
#: never counts because URLs are removed first.
_QUESTION = re.compile(r"\?+(?=[\s\"'”’)\]!]|$)")


def is_ask(text: str) -> bool:
    """`message_flags_v1`: the message contains a sentence ending in `?`.

    Structural, not semantic: no model, no word lists. It is the definition
    research can supersede with a new `flags_rule`, and nothing here pretends
    to detect recommendations or sentiment — those stay null.
    """
    return bool(_QUESTION.search(_URL.sub(" ", text)))


def channel_of(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return "unknown"
    return text if _CHANNEL.match(text) else "other"


#: Hermes's silence markers (`gateway/response_filters.py`
#: `LIVE_GATEWAY_SILENT_MARKERS` at `v2026.8.31`).
SILENT_MARKERS = frozenset({"[SILENT]", "SILENT", "NO_REPLY", "NO REPLY"})


def _silence_token(line: str) -> bool:
    return " ".join(line.strip().upper().split()) in SILENT_MARKERS


def is_silent(text: Any) -> bool:
    """Hermes's `is_autonomous_silence_response`: the reply a cron run
    suppresses — a marker as the whole reply, on its own first or last line,
    or `[SILENT]` opening it. A marker buried mid-sentence is a real reply."""
    if not isinstance(text, str) or not text.strip():
        return False
    stripped = text.strip()
    if _silence_token(stripped):
        return True
    lines = [line for line in stripped.splitlines() if line.strip()]
    if lines and (_silence_token(lines[0]) or _silence_token(lines[-1])):
        return True
    return stripped.upper().startswith("[SILENT]")


def message_payload(
    text: Any,
    channel: str,
    capture: str,
    cron_job_id: Optional[str],
    hasher: Callable[[str], Optional[str]],
    silent: Optional[bool] = None,
) -> dict:
    """§4.1: `channel`, `length`, `content_hash`, `flags` {is_ask,
    is_recommendation, sentiment?}, `cron_job_id?`. Every key always present.

    `metadata` keeps only the channel and the fact that a message happened:
    length, hash and flags are all derived from the content. A message that is
    not a string (a multimodal list) has no length or hash either.

    `content_hash` is `hasher`'s — HMAC-SHA256 under the tenant's key, since a
    plain hash of "yes" is "yes". `silent` is set only on a cron run's
    `message.out`: true when the reply is Hermes's silence marker, i.e. nothing
    was delivered. It is a delivery fact, not content, and rides in every mode.
    """
    payload: dict[str, Any] = {
        "channel": channel_of(channel),
        "length": None,
        "content_hash": None,
        "flags": {"is_ask": None, "is_recommendation": None, "sentiment": None},
        "flags_rule": None,
        "cron_job_id": cron_job_id,
        "silent": silent,
    }
    if capture != "metadata" and isinstance(text, str):
        payload["length"] = len(text)
        payload["content_hash"] = hasher(text)
        payload["flags"]["is_ask"] = is_ask(text)
        payload["flags_rule"] = FLAGS_RULE
    return payload


__all__ = ["FLAGS_RULE", "SILENT_MARKERS", "channel_of", "is_ask", "is_silent", "message_payload"]
