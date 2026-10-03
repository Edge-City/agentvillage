"""DATA-88: the archive_read bearer on the Edge City dashboard.

Two layers. The first half needs no Hermes (CI has none): a tiny ASGI-shaped harness drives the
real route wrapper from `_archive.py` in front of a stand-in for Hermes's seam and cookie gate,
so every decision is checked end to end. The wrapper only ever vouches for the archive token;
any other bearer on the two routes falls through to the seam and the gate as if it were absent. The second half (`hermes_*` tests) imports
the real seam, gate and registry and is skipped where `hermes_cli` is not importable; run it with
the pinned Hermes source on PYTHONPATH (README.md, "Tests").
"""
import asyncio
import hashlib
import hmac
import json
import logging
import urllib.parse
from pathlib import Path
from types import SimpleNamespace

import pytest

#: The shared vector file (D5); the control plane and agentvillage-data copy it verbatim.
VECTORS = Path(__file__).parents[3] / "tests" / "vectors" / "archive_read.v1.json"
V = json.loads(VECTORS.read_text(encoding="utf-8"))
CASES = V["cases"]
A = CASES[0]  # tenant A
B = CASES[1]  # tenant B, same master
A_ROTATED = CASES[2]  # tenant A under the rotated master


# ---- harness -------------------------------------------------------------------------------


class Headers:
    def __init__(self, pairs):
        self._pairs = [(k.lower(), v) for k, v in pairs]

    def get(self, name, default=None):
        name = name.lower()
        return next((v for k, v in self._pairs if k == name), default)


class Request:
    """What the wrapper reads from a Starlette request, built the way uvicorn + Starlette do:
    `scope["path"]` is the percent-decoded target path (the router dispatches on it) and
    `url.path` is that path re-parsed as a URL (Hermes's seam and gate match on it)."""

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
    def __init__(self, status, body):
        self.status_code = status
        self.body = body


def unauthorized(by):
    return Response(401, {"error": "unauthenticated", "detail": "Unauthorized", "by": by})


class FakeProvider:
    """Stands in for the registered `edgecity-archive` provider: same decision function."""

    supports_token = True
    supports_session = False
    _edgecity_archive = True

    def __init__(self, archive):
        self._archive = archive
        self.archive_scope = archive.new_scope()
        self.calls = 0

    def verify_token(self, *, token):
        self.calls += 1
        return SimpleNamespace(principal="archive-read", provider="edgecity-archive",
                               scopes=("archive_read",)) if self._archive.verify(self.archive_scope, token) else None


SESSION_BEARER = "a-valid-owner-session-bearer"
SESSION_COOKIE = "hermes_session_at=a-valid-owner-session"


class Dashboard:
    """Wrapper -> stand-in seam -> stand-in cookie gate -> router.

    The seam passes through (no registered token route here except the drain path, which it
    hands to the generic token providers like Hermes does). The gate honours
    `token_authenticated`, otherwise wants a valid session as a cookie or a session bearer
    (Hermes's native-app path), and 401s everything else. The router 200s every path so a 401
    can only come from auth."""

    DRAIN = "/api/gateway/drain"

    def __init__(self, archive, provider):
        self.archive = archive
        self.provider = provider
        self.seam_calls = 0
        self.routed = []
        self.wrapper = archive.make_route_wrapper(
            self.seam, lookup_provider=lambda: self.provider)

    async def seam(self, request, call_next):
        self.seam_calls += 1
        if request.url.path == self.DRAIN:  # a registered token route: every token provider is asked
            token = self.archive.extract_bearer(request.headers)
            principal = self.provider.verify_token(token=token) if (token and self.provider) else None
            if principal is None:
                return unauthorized("seam")
            request.state.token_principal = principal
            request.state.token_authenticated = True
        return await call_next(request)

    async def gate(self, request):
        if not getattr(request.state, "token_authenticated", False):
            bearer = self.archive.extract_bearer(request.headers)
            if bearer:
                if bearer != SESSION_BEARER:
                    return unauthorized("gate")
            elif SESSION_COOKIE not in (request.headers.get("cookie") or ""):
                return unauthorized("gate")
        self.routed.append((request.method, request.scope["path"]))
        return Response(200, {"path": request.scope["path"]})

    def request(self, method, target, *, token=None, headers=()):
        hdrs = list(headers)
        if token is not None:
            hdrs.append(("Authorization", f"Bearer {token}"))
        req = Request(method, target, hdrs)
        resp = asyncio.run(self.wrapper(req, self.gate))
        return resp, req


