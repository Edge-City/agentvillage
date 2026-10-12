"""Admin-only plugin management for the Edge City dashboard (SEC-1).

Residents may not install, enable, disable, update or remove plugins; landing admins may. Hermes
puts every plugin mutation behind `_require_token`, which under the cookie gate only checks that a
session exists (`web_server.py:431-443`), so the narrowing lives here: a wrapper installed around
Hermes's cookie gate (`dashboard_auth.middleware.gated_auth_middleware`) at plugin `register()`
time. `web_server._dashboard_auth_gate` imports the gate at call time (`web_server.py:645`), so the
replacement takes effect on the next request, the same seam shape `_archive.install` uses on the
token seam.

The wrapper calls the original gate with a guarded `call_next`. The gate sets
`request.state.session` before it calls `call_next` on every authenticated path (cookie, native
bearer, refreshed), so the guard sees the verified session. On the plugin surface the guard lets
the request through only for an edgecity admin session; everything else gets a 403. Off the
surface it changes nothing, except that the SPA's `index.html` served to a non-admin gets a small
`<style>` and `<script>` that hide the Plugins nav entry and send `/plugins` to `/`.

The allow-list is closed: `session.provider == "edgecity" and session.org_id == "admin"`, which
the edgecity provider mints only for the landing-admin SSO exchange with the control plane.
No session, a token principal, another provider, any other role, or an exception in the
decision is not admin.

Standard library only and no Hermes import: the tests drive it without Hermes. The 403 is built
with the gate module's own `JSONResponse` (or the factory `install` is given).
"""

from __future__ import annotations

import logging
import threading
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

ADMIN_PROVIDER = "edgecity"
ADMIN_ROLE = "admin"

#: Every path under these prefixes is plugin management (`hermes_cli/web_routers/dashboard_ui.py`
#: v2026.9.24: `/api/dashboard/plugins/{rescan,hub,catalog}` :149/:156/:181, `/api/dashboard/plugins/
#: {name}/visibility` :345, `/api/dashboard/agent-plugins/...` :222-:290, `/api/dashboard/plugin-
#: providers` :317). A plain prefix, no trailing slash: `/api/dashboard/plugins?/hub` (a decoded
#: `%3F`) is on the surface too. Fail closed: a path no route serves only turns a 404 into a 403.
SURFACE_PREFIXES = ("/api/dashboard/agent-plugins", "/api/dashboard/plugins", "/api/dashboard/plugin-providers")
#: The one exception: `GET /api/dashboard/plugins` (`dashboard_ui.py:131`) is the manifest list every
#: page loads to mount dashboard plugin tabs (`web/src/plugins/usePlugins.ts:87`), not the Plugins page.
MANIFEST_PATH = "/api/dashboard/plugins"
#: Not mutations, and no FastAPI route answers them on a GET or POST route (a HEAD on the rescan GET
#: is a 405): left to Hermes.
PASS_METHODS = frozenset({"HEAD", "OPTIONS"})

FORBIDDEN = {"error": "forbidden", "detail": "Plugin management is admin only.", "reason": "plugin_admin_only"}

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

_log = logging.getLogger("dashboard-auth-edgecity.plugins-admin")

_counts: dict[str, int] = {}
_counts_lock = threading.Lock()


def _count(code: str) -> None:
    """Count a decision. Denials at INFO with the running counts; `admin_allowed` and the hide at
    DEBUG (a page load is not news). Never the email, the token or the path."""
    with _counts_lock:
        _counts[code] = _counts.get(code, 0) + 1
        snapshot = ", ".join(f"{key}={_counts[key]}" for key in sorted(_counts))
    level = logging.INFO if code.startswith("denied_") else logging.DEBUG
    _log.log(level, "dashboard-auth-edgecity: plugins %s (%s)", code, snapshot)


def counts() -> dict[str, int]:
    with _counts_lock:
        return dict(_counts)


def _path_on_surface(method: Any, path: Any) -> bool:
    if not isinstance(path, str):
        return True  # unknown is closed
    if not path.startswith(SURFACE_PREFIXES):
        return False
    return not (path == MANIFEST_PATH and method == "GET")


