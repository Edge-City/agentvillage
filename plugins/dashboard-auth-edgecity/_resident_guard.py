"""The resident guard for the Edge City dashboard (SEC-1): residents get a named set, admins get all.

Hermes's dashboard is an operator console: behind the ordinary login it installs plugins, edits
config.yaml and .env, reads and writes any file the `hermes` user can, and opens a shell. On a
village box the resident's login is that ordinary login. So this module turns the dashboard into a
closed allow-list for every session that is not a landing admin, on three seams:

- **HTTP.** A wrapper around Hermes's cookie gate (`dashboard_auth.middleware.gated_auth_middleware`,
  imported by `web_server._dashboard_auth_gate` at call time, `web_server.py:645`) calls the gate
  with a guarded `call_next`. The gate has set `request.state.session` by then on every
  authenticated path (`middleware.py:129/:170/:201`). An edgecity admin passes; anything else may use
  only the routes in `RESIDENT_HTTP` and gets a 403 everywhere else.
- **WebSockets.** HTTP middleware never sees a websocket scope, so the role travels with the ticket.
  `POST /api/auth/ws-ticket` (`dashboard_auth/routes.py:458`) mints through `ws_tickets.mint_ticket`
  (imported at call time, :463), which this module wraps to stamp the minting request's role into
  the ticket's own info (`ws_tickets.py:36`, the `extra` dict). `web_server_chat._ws_auth_reason`
  (`web_server_chat.py:220`), which every gated socket but the display bridge calls before accepting
  (the console and PTY through `chat_ws._ws_gate` :118, the sidecars through `_ws_auth_ok` :298),
  is wrapped to read the role back from the consumed ticket, stamp it on the socket, and refuse a
  socket path the role may not open (`RESIDENT_WS_PATHS`). The console (`/api/console`) and the PTY
  (`/api/pty`) are therefore admin only. The display bridge consumes its own ticket
  (`web_routers/display.py:61`); a display ticket minted under a non-admin request is refused there.
- **Gateway methods.** `/api/ws` (`chat_ws.py:583`) runs the TUI JSON-RPC table through
  `tui_gateway.server.dispatch(req, transport)` (`tui_gateway/ws.py:361`). This module wraps
  `tui_gateway.ws.handle_ws` (imported by the route at call time, `chat_ws.py:588`) to carry the
  socket's role in a context variable that `asyncio.to_thread` copies into every dispatch, and wraps
  `server.dispatch` to answer only `RESIDENT_GATEWAY_METHODS` for a resident connection.

Who is admin: `session.provider == "edgecity" and session.org_id == "admin"`, which the edgecity
provider mints only after the control plane's landing-admin exchange (`complete_login`). No session,
a token principal, another provider, any other role, or an exception in the decision is not admin.

Fail closed throughout: a request the tables do not name, an unparseable value, an exception in the
guard, a ticket without a role, or a gateway seam that did not install is a refusal, never a pass.

Standard library only and no Hermes import: the Hermes-free tests drive every decision through
stand-ins. `__init__.register()` hands the Hermes modules in.
"""

from __future__ import annotations

import contextvars
import inspect
import logging
import os
import threading
import urllib.parse
from typing import Any, AsyncIterator, Awaitable, Callable, Iterable, Optional

ADMIN_PROVIDER = "edgecity"
ADMIN_ROLE = "admin"

ROLE_ADMIN = "admin"
ROLE_RESIDENT = "resident"
#: The PTY child's own connections back into the dashboard (`?internal=`, `ws_tickets.py:71`). Only a
#: PTY spawns them, and the PTY is admin only.
ROLE_INTERNAL = "internal"

#: The key this module adds to a ticket's info dict (`ws_tickets.mint_ticket(extra=...)`).
TICKET_ROLE_KEY = "edgecity_role"

GET = frozenset({"GET", "HEAD"})
POST = frozenset({"POST"})
PATCH = frozenset({"PATCH"})
DELETE = frozenset({"DELETE"})
GET_POST = GET | POST

#: The non-API pages: the SPA index (every client route), its bundle under /assets, fonts and icons.
#: A GET on any path whose first segment is not in SPA_RESERVED. Hermes's `serve_spa`
#: (`web_server_dashboard.py:217`) serves only a file inside the built dist or the index there, and
#: the `/assets` mount (:213) only the dist's bundle.
SPA = "<spa>"
SPA_RESERVED = frozenset({"api", "auth", "login", "docs", "redoc", "openapi.json", "dashboard-plugins"})

# ==================================================================================================
# THE RESIDENT ALLOW-LIST. Carter edits these three tables; nothing else needs to change.
# A session that is not an edgecity admin may use what is named here and nothing else.
# ==================================================================================================