def write_env(home, *lines, newline="\n"):
    (home / ".env").write_text("".join(line + newline for line in lines), encoding="utf-8")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("AV_ARCHIVE_READ_HASH", raising=False)
    write_env(tmp_path, "TENANT_ID=" + A["tenant_id"], "AV_EVENTS_TOKEN=unrelated", "AV_ARCHIVE_READ_HASH=" + A["sha256"])
    return tmp_path


@pytest.fixture
def dash(archive, home):
    return Dashboard(archive, FakeProvider(archive))


ALLOWED = [
    "/api/sessions",
    "/api/sessions?limit=100&offset=0&order=recent",
    "/api/sessions/20260924_101500_ab12cd/messages",
    "/api/sessions/20260924_101500_ab12cd/messages?limit=500&offset=0&order=oldest",
    "/api/sessions/cron_job-1.run:2/messages",
    "/api/sessions/" + "a" * 128 + "/messages",
]


# ---- the vector file -----------------------------------------------------------------------


def test_vector_file_round_trips():
    assert V["version"] == 1 and "TEST" in V["_comment"]
    assert len({c["token"] for c in CASES}) == len(CASES)
    for case in CASES:
        token = hmac.new(case["master"].encode(), ("archive_read:" + case["tenant_id"]).encode(), hashlib.sha256).hexdigest()
        assert token == case["token"], case["note"]
        assert hashlib.sha256(token.encode()).hexdigest() == case["sha256"], case["note"]


def test_each_vector_hash_admits_exactly_its_own_token(archive, home):
    for case in CASES:
        write_env(home, "AV_ARCHIVE_READ_HASH=" + case["sha256"])
        assert archive.stored_hash() == case["sha256"]
        assert [archive.token_matches(other["token"]) for other in CASES] == [other is case for other in CASES]


# ---- allowed --------------------------------------------------------------------------------


@pytest.mark.parametrize("target", ALLOWED)
def test_allowed_gets_are_served_with_the_seams_principal(dash, target):
    resp, req = dash.request("GET", target, token=A["token"])
    assert resp.status_code == 200
    assert req.state.token_authenticated is True
    assert (req.state.token_principal.principal, req.state.token_principal.provider) == ("archive-read", "edgecity-archive")
    assert req.state.token_principal.scopes == ("archive_read",)
    assert dash.seam_calls == 0  # decided by the wrapper; the seam never saw it


def test_bearer_scheme_is_case_insensitive_like_hermes(dash):
    resp, _ = dash.request("GET", "/api/sessions", headers=[("Authorization", "bearer  " + A["token"] + " ")])
    assert resp.status_code == 200


def test_percent_encoded_target_that_decodes_to_an_allowed_route_reaches_only_that_route(dash):
    resp, _ = dash.request("GET", "/api/sessions/%61bc/messages", token=A["token"])
    assert resp.status_code == 200
    assert dash.routed == [("GET", "/api/sessions/abc/messages")]


# ---- cookie users unaffected ------------------------------------------------------------------


@pytest.mark.parametrize("target", ["/api/sessions", "/api/sessions/abc/messages", "/api/sessions/stats", "/"])
def test_cookie_users_fall_through_untouched(dash, target):
    resp, req = dash.request("GET", target, headers=[("Cookie", SESSION_COOKIE)])
    assert resp.status_code == 200
    assert dash.seam_calls == 1 and dash.provider.calls == 0
    assert not hasattr(req.state, "token_authenticated")