def on_surface(method: Any, url_path: Any, scope_path: Any) -> bool:
    """Plugin management, on either the parsed URL path (what Hermes's gate matches on) or the ASGI
    scope path (what the router dispatches on). No normalisation: a path the two disagree on is on
    the surface when either one is."""
    if isinstance(method, str) and method in PASS_METHODS:
        return False
    return _path_on_surface(method, url_path) or _path_on_surface(method, scope_path)


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


def _decide(request: Any) -> Optional[str]:
    """None off the surface; otherwise the decision code. Any exception is a denial."""
    try:
        if not on_surface(request.method, request.url.path, request.scope.get("path")):
            return None
        return admin_code(request.state)
    except Exception:  # noqa: BLE001 - a broken request or session object is not admin
        return "denied_error"


#: Never read for the hide: API responses, the login page and the auth flow.
_NO_HIDE_PREFIXES = ("/api/", "/auth/", "/login")


def _hide_candidate(request: Any) -> bool:
    """A GET off the API and the auth flow, on both paths (the SPA index is served on every other
    path, `web_server_dashboard.py:serve_spa`)."""
    try:
        if request.method != "GET":
            return False
        paths = (request.url.path, request.scope.get("path"))
        return all(isinstance(p, str) and not p.startswith(_NO_HIDE_PREFIXES) for p in paths)
    except Exception:  # noqa: BLE001
        return False


def _is_admin(request: Any) -> bool:
    try:
        return admin_code(request.state) == "admin_allowed"
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
    """Insert the hide into the SPA index. A plain response (`body` bytes) is patched in place; a
    streamed one (`body_iterator`: what Starlette's `call_next` hands every HTTP middleware) is read
    up to MAX_HTML_BYTES and replaced with one chunk. Anything else, an ASGI message in the stream,
    a body over the cap or a body that is not the index, goes out byte-identical."""
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

    The guard runs only when the gate hands the request on (it has set `request.state.session`
    on every authenticated path; a token principal, a public path or the gate switched off arrive
    with none). On the plugin surface only an edgecity admin session proceeds; anything else,
    an exception in the decision included, is a 403 `plugin_admin_only`, never a pass-through and
    never a 500. Off the surface the request proceeds unchanged and, for a GET under a non-admin,
    the SPA index gets the Plugins hide. The gate's own 401/302/503 never reach the guard and stay
    as they are."""

    async def edgecity_plugins_admin_gate(request: Any, call_next: Callable[[Any], Awaitable[Any]]) -> Any:
        async def guarded(req: Any) -> Any:
            code = _decide(req)
            if code is None:
                response = await call_next(req)
                if _hide_candidate(req) and not _is_admin(req):
                    try:
                        response = await hide_plugins_page(response)
                    except Exception:  # noqa: BLE001 - the hide is cosmetic; never break a page over it
                        _count("html_hide_error")
                return response
            _count(code)
            if code == "admin_allowed":
                return await call_next(req)
            return json_response(dict(FORBIDDEN), status_code=403)

        return await original(request, guarded)

    edgecity_plugins_admin_gate._edgecity_plugins_admin = True  # type: ignore[attr-defined]
    edgecity_plugins_admin_gate._edgecity_original = original  # type: ignore[attr-defined]
    return edgecity_plugins_admin_gate


def install(module: Any, *, json_response: Optional[Callable[..., Any]] = None) -> bool:
    """Install the wrapper on `module.gated_auth_middleware` (Hermes's `dashboard_auth.middleware`).

    Exactly one layer: a wrapper already installed (by this or an earlier load of the plugin) is
    replaced, wrapping the gate it wrapped. The 403 is built with `json_response`, by default the
    gate module's own `JSONResponse`. False (nothing changed) when the gate or a response class is
    missing."""
    current = getattr(module, "gated_auth_middleware", None)
    factory = json_response if json_response is not None else getattr(module, "JSONResponse", None)
    if current is None or factory is None:
        return False
    base = getattr(current, "_edgecity_original", current) if getattr(current, "_edgecity_plugins_admin", False) else current
    module.gated_auth_middleware = make_gate_wrapper(base, json_response=factory)
    return True
