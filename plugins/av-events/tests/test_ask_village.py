"""ASK-VILLAGE (D): the `ask_village` tool (`_ask_village.py`), dark behind `AV_ASK_VILLAGE`.

The control plane's `POST /tenants/:id/village/ask` (release's cp half) is
faked: most tests swap the module's `_OPENER` for `FakeCP`; a few drive a real
loopback `http.server` through the real `_core.NO_REDIRECT_OPENER`. The request
shape and answer mapping are pinned by `tests/vectors/ask-village-contract.json`.
"""

from __future__ import annotations

import io
import json
import logging
import sys
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

REPO = Path(__file__).resolve().parents[3]
VECTOR = json.loads((REPO / "tests" / "vectors" / "ask-village-contract.json").read_text(encoding="utf-8"))

TENANT = "aa9a5de3-0000-4000-8000-000000000001"
KEY = "edgeos-attendee-key-for-ask-village-tests-0123"
CP = "https://control-plane-production-606c.up.railway.app"
SESSION = "sess-ask"
QUESTION = "What has Asha been saying in the group about the Friday dinner?"
ANSWER = VECTOR["answers"][0]["body"]
ARGS = {"question": QUESTION}
SESSION_ENV = ("HERMES_SESSION_CHAT_TYPE", "HERMES_CRON_SESSION", "HERMES_PLATFORM", "HERMES_SESSION_PLATFORM",
               "HERMES_SESSION_SOURCE", "HERMES_SESSION_ID", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
               "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy")


class Response:
    def __init__(self, status: int, body: bytes, headers: Optional[dict] = None, fail_read: bool = False) -> None:
        self.status = status
        self.headers = dict(headers or {})
        self._body = io.BytesIO(body)
        self._fail_read = fail_read

    def read(self, n: int = -1) -> bytes:
        if self._fail_read:
            raise ConnectionResetError("cut")
        return self._body.read(n)

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _Headers(dict):
    def get(self, name, default=None):  # noqa: ANN001
        for key, value in self.items():
            if key.lower() == name.lower():
                return value
        return default


def reply(status: int, body: Any = None, headers: Optional[dict] = None) -> Any:
    raw = body if isinstance(body, bytes) else json.dumps(body if body is not None else {}).encode()
    if 200 <= status < 300:
        return Response(status, raw, headers)
    return urllib.error.HTTPError(CP, status, "x", _Headers(headers or {}), io.BytesIO(raw))


class FakeCP:
    def __init__(self) -> None:
        self.script: list = []
        self.requests: list[dict] = []
        self.gate: Optional[threading.Event] = None
        self._lock = threading.Lock()

    def open(self, request, timeout=None):  # noqa: ANN001
        with self._lock:
            self.requests.append({
                "url": request.full_url,
                "method": request.get_method(),
                "headers": {k.lower(): v for k, v in request.header_items()},
                "raw": request.data,
                "body": json.loads(request.data.decode("utf-8")),
                "timeout": timeout,
            })
            item = self.script.pop(0) if self.script else reply(200, ANSWER)
        if self.gate is not None:
            self.gate.wait(5)
        if isinstance(item, BaseException):
            raise item
        return item


class ToolFireCtx:
    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.tools: dict[str, dict] = {}

    def register_hook(self, hook_name, callback):  # noqa: ANN001
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                      is_async=False, description="", emoji="", override=False):  # noqa: ANN001
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "description": description}
        return object()

    def fire(self, hook_name: str, **kwargs: Any) -> None:
        for callback in self.hooks.get(hook_name, []):
            callback(**kwargs)


@pytest.fixture()
def av_mod(plugin, av, monkeypatch):
    module = sys.modules[f"{av.MODULE_NAME}._ask_village"]
    monkeypatch.setattr(module, "_sleep", lambda _s: None)
    for name in SESSION_ENV:
        monkeypatch.delenv(name, raising=False)
    return module


@pytest.fixture()
def cp(av_mod, monkeypatch):
    fake = FakeCP()
    monkeypatch.setattr(av_mod, "_OPENER", fake)
    return fake


