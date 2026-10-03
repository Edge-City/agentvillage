"""The archive_read bearer for the Edge City dashboard (DATA-88).

The archive job reads a tenant's sessions with a per-tenant token derived from one master:
token = hex(HMAC-SHA256(ARCHIVE_READ_MASTER, "archive_read:" + tenant_id)). The sandbox holds only
SHA-256 of its own token, as `AV_ARCHIVE_READ_HASH` in `$HERMES_HOME/.env`, so it can verify that
token and nothing else.

Scope is two routes and one method: `GET /api/sessions` and `GET /api/sessions/<id>/messages`.
Hermes's token seam (`token_auth.token_auth_middleware`) matches registered paths exactly and has
no method or pattern scope, and a provider's `verify_session` never sees a path, so the scoping
lives here, in a wrapper installed around the seam at plugin `register()` time. The provider
vouches only while this wrapper is deciding an allowed route, through a scope flag that lives on
the provider instance (`new_scope()`), so the token is never accepted by the generic seam on any
other token route (the drain route, for one), and any copy of this module agrees with any copy of
the provider. A bearer the archive provider does not vouch for falls through to the seam and the
cookie gate unchanged.

Standard library only and no Hermes import: the tests drive it without Hermes.
"""

from __future__ import annotations

import contextvars
import hashlib
import hmac
import itertools
import logging
import os
import re
import threading
from typing import Any, Awaitable, Callable, Optional

HASH_ENV = "AV_ARCHIVE_READ_HASH"
PROVIDER_NAME = "edgecity-archive"
PRINCIPAL = "archive-read"
SCOPE = "archive_read"

LIST_PATH = "/api/sessions"
_MESSAGES_PATH = re.compile(r"/api/sessions/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}/messages")
#: The one line shape the control plane writes; anything else in `.env` is not a hash line.
_HASH_LINE = re.compile(rb"AV_ARCHIVE_READ_HASH=([0-9a-f]{64})\r?")
_HASH = re.compile(r"[0-9a-f]{64}")

_log = logging.getLogger("dashboard-auth-edgecity.archive")

_counts: dict[str, int] = {}
_counts_lock = threading.Lock()
_scope_ids = itertools.count()


class Decision:
    """One wrapper decision in progress. The provider records whether a hash was set, so the
    wrapper can log the reason without reading `.env` a second time."""

    __slots__ = ("hash_set",)

    def __init__(self) -> None:
        self.hash_set = False


def new_scope() -> "contextvars.ContextVar[Optional[Decision]]":
    """A provider instance's scope flag: a Decision only while a wrapper is deciding an allowed
    route on that provider, None everywhere else."""
    return contextvars.ContextVar(f"edgecity_archive_scope_{next(_scope_ids)}", default=None)


