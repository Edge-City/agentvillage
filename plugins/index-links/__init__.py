"""Rewrite Index URLs in tool results.

Hermes calls ``transform_tool_result`` after a tool returns and before the
model sees the result. A string return replaces that result. ``None`` leaves
it unchanged.

A signed accept link (``action=accept``) gains ``surface=telegram``. The
signature does not cover surface, and a plain ``/o/<id>`` opportunity link
is left as Index minted it. Every other ``index.network`` URL, including
``/u/<userId>``, keeps its path on ``agents.edgecity.live``. A signed
decline link is left as Index minted it.
"""

from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_OPP_PATH = re.compile(r"^/o/([A-Za-z0-9_-]+)/?$")
_INTENT_PATH = re.compile(r"^/i/([A-Za-z0-9_-]+)/?$")
_INDEX_URL = re.compile(r"https?://(?:[A-Za-z0-9-]+\.)*index\.network(?:/[^\s<>\"'\\)\]]*)?", re.IGNORECASE)
_INDEX_HOST = re.compile(r"^(https?://)(?:[A-Za-z0-9-]+\.)*index\.network", re.IGNORECASE)
_INDEX_MARKDOWN = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")
_INDEX_AUTOLINK = re.compile(r"<(https?://(?:[A-Za-z0-9-]+\.)*index\.network[^>\s]*)>", re.IGNORECASE)
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


def _query(url: str) -> dict[str, str]:
    return dict(parse_qsl(urlsplit(url).query, keep_blank_values=True))


def _with_surface(url: str) -> str:
    """Append ``surface=telegram``. Surface is not part of the signature."""
    parts = urlsplit(url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key not in ("surface", "to")]
    query.append(("surface", _SURFACE))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def rewrite_opportunity_link(url: str) -> str:
    """A signed accept link gains ``surface=telegram``. A plain ``/o/<id>`` stays."""
    action = _query(url).get("action", "")
    if action == "accept" and _query(url).get("viewer") and _query(url).get("sig"):
        return _with_surface(url)
    return url


def rewrite_intent_link(url: str) -> str:
    """``/i/<intentId>``. Same path on the portal."""
    return rewrite_remaining_index_link(url)


def rewrite_remaining_index_link(url: str) -> str:
    """Any other ``index.network`` URL, with the host swapped."""
    return _INDEX_HOST.sub(r"\1" + _PORTAL_HOST, url, count=1)


def _map_url(url: str) -> Optional[str]:
    path = _url_path(url)
    if not path:
        return None
    if _OPP_PATH.fullmatch(path):
        return rewrite_opportunity_link(url)
    if _INTENT_PATH.fullmatch(path):
        return rewrite_intent_link(url)
    return rewrite_remaining_index_link(url)


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
        return _map_url(match.group(1)) or ""

    return _INDEX_AUTOLINK.sub(sub, text)


def _rewrite_bare_urls(text: str) -> str:
    def sub(match: re.Match[str]) -> str:
        return _map_url(match.group(0)) or ""

    return _INDEX_URL.sub(sub, text)


def rewrite_index_links(result: Any) -> Any:
    """Replace Index URLs in a tool-result string. Anything else is returned as-is."""
    if not isinstance(result, str) or "index.network" not in result.lower():
        return result
    text = _rewrite_markdown(result)
    text = _rewrite_autolinks(text)
    return _rewrite_bare_urls(text)


def transform_tool_result(result: Any = None, **_kwargs: Any) -> Optional[str]:
    """Hook body. ``None`` means Hermes keeps the original result."""
    try:
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