def test_no_credentials_at_all_is_the_gates_401(dash):
    resp, _ = dash.request("GET", "/api/sessions")
    assert resp.status_code == 401 and dash.seam_calls == 1 and dash.provider.calls == 0


@pytest.mark.parametrize("target", ["/api/sessions", "/api/sessions/abc/messages", "/api/sessions/stats"])
def test_an_owner_session_bearer_still_passes_through_the_seam(dash, target):
    # Hermes's native-app (desktop) session bearer: the archive provider does not vouch for it,
    # so the wrapper hands it to the seam and the gate, which serve it as before the plugin.
    resp, req = dash.request("GET", target, token=SESSION_BEARER)
    assert resp.status_code == 200 and dash.seam_calls == 1
    assert not hasattr(req.state, "token_authenticated")


# ---- refused everywhere else ------------------------------------------------------------------

OTHER_PATHS = [
    "/api/sessions/",
    "//api/sessions",
    "/api/sessions//messages",
    "/api/sessions/abc/messages/",
    "/api/sessions/abc//messages",
    "/api/sessions/abc/messages/around",
    "/api/sessions/abc/messages%2Faround",
    "/api/sessions/abc/messages%0A",
    "/api/sessions%0A",
    "/api/sessions%3Fx",
    "/api/sessions%3Fx/messages",
    "/api/sessions/abc%3F/messages",
    "/api/sessions/abc%23/messages",
    "/api/sessions/%2e%2e/messages",
    "/api/sessions/..%2Fstats/messages",
    "/api/sessions/abc/../stats",
    "/api/sessions/./messages",
    "/api/sessions/_abc/messages",
    "/api/sessions/" + "a" * 129 + "/messages",
    "/api/sessions/a%20b/messages",
    "/api/sessions/search",
    "/api/sessions/stats",
    "/api/sessions/empty/count",
    "/api/sessions/abc",
    "/api/sessions/abc/export",
    "/api/sessions/abc/timeline",
    "/api/sessions/abc/latest-descendant",
    "/API/SESSIONS",
    "/api/Sessions",
    "/api/cron/jobs",
    "/api/config",
    "/api/env",
    "/api/status",
    "/api/plugins/av-events/x",
    "/auth/logout",
    "/",
    "/sessions",
]


@pytest.mark.parametrize("target", OTHER_PATHS)
def test_the_token_is_refused_on_every_other_path(dash, target):
    resp, req = dash.request("GET", target, token=A["token"])
    assert resp.status_code == 401
    assert dash.provider.calls == 0 and dash.seam_calls == 1  # never decided by the wrapper
    assert not getattr(req.state, "token_authenticated", False)


@pytest.mark.parametrize("method", ["POST", "DELETE", "PATCH", "PUT", "HEAD", "OPTIONS", "get", "TRACE"])
@pytest.mark.parametrize("target", ["/api/sessions", "/api/sessions/abc/messages"])
def test_the_token_is_refused_for_every_other_method_on_the_allowed_paths(dash, method, target):
    resp, _ = dash.request(method, target, token=A["token"])
    assert resp.status_code == 401
    assert dash.provider.calls == 0 and dash.seam_calls == 1


def test_another_registered_token_route_never_accepts_the_token(dash):
    # Hermes's generic seam asks every token provider; ours declines outside the wrapper.
    resp, _ = dash.request("POST", Dashboard.DRAIN, token=A["token"])
    assert resp.status_code == 401 and dash.provider.calls == 1
    assert dash.archive.verify(dash.provider.archive_scope, A["token"]) is False  # outside the wrapper
    assert dash.archive.token_matches(A["token"]) is True


def test_a_token_in_the_query_string_is_not_a_bearer(dash):
    resp, _ = dash.request("GET", "/api/sessions?token=" + A["token"] + "&access_token=" + A["token"])
    assert resp.status_code == 401 and dash.provider.calls == 0