#: HTTP: (methods, path pattern, why). A pattern is matched on path segments: a literal segment
#: matches itself, `{x}` matches exactly one non-empty segment, a final `**` matches one or more
#: further segments, and SPA is the page rule above. Both the URL path and the ASGI scope path must
#: match a row. GET rows also allow HEAD.
RESIDENT_HTTP: tuple[tuple[frozenset, str, str], ...] = (
    # -- signing in and out (Hermes `dashboard_auth/routes.py`; the gate lets these through without a
    # session, so an admin who is not yet signed in arrives here as "not admin" too) --
    (GET, "/login", "the sign-in page"),
    (GET, "/auth/login", "start of the landing-admin SSO redirect"),
    (GET, "/auth/callback", "end of the landing-admin SSO redirect"),
    (POST, "/auth/password-login", "the resident's email-code sign-in"),
    (POST, "/auth/logout", "sign out"),
    (GET, "/auth/native/authorize", "the desktop app's sign-in (RFC 8252)"),
    (POST, "/auth/native/token", "the desktop app's sign-in token exchange"),
    (POST, "/auth/native/refresh", "the desktop app's token refresh"),
    (GET, "/api/auth/providers", "which sign-in forms to show"),
    (GET, "/api/auth/me", "who is signed in (the SPA reads it on every page)"),
    (POST, "/api/auth/ws-ticket", "a single-use ticket for the chat socket; the ticket carries the role"),
    # -- the rest of Hermes's public paths (`dashboard_auth/public_paths.py`): open to anyone with no
    # session at all, so refusing them to a resident protects nothing and would break the probes --
    (GET, "/api/health", "public liveness probe"),
    (GET, "/api/status", "public status probe; the sidebar strip reads it"),
    (GET, "/api/config/defaults", "public, read-only"),
    (GET, "/api/config/schema", "public, read-only"),
    (GET, "/api/model/info", "public, read-only model metadata"),
    (GET, "/api/dashboard/themes", "public theme manifest"),
    (GET, "/api/dashboard/plugins", "public dashboard-plugin manifest (every page loads it)"),
    (POST, "/api/cron/fire", "public; carries its own signed token, which the handler verifies"),
    (GET, "/api/mcp/oauth/callback/**", "public OAuth redirect target for an MCP flow an admin started"),
    # -- the page shell --
    (GET, SPA, "the dashboard pages, the bundle, fonts and icons (static files and the index only)"),
    (GET, "/dashboard-plugins/**", "enabled dashboard plugins' static JS and CSS (suffix-filtered by Hermes)"),
    (GET, "/api/profiles", "profile read for the profile switcher"),
    (GET, "/api/profiles/active", "profile read: which profile the pages show"),
    (GET, "/api/dashboard/font", "the saved font preference"),
    # -- the resident's own sessions (SessionsPage.tsx, ChatSessionList.tsx); one tenant per box --
    (GET, "/api/sessions", "list sessions (also the archive job's read-only bearer)"),
    (GET, "/api/sessions/search", "search sessions"),
    (GET, "/api/sessions/stats", "session counts"),
    (GET, "/api/sessions/empty/count", "how many empty sessions there are"),
    (GET, "/api/sessions/{id}", "one session"),
    (GET, "/api/sessions/{id}/messages", "read a session (also the archive job's read-only bearer)"),
    (GET, "/api/sessions/{id}/messages/around", "read around a search hit"),
    (GET, "/api/sessions/{id}/timeline", "a session's timeline"),
    (GET, "/api/sessions/{id}/latest-descendant", "follow a compressed session to its newest part"),
    (GET, "/api/sessions/{id}/export", "export a session as JSON"),
    (PATCH, "/api/sessions/{id}", "rename a session"),
    (DELETE, "/api/sessions/{id}", "delete a session"),
    (POST, "/api/sessions/bulk-delete", "delete selected sessions"),
    (DELETE, "/api/sessions/empty", "delete empty sessions"),
    (POST, "/api/sessions/prune", "delete sessions older than N days"),
    # -- the web chat's uploads --
    (POST, "/api/chat/image-upload", "a pasted chat image, saved under HERMES_HOME/images with a random name"),
    # -- the overlay's approvals card --
    (GET_POST, "/api/plugins/av-approval/**",
     "reserved for av-approval's own dashboard routes (the approvals card); none is mounted at 1.3.0"),
)

#: WebSockets: socket paths a resident may open. Everything else (the console, the PTY, the PTY's
#: /api/pub and /api/events feed, TTS streaming, the display bridge, plugin sockets) is refused
#: before accept.
RESIDENT_WS_PATHS: dict[str, str] = {
    "/api/ws": "the chat gateway; what it may call is RESIDENT_GATEWAY_METHODS",
}

#: Gateway parameter rules (see `gateway_method_allowed`).
BYTES_ONLY = "bytes_only"  # an upload from the client; a host `path` is refused
NO_ALWAYS = "no_always"    # approve once or for the session; "always" writes config.yaml

