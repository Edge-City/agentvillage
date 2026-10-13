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
  socket path the role may not open (`RESIDENT_WS_PATHS`). The console (`/api/console`) is
  therefore admin only. The display bridge consumes its own ticket (`web_routers/display.py:61`); a
  display ticket minted under a non-admin request is refused there.
- **The Chat tab (1.4.0).** A resident's `/api/pty` opens only on `pty_admission`'s terms, and its
  `hermes --tui` child attaches to the gateway with a credential minted for that one PTY and bound
  to the resident's login (`PtyGrant`, `install_pty`), never the process-wide one: on /api/ws and
  /api/pub that child is the resident, and the credential is revoked when the PTY ends.
- **Gateway methods.** `/api/ws` (`chat_ws.py:583`) runs the TUI JSON-RPC table through
  `tui_gateway.server.dispatch(req, transport)` (`tui_gateway/ws.py:361`). This module wraps
  `tui_gateway.ws.handle_ws` (imported by the route at call time, `chat_ws.py:588`) to carry the
  socket's role in a context variable that `asyncio.to_thread` copies into every dispatch, and wraps
  `server.dispatch` to answer only `RESIDENT_GATEWAY_METHODS` for a resident connection, and only
  on that connection's own chats (`GatewayView`): a frame that names another login's chat, answers
  a request raised on one, or answers an approval with anything but once, session or deny is
  refused (SEC1-refute2 M-new-1, S-new-1). A resident's chat runs in RESIDENT_CWD_NAME and its
  prompts carry no `@folder:` and no `@file:` but to a file in RESIDENT_FILE_DIRS (S-new-3, S-r3-2).
- **Session routes and lists.** A listed `/api/sessions/{id}...` route answers a resident only for
  one of its own stored sessions (`session_visible`), and every session list a resident keeps
  (`GET /api/sessions`, gateway `session.list` and `session.most_recent`) carries only those rows
  (SEC1-refute2 S-r3-1).
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

import asyncio
import contextlib
import contextvars
import hashlib
import hmac
import inspect
import ipaddress
import logging
import os
import re
import secrets
import sys
import threading
import time
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
    # -- the resident's own sessions (SessionsPage.tsx, ChatSessionList.tsx). The list carries only
    # the resident's own rows (`resident_session_list`; `?full=1` is admin only), and a route that
    # names one session (`/api/sessions/{id}...`) answers only for a session the resident owns
    # (`session_visible`). The box-wide counts (stats, empty count), search, bulk delete,
    # delete-empty and prune read or delete across sessions the guard cannot attribute before the
    # handler runs, so they are admin only --
    (GET, "/api/sessions", "list the resident's own sessions (the archive job's read-only bearer: all)"),
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
     "reserved for av-approval's own dashboard routes (the approvals card); none is mounted at 1.4.0"),
)

#: WebSockets: socket paths a resident may open. Everything else (the console, the browser's
#: /api/pub and /api/events feed, TTS streaming, the display bridge, plugin sockets) is refused
#: before accept. The Chat tab's own child connects back on /api/ws and /api/pub with a credential
#: bound to the resident's login (`PtyGrant`), never the process-wide one.
RESIDENT_WS_PATHS: dict[str, str] = {
    "/api/ws": "the chat gateway; what it may call is RESIDENT_GATEWAY_METHODS",
    "/api/pty": "the Chat tab (1.4.0): `hermes --tui` on this dashboard's gateway as the resident's own login, "
                "under the RESIDENT_PTY_* rules (`pty_admission`)",
}

#: The Chat tab (1.4.0). A resident's `/api/pty` may name no `profile` but none or "current"
#: (Hermes's own unscoped spellings, `web_server_chat.py:325-327`): any other scopes HERMES_HOME
#: and skips the attach URL, so the TUI would spawn a gateway the guard never sees.
RESIDENT_PTY_PROFILES = frozenset({"", "current"})
#: Chat terminals one resident login holds at once. Hermes's registry holds 16 for the whole box
#: (`web_server_chat.py:47`); at this limit the login's own oldest detached terminal is closed to
#: make room, and if every one is attached the new one is refused.
RESIDENT_PTYS_PER_LOGIN = 3
#: Sockets one PTY credential may hold open at once on each of /api/ws and /api/pub: the TUI's
#: connection, plus one for a reconnect racing the old socket's close.
PTY_SOCKETS_PER_PATH = 2
#: Channels remembered with the login that first opened a Chat tab on them (Hermes's channel id,
#: `chat_ws.py:52`). When full, a resident cannot claim a new one (fail closed).
PTY_CHANNELS_MAX = 4096
#: A PTY credential minted for a chat that never spawned (a reattach, a failed start) is dropped
#: at the latest after this many seconds.
PTY_UNBOUND_SECONDS = 120

#: Gateway parameter rules (see `gateway_decision`). A row names any number of them.
BYTES_ONLY = "bytes_only"          # an upload from the client; a host `path` is refused
NO_ALWAYS = "no_always"            # approve once, for the session, or deny; "always" writes config.yaml
OWN_SESSION = "own_session"        # `session_id` is a live chat this connection owns (required)
OWN_SESSION_IF_GIVEN = "own_session_if_given"  # the same, when the frame names a session at all
OWN_STORED = "own_stored"          # `session_id` is a stored session the resident owns (resume, delete)
OWN_REQUEST = "own_request"        # a `request_id` must be pending on that same chat (no box-wide lookup)
PINNED_CWD = "pinned_cwd"          # the chat runs in RESIDENT_CWD_NAME; a parent must be the resident's
NO_FILE_REFS = "no_file_refs"      # no @folder:, no @file: outside RESIDENT_FILE_DIRS, no `_` parameters
ANSWER = "answer"                  # answers only a request the server raised on this connection
OWN_ROWS = "own_rows"              # a session list: the reply carries only the resident's own rows

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
    "session.list": ((OWN_ROWS,), "list the resident's own chats (rows filtered, as GET /api/sessions)"),
    "session.most_recent": ((OWN_ROWS,), "the newest chat's id and title, when it is the resident's"),
    "session.title": ((OWN_SESSION,), "rename a chat"),
    "session.close": ((OWN_SESSION,), "close a chat"),
    "session.delete": ((OWN_STORED,), "delete one of the resident's stored chats"),
    "session.interrupt": ((OWN_SESSION,), "stop the agent's turn"),
    "session.events.since": ((OWN_SESSION,), "replay after a reconnect"),
    "prompt.submit": ((OWN_SESSION, NO_FILE_REFS),
                      "send a message (no @folder:, no @file: but to an upload, a paste or the chat directory)"),
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

#: The directories under HERMES_HOME a resident's `@file:` may name a file in (S-r3-2), from a chat
#: that runs in RESIDENT_CWD_NAME: Hermes's own uploads (`file.attach` stages into `attachments/`,
#: `prompt_attachments.py:176`), the desktop app's long pastes (`composer-pastes/`,
#: `context_references.py` COMPOSER_PASTES_DIRNAME) and the chat directory itself. Resolved through
#: symlinks; a directory that is itself a link admits nothing.
RESIDENT_FILE_DIRS = ("attachments", "composer-pastes", RESIDENT_CWD_NAME)

# ==================================================================================================

