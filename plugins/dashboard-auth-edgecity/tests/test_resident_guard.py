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


def session_lookup(rows=SESSION_ROWS):
    def lookup(session_id, profile=None, *, prefix):
        if session_id in rows:
            return rows[session_id]
        if prefix:
            found = [r for k, r in rows.items() if k.startswith(session_id)]
            return found[0] if len(found) == 1 else None
        return None

    return lookup


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
    ("GET", "/api/sessions/stats"),
    ("GET", "/api/sessions/empty/count"),
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
             guard.OWN_REQUEST, guard.PINNED_CWD, guard.NO_FILE_REFS, guard.ANSWER}
    for name, (rules, why) in guard.RESIDENT_GATEWAY_METHODS.items():
        assert isinstance(rules, tuple) and set(rules) <= known and why.strip(), name
    for source, why in guard.RESIDENT_SESSION_SOURCES.items():
        assert source == source.strip().lower() and why.strip()
    assert set(guard.RESIDENT_WS_PATHS) == {"/api/ws"}


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
                       "denied_private_path": logging.INFO, "resident_allowed": logging.DEBUG}
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
    for target in ("/api/sessions", "/api/auth/me"):
        resp, _ = dash.request("GET", target, headers=dash.login(OWNER))
        assert resp.body == {"path": target}


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
        return {"id": rid, "result": "ran"}

    def login(transport):
        ident = transport.auth_identity
        return f"{ident['provider']}:{ident['user_id']}" if ident else None

    import threading

    server = SimpleNamespace(
        dispatch=dispatch, _sessions=live_chats(), _sessions_lock=threading.Lock(),
        _session_transport_contains=lambda rec, t: login(t) in rec.get("attached", ()))
    server.frames = frames
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
                         (file_safety, "_READ_DENIED_DIRS"), (context_references, "_ensure_reference_path_allowed")):
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
         ("chat", "_ws_auth_reason"), ("tui_server", "dispatch"), ("tui_ws", "handle_ws"))


def test_hermes_register_installs_every_seam_once(hermes):
    g = hermes.guard
    assert {k: v for k, v in g.installed().items() if k != "files"} == {"http": True, "tickets": True, "ws": True,
                                                                         "gateway": True, "agent_reads": True,
                                                                         "references": True}
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
    assert owner.get("/api/sessions/stats").status_code == 200
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


@pytest.mark.parametrize("url", ["/api/console", "/api/pty", "/api/pub?channel=c1", "/api/events?channel=c1",
                                 "/api/audio/speak-stream", "/api/plugins/kanban/events"])
def test_hermes_m1_an_owner_opens_no_socket_but_the_chat_gateway(hermes, url):
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
