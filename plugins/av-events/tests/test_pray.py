"""PRAYER P3: the `pray` tool (`_pray.py`), dark behind `AV_PRAY`.

The control plane's `POST /tenants/:id/prayers` (P2) is faked. Most tests swap
the module's `_OPENER` for `FakeCP`, which records every request and answers
from a script, so no wall clock and no network. A few drive a real loopback
`http.server` through the real `_core.NO_REDIRECT_OPENER` (headers on the
wire, a real redirect refused, proxy variables ignored). The request shape and
the answer mapping are pinned by the shared contract vector
`tests/vectors/prayer-contract.json`, which P2 copies.
"""

from __future__ import annotations

import io
import json
import logging
import sys
import threading
import types
import urllib.error
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

REPO = Path(__file__).resolve().parents[3]
VECTOR = json.loads((REPO / "tests" / "vectors" / "prayer-contract.json").read_text(encoding="utf-8"))

TENANT = "aa9a5de3-0000-4000-8000-000000000001"
TOKEN = "events-token-for-pray-tests-0123456789"
CP = "https://cp.example.test"
SESSION = "sess-pray"
REASON = "My resident writes long research briefs and the current model runs out of context."
PRAYER_ID = VECTOR["ids"]["cases"][0]["prayer_id"]
ARGS = {"ask": {"kind": "model_tier", "tier": "pro"}, "reason": REASON}
SESSION_ENV = ("HERMES_SESSION_CHAT_TYPE", "HERMES_CRON_SESSION", "HERMES_PLATFORM", "HERMES_SESSION_PLATFORM",
               "HERMES_SESSION_SOURCE", "HERMES_SESSION_ID", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
               "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy")


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------


class Response:
    def __init__(self, status: int, body: bytes, headers: Optional[dict] = None, fail_read: bool = False) -> None:
        self.status = status
        self.headers = {k: v for k, v in (headers or {}).items()}
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


def http_error(status: int, body: Any = None, headers: Optional[dict] = None) -> urllib.error.HTTPError:
    raw = body if isinstance(body, bytes) else json.dumps(body if body is not None else {}).encode()
    return urllib.error.HTTPError(CP, status, "x", _Headers(headers or {}), io.BytesIO(raw))


def reply(status: int, body: Any = None, headers: Optional[dict] = None) -> Any:
    """What the fake answers: a 2xx `Response`, else the `HTTPError` urllib raises (3xx too: NoRedirect)."""
    if 200 <= status < 300:
        raw = body if isinstance(body, bytes) else json.dumps(body if body is not None else {}).encode()
        return Response(status, raw, headers)
    return http_error(status, body, headers)


class FakeCP:
    """The control plane's prayers route, in-process. `script` is consumed one item per request:
    a `Response`, an exception to raise, or a callable returning either. Empty: a 201."""

    def __init__(self, *script: Any) -> None:
        self.script = list(script)
        self.requests: list[dict] = []
        self.gate: Optional[threading.Event] = None
        self._lock = threading.Lock()

    def open(self, request, timeout=None):  # noqa: ANN001 - urllib's opener API
        with self._lock:
            self.requests.append({
                "url": request.full_url,
                "method": request.get_method(),
                "headers": {k.lower(): v for k, v in request.header_items()},
                "raw": request.data,
                "body": json.loads(request.data.decode("utf-8")),
                "timeout": timeout,
            })
            item = self.script.pop(0) if self.script else reply(201, {"prayer_id": PRAYER_ID, "status": "received"})
        if self.gate is not None:
            self.gate.wait(5)
        if callable(item) and not isinstance(item, BaseException):
            item = item()
        if isinstance(item, BaseException):
            raise item
        return item


class ToolFireCtx:
    """A `PluginContext` that takes hooks and tools, and fires hooks like Hermes."""

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


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture()
def pr(plugin, av, monkeypatch):
    module = sys.modules[f"{av.MODULE_NAME}._pray"]
    monkeypatch.setattr(module, "_sleep", lambda _s: None)
    for name in SESSION_ENV:
        monkeypatch.delenv(name, raising=False)
    return module


@pytest.fixture()
def cp(pr, monkeypatch):
    fake = FakeCP()
    monkeypatch.setattr(pr, "_OPENER", fake)
    return fake