#: Where the PTY child connects back with the internal credential (`web_server_chat.py:438-445`),
#: the process-wide one (an admin's terminal) or a resident's per-PTY one.
INTERNAL_WS_PATHS = frozenset({"/api/ws", "/api/pub"})
PTY_PATH = "/api/pty"
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
LIST_UNAVAILABLE = {"error": "unavailable", "detail": "The session list could not be read.",
                    "reason": "session_list_unavailable"}
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
#: The per-PTY credential `consume_internal_credential` just recognised, for the `_ws_auth_reason`
#: wrapper that called it (one synchronous call, one context).
_CONSUMED_GRANT: contextvars.ContextVar[Any] = contextvars.ContextVar("edgecity_consumed_grant", default=None)
#: The /api/pty socket being served (`PtyContext`), set by the `_ws_auth_reason` wrapper inside
#: the PTY handler's own task and read by the wrappers it then calls (argv, registry, spawn). The
#: spawn runs in `asyncio.to_thread`, which copies it.
_PTY_CONTEXT: contextvars.ContextVar[Any] = contextvars.ContextVar("edgecity_pty_context", default=None)

#: Which seams this copy of the module installed. /api/ws opens to a resident only while the
#: gateway seam is in place (`ws_path_allowed`).
_installed: dict[str, bool] = {"http": False, "tickets": False, "ws": False, "gateway": False, "files": False,
                               "agent_reads": False, "references": False, "pty": False}
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


#: `GET /api/sessions?full=<one of these>` is Hermes's compact list; anything else (`full=1`, which
#: adds each row's system prompt and model config) is admin only.
_FALSE_WORDS = frozenset({"0", "false", "f", "no", "n", "off"})
#: The session list a resident keeps (`web_routers/sessions.py` `get_sessions`).
SESSION_LIST_PATH = "/api/sessions"


def _token_request(state: Any) -> bool:
    return bool(getattr(state, "token_authenticated", False)) or getattr(state, "token_principal", None) is not None


def _query_pairs(query: Any) -> list:
    if isinstance(query, (bytes, bytearray)):
        query = bytes(query).decode("latin-1")
    return urllib.parse.parse_qsl(query or "", keep_blank_values=True)


def session_route_code(request: Any, url_path: Any, scope_path: Any, query: Any) -> str:
    """A listed route that names one stored session answers a resident only for the resident's own
    (`session_visible`), looked up the way the handler resolves it (exact id, else a unique prefix,
    in the `?profile=` store). No lookup, a failed lookup, an unknown id, a Hermes subroute word or
    URL and scope paths that name different ids: refused. The session list with `full` other than
    a false word is refused (S-r3-1: it carries every row's system prompt). The archive job's bearer
    (a token principal, scoped by `_archive` to two read routes) reads every session, as before."""
    state = request.state
    if _token_request(state):
        return "resident_allowed"
    if SESSION_LIST_PATH in (url_path, scope_path):
        if any(k == "full" and v.strip().lower() not in _FALSE_WORDS for k, v in _query_pairs(query)):
            return "denied_full_list"
        return "resident_allowed"
    ids = {_session_route_id(url_path), _session_route_id(scope_path)}
    if ids == {None}:
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


# ---- the session lists a resident keeps (S-r3-1) --------------------------------------------------

#: Rows read per call when a resident's list is built (Hermes's own `limit` bound, `le=100`).
LIST_PAGE_ROWS = 100
#: The most stored rows read for one resident list; the resident's rows past them are not listed
#: (fail closed: never another login's row, at worst fewer of the resident's own).
LIST_SCAN_ROWS = 5000

#: `page(query, limit, offset) -> Hermes's GET /api/sessions body` for the request's own filters,
#: handed in by `__init__` (Hermes's handler, read only). None: a resident's list is refused.
_session_list_page: Optional[Callable[[dict, int, int], dict]] = None
#: `owners(ids, profile) -> {id: {"id", "user_id", "source"}}` from the stored sessions, handed in by
#: `__init__` (the gateway's list rows carry no `user_id`). None: a resident's gateway list is refused.
_session_owners: Optional[Callable[..., dict]] = None


def set_session_list(fn: Optional[Callable[[dict, int, int], dict]]) -> None:
    global _session_list_page
    _session_list_page = fn


def set_session_owners(fn: Optional[Callable[..., dict]]) -> None:
    global _session_owners
    _session_owners = fn


def list_query(query: Any) -> dict:
    """The list's query parameters, the last value of each winning, as FastAPI reads a scalar."""
    return dict(_query_pairs(query))


def own_session_page(page: Callable[[dict, int, int], dict], query: dict, login: Optional[str]) -> dict:
    """The resident's own page of `GET /api/sessions`: Hermes's list under the request's filters and
    order is read LIST_PAGE_ROWS at a time from the start, rows `session_visible` refuses are
    dropped (a row carries `user_id` and `source`; one with neither is not the resident's), and
    `limit`/`offset` page through what is left. `total` counts the resident's rows only, so the
    page reveals nothing of other logins' sessions, not even how many there are. Raises on a body
    that is not Hermes's list shape (the caller then refuses)."""
    limit = int(query.get("limit", 20))
    offset = int(query.get("offset", 0))
    if limit < 0 or offset < 0:
        raise ValueError("negative paging")
    own: list = []
    seen: set = set()
    storage: dict = {}
    read = 0
    while True:
        body = page(query, LIST_PAGE_ROWS, read)
        rows, total = body.get("sessions"), body.get("total")
        if not isinstance(rows, list) or type(total) is not int:
            raise ValueError("not a session list")
        if isinstance(body.get("storage"), dict):
            storage = body["storage"]
        for row in rows:
            key = row.get("id") if isinstance(row, dict) else None
            if type(key) is not str or key in seen:  # Hermes repeats pinned rows on every page
                continue
            seen.add(key)
            if session_visible(row, login):
                own.append(row)
        read += LIST_PAGE_ROWS
        if not rows or read >= total:
            break
        if read >= LIST_SCAN_ROWS:
            _count("resident_list_truncated")
            break
    return {"sessions": own[offset:offset + limit], "total": len(own), "limit": limit, "offset": offset,
            "storage": storage}


async def _drain(response: Any) -> None:
    """Read and drop a streamed body the guard replaces (the app's task finishes as it would)."""
    iterator = getattr(response, "body_iterator", None)
    if iterator is not None and hasattr(iterator, "__aiter__"):
        async for _chunk in iterator:
            pass


def _is_resident_list(request: Any) -> bool:
    try:
        return (request.method in GET and request.url.path == SESSION_LIST_PATH
                and request.scope.get("path") == SESSION_LIST_PATH and not _token_request(request.state))
    except Exception:  # noqa: BLE001
        return True  # the caller then builds the list itself, or refuses


async def resident_session_list(request: Any, response: Any, json_response: Callable[..., Any]) -> Any:
    """A resident's `GET /api/sessions` (S-r3-1). Hermes's handler has answered (its validation and
    its errors stand: a response that is not a 200 goes out as it is, and carries no rows); its body
    is replaced with `own_session_page`. No list reader, a failure or a body of the wrong shape is a
    503, never Hermes's box-wide page."""
    if getattr(response, "status_code", None) != 200:
        return response
    try:
        await _drain(response)
        page = _session_list_page
        if page is None:
            raise LookupError("no session list reader")
        session = getattr(request.state, "session", None)
        login = login_id(getattr(session, "provider", None), getattr(session, "user_id", None))
        query = list_query(request.scope.get("query_string", b""))
        body = await asyncio.to_thread(own_session_page, page, query, login)
    except Exception:  # noqa: BLE001
        _count("denied_session_list_error")
        return json_response(dict(LIST_UNAVAILABLE), status_code=503)
    _count("resident_list_filtered")
    return json_response(body, status_code=200)


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
            if code == "resident_allowed" and _is_resident_list(req):
                return await resident_session_list(req, response, json_response)
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


