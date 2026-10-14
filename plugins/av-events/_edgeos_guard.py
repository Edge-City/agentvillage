"""EDGEOS-CURL-GUARD: refuse a hand-written call to EdgeOS's directory or own-profile endpoint.

BUG 1 (resident bugs, 14 Oct): since rc39 the attendee directory comes only from
`bun skills/edgeos/scripts/directory.ts` (box -> control plane -> app -> EdgeOS, DATA-454), and
since rc41 the person's own profile only from `profile.ts` (DATA-454b, ov#342). A Telegram DM
session that began before that still holds the old §8/§9 recipe in its own history,
`curl -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/applications/my/directory/{popup}..."`
(or `/humans/me`). The bearer is dead, EdgeOS answers 401, and the model tells the resident the
directory "expired". Hermes never ends such a session, so the skill text alone cannot reach it.

This module returns a `block` directive for exactly that call, naming the script to run instead.
The rule (all three must hold):

1. The tool is `terminal` (its `command`) or `execute_code` (its `code`).
2. A `terminal` command runs an HTTP client: `curl`, `wget`, HTTPie (`http`/`https`), `xh`, or an
   interpreter (`python`, `node`, `bun`, `deno`, `perl`, `ruby`) at a command position. An
   `execute_code` call is code, so it always counts.
3. The text names EdgeOS (`edgeos.world`, `EDGEOS_API_BASE`, `EDGEOS_BEARER_TOKEN` or
   `EDGEOS_API_KEY`) AND holds an endpoint path, `[/api/v1]/humans/me` or
   `[/api/v1]/applications/my/directory`, ending at a path boundary, whose own URL word starts
   with nothing (not after `=`, `&` or `?`), an EdgeOS origin (`[https://][sub.]edgeos.world[:port]`)
   or a variable expansion (`$NAME`, `${...}`, `{name}`). A path inside a URL on any other host,
   or in a query string, does not count.

Before matching, backslash-newline continuations are joined and quote characters dropped, so
quoting and multi-line curls read the same as one-liners.

Fail closed, narrowly: if the matcher itself raises, the call is refused only when the raw text
still contains one of the two endpoint paths; otherwise it goes through and one warning is logged.
Kill switch `AV_EDGEOS_CURL_GUARD` (default on; `0`, `false`, `no`, `off` turn it off), read from
the process environment on every call, like `AV_TERMINAL_ARGS_FIX`. No I/O beyond that dict read;
the log line never carries the command.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Mapping, Optional

from ._core import DISABLED_VALUES

logger = logging.getLogger("av-events")

SWITCH = "AV_EDGEOS_CURL_GUARD"

#: Tool -> the argument holding what it runs.
TOOL_FIELDS = {"terminal": "command", "execute_code": "code"}

#: The two retired curl targets, as plain substrings (the fail-closed fallback).
ENDPOINT_PATHS = ("/humans/me", "/applications/my/directory")

REFUSAL = (
    "Refused by Agent Village (EDGEOS-CURL-GUARD): EdgeOS's attendee directory and the person's own "
    "profile (/humans/me) are no longer read with a curl or a hand-written HTTP call. The old "
    "EDGEOS_BEARER_TOKEN recipe is retired, so EdgeOS answers 401; that is not the directory or the "
    "profile expiring, so never tell the person it expired. Instead run "
    "`bun skills/edgeos/scripts/directory.ts` for the directory (`--search WORDS` to find someone) "
    "or `bun skills/edgeos/scripts/profile.ts` for their own profile, and follow "
    "skills/edgeos/SKILL.md §8 and §9 for what its output and exit code mean."
)

_ENDPOINT = re.compile(
    r"(?:/api/v1)?/(?:humans/me|applications/my/directory)(?=$|[/?#\s;&|)\\,}+`<>.])", re.IGNORECASE)
_EDGEOS_REF = re.compile(r"edgeos\.world|EDGEOS_API_BASE|EDGEOS_BEARER_TOKEN|EDGEOS_API_KEY",
                         re.IGNORECASE)
_CLIENT = re.compile(
    r"(?:^|[\s;&|(`!{]|\$\()(?:[\w./-]*/)?"
    r"(?:curl|wget|http|https|xh|xhs|python[0-9.]*|node|bun|deno|perl|ruby)(?=$|\s)")
#: What may stand before the endpoint path inside its own URL word.
_PREFIX = re.compile(
    r"(?:(?:https?:)?//)?(?:[a-z0-9-]+\.)*edgeos\.world(?::\d+)?"
    r"|\$[A-Za-z_][A-Za-z0-9_]*"
    r"|\$\{[^{}]*\}"
    r"|f?\{[^{}]*\}",
    re.IGNORECASE)
#: Characters that end a URL word (looking back from the endpoint path).
_WORD_BREAK = frozenset(" \t\n;&|()<>,=+[]`")


def switch_on(environ: Optional[Mapping[str, str]] = None) -> bool:
    """True unless `AV_EDGEOS_CURL_GUARD` holds an accepted spelling of "off"."""
    raw = (os.environ if environ is None else environ).get(SWITCH)
    if raw is None:
        return True
    return str(raw).strip().lower() not in DISABLED_VALUES


def normalised(text: str) -> str:
    """Continuations joined, quote characters dropped."""
    return text.replace("\\\r\n", "").replace("\\\n", "").replace('"', "").replace("'", "")


def _word_start(text: str, end: int) -> int:
    """Start of the URL word that ends at `end` (exclusive), braces kept whole."""
    depth = 0
    i = end - 1
    while i >= 0:
        ch = text[i]
        if ch == "}":
            depth += 1
        elif ch == "{":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and ch in _WORD_BREAK:
            break
        i -= 1
    return i + 1


def _endpoint_hit(text: str) -> bool:
    """True when an endpoint path appears with an allowed prefix in its own URL word."""
    for match in _ENDPOINT.finditer(text):
        start = _word_start(text, match.start())
        prefix = text[start:match.start()]
        if prefix == "":
            # A bare path (`base + "/humans/me"`), but not a query value (`?q=/humans/me`).
            if start == 0 or text[start - 1] not in "=&?":
                return True
        elif _PREFIX.fullmatch(prefix):
            return True
    return False


def matches(tool_name: Any, args: Any) -> bool:
    """The rule in the module docstring. May raise on odd input; `safe_directive` handles that."""
    field = TOOL_FIELDS.get(tool_name) if isinstance(tool_name, str) else None
    if field is None or not isinstance(args, dict):
        return False
    raw = args.get(field)
    if not isinstance(raw, str):
        return False
    text = normalised(raw)
    if not _EDGEOS_REF.search(text):
        return False
    if tool_name == "terminal" and not _CLIENT.search(text):
        return False
    return _endpoint_hit(text)


def directive(tool_name: Any, args: Any) -> Optional[dict]:
    """The block directive for a matching call, else None."""
    if matches(tool_name, args):
        return {"action": "block", "message": REFUSAL}
    return None


def _raw_has_endpoint(tool_name: Any, args: Any) -> bool:
    field = TOOL_FIELDS.get(tool_name) if isinstance(tool_name, str) else None
    if field is None or not isinstance(args, dict):
        return False
    raw = args.get(field)
    return isinstance(raw, str) and any(path in raw for path in ENDPOINT_PATHS)


def safe_directive(tool_name: Any, args: Any, environ: Optional[Mapping[str, str]] = None,
                   matcher=None) -> Optional[dict]:
    """`directive` behind the kill switch, never raising.

    If the matcher raises, the call is blocked only when its raw text contains an endpoint path;
    otherwise it is allowed and one warning is logged (no command text). A raise out of here would
    turn every tool call into a block (Hermes `_policy_error_block_directive`), so nothing does.
    `matcher` is for tests (it replaces `matches`).
    """
    try:
        if not switch_on(environ):
            return None
    except BaseException:  # noqa: BLE001 - an unreadable switch keeps the guard on
        pass
    try:
        hit = (matcher or matches)(tool_name, args)
        return {"action": "block", "message": REFUSAL} if hit else None
    except BaseException:  # noqa: BLE001 - see docstring
        try:
            if _raw_has_endpoint(tool_name, args):
                return {"action": "block", "message": REFUSAL}
        except BaseException:  # noqa: BLE001
            pass
        try:
            logger.warning("av-events: edgeos_curl_guard matcher failed; call allowed")
        except BaseException:  # noqa: BLE001
            pass
        return None


__all__ = ["SWITCH", "TOOL_FIELDS", "ENDPOINT_PATHS", "REFUSAL", "switch_on", "normalised", "matches",
           "directive", "safe_directive"]