# ---- wrong tenant, rotation, unset ------------------------------------------------------------


def test_tenant_b_token_falls_through_and_ends_401_at_the_gate(dash):
    resp, req = dash.request("GET", "/api/sessions", token=B["token"])
    assert resp.status_code == 401 and resp.body["by"] == "gate"
    assert dash.seam_calls == 1 and dash.provider.calls == 1
    assert dash.routed == [] and not hasattr(req.state, "token_authenticated")


@pytest.mark.parametrize("bad", ["x", A["sha256"], A["token"].upper(), A["token"][:-1], A["token"] + "0", A["master"]])
def test_anything_but_the_exact_token_falls_through_to_the_gates_401(dash, bad):
    resp, _ = dash.request("GET", "/api/sessions", token=bad)
    assert resp.status_code == 401 and resp.body["by"] == "gate"
    assert dash.seam_calls == 1 and dash.routed == []


def test_a_rewritten_env_hash_takes_effect_on_the_next_request(dash, home, monkeypatch):
    assert dash.request("GET", "/api/sessions", token=A["token"])[0].status_code == 200
    # Hermes loaded the old line into the process environment at startup; the file still wins.
    monkeypatch.setenv("AV_ARCHIVE_READ_HASH", A["sha256"])
    write_env(home, "TENANT_ID=" + A["tenant_id"], "AV_ARCHIVE_READ_HASH=" + A_ROTATED["sha256"])
    assert dash.request("GET", "/api/sessions", token=A["token"])[0].status_code == 401
    assert dash.request("GET", "/api/sessions", token=A_ROTATED["token"])[0].status_code == 200


def test_a_removed_env_line_refuses_every_bearer_even_with_a_stale_process_env(dash, home, monkeypatch):
    monkeypatch.setenv("AV_ARCHIVE_READ_HASH", A["sha256"])
    write_env(home, "TENANT_ID=" + A["tenant_id"])
    for case in CASES:
        assert dash.request("GET", "/api/sessions", token=case["token"])[0].status_code == 401
    assert dash.routed == []


def test_hash_unset_everywhere_refuses_every_bearer(dash, home):
    (home / ".env").unlink()
    for target in ALLOWED:
        for token in [c["token"] for c in CASES] + ["", "anything"]:
            assert dash.request("GET", target, token=token)[0].status_code == 401
    assert dash.routed == []


def test_without_an_env_file_the_process_environment_answers(dash, home, monkeypatch):
    (home / ".env").unlink()
    monkeypatch.setenv("AV_ARCHIVE_READ_HASH", A["sha256"])
    assert dash.request("GET", "/api/sessions", token=A["token"])[0].status_code == 200


def test_an_unreadable_env_file_refuses(dash, home, monkeypatch):
    (home / ".env").unlink()
    (home / ".env").mkdir()  # exists, cannot be read as a file
    monkeypatch.setenv("AV_ARCHIVE_READ_HASH", A["sha256"])
    assert dash.request("GET", "/api/sessions", token=A["token"])[0].status_code == 401