def ws_role(credential: Any, ticket_role: Any, grant: Any = None) -> str:
    """The role a socket gets from what authenticated it: an admin-minted ticket is admin; the
    process-wide internal credential is an admin terminal's child; a resident's per-PTY credential
    (`grant`), a resident's ticket, the loopback token or anything unknown is a resident."""
    if grant is not None:
        return ROLE_RESIDENT
    if credential == "internal":
        return ROLE_INTERNAL
    if credential in ("ticket", "ticket-subprotocol") and ticket_role == ROLE_ADMIN:
        return ROLE_ADMIN
    return ROLE_RESIDENT


def ws_path_allowed(role: Any, url_path: Any, scope_path: Any) -> bool:
    """Admin: every socket. The admin terminal's child: /api/ws and /api/pub. A resident:
    RESIDENT_WS_PATHS; /api/ws only once the gateway method guard is installed, and /api/pty only
    once the PTY seam is too (the child's own /api/ws must be guarded). Both paths must agree."""
    if role == ROLE_ADMIN:
        return True
    if not isinstance(url_path, str) or url_path != scope_path:
        return False
    if role == ROLE_INTERNAL:
        return url_path in INTERNAL_WS_PATHS
    if url_path not in RESIDENT_WS_PATHS:
        return False
    if url_path in ("/api/ws", PTY_PATH) and not _ensure("gateway"):
        return False
    if url_path == PTY_PATH and not _installed["pty"]:
        return False
    return True


def _socket_paths(ws: Any) -> tuple[Any, Any]:
    url = getattr(ws, "url", None)
    scope = getattr(ws, "scope", None) or {}
    return getattr(url, "path", None), scope.get("path")


def _refusal_code(reason: str) -> str:
    """The count for a socket refusal: `denied_ws_resident` off the path list, else
    `denied_<reason without the edgecity_ prefix>` (`denied_pty_profile`, `denied_pty_peer`, ...)."""
    if reason == WS_REFUSAL:
        return "denied_ws_resident"
    return "denied_" + (reason[len("edgecity_"):] if reason.startswith("edgecity_") else reason)


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
        grant_token = _CONSUMED_GRANT.set(None)
        try:
            result = base(ws)
            ticket_role = _CONSUMED_ROLE.get()
            grant = _CONSUMED_GRANT.get()
        finally:
            _CONSUMED_ROLE.reset(token)
            _CONSUMED_GRANT.reset(grant_token)
        try:
            reason, credential = result
        except Exception:  # noqa: BLE001
            return "edgecity_guard_error", "unknown"
        if reason is not None:
            return reason, credential
        try:
            if grant is not None and credential != "internal":
                grant = None  # a grant is only ever presented as `?internal=`
            role = ws_role(credential, ticket_role, grant)
            ws._edgecity_ws_role = role
            url_path, scope_path = _socket_paths(ws)
            if grant is not None:
                refusal = grant_socket_refusal(grant, ws, url_path, scope_path)
                if refusal is not None:
                    _count(_refusal_code(refusal))
                    return refusal, credential
                _count("ws_pty_child_allowed")
                return None, credential
            if not ws_path_allowed(role, url_path, scope_path):
                _count(f"denied_ws_{role}")
                return WS_REFUSAL, credential
            if url_path == PTY_PATH:
                refusal = pty_admission(role, ws, credential)
                if refusal is not None:
                    _count(_refusal_code(refusal))
                    return refusal, credential
            _count(f"ws_{role}_allowed")
            return None, credential
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


# ---- the Chat tab (1.4.0): a resident's /api/pty ------------------------------------------------
#
# At Hermes 0.21.5 the dashboard's Chat tab is `/api/pty` (`chat_ws.py:432`): `hermes --tui` behind a
# pseudo-terminal, attached to this process's gateway over /api/ws with the URL in its env
# (`HERMES_TUI_GATEWAY_URL`, `web_server_chat.py:388-389`), which carries ONE process-wide internal
# credential (`ws_tickets.internal_ws_credential`, `:405-430`). A resident's Chat tab instead gets a
# credential minted for that one PTY and bound to the resident's login (`PtyGrant`): its child is a
# resident on /api/ws (the method table, own chats only) and may publish only to its own channel on
# /api/pub. The process-wide credential stays the admin terminal's (ROLE_INTERNAL).
#
# Seams (all in `hermes_cli.web_server_chat` but the last; `install_pty`, all or none):
# - `_ws_auth_reason` (the socket seam above): a resident's /api/pty is admitted only by
#   `pty_admission`, before accept (4401 with a reason code);
# - `_resolve_chat_argv_async` (late-bound by `chat_ws.py:33`): the chat Hermes actually resolved is
#   checked again (the channel's active-session fallback, the newest descendant), the child's env is
#   rebuilt (`resident_chat_env`) with the per-PTY credential, before anything is spawned;
# - `PtyBridge` (imported at call time by `chat_ws.py:434`): a subclass whose `spawn` binds the
#   credential to the bridge, which revokes it on close and on the child's exit;
# - `PTY_REGISTRY.attach_or_spawn` / `.detach`: a resident's `?attach=` token is namespaced by its
#   login, so no resident reattaches another login's terminal, and a login holds at most
#   RESIDENT_PTYS_PER_LOGIN terminals;
# - `ws_tickets.consume_internal_credential` (imported at call time by `_ws_auth_reason`,
#   `web_server_chat.py:236`): a per-PTY credential answers with the resident's own identity, which
#   Hermes stamps on the socket (`_stamp_identity`, `:245-252`) exactly as it does a ticket's.

#: Hermes's channel id rule (`chat_ws.py:52`): a value that does not match is not a channel.
_CHANNEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
#: The internal identity Hermes gives the process-wide credential (`ws_tickets.py:30-31`).
_SERVER_INTERNAL = "server-internal"
#: Where a resident's TUI keeps what it writes on its own (input history, its log, theme, widgets,
#: `/terminal-setup`): one 0700 directory per login under HERMES_HOME, its child's HOME and
#: HERMES_HOME. Not the box's HERMES_HOME, whose `.hermes_history` every login's TUI shares.
RESIDENT_TUI_DIR_NAME = "resident-tui"
#: What a resident's TUI may spawn on its own: nothing. `$VISUAL`/`$EDITOR` (the composer's
#: editor, `lib/editor.ts:33-52`, whose own shell escape is a shell), `$HERMES_BIN` (`/setup`,
#: `lib/externalCli.ts:8`) and `$BROWSER` (xdg-open's first choice) point at a path that does not
#: exist: the spawn fails (ENOENT), which the TUI reports and survives.
PTY_INERT_COMMAND = "/nonexistent/edgecity-resident-chat-runs-nothing"
#: The child's env, forced for a resident: the editor, `/setup` and the opener inert; hosted
#: dashboard mode (`/exit`, `/quit`, `/update` refused, `slash/commands/core.ts:84-151`); mouse and
#: clicks off, so no link in the transcript is opened with a click (`entry.tsx:172-179`).
PTY_FORCED_ENV = {
    "VISUAL": PTY_INERT_COMMAND, "EDITOR": PTY_INERT_COMMAND, "HERMES_BIN": PTY_INERT_COMMAND,
    "BROWSER": PTY_INERT_COMMAND, "HERMES_TUI_DASHBOARD": "1", "HERMES_TUI_DISABLE_MOUSE": "1",
    "HERMES_TUI_DISABLE_MOUSE_CLICKS": "1", "HERMES_TUI_MOUSE_TRACKING": "0",
}
#: Dropped from a resident child's env: a host image path to attach at start, a query to send at
#: start, the confirm opt-out, and dump/log paths outside its own directory.
PTY_DROPPED_ENV = ("HERMES_TUI_IMAGE", "HERMES_TUI_QUERY", "HERMES_TUI_NO_CONFIRM", "HERMES_HEAPDUMP_DIR",
                   "HERMES_DEV_PERF_LOG")
