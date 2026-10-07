"""Rewrite Index URLs in Index tool results.

Hermes calls ``transform_tool_result`` after a tool returns and before the
model sees the result. A string return replaces that result. ``None`` leaves
it unchanged.

A signed accept link (``action=accept``) gains ``surface=telegram``. The
signature does not cover surface, and a plain ``/o/<id>`` opportunity link
is left as Index minted it. A signed decline link is left as Index minted
it. A person link becomes ``https://agents.edgecity.live/rolodex?person=<userId>``.
A signal link becomes ``https://agents.edgecity.live/intents?intent=<intentId>``.
Every other ``index.network`` URL stays as Index minted it.

Bounds (SEREF-OVERLAY refute F2-F4, N1, N4):

* Only results of Index tools are touched: the Index MCP server's tools
  (``mcp__index__<tool>``, and ``mcp_index_<tool>`` from Hermes builds that
  used one underscore) and Index's own Hermes plugin tools (``index_<tool>``).
  ``read_file``, ``terminal``, web tools and everything else pass untouched.
* ``AV_INDEX_LINKS=off`` (or ``0``, ``false``, ``no``), in the process
  environment or in ``$HERMES_HOME/.env``, makes the hook a no-op. It is read
  on every Index tool call, so no restart is needed.
* A result over 256 KiB is returned unchanged, and every pattern is bounded,
  so no input makes a match run in more than linear time.
* Trailing sentence punctuation (``.`` ``,`` ``;`` ``:`` ``!`` ``?`` ``*``, a
  closing bracket or quote) after a bare URL stays outside the URL.
* A query that repeats ``action``, ``viewer``, ``sig``, ``surface`` or ``to``
  is never rewritten.
* Hosts match in ASCII only, so a Unicode look-alike host is left alone.
"""

from __future__ import annotations

import os
import re
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_OPP_PATH = re.compile(r"^/o/([A-Za-z0-9_-]+)/?$")
_USER_PATH = re.compile(r"^/u/([A-Za-z0-9_-]+)/?$")
_INTENT_PATH = re.compile(r"^/i/([A-Za-z0-9_-]+)/?$")
# Every class is bounded and excludes its own opening delimiter, so a match
# attempt at one position never scans past the next candidate (refute F2).
# The host matches case-insensitively in ASCII only, so a Unicode case-fold
# (dotless i, KELVIN SIGN) is not taken for index.network (refute N4).
_HOST = r"(?ai:https?://(?:[a-z0-9-]{1,63}\.){0,8}index\.network)"
_URL_CHARS = r"[^\s<>\"'\\)\]]"
_MAX_URL_TAIL = 2048
_INDEX_URL = re.compile(_HOST + r"(?:/" + _URL_CHARS + r"{0,%d})?" % _MAX_URL_TAIL)
_INDEX_MARKDOWN = re.compile(r"\[([^\[\]\n]{0,300})\]\(([^()\s]{0,%d})\)" % _MAX_URL_TAIL)
_INDEX_AUTOLINK = re.compile(r"<(" + _HOST + r"[^<>\s]{0,%d})>" % _MAX_URL_TAIL)
_URL_CHAR = re.compile(_URL_CHARS)
#: Sentence punctuation a linkifier leaves outside a bare URL (refute F4). Not
#: ``_``, ``-`` or ``=``: those can end a base64url signature.
_TRAILING = ".,;:!?*)]'\"\u2019\u201d\u00bb"
#: Query keys that must appear at most once for a rewrite (refute N1).
_SINGLE_KEYS = ("action", "viewer", "sig", "surface", "to")
#: Hermes's own security-guidance plugin skips results over this size too.
MAX_RESULT_BYTES = 256 * 1024
#: Index tool-name prefixes: MCP server ``index`` (two Hermes spellings) and
#: Index's Hermes plugin, whose tools register under their bare names.
INDEX_TOOL_PREFIXES = ("mcp__index__", "mcp_index_", "index_")
OFF_SWITCH = "AV_INDEX_LINKS"
_OFF_VALUES = frozenset({"off", "0", "false", "no"})
_PORTAL_HOST = "agents.edgecity.live"
_SURFACE = "telegram"

_REGISTERED = False


def _url_path(url: Any) -> str:
    if not isinstance(url, str):
        return ""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if host != "index.network" and not host.endswith(".index.network"):
        return ""
    return parts.path or "/"


def _query_pairs(url: str) -> list[tuple[str, str]]:
    return parse_qsl(urlsplit(url).query, keep_blank_values=True)


def _with_surface(url: str) -> str:
    """Append ``surface=telegram``. Surface is not part of the signature."""
    parts = urlsplit(url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key not in ("surface", "to")]
    query.append(("surface", _SURFACE))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def rewrite_opportunity_link(url: str) -> str:
    """A signed accept link gains ``surface=telegram``. A plain ``/o/<id>`` stays.

    A link that repeats ``action``, ``viewer``, ``sig``, ``surface`` or ``to``
    stays as minted: which duplicate counts is the verifier's call, not ours.
    """
    pairs = _query_pairs(url)
    keys = [key for key, _ in pairs]
    if any(keys.count(key) > 1 for key in _SINGLE_KEYS):
        return url
    query = dict(pairs)
    if query.get("action", "") == "accept" and query.get("viewer") and query.get("sig"):
        return _with_surface(url)
    return url