@pytest.mark.parametrize(
    "line,usable",
    [
        # Only the exact line the control plane writes (F2); every other shape is not a hash line.
        ("AV_ARCHIVE_READ_HASH=" + A["sha256"], True),
        ("AV_ARCHIVE_READ_HASH='" + A["sha256"] + "'", False),
        ('AV_ARCHIVE_READ_HASH="' + A["sha256"] + '"', False),
        ("export AV_ARCHIVE_READ_HASH=" + A["sha256"], False),
        ("AV_ARCHIVE_READ_HASH = " + A["sha256"], False),
        ("AV_ARCHIVE_READ_HASH=" + A["sha256"] + " ", False),
        (" AV_ARCHIVE_READ_HASH=" + A["sha256"], False),
        ("\ufeffAV_ARCHIVE_READ_HASH=" + A["sha256"], False),
        ("AV_ARCHIVE_READ_HASH=" + A["sha256"] + "\x00", False),
        ("AV_ARCHIVE_READ_HASH: " + A["sha256"], False),
        ("AV_ARCHIVE_READ_HASH=" + A["sha256"].upper(), False),
        ("AV_ARCHIVE_READ_HASH=" + A["sha256"][:-1], False),
        ("AV_ARCHIVE_READ_HASH=" + A["sha256"] + "0", False),
        ("AV_ARCHIVE_READ_HASH=" + A["sha256"] + " # note", False),
        ("AV_ARCHIVE_READ_HASH='" + A["sha256"] + '"', False),
        ("AV_ARCHIVE_READ_HASH=", False),
        ("#AV_ARCHIVE_READ_HASH=" + A["sha256"], False),
        ("XAV_ARCHIVE_READ_HASH=" + A["sha256"], False),
        ("AV_ARCHIVE_READ_HASH_OLD=" + A["sha256"], False),
    ],
)
@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_env_line_shapes(dash, home, line, usable, newline):
    write_env(home, "TENANT_ID=" + A["tenant_id"], line, newline=newline)
    assert dash.archive.stored_hash() == (A["sha256"] if usable else "")
    assert dash.request("GET", "/api/sessions", token=A["token"])[0].status_code == (200 if usable else 401)


def test_the_last_exact_env_line_wins(dash, home):
    write_env(home, "AV_ARCHIVE_READ_HASH=" + A["sha256"], "AV_ARCHIVE_READ_HASH=" + A_ROTATED["sha256"])
    assert dash.request("GET", "/api/sessions", token=A["token"])[0].status_code == 401
    assert dash.request("GET", "/api/sessions", token=A_ROTATED["token"])[0].status_code == 200
    # A later line that is not exact is not a hash line, so it neither replaces nor clears.
    write_env(home, "AV_ARCHIVE_READ_HASH=" + A["sha256"], "AV_ARCHIVE_READ_HASH=", "export AV_ARCHIVE_READ_HASH=" + B["sha256"])
    assert dash.archive.stored_hash() == A["sha256"]


def test_a_lone_cr_is_not_a_line_end(archive, home):
    (home / ".env").write_bytes(b"X=1\rAV_ARCHIVE_READ_HASH=" + A["sha256"].encode() + b"\r")
    assert archive.stored_hash() == ""
    (home / ".env").write_bytes(b"\xff\xfe\nAV_ARCHIVE_READ_HASH=" + A["sha256"].encode() + b"\n")
    assert archive.stored_hash() == A["sha256"]  # undecodable neighbours do not matter


def test_the_process_environment_fallback_is_exact_too(archive, home, monkeypatch):
    (home / ".env").unlink()
    for value, expected in [(A["sha256"], A["sha256"]), (" " + A["sha256"], ""), (A["sha256"].upper(), ""), ("", "")]:
        monkeypatch.setenv("AV_ARCHIVE_READ_HASH", value)
        assert archive.stored_hash() == expected


def test_one_env_read_per_bearer_get_on_the_two_routes(dash, home, monkeypatch):
    reads = []
    real = dash.archive.stored_hash
    monkeypatch.setattr(dash.archive, "stored_hash", lambda: reads.append(1) or real())

    def reads_for(*args, **kwargs):
        reads.clear()
        dash.request(*args, **kwargs)
        return len(reads)

    assert reads_for("GET", "/api/sessions", token=A["token"]) == 1  # accepted
    assert reads_for("GET", "/api/sessions", token=B["token"]) == 1  # passed_not_archive
    assert reads_for("GET", "/api/sessions/stats", token=A["token"]) == 0
    assert reads_for("POST", "/api/sessions", token=A["token"]) == 0
    assert reads_for("GET", "/api/sessions", headers=[("Cookie", SESSION_COOKIE)]) == 0
    write_env(home, "TENANT_ID=x")
    assert reads_for("GET", "/api/sessions", token=A["token"]) == 1  # passed_hash_unset
    dash.provider = None
    assert reads_for("GET", "/api/sessions", token=A["token"]) == 0  # passed_no_provider


