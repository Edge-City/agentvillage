"""SEC-1: plugin management on the Edge City dashboard is admin only.

Two layers, as in `test_archive_token.py`. The first half needs no Hermes (CI has none): a tiny
ASGI-shaped harness drives the real wrapper from `_plugins_admin.py` around a stand-in for
Hermes's cookie gate, so every decision is checked end to end. The second half (`hermes_*` tests)
runs the real gate, seam, registry and `web_server` app and is skipped where `hermes_cli` is not
importable; run it with the pinned Hermes source on PYTHONPATH (README.md, "Tests").
"""
import asyncio
import logging
import os
import urllib.parse
from pathlib import Path
from types import SimpleNamespace

import pytest

# ---- harness -------------------------------------------------------------------------------


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


def hide_and_read(plugins_admin, streamed):
    """The hide and the send in one event loop, as in a server (a loop's end closes its
    unfinished async generators)."""

    async def run():
        out = await plugins_admin.hide_plugins_page(streamed)
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
    gate's own 401. The router 200s every path (the SPA index for non-API paths), so a 403 can
    only come from the wrapper."""

    PUBLIC = ("/login", "/auth/", "/api/auth/providers")

    def __init__(self, plugins_admin, *, auth_required=True):
        self.mod = plugins_admin
        self.auth_required = auth_required
        self.sessions = {}
        self.routed = []
        self.gate_calls = 0
        self.module = SimpleNamespace(gated_auth_middleware=self.gate, JSONResponse=json_response)
        assert plugins_admin.install(self.module) is True
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

    def request(self, method, target, *, headers=(), token_principal=False, preset_session=None):
        req = Request(method, target, headers)
        if preset_session is not None:
            req.state.session = preset_session
        if token_principal:
            req.state.token_principal = SimpleNamespace(principal="svc", provider="edgecity-archive", scopes=())
            req.state.token_authenticated = True
        resp = asyncio.run(self.module.gated_auth_middleware(req, self.router))
        return resp, req


@pytest.fixture
def dash(plugins_admin):
    return Dashboard(plugins_admin)


#: Every plugin-management route in `hermes_cli/web_routers/dashboard_ui.py` v2026.9.24.
MUTATIONS = [
    ("POST", "/api/dashboard/agent-plugins/install"),              # :222
    ("POST", "/api/dashboard/agent-plugins/av-approval/enable"),   # :255
    ("POST", "/api/dashboard/agent-plugins/av-approval/disable"),  # :262
    ("POST", "/api/dashboard/agent-plugins/av-approval/update"),   # :269
    ("DELETE", "/api/dashboard/agent-plugins/av-approval"),        # :284
    ("POST", "/api/dashboard/agent-plugins/activate"),             # :290
    ("PUT", "/api/dashboard/plugin-providers"),                    # :317
    ("POST", "/api/dashboard/plugins/av-events/visibility"),       # :345
    ("POST", "/api/dashboard/agent-plugins/org/nested/enable"),    # {name:path}
    ("PATCH", "/api/dashboard/agent-plugins/av-approval"),
    ("POST", "/api/dashboard/agent-plugins"),
]
PAGE_FEEDS = [
    ("GET", "/api/dashboard/plugins/hub"),      # :156
    ("GET", "/api/dashboard/plugins/catalog"),  # :181
    ("GET", "/api/dashboard/plugins/rescan"),   # :149, a GET that rescans
    ("GET", "/api/dashboard/agent-plugins/av-approval"),
    ("GET", "/api/dashboard/plugins/hub?refresh=1"),
]
SURFACE = MUTATIONS + PAGE_FEEDS
OFF_SURFACE = [
    ("GET", "/api/dashboard/plugins"),  # :131, the manifest list every page loads (usePlugins.ts:87)
    ("GET", "/api/dashboard/plugins?profile=default"),
    ("GET", "/api/sessions"),
    ("GET", "/api/auth/me"),
    ("GET", "/api/dashboard/themes"),
    ("PUT", "/api/dashboard/theme"),
    ("POST", "/api/cron/jobs"),
    ("GET", "/dashboard-plugins/av-events/dist/index.js"),
]


def forbidden(resp):
    return resp.status_code == 403 and resp.body == {"error": "forbidden", "detail": "Plugin management is admin only.",
                                                    "reason": "plugin_admin_only"}


# ---- the allow-list --------------------------------------------------------------------------


@pytest.mark.parametrize("method,target", SURFACE)
def test_an_owner_session_gets_403_on_every_plugin_route(dash, method, target):
    resp, _ = dash.request(method, target, headers=dash.login(OWNER))
    assert forbidden(resp)
    assert dash.routed == []


@pytest.mark.parametrize("method,target", SURFACE)
def test_an_edgecity_admin_session_reaches_the_route(dash, method, target):
    resp, _ = dash.request(method, target, headers=dash.login(ADMIN))
    assert resp.status_code == 200
    assert dash.routed == [(method, target.partition("?")[0])]


def test_a_session_bearer_is_judged_like_a_cookie(dash):
    owner_key = "owner-bearer"
    admin_key = "admin-bearer"
    dash.sessions.update({owner_key: OWNER, admin_key: ADMIN})
    assert forbidden(dash.request("POST", "/api/dashboard/agent-plugins/install", headers=[("Authorization", "Bearer " + owner_key)])[0])
    assert dash.request("POST", "/api/dashboard/agent-plugins/install", headers=[("Authorization", "Bearer " + admin_key)])[0].status_code == 200


@pytest.mark.parametrize("who", [
    session(provider="basic", org_id="admin"),
    session(provider="edgecity-archive", org_id="admin"),
    session(provider="EdgeCity", org_id="admin"),
    session(provider="edgecity", org_id="Admin"),
    session(provider="edgecity", org_id="admin "),
    session(provider="edgecity", org_id=""),
    session(provider="edgecity", org_id=None),
    session(provider=None, org_id="admin"),
    SimpleNamespace(provider="edgecity"),
    SimpleNamespace(),
])
def test_nothing_but_provider_edgecity_and_role_admin_is_admin(dash, who):
    resp, _ = dash.request("POST", "/api/dashboard/agent-plugins/install", headers=dash.login(who))
    assert forbidden(resp)
    resp, _ = dash.request("GET", "/api/dashboard/plugins/hub", headers=dash.login(who))
    assert forbidden(resp)
    assert dash.routed == []


def test_a_str_subclass_is_not_admin(dash):
    class Sneaky(str):
        def __eq__(self, other):
            return True

        __hash__ = str.__hash__

    who = session(provider=Sneaky("x"), org_id=Sneaky("y"))
    assert forbidden(dash.request("POST", "/api/dashboard/agent-plugins/install", headers=dash.login(who))[0])


@pytest.mark.parametrize("method,target", SURFACE)
def test_a_token_principal_is_not_admin(dash, method, target):
    resp, _ = dash.request(method, target, token_principal=True)
    assert forbidden(resp)
    assert dash.routed == []


def test_a_token_principal_beside_an_admin_session_is_still_not_admin(dash):
    resp, _ = dash.request("POST", "/api/dashboard/agent-plugins/install", token_principal=True, preset_session=ADMIN)
    assert forbidden(resp)
    assert dash.mod.counts() == {"denied_token_principal": 1}


# ---- no session --------------------------------------------------------------------------------


@pytest.mark.parametrize("method,target", SURFACE + OFF_SURFACE)
def test_without_a_session_the_gates_own_401_stands_on_and_off_the_surface(dash, method, target):
    resp, _ = dash.request(method, target)
    assert resp.status_code == 401 and resp.body["by"] == "gate"
    assert dash.routed == []


@pytest.mark.parametrize("method,target", SURFACE)
def test_with_the_gate_off_there_is_no_session_and_the_surface_is_closed(plugins_admin, method, target):
    loopback = Dashboard(plugins_admin, auth_required=False)
    resp, _ = loopback.request(method, target)
    assert forbidden(resp)
    assert loopback.routed == []


@pytest.mark.parametrize("method,target", OFF_SURFACE)
def test_with_the_gate_off_everything_else_is_untouched(plugins_admin, method, target):
    loopback = Dashboard(plugins_admin, auth_required=False)
    resp, _ = loopback.request(method, target)
    assert resp.status_code == 200 and loopback.routed == [(method, target.partition("?")[0])]


# ---- what the surface is -----------------------------------------------------------------------


@pytest.mark.parametrize("method,target", OFF_SURFACE)
def test_off_the_surface_an_owner_passes_untouched(dash, method, target):
    resp, _ = dash.request(method, target, headers=dash.login(OWNER))
    assert resp.status_code == 200
    assert dash.routed == [(method, target.partition("?")[0])]


@pytest.mark.parametrize("target", [
    "/api/dashboard/plugins%3F/hub",       # url.path /api/dashboard/plugins, scope path .../plugins?/hub
    "/api/dashboard/plugins%3Fx",
    "/api/dashboard/plugins%23/catalog",
    "/api/dashboard/agent-plugins%3F/install",
])
def test_a_path_the_url_and_the_scope_disagree_on_is_on_the_surface(dash, target):
    req = Request("GET", target)
    assert req.url.path != req.scope["path"]
    resp, _ = dash.request("GET", target, headers=dash.login(OWNER))
    assert forbidden(resp)
    assert dash.routed == []


def test_the_surface_is_a_plain_prefix_so_lookalikes_are_closed_too(plugins_admin):
    on = plugins_admin.on_surface
    for path in ("/api/dashboard/pluginsx", "/api/dashboard/plugins/", "/api/dashboard/plugin-providers/x",
                 "/api/dashboard/agent-pluginsx", "/api/dashboard/plugins//hub"):
        assert on("GET", path, path) and on("POST", path, path), path
    assert not on("GET", "/api/dashboard/plugins", "/api/dashboard/plugins")
    assert on("POST", "/api/dashboard/plugins", "/api/dashboard/plugins")  # only the GET is the manifest
    for path in ("/api/dashboard/theme", "/api/plugins/av-events/x", "/dashboard-plugins/x/y.js", "/plugins"):
        assert not on("POST", path, path), path
    assert on("GET", None, "/api/sessions") and on("GET", "/api/sessions", None)  # unknown is closed


@pytest.mark.parametrize("method", ["HEAD", "OPTIONS"])
def test_head_and_options_are_left_to_hermes(dash, method):
    resp, _ = dash.request(method, "/api/dashboard/plugins/rescan", headers=dash.login(OWNER))
    assert resp.status_code == 200 and dash.routed == [(method, "/api/dashboard/plugins/rescan")]


# ---- fail closed -------------------------------------------------------------------------------


class Raising:
    def __getattr__(self, name):
        raise RuntimeError("broken session")


def test_a_raising_session_is_a_403_never_a_pass_or_a_500(dash):
    resp, _ = dash.request("POST", "/api/dashboard/agent-plugins/install", headers=dash.login(Raising()))
    assert forbidden(resp)
    assert dash.mod.counts() == {"denied_error": 1}


def test_a_raising_decision_is_a_403(dash, monkeypatch):
    def boom(state):
        raise RuntimeError("decision broke")

    monkeypatch.setattr(dash.mod, "admin_code", boom)
    for who in (OWNER, ADMIN):
        assert forbidden(dash.request("POST", "/api/dashboard/agent-plugins/install", headers=dash.login(who))[0])
        assert forbidden(dash.request("GET", "/api/dashboard/plugins/hub", headers=dash.login(who))[0])
    assert dash.routed == []
    # Off the surface the broken decision changes nothing (and the page hide errs on hiding).
    resp, _ = dash.request("GET", "/api/sessions", headers=dash.login(ADMIN))
    assert resp.status_code == 200


def test_a_raising_request_is_a_403(dash):
    req = Request("POST", "/api/dashboard/agent-plugins/install")

    class BadScope(dict):
        def get(self, *a, **k):
            raise RuntimeError("no scope")

    req.scope = BadScope(req.scope)
    req.state.session = ADMIN

    async def gate_passes(request, call_next):
        return await call_next(request)

    wrapper = dash.mod.make_gate_wrapper(gate_passes, json_response=json_response)
    resp = asyncio.run(wrapper(req, dash.router))
    assert forbidden(resp) and dash.routed == []


# ---- one layer -----------------------------------------------------------------------------------


def test_install_keeps_exactly_one_layer(plugins_admin, load_archive_copy):
    async def gate(request, call_next):
        return await call_next(request)

    module = SimpleNamespace(gated_auth_middleware=gate, JSONResponse=json_response)
    assert plugins_admin.install(module) is True
    first = module.gated_auth_middleware
    assert first is not gate and first._edgecity_plugins_admin and first._edgecity_original is gate
    assert plugins_admin.install(module) is True
    assert module.gated_auth_middleware is not first
    assert module.gated_auth_middleware._edgecity_original is gate  # replaced, not stacked
    # Another copy of the module (a second plugin load) agrees on the marker.
    import importlib.util
    spec = importlib.util.spec_from_file_location("edgecity_test_plugins_admin_copy", Path(plugins_admin.__file__))
    copy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(copy)
    assert copy.install(module) is True
    assert module.gated_auth_middleware._edgecity_original is gate
    # Nothing to wrap, or nothing to build a 403 with: not installed, nothing changed.
    assert plugins_admin.install(SimpleNamespace()) is False
    bare = SimpleNamespace(gated_auth_middleware=gate)
    assert plugins_admin.install(bare) is False and bare.gated_auth_middleware is gate
    assert plugins_admin.install(bare, json_response=json_response) is True


def test_one_layer_means_one_decision_per_request(dash):
    dash.mod.install(dash.module)
    dash.mod.install(dash.module)
    dash.request("POST", "/api/dashboard/agent-plugins/install", headers=dash.login(OWNER))
    assert dash.gate_calls == 1 and dash.mod.counts() == {"denied_non_admin": 1}


# ---- logs ----------------------------------------------------------------------------------------


def test_logs_carry_codes_and_counts_never_the_email_or_token(dash, caplog):
    caplog.set_level(logging.DEBUG)
    dash.request("POST", "/api/dashboard/agent-plugins/install", headers=dash.login(OWNER))
    dash.request("POST", "/api/dashboard/agent-plugins/install", headers=dash.login(ADMIN))
    dash.request("POST", "/api/dashboard/agent-plugins/install", headers=dash.login(session(provider="basic", org_id="admin")))
    dash.request("POST", "/api/dashboard/agent-plugins/install", token_principal=True)
    Dashboard(dash.mod, auth_required=False).request("PUT", "/api/dashboard/plugin-providers")
    dash.request("GET", "/sessions", headers=dash.login(OWNER))
    text = caplog.text
    for secret in ("owner@example.org", "admin@example.org", "at-secret-value", "rt-secret-value", "cookie-0"):
        assert secret not in text
    levels = {r.getMessage().split(" (")[0].rsplit(" ", 1)[-1]: r.levelno for r in caplog.records
              if r.name == "dashboard-auth-edgecity.plugins-admin"}
    assert levels == {"denied_non_admin": logging.INFO, "admin_allowed": logging.DEBUG,
                      "denied_other_provider": logging.INFO, "denied_token_principal": logging.INFO,
                      "denied_no_session": logging.INFO, "html_hidden": logging.DEBUG}
    assert dash.mod.counts() == {"denied_non_admin": 1, "admin_allowed": 1, "denied_other_provider": 1,
                                 "denied_token_principal": 1, "denied_no_session": 1, "html_hidden": 1}
    assert "denied_non_admin=1" in text  # running counts


# ---- the Plugins page hide -----------------------------------------------------------------------


def test_the_spa_index_under_an_owner_gets_the_hide_before_head_end(dash):
    resp, _ = dash.request("GET", "/plugins", headers=dash.login(OWNER))
    body = resp.body
    assert body == INDEX.replace(b"</head>", dash.mod.HIDE_SNIPPET + b"</head>", 1)
    assert body.index(b"window.__HERMES_BASE_PATH__") < body.index(b'data-edgecity="plugins-admin-only"')
    assert resp.headers.get("content-length") == str(len(body))
    assert b'nav a[href$="/plugins"]{display:none!important}' in body
    assert b'location.replace(b+"/")' in body


@pytest.mark.parametrize("path", ["/", "/sessions", "/plugins", "/config"])
def test_the_spa_index_under_an_admin_is_byte_identical(dash, path):
    resp, _ = dash.request("GET", path, headers=dash.login(ADMIN))
    assert resp.body == INDEX and resp.headers.get("content-length") == str(len(INDEX))


def test_the_index_with_the_gate_off_is_hidden_too(plugins_admin):
    loopback = Dashboard(plugins_admin, auth_required=False)
    resp, _ = loopback.request("GET", "/plugins")
    assert plugins_admin.HIDE_SNIPPET in resp.body


def test_the_login_page_and_api_responses_are_never_touched(dash):
    resp, _ = dash.request("GET", "/login")
    assert resp.body == LOGIN
    dash.html = INDEX
    for target in ("/api/sessions", "/api/auth/me"):
        resp, _ = dash.request("GET", target, headers=dash.login(OWNER))
        assert resp.body == {"path": target}


def test_html_under_api_is_not_read_even_when_it_looks_like_the_index(dash):
    async def router(request):
        return Response(200, INDEX, "text/html")

    req = Request("GET", "/api/mcp/oauth/callback/x")
    req.state.session = OWNER

    async def gate_passes(request, call_next):
        return await call_next(request)

    wrapper = dash.mod.make_gate_wrapper(gate_passes, json_response=json_response)
    assert asyncio.run(wrapper(req, router)).body == INDEX


@pytest.mark.parametrize("response", [
    Response(200, INDEX, "application/json"),
    Response(200, INDEX, "text/plain"),
    Response(404, INDEX, "text/html"),
    Response(200, LOGIN, "text/html"),
    Response(200, {"not": "bytes"}, "text/html"),
    Response(200, INDEX.replace(b"</head>", b""), "text/html"),
])
def test_anything_but_the_index_is_byte_identical(plugins_admin, response):
    before = response.body
    out = asyncio.run(plugins_admin.hide_plugins_page(response))
    assert out is response and out.body == before


def test_a_compressed_index_is_byte_identical(plugins_admin):
    response = Response(200, INDEX, "text/html")
    response.headers["content-encoding"] = "gzip"
    assert asyncio.run(plugins_admin.hide_plugins_page(response)).body == INDEX


def test_the_hide_is_applied_once(plugins_admin):
    once = plugins_admin.inject_hide(INDEX)
    assert once is not None and plugins_admin.inject_hide(once) is None


def test_a_streamed_index_is_hidden_and_its_length_fixed(plugins_admin):
    streamed = Streamed([INDEX[:40], INDEX[40:]])
    out = asyncio.run(plugins_admin.hide_plugins_page(streamed))
    body = b"".join(out.read())
    assert body == plugins_admin.inject_hide(INDEX)
    assert out.headers.get("content-length") == str(len(body))


def test_a_streamed_non_index_is_byte_identical(plugins_admin):
    streamed = Streamed([LOGIN[:10], LOGIN[10:]])
    out = asyncio.run(plugins_admin.hide_plugins_page(streamed))
    assert b"".join(out.read()) == LOGIN and out.headers.get("content-length") == str(len(LOGIN))


def test_a_streamed_asgi_message_or_an_oversize_body_goes_out_unchanged(plugins_admin, monkeypatch):
    message = {"type": "http.response.pathsend", "path": "/x"}
    out, chunks = hide_and_read(plugins_admin, Streamed([INDEX[:10], message, INDEX[10:]]))
    assert chunks == [INDEX[:10], message, INDEX[10:]]
    monkeypatch.setattr(plugins_admin, "MAX_HTML_BYTES", 32)
    out, chunks = hide_and_read(plugins_admin, Streamed([INDEX[:20], INDEX[20:40], INDEX[40:]]))
    assert chunks == [INDEX[:20], INDEX[20:40], INDEX[40:]]
    assert out.headers.get("content-length") == str(len(INDEX))


def test_a_stream_that_fails_fails_where_it_would_have(plugins_admin):
    out = asyncio.run(plugins_admin.hide_plugins_page(Streamed([INDEX[:10], RuntimeError("app broke")])))
    with pytest.raises(RuntimeError, match="app broke"):
        out.read()


def test_a_broken_hide_never_breaks_the_page(dash, monkeypatch):
    async def boom(response):
        raise RuntimeError("hide broke")

    monkeypatch.setattr(dash.mod, "hide_plugins_page", boom)
    resp, _ = dash.request("GET", "/plugins", headers=dash.login(OWNER))
    assert resp.status_code == 200 and resp.body == INDEX
    assert dash.mod.counts() == {"html_hide_error": 1}


def test_a_post_off_the_surface_is_never_read(dash):
    resp, _ = dash.request("POST", "/sessions", headers=dash.login(OWNER))
    assert resp.body == INDEX


# ---- against the real Hermes gate and app (skipped without hermes_cli) ---------------------------

TENANT = "tenant-sec1"


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
    return dist


@pytest.fixture(scope="session")
def web_server(web_dist, tmp_path_factory):
    """`hermes_cli.web_server` imported with the stand-in dist (WEB_DIST is read at import)."""
    pytest.importorskip("hermes_cli.dashboard_auth")
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    import sys

    import hermes_cli

    # pytest's importlib mode names this file `plugins.dashboard-auth-edgecity.tests...` and puts a
    # stand-in `plugins` package (this repo's plugins/) in sys.modules, which hides Hermes's own
    # top-level `plugins` package (`plugins.memory`, imported by web_server). Hermes's
    # `plugins/__init__.py` is empty, so adding its directory to the stand-in's path is enough.
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
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    return module


@pytest.fixture
def hermes(load_plugin, web_server, tmp_path, monkeypatch):
    plugin = load_plugin()
    from hermes_cli import plugins_cmd, plugins_cmd_catalog
    from hermes_cli.dashboard_auth import middleware, registry, token_auth
    from hermes_cli.web_routers import dashboard_ui

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(plugin, "_post_json", lambda *args: (200, {"ok": True}))
    monkeypatch.setattr(middleware, "gated_auth_middleware", middleware.gated_auth_middleware)
    monkeypatch.setattr(token_auth, "token_auth_middleware", token_auth.token_auth_middleware)
    monkeypatch.setattr(web_server.app.state, "auth_required", True, raising=False)
    # Route bodies an admin reaches: stubbed, so nothing is cloned, rescanned or written.
    calls = []
    monkeypatch.setattr(web_server, "_get_dashboard_plugins", lambda force_rescan=False: calls.append(("scan", force_rescan)) or [])
    monkeypatch.setattr(dashboard_ui, "_merged_plugins_hub", lambda: {"stub": "hub"})
    monkeypatch.setattr(plugins_cmd, "_discover_all_plugins", lambda: [])
    monkeypatch.setattr(plugins_cmd_catalog, "installed_catalog_state", lambda installed: {"stub": "catalog"})
    for name in ("dashboard_install_plugin", "dashboard_set_agent_plugin_enabled", "dashboard_update_user_plugin",
                 "dashboard_remove_user_plugin"):
        monkeypatch.setattr(plugins_cmd, name, lambda *a, _n=name, **k: calls.append((_n, a, k)) or {"ok": True, "name": "stub"})
    registry.clear_providers()
    token_auth.clear_token_routes()
    ctx = Ctx()
    plugin.register(ctx)
    from starlette.testclient import TestClient

    yield SimpleNamespace(plugin=plugin, ctx=ctx, registry=registry, token_auth=token_auth, middleware=middleware,
                          app=web_server.app, web_server=web_server, calls=calls,
                          client=lambda: TestClient(web_server.app))
    registry.clear_providers()
    token_auth.clear_token_routes()


def mint(hermes, role):
    return hermes.registry.get_provider("edgecity")._mint(f"{role}-id", f"{role}@example.org", role)


def as_role(hermes, role):
    client = hermes.client()
    client.cookies.set("hermes_session_at", mint(hermes, role).access_token)
    return client


#: (method, path, json body) on the real app; the bodies are valid so an admin reaches the handler.
HERMES_SURFACE = [
    ("POST", "/api/dashboard/agent-plugins/install", {"identifier": "https://example.invalid/x.git"}),
    ("POST", "/api/dashboard/agent-plugins/av-approval/enable", None),
    ("POST", "/api/dashboard/agent-plugins/av-approval/disable", None),
    ("POST", "/api/dashboard/agent-plugins/av-approval/update", {}),
    ("DELETE", "/api/dashboard/agent-plugins/av-approval", None),
    ("POST", "/api/dashboard/agent-plugins/activate", {"name": "a..b"}),
    ("PUT", "/api/dashboard/plugin-providers", {}),
    ("POST", "/api/dashboard/plugins/a..b/visibility", {"hidden": True}),
    ("GET", "/api/dashboard/plugins/rescan", None),
    ("GET", "/api/dashboard/plugins/hub", None),
    ("GET", "/api/dashboard/plugins/catalog", None),
]


def send(client, method, path, body, **kw):
    return client.request(method, path, json=body, **kw) if body is not None else client.request(method, path, **kw)


def test_hermes_register_wraps_the_real_gate_once(hermes):
    gate = hermes.middleware.gated_auth_middleware
    assert gate._edgecity_plugins_admin is True
    original = gate._edgecity_original
    assert not getattr(original, "_edgecity_plugins_admin", False)
    hermes.plugin.register(Ctx())
    assert hermes.middleware.gated_auth_middleware._edgecity_original is original


@pytest.mark.parametrize("method,path,body", HERMES_SURFACE)
def test_hermes_an_owner_gets_403_on_every_plugin_route(hermes, method, path, body):
    resp = send(as_role(hermes, "owner"), method, path, body)
    assert resp.status_code == 403
    assert resp.json() == {"error": "forbidden", "detail": "Plugin management is admin only.", "reason": "plugin_admin_only"}
    assert hermes.calls == []


def routed_here(hermes, method, path):
    """Whether the loaded Hermes has this route (the suite may run against another Hermes than the
    pinned v2026.9.24: `activate` is not in every version)."""
    from starlette.routing import Match

    scope = {"type": "http", "method": method, "path": path, "root_path": "", "query_string": b"", "headers": []}
    for route in hermes.app.router.routes:
        match, _ = route.matches(scope)
        if match is Match.FULL and getattr(route, "path", "") != "/{full_path:path}":
            return True
    return False


@pytest.mark.parametrize("method,path,body", HERMES_SURFACE)
def test_hermes_an_admin_reaches_every_plugin_route(hermes, method, path, body):
    if not routed_here(hermes, method, path):
        pytest.skip(f"{method} {path} is not a route in this Hermes")
    resp = send(as_role(hermes, "admin"), method, path, body)
    assert resp.status_code != 403, resp.text
    if "a..b" in path or (body and body.get("name") == "a..b"):
        assert resp.status_code == 400 and resp.json()["detail"] == "Invalid plugin name."  # the handler's own check
    else:
        assert resp.status_code == 200, resp.text


def test_hermes_admin_route_bodies_ran(hermes):
    client = as_role(hermes, "admin")
    assert client.get("/api/dashboard/plugins/hub").json() == {"stub": "hub"}
    assert client.get("/api/dashboard/plugins/catalog").json() == {"stub": "catalog"}
    assert client.post("/api/dashboard/agent-plugins/install", json={"identifier": "https://example.invalid/x.git"}).json()["ok"] is True
    assert [c[0] for c in hermes.calls if c[0] != "scan"] == ["dashboard_install_plugin"]


def test_hermes_the_manifest_list_and_other_pages_still_work_for_an_owner(hermes):
    client = as_role(hermes, "owner")
    assert client.get("/api/dashboard/plugins").status_code == 200
    me = client.get("/api/auth/me").json()
    assert (me["provider"], me["org_id"]) == ("edgecity", "owner")
    assert client.get("/api/dashboard/themes").status_code == 200


def test_hermes_no_cookie_is_the_gates_own_401(hermes):
    client = hermes.client()
    for path in ("/api/dashboard/plugins/hub", "/api/auth/me"):
        resp = client.get(path)
        assert resp.status_code == 401 and resp.json()["reason"] == "no_cookie"
    assert client.post("/api/dashboard/agent-plugins/install", json={"identifier": "x"}).json()["reason"] == "no_cookie"


def test_hermes_an_owner_session_bearer_gets_403_and_an_admin_bearer_passes(hermes):
    client = hermes.client()
    owner = {"Authorization": "Bearer " + mint(hermes, "owner").access_token}
    admin = {"Authorization": "Bearer " + mint(hermes, "admin").access_token}
    assert client.get("/api/dashboard/plugins/hub", headers=owner).status_code == 403
    assert client.get("/api/dashboard/plugins/hub", headers=admin).status_code == 200


def test_hermes_a_refreshed_owner_session_gets_403_with_its_rotated_cookies(hermes):
    client = hermes.client()
    client.cookies.set("hermes_session_rt", mint(hermes, "owner").refresh_token)
    resp = client.post("/api/dashboard/agent-plugins/install", json={"identifier": "x"})
    assert resp.status_code == 403 and resp.json()["reason"] == "plugin_admin_only"
    assert "hermes_session_at" in resp.headers.get("set-cookie", "")  # the gate's rotation still lands


def test_hermes_a_token_principal_is_not_admin(hermes):
    from hermes_cli.dashboard_auth import DashboardAuthProvider, TokenPrincipal

    class Service(DashboardAuthProvider):
        name = "sec1-service"
        display_name = "service"
        supports_token = True
        supports_session = False

        def verify_token(self, *, token):
            return TokenPrincipal(principal="svc", provider=self.name, scopes=()) if token == "svc-token" else None

        def start_login(self, **k):
            raise NotImplementedError

        def complete_login(self, **k):
            raise NotImplementedError

        def verify_session(self, **k):
            return None

        def refresh_session(self, **k):
            raise NotImplementedError

        def revoke_session(self, **k):
            return None

    hermes.registry.register_global_provider(Service())
    hermes.token_auth.register_token_route("/api/dashboard/plugins/hub")
    hermes.token_auth.register_token_route("/api/dashboard/agent-plugins/install")
    client = hermes.client()
    bearer = {"Authorization": "Bearer svc-token"}
    assert client.get("/api/dashboard/plugins/hub", headers=bearer).status_code == 403
    assert client.post("/api/dashboard/agent-plugins/install", headers=bearer, json={"identifier": "x"}).status_code == 403
    assert hermes.calls == []


def test_hermes_a_path_the_url_and_scope_disagree_on_is_403(hermes):
    client = as_role(hermes, "owner")
    assert client.get("/api/dashboard/plugins%3F/hub").status_code == 403


def test_hermes_head_is_not_routed_to_a_get_handler(hermes):
    resp = as_role(hermes, "owner").head("/api/dashboard/plugins/rescan")
    assert resp.status_code == 405 and hermes.calls == []


def test_hermes_with_the_gate_off_the_surface_is_closed(hermes, monkeypatch):
    monkeypatch.setattr(hermes.app.state, "auth_required", False)
    token = {hermes.web_server._SESSION_HEADER_NAME: hermes.web_server._SESSION_TOKEN}
    client = hermes.client()
    assert client.get("/api/dashboard/plugins/hub", headers=token).status_code == 403
    assert client.post("/api/dashboard/agent-plugins/install", headers=token, json={"identifier": "x"}).status_code == 403
    assert client.get("/api/dashboard/plugins", headers=token).status_code == 200
    assert hermes.calls == [("scan", False)]


HIDE_MARK = 'data-edgecity="plugins-admin-only"'


@pytest.mark.parametrize("path", ["/plugins", "/", "/sessions"])
def test_hermes_the_spa_index_under_an_owner_hides_the_plugins_page(hermes, path):
    resp = as_role(hermes, "owner").get(path)
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/html")
    html = resp.text
    assert html.count(HIDE_MARK) == 3
    assert html.index("window.__HERMES_BASE_PATH__") < html.index(HIDE_MARK) < html.index("</head>")
    assert int(resp.headers["content-length"]) == len(resp.content)


def test_hermes_the_spa_index_under_an_admin_is_unchanged(hermes):
    owner = as_role(hermes, "owner").get("/plugins").content
    admin = as_role(hermes, "admin").get("/plugins").content
    assert HIDE_MARK.encode() not in admin
    assert owner == admin.replace(b"</head>", hermes.plugin._plugins_admin.HIDE_SNIPPET + b"</head>", 1)


def test_hermes_the_login_page_is_untouched(hermes):
    resp = hermes.client().get("/login")
    assert resp.status_code == 200 and HIDE_MARK not in resp.text


def test_hermes_under_a_proxy_prefix_the_hide_reads_the_base_path(hermes):
    resp = as_role(hermes, "owner").get("/plugins", headers={"X-Forwarded-Prefix": "/hermes"})
    assert 'window.__HERMES_BASE_PATH__="/hermes"' in resp.text and HIDE_MARK in resp.text