@pytest.fixture()
def on(monkeypatch, home):
    monkeypatch.setenv("AV_ASK_VILLAGE", "1")
    monkeypatch.setenv("CONTROL_PLANE_URL", CP)
    monkeypatch.setenv("EDGEOS_API_KEY", KEY)
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")


@pytest.fixture()
def tctx(plugin, av_mod, cp, on):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    return ctx


def call(ctx: ToolFireCtx, args: Any, *, session: str = SESSION) -> dict:
    result = ctx.tools["ask_village"]["handler"](args, task_id="task-1", session_id=session)
    assert isinstance(result, str)
    return json.loads(result)


# ---- Switch and registration -------------------------------------------------


def test_switch_unset_registers_nothing(plugin, av_mod, cp, home, caplog):
    ctx = ToolFireCtx()
    with caplog.at_level(logging.DEBUG, logger="av-events"):
        plugin.register(ctx)
    assert "ask_village" not in ctx.tools and "pray" not in ctx.tools
    assert [r.getMessage() for r in caplog.records if "ask_village" in r.getMessage()] == [
        "av-events: ask_village skipped=switch_off"]
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)


@pytest.mark.parametrize("value", ["0", "false", "off", "", "maybe"])
def test_only_a_truthy_switch_registers(plugin, av_mod, cp, home, monkeypatch, value):
    monkeypatch.setenv("AV_ASK_VILLAGE", value)
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert "ask_village" not in ctx.tools


@pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
def test_switch_on_registers_the_tool_alone(plugin, av_mod, cp, home, monkeypatch, caplog, value):
    monkeypatch.setenv("AV_ASK_VILLAGE", value)
    ctx = ToolFireCtx()
    with caplog.at_level(logging.INFO, logger="av-events"):
        plugin.register(ctx)
    tool = ctx.tools["ask_village"]
    assert tool["toolset"] == "av-events" and tool["schema"] is av_mod.TOOL_SCHEMA
    assert tool["description"] == av_mod.TOOL_DESCRIPTION
    assert "pray" not in ctx.tools
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)
    ri = sys.modules[f"{plugin.__name__}._record_intention"]
    for name in ("on_session_start", "pre_api_request", "subagent_start"):
        assert ri.LINEAGE_HOOKS[name] in ctx.hooks[name]
    assert "av-events: ask_village registered" in caplog.text


def test_switch_read_from_the_dotenv(plugin, av_mod, cp, home):
    (home / ".env").write_text("AV_ASK_VILLAGE=1\n", encoding="utf-8")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert "ask_village" in ctx.tools


def test_switch_turned_off_after_registration(tctx, cp, monkeypatch):
    monkeypatch.setenv("AV_ASK_VILLAGE", "0")
    assert call(tctx, ARGS)["error"] == "disabled"
    assert cp.requests == []


def test_both_tools_on_together(plugin, av_mod, cp, on, monkeypatch):
    monkeypatch.setenv("AV_PRAY", "1")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert {"ask_village", "pray"} <= set(ctx.tools)
    assert call(ctx, ARGS)["answer"] == ANSWER["answer"]


def test_a_refused_registration_keeps_the_hooks(plugin, av_mod, cp, on, caplog):
    class Refusing(ToolFireCtx):
        def register_tool(self, name, *args, **kwargs):  # noqa: ANN001
            if name == "ask_village":
                raise PermissionError("no")
            return super().register_tool(name, *args, **kwargs)

    ctx = Refusing()
    plugin.register(ctx)
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES) and "ask_village" not in ctx.tools
    assert "av-events: ask_village register_failed=PermissionError" in caplog.text