def test_two_copies_of_the_module_agree_through_the_provider_instance(archive, home, load_archive_copy):
    # Hermes can load the plugin a second time under another module name; the wrapper from one
    # copy and the provider from the other must still agree, because the scope is the instance's.
    other = load_archive_copy()
    for wrapper_mod, provider_mod in [(archive, other), (other, archive)]:
        d = Dashboard(wrapper_mod, FakeProvider(provider_mod))
        assert d.request("GET", "/api/sessions", token=A["token"])[0].status_code == 200
        assert d.request("GET", "/api/sessions", token=B["token"])[0].body["by"] == "gate"


# ---- provider absent or broken, install -------------------------------------------------------


def test_no_registered_provider_passes_a_valid_token_to_the_gates_401(dash):
    dash.provider = None
    resp, _ = dash.request("GET", "/api/sessions", token=A["token"])
    assert resp.status_code == 401 and resp.body["by"] == "gate" and dash.seam_calls == 1
    assert dash.routed == []
    assert dash.request("GET", "/api/sessions", token=SESSION_BEARER)[0].status_code == 200


def test_a_raising_provider_or_registry_falls_through_and_never_500s(archive, home):
    class Boom(FakeProvider):
        def verify_token(self, *, token):
            raise RuntimeError("provider bug")

    boom = Boom(archive)
    d = Dashboard(archive, boom)
    assert d.request("GET", "/api/sessions", token=A["token"])[0].body["by"] == "gate"
    assert d.request("GET", "/api/sessions", token=SESSION_BEARER)[0].status_code == 200
    d.wrapper = archive.make_route_wrapper(d.seam, lookup_provider=lambda: 1 / 0)
    assert d.request("GET", "/api/sessions", token=A["token"])[0].body["by"] == "gate"
    assert d.request("GET", "/api/sessions", token=SESSION_BEARER)[0].status_code == 200
    assert d.seam_calls == 4
    assert boom.archive_scope.get() is None  # the scope flag never leaks out of the wrapper


def test_install_keeps_exactly_one_layer(archive):
    async def seam(request, call_next):
        return await call_next(request)

    module = SimpleNamespace(token_auth_middleware=seam)
    kwargs = dict(lookup_provider=lambda: None)
    assert archive.install(module, **kwargs) is True
    first = module.token_auth_middleware
    assert first is not seam and first._edgecity_archive and first._edgecity_original is seam
    assert archive.install(module, **kwargs) is True
    assert module.token_auth_middleware._edgecity_original is seam  # replaced, not stacked
    assert archive.install(SimpleNamespace(), **kwargs) is False


def test_logs_carry_codes_and_counts_never_the_token_or_hash(dash, home, caplog):
    caplog.set_level(logging.DEBUG)
    dash.request("GET", "/api/sessions", token=A["token"])
    dash.request("GET", "/api/sessions", token=B["token"])
    dash.provider = None
    dash.request("GET", "/api/sessions", token=A["token"])
    (home / ".env").unlink()
    dash.provider = FakeProvider(dash.archive)
    dash.request("GET", "/api/sessions", token=A["token"])
    text = caplog.text
    for code in ("accepted", "passed_not_archive", "passed_no_provider", "passed_hash_unset"):
        assert "archive_read " + code in text
    for secret in (A["token"], A["sha256"], B["token"], B["sha256"], A["master"]):
        assert secret not in text
    levels = {r.getMessage().split(" (")[0].rsplit(" ", 1)[-1]: r.levelno for r in caplog.records
              if r.name == "dashboard-auth-edgecity.archive"}
    assert levels == {"accepted": logging.INFO, "passed_not_archive": logging.DEBUG,
                      "passed_no_provider": logging.DEBUG, "passed_hash_unset": logging.DEBUG}
    assert dash.archive.counts() == {"accepted": 1, "passed_not_archive": 1, "passed_no_provider": 1, "passed_hash_unset": 1}


