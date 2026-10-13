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
  `server.dispatch` to answer only `RESIDENT_GATEWAY_METHODS` for a resident connection, and only
  on that connection's own chats (`GatewayView`): a frame that names another login's chat, answers
  a request raised on one, or answers an approval with anything but once, session or deny is
  refused (SEC1-refute2 M-new-1, S-new-1). A resident's chat runs in RESIDENT_CWD_NAME and its
  prompts carry no `@file:` / `@folder:` (S-new-3).
- **Session routes.** A listed `/api/sessions/{id}...` route answers a resident only for one of its
  own stored sessions (`session_visible`).
- **The agent's reads.** The key store joins Hermes's agent read deny-list, and `@file:` references
  to private paths under HERMES_HOME are refused for everyone (`harden_agent_reads`,
  `harden_reference_reads`; S-new-2's cheap half, custody is SEC-2).

Who is admin: `session.provider == "edgecity" and session.org_id == "admin"`, which the edgecity
provider mints only after the control plane's landing-admin exchange (`complete_login`). No session,
a token principal, another provider, any other role, or an exception in the decision is not admin.

Fail closed throughout: a request the tables do not name, an unparseable value, an exception in the
guard, a ticket without a role, or a gateway seam that did not install is a refusal, never a pass.

Standard library only and no Hermes import: the Hermes-free tests drive every decision through
stand-ins. `__init__.register()` hands the Hermes modules in.
"""

from __future__ import annotations

import contextlib
import contextvars
import inspect
import logging
import os
import re
import sys
import threading
import unicodedata
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
    # -- the resident's own sessions (SessionsPage.tsx, ChatSessionList.tsx). The list and the counts
    # are box-wide metadata (README "What a resident can see of other sessions"); a route that names
    # one session (`/api/sessions/{id}...`) answers only for a session the resident owns
    # (`session_visible`). Search, bulk delete, delete-empty and prune read or delete across sessions
    # the guard cannot attribute before the handler runs, so they are admin only --
    (GET, "/api/sessions", "list sessions (also the archive job's read-only bearer)"),
    (GET, "/api/sessions/stats", "session counts"),
    (GET, "/api/sessions/empty/count", "how many empty sessions there are"),
    (GET, "/api/sessions/{id}", "one of the resident's sessions"),
    (GET, "/api/sessions/{id}/messages", "read one of the resident's sessions (also the archive job's bearer)"),
    (GET, "/api/sessions/{id}/messages/around", "read around a message in one of the resident's sessions"),
    (GET, "/api/sessions/{id}/timeline", "one of the resident's sessions' timeline"),
    (GET, "/api/sessions/{id}/latest-descendant", "follow one of the resident's compressed sessions"),
    (GET, "/api/sessions/{id}/export", "export one of the resident's sessions as JSON"),
    (PATCH, "/api/sessions/{id}", "rename one of the resident's sessions"),
    (DELETE, "/api/sessions/{id}", "delete one of the resident's sessions"),
    # -- the web chat's uploads --
    (POST, "/api/chat/image-upload", "a pasted chat image, saved under HERMES_HOME/images with a random name"),
    # -- the overlay's approvals card --
    (GET_POST, "/api/plugins/av-approval/**",
     "reserved for av-approval's own dashboard routes (the approvals card); none is mounted at 1.3.1"),
)

#: WebSockets: socket paths a resident may open. Everything else (the console, the PTY, the PTY's
#: /api/pub and /api/events feed, TTS streaming, the display bridge, plugin sockets) is refused
#: before accept.
RESIDENT_WS_PATHS: dict[str, str] = {
    "/api/ws": "the chat gateway; what it may call is RESIDENT_GATEWAY_METHODS",
}

#: Gateway parameter rules (see `gateway_decision`). A row names any number of them.
BYTES_ONLY = "bytes_only"          # an upload from the client; a host `path` is refused
NO_ALWAYS = "no_always"            # approve once, for the session, or deny; "always" writes config.yaml
OWN_SESSION = "own_session"        # `session_id` is a live chat this connection owns (required)
OWN_SESSION_IF_GIVEN = "own_session_if_given"  # the same, when the frame names a session at all
OWN_STORED = "own_stored"          # `session_id` is a stored session the resident owns (resume, delete)
OWN_REQUEST = "own_request"        # a `request_id` must be pending on that same chat (no box-wide lookup)
PINNED_CWD = "pinned_cwd"          # the chat runs in RESIDENT_CWD_NAME; a parent must be the resident's
NO_FILE_REFS = "no_file_refs"      # no @file:/@folder: in the text, no gateway-internal `_` parameters
ANSWER = "answer"                  # answers only a request the server raised on this connection

#: Chat gateway methods on /api/ws: name -> (parameter rules, why). The SPA itself calls
#: `session.create` (ChatSidebar.tsx:219) and `model.options` (ModelPickerDialog.tsx:125); the rest
#: is what a chat client needs to hold a conversation, answer its agent and upload into it. Every
#: method also refuses a `profile` outside RESIDENT_PROFILES (the guard reads ownership from the
#: box's own session store only).
RESIDENT_GATEWAY_METHODS: dict[str, tuple[tuple[str, ...], str]] = {
    "ping": ((), "liveness"),
    "gateway.capabilities": ((), "handshake"),
    "client.capabilities": ((), "handshake"),
    "session.create": ((PINNED_CWD,), "start a chat (ChatSidebar.tsx:219), in the resident chat directory"),
    "session.resume": ((OWN_STORED,), "reopen one of the resident's chats"),
    "session.list": ((), "list chats (box-wide metadata, as GET /api/sessions)"),
    "session.most_recent": ((), "the newest chat's id and title (box-wide metadata)"),
    "session.title": ((OWN_SESSION,), "rename a chat"),
    "session.close": ((OWN_SESSION,), "close a chat"),
    "session.delete": ((OWN_STORED,), "delete one of the resident's stored chats"),
    "session.interrupt": ((OWN_SESSION,), "stop the agent's turn"),
    "session.events.since": ((OWN_SESSION,), "replay after a reconnect"),
    "prompt.submit": ((OWN_SESSION, NO_FILE_REFS), "send a message (no @file:/@folder: references)"),
    "approval.pending": ((OWN_SESSION,), "the agent's open approval prompts"),
    "approval.received": ((OWN_SESSION, OWN_REQUEST), "acknowledge an approval prompt"),
    "approval.respond": ((OWN_SESSION, OWN_REQUEST, NO_ALWAYS), "answer an approval prompt: once, session or deny"),
    "request.answer": ((ANSWER,), "answer the agent's question, by the rules of a response frame"),
    "image.attach_bytes": ((OWN_SESSION,), "upload an image into the chat"),
    "image.detach": ((OWN_SESSION,), "remove an uploaded image"),
    "file.attach": ((OWN_SESSION, BYTES_ONLY), "upload a file into the chat (data_url only)"),
    "pdf.attach": ((OWN_SESSION, BYTES_ONLY), "upload a PDF into the chat (content_base64 only)"),
    "model.options": ((OWN_SESSION_IF_GIVEN,), "read the model list (ModelPickerDialog.tsx:125)"),
}

#: Server-to-client requests a resident may answer, by a response frame (`server_requests.py:201`)
#: or `request.answer`: the request's method -> (rule, why). Everything else the agent can ask over
#: the socket (`sudo`, `secret`, whose answer `agent_callbacks.py:205-207` saves into .env, the vault
#: prompts, the desktop GUI reads, `tour`, `display.install.sudo`) is an admin's to answer.
RESIDENT_SERVER_REQUESTS: dict[str, tuple[Optional[str], str]] = {
    "approval": (NO_ALWAYS, "a dangerous-command prompt: once, session or deny (server.py:790-792)"),
    "clarify": (None, "the agent's question to the user"),
}

#: Stored-session sources that are the resident's whoever is signed in: the box's messaging channels
#: (one tenant per box; Hermes stamps the platform's sender as `user_id`). Any other stored session
#: is the resident's only when its `user_id` is the resident's own dashboard login
#: (`<provider>:<user id>`, `tui_gateway/server.py:2402`). So a landing admin's dashboard chats, the
#: terminal's (`tui`/`cli`, no login) and cron's are not.
RESIDENT_SESSION_SOURCES: dict[str, str] = {
    "telegram": "the village channel",
    "whatsapp": "messaging channel",
    "signal": "messaging channel",
    "discord": "messaging channel",
    "slack": "messaging channel",
    "sms": "messaging channel",
    "email": "messaging channel",
}

#: The `profile` values a resident may name: none, or the box's one profile.
RESIDENT_PROFILES = frozenset({"", "default"})

#: The directory under HERMES_HOME a resident's chats run in (S-new-3), created on first use: empty
#: but for an `AGENTS.md` link to the box's own, so the agent keeps the village rules. Not
#: HERMES_HOME (config.yaml, plugins, hooks, the key store) and not `/`.
RESIDENT_CWD_NAME = "resident-chat"

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
FORBIDDEN_SESSION = {"error": "forbidden", "detail": "That session is not yours.", "reason": "not_own_session"}
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
_installed: dict[str, bool] = {"http": False, "tickets": False, "ws": False, "gateway": False, "files": False,
                               "agent_reads": False, "references": False}
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
        query = request.scope.get("query_string", b"")
        if request_names_private_path(url_path, scope_path, query):
            return "denied_private_path"
        return session_route_code(request, url_path, scope_path, query)
    except Exception:  # noqa: BLE001 - a broken request or session object is refused
        return "denied_error"


# ---- whose session is it (S-new-1) ---------------------------------------------------------------

#: Hermes's own literal subroutes of /api/sessions (`web_routers/sessions.py`): never a session id.
_SESSION_SUBROUTES = frozenset({"search", "stats", "empty", "bulk-delete", "prune", "import", "owner-backfill"})
#: Dashboard login providers: a `user_id` of the form `<one of these>:<id>` is a dashboard login,
#: so a stored session carrying another one is not the resident's, whatever its source.
_LOGIN_PROVIDERS = frozenset({"edgecity", "basic", "nous", "self_hosted", "drain", "oidc", "bot-desktop", "internal"})

#: `lookup(session_id, profile, prefix=bool) -> {"id", "user_id", "source"} or None`, handed in by
#: `__init__` (Hermes's own session store, read only). None: nothing names a session (fail closed).
_session_lookup: Optional[Callable[..., Optional[dict]]] = None


def set_session_lookup(fn: Optional[Callable[..., Optional[dict]]]) -> None:
    global _session_lookup
    _session_lookup = fn


def login_id(provider: Any, user_id: Any) -> Optional[str]:
    """`<provider>:<user id>`, as Hermes stamps a dashboard login on a session
    (`tui_gateway/server.py:2402`), or None."""
    if type(provider) is str and type(user_id) is str and provider.strip() and user_id.strip():
        return f"{provider.strip()}:{user_id.strip()}"
    return None


def session_visible(row: Any, login: Optional[str]) -> bool:
    """Whether a stored session is the resident's: its `user_id` is the resident's own login, or it
    came in on one of the box's messaging channels and no other dashboard login owns it."""
    if not isinstance(row, dict):
        return False
    owner = row.get("user_id")
    if login is not None and type(owner) is str and owner == login:
        return True
    if type(owner) is str and ":" in owner and owner.split(":", 1)[0].strip() in _LOGIN_PROVIDERS:
        return False
    source = row.get("source")
    return type(source) is str and source in RESIDENT_SESSION_SOURCES


def _profile_param(query: Any) -> Optional[str]:
    if isinstance(query, (bytes, bytearray)):
        query = bytes(query).decode("latin-1")
    values = [v for k, v in urllib.parse.parse_qsl(query or "", keep_blank_values=True) if k == "profile"]
    return values[-1] if values else None


def _session_route_id(path: Any) -> Optional[str]:
    """The `{id}` of a listed `/api/sessions/{id}...` route, or None for any other path."""
    row = http_row("GET", path) or http_row("PATCH", path) or http_row("DELETE", path)
    if row is None or not row[1].startswith("/api/sessions/{id}"):
        return None
    return _segments(path)[2]


def session_route_code(request: Any, url_path: Any, scope_path: Any, query: Any) -> str:
    """A listed route that names one stored session answers a resident only for the resident's own
    (`session_visible`), looked up the way the handler resolves it (exact id, else a unique prefix,
    in the `?profile=` store). No lookup, a failed lookup, an unknown id, a Hermes subroute word or
    URL and scope paths that name different ids: refused. The archive job's bearer (a token
    principal, scoped by `_archive` to two read routes) reads every session, as before."""
    ids = {_session_route_id(url_path), _session_route_id(scope_path)}
    if ids == {None}:
        return "resident_allowed"
    state = request.state
    if getattr(state, "token_authenticated", False) or getattr(state, "token_principal", None) is not None:
        return "resident_allowed"
    if len(ids) != 1 or None in ids:
        return "denied_session_route"
    (session_id,) = ids
    if session_id in _SESSION_SUBROUTES:
        return "denied_not_listed"
    lookup = _session_lookup
    if lookup is None:
        return "denied_session_lookup"
    profile = _profile_param(query)
    row = lookup(session_id, profile, prefix=True)
    session = getattr(state, "session", None)
    login = login_id(getattr(session, "provider", None), getattr(session, "user_id", None))
    if not session_visible(row, login):
        return "denied_not_own_session"
    return "resident_allowed"


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
                body = (FORBIDDEN_PRIVATE if code == "denied_private_path" else
                        FORBIDDEN_SESSION if code.startswith("denied_session") or code == "denied_not_own_session"
                        else FORBIDDEN)
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


def minting_role() -> str:
    """The role a ticket minted now carries. Inside a chat-gateway call (`display.observe` mints the
    Bot Desktop ticket there, `methods_display.py:162`) it is the connection's role; otherwise the
    HTTP request's (`POST /api/auth/ws-ticket`). Only an admin's is admin; the PTY child's, a
    resident's, or none is a resident's."""
    gateway = _GATEWAY_ROLE.get()
    if gateway is not None:
        return ROLE_ADMIN if gateway == ROLE_ADMIN else ROLE_RESIDENT
    return ROLE_ADMIN if _REQUEST_ROLE.get() == ROLE_ADMIN else ROLE_RESIDENT


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
        extra[TICKET_ROLE_KEY] = minting_role()
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


#: `@file:` / `@folder:` references (Hermes's own pattern is `agent/context_references.py:77`; this
#: one is broader on purpose: any case, anywhere in the text).
_FILE_REF = re.compile(r"@(?:file|folder):", re.IGNORECASE)
#: Bracketed-paste markers Hermes strips before expanding (`hermes_cli/input_sanitize.py:50`).
_PASTE_MARKERS = ("\x1b[200~", "\x1b[201~", "[200~", "[201~")
#: Hermes's own prompt sanitiser, handed in by `__init__`, so the check also sees what Hermes sees.
_prompt_sanitizer: Optional[Callable[[str], Any]] = None


def set_prompt_sanitizer(fn: Optional[Callable[[str], Any]]) -> None:
    global _prompt_sanitizer
    _prompt_sanitizer = fn


def names_file_reference(text: Any) -> bool:
    """Whether prompt text carries an `@file:` or `@folder:` reference: as written, after Hermes's
    own sanitiser, and once Unicode is folded and control, format and space characters and paste
    markers are dropped (so `@fi<ZWSP>le:` and `＠file:` count). Text that is not a string, or a
    sanitiser that fails, counts as a reference (fail closed)."""
    if text is None:
        return False
    if not isinstance(text, str):
        return True
    forms = [text]
    try:
        folded = unicodedata.normalize("NFKC", text)
        for marker in _PASTE_MARKERS:
            folded = folded.replace(marker, "")
        forms.append("".join(ch for ch in folded if unicodedata.category(ch)[0] not in ("C", "Z")))
        if _prompt_sanitizer is not None:
            forms.append(_prompt_sanitizer(text))
    except Exception:  # noqa: BLE001
        return True
    return any(not isinstance(form, str) or _FILE_REF.search(form) for form in forms)


def resident_cwd() -> Optional[str]:
    """The directory a resident's chats run in: `<HERMES_HOME>/<RESIDENT_CWD_NAME>`, created (0700)
    on first use, with an `AGENTS.md` link to the box's own when there is one. None (the chat is
    refused) when it cannot be made or is not a plain directory where it should be (a symlink put
    there would move the chat back into HERMES_HOME)."""
    try:
        home = os.path.realpath(_hermes_home())
        path = os.path.join(home, RESIDENT_CWD_NAME)
        if os.path.islink(path):
            return None
        os.makedirs(path, mode=0o700, exist_ok=True)
        if os.path.realpath(path) != path or not os.path.isdir(path) or private_path(path):
            return None
    except Exception:  # noqa: BLE001
        return None
    try:
        link = os.path.join(path, "AGENTS.md")
        if not os.path.lexists(link) and os.path.isfile(os.path.join(home, "AGENTS.md")):
            os.symlink(os.path.join("..", "AGENTS.md"), link)
    except OSError:
        pass  # the chat still runs; the agent then has no AGENTS.md in it
    return path


def _within(value: Any, root: str) -> bool:
    """`value`, resolved as Hermes resolves a chat's cwd (`~`, relative to the process) and then
    through symlinks, is `root` or inside it."""
    try:
        if type(value) is not str or not value.strip():
            return False
        resolved = os.path.realpath(os.path.expanduser(value.strip()))
        return resolved == root or resolved.startswith(root.rstrip(os.sep) + os.sep)
    except Exception:  # noqa: BLE001
        return False


def _role_of_ws(ws: Any) -> str:
    role = getattr(ws, "_edgecity_ws_role", None)
    return role if role in (ROLE_ADMIN, ROLE_INTERNAL, ROLE_RESIDENT) else ROLE_RESIDENT


#: The attribute on a gateway transport (`tui_gateway.ws.WSTransport`) that holds what this
#: connection created: {"sids": live chat ids, "keys": their stored ids}.
_OWN_ATTR = "_edgecity_own"


def _own(transport: Any) -> Optional[dict]:
    own = getattr(transport, _OWN_ATTR, None)
    if isinstance(own, dict):
        return own
    own = {"sids": set(), "keys": set()}
    try:
        setattr(transport, _OWN_ATTR, own)
    except Exception:  # noqa: BLE001 - nothing remembered: only the login can make a chat its own
        return None
    return own


class GatewayView:
    """What the decision reads about one resident connection and Hermes's live state:

    - the connection's login, as Hermes stamps it on the chats it creates
      (`server._transport_auth_user_id`, `server.py:2402`), and the chats it created here;
    - the live chats (`server._sessions`) and whether this transport is attached to one
      (`server._session_transport_contains`, `session_transports.py:20`);
    - the open server requests (`server_requests._open`, `server_requests.py:75`);
    - a chat's pending approvals (`tools.approval.list_gateway_approvals`);
    - the stored-session lookup (`set_session_lookup`).

    Anything missing answers "not yours" (fail closed)."""

    def __init__(self, transport: Any, server: Any, requests: Any = None, approvals: Any = None) -> None:
        self.transport = transport
        self.server = server
        self._requests = requests
        self._approvals = approvals
        self.own = _own(transport)
        self.login = self._login()

    def _login(self) -> Optional[str]:
        stamp = getattr(self.server, "_transport_auth_user_id", None)
        if callable(stamp):
            value = stamp(self.transport)
            return value if type(value) is str and value else None
        identity = getattr(self.transport, "auth_identity", None)
        if isinstance(identity, dict):
            return login_id(identity.get("provider"), identity.get("user_id"))
        return None

    def _records(self) -> list:
        sessions = getattr(self.server, "_sessions", None)
        if not isinstance(sessions, dict):
            return []
        lock = getattr(self.server, "_sessions_lock", None)
        with (lock if lock is not None else contextlib.nullcontext()):
            return [(sid, rec) for sid, rec in list(sessions.items()) if isinstance(rec, dict)]

    def live(self, sid: Any) -> Optional[dict]:
        if type(sid) is not str or not sid:
            return None
        sessions = getattr(self.server, "_sessions", None)
        record = sessions.get(sid) if isinstance(sessions, dict) else None
        return record if isinstance(record, dict) else None

    def own_live(self, sid: Any) -> bool:
        """A live chat this connection created, or one stamped with this connection's login (a
        reconnect, a resume). Never one stamped with another login, the PTY's (none) included."""
        record = self.live(sid)
        if record is None or self.own is None:
            return False
        owner = record.get("auth_user_id")
        if sid in self.own["sids"]:
            return owner == self.login
        return self.login is not None and owner == self.login

    def attached(self, sid: Any) -> bool:
        record = self.live(sid)
        contains = getattr(self.server, "_session_transport_contains", None)
        return record is not None and callable(contains) and bool(contains(record, self.transport))

    def own_stored(self, key: Any, profile: Any) -> bool:
        """A stored session the resident may reopen or delete: one this connection created, or one
        `session_visible` names the resident's. Never one that a live chat under another login (or
        none, the PTY's) holds right now."""
        if type(key) is not str or not key or self.own is None:
            return False
        for _sid, record in self._records():
            if record.get("session_key") == key and record.get("auth_user_id") != self.login:
                return False
            if record.get("session_key") == key and self.login is None and key not in self.own["keys"]:
                return False
        if key in self.own["keys"]:
            return True
        lookup = _session_lookup
        if lookup is None:
            return False
        return session_visible(lookup(key, profile or None, prefix=False), self.login)

    def pending_approval(self, sid: Any, request_id: Any) -> bool:
        record = self.live(sid)
        approvals = self._approvals
        if approvals is None:
            module = sys.modules.get("tools.approval")
            approvals = getattr(module, "list_gateway_approvals", None)
        if record is None or not callable(approvals) or type(request_id) is not str:
            return False
        pending = approvals(str(record.get("session_key") or ""))
        return any(isinstance(p, dict) and p.get("request_id") == request_id for p in pending or ())

    def open_request(self, rid: Any) -> Optional[tuple]:
        """(method, chat id) of the open server request `rid`, or None."""
        module = self._requests if self._requests is not None else sys.modules.get("tui_gateway.server_requests")
        opened = getattr(module, "_open", None)
        if type(rid) is not str or not isinstance(opened, dict):
            return None
        lock = getattr(module, "_lock", None)
        with (lock if lock is not None else contextlib.nullcontext()):
            request = opened.get(rid)
        if request is None:
            return None
        return getattr(request, "method", None), getattr(request, "sid", None)

    def remember(self, response: Any) -> None:
        """After `session.create` answered: the new chat and its stored id are this connection's."""
        result = response.get("result") if isinstance(response, dict) else None
        if not isinstance(result, dict) or self.own is None:
            return
        sid, key = result.get("session_id"), result.get("stored_session_id")
        if type(sid) is str and sid:
            self.own["sids"].add(sid)
        if type(key) is str and key:
            self.own["keys"].add(key)


def _choice_ok(container: Any) -> bool:
    """No `choice` (Hermes reads it as deny) or exactly once, session or deny."""
    if not isinstance(container, dict):
        return False
    if "choice" not in container:
        return True
    choice = container["choice"]
    return type(choice) is str and choice in APPROVAL_CHOICES


def answer_code(rid: Any, result: Any, is_error: bool, view: Optional[GatewayView]) -> str:
    """A resident's answer to a server request (a response frame or `request.answer`): only to an
    open request the server raised on a chat this connection owns and is attached to, of a kind in
    RESIDENT_SERVER_REQUESTS, and for an approval only once, session or deny (M-new-1). An error
    answer (the client cannot show it) withdraws the request and is let through."""
    if view is None:
        return "denied_answer_unknown"
    opened = view.open_request(rid)
    if opened is None:
        return "denied_answer_unknown"
    method, sid = opened
    if not (view.own_live(sid) and view.attached(sid)):
        return "denied_answer_foreign"
    if type(method) is not str or method not in RESIDENT_SERVER_REQUESTS:
        return "denied_answer_kind"
    if is_error:
        return "resident_allowed"
    if not isinstance(result, dict):
        return "denied_answer_result"
    if RESIDENT_SERVER_REQUESTS[method][0] == NO_ALWAYS and not _choice_ok(result):
        return "denied_gateway_always"
    return "resident_allowed"


def gateway_decision(role: Any, req: Any, view: Optional[GatewayView] = None) -> tuple[str, Any]:
    """(`admin_allowed` / `resident_allowed` or a denial code, the frame to dispatch). Admin and the
    PTY child: everything. A resident: a response frame by `answer_code`; a method on
    RESIDENT_GATEWAY_METHODS with its rules, no profile but the box's and no path parameter that
    names a private file. A rule that needs live state and has no view refuses."""
    if role in (ROLE_ADMIN, ROLE_INTERNAL):
        return "admin_allowed", req
    if not isinstance(req, dict):
        return "denied_gateway_method", req
    if "method" not in req:
        if "id" not in req or not ("result" in req or "error" in req):
            return "denied_gateway_frame", req
        return answer_code(req.get("id"), req.get("result"), "error" in req, view), req
    method = req.get("method")
    if not isinstance(method, str) or method not in RESIDENT_GATEWAY_METHODS:
        return "denied_gateway_method", req
    params = req.get("params")
    params = {} if params is None else params
    if not isinstance(params, dict):
        return "denied_gateway_params", req
    for key, value in params.items():
        if isinstance(key, str) and key.lower() in PATH_PARAMS and value not in (None, "") and private_path(value):
            return "denied_gateway_private_path", req
    profile = params.get("profile")
    if profile is not None and (type(profile) is not str or profile.strip() not in RESIDENT_PROFILES):
        return "denied_gateway_profile", req
    rules = RESIDENT_GATEWAY_METHODS[method][0]
    sid = params.get("session_id")
    if BYTES_ONLY in rules and str(params.get("path") or "").strip():
        return "denied_gateway_params", req
    if NO_ALWAYS in rules and not _choice_ok(params):
        return "denied_gateway_always", req
    if OWN_SESSION in rules or (OWN_SESSION_IF_GIVEN in rules and sid not in (None, "")):
        if view is None or not view.own_live(sid):
            return "denied_gateway_session", req
    if OWN_REQUEST in rules and params.get("request_id") not in (None, ""):
        if view is None or not view.pending_approval(sid, params.get("request_id")):
            return "denied_gateway_session", req
    if OWN_STORED in rules and (view is None or not view.own_stored(sid, profile)):
        return "denied_gateway_session", req
    if NO_FILE_REFS in rules:
        if any(type(k) is not str or k.startswith("_") for k in params):
            return "denied_gateway_params", req
        if names_file_reference(params.get("text")):
            return "denied_gateway_file_ref", req
    if ANSWER in rules:
        code = answer_code(params.get("id"), params.get("result"), False, view)
        if code != "resident_allowed":
            return code, req
    if PINNED_CWD in rules:
        parent = params.get("parent_session_id")
        if parent not in (None, "") and (view is None or not view.own_stored(parent, profile)):
            return "denied_gateway_session", req
        cwd = resident_cwd()
        if cwd is None:
            return "denied_gateway_cwd", req
        given = params.get("cwd")
        if given in (None, ""):
            req = {**req, "params": {**params, "cwd": cwd}}
        elif not _within(given, cwd):
            return "denied_gateway_cwd", req
    return "resident_allowed", req


def gateway_method_allowed(role: Any, method: Any, params: Any, view: Optional[GatewayView] = None) -> bool:
    """`gateway_decision` for a method call, as a yes or no."""
    code, _ = gateway_decision(role, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, view)
    return code in ("admin_allowed", "resident_allowed")


#: Denials a client sees as "not your session" rather than "admin only".
_SESSION_CODES = frozenset({"denied_gateway_session", "denied_answer_foreign"})


def _refusal(req: Any, method: Any, code: str = "denied_gateway_method") -> dict:
    rid = req.get("id") if isinstance(req, dict) else None
    reason = "not_own_session" if code in _SESSION_CODES else "admin_only"
    return {"jsonrpc": "2.0", "id": rid, "error": {
        "code": GATEWAY_REFUSAL_CODE, "message": "This gateway method is admin only." if reason == "admin_only"
        else "That chat is not this connection's.",
        "data": {"reason": reason, "method": method if isinstance(method, str) else None}}}


def install_gateway(server_module: Any, ws_module: Any, requests_module: Any = None, approvals: Any = None) -> bool:
    """Wrap `tui_gateway.ws.handle_ws` (the connection's role into a context variable) and
    `tui_gateway.server.dispatch` (a resident connection's frame answered only by
    `gateway_decision`). A dispatch with no dashboard socket behind it (the stdio TUI, in-process
    callers) is untouched. Both or neither: without both, `_installed["gateway"]` stays False and
    /api/ws stays closed to residents. `requests_module` is `tui_gateway.server_requests` and
    `approvals` is `tools.approval.list_gateway_approvals` (both looked up in `sys.modules` at call
    time when not given)."""
    dispatch = getattr(server_module, "dispatch", None)
    handle_ws = getattr(ws_module, "handle_ws", None)
    base_dispatch = _unwrap(dispatch) if callable(dispatch) else None
    base_handle = _unwrap(handle_ws) if callable(handle_ws) else None
    if base_dispatch is None or base_handle is None:
        return False

    def guarded_call(role: str, req: Any, transport: Any, args: tuple, kwargs: dict) -> Any:
        if role in (ROLE_ADMIN, ROLE_INTERNAL):
            return base_dispatch(req, transport, *args, **kwargs)
        method = req.get("method") if isinstance(req, dict) else None
        try:
            view = GatewayView(transport, server_module, requests_module, approvals)
            code, frame = gateway_decision(role, req, view)
        except Exception:  # noqa: BLE001
            _count("denied_gateway_error")
            return _refusal(req, None)
        if code != "resident_allowed":
            _count(code if code.startswith("denied_") else "denied_gateway_method")
            return _refusal(req, method, code)
        response = base_dispatch(frame, transport, *args, **kwargs)
        if method == "session.create":
            try:
                view.remember(response)
            except Exception:  # noqa: BLE001 - the chat is then only its login's, as after a reconnect
                _count("gateway_remember_error")
        return response

    def dispatch_guarded(req: Any, transport: Any = None, *args: Any, **kwargs: Any) -> Any:
        role = _GATEWAY_ROLE.get()
        if role is None and (transport is None or not hasattr(transport, "auth_identity")):
            return base_dispatch(req, transport, *args, **kwargs)
        token = None
        try:
            if role is None:
                # A socket outside the handle_ws context: its own role, carried for this call (a
                # ticket minted inside it, `minting_role`).
                role = _role_of_ws(getattr(transport, "_ws", None))
                token = _GATEWAY_ROLE.set(role)
            return guarded_call(role, req, transport, args, kwargs)
        finally:
            if token is not None:
                _GATEWAY_ROLE.reset(token)

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


# ---- Hermes's agent reads (S-new-2, S-new-3) -----------------------------------------------------


def home_private_path(value: Any) -> bool:
    """`private_path` for a path inside HERMES_HOME or the Hermes checkout (resolved); a path
    elsewhere is left to Hermes. Anything unreadable is private."""
    try:
        resolved = os.path.realpath(os.path.expanduser(os.fspath(value)))
        roots = [os.path.realpath(_hermes_home())] + list(_private_roots)
        inside = any(resolved == r or resolved.startswith(r.rstrip(os.sep) + os.sep) for r in roots)
        return inside and private_path(resolved)
    except Exception:  # noqa: BLE001
        return True


def harden_reference_reads(module: Any) -> bool:
    """Wrap `agent.context_references._ensure_reference_path_allowed` (read at call time by
    `_expand_path_reference`, `context_references.py:291`) so an `@file:`/`@folder:` reference to a
    private path under HERMES_HOME (config.yaml, plugins/, hooks/, the key store, the state store)
    is refused for every caller: a second line behind the gateway's refusal of the tokens, and the
    same rule for the messaging gateway where this plugin loads."""
    current = getattr(module, "_ensure_reference_path_allowed", None)
    base = _unwrap(current) if callable(current) else None
    if base is None:
        return False

    def _ensure_reference_path_allowed(path: Any, *args: Any, **kwargs: Any) -> Any:
        result = base(path, *args, **kwargs)
        if home_private_path(path):
            _count("denied_context_reference")
            raise ValueError("path is private to this box and cannot be attached")
        return result

    module._ensure_reference_path_allowed = _mark(_ensure_reference_path_allowed, base)
    _installed["references"] = True
    return True


#: What the agent is told when it reads the dashboard's key store (`agent/file_safety.py:329`).
_KEY_DIR_MESSAGES = (
    "is private to the dashboard sign-in plugin (its key store or code) and cannot be read directly.",
    "is inside the dashboard sign-in plugin's private files and cannot be read directly.",
)


def harden_agent_reads(module: Any, directories: Iterable[Any]) -> bool:
    """Add `directories` (relative to each Hermes home, or absolute) to Hermes's agent read
    deny-list, `agent.file_safety._READ_DENIED_DIRS` (a tuple of (subdir, dir message, file
    message), read at call time by `get_read_block_error`, `file_safety.py:343-385`; read_file and
    `@file:` both consult it). False, changing nothing, when the tuple or the function is not there
    in that shape: `__init__` then refuses to load. Defence in depth only: the agent's terminal can
    still read the store (SEC-2 moves the key out of its reach)."""
    current = getattr(module, "_READ_DENIED_DIRS", None)
    if not callable(getattr(module, "get_read_block_error", None)) or not isinstance(current, tuple):
        return False
    if not all(isinstance(e, tuple) and len(e) == 3 and all(isinstance(x, str) for x in e) for e in current):
        return False
    have = {entry[0] for entry in current}
    wanted = [str(d) for d in directories if d and str(d) not in have]
    module._READ_DENIED_DIRS = current + tuple((d, *_KEY_DIR_MESSAGES) for d in dict.fromkeys(wanted))
    _installed["agent_reads"] = True
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