@pytest.fixture()
def on(monkeypatch, home):
    monkeypatch.setenv("AV_PRAY", "1")
    monkeypatch.setenv("CONTROL_PLANE_URL", CP)
    monkeypatch.setenv("AV_EVENTS_TOKEN", TOKEN)
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")


@pytest.fixture()
def tctx(plugin, pr, cp, on):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return ctx


def call(ctx: ToolFireCtx, args: Any, *, session: str = SESSION) -> dict:
    result = ctx.tools["pray"]["handler"](args, task_id="task-1", session_id=session)
    assert isinstance(result, str)
    return json.loads(result)


# --------------------------------------------------------------------------
# Switch and registration
# --------------------------------------------------------------------------


def test_switch_unset_registers_nothing(plugin, pr, cp, home, caplog):
    ctx = ToolFireCtx()
    with caplog.at_level(logging.DEBUG, logger="av-events"):
        plugin.register(ctx)
    assert "pray" not in ctx.tools
    assert "consent_status" in ctx.tools
    assert [r.getMessage() for r in caplog.records if "pray" in r.getMessage()] == ["av-events: pray skipped=switch_off"]
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)


@pytest.mark.parametrize("value", ["0", "false", "off", "", "maybe", "no"])
def test_only_a_truthy_switch_registers(plugin, pr, cp, home, monkeypatch, value):
    monkeypatch.setenv("AV_PRAY", value)
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert "pray" not in ctx.tools


@pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
def test_switch_on_registers_the_tool_and_its_lineage_listeners(plugin, pr, cp, home, monkeypatch, caplog, value):
    monkeypatch.setenv("AV_PRAY", value)
    ctx = ToolFireCtx()
    with caplog.at_level(logging.INFO, logger="av-events"):
        plugin.register(ctx)
    tool = ctx.tools["pray"]
    assert tool["toolset"] == "av-events"
    assert tool["schema"] is pr.TOOL_SCHEMA and tool["description"] == pr.TOOL_DESCRIPTION
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)
    ri = sys.modules[f"{plugin.__name__}._record_intention"]
    for name in pr.LINEAGE_HOOK_NAMES:
        assert ri.LINEAGE_HOOKS[name] in ctx.hooks[name]
    assert ri.LINEAGE_HOOKS["post_tool_call"] not in ctx.hooks.get("post_tool_call", [])
    assert "av-events: pray registered" in caplog.text
    assert "record_intention" not in ctx.tools  # its own switch is off


def test_switch_read_from_the_dotenv(plugin, pr, cp, home):
    (home / ".env").write_text("AV_PRAY=1\n", encoding="utf-8")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert "pray" in ctx.tools


def test_switch_turned_off_after_registration_refuses_without_sending(tctx, cp, monkeypatch):
    monkeypatch.setenv("AV_PRAY", "0")
    out = call(tctx, ARGS)
    assert out["error"] == "disabled"
    assert cp.requests == []


def test_older_register_tool_without_description(plugin, pr, cp, on):
    class Older(ToolFireCtx):
        def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False):  # noqa: ANN001
            self.tools[name] = {"schema": schema, "handler": handler}

    ctx = Older()
    plugin.register(ctx)
    assert "pray" in ctx.tools


def test_a_refused_registration_keeps_the_hooks_and_the_other_tools(plugin, pr, cp, on, caplog):
    class Refusing(ToolFireCtx):
        def register_tool(self, name, *args, **kwargs):  # noqa: ANN001
            if name == "pray":
                raise PermissionError("no")
            return super().register_tool(name, *args, **kwargs)

    ctx = Refusing()
    plugin.register(ctx)
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)
    assert "consent_status" in ctx.tools and "pray" not in ctx.tools
    assert "av-events: pray register_failed=PermissionError" in caplog.text


def test_both_tools_on_share_the_lineage(plugin, pr, cp, on, monkeypatch):
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert {"pray", "record_intention"} <= set(ctx.tools)
    ctx.fire("on_session_start", session_id="s-cron", model="m", platform="cron")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    assert call(ctx, ARGS, session="s-cron")["status"] == "received"
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "cron"