_GRANT_LIVE = ("spawning", "bound")


class PtyRefused(Exception):
    """A resident's chat refused after accept; `code` is counted, `detail` is what the tab shows."""

    def __init__(self, code: str, detail: str = "This chat cannot start here.") -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class PtyGrant:
    """One per-PTY credential: 32 random bytes, in memory only, with `{user_id, provider, role:
    resident, pty_id, minted_at}`. minted (env built) -> spawning -> bound (the child runs) ->
    revoked (the PTY closed, the child exited, or the chat never started)."""

    def __init__(self, *, user_id: str, provider: str, channel: Optional[str]) -> None:
        self.credential = secrets.token_urlsafe(32)
        self.pty_id = secrets.token_hex(8)
        self.user_id = user_id
        self.provider = provider
        self.login = login_id(provider, user_id)
        self.role = ROLE_RESIDENT
        self.channel = channel
        self.minted_at = time.time()
        self.state = "minted"
        #: path -> [(socket, the loop it runs on)], the sockets this credential opened.
        self.sockets: dict[str, list] = {path: [] for path in INTERNAL_WS_PATHS}

    def info(self) -> dict:
        """What `consume_internal_credential` answers: the identity Hermes stamps on the socket."""
        return {"user_id": self.user_id, "provider": self.provider}


class PtyContext:
    """The /api/pty socket being served: who opened it, its channel, its chat directory, and the
    grant minted for its child (set by the argv wrapper)."""

    def __init__(self, role: str, login: Optional[str], identity: Optional[dict] = None,
                 channel: Optional[str] = None, chat: Optional[str] = None) -> None:
        self.role = role
        self.login = login
        self.identity = dict(identity or {})
        self.channel = channel
        self.chat = chat
        self.grant: Optional[PtyGrant] = None
        digest = hashlib.sha256((login or "").encode("utf-8")).hexdigest()[:32]
        #: A resident's `?attach=` tokens live under this prefix in Hermes's registry.
        self.namespace = f"edgecity-resident:{digest}\0" if role == ROLE_RESIDENT else ""


_pty_lock = threading.Lock()
#: pty_id -> grant, every grant not yet revoked.
_pty_grants: dict[str, PtyGrant] = {}
#: channel -> the login that first opened a Chat tab on it (insertion ordered).
_pty_channels: dict[str, str] = {}
#: Hermes's loopback peer names (`web_server_chat._LOOPBACK_HOSTS`, which counts Starlette's
#: TestClient), handed in by `install_pty`.
_pty_loopback: frozenset = frozenset()
#: `() -> the process-wide internal credential or None` (`ws_tickets._internal_credential`).
_process_credential: Optional[Callable[[], Any]] = None
#: `(path, **query) -> ws://... URL` for a server-spawned client (`_server_internal_ws_url`).
_pty_url_builder: Optional[Callable[..., Any]] = None


def pty_grants() -> list:
    with _pty_lock:
        return list(_pty_grants.values())


def _query_pairs_of(ws: Any) -> Optional[list]:
    """A socket's query as Starlette parses it (`parse_qsl` of the latin-1 query string, blanks
    kept), every value of every name. None when it cannot be read."""
    raw = (getattr(ws, "scope", None) or {}).get("query_string", b"")
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("latin-1")
    if not isinstance(raw, str):
        return None
    return urllib.parse.parse_qsl(raw, keep_blank_values=True)


def _identity_login(ws: Any) -> Optional[str]:
    """The login Hermes stamped on the socket (`ws._hermes_auth_identity`), never the internal one."""
    identity = getattr(ws, "_hermes_auth_identity", None)
    if not isinstance(identity, dict):
        return None
    if identity.get("user_id") == _SERVER_INTERNAL or identity.get("provider") == _SERVER_INTERNAL:
        return None
    return login_id(identity.get("provider"), identity.get("user_id"))


def _same_dir(value: Any, root: str) -> bool:
    """`value`, read as Hermes reads a `?cwd=` (`chat_workspaces.py:32-38`: strip, `~`, absolute)
    and then through every symlink, is exactly `root`."""
    try:
        if type(value) is not str or not value.strip():
            return False
        return os.path.realpath(os.path.abspath(os.path.expanduser(value.strip()))) == root
    except Exception:  # noqa: BLE001
        return False


def own_chat(session_id: Any, login: Optional[str], *, prefix: bool) -> bool:
    """A stored chat the resident may reopen in its Chat tab: `session_visible` through the stored
    owner (the box's own store, `profile` none). A prefix is read as Hermes's `resolve_session_id`
    reads it (`web_server_sessions.py:42`). No lookup, a failure or an unknown id: False."""
    lookup = _session_lookup
    if lookup is None or type(session_id) is not str or not session_id or login is None:
        return False
    try:
        return session_visible(lookup(session_id, None, prefix=prefix), login)
    except Exception:  # noqa: BLE001
        return False


def _claim_channel(channel: str, login: str, *, admin: bool = False) -> bool:
    """Bind `channel` to `login` the first time a Chat tab opens on it. A resident may use only a
    channel that is new or its own; an admin's claim always succeeds (it is not recorded over
    another login's). The table is bounded: full, a resident's new channel is refused, an admin's
    displaces the oldest entry."""
    with _pty_lock:
        owner = _pty_channels.get(channel)
        if owner is not None:
            return admin or owner == login
        if len(_pty_channels) >= PTY_CHANNELS_MAX:
            if not admin:
                return False
            _pty_channels.pop(next(iter(_pty_channels)))
        _pty_channels[channel] = login
        return True


def pty_admission(role: Any, ws: Any, credential: Any) -> Optional[str]:
    """Whether this /api/pty may open, before accept: None (open; the socket's `PtyContext` is set)
    or the 4401 reason. An admin opens anything (its channel is recorded). A resident needs:

    - a login: a ticket Hermes stamped `{user_id, provider}` from (never the loopback token);
    - no `profile` but none or "current" (RESIDENT_PTY_PROFILES): any other spawns its own gateway;
    - no `cwd` but `$HERMES_HOME/resident-chat` (a usable resident chat directory);
    - no `resume` but a chat of its own (`own_chat`, the prefix read as Hermes reads it);
    - no `channel` another login opened a Chat tab on.

    Every value of a repeated name is checked (Hermes reads the last)."""
    pairs = _query_pairs_of(ws)
    if pairs is None:
        return "edgecity_pty_query"
    channels = [value for key, value in pairs if key == "channel"]
    channel = channels[-1] if channels and _CHANNEL_RE.match(channels[-1]) else None
    login = _identity_login(ws)
    if role == ROLE_ADMIN:
        if channel is not None:
            _claim_channel(channel, login or ROLE_ADMIN, admin=True)
        _PTY_CONTEXT.set(PtyContext(ROLE_ADMIN, login, channel=channel))
        return None
    if role != ROLE_RESIDENT or credential not in ("ticket", "ticket-subprotocol") or login is None:
        return "edgecity_pty_no_login"
    if any(key == "profile" and value.strip().lower() not in RESIDENT_PTY_PROFILES for key, value in pairs):
        return "edgecity_pty_profile"
    chat = resident_cwd()
    if chat is None:
        return "edgecity_pty_cwd"
    if any(key == "cwd" and value.strip() and not _same_dir(value, chat) for key, value in pairs):
        return "edgecity_pty_cwd"
    if any(key == "resume" and value != "" and not own_chat(value, login, prefix=True) for key, value in pairs):
        return "edgecity_pty_resume"
    with _pty_lock:
        taken = any(_CHANNEL_RE.match(v) and _pty_channels.get(v, login) != login for v in channels)
    if taken or (channel is not None and not _claim_channel(channel, login)):
        return "edgecity_pty_channel"
    identity = getattr(ws, "_hermes_auth_identity", None)
    _PTY_CONTEXT.set(PtyContext(ROLE_RESIDENT, login, identity, channel, chat))
    return None