#: Chat gateway methods on /api/ws: name -> (parameter rule or None, why). The SPA itself calls
#: `session.create` (ChatSidebar.tsx:219) and `model.options` (ModelPickerDialog.tsx:125); the rest
#: is what a chat client needs to hold a conversation, answer its agent and upload into it.
RESIDENT_GATEWAY_METHODS: dict[str, tuple[Optional[str], str]] = {
    "ping": (None, "liveness"),
    "gateway.capabilities": (None, "handshake"),
    "client.capabilities": (None, "handshake"),
    "session.create": (None, "start a chat (ChatSidebar.tsx:219)"),
    "session.resume": (None, "reopen a chat"),
    "session.list": (None, "list chats"),
    "session.most_recent": (None, "reopen the last chat"),
    "session.title": (None, "rename a chat"),
    "session.close": (None, "close a chat"),
    "session.delete": (None, "delete a chat"),
    "session.interrupt": (None, "stop the agent's turn"),
    "session.events.since": (None, "replay after a reconnect"),
    "prompt.submit": (None, "send a message"),
    "approval.pending": (None, "the agent's open approval prompts"),
    "approval.received": (None, "acknowledge an approval prompt"),
    "approval.respond": (NO_ALWAYS, "answer an approval prompt: once, session or deny"),
    "request.answer": (None, "answer the agent's question"),
    "image.attach_bytes": (None, "upload an image into the chat"),
    "image.detach": (None, "remove an uploaded image"),
    "file.attach": (BYTES_ONLY, "upload a file into the chat (data_url only)"),
    "pdf.attach": (BYTES_ONLY, "upload a PDF into the chat (content_base64 only)"),
    "model.options": (None, "read the model list (ModelPickerDialog.tsx:125)"),
}

# ==================================================================================================

#: Where the PTY child connects back with the internal credential (`web_server_chat.py:438-445`).
INTERNAL_WS_PATHS = frozenset({"/api/ws", "/api/pub"})
APPROVAL_CHOICES = frozenset({"once", "session", "deny"})

# ---- private paths (design rule 3) ---------------------------------------------------------------

#: Directory names whose whole subtree is private, wherever they sit: this plugin's key and session
#: store, plugin code, hook scripts, the Hermes checkout.
PRIVATE_DIR_NAMES = frozenset({".dashboard-auth-edgecity", "plugins", "hooks", "agent-hooks", "hermes-agent"})
#: File basenames that are private wherever they sit: dotenv files, the state database, this
#: plugin's session store, config.yaml. (Also any `.env.<x>` and `<x>.env`.)
PRIVATE_FILE_NAMES = frozenset({
    ".env", ".envrc", ".op.env", "state.db", "state.db-wal", "state.db-shm", "state.db-journal",
    "sessions.sqlite3", "config.yaml",
})
#: Names checked on the URL path itself: never part of a legitimate dashboard URL.
PRIVATE_URL_SEGMENTS = frozenset({".dashboard-auth-edgecity", "hermes-agent", "agent-hooks"}) | PRIVATE_FILE_NAMES
#: Query and gateway parameters that carry a filesystem path.
PATH_PARAMS = frozenset({"path", "file", "file_path", "filepath", "filename", "root", "cwd", "dir", "directory",
                         "target", "src", "source", "dest", "destination"})

FORBIDDEN = {"error": "forbidden", "detail": "This dashboard feature is admin only.", "reason": "admin_only"}
FORBIDDEN_PRIVATE = {"error": "forbidden", "detail": "That path is private.", "reason": "private_path"}
GATEWAY_REFUSAL_CODE = 4031
WS_REFUSAL = "edgecity_admin_only"

#: What the SPA's index.html carries and no other HTML response does: Hermes's bootstrap script
#: (`web_server_dashboard.py:_serve_index`).
_INDEX_MARKER = b"window.__HERMES_BASE_PATH__="
_HEAD_END = b"</head>"
_HIDE_MARK = b'data-edgecity="plugins-admin-only"'
#: Upper bound on an HTML body read for the hide; a bigger one is passed on untouched.
MAX_HTML_BYTES = 4 * 1024 * 1024
#: Two rules, not one selector list: a browser without `:has` drops only the second.
HIDE_SNIPPET = (
    b'<style data-edgecity="plugins-admin-only">'
    b'nav a[href$="/plugins"]{display:none!important}'
    b"</style>"
    b'<style data-edgecity="plugins-admin-only">'
    b'nav li:has(> a[href$="/plugins"]){display:none!important}'
    b"</style>"
    b'<script data-edgecity="plugins-admin-only">'
    b"(function(){try{"
    b'var b=String(window.__HERMES_BASE_PATH__||"").replace(/\\/+$/,"");'
    b'var t=(b+"/plugins").toLowerCase();'
    b'function g(){var p=String(location.pathname||"").toLowerCase().replace(/\\/+$/,"");'
    b'if(p===t){location.replace(b+"/");}}'
    b'g();window.addEventListener("popstate",g);'
    b'["pushState","replaceState"].forEach(function(k){var o=history[k];if(typeof o!=="function")return;'
    b"history[k]=function(){var r=o.apply(this,arguments);g();return r;};});"
    b"}catch(e){}})();"
    b"</script>"
)

_log = logging.getLogger("dashboard-auth-edgecity.resident-guard")

_counts: dict[str, int] = {}
_counts_lock = threading.Lock()