def test_manifest_lists_the_tool_and_the_switch(av):
    import yaml  # noqa: PLC0415

    manifest = yaml.safe_load((av.PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    assert "pray" in manifest["provides_tools"]
    assert {"AV_PRAY", "CONTROL_PLANE_URL", "AV_EVENTS_TOKEN", "TENANT_ID", "AV_TENANT_ID"} <= set(manifest["optional_env"])


def test_pray_stays_out_of_the_tool_category_seed(plugin):
    """§2: tool_categories.json (frozen v3) is unchanged; `pray` leaves as `other` with a null name."""
    tools = sys.modules[f"{plugin.__name__}._tools"]
    assert "pray" not in tools.TOOL_CATEGORIES
    assert tools.tool_category("pray") == "other" and tools.listed_tool_name("pray") is None


# --------------------------------------------------------------------------
# Schema (§2)
# --------------------------------------------------------------------------


def test_schema_and_description_follow_the_note(pr):
    assert pr.TOOL_DESCRIPTION == (
        "Ask the village's god agents (Odin) for something your agent needs: today, a different model plan. "
        "A human admin reviews every request. Write the reason as a short summary of your resident's need, "
        "in your own words. Never include other people. Tell your resident you asked."
    )
    schema = pr.TOOL_SCHEMA
    assert schema["name"] == "pray" and schema["description"] == pr.TOOL_DESCRIPTION
    params = schema["parameters"]
    assert params["required"] == ["ask", "reason"] and params["additionalProperties"] is False
    assert set(params["properties"]) == {"ask", "reason"}
    ask = params["properties"]["ask"]
    assert set(ask["properties"]) == {"kind", "tier", "model"}
    assert ask["required"] == ["kind"] and ask["additionalProperties"] is False
    assert ask["properties"]["kind"]["enum"] == ["model_tier", "other"]
    reason = params["properties"]["reason"]
    assert reason["maxLength"] == 600
    assert "about your own resident's needs only; never name or describe other people" in reason["description"]
    json.dumps(schema)  # serialisable as Hermes sends it


def test_success_answer_shape(tctx, cp):
    out = call(tctx, ARGS)
    assert out == {
        "prayer_id": PRAYER_ID,
        "status": "received",
        "review": "a village admin reviews every request; nothing changes until they approve",
        "tell_resident": True,
    }


# --------------------------------------------------------------------------
# The contract vector: what is sent, what is refused, how answers map
# --------------------------------------------------------------------------


@pytest.mark.parametrize("case", VECTOR["sent"], ids=lambda c: c["args"]["ask"]["kind"] + ":" + str(len(c["args"]["reason"])))
def test_vector_sent_bodies(tctx, cp, case):
    out = call(tctx, case["args"])
    assert out["status"] == "received"
    assert len(cp.requests) == 1
    req = cp.requests[0]
    assert req["method"] == "POST"
    assert req["url"] == CP + VECTOR["request"]["path"].format(tenant_id=TENANT)
    body = req["body"]
    assert list(body) == VECTOR["rules"]["body_keys"]
    key = body.pop("idempotency_key")
    assert body == case["body"]
    assert len(key) == 36 and uuid.UUID(key).version == 4 and str(uuid.UUID(key)) == key
    # Compact JSON, UTF-8 as is, within 4 KiB.
    assert req["raw"] == json.dumps({**case["body"], "idempotency_key": key}, ensure_ascii=False,
                                    separators=(",", ":")).encode("utf-8")
    assert len(req["raw"]) <= VECTOR["request"]["max_body_bytes"]


def test_vector_headers(tctx, cp):
    call(tctx, ARGS)
    headers = cp.requests[0]["headers"]
    assert headers["authorization"] == f"Bearer {TOKEN}"
    assert headers["content-type"] == "application/json"
    assert headers["accept"] == "application/json"
    assert headers["x-av-session-kind"] == "dm"
    assert cp.requests[0]["timeout"] == pytest.approx(8.0)


@pytest.mark.parametrize(
    "code,args",
    [(code, args) for code, cases in VECTOR["refused"].items() for args in cases],
    ids=lambda v: v if isinstance(v, str) else None,
)
def test_vector_refused_before_sending(tctx, cp, code, args):
    out = call(tctx, args)
    assert out["error"] == code
    assert isinstance(out["message"], str) and out["message"]
    assert cp.requests == []


@pytest.mark.parametrize("case", VECTOR["answers"], ids=lambda c: f"{c['status']}-{c['body'].get('error', 'ok')}")
def test_vector_answers(tctx, cp, case):
    attempts = case.get("attempts", 1)
    cp.script = [reply(case["status"], case["body"]) for _ in range(attempts)]
    out = call(tctx, ARGS)
    if "error" in case["tool"]:
        message = out.pop("message")
        assert isinstance(message, str) and message
    assert out == case["tool"]
    assert len(cp.requests) == attempts
    assert len({r["body"]["idempotency_key"] for r in cp.requests}) == 1


def test_vector_ids_are_the_note_derivation(pr, plugin):
    core = sys.modules[f"{plugin.__name__}._core"]
    assert str(core.NS_AV) == VECTOR["ids"]["ns_av"]
    for case in VECTOR["ids"]["cases"]:
        prayer_id = str(uuid.uuid5(core.NS_AV, f"prayer:{case['tenant_id']}:{case['idempotency_key']}"))
        assert prayer_id == case["prayer_id"]
        assert str(uuid.uuid5(core.NS_AV, f"prayer.made:{prayer_id}")) == case["event_id"]
        assert pr.IDEMPOTENCY_KEY.fullmatch(case["idempotency_key"])


def test_vector_rules_are_the_module_rules(pr):
    rules = VECTOR["rules"]
    assert rules["tier_fullmatch"] == pr.TIER.pattern
    assert rules["model_fullmatch"] == pr.MODEL_ID.pattern and rules["model_max"] == pr.MODEL_ID_MAX
    assert rules["idempotency_key_fullmatch"] == pr.IDEMPOTENCY_KEY.pattern
    assert rules["reason_max"] == pr.REASON_MAX and rules["reason_max_lines"] == pr.REASON_MAX_LINES
    assert rules["reason_controls_refused"] == pr.CONTROLS.pattern
    contact = rules["reason_contact_search"]
    assert [contact["email"], contact["phone"], contact["handle"]] == [p.pattern for p in pr.CONTACT[:3]]
    assert pr.CONTACT[3].pattern == "t\\.me/" and contact["telegram_link"] == "(?i)t\\.me/"
    assert rules["ask_kind"] == list(pr.ASK_KINDS)
    assert VECTOR["request"]["max_body_bytes"] == pr.MAX_BODY_BYTES
    assert VECTOR["request"]["deadline_s"] == pr.DEADLINE_S


def test_reason_is_sent_normalised_and_trimmed_like_javascript(pr):
    # Python's str.strip would also drop U+001C-U+001F and U+0085; JS's trim keeps them (then refused as controls).
    assert pr.normalize_reason("\x1cneeds more\x1c") == (None, "reason_invalid")
    assert pr.normalize_reason("﻿needs more　") == ("needs more", None)
    assert pr.normalize_reason("é") == ("é", None)
    assert pr.normalize_reason("\ud83d lone") == (None, "reason_invalid")


# --------------------------------------------------------------------------
# Who may pray (§2 session rule)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("chat_type", ["group", "supergroup", "channel", "thread", "forum", "webhook"])
def test_group_sessions_are_refused(tctx, cp, monkeypatch, chat_type):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    out = call(tctx, ARGS)
    assert out["error"] == "group_session"
    assert cp.requests == []


@pytest.mark.parametrize("chat_type", ["dm", "private", "DIRECT", "c2c"])
def test_direct_chats_are_dm(tctx, cp, monkeypatch, chat_type):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    assert call(tctx, ARGS)["status"] == "received"
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "dm"


def test_a_non_local_surface_with_no_chat_type_is_refused(tctx, cp, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "api_server")
    assert call(tctx, ARGS)["error"] == "group_session"
    assert cp.requests == []


def test_the_local_cli_is_the_owners_main_session(tctx, cp, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "cli")
    assert call(tctx, ARGS)["status"] == "received"
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "dm"


def test_cron_by_session_id(tctx, cp, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    assert call(tctx, ARGS, session="cron_job1_20261014")["status"] == "received"
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "cron"


def test_cron_by_platform_lineage_even_where_it_delivers_to_a_group(tctx, cp, monkeypatch):
    tctx.fire("on_session_start", session_id="s-c", model="m", platform="cron")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    assert call(tctx, ARGS, session="s-c")["status"] == "received"
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "cron"


def test_cron_subagent_by_lineage(tctx, cp, monkeypatch):
    tctx.fire("subagent_start", child_session_id="child-1", parent_session_id="cron_job2_1")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "subagent")
    assert call(tctx, ARGS, session="child-1")["status"] == "received"
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "cron"


def test_cron_by_hermes_flag(tctx, cp, monkeypatch):
    monkeypatch.setenv("HERMES_CRON_SESSION", "1")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    assert call(tctx, ARGS)["status"] == "received"
    assert cp.requests[0]["headers"]["x-av-session-kind"] == "cron"


def test_a_session_label_cannot_come_from_the_arguments(tctx, cp, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    out = call(tctx, {**ARGS, "session_kind": "dm"})
    assert out["error"] == "group_session"  # the session is checked first; nothing is sent either way
    assert cp.requests == []


class _Unset:
    pass


def _fake_gateway(monkeypatch, values: dict, engaged: bool) -> None:
    unset = _Unset()

    class Var:
        def __init__(self, value: Any) -> None:
            self.value = value

        def get(self) -> Any:
            return self.value

    sc = types.ModuleType("gateway.session_context")
    names = ("HERMES_SESSION_CHAT_TYPE", "HERMES_CRON_SESSION", "HERMES_SESSION_PLATFORM", "HERMES_SESSION_SOURCE",
             "HERMES_SESSION_ID")
    sc._VAR_MAP = {name: Var(values.get(name, unset)) for name in names}
    sc._UNSET = unset
    sc.session_context_engaged = lambda: engaged
    sc.get_session_env = lambda name, default="": default
    gateway = types.ModuleType("gateway")
    gateway.session_context = sc
    monkeypatch.setitem(sys.modules, "gateway", gateway)
    monkeypatch.setitem(sys.modules, "gateway.session_context", sc)


def test_gateway_task_bound_to_a_dm(tctx, cp, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")  # a stale mirror from another turn
    _fake_gateway(monkeypatch, {"HERMES_SESSION_CHAT_TYPE": "dm", "HERMES_SESSION_PLATFORM": "telegram",
                                "HERMES_SESSION_SOURCE": "telegram", "HERMES_SESSION_ID": SESSION}, engaged=True)
    assert call(tctx, ARGS)["status"] == "received"


def test_gateway_task_with_no_session_bound_is_refused(tctx, cp, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")  # someone else's turn's mirror
    _fake_gateway(monkeypatch, {}, engaged=True)
    assert call(tctx, ARGS)["error"] == "group_session"
    assert cp.requests == []


def test_gateway_task_bound_to_a_group_is_refused(tctx, cp, monkeypatch):
    _fake_gateway(monkeypatch, {"HERMES_SESSION_CHAT_TYPE": "group", "HERMES_SESSION_PLATFORM": "telegram",
                                "HERMES_SESSION_SOURCE": "telegram", "HERMES_SESSION_ID": SESSION}, engaged=True)
    assert call(tctx, ARGS)["error"] == "group_session"


# --------------------------------------------------------------------------
# The wire: retry with the same key, deadline, https only, no redirect
# --------------------------------------------------------------------------


def test_transport_failure_is_retried_once_with_the_same_key(tctx, cp):
    cp.script = [urllib.error.URLError(ConnectionRefusedError("refused"))]
    out = call(tctx, ARGS)
    assert out["status"] == "received"
    assert len(cp.requests) == 2
    assert cp.requests[0]["raw"] == cp.requests[1]["raw"]


def test_a_cut_answer_is_retried_with_the_same_key(tctx, cp):
    cp.script = [Response(201, b"{}", fail_read=True)]
    assert call(tctx, ARGS)["status"] == "received"
    assert len(cp.requests) == 2 and cp.requests[0]["raw"] == cp.requests[1]["raw"]


def test_a_reset_after_sending_is_retried_with_the_same_key(tctx, cp):
    cp.script = [ConnectionResetError("reset")]
    assert call(tctx, ARGS)["status"] == "received"
    assert len(cp.requests) == 2 and cp.requests[0]["raw"] == cp.requests[1]["raw"]


def test_two_transport_failures_answer_unreachable(tctx, cp, caplog):
    cp.script = [urllib.error.URLError("down"), urllib.error.URLError("down")]
    with caplog.at_level(logging.INFO, logger="av-events"):
        out = call(tctx, ARGS)
    assert out["error"] == "unreachable" and "retry_after_s" not in out
    assert len(cp.requests) == 2
    assert "av-events: pray result=unreachable kind=model_tier session=dm http=transport attempts=2" in caplog.text


def test_a_new_call_gets_a_new_key(tctx, cp):
    call(tctx, ARGS)
    call(tctx, ARGS)
    assert cp.requests[0]["body"]["idempotency_key"] != cp.requests[1]["body"]["idempotency_key"]


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_a_5xx_is_retried_once(tctx, cp, status):
    cp.script = [reply(status, {"error": "unavailable"})]
    assert call(tctx, ARGS)["status"] == "received"
    assert len(cp.requests) == 2 and cp.requests[0]["raw"] == cp.requests[1]["raw"]


@pytest.mark.parametrize("status", [400, 401, 404, 409, 413, 422, 429, 301, 302, 307, 308])
def test_nothing_else_is_retried(tctx, cp, status):
    cp.script = [reply(status, {"error": "x"}, {"Location": "https://evil.example/"})]
    out = call(tctx, ARGS)
    assert "error" in out
    assert len(cp.requests) == 1


def test_the_deadline_bounds_each_attempt_and_the_retry_reuses_the_key(tctx, pr, cp, monkeypatch, caplog):
    waits: list[float] = []
    monkeypatch.setattr(pr, "_join", lambda worker, deadline: waits.append(deadline))  # never waits: past the deadline
    cp.gate = threading.Event()
    try:
        with caplog.at_level(logging.INFO, logger="av-events"):
            out = call(tctx, ARGS)
    finally:
        cp.gate.set()
    assert out["error"] == "unreachable"
    assert waits == [10.0, 10.0]
    assert len(cp.requests) == 2 and cp.requests[0]["raw"] == cp.requests[1]["raw"]
    assert "http=deadline attempts=2" in caplog.text


def test_unknown_and_odd_answers(tctx, cp):
    cp.script = [reply(418, {"error": "teapot"})]
    assert call(tctx, ARGS)["error"] == "http_418"
    cp.script = [reply(201, {"status": "received"})]
    assert call(tctx, ARGS)["error"] == "bad_answer"
    cp.script = [reply(201, b"not json")]
    assert call(tctx, ARGS)["error"] == "bad_answer"
    cp.script = [reply(201, {"prayer_id": PRAYER_ID.upper(), "status": "received"})]
    assert call(tctx, ARGS)["error"] == "bad_answer"
    cp.script = [reply(201, b" " * 20000)]
    assert call(tctx, ARGS)["error"] == "bad_answer"
    cp.script = [reply(201, {"prayer_id": PRAYER_ID, "status": "weird", "duplicate_open": "yes"})]
    assert call(tctx, ARGS) == {"prayer_id": PRAYER_ID, "status": "received", "review": VECTOR["answers"][0]["tool"]["review"], "tell_resident": True}
    cp.script = [reply(429, {"error": "rate_limited"}, {"Retry-After": "120"})]
    assert call(tctx, ARGS)["retry_after_s"] == 120
    cp.script = [reply(429, {"error": "rate_limited", "retry_after": 1e12})]
    assert call(tctx, ARGS)["retry_after_s"] == 86400
    cp.script = [reply(429, {"error": "rate_limited", "retry_after": 0.2})]
    assert call(tctx, ARGS)["retry_after_s"] == 1
    cp.script = [reply(429, {"error": "rate_limited", "retry_after": True})]
    assert "retry_after_s" not in call(tctx, ARGS)


@pytest.mark.parametrize("url", [
    "http://cp.example.test",            # plain http to a non-loopback host
    "ftp://cp.example.test",
    "https://user:pw@cp.example.test",   # credentials
    "https://cp.example.test/api",       # a path
    "https://cp.example.test/?x=1",      # a query
    "https://cp.example.test#f",
    "https://cp.exa mple.test",
    "",
])
def test_only_an_https_origin_or_loopback_http(tctx, cp, monkeypatch, url):
    monkeypatch.setenv("CONTROL_PLANE_URL", url)
    assert call(tctx, ARGS)["error"] == "not_configured"
    assert cp.requests == []


@pytest.mark.parametrize("url", ["http://127.0.0.1:8080", "http://localhost:9/", "https://cp.example.test/"])
def test_loopback_http_and_a_trailing_slash_are_allowed(tctx, cp, monkeypatch, url):
    monkeypatch.setenv("CONTROL_PLANE_URL", url)
    assert call(tctx, ARGS)["status"] == "received"
    assert cp.requests[0]["url"] == url.rstrip("/") + f"/tenants/{TENANT}/prayers"


def test_token_and_tenant_are_required(tctx, cp, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "")
    assert call(tctx, ARGS)["error"] == "not_configured"
    monkeypatch.setenv("AV_EVENTS_TOKEN", TOKEN)
    monkeypatch.setenv("TENANT_ID", "not-a-uuid")
    assert call(tctx, ARGS)["error"] == "not_configured"
    monkeypatch.delenv("TENANT_ID")
    assert call(tctx, ARGS)["error"] == "not_configured"
    assert cp.requests == []


def test_a_blank_token_in_the_process_environment_beats_the_dotenv(tctx, cp, monkeypatch, home):
    (home / ".env").write_text(f"AV_EVENTS_TOKEN={TOKEN}\n", encoding="utf-8")
    monkeypatch.setenv("AV_EVENTS_TOKEN", "")
    assert call(tctx, ARGS)["error"] == "not_configured"
    assert cp.requests == []


def test_av_tenant_id_overrides_and_is_lower_cased(tctx, cp, monkeypatch):
    other = "0C1D2E3F-4A5B-4C6D-8E7F-901A2B3C4D5E"
    monkeypatch.setenv("AV_TENANT_ID", other)
    call(tctx, ARGS)
    assert cp.requests[0]["url"] == f"{CP}/tenants/{other.lower()}/prayers"


def test_an_oversized_body_is_not_sent(tctx, pr, cp, monkeypatch):
    monkeypatch.setattr(pr, "MAX_BODY_BYTES", 64)
    assert call(tctx, ARGS)["error"] == "too_large"
    assert cp.requests == []


# --------------------------------------------------------------------------
# Real HTTP on loopback, through the real NO_REDIRECT_OPENER
# --------------------------------------------------------------------------


class Server:
    """A loopback `http.server` that records requests and answers from `answer(path) -> (status, headers, body)`."""

    def __init__(self, answer: Callable[[str], tuple[int, dict, bytes]]) -> None:
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                outer.requests.append({"path": self.path, "method": self.command,
                                       "headers": {k.lower(): v for k, v in self.headers.items()}, "raw": raw})
                status, headers, body = answer(self.path)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_POST = do_GET = do_CONNECT = _handle  # noqa: N815

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
def live(plugin, pr, on):
    """Registered, with the real opener (no FakeCP)."""
    ctx = ToolFireCtx()
    plugin.register(ctx)
    return ctx


def test_end_to_end_on_loopback(live, monkeypatch):
    created = json.dumps({"prayer_id": PRAYER_ID, "status": "received"}).encode()
    with Server(lambda _p: (201, {"Content-Type": "application/json"}, created)) as server:
        monkeypatch.setenv("CONTROL_PLANE_URL", server.url)
        out = call(live, ARGS)
    assert out["prayer_id"] == PRAYER_ID
    (req,) = server.requests
    assert req["method"] == "POST" and req["path"] == f"/tenants/{TENANT}/prayers"
    assert req["headers"]["authorization"] == f"Bearer {TOKEN}"
    assert req["headers"]["x-av-session-kind"] == "dm"
    assert req["headers"]["content-type"] == "application/json"
    body = json.loads(req["raw"])
    assert body["ask"] == ARGS["ask"] and body["reason"] == REASON


def test_a_real_redirect_is_refused_and_the_bearer_never_reaches_its_target(live, monkeypatch):
    with Server(lambda _p: (201, {}, b"{}")) as elsewhere:
        target = elsewhere.url + "/steal"
        with Server(lambda _p: (307, {"Location": target}, b"")) as server:
            monkeypatch.setenv("CONTROL_PLANE_URL", server.url)
            out = call(live, ARGS)
    assert out["error"] == "redirect_refused"
    assert len(server.requests) == 1
    assert elsewhere.requests == []


def test_proxy_variables_are_ignored(live, monkeypatch):
    created = json.dumps({"prayer_id": PRAYER_ID, "status": "received"}).encode()
    with Server(lambda _p: (502, {}, b"")) as proxy, \
            Server(lambda _p: (201, {"Content-Type": "application/json"}, created)) as server:
        for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY"):
            monkeypatch.setenv(name, proxy.url)
        monkeypatch.setenv("CONTROL_PLANE_URL", server.url)
        assert call(live, ARGS)["status"] == "received"
    assert proxy.requests == [] and len(server.requests) == 1


def test_a_real_503_is_retried_once_on_the_wire(live, monkeypatch):
    answers = iter([(503, {"Content-Type": "application/json"}, b'{"error":"unavailable","retry_after_s":30}'),
                    (503, {"Content-Type": "application/json"}, b'{"error":"unavailable","retry_after_s":30}')])
    with Server(lambda _p: next(answers)) as server:
        monkeypatch.setenv("CONTROL_PLANE_URL", server.url)
        out = call(live, ARGS)
    assert out["error"] == "unavailable" and out["retry_after_s"] == 30
    assert len(server.requests) == 2 and server.requests[0]["raw"] == server.requests[1]["raw"]


# --------------------------------------------------------------------------
# Nothing private leaves; fail open
# --------------------------------------------------------------------------


def test_logs_carry_codes_only(tctx, cp, caplog):
    with caplog.at_level(logging.DEBUG):
        call(tctx, ARGS)
        cp.script = [reply(400, {"error": "reason_contact"})]
        call(tctx, ARGS)
    text = caplog.text
    assert REASON not in text and TOKEN not in text and TENANT not in text and TENANT[:8] not in text
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("av-events: pray result=")]
    assert lines == [
        "av-events: pray result=received kind=model_tier session=dm http=201 attempts=1",
        "av-events: pray result=reason_contact kind=model_tier session=dm http=400 attempts=1",
    ]


def test_the_answer_never_echoes_the_reason_or_the_token(tctx, cp):
    for script in ([], [reply(400, {"error": "reason_invalid", "reason": REASON})], [reply(503, {"echo": TOKEN})] * 2):
        cp.script = list(script)
        out = json.dumps(call(tctx, ARGS))
        assert REASON not in out and TOKEN not in out


def test_tool_call_telemetry_keeps_no_reason_and_pray_emits_no_event(tctx, cp, plugin, av, monkeypatch):
    monkeypatch.setenv("AV_CAPTURE", "full")
    result = tctx.tools["pray"]["handler"](ARGS, task_id="task-1", session_id=SESSION)
    tctx.fire("post_tool_call", tool_name="pray", args=ARGS, result=result, session_id=SESSION, task_id="task-1",
              turn_id="turn-1", tool_call_id="call-1", api_request_id="req-1", duration_ms=12, status="ok",
              error_type=None, error_message=None)
    events = av.read_buffer(plugin._COLLECTOR)
    calls = [e for e in events if e["event_type"] == "tool.call"]
    assert len(calls) == 1  # the observer saw the call: the check below is not vacuous
    assert calls[0]["payload"]["tool_name"] is None and calls[0]["payload"]["tool_category"] == "other"
    blob = json.dumps(events, ensure_ascii=False)
    assert REASON not in blob and TOKEN not in blob
    assert not [e for e in events if e["event_type"].startswith("prayer")]


def test_a_failure_inside_the_tool_answers_internal(tctx, pr, cp, monkeypatch, caplog):
    def boom(_args):  # noqa: ANN001
        raise RuntimeError(REASON)

    monkeypatch.setattr(pr, "validate", boom)
    out = call(tctx, ARGS)
    assert out["error"] == "internal"
    assert "av-events: pray failed=RuntimeError" in caplog.text and REASON not in caplog.text
    assert cp.requests == []