# ---- against the real Hermes seam (skipped without hermes_cli) --------------------------------


class Ctx:
    """`PluginContext.register_dashboard_auth_provider` as v2026.9.24 behaves: the launch scope
    upserts into the global registry; any other profile scope is ignored without raising."""

    def __init__(self, accept=True):
        from hermes_cli.dashboard_auth.registry import register_global_provider

        self._register = register_global_provider
        self.accept = accept
        self.registered = []

    def register_dashboard_auth_provider(self, provider):
        if self.accept:
            self._register(provider)
            self.registered.append(provider.name)


@pytest.fixture
def hermes(load_plugin, home, monkeypatch):
    plugin = load_plugin()
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from hermes_cli.dashboard_auth import registry, token_auth

    monkeypatch.setenv("TENANT_ID", A["tenant_id"])
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(plugin, "_post_json", lambda *args: (200, {"ok": True}))
    monkeypatch.setattr(token_auth, "token_auth_middleware", token_auth.token_auth_middleware)
    registry.clear_providers()
    token_auth.clear_token_routes()
    ctx = Ctx()
    plugin.register(ctx)
    yield SimpleNamespace(plugin=plugin, ctx=ctx, registry=registry, token_auth=token_auth)
    registry.clear_providers()
    token_auth.clear_token_routes()


def hermes_app():
    """The dashboard's auth stack as web_server.py v2026.9.24 builds it: the cookie gate, then
    the outermost seam, which imports `token_auth_middleware` at call time."""
    from fastapi import FastAPI, Request

    app = FastAPI()
    app.state.auth_required = True

    @app.get("/api/sessions")
    def sessions():
        return {"sessions": []}

    @app.get("/api/sessions/stats")
    def stats():
        return {"total": 0}

    @app.get("/api/sessions/{session_id}/messages")
    def messages(session_id: str):
        return {"session_id": session_id, "messages": []}

    @app.post("/api/sessions/{session_id}/messages")
    def post_messages(session_id: str):
        return {"posted": session_id}

    @app.post("/api/gateway/drain")
    def drain():
        return {"ok": True}

    @app.middleware("http")
    async def _dashboard_auth_gate(request: Request, call_next):
        from hermes_cli.dashboard_auth.middleware import gated_auth_middleware

        return await gated_auth_middleware(request, call_next)

    @app.middleware("http")
    async def _token_auth_seam(request: Request, call_next):
        from hermes_cli.dashboard_auth.token_auth import token_auth_middleware

        return await token_auth_middleware(request, call_next)

    return app


def test_hermes_register_adds_a_token_only_provider_never_offered_at_login(hermes):
    from hermes_cli.dashboard_auth import list_session_providers, list_token_providers

    assert hermes.ctx.registered == ["edgecity", "edgecity-archive"]
    assert [p.name for p in list_session_providers()] == ["edgecity"]
    assert [p.name for p in list_token_providers()] == ["edgecity-archive"]
    archive_provider = hermes.registry.get_provider("edgecity-archive")
    assert archive_provider.supports_session is False and archive_provider.supports_password is False
    assert archive_provider.verify_session(access_token=A["token"]) is None
    assert archive_provider.verify_token(token=A["token"]) is None  # outside the wrapper
    assert hermes.registry.get_provider("edgecity").verify_session(access_token=A["token"]) is None
    assert hermes.token_auth.token_auth_middleware._edgecity_archive is True


def test_hermes_register_twice_keeps_one_wrapper(hermes):
    seam = hermes.token_auth.token_auth_middleware._edgecity_original
    hermes.plugin.register(Ctx())
    assert hermes.token_auth.token_auth_middleware._edgecity_original is seam