#: The role of the HTTP request being served, set by the gate wrapper before `call_next` (the
#: endpoint runs in a task that copies this context) and read by the ticket-mint wrapper.
_REQUEST_ROLE: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("edgecity_request_role", default=None)
#: The role `consume_ticket` just read from a ticket, for the `_ws_auth_reason` wrapper that called
#: it (one synchronous call, one context).
_CONSUMED_ROLE: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("edgecity_consumed_role", default=None)
#: The role of the /api/ws connection whose frames are being dispatched (set by the `handle_ws`
#: wrapper; `asyncio.to_thread` and the long-handler pool copy it).
_GATEWAY_ROLE: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("edgecity_gateway_role", default=None)

#: Which seams this copy of the module installed. /api/ws opens to a resident only while the
#: gateway seam is in place (`ws_path_allowed`).
_installed: dict[str, bool] = {"http": False, "tickets": False, "ws": False, "gateway": False, "files": False}
#: Extra private roots (the Hermes checkout), set by `set_private_roots`.
_private_roots: list[str] = []
#: Loaders `__init__` hands in for the seams that live in modules too heavy to import at plugin
#: load (`tui_gateway.server` starts threads at import): called the first time they are needed.
_loaders: dict[str, Optional[Callable[[], Any]]] = {"gateway": None, "files": None}
_install_lock = threading.Lock()
#: Seams whose module was there but would not take the wrapper: not retried on every request.
_failed: set[str] = set()


def _count(code: str) -> None:
    """Count a decision. Denials at INFO with the running counts; allows and the hide at DEBUG.
    Never the email, a token, a ticket or a path."""
    with _counts_lock:
        _counts[code] = _counts.get(code, 0) + 1
        snapshot = ", ".join(f"{key}={_counts[key]}" for key in sorted(_counts))
    level = logging.INFO if code.startswith("denied_") else logging.DEBUG
    _log.log(level, "dashboard-auth-edgecity: resident guard %s (%s)", code, snapshot)


def counts() -> dict[str, int]:
    with _counts_lock:
        return dict(_counts)


def installed() -> dict[str, bool]:
    return dict(_installed)


def set_loader(name: str, loader: Optional[Callable[[], Any]]) -> None:
    _loaders[name] = loader


# ---- who is admin --------------------------------------------------------------------------------


def admin_code(state: Any) -> str:
    """`admin_allowed` for an edgecity admin session and nothing else; otherwise the denial code."""
    if getattr(state, "token_authenticated", False) or getattr(state, "token_principal", None) is not None:
        return "denied_token_principal"
    session = getattr(state, "session", None)
    if session is None:
        return "denied_no_session"
    provider = getattr(session, "provider", None)
    role = getattr(session, "org_id", None)
    if type(provider) is not str or provider != ADMIN_PROVIDER:
        return "denied_other_provider"
    if type(role) is not str or role != ADMIN_ROLE:
        return "denied_non_admin"
    return "admin_allowed"


# ---- path matching -------------------------------------------------------------------------------

_DOTS = ("", ".", "..")


def _segments(path: Any) -> Optional[list[str]]:
    """`/a/b` -> ["a", "b"]; `/` -> []; None for anything that is not an absolute path."""
    if not isinstance(path, str) or not path.startswith("/"):
        return None
    if path == "/":
        return []
    return path[1:].split("/")


def pattern_matches(pattern: str, path: Any) -> bool:
    segs = _segments(path)
    if segs is None:
        return False
    if pattern == SPA:
        if not segs:
            return True
        return (segs[0] not in SPA_RESERVED and all(s not in _DOTS for s in segs[:-1])
                and segs[-1] not in (".", ".."))
    want = _segments(pattern)
    if want is None:
        return False
    if want and want[-1] == "**":
        head = want[:-1]
        if len(segs) <= len(head) or any(s in _DOTS for s in segs[len(head):]):
            return False
        segs, want = segs[: len(head)], head
    if len(segs) != len(want):
        return False
    for w, s in zip(want, segs):
        if w.startswith("{") and w.endswith("}"):
            if s in _DOTS:
                return False
        elif w != s:
            return False
    return True


def http_row(method: Any, path: Any) -> Optional[tuple]:
    """The RESIDENT_HTTP row that names this method and path, or None."""
    if not isinstance(method, str):
        return None
    for row in RESIDENT_HTTP:
        if method in row[0] and pattern_matches(row[1], path):
            return row
    return None


def http_allowed(method: Any, url_path: Any, scope_path: Any) -> bool:
    """Both the URL path (what Hermes's gate matches on) and the scope path (what the router
    dispatches on) must be named by the table. No normalisation."""
    return http_row(method, url_path) is not None and http_row(method, scope_path) is not None


# ---- private paths -------------------------------------------------------------------------------


def set_private_roots(roots: Iterable[Any]) -> None:
    """Extra trees that are private whatever their names (the Hermes checkout outside HERMES_HOME)."""
    _private_roots[:] = [os.path.realpath(str(r)) for r in roots if r]


def _hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _name_private(part: str) -> bool:
    low = part.lower()
    return (low in PRIVATE_DIR_NAMES or low in PRIVATE_FILE_NAMES or low.startswith(".env.")
            or (low.endswith(".env") and len(low) > 4))


def _parts(path: str) -> list[str]:
    return [p for p in path.replace("\\", "/").split("/") if p]