def _loopback_peer(ws: Any) -> bool:
    host = getattr(getattr(ws, "client", None), "host", None)
    if type(host) is not str or not host:
        return False
    if host in _pty_loopback:
        return True
    try:
        address = ipaddress.ip_address(host.strip("[]").split("%", 1)[0])
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return address.is_loopback or (mapped is not None and mapped.is_loopback)


def _socket_closed(sock: Any) -> bool:
    if getattr(sock, "_edgecity_closed", False):
        return True
    for name in ("client_state", "application_state"):
        if getattr(getattr(sock, name, None), "name", None) == "DISCONNECTED":
            return True
    return False


def _running_loop() -> Any:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def grant_socket_refusal(grant: PtyGrant, ws: Any, url_path: Any, scope_path: Any) -> Optional[str]:
    """Whether the per-PTY credential may open this socket: None, or the 4401 reason. Only /api/ws
    and /api/pub (both paths agreeing), only from a loopback peer (the child dials the dashboard
    on the box itself), /api/pub only on the grant's own channel, at most PTY_SOCKETS_PER_PATH open
    sockets per path, and only while the grant is live. An admitted socket is remembered so a
    revocation closes it."""
    if url_path not in INTERNAL_WS_PATHS or url_path != scope_path:
        return WS_REFUSAL
    if not _loopback_peer(ws):
        return "edgecity_pty_peer"
    if url_path == "/api/ws" and not _ensure("gateway"):
        return WS_REFUSAL
    if url_path == "/api/pub":
        pairs = _query_pairs_of(ws) or []
        channels = [value for key, value in pairs if key == "channel"]
        if grant.channel is None or not channels or any(value != grant.channel for value in channels):
            return "edgecity_pty_channel"
    with _pty_lock:
        if grant.state not in _GRANT_LIVE:
            return "edgecity_pty_revoked"
        live = [(sock, loop) for sock, loop in grant.sockets[url_path] if not _socket_closed(sock)]
        if len(live) >= PTY_SOCKETS_PER_PATH:
            grant.sockets[url_path] = live
            return "edgecity_pty_sockets"
        grant.sockets[url_path] = live + [(ws, _running_loop())]
    ws._edgecity_pty_grant = grant
    return None


async def _close_quietly(sock: Any) -> None:
    with contextlib.suppress(Exception):
        await sock.close(code=4401, reason="auth: edgecity_pty_revoked")


def _close_socket(sock: Any, loop: Any) -> None:
    """Close an open socket of a revoked grant on its own loop, from whichever thread revokes."""
    if loop is None or not callable(getattr(sock, "close", None)):
        return
    with contextlib.suppress(Exception):
        loop.call_soon_threadsafe(lambda: loop.create_task(_close_quietly(sock)))


def revoke_grant(grant: Any, reason: str) -> None:
    """The credential no longer opens anything, and every socket it opened is closed. Idempotent."""
    if not isinstance(grant, PtyGrant):
        return
    with _pty_lock:
        if grant.state == "revoked":
            return
        grant.state = "revoked"
        _pty_grants.pop(grant.pty_id, None)
        sockets = [entry for path in sorted(grant.sockets) for entry in grant.sockets[path]]
        grant.sockets = {path: [] for path in INTERNAL_WS_PATHS}
    _count(f"pty_revoked_{reason}")
    for sock, loop in sockets:
        _close_socket(sock, loop)


def mint_grant(ctx: PtyContext) -> PtyGrant:
    """A new per-PTY credential for a resident's chat. Credentials minted for chats that never
    spawned are dropped once older than PTY_UNBOUND_SECONDS."""
    identity = ctx.identity
    grant = PtyGrant(user_id=identity.get("user_id"), provider=identity.get("provider"), channel=ctx.channel)
    if grant.login is None or grant.login != ctx.login:
        raise PtyRefused("no_login")
    now = time.time()
    with _pty_lock:
        stale = [g for g in _pty_grants.values() if g.state == "minted" and now - g.minted_at > PTY_UNBOUND_SECONDS]
    for old in stale:
        revoke_grant(old, "unbound")
    with _pty_lock:
        _pty_grants[grant.pty_id] = grant
    _count("pty_grant_minted")
    return grant


def grant_for(value: Any) -> Optional[PtyGrant]:
    """The grant whose credential is `value` (constant-time compare against each), or None."""
    if type(value) is not str or not value:
        return None
    found = None
    with _pty_lock:
        grants = list(_pty_grants.values())
    for grant in grants:
        if hmac.compare_digest(grant.credential.encode("utf-8"), value.encode("utf-8")):
            found = grant
    return found


def grant_url(build: Optional[Callable[..., Any]], path: str, credential: str, **query: Any) -> Optional[str]:
    """Hermes's own URL for a server-spawned client (`_server_internal_ws_url`: the host the child
    dials, the bound port), with the process-wide `internal=` replaced by `credential`. None when
    Hermes builds none (no bound port) or one without exactly one `internal` (the gate is off)."""
    if build is None:
        return None
    url = build(path, **query)
    if not isinstance(url, str) or not url:
        return None
    parts = urllib.parse.urlsplit(url)
    pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    if [key for key, _ in pairs].count("internal") != 1:
        return None
    pairs = [(key, credential if key == "internal" else value) for key, value in pairs]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(pairs)))


def resident_tui_dir(login: Optional[str]) -> Optional[str]:
    """`<HERMES_HOME>/resident-tui/<sha256(login)[:32]>`, created 0700, a plain directory (not a
    link) where it should be; None when it cannot be made."""
    try:
        if login is None:
            return None
        home = os.path.realpath(_hermes_home())
        base = os.path.join(home, RESIDENT_TUI_DIR_NAME)
        path = os.path.join(base, hashlib.sha256(login.encode("utf-8")).hexdigest()[:32])
        for part in (base, path):
            if os.path.islink(part):
                return None
            os.makedirs(part, mode=0o700, exist_ok=True)
        if os.path.realpath(path) != path or not os.path.isdir(path) or private_path(path):
            return None
        return path
    except Exception:  # noqa: BLE001
        return None


def resident_chat_call(ctx: PtyContext, kwargs: dict) -> dict:
    """The keyword arguments a resident's chat is resolved with, after the checks Hermes's own
    resolution makes possible only now: the resume the handler settled on (an explicit `?resume=`
    or the channel's active-session file, `chat_ws.py:459-475`) must be the resident's; no
    profile; the workspace pinned to the resident chat directory. Hermes's sidecar URL (process
    credential) is not passed on: `resident_chat_env` builds its own."""
    known = {"resume", "sidecar_url", "profile", "active_session_file", "workspace_cwd"}
    if set(kwargs) - known:
        raise PtyRefused("args")
    profile = kwargs.get("profile")
    if profile is not None and (type(profile) is not str or profile.strip().lower() not in RESIDENT_PTY_PROFILES):
        raise PtyRefused("profile", "That profile's chat is admin only.")
    chat = resident_cwd()
    if chat is None or chat != ctx.chat:
        raise PtyRefused("cwd")
    given = kwargs.get("workspace_cwd")
    if given not in (None, "") and not _same_dir(given, chat):
        raise PtyRefused("cwd", "That workspace is admin only.")
    resume = kwargs.get("resume")
    if resume not in (None, "") and not own_chat(resume, ctx.login, prefix=True):
        raise PtyRefused("resume", "That chat is not yours.")
    sidecar = kwargs.get("sidecar_url")
    if (sidecar not in (None, "")) != (ctx.channel is not None):
        raise PtyRefused("channel")
    if sidecar not in (None, ""):
        named = [v for k, v in urllib.parse.parse_qsl(urllib.parse.urlsplit(str(sidecar)).query) if k == "channel"]
        if named != [ctx.channel]:
            raise PtyRefused("channel")
    call = {key: value for key, value in kwargs.items() if key not in ("sidecar_url", "workspace_cwd", "profile")}
    call["profile"] = None
    call["sidecar_url"] = None
    if resume in (None, ""):
        call["workspace_cwd"] = chat
    return call


