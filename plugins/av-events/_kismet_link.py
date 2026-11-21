"""A Kismet one-time sign-in link in outbound text (ov#599 N1/N6 follow-up; review-b CLAIMS L37096, ruling L37099).

kismet.web_link gives the owner a single-use, 15-minute sign-in link to their own Kismet account
(https://kismet-village.vercel.app/u/<token>?next=chat). It belongs in the owner's private chat only, so no other outbound
write carries one: village-bridge checks every free-text string of every write operation except Kismet's own, and
av-events checks a share_digest text. Best effort and plain text only: no URL parser (nothing here can throw on a str),
no remembered tokens, no gate.

Normalised before matching: NFKC; control (tab, CR, LF and every other Cc), format, unassigned, private-use, surrogate and
invisible characters dropped; the IDNA dot equivalents (U+3002, U+FF0E, U+FF61) and U+2024 read as "."; percent-decoded until
stable (bounded); backslashes as slashes; case-folded. Then a link is the host (any scheme or "//" before it; a trailing dot
and a port allowed) followed by a path whose first real segment, after "." and ".." segments and empty segments are
resolved, is "u". A path after the host longer than PATH_CHARS fails closed (counts as a link): its padding could otherwise
hide the "u" segment past any cap.

This file is byte-identical in plugins/village-bridge/_kismet_link.py and plugins/av-events/_kismet_link.py (each plugin
is its own package and never imports the other); plugins/village-bridge/tests/test_bridge.py pins the two copies equal.
Standard library only.
"""
from __future__ import annotations

import re
import unicodedata
from urllib.parse import unquote

#: The same set as village-bridge __init__.py INVISIBLE (pinned by test_bridge.py).
INVISIBLE = frozenset("­͏ᅟᅠ឴឵᠋᠌᠍᠏⠀ㅤﾠ"
                      + "".join(map(chr, range(0xFE00, 0xFE10))) + "".join(map(chr, range(0xE0100, 0xE01F0))))
DROPPED = ("Cc", "Cf", "Cn", "Co", "Cs")
#: IDNA dot equivalents (RFC 3490 section 3.1) and the one-dot leader, read as "." (NFKC alone leaves U+3002 as it is).
DOTS = str.maketrans({"\u3002": ".", "\uff0e": ".", "\uff61": ".", "\u2024": "."})
HOST = re.compile(r"(?<![a-z0-9-])kismet-village\.vercel\.app\.?(?::[0-9]{0,5})?(?=/)")
PATH_END = re.compile(r"[?#\s]")
DECODE_PASSES = 8
PATH_CHARS = 4096


def _plain(value: str) -> str:
    text = unicodedata.normalize("NFKC", value).translate(DOTS)
    return "".join(c for c in text if unicodedata.category(c) not in DROPPED and c not in INVISIBLE)


def _normalised(value: str) -> str:
    text = _plain(value)
    for _ in range(DECODE_PASSES):  # percent-decoding until stable (bounded; unquote never raises on a str)
        decoded = _plain(unquote(text))
        if decoded == text:
            break
        text = decoded
    return text.replace("\\", "/").casefold()


def _first_segment_is_u(text: str, start: int) -> bool:
    """The path at text[start:] (it starts with "/", ends at PATH_END): its segments with "", "." and ".." resolved; True
    when the first one left is "u". A path longer than PATH_CHARS is True (fail closed): no cap falls before resolution."""
    end = PATH_END.search(text, start, start + PATH_CHARS + 1)
    stop = end.start() if end else min(len(text), start + PATH_CHARS + 1)
    if stop - start > PATH_CHARS:
        return True
    kept: list = []
    for segment in text[start:stop].split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if kept:
                kept.pop()
            continue
        kept.append(segment)
    return bool(kept) and kept[0] == "u"


def names_kismet_signin_link(value) -> bool:
    """True when the string `value` names a Kismet sign-in link (any spelling above); False for anything else."""
    if not isinstance(value, str):
        return False
    text = _normalised(value)
    return any(_first_segment_is_u(text, found.end()) for found in HOST.finditer(text))


def carries_kismet_signin_link(value) -> bool:
    """True when any string at any depth of `value` (dict keys and values, lists walked) names a Kismet sign-in link: keys
    count too, since generic args and card items carry agent-supplied keys."""
    if isinstance(value, str):
        return names_kismet_signin_link(value)
    if isinstance(value, dict):
        return any(carries_kismet_signin_link(k) or carries_kismet_signin_link(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return any(carries_kismet_signin_link(v) for v in value)
    return False
