"""`message.in` / `message.out` payloads (spec §4.1, §7.1). Pure.

A message leaves as its channel, its length in characters and a SHA-256 of
its exact text, plus flags derived from punctuation — never the text, in any
capture mode. The text itself is in the archive only (§7.5); the training
export reads it from there (§8), never from events.

Python 3.11, standard library only.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ._core import sha256_text

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


def message_payload(text: Any, channel: str, capture: str, cron_job_id: Optional[str]) -> dict:
    """§4.1: `channel`, `length`, `content_hash`, `flags` {is_ask,
    is_recommendation, sentiment?}, `cron_job_id?`. Every key always present.

    `metadata` keeps only the channel and the fact that a message happened:
    length, hash and flags are all derived from the content. A message that is
    not a string (a multimodal list) has no length or hash either.
    """
    payload: dict[str, Any] = {
        "channel": channel_of(channel),
        "length": None,
        "content_hash": None,
        "flags": {"is_ask": None, "is_recommendation": None, "sentiment": None},
        "flags_rule": None,
        "cron_job_id": cron_job_id,
    }
    if capture != "metadata" and isinstance(text, str):
        payload["length"] = len(text)
        payload["content_hash"] = sha256_text(text)
        payload["flags"]["is_ask"] = is_ask(text)
        payload["flags_rule"] = FLAGS_RULE
    return payload


__all__ = ["FLAGS_RULE", "channel_of", "is_ask", "message_payload"]