def private_path(value: Any) -> bool:
    """Whether a filesystem path names a private file, as written and as resolved (symlinks, `~`,
    `..`, a `file:` URL; a relative path is taken from HERMES_HOME). Anything that cannot be read as
    a path is private (fail closed)."""
    try:
        if not isinstance(value, str):
            return True
        raw = value.strip()
        if not raw:
            return False
        if raw.lower().startswith("file:"):
            raw = urllib.parse.unquote(urllib.parse.urlsplit(raw).path or "")
        if "\x00" in raw or any(_name_private(p) for p in _parts(raw)):
            return True
        home = os.path.realpath(_hermes_home())
        resolved = os.path.realpath(os.path.join(home, os.path.expanduser(raw)))
        if any(_name_private(p) for p in _parts(resolved)):
            return True
        roots = [os.path.join(home, n) for n in (".dashboard-auth-edgecity", "plugins", "hooks", "hermes-agent")]
        for root in roots + list(_private_roots):
            if resolved == root or resolved.startswith(root.rstrip("/") + "/"):
                return True
        return False
    except Exception:  # noqa: BLE001
        return True


def _url_private(path: Any) -> bool:
    if not isinstance(path, str):
        return True
    for part in _parts(path):
        low = part.lower()
        if low in PRIVATE_URL_SEGMENTS or low.startswith(".env.") or (low.endswith(".env") and len(low) > 4):
            return True
    return False


def _looks_like_path(value: str) -> bool:
    return value.startswith(("/", "~", "\\")) or value.lower().startswith("file:") or "/." in value


def request_names_private_path(url_path: Any, scope_path: Any, query: Any) -> bool:
    """Design rule 3, on both URL paths and every path-carrying query parameter."""
    if _url_private(url_path) or _url_private(scope_path):
        return True
    if isinstance(query, (bytes, bytearray)):
        query = bytes(query).decode("latin-1")
    if not isinstance(query, str):
        return True
    for key, value in urllib.parse.parse_qsl(query, keep_blank_values=True):
        if (key.lower() in PATH_PARAMS or _looks_like_path(value)) and private_path(value):
            return True
    return False


# ---- HTTP ----------------------------------------------------------------------------------------


def http_decision(request: Any) -> str:
    """`admin_allowed`, `resident_allowed` or a denial code. Any exception is a denial."""
    try:
        code = admin_code(request.state)
        if code == "admin_allowed":
            return code
        url_path = request.url.path
        scope_path = request.scope.get("path")
        if not http_allowed(request.method, url_path, scope_path):
            return "denied_not_listed"
        if request_names_private_path(url_path, scope_path, request.scope.get("query_string", b"")):
            return "denied_private_path"
        return "resident_allowed"
    except Exception:  # noqa: BLE001 - a broken request or session object is refused
        return "denied_error"


#: Never read for the hide: API responses, the login page and the auth flow.
_NO_HIDE_PREFIXES = ("/api/", "/auth/", "/login")


def _hide_candidate(request: Any) -> bool:
    try:
        if request.method != "GET":
            return False
        paths = (request.url.path, request.scope.get("path"))
        return all(isinstance(p, str) and not p.startswith(_NO_HIDE_PREFIXES) for p in paths)
    except Exception:  # noqa: BLE001
        return False


def inject_hide(html: bytes) -> Optional[bytes]:
    """The SPA index with the hide inserted before the first `</head>` (after Hermes's bootstrap
    script), or None when `html` is not the SPA index or already carries it."""
    if _INDEX_MARKER not in html or _HIDE_MARK in html:
        return None
    end = html.find(_HEAD_END)
    if end < 0:
        return None
    return html[:end] + HIDE_SNIPPET + html[end:]


def _html_candidate(response: Any) -> bool:
    if getattr(response, "status_code", None) != 200:
        return False
    headers = getattr(response, "headers", None)
    if headers is None:
        return False
    ctype = headers.get("content-type") or ""
    if not isinstance(ctype, str) or not ctype.lower().startswith("text/html"):
        return False
    return not headers.get("content-encoding")


def _set_length(response: Any, length: int) -> None:
    headers = response.headers
    if headers.get("content-length") is not None:
        headers["content-length"] = str(length)


async def _replay(head: list, rest: AsyncIterator[Any]) -> AsyncIterator[Any]:
    for chunk in head:
        yield chunk
    async for chunk in rest:
        yield chunk


async def _one(body: bytes) -> AsyncIterator[bytes]:
    yield body


async def _replay_then_raise(head: list, exc: BaseException) -> AsyncIterator[Any]:
    for chunk in head:
        yield chunk
    raise exc