def resident_chat_env(ctx: PtyContext, env: Any) -> dict:
    """The child's env for a resident's chat, from the one Hermes resolved:

    - the chat Hermes settled on (`HERMES_TUI_RESUME`, the newest descendant) is the resident's;
    - HERMES_HOME is the box's own (not a profile's: that chat would run its own gateway);
    - no value carries the process-wide credential; `HERMES_TUI_GATEWAY_URL` (always: without it
      the TUI spawns its own gateway, `gatewayClient.ts:632-672`) and, with a channel,
      `HERMES_TUI_SIDECAR_URL` carry the per-PTY credential instead;
    - `HERMES_CWD` and `HERMES_TUI_CWD` are the resident chat directory (`session.create`'s cwd);
    - the TUI's own files go to the login's own directory (HOME, HERMES_HOME), and what it could
      spawn is inert (PTY_FORCED_ENV, PTY_DROPPED_ENV).

    The grant is set on `ctx` for the spawn to bind."""
    if not isinstance(env, dict):
        raise PtyRefused("env")
    env = dict(env)
    home = os.path.realpath(_hermes_home())
    if env.get("HERMES_HOME") not in (None, "") and os.path.realpath(str(env["HERMES_HOME"])) != home:
        raise PtyRefused("profile", "That profile's chat is admin only.")
    resumed = env.get("HERMES_TUI_RESUME")
    if resumed not in (None, "") and not own_chat(resumed, ctx.login, prefix=False):
        raise PtyRefused("resume", "That chat is not yours.")
    tui_dir = resident_tui_dir(ctx.login)
    if tui_dir is None or ctx.chat is None:
        raise PtyRefused("cwd")
    grant = mint_grant(ctx)
    try:
        gateway = grant_url(_pty_url_builder, "/api/ws", grant.credential)
        sidecar = (grant_url(_pty_url_builder, "/api/pub", grant.credential, channel=ctx.channel)
                   if ctx.channel is not None else None)
        if gateway is None or (ctx.channel is not None and sidecar is None):
            raise PtyRefused("attach_url")
        process = _process_credential() if _process_credential is not None else None
        process = process if type(process) is str and process else None
        for key in list(env):
            value = env[key]
            if key in ("HERMES_TUI_GATEWAY_URL", "HERMES_TUI_SIDECAR_URL") or key in PTY_DROPPED_ENV or (
                    process is not None and isinstance(value, str) and process in value):
                del env[key]
        env.update(PTY_FORCED_ENV)
        env["HERMES_TUI_GATEWAY_URL"] = gateway
        if sidecar is not None:
            env["HERMES_TUI_SIDECAR_URL"] = sidecar
        env["HERMES_CWD"] = env["HERMES_TUI_CWD"] = ctx.chat
        env["HOME"] = env["HERMES_HOME"] = tui_dir
        if process is not None and any(isinstance(v, str) and process in v for v in env.values()):
            raise PtyRefused("process_credential")
    except BaseException:
        revoke_grant(grant, "unbuilt")
        raise
    ctx.grant = grant
    return env