def test_hermes_end_to_end_through_the_real_seam_and_gate(hermes):
    from starlette.testclient import TestClient

    client = TestClient(hermes_app())
    bearer = {"Authorization": "Bearer " + A["token"]}
    assert client.get("/api/sessions?limit=100", headers=bearer).status_code == 200
    assert client.get("/api/sessions/20260924_101500_ab12cd/messages", headers=bearer).json()["session_id"] == "20260924_101500_ab12cd"
    assert client.get("/api/sessions/stats", headers=bearer).status_code == 401
    assert client.post("/api/sessions/abc/messages", headers=bearer).status_code == 401
    # Tenant B's token is not ours: it falls through to Hermes's gate, whose session providers
    # do not know it either, and ends in the gate's own 401.
    refused = client.get("/api/sessions", headers={"Authorization": "Bearer " + B["token"]})
    assert refused.status_code == 401 and refused.json()["reason"] == "invalid_or_expired_session"

    # Another token route registered with Hermes's seam (the drain plugin does this) asks every
    # token provider; ours declines there.
    hermes.token_auth.register_token_route("/api/gateway/drain")
    assert client.post("/api/gateway/drain", headers=bearer).status_code == 401

    # A browser's cookie session still reads the Sessions page.
    owner = hermes.registry.get_provider("edgecity")._mint("owner-id", "owner@example.org", "owner")
    client.cookies.set("hermes_session_at", owner.access_token)
    assert client.get("/api/sessions").status_code == 200
    assert client.get("/api/sessions/stats").status_code == 200


def test_hermes_owner_session_bearer_still_reads_the_two_routes(hermes):
    from starlette.testclient import TestClient

    client = TestClient(hermes_app())
    owner = hermes.registry.get_provider("edgecity")._mint("owner-id", "owner@example.org", "owner")
    session_bearer = {"Authorization": "Bearer " + owner.access_token}
    assert client.get("/api/sessions", headers=session_bearer).status_code == 200
    assert client.get("/api/sessions/abc/messages", headers=session_bearer).status_code == 200
    assert client.get("/api/sessions/stats", headers=session_bearer).status_code == 200


def test_hermes_unregistered_provider_passes_a_valid_token_to_the_gates_401(hermes):
    from starlette.testclient import TestClient

    archive_provider = hermes.registry.get_provider("edgecity-archive")
    hermes.registry.unregister_global_provider("edgecity-archive", archive_provider)
    client = TestClient(hermes_app())
    refused = client.get("/api/sessions", headers={"Authorization": "Bearer " + A["token"]})
    assert refused.status_code == 401 and refused.json()["reason"] == "invalid_or_expired_session"


def test_hermes_second_load_under_another_module_name_keeps_the_token_working(hermes, load_plugin):
    from starlette.testclient import TestClient

    client = TestClient(hermes_app())
    bearer = {"Authorization": "Bearer " + A["token"]}
    first_wrapper = hermes.token_auth.token_auth_middleware
    assert client.get("/api/sessions", headers=bearer).status_code == 200

    # A non-launch profile scope: Hermes loads the plugin again under another module name and
    # ignores its registrations. The launch scope's provider and wrapper stay, and still agree.
    profile_copy = load_plugin()
    profile_copy.register(Ctx(accept=False))
    assert hermes.token_auth.token_auth_middleware is first_wrapper
    assert client.get("/api/sessions", headers=bearer).status_code == 200
    assert client.get("/api/sessions/abc/messages", headers=bearer).status_code == 200

    # A forced re-discovery in the launch scope: the new copy's provider and wrapper replace both.
    rediscovered = load_plugin()
    rediscovered.register(Ctx())
    assert hermes.token_auth.token_auth_middleware is not first_wrapper
    assert hermes.token_auth.token_auth_middleware._edgecity_original is first_wrapper._edgecity_original
    assert client.get("/api/sessions", headers=bearer).status_code == 200
    assert client.get("/api/sessions/stats", headers=bearer).status_code == 401