async def hide_plugins_page(response: Any) -> Any:
    """Insert the Plugins hide into the SPA index. A plain response (`body` bytes) is patched in
    place; a streamed one (`body_iterator`: what Starlette's `call_next` hands every HTTP middleware)
    is read up to MAX_HTML_BYTES and replaced with one chunk. Anything else, an ASGI message in the
    stream, a body over the cap or a body that is not the index, goes out byte-identical."""
    if not _html_candidate(response):
        return response
    body = getattr(response, "body", None)
    if isinstance(body, (bytes, bytearray)):
        patched = inject_hide(bytes(body))
        if patched is not None:
            response.body = patched
            _set_length(response, len(patched))
            _count("html_hidden")
        return response
    iterator = getattr(response, "body_iterator", None)
    if iterator is None or not hasattr(iterator, "__aiter__"):
        return response
    head: list = []
    size = 0
    stream = iterator.__aiter__()
    complete = True
    try:
        async for chunk in stream:
            head.append(chunk)
            if not isinstance(chunk, (bytes, bytearray)):
                complete = False
                break
            size += len(chunk)
            if size > MAX_HTML_BYTES:
                complete = False
                break
    except Exception as exc:  # noqa: BLE001 - the app's own failure, re-raised where it would have been
        response.body_iterator = _replay_then_raise(head, exc)
        return response
    if not complete:
        response.body_iterator = _replay(head, stream)
        return response
    whole = b"".join(bytes(c) for c in head)
    patched = inject_hide(whole)
    if patched is None:
        response.body_iterator = _one(whole)
        return response
    response.body_iterator = _one(patched)
    _set_length(response, len(patched))
    _count("html_hidden")
    return response


Middleware = Callable[[Any, Callable[[Any], Awaitable[Any]]], Awaitable[Any]]


def make_gate_wrapper(original: Middleware, *, json_response: Callable[..., Any]) -> Middleware:
    """Wrap Hermes's `gated_auth_middleware`: the gate runs as before, with a guarded `call_next`.

    The guard runs only when the gate hands the request on, so the gate's own 401/302/503 stay as
    they are. An edgecity admin proceeds. Anything else proceeds only on a RESIDENT_HTTP row whose
    paths name no private file; otherwise a 403. An exception in the decision is a 403, never a pass
    and never a 500. The request's role rides into the endpoint in a context variable, where the
    ticket-mint wrapper reads it. The SPA index under a non-admin gets the Plugins hide."""

    async def edgecity_resident_gate(request: Any, call_next: Callable[[Any], Awaitable[Any]]) -> Any:
        async def guarded(req: Any) -> Any:
            _ensure("files")
            code = http_decision(req)
            _count(code)
            if code not in ("admin_allowed", "resident_allowed"):
                body = FORBIDDEN_PRIVATE if code == "denied_private_path" else FORBIDDEN
                return json_response(dict(body), status_code=403)
            token = _REQUEST_ROLE.set(ROLE_ADMIN if code == "admin_allowed" else ROLE_RESIDENT)
            try:
                response = await call_next(req)
            finally:
                _REQUEST_ROLE.reset(token)
            if code == "resident_allowed" and _hide_candidate(req):
                try:
                    response = await hide_plugins_page(response)
                except Exception:  # noqa: BLE001 - the hide is cosmetic; never break a page over it
                    _count("html_hide_error")
            return response

        return await original(request, guarded)

    edgecity_resident_gate._edgecity_resident_guard = True  # type: ignore[attr-defined]
    edgecity_resident_gate._edgecity_original = original  # type: ignore[attr-defined]
    return edgecity_resident_gate


def _unwrap(current: Any) -> Any:
    """The original under any wrapper of ours (this or an earlier load of the plugin, including the
    1.2.0 marker), so exactly one layer is ever installed."""
    for _ in range(8):
        if not (getattr(current, "_edgecity_resident_guard", False) or getattr(current, "_edgecity_plugins_admin", False)):
            return current
        current = getattr(current, "_edgecity_original", None)
    return None


def _mark(fn: Any, original: Any) -> Any:
    fn._edgecity_resident_guard = True
    fn._edgecity_original = original
    return fn


def install(module: Any, *, json_response: Optional[Callable[..., Any]] = None) -> bool:
    """Install the HTTP wrapper on `module.gated_auth_middleware` (Hermes's
    `dashboard_auth.middleware`). Exactly one layer. False (nothing changed) when the gate or a
    response class is missing."""
    current = getattr(module, "gated_auth_middleware", None)
    factory = json_response if json_response is not None else getattr(module, "JSONResponse", None)
    base = _unwrap(current) if current is not None else None
    if base is None or factory is None:
        return False
    module.gated_auth_middleware = make_gate_wrapper(base, json_response=factory)
    _installed["http"] = True
    return True


# ---- tickets -------------------------------------------------------------------------------------


def _takes_extra(fn: Any) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return "extra" in params or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())