def _env_path() -> str:
    return os.path.join(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")), ".env")


def stored_hash() -> str:
    """The tenant's token hash, re-read from `.env` on every call, or "" when unusable.

    Only the exact line the control plane writes counts: `AV_ARCHIVE_READ_HASH=` followed by 64
    lowercase hex characters and the line end (`\\n`, or `\\r\\n`). No `export`, quotes,
    whitespace, comment or BOM; any other line is simply not a hash line, and the last exact line
    wins. The file is authoritative whenever it exists: Hermes loads `.env` into the process
    environment once at startup, so the environment holds the value from before the last
    re-injection. Only when the file does not exist does the environment answer, and then only
    with exactly 64 lowercase hex characters. An unreadable file is unusable."""
    try:
        with open(_env_path(), "rb") as handle:
            data = handle.read()
    except FileNotFoundError:
        value = os.environ.get(HASH_ENV, "")
        return value if _HASH.fullmatch(value) else ""
    except OSError:
        return ""
    value = ""
    for line in data.split(b"\n"):
        match = _HASH_LINE.fullmatch(line)
        if match:
            value = match.group(1).decode("ascii")
    return value


def _matches(token: str, stored: str) -> bool:
    if not stored or not token:
        return False
    try:
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    except (UnicodeError, AttributeError):
        return False
    return hmac.compare_digest(digest, stored)


def token_matches(token: str) -> bool:
    """Constant-time compare of SHA-256(token) with the stored hash; False when unset."""
    return _matches(token, stored_hash())


def verify(scope: "contextvars.ContextVar[Optional[Decision]]", token: str) -> bool:
    """The provider's whole decision. Outside a wrapper decision on this provider's own scope
    (Hermes's generic seam on another token route, say) False without reading anything; inside,
    one read of `.env`, recorded on the decision, and a constant-time compare."""
    decision = scope.get()
    if decision is None:
        return False
    stored = stored_hash()
    decision.hash_set = bool(stored)
    return _matches(token, stored)


def extract_bearer(headers: Any) -> str:
    """`Authorization: Bearer <token>` (scheme case-insensitive), as Hermes's own `extract_bearer`."""
    parts = (headers.get("authorization") or "").split(" ", 1)
    if len(parts) == 2 and parts[0].strip().lower() == "bearer":
        return parts[1].strip()
    return ""


def _path_allowed(path: Any) -> bool:
    return isinstance(path, str) and (path == LIST_PATH or _MESSAGES_PATH.fullmatch(path) is not None)


def route_allowed(method: Any, url_path: Any, scope_path: Any) -> bool:
    """GET on exactly one of the two paths.

    Both the parsed URL path (what Hermes's seam and gate match on) and the ASGI scope path
    (what the router dispatches on) must match, so a percent-encoded `?`, `#` or `/` that makes
    the two disagree is never handled here. Query strings are not part of either. No
    normalisation is applied: `//`, `..`, a trailing slash or a stray character simply fails
    the exact match and the request goes on to the cookie gate."""
    return method == "GET" and _path_allowed(url_path) and _path_allowed(scope_path)


def _count(code: str) -> None:
    """Count a decision. `accepted` is logged at INFO with the running counts; the pass-through
    codes only at DEBUG, so a desktop app polling with its session bearer does not fill the log."""
    with _counts_lock:
        _counts[code] = _counts.get(code, 0) + 1
        snapshot = ", ".join(f"{key}={_counts[key]}" for key in sorted(_counts))
    level = logging.INFO if code == "accepted" else logging.DEBUG
    _log.log(level, "dashboard-auth-edgecity: archive_read %s (%s)", code, snapshot)


def counts() -> dict[str, int]:
    with _counts_lock:
        return dict(_counts)


Middleware = Callable[[Any, Callable[[Any], Awaitable[Any]]], Awaitable[Any]]


def make_route_wrapper(original: Middleware, *, lookup_provider: Callable[[], Optional[Any]]) -> Middleware:
    """Wrap Hermes's `token_auth_middleware`.

    Considered here: a GET with a bearer on an allowed path. When the registered archive
    provider vouches for the bearer (inside its own scope, set here on the instance looked up),
    `request.state.token_principal` and `token_authenticated` are set exactly as the seam sets
    them and the request proceeds. Otherwise (not the archive token, hash unset, provider missing
    or raising) the request goes on to the original seam exactly as if this wrapper were absent,
    so Hermes's own session bearers keep working and an unknown bearer ends at the cookie gate's
    401. Every other request goes straight to the original seam too."""

    async def edgecity_archive_token_auth(request: Any, call_next: Callable[[Any], Awaitable[Any]]) -> Any:
        token = extract_bearer(request.headers)
        if not token or not route_allowed(request.method, request.url.path, request.scope.get("path")):
            return await original(request, call_next)
        try:
            provider = lookup_provider()
        except Exception:  # noqa: BLE001 - the registry must not 500 the gate
            provider = None
        scope = getattr(provider, "archive_scope", None)
        if provider is None or not isinstance(scope, contextvars.ContextVar):
            _count("passed_no_provider")
            return await original(request, call_next)
        decision = Decision()
        principal = None
        reset = scope.set(decision)
        try:
            principal = provider.verify_token(token=token)
        except Exception:  # noqa: BLE001 - a raising provider vouches for nothing, never 500s
            principal = None
        finally:
            scope.reset(reset)
        if principal is None:
            _count("passed_not_archive" if decision.hash_set else "passed_hash_unset")
            return await original(request, call_next)
        request.state.token_principal = principal
        request.state.token_authenticated = True
        _count("accepted")
        return await call_next(request)

    edgecity_archive_token_auth._edgecity_archive = True  # type: ignore[attr-defined]
    edgecity_archive_token_auth._edgecity_original = original  # type: ignore[attr-defined]
    return edgecity_archive_token_auth


def install(module: Any, *, lookup_provider: Callable[[], Optional[Any]]) -> bool:
    """Install the wrapper on `module.token_auth_middleware` (Hermes's `token_auth` module).

    Exactly one layer: a wrapper already installed (by this or an earlier load of the plugin)
    is replaced, wrapping the seam it wrapped, so a forced plugin re-discovery leaves one wrapper
    bound to the current provider. `web_server._token_auth_seam` imports the attribute at call
    time, so the replacement takes effect on the next request."""
    current = getattr(module, "token_auth_middleware", None)
    if current is None:
        return False
    base = getattr(current, "_edgecity_original", current) if getattr(current, "_edgecity_archive", False) else current
    module.token_auth_middleware = make_route_wrapper(base, lookup_provider=lookup_provider)
    return True