def _portal(path: str) -> str:
    return "https://" + _PORTAL_HOST + path


def _map_url(url: str) -> Optional[str]:
    path = _url_path(url)
    if not path:
        return None
    if _OPP_PATH.fullmatch(path):
        return rewrite_opportunity_link(url)
    user = _USER_PATH.fullmatch(path)
    if user:
        return _portal("/rolodex?person=" + user.group(1))
    intent = _INTENT_PATH.fullmatch(path)
    if intent:
        return _portal("/intents?intent=" + intent.group(1))
    return url


def _rewrite_markdown(text: str) -> str:
    def sub(match: re.Match[str]) -> str:
        label, url = match.group(1), match.group(2).strip()
        if _INDEX_URL.fullmatch(url) is None:
            return match.group(0)
        mapped = _map_url(url)
        if not mapped:
            return label
        return "[" + label + "](" + mapped + ")"

    return _INDEX_MARKDOWN.sub(sub, text)


def _rewrite_autolinks(text: str) -> str:
    def sub(match: re.Match[str]) -> str:
        url = match.group(1)
        # Same guard as the markdown branch: a look-alike host or a port is not an
        # Index URL, and an unmapped one stays as written (recheck N1).
        if _INDEX_URL.fullmatch(url) is None:
            return match.group(0)
        mapped = _map_url(url)
        return match.group(0) if mapped is None else mapped

    return _INDEX_AUTOLINK.sub(sub, text)


def _rewrite_bare_urls(text: str) -> str:
    def sub(match: re.Match[str]) -> str:
        whole = match.group(0)
        end = match.end()
        if end < len(text) and _URL_CHAR.match(text, end):
            return whole  # longer than the bound: leave the whole URL alone
        url = whole.rstrip(_TRAILING)
        if not url or _INDEX_URL.fullmatch(url) is None:
            return whole
        return (_map_url(url) or "") + whole[len(url):]

    return _INDEX_URL.sub(sub, text)


def _too_big(text: str) -> bool:
    return len(text) > MAX_RESULT_BYTES or len(text.encode("utf-8", errors="ignore")) > MAX_RESULT_BYTES


def rewrite_index_links(result: Any) -> Any:
    """Replace Index URLs in a tool-result string. Anything else is returned as-is."""
    if not isinstance(result, str) or _too_big(result) or "index.network" not in result.lower():
        return result
    text = _rewrite_markdown(result)
    text = _rewrite_autolinks(text)
    return _rewrite_bare_urls(text)


def is_index_tool(tool_name: Any) -> bool:
    return isinstance(tool_name, str) and tool_name.startswith(INDEX_TOOL_PREFIXES)


#: (path, mtime_ns) -> the switch's value in `$HERMES_HOME/.env`.
_DOTENV_CACHE: dict[tuple[str, int], str] = {}


def _dotenv_switch() -> str:
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    path = os.path.join(home, ".env")
    try:
        key = (path, os.stat(path).st_mtime_ns)
    except OSError:
        return ""
    cached = _DOTENV_CACHE.get(key)
    if cached is not None:
        return cached
    value = ""
    try:
        with open(path, encoding="utf-8-sig") as handle:
            for line in handle:
                stripped = line.strip()
                if stripped.startswith("export "):
                    stripped = stripped[len("export "):].lstrip()
                name, sep, raw = stripped.partition("=")
                if sep and name.strip() == OFF_SWITCH:
                    raw = raw.strip()
                    if raw[:1] in ("'", '"'):
                        quote = raw[0]
                        raw = raw[1:].split(quote, 1)[0]
                    else:
                        raw = raw.split(" #", 1)[0].split("\t#", 1)[0].strip()
                    value = raw
    except OSError:
        return ""
    _DOTENV_CACHE.clear()
    _DOTENV_CACHE[key] = value
    return value


def switched_off() -> bool:
    """``AV_INDEX_LINKS`` is off in the process env OR in `$HERMES_HOME/.env`
    (read on its mtime, so an edit takes effect without a gateway restart, as
    ``AV_EVENTS_ENABLED`` does for av-events). Either source saying off wins, so
    a stale value Hermes loaded at boot cannot keep the rewrite on (recheck S1).
    ``export KEY=off``, quotes and a trailing ``# comment`` are accepted."""
    env = os.environ.get(OFF_SWITCH)
    if env is not None and env.strip().lower() in _OFF_VALUES:
        return True
    return _dotenv_switch().strip().lower() in _OFF_VALUES


def transform_tool_result(result: Any = None, tool_name: Any = None, **_kwargs: Any) -> Optional[str]:
    """Hook body. ``None`` means Hermes keeps the original result."""
    try:
        if not is_index_tool(tool_name) or switched_off():
            return None
        rewritten = rewrite_index_links(result)
    except Exception:
        return None
    if not isinstance(rewritten, str) or rewritten == result:
        return None
    return rewritten


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint. One hook, no tools."""
    global _REGISTERED
    if _REGISTERED:
        return
    ctx.register_hook("transform_tool_result", transform_tool_result)
    _REGISTERED = True