def install_tickets(module: Any) -> bool:
    """Wrap `ws_tickets.mint_ticket` (stamp the minting request's role into the ticket) and
    `ws_tickets.consume_ticket` (hand the role to the socket-auth wrapper; refuse a display ticket a
    non-admin request minted). A ticket without a role is a resident's."""
    mint = getattr(module, "mint_ticket", None)
    consume = getattr(module, "consume_ticket", None)
    invalid = getattr(module, "TicketInvalid", None)
    if not callable(mint) or not callable(consume) or not isinstance(invalid, type):
        return False
    base_mint, base_consume = _unwrap(mint), _unwrap(consume)
    if base_mint is None or base_consume is None or not _takes_extra(base_mint):
        # A Hermes whose tickets cannot carry `extra` (before 0.21.5): no role rides in a ticket, so
        # every socket is a resident's (fail closed: the console and terminal close to admins too).
        return False

    def mint_ticket(*args: Any, **kwargs: Any) -> Any:
        extra = dict(kwargs.get("extra") or {})
        extra[TICKET_ROLE_KEY] = ROLE_ADMIN if _REQUEST_ROLE.get() == ROLE_ADMIN else ROLE_RESIDENT
        kwargs["extra"] = extra
        return base_mint(*args, **kwargs)

    def consume_ticket(*args: Any, **kwargs: Any) -> Any:
        info = base_consume(*args, **kwargs)
        role = ROLE_ADMIN if isinstance(info, dict) and info.get(TICKET_ROLE_KEY) == ROLE_ADMIN else ROLE_RESIDENT
        if isinstance(info, dict) and info.get("provider") == "bot-desktop" and role != ROLE_ADMIN:
            _count("denied_display_ticket")
            raise invalid("display ticket minted outside an admin session")
        _CONSUMED_ROLE.set(role)
        return info

    module.mint_ticket = _mark(mint_ticket, base_mint)
    module.consume_ticket = _mark(consume_ticket, base_consume)
    _installed["tickets"] = True
    return True


# ---- sockets -------------------------------------------------------------------------------------


def ws_role(credential: Any, ticket_role: Any) -> str:
    """The role a socket gets from what authenticated it: an admin-minted ticket is admin; the
    internal credential is the PTY child's; a resident's ticket, the loopback token or anything
    unknown is a resident."""
    if credential == "internal":
        return ROLE_INTERNAL
    if credential in ("ticket", "ticket-subprotocol") and ticket_role == ROLE_ADMIN:
        return ROLE_ADMIN
    return ROLE_RESIDENT


def ws_path_allowed(role: Any, url_path: Any, scope_path: Any) -> bool:
    """Admin: every socket. The PTY child: /api/ws and /api/pub. A resident: RESIDENT_WS_PATHS, and
    /api/ws only once the gateway method guard is installed. Both paths must agree."""
    if role == ROLE_ADMIN:
        return True
    if not isinstance(url_path, str) or url_path != scope_path:
        return False
    if role == ROLE_INTERNAL:
        return url_path in INTERNAL_WS_PATHS
    if url_path not in RESIDENT_WS_PATHS:
        return False
    if url_path == "/api/ws" and not _ensure("gateway"):
        return False
    return True


def _socket_paths(ws: Any) -> tuple[Any, Any]:
    url = getattr(ws, "url", None)
    scope = getattr(ws, "scope", None) or {}
    return getattr(url, "path", None), scope.get("path")


def install_ws(module: Any) -> bool:
    """Wrap `web_server_chat._ws_auth_reason`: after Hermes accepts the credential, stamp the
    socket's role (`ws._edgecity_ws_role`) and refuse a socket path the role may not open, with the
    reason `edgecity_admin_only` (Hermes then closes it before accept: 4401). Any exception in the
    guard is a refusal."""
    current = getattr(module, "_ws_auth_reason", None)
    base = _unwrap(current) if callable(current) else None
    if base is None:
        return False

    def _ws_auth_reason(ws: Any) -> Any:
        token = _CONSUMED_ROLE.set(None)
        try:
            result = base(ws)
            ticket_role = _CONSUMED_ROLE.get()
        finally:
            _CONSUMED_ROLE.reset(token)
        try:
            reason, credential = result
        except Exception:  # noqa: BLE001
            return "edgecity_guard_error", "unknown"
        if reason is not None:
            return reason, credential
        try:
            role = ws_role(credential, ticket_role)
            ws._edgecity_ws_role = role
            url_path, scope_path = _socket_paths(ws)
            if ws_path_allowed(role, url_path, scope_path):
                _count(f"ws_{role}_allowed")
                return None, credential
            _count(f"denied_ws_{role}")
            return WS_REFUSAL, credential
        except Exception:  # noqa: BLE001
            _count("denied_ws_error")
            return "edgecity_guard_error", credential

    module._ws_auth_reason = _mark(_ws_auth_reason, base)
    _installed["ws"] = True
    return True


def close_embedded_chat(module: Any) -> bool:
    """The one allowed exception to "find the seam" (design rule 4): when the socket seam is
    missing, turn Hermes's embedded chat off for every session (`web_server.py:383`; the console,
    PTY and chat sockets then close before accept)."""
    if not hasattr(module, "_DASHBOARD_EMBEDDED_CHAT_ENABLED"):
        return False
    module._DASHBOARD_EMBEDDED_CHAT_ENABLED = False
    return True


# ---- gateway methods -----------------------------------------------------------------------------


def _role_of_ws(ws: Any) -> str:
    role = getattr(ws, "_edgecity_ws_role", None)
    return role if role in (ROLE_ADMIN, ROLE_INTERNAL, ROLE_RESIDENT) else ROLE_RESIDENT