class GrantBridge:
    """Hermes's PTY bridge with the grant tied to it: closing the bridge (the legacy pump's end, a
    registry reap or eviction, shutdown) or reading the child's exit (EOF) revokes the credential.
    Everything else is the bridge's own."""

    def __init__(self, inner: Any, grant: PtyGrant) -> None:
        self._edgecity_inner = inner
        self._edgecity_grant = grant

    def read(self, *args: Any, **kwargs: Any) -> Any:
        data = self._edgecity_inner.read(*args, **kwargs)
        if data is None:
            revoke_grant(self._edgecity_grant, "exited")
        return data

    def close(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self._edgecity_inner.close(*args, **kwargs)
        finally:
            revoke_grant(self._edgecity_grant, "closed")

    def __getattr__(self, name: str) -> Any:
        return getattr(self._edgecity_inner, name)


def _live_count(login: Optional[str], exclude: Any = None) -> int:
    with _pty_lock:
        return sum(1 for g in _pty_grants.values() if g.login == login and g.state in _GRANT_LIVE and g is not exclude)


def install_pty(chat_module: Any, tickets_module: Any, *, refusal: Optional[Callable[[str], BaseException]] = None,
                registry_full: Optional[Callable[[], BaseException]] = None) -> bool:
    """Install the Chat tab's seams (see the section comment), all or none. False, changing
    nothing, when one is missing: `_installed["pty"]` stays False and a resident's /api/pty is
    refused (`ws_path_allowed`). `refusal(detail)` is the exception the PTY handler shows a
    resident whose chat is refused after accept (Hermes's `HTTPException`, `chat_ws.py:494`);
    `registry_full()` the one it shows when the login's terminals are all attached (`RegistryFull`)."""
    global _pty_loopback, _process_credential, _pty_url_builder
    resolve = getattr(chat_module, "_resolve_chat_argv_async", None)
    bridge_cls = getattr(chat_module, "PtyBridge", None)
    registry = getattr(chat_module, "PTY_REGISTRY", None)
    build = getattr(chat_module, "_server_internal_ws_url", None)
    unavailable = getattr(chat_module, "PtyUnavailableError", None)
    consume = getattr(tickets_module, "consume_internal_credential", None)
    invalid = getattr(tickets_module, "TicketInvalid", None)
    base_resolve = _unwrap(resolve) if callable(resolve) else None
    base_bridge = _unwrap(bridge_cls) if isinstance(bridge_cls, type) else None
    base_consume = _unwrap(consume) if callable(consume) else None
    attach = getattr(registry, "attach_or_spawn", None)
    detach = getattr(registry, "detach", None)
    base_attach = _unwrap(attach) if callable(attach) else None
    base_detach = _unwrap(detach) if callable(detach) else None
    if (base_resolve is None or base_bridge is None or base_consume is None or base_attach is None
            or base_detach is None or not callable(build) or not isinstance(invalid, type)
            or not callable(getattr(base_bridge, "spawn", None))
            or not (isinstance(unavailable, type) and issubclass(unavailable, BaseException))):
        return False
    make_refusal = refusal if refusal is not None else (lambda detail: PermissionError(detail))
    make_full = registry_full if registry_full is not None else (lambda: unavailable("too many chat terminals"))

    def consume_internal_credential(value: Any, *args: Any, **kwargs: Any) -> Any:
        grant = grant_for(value)
        if grant is None:
            return base_consume(value, *args, **kwargs)
        if grant.state not in _GRANT_LIVE:
            raise invalid("pty credential not live")
        _CONSUMED_GRANT.set(grant)
        return grant.info()

    async def _resolve_chat_argv_async(*args: Any, **kwargs: Any) -> Any:
        ctx = _PTY_CONTEXT.get()
        if isinstance(ctx, PtyContext) and ctx.role == ROLE_ADMIN:
            return await base_resolve(*args, **kwargs)
        try:
            if not isinstance(ctx, PtyContext) or ctx.role != ROLE_RESIDENT or args:
                raise PtyRefused("no_context")
            call = await asyncio.to_thread(resident_chat_call, ctx, kwargs)
        except PtyRefused as exc:
            _count(f"denied_pty_{exc.code}")
            raise make_refusal(exc.detail) from None
        except Exception:  # noqa: BLE001
            _count("denied_pty_error")
            raise make_refusal("This chat cannot start here.") from None
        argv, cwd, env = await base_resolve(**call)
        try:
            env = await asyncio.to_thread(resident_chat_env, ctx, env)
        except PtyRefused as exc:
            _count(f"denied_pty_{exc.code}")
            raise make_refusal(exc.detail) from None
        except Exception:  # noqa: BLE001
            _count("denied_pty_error")
            raise make_refusal("This chat cannot start here.") from None
        _count("pty_resident_resolved")
        return argv, cwd, env

    def guarded_spawn(argv: Any, args: tuple, kwargs: dict) -> Any:
        ctx = _PTY_CONTEXT.get()
        if not isinstance(ctx, PtyContext) or ctx.role != ROLE_RESIDENT:
            # An admin's terminal, or no dashboard socket behind it (the argv seam has already
            # refused a /api/pty without a context): Hermes's own spawn.
            return base_bridge.spawn(argv, *args, **kwargs)
        grant = ctx.grant
        env = kwargs.get("env")
        if (not isinstance(grant, PtyGrant) or grant.state != "minted" or args or not isinstance(env, dict)
                or grant.credential not in str(env.get("HERMES_TUI_GATEWAY_URL") or "")):
            revoke_grant(grant, "spawn_mismatch")
            _count("denied_pty_spawn")
            raise unavailable("this chat cannot start here")
        with _pty_lock:
            over = sum(1 for g in _pty_grants.values()
                       if g.login == grant.login and g.state in _GRANT_LIVE and g is not grant)
            if over < RESIDENT_PTYS_PER_LOGIN:
                grant.state = "spawning"
        if grant.state != "spawning":
            revoke_grant(grant, "over_limit")
            _count("denied_pty_limit")
            raise unavailable(f"you already have {RESIDENT_PTYS_PER_LOGIN} chat terminals open; close one first")
        try:
            bridge = base_bridge.spawn(argv, **kwargs)
        except BaseException:
            revoke_grant(grant, "spawn_failed")
            raise
        guarded = GrantBridge(bridge, grant)
        with _pty_lock:
            if grant.state == "spawning":
                grant.state = "bound"
        _count("pty_resident_spawned")
        return guarded

    def spawn(cls: Any, argv: Any, *args: Any, **kwargs: Any) -> Any:
        return guarded_spawn(argv, args, kwargs)

    guarded_bridge = type(base_bridge.__name__, (base_bridge,), {
        "spawn": classmethod(spawn), "__module__": __name__, "__doc__": base_bridge.__doc__,
        "_edgecity_resident_guard": True, "_edgecity_original": base_bridge})

    def _drop_unbound(ctx: PtyContext) -> None:
        if ctx.grant is not None and ctx.grant.state == "minted":
            revoke_grant(ctx.grant, "not_spawned")

    async def _make_room(ctx: PtyContext, key: str) -> None:
        """At the login's limit, close its own oldest detached terminals (never another login's,
        never the one being reattached) until one fits."""
        sessions = getattr(registry, "_sessions", None)
        if not isinstance(sessions, dict) or _live_count(ctx.login, ctx.grant) < RESIDENT_PTYS_PER_LOGIN:
            return
        current = sessions.get(key)
        if current is not None and getattr(current, "alive", False):
            return
        lock = getattr(registry, "_attach_lock", None)
        async with (lock if lock is not None else contextlib.AsyncExitStack()):
            idle = sorted(((getattr(s, "last_detached_at", None) or 0.0, k) for k, s in list(sessions.items())
                           if k.startswith(ctx.namespace) and k != key and getattr(s, "alive", False)
                           and not getattr(s, "attached", True)))
            doomed = []
            for _when, k in idle:
                if _live_count(ctx.login, ctx.grant) - len(doomed) < RESIDENT_PTYS_PER_LOGIN:
                    break
                session = sessions.pop(k, None)
                if session is not None:
                    doomed.append(session)
        for session in doomed:
            _count("pty_resident_evicted")
            with contextlib.suppress(Exception):
                await session.close()
            with contextlib.suppress(Exception):  # idempotent; revokes even if close() stopped early
                await asyncio.to_thread(session.bridge.close)

    async def attach_or_spawn(key: Any, *args: Any, **kwargs: Any) -> Any:
        ctx = _PTY_CONTEXT.get()
        if not isinstance(ctx, PtyContext) or ctx.role != ROLE_RESIDENT:
            return await base_attach(key, *args, **kwargs)
        key = f"{ctx.namespace}{key}"
        try:
            await _make_room(ctx, key)
            if _live_count(ctx.login, ctx.grant) >= RESIDENT_PTYS_PER_LOGIN:
                sessions = getattr(registry, "_sessions", None)
                current = sessions.get(key) if isinstance(sessions, dict) else None
                if current is None or not getattr(current, "alive", False):
                    _count("denied_pty_limit")
                    raise make_full()
            session, created = await base_attach(key, *args, **kwargs)
        except BaseException:
            _drop_unbound(ctx)
            raise
        if not created:
            _drop_unbound(ctx)  # reattached: the child already running keeps its own credential
        return session, created

    def detach_guarded(key: Any, *args: Any, **kwargs: Any) -> Any:
        ctx = _PTY_CONTEXT.get()
        if isinstance(ctx, PtyContext) and ctx.role == ROLE_RESIDENT:
            key = f"{ctx.namespace}{key}"
        return base_detach(key, *args, **kwargs)

    _pty_loopback = frozenset(h for h in (getattr(chat_module, "_LOOPBACK_HOSTS", None) or ()) if isinstance(h, str))
    _process_credential = lambda: getattr(tickets_module, "_internal_credential", None)  # noqa: E731
    _pty_url_builder = build
    tickets_module.consume_internal_credential = _mark(consume_internal_credential, base_consume)
    chat_module._resolve_chat_argv_async = _mark(_resolve_chat_argv_async, base_resolve)
    chat_module.PtyBridge = guarded_bridge
    registry.attach_or_spawn = _mark(attach_or_spawn, base_attach)
    registry.detach = _mark(detach_guarded, base_detach)
    _installed["pty"] = True
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


#: Hermes's own reference parser (`agent.context_references.parse_context_references`), handed in
#: by `__init__`: the `@file:` references a resident may keep are read exactly as Hermes reads
#: them. None: no reference is admitted.
_reference_parser: Optional[Callable[[str], Any]] = None


def set_reference_parser(fn: Optional[Callable[[str], Any]]) -> None:
    global _reference_parser
    _reference_parser = fn


def _fold(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text)
    for marker in _PASTE_MARKERS:
        folded = folded.replace(marker, "")
    return "".join(ch for ch in folded if unicodedata.category(ch)[0] not in ("C", "Z"))


def names_file_reference(text: Any, admitted: Optional[Callable[[str], Any]] = None) -> bool:
    """Whether prompt text carries an `@file:` or `@folder:` reference: as written, after Hermes's
    own sanitiser, and in each once Unicode is folded and control, format and space characters and
    paste markers are dropped (so `@fi<ZWSP>le:` and `＠file:` count). `admitted(form)` first blanks
    the references a resident may keep out of each form (`strip_admitted_references`). Text that is
    not a string, or a sanitiser or `admitted` that fails, counts as a reference (fail closed)."""
    if text is None:
        return False
    if not isinstance(text, str):
        return True
    forms = []
    try:
        bases = [text] + ([_prompt_sanitizer(text)] if _prompt_sanitizer is not None else [])
        for base in bases:
            if isinstance(base, str) and admitted is not None:
                base = admitted(base)
            if not isinstance(base, str):
                return True
            forms += [base, _fold(base)]
    except Exception:  # noqa: BLE001
        return True
    return any(_FILE_REF.search(form) for form in forms)


def resident_file_allowed(target: Any, cwd: Any) -> bool:
    """Whether a resident's `@file:` target may stay in its prompt (S-r3-2): the chat runs in the
    resident directory (`cwd`, resolved), and the target, resolved as Hermes resolves it (`~`, then
    relative to the chat's cwd, `context_references.py:_resolve_path`) and then through every
    symlink, is inside one of RESIDENT_FILE_DIRS (a directory that is itself a link admits
    nothing), names no private file, and is a plain file or not there yet. Anything else, or
    anything that cannot be read, is refused."""
    try:
        if type(target) is not str or not target.strip() or "\x00" in target:
            return False
        home = os.path.realpath(_hermes_home())
        chat = os.path.join(home, RESIDENT_CWD_NAME)
        if type(cwd) is not str or not cwd or os.path.realpath(os.path.expanduser(cwd)) != chat:
            return False
        resolved = os.path.realpath(os.path.join(chat, os.path.expanduser(target)))
        inside = False
        for name in RESIDENT_FILE_DIRS:
            root = os.path.join(home, name)
            if os.path.islink(root) or os.path.realpath(root) != root:
                continue
            inside = inside or resolved.startswith(root + os.sep)
        if not inside or private_path(resolved):
            return False
        return not os.path.lexists(resolved) or os.path.isfile(resolved)
    except Exception:  # noqa: BLE001
        return False


def strip_admitted_references(text: str, cwd: Any) -> Optional[str]:
    """`text` with each `@file:` reference that Hermes's own parser reads and
    `resident_file_allowed` admits replaced by a space. Every other reference stays, so the strict
    check in `names_file_reference` still refuses it (`@folder:`, a file elsewhere). No parser: the
    text unchanged (nothing admitted). A parser answer that is not well formed: None (refused)."""
    parser = _reference_parser
    if parser is None:
        return text
    spans = []
    for ref in parser(text) or ():
        kind, target = getattr(ref, "kind", None), getattr(ref, "target", None)
        start, end = getattr(ref, "start", None), getattr(ref, "end", None)
        if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(text):
            return None
        if kind == "file" and resident_file_allowed(target, cwd):
            spans.append((start, end))
    out, last = [], 0
    for start, end in sorted(spans):
        if start < last:
            return None
        out += [text[last:start], " "]
        last = end
    return "".join(out) + text[last:]


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
    if OWN_ROWS in rules and view is None:
        return "denied_gateway_list", req
    if NO_FILE_REFS in rules:
        if any(type(k) is not str or k.startswith("_") for k in params):
            return "denied_gateway_params", req
        record = view.live(sid) if view is not None else None
        cwd = record.get("cwd") if record is not None else None
        if names_file_reference(params.get("text"), lambda form: strip_admitted_references(form, cwd)):
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


def own_rows_reply(method: Any, frame: Any, login: Optional[str], profile: Any) -> Any:
    """A resident's `session.list` / `session.most_recent` reply with only the resident's rows
    (S-r3-1). The rows (`methods_session.py:117`) carry no `user_id`, so each id's stored owner is
    read through `_session_owners` and judged by `session_visible`. `session.most_recent` naming
    another login's chat answers Hermes's own "none" (`{"session_id": null}`). An error reply goes
    out as it is; a reply of another shape, no owner reader or a failing one is a refusal."""
    if not isinstance(frame, dict) or "result" not in frame:
        return frame
    owners = _session_owners
    try:
        if owners is None:
            raise LookupError("no session owner reader")
        result = frame["result"]
        if not isinstance(result, dict):
            raise ValueError("not a session list")
        name = profile if type(profile) is str and profile.strip() else None
        if method == "session.most_recent":
            sid = result.get("session_id")
            if sid is None:
                return frame
            table = owners([sid], name) if type(sid) is str else {}
            if session_visible(table.get(sid), login):
                return frame
            _count("resident_list_filtered")
            return {**frame, "result": {"session_id": None}}
        rows = result.get("sessions")
        if not isinstance(rows, list):
            raise ValueError("not a session list")
        ids = [r.get("id") for r in rows if isinstance(r, dict) and type(r.get("id")) is str]
        table = owners(ids, name) if ids else {}
        kept = [r for r in rows if isinstance(r, dict) and type(r.get("id")) is str
                and session_visible(table.get(r["id"]), login)]
        _count("resident_list_filtered")
        return {**frame, "result": {**result, "sessions": kept}}
    except Exception:  # noqa: BLE001
        _count("denied_gateway_list_error")
        return _refusal(frame, method)


class FilteredReplies:
    """The transport one resident list call is dispatched with: Hermes runs `session.list` on its
    long-handler pool, and the worker writes the reply through the transport it was handed
    (`rpc_dispatch.py` `t.write(resp)`), so the reply to this call's id passes `keep` first. Every
    other frame and attribute is the connection's own transport's."""

    def __init__(self, inner: Any, rid: Any, keep: Callable[[Any], Any]) -> None:
        self._edgecity_inner = inner
        self._edgecity_rid = rid
        self._edgecity_keep = keep

    def _edgecity_pick(self, obj: Any) -> Any:
        if isinstance(obj, dict) and "method" not in obj and obj.get("id") == self._edgecity_rid:
            return self._edgecity_keep(obj)
        return obj

    def write(self, obj: Any) -> Any:
        return self._edgecity_inner.write(self._edgecity_pick(obj))

    async def write_async(self, obj: Any) -> Any:
        return await self._edgecity_inner.write_async(self._edgecity_pick(obj))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._edgecity_inner, name)


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
        grant = getattr(getattr(transport, "_ws", None), "_edgecity_pty_grant", None)
        if grant is not None and getattr(grant, "state", None) not in _GRANT_LIVE:
            # A Chat tab's child whose PTY has closed: its socket is being closed, nothing more runs.
            _count("denied_pty_revoked")
            return _refusal(req, method)
        try:
            view = GatewayView(transport, server_module, requests_module, approvals)
            code, frame = gateway_decision(role, req, view)
        except Exception:  # noqa: BLE001
            _count("denied_gateway_error")
            return _refusal(req, None)
        if code != "resident_allowed":
            _count(code if code.startswith("denied_") else "denied_gateway_method")
            return _refusal(req, method, code)
        if method in RESIDENT_GATEWAY_METHODS and OWN_ROWS in RESIDENT_GATEWAY_METHODS[method][0]:
            params = frame.get("params") if isinstance(frame.get("params"), dict) else {}

            def keep(reply: Any) -> Any:
                return own_rows_reply(method, reply, view.login, params.get("profile"))

            response = base_dispatch(frame, FilteredReplies(transport, frame.get("id"), keep), *args, **kwargs)
            return keep(response) if response is not None else None
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
            with contextlib.suppress(Exception):
                ws._edgecity_closed = True  # no longer counts against its PTY credential's sockets

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