def test_manifest_lists_the_tool_and_the_switch(av):
    import yaml  # noqa: PLC0415

    manifest = yaml.safe_load((av.PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    assert "ask_village" in manifest["provides_tools"]
    assert {"AV_ASK_VILLAGE", "CONTROL_PLANE_URL", "EDGEOS_API_KEY"} <= set(manifest["optional_env"])


def test_schema(av_mod):
    params = av_mod.TOOL_SCHEMA["parameters"]
    assert params["required"] == ["question"] and params["additionalProperties"] is False
    assert set(params["properties"]) == {"question", "window"}  # no person-id field
    assert params["properties"]["question"]["maxLength"] == 500
    assert params["properties"]["window"]["enum"] == ["24h", "7d", "all"]
    assert "named person" in av_mod.TOOL_DESCRIPTION and "private chats" in av_mod.TOOL_DESCRIPTION
    json.dumps(av_mod.TOOL_SCHEMA)


# ---- The contract vector ------------------------------------------------------


@pytest.mark.parametrize("case", VECTOR["sent"], ids=lambda c: str(c["args"].get("window")) + ":" + str(len(c["args"]["question"])))
def test_vector_sent(tctx, cp, case):
    out = call(tctx, case["args"])
    assert out == ANSWER
    (req,) = cp.requests
    assert req["method"] == "POST"
    assert req["url"] == CP + VECTOR["request"]["path"].format(tenant_id=TENANT)
    assert req["body"] == case["body"]
    assert req["raw"] == json.dumps(case["body"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert len(req["raw"]) <= VECTOR["request"]["max_body_bytes"]


def test_vector_headers_and_deadline(tctx, av_mod, cp):
    call(tctx, ARGS)
    headers = cp.requests[0]["headers"]
    assert headers["authorization"] == f"Bearer {KEY}"
    assert headers["content-type"] == "application/json" and headers["accept"] == "application/json"
    assert headers["x-av-session-kind"] == "dm"
    assert av_mod.DEADLINE_S == VECTOR["request"]["deadline_s"] and 60 < av_mod.DEADLINE_S <= 70
    assert 60 < cp.requests[0]["timeout"] < av_mod.DEADLINE_S
    assert sorted(av_mod.CP_HOSTS) == VECTOR["request"]["cp_hosts"]


@pytest.mark.parametrize("code,args", [(code, a) for code, cases in VECTOR["refused"].items() for a in cases],
                         ids=lambda v: v if isinstance(v, str) else None)
def test_vector_refused_before_sending(tctx, cp, code, args):
    out = call(tctx, args)
    assert out["error"] == code and out["message"]
    assert cp.requests == []


@pytest.mark.parametrize("case", VECTOR["answers"], ids=lambda c: f"{c['status']}-{c['body'].get('error', 'ok')}")
def test_vector_answers(tctx, cp, case):
    cp.script = [reply(case["status"], case["body"])]
    out = call(tctx, ARGS)
    if "error" in case["tool"]:
        assert out.pop("message")
    assert out == case["tool"]
    assert len(cp.requests) == 1


def test_the_credential_is_directory_ts_key(av_mod):
    directory = (REPO / "skills" / "edgeos" / "scripts" / "directory.ts").read_text(encoding="utf-8")
    assert "Authorization: Bearer $EDGEOS_API_KEY" in directory and av_mod.CREDENTIAL_ENV == "EDGEOS_API_KEY"
    for host in av_mod.CP_HOSTS:
        assert f'"{host}"' in directory


# ---- Who may ask ----------------------------------------------------------------


@pytest.mark.parametrize("chat_type", ["group", "supergroup", "channel", "thread"])
def test_group_sessions_are_refused(tctx, cp, monkeypatch, chat_type):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    assert call(tctx, ARGS)["error"] == "group_session"
    assert cp.requests == []


def test_cron_runs_may_ask(tctx, cp, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    assert call(tctx, ARGS, session="cron_daily_1")["answer"]
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "cron"


def test_cron_by_platform_lineage(tctx, cp, monkeypatch):
    tctx.fire("on_session_start", session_id="s-c", model="m", platform="cron")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    assert call(tctx, ARGS, session="s-c")["answer"]
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "cron"


# ---- The wire -------------------------------------------------------------------


@pytest.mark.parametrize("url", [
    "https://cp.example.test",                                        # https, but not a CP_HOSTS host
    "http://control-plane-production-606c.up.railway.app",            # plain http to the real host
    "https://control-plane-production-606c.up.railway.app:8443",      # another port
    "https://u:p@control-plane-production-606c.up.railway.app",
    "https://control-plane-production-606c.up.railway.app/api",
    "https://control-plane-production-606c.up.railway.app/?x=1",
    "https://control-plane-production-606c.up.railway.app.evil.test",
    "",
])
def test_the_key_goes_only_to_a_cp_host_over_https(tctx, cp, monkeypatch, url):
    monkeypatch.setenv("CONTROL_PLANE_URL", url)
    assert call(tctx, ARGS)["error"] == "not_configured"
    assert cp.requests == []


@pytest.mark.parametrize("url,base", [
    ("https://control-plane-production-606c.up.railway.app/", CP),
    ("https://Control-Plane-Production-606c.up.railway.app:443", CP),
    ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
])
def test_allowed_origins(tctx, cp, monkeypatch, url, base):
    monkeypatch.setenv("CONTROL_PLANE_URL", url)
    assert call(tctx, ARGS)["answer"]
    assert cp.requests[0]["url"] == f"{base}/tenants/{TENANT}/village/ask"


def test_key_and_tenant_are_required(tctx, cp, monkeypatch):
    monkeypatch.setenv("EDGEOS_API_KEY", "")
    assert call(tctx, ARGS)["error"] == "not_configured"
    monkeypatch.setenv("EDGEOS_API_KEY", KEY)
    monkeypatch.setenv("TENANT_ID", "nope")
    assert call(tctx, ARGS)["error"] == "not_configured"
    assert cp.requests == []


def test_a_connect_failure_is_retried_once(tctx, cp):
    cp.script = [urllib.error.URLError(ConnectionRefusedError("x"))]
    assert call(tctx, ARGS)["answer"]
    assert len(cp.requests) == 2 and cp.requests[0]["raw"] == cp.requests[1]["raw"]


def test_two_connect_failures_answer_unreachable(tctx, cp):
    cp.script = [urllib.error.URLError("x"), urllib.error.URLError("x")]
    assert call(tctx, ARGS)["error"] == "unreachable"
    assert len(cp.requests) == 2


@pytest.mark.parametrize("item", [
    lambda: ConnectionResetError("after send"),
    lambda: Response(200, b"{}", fail_read=True),
    lambda: reply(503, {"error": "unavailable"}),
    lambda: reply(504, b""),
])
def test_nothing_sent_twice_after_the_question_left(tctx, cp, item):
    cp.script = [item()]
    out = call(tctx, ARGS)
    assert "error" in out
    assert len(cp.requests) == 1


def test_the_deadline_is_65_seconds_and_not_retried(tctx, av_mod, cp, monkeypatch, caplog):
    waits: list[float] = []
    monkeypatch.setattr(av_mod, "_join", lambda worker, deadline: waits.append(deadline))
    cp.gate = threading.Event()
    try:
        with caplog.at_level(logging.INFO, logger="av-events"):
            out = call(tctx, ARGS)
    finally:
        cp.gate.set()
    assert out["error"] == "unreachable" and waits == [65.0]
    assert len(cp.requests) == 1
    assert "http=deadline attempts=1" in caplog.text


def test_odd_answers(tctx, cp):
    cp.script = [reply(200, b"not json")]
    assert call(tctx, ARGS)["error"] == "bad_answer"
    cp.script = [reply(200, [1, 2])]
    assert call(tctx, ARGS)["error"] == "bad_answer"
    cp.script = [reply(200, {"answer": 5})]
    assert call(tctx, ARGS)["error"] == "bad_answer"
    cp.script = [reply(200, {"answer": "x" * 70000})]
    assert call(tctx, ARGS)["error"] == "bad_answer"
    cp.script = [reply(302, b"", {"Location": "https://evil.example/"})]
    assert call(tctx, ARGS)["error"] == "redirect_refused"
    cp.script = [reply(418, {"error": "teapot"})]
    assert call(tctx, ARGS)["error"] == "http_418"
    cp.script = [reply(429, {"error": "rate_limited"}, {"Retry-After": "30"})]
    assert call(tctx, ARGS)["retry_after_s"] == 30


# ---- Real HTTP on loopback ---------------------------------------------------------


class Server:
    def __init__(self, answer: Callable[[str], tuple[int, dict, bytes]]) -> None:
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                outer.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                                       "raw": raw})
                status, headers, body = answer(self.path)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_POST = do_GET = _handle  # noqa: N815

            def log_message(self, *args):  # noqa: A003
                return

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "Server":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._server.shutdown()
        self._server.server_close()

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"


@pytest.fixture()
def live(plugin, av_mod, on):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    return ctx


def test_end_to_end_on_loopback(live, monkeypatch):
    with Server(lambda _p: (200, {"Content-Type": "application/json"}, json.dumps(ANSWER).encode())) as server:
        monkeypatch.setenv("CONTROL_PLANE_URL", server.url)
        out = call(live, {"question": QUESTION, "window": "7d"})
    assert out == ANSWER
    (req,) = server.requests
    assert req["path"] == f"/tenants/{TENANT}/village/ask"
    assert req["headers"]["authorization"] == f"Bearer {KEY}"
    assert json.loads(req["raw"]) == {"question": QUESTION, "window": "7d"}


def test_a_real_404_says_not_available_yet(live, monkeypatch):
    with Server(lambda _p: (404, {"Content-Type": "application/json"}, b'{"error":"not_found"}')) as server:
        monkeypatch.setenv("CONTROL_PLANE_URL", server.url)
        out = call(live, ARGS)
    assert out["error"] == "not_available" and "not available yet" in out["message"]


def test_a_real_redirect_is_refused(live, monkeypatch):
    with Server(lambda _p: (200, {}, b"{}")) as elsewhere:
        with Server(lambda _p: (307, {"Location": elsewhere.url + "/x"}, b"")) as server:
            monkeypatch.setenv("CONTROL_PLANE_URL", server.url)
            assert call(live, ARGS)["error"] == "redirect_refused"
    assert len(server.requests) == 1 and elsewhere.requests == []


def test_proxy_variables_are_ignored(live, monkeypatch):
    with Server(lambda _p: (502, {}, b"")) as proxy, \
            Server(lambda _p: (200, {"Content-Type": "application/json"}, json.dumps(ANSWER).encode())) as server:
        for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "ALL_PROXY"):
            monkeypatch.setenv(name, proxy.url)
        monkeypatch.setenv("CONTROL_PLANE_URL", server.url)
        assert call(live, ARGS)["answer"]
    assert proxy.requests == [] and len(server.requests) == 1


# ---- Nothing private logged ------------------------------------------------------------


def test_logs_never_carry_the_question_the_answer_or_the_key(tctx, cp, caplog):
    with caplog.at_level(logging.DEBUG):
        call(tctx, {"question": QUESTION, "window": "7d"})
        cp.script = [reply(429, {"error": "rate_limited", "echo": QUESTION})]
        call(tctx, ARGS)
    text = caplog.text
    for secret in (QUESTION, "Asha", ANSWER["answer"], KEY, TENANT, TENANT[:8]):
        assert secret not in text
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("av-events: ask_village result=")]
    assert lines == [
        "av-events: ask_village result=answered window=7d session=dm http=200 attempts=1",
        "av-events: ask_village result=rate_limited window=default session=dm http=429 attempts=1",
    ]


def test_tool_call_telemetry_keeps_no_question_or_answer(tctx, cp, plugin, av, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    tctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    result = tctx.tools["ask_village"]["handler"](ARGS, task_id="t", session_id=SESSION)
    tctx.fire("post_tool_call", tool_name="ask_village", args=ARGS, result=result, session_id=SESSION, task_id="t",
              turn_id="turn-1", tool_call_id="call-1", api_request_id="req-1", duration_ms=12, status="ok",
              error_type=None, error_message=None)
    events = av.read_buffer(plugin._COLLECTOR)
    calls = [e for e in events if e["event_type"] == "tool.call"]
    assert len(calls) == 1 and calls[0]["payload"]["tool_name"] is None
    blob = json.dumps(events, ensure_ascii=False)
    assert QUESTION not in blob and ANSWER["answer"] not in blob and KEY not in blob


def test_a_failure_inside_the_tool_answers_internal(tctx, av_mod, cp, monkeypatch, caplog):
    def boom(_args):  # noqa: ANN001
        raise RuntimeError(QUESTION)

    monkeypatch.setattr(av_mod, "validate", boom)
    assert call(tctx, ARGS)["error"] == "internal"
    assert "av-events: ask_village failed=RuntimeError" in caplog.text and QUESTION not in caplog.text