def gateway_method_allowed(role: Any, method: Any, params: Any) -> bool:
    """Admin and the PTY child: every method. A resident: RESIDENT_GATEWAY_METHODS, with its
    parameter rule, and no path parameter that names a private file."""
    if role in (ROLE_ADMIN, ROLE_INTERNAL):
        return True
    if not isinstance(method, str) or method not in RESIDENT_GATEWAY_METHODS:
        return False
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return False
    rule = RESIDENT_GATEWAY_METHODS[method][0]
    if rule == BYTES_ONLY and str(params.get("path") or "").strip():
        return False
    if rule == NO_ALWAYS and params.get("choice", "deny") not in APPROVAL_CHOICES:
        return False
    for key, value in params.items():
        if isinstance(key, str) and key.lower() in PATH_PARAMS and value not in (None, "") and private_path(value):
            return False
    return True


def _refusal(req: Any, method: Any) -> dict:
    rid = req.get("id") if isinstance(req, dict) else None
    return {"jsonrpc": "2.0", "id": rid, "error": {
        "code": GATEWAY_REFUSAL_CODE, "message": "This gateway method is admin only.",
        "data": {"reason": "admin_only", "method": method if isinstance(method, str) else None}}}


def install_gateway(server_module: Any, ws_module: Any) -> bool:
    """Wrap `tui_gateway.ws.handle_ws` (the connection's role into a context variable) and
    `tui_gateway.server.dispatch` (a resident connection's request answered only on the method
    list). A dispatch with no dashboard socket behind it (the stdio TUI, in-process callers) is
    untouched. Both or neither: without both, `_installed["gateway"]` stays False and /api/ws stays
    closed to residents."""
    dispatch = getattr(server_module, "dispatch", None)
    handle_ws = getattr(ws_module, "handle_ws", None)
    base_dispatch = _unwrap(dispatch) if callable(dispatch) else None
    base_handle = _unwrap(handle_ws) if callable(handle_ws) else None
    if base_dispatch is None or base_handle is None:
        return False

    def dispatch_guarded(req: Any, transport: Any = None, *args: Any, **kwargs: Any) -> Any:
        try:
            role = _GATEWAY_ROLE.get()
            if role is None:
                if transport is None or not hasattr(transport, "auth_identity"):
                    return base_dispatch(req, transport, *args, **kwargs)
                role = _role_of_ws(getattr(transport, "_ws", None))
            if role in (ROLE_ADMIN, ROLE_INTERNAL) or (isinstance(req, dict) and "method" not in req):
                # Admin, the PTY child, or a client's answer to one of the server's own requests
                # (approval, clarify: `server_requests.is_response_frame`), which calls no method.
                return base_dispatch(req, transport, *args, **kwargs)
            method = req.get("method") if isinstance(req, dict) else None
            allowed = gateway_method_allowed(role, method, req.get("params") if isinstance(req, dict) else None)
        except Exception:  # noqa: BLE001
            _count("denied_gateway_error")
            return _refusal(req, None)
        if not allowed:
            _count("denied_gateway_method")
            return _refusal(req, method)
        return base_dispatch(req, transport, *args, **kwargs)

    async def handle_ws_guarded(ws: Any, *args: Any, **kwargs: Any) -> Any:
        token = _GATEWAY_ROLE.set(_role_of_ws(ws))
        try:
            return await base_handle(ws, *args, **kwargs)
        finally:
            _GATEWAY_ROLE.reset(token)

    server_module.dispatch = _mark(dispatch_guarded, base_dispatch)
    ws_module.handle_ws = _mark(handle_ws_guarded, base_handle)
    _installed["gateway"] = True
    return True


# ---- Hermes's own read guard ---------------------------------------------------------------------


def harden_file_routes(files_module: Any) -> bool:
    """Add this plugin's private directory to Hermes's own read guard for the Files and /api/fs
    routes (`web_routers/files.py:78`, read at call time by `_is_sensitive_path`), for every
    session, admins included: nobody downloads the signing key through the dashboard."""
    names = getattr(files_module, "_SENSITIVE_MANAGED_DIR_NAMES", None)
    if not isinstance(names, (frozenset, set)):
        return False
    files_module._SENSITIVE_MANAGED_DIR_NAMES = frozenset(names) | {".dashboard-auth-edgecity"}
    _installed["files"] = True
    return True


_INSTALLERS = {"gateway": lambda mods: install_gateway(*mods), "files": harden_file_routes}


def _ensure(name: str) -> bool:
    """Install a lazily loaded seam the first time it is needed. False when it is not in place."""
    if _installed.get(name):
        return True
    loader = _loaders.get(name)
    if loader is None or name in _failed:
        return False
    with _install_lock:
        if _installed.get(name):
            return True
        if name in _failed:
            return False
        try:
            loaded = loader()
            if loaded is None:  # not imported in this process (yet): nothing to guard there
                return False
            ok = bool(_INSTALLERS[name](loaded))
        except Exception as exc:  # noqa: BLE001
            ok = False
            _log.warning("dashboard-auth-edgecity: resident guard seam %s not installed (%s)", name, type(exc).__name__)
        if not ok:
            _failed.add(name)
            _count(f"denied_seam_{name}_missing")
        elif name == "gateway":
            _log.info("dashboard-auth-edgecity: resident guard on the chat gateway's methods")
        return ok
