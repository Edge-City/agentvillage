"""DATA-212: the `record_intention` tool, the one front door for intentions.

Index is faked in-process: the module's `_OPENER` is replaced by `FakeIndex`,
which answers the MCP streamable-HTTP sequence and records every request. No
test reaches the network. The observer half is driven the way Hermes drives
it: the handler's own return value is handed to `post_tool_call`.
"""

from __future__ import annotations

import io
import json
import logging
import os
import stat
import sys
import threading
import time
import urllib.error
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

SESSION = "sess-ri"
KEY = "index-key-for-record-intention-tests-0123456789"
TEXT = "Looking for a climbing partner in Goa on weekends"
INDEX_ID = "int-7f3a"
PROD_URL = "https://protocol.index.network/mcp"
RULE = (
    "The two legitimate reasons an explicit intent stays local: the resident asked, or the "
    "content is personal."
)
REPO = Path(__file__).resolve().parents[3]


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------


class Headers:
    def __init__(self, values: dict[str, str]) -> None:
        self._values = {k.lower(): v for k, v in values.items()}

    def get(self, name: str, default: Any = None) -> Any:
        return self._values.get(name.lower(), default)


class Response:
    def __init__(self, status: int, body: bytes, headers: Optional[dict] = None) -> None:
        self.status = status
        self.headers = Headers(headers or {})
        self._body = io.BytesIO(body)

    def read(self, n: int = -1) -> bytes:
        return self._body.read(n)

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def rpc(result: Any, rpc_id: int = 1) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": rpc_id, "result": result}).encode()


def tool_text(payload: Any, **extra: Any) -> dict:
    """A `tools/call` result carrying Index's JSON document as text content."""
    return {"content": [{"type": "text", "text": json.dumps(payload)}], **extra}


def created(intent_id: str = INDEX_ID) -> dict:
    return tool_text({"success": True, "data": {"intent": {"id": intent_id, "status": "active"}}})


class FakeIndex:
    """Answers `initialize`, `notifications/initialized` and `tools/call`.

    `tool` is what `tools/call` returns: a dict (a JSON-RPC result), a
    `Response`, or an exception to raise. Every request is recorded.
    """

    def __init__(self, tool: Any = None) -> None:
        self.tool = created() if tool is None else tool
        self.requests: list[dict] = []
        self.delay = 0.0
        self._lock = threading.Lock()

    def open(self, request, timeout=None):  # noqa: ANN001 - urllib's opener API
        body = json.loads(request.data.decode())
        with self._lock:
            self.requests.append(
                {
                    "url": request.full_url,
                    "method": request.get_method(),
                    "headers": {k.lower(): v for k, v in request.header_items()},
                    "body": body,
                    "timeout": timeout,
                }
            )
        if self.delay:
            time.sleep(self.delay)
        method = body.get("method")
        if method == "initialize":
            return Response(
                200,
                rpc({"protocolVersion": "2025-03-26", "capabilities": {}}, body["id"]),
                {"content-type": "application/json", "mcp-session-id": "mcp-sess-1"},
            )
        if method == "notifications/initialized":
            return Response(202, b"")
        answer = self.tool
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, Response):
            return answer
        return Response(200, rpc(answer, body["id"]), {"content-type": "application/json"})

    def tool_calls(self) -> list[dict]:
        return [r["body"]["params"] for r in self.requests if r["body"].get("method") == "tools/call"]


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
def ri(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._record_intention"]


@pytest.fixture()
def index(ri, monkeypatch):
    fake = FakeIndex()
    monkeypatch.setattr(ri, "_OPENER", fake)
    return fake


@pytest.fixture()
def on(monkeypatch, home):
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("INDEX_API_KEY", KEY)


@pytest.fixture()
def tctx(plugin, index, on, monkeypatch):
    """The plugin registered and live (it has a token), with the tool, in a Telegram session."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return ctx


def call(ctx: ToolFireCtx, args: dict, *, session: str = SESSION, tool_call_id: str = "call-1") -> dict:
    """Run the tool as Hermes would, then hand its result to `post_tool_call`."""
    handler = ctx.tools["record_intention"]["handler"]
    result = handler(args, task_id="task-1", session_id=session)
    assert isinstance(result, str)
    ctx.fire(
        "post_tool_call",
        tool_name="record_intention",
        args=args,
        result=result,
        session_id=session,
        task_id="task-1",
        turn_id="turn-1",
        tool_call_id=tool_call_id,
        api_request_id="req-1",
        duration_ms=120,
        status="error" if '"error"' in result else "ok",
        error_type=None,
        error_message=None,
    )
    return json.loads(result)


def intention_events(av, plugin) -> list[dict]:
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("intention.")]


# --------------------------------------------------------------------------
# Switch and registration
# --------------------------------------------------------------------------


def test_switch_off_registers_no_tool_and_logs_one_line(plugin, index, home, caplog):
    ctx = ToolFireCtx()
    with caplog.at_level(logging.DEBUG, logger="av-events"):
        plugin.register(ctx)
    assert "record_intention" not in ctx.tools
    assert "consent_status" in ctx.tools
    lines = [r.getMessage() for r in caplog.records if "record_intention" in r.getMessage()]
    assert lines == ["av-events: record_intention skipped=switch_off"]


@pytest.mark.parametrize("value", ["0", "false", "off", "", "maybe"])
def test_only_a_truthy_switch_registers(plugin, index, home, monkeypatch, value):
    monkeypatch.setenv("AV_RECORD_INTENTION", value)
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert "record_intention" not in ctx.tools


@pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
def test_switch_on_registers_the_tool(plugin, ri, index, home, monkeypatch, caplog, value):
    monkeypatch.setenv("AV_RECORD_INTENTION", value)
    ctx = ToolFireCtx()
    with caplog.at_level(logging.DEBUG, logger="av-events"):
        plugin.register(ctx)
    tool = ctx.tools["record_intention"]
    assert tool["toolset"] == "av-events"
    assert tool["schema"]["name"] == "record_intention"
    assert tool["description"] == ri.TOOL_DESCRIPTION
    assert set(tool["schema"]["parameters"]["properties"]) == {
        "action", "text", "summary", "source", "publish", "reason", "intention_id",
    }
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)
    assert "av-events: record_intention registered" in caplog.text


def test_switch_read_from_the_dotenv(plugin, index, home):
    (home / ".env").write_text("AV_RECORD_INTENTION=1\n", encoding="utf-8")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert "record_intention" in ctx.tools


def test_switch_turned_off_after_registration_refuses_without_calling_index(tctx, index, monkeypatch, av, plugin):
    monkeypatch.setenv("AV_RECORD_INTENTION", "0")
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["success"] is False and out["error"] == "disabled"
    assert index.requests == []
    assert intention_events(av, plugin) == []


def test_older_register_tool_without_description(plugin, ri, index, on):
    class Older(ToolFireCtx):
        def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False):  # noqa: ANN001
            self.tools[name] = {"schema": schema, "handler": handler}

    ctx = Older()
    plugin.register(ctx)
    assert "record_intention" in ctx.tools


def test_a_refused_registration_keeps_the_hooks(plugin, index, on, caplog):
    class Refusing(ToolFireCtx):
        def register_tool(self, name, *args, **kwargs):  # noqa: ANN001
            if name == "record_intention":
                raise PermissionError("no")
            return super().register_tool(name, *args, **kwargs)

    ctx = Refusing()
    plugin.register(ctx)
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)
    assert "av-events: record_intention register_failed=PermissionError" in caplog.text


# --------------------------------------------------------------------------
# The publish-by-default rule, stated where the agent reads it
# --------------------------------------------------------------------------


def test_rule_is_in_the_description_the_manifest_and_the_skill(ri):
    assert RULE in ri.PUBLISH_RULE
    assert RULE in ri.TOOL_DESCRIPTION
    assert RULE in (REPO / "plugins" / "av-events" / "plugin.yaml").read_text(encoding="utf-8")
    skill = (REPO / "skills" / "record-intention" / "SKILL.md").read_text(encoding="utf-8")
    assert RULE in skill
    assert "requires_tools" in skill and "record_intention" in skill


def test_description_is_searchable(ri):
    words = ri.TOOL_DESCRIPTION.lower()
    for phrase in ("record an intention", "publish", "index", "ambient"):
        assert phrase in words


def test_the_skill_is_installed_with_the_edge_bundles():
    paths = (REPO / "install" / "paths.ts").read_text(encoding="utf-8")
    assert '"record-intention"' in paths


# --------------------------------------------------------------------------
# Capture, published
# --------------------------------------------------------------------------


def test_publish_speaks_the_poller_sequence(tctx, index):
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["success"] is True
    methods = [r["body"]["method"] for r in index.requests]
    assert methods == ["initialize", "notifications/initialized", "tools/call"]
    for request in index.requests:
        assert request["url"] == PROD_URL
        assert request["method"] == "POST"
        assert request["headers"]["x-api-key"] == KEY
        assert request["headers"]["content-type"] == "application/json"
        assert request["headers"]["accept"] == "application/json, text/event-stream"
        assert request["body"]["jsonrpc"] == "2.0"
        assert request["timeout"] is not None and request["timeout"] <= 30
        # Only the headers the poller sends.
        assert set(request["headers"]) <= {"x-api-key", "content-type", "accept", "mcp-session-id", "content-length", "host", "user-agent", "connection"}
    assert "mcp-session-id" not in index.requests[0]["headers"]
    assert index.requests[1]["headers"]["mcp-session-id"] == "mcp-sess-1"
    assert index.requests[2]["headers"]["mcp-session-id"] == "mcp-sess-1"
    assert "id" not in index.requests[1]["body"]  # a notification
    assert index.tool_calls() == [{"name": "create_intent", "arguments": {"description": TEXT}}]


def test_publish_returns_index_id(tctx, index):
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["intention_id"] == INDEX_ID
    assert out["index_intent_id"] == INDEX_ID
    assert out["published"] is True
    assert "publish_refused" not in out and "local_reason" not in out


def test_exactly_one_intention_captured_per_published_call(tctx, index, av, plugin):
    """The Index write is this tool's own HTTP, not a Hermes MCP call, so the
    `index_tool` observer never fires: one call, one captured event."""
    call(tctx, {"text": TEXT, "summary": "Climbing partner", "source": "message"})
    buffered = av.read_buffer(plugin._COLLECTOR)
    events = [e for e in buffered if e["event_type"].startswith("intention.")]
    assert [e["event_type"] for e in events] == ["intention.captured"]
    event = events[0]
    assert event["intention_id"] == INDEX_ID
    payload = event["payload"]
    assert payload["capture_path"] == "record_intention"
    assert payload["index_intent_id"] == INDEX_ID
    assert payload["source"] == "message"
    assert payload["publish_refused"] is None and payload["local_reason"] is None
    # The only tool.call is the one Hermes made: record_intention.
    tools = [e["payload"].get("tool_name") for e in buffered if e["event_type"] == "tool.call"]
    assert tools == ["record_intention"]
    # Two calls, two events: nothing is swallowed or doubled.
    index.tool = created("int-second")
    call(tctx, {"text": TEXT + " too", "source": "onboarding"}, tool_call_id="call-2")
    events = intention_events(av, plugin)
    assert [e["intention_id"] for e in events] == [INDEX_ID, "int-second"]
    assert events[1]["payload"]["source"] == "onboarding"


def test_note_source_publishes(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "note"})
    assert out["published"] is True
    assert intention_events(av, plugin)[0]["payload"]["source"] == "note"


def test_sse_response_is_read(tctx, index):
    body = (
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n'
        f"event: message\ndata: {json.dumps({'jsonrpc': '2.0', 'id': 3, 'result': created()})}\n\n"
    ).encode()
    index.tool = Response(200, body, {"content-type": "text/event-stream"})
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["intention_id"] == INDEX_ID and out["published"] is True


def test_structured_content_wins(tctx, index):
    index.tool = {"content": [], "structuredContent": {"success": True, "data": {"intent": {"id": "int-sc"}}}}
    assert call(tctx, {"text": TEXT, "source": "message"})["intention_id"] == "int-sc"


def test_configured_https_url_is_used(tctx, index, monkeypatch):
    monkeypatch.setenv("INDEX_MCP_URL", "https://protocol.dev.index.network/mcp")
    call(tctx, {"text": TEXT, "source": "message"})
    assert {r["url"] for r in index.requests} == {"https://protocol.dev.index.network/mcp"}


def test_success_result_does_not_look_like_a_failure_to_hermes(tctx, index):
    """Hermes marks a result failed when it holds `"error"` / `"failed"`
    (`agent/display.py` `_detect_tool_failure`); the observer then records nothing."""
    handler = tctx.tools["record_intention"]["handler"]
    for args in (
        {"text": TEXT, "source": "message"},
        {"text": TEXT, "source": "ambient"},
        {"text": TEXT, "source": "message", "publish": False, "reason": "personal"},
    ):
        result = handler(args, session_id=SESSION)
        assert '"error"' not in result.lower() and '"failed"' not in result.lower()


# --------------------------------------------------------------------------
# Capture, Index refused or unreachable: local, with publish_refused
# --------------------------------------------------------------------------


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(PROD_URL, code, "x", {}, io.BytesIO(b"{}"))


@pytest.mark.parametrize(
    "answer,code",
    [
        (tool_text({"success": False, "error": "Signal too vague"}), "rejected"),
        (tool_text({"success": "false"}), "rejected"),
        ({"isError": True, "content": [{"type": "text", "text": "too vague"}]}, "rejected"),
        (tool_text({"success": True, "data": {}}), "malformed"),
        (tool_text({"success": True, "data": {"intent": {"id": "bad id with spaces"}}}), "malformed"),
        ({"content": [{"type": "text", "text": ""}]}, "malformed"),
        (Response(200, b"not json", {"content-type": "application/json"}), "malformed"),
        (Response(200, json.dumps({"jsonrpc": "2.0", "id": 3, "error": {"code": -32000}}).encode(),
                  {"content-type": "application/json"}), "rpc_error"),
        (Response(200, b"x" * (300 * 1024), {"content-type": "application/json"}), "too_large"),
        (http_error(400), "http_400"),
        (http_error(401), "http_401"),
        (http_error(429), "http_429"),
        (http_error(503), "http_503"),
        (http_error(302), "redirect"),
    ],
)
def test_index_refusal_is_a_local_capture_with_the_code(tctx, index, av, plugin, answer, code):
    index.tool = answer
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["success"] is True
    assert out["published"] is False
    assert out["publish_refused"] == code
    assert out["index_intent_id"] is None
    assert uuid.UUID(out["intention_id"]).version == 7
    events = intention_events(av, plugin)
    assert [e["event_type"] for e in events] == ["intention.captured"]
    assert events[0]["intention_id"] == out["intention_id"]
    assert events[0]["payload"]["publish_refused"] == code
    assert events[0]["payload"]["index_intent_id"] is None
    assert events[0]["payload"]["source"] == "message"


@pytest.mark.parametrize(
    "exc,code",
    [
        (urllib.error.URLError(ConnectionRefusedError(61, "refused")), "transport"),
        (OSError("tls"), "transport"),
        (TimeoutError(), "timeout"),
        (urllib.error.URLError(TimeoutError()), "timeout"),
    ],
)
def test_transport_failure_is_a_local_capture(tctx, index, av, plugin, exc, code):
    index.tool = exc
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["success"] is True and out["published"] is False
    assert out["publish_refused"] == code
    assert intention_events(av, plugin)[0]["payload"]["publish_refused"] == code


def test_one_deadline_bounds_the_whole_sequence(ri, index, on):
    index.delay = 0.3
    started = time.monotonic()
    payload, code = ri.index_tool_call("create_intent", {"description": TEXT}, deadline=0.5)
    assert (payload, code) == (None, "timeout")
    assert time.monotonic() - started < 1.5


def test_default_deadline_is_thirty_seconds(ri):
    assert ri.INDEX_DEADLINE_S == 30.0
    assert ri.INDEX_TIMEOUT_S <= 30.0


def test_no_key_is_a_local_capture_without_a_request(tctx, index, monkeypatch, av, plugin):
    monkeypatch.setenv("INDEX_API_KEY", "")
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == "no_key" and out["published"] is False
    assert index.requests == []
    assert intention_events(av, plugin)[0]["payload"]["publish_refused"] == "no_key"


@pytest.mark.parametrize("url", ["http://protocol.index.network/mcp", "http://127.0.0.1:9/mcp", "ftp://x/mcp", "https://"])
def test_only_https_carries_the_key(tctx, index, monkeypatch, url):
    monkeypatch.setenv("INDEX_MCP_URL", url)
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == "url_refused"
    assert index.requests == []


def test_the_real_opener_refuses_redirects(ri, plugin, av):
    core = sys.modules[f"{av.MODULE_NAME}._core"]
    assert ri.NO_REDIRECT_OPENER is core.NO_REDIRECT_OPENER


# --------------------------------------------------------------------------
# Ambient and cron
# --------------------------------------------------------------------------


@pytest.mark.parametrize("publish", [None, True, False])
def test_ambient_never_calls_index(tctx, index, av, plugin, publish):
    args: dict[str, Any] = {"text": TEXT, "source": "ambient"}
    if publish is not None:
        args["publish"] = publish
    out = call(tctx, args)
    assert index.requests == []
    assert out["success"] is True and out["published"] is False and out["held"] is True
    assert out["source"] == "ambient" and out["index_intent_id"] is None
    assert uuid.UUID(out["intention_id"]).version == 7
    events = intention_events(av, plugin)
    assert [e["event_type"] for e in events] == ["intention.captured"]
    payload = events[0]["payload"]
    assert payload["source"] == "ambient"
    assert payload["index_intent_id"] is None
    assert payload["publish_refused"] is None and payload["local_reason"] is None


def test_cron_session_by_platform_is_forced_ambient(tctx, index, av, plugin):
    tctx.fire("on_session_start", session_id="nightly-1", model="m", platform="cron")
    out = call(tctx, {"text": TEXT, "source": "message"}, session="nightly-1")
    assert index.requests == []
    assert out["source"] == "ambient" and out["published"] is False
    assert intention_events(av, plugin)[0]["payload"]["source"] == "ambient"


def test_cron_session_by_id_is_forced_ambient(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "onboarding"}, session="cron_abc123_20261012")
    assert index.requests == []
    assert out["source"] == "ambient"
    assert intention_events(av, plugin)[0]["payload"]["source"] == "ambient"


def test_subagent_of_a_cron_run_is_forced_ambient(tctx, index, av, plugin):
    tctx.fire("on_session_start", session_id="nightly-2", model="m", platform="cron")
    tctx.fire(
        "subagent_start",
        parent_session_id="nightly-2",
        parent_turn_id="t",
        child_session_id="child-1",
        child_role="r",
        child_goal="g",
    )
    out = call(tctx, {"text": TEXT, "source": "message"}, session="child-1")
    assert index.requests == [] and out["source"] == "ambient"
    assert intention_events(av, plugin)[0]["payload"]["source"] == "ambient"


def test_a_cron_check_that_raises_holds_as_ambient(ri, index, on):
    def broken(_sid):  # noqa: ANN001
        raise RuntimeError("x")

    out = ri.record_intention_answer({"text": TEXT, "source": "message"}, SESSION, broken)
    assert out["source"] == "ambient" and index.requests == []


# --------------------------------------------------------------------------
# publish=false and its reason
# --------------------------------------------------------------------------


@pytest.mark.parametrize("reason", ["participant_asked", "personal", " Personal "])
def test_publish_false_with_a_reason_is_local(tctx, index, av, plugin, reason):
    out = call(tctx, {"text": TEXT, "source": "message", "publish": False, "reason": reason})
    assert index.requests == []
    assert out["published"] is False and out["local_reason"] == reason.strip().lower()
    payload = intention_events(av, plugin)[0]["payload"]
    assert payload["local_reason"] == reason.strip().lower()
    assert payload["publish_refused"] is None


def test_publish_false_as_a_string(tctx, index):
    out = call(tctx, {"text": TEXT, "source": "message", "publish": "false", "reason": "personal"})
    assert out["published"] is False and index.requests == []


@pytest.mark.parametrize("reason,code", [(None, "reason_required"), ("", "reason_required"), ("shy", "reason_invalid")])
def test_publish_false_needs_a_reason(tctx, index, av, plugin, reason, code):
    args: dict[str, Any] = {"text": TEXT, "source": "message", "publish": False}
    if reason is not None:
        args["reason"] = reason
    out = call(tctx, args)
    assert out == {"success": False, "error": code, "message": out["message"]}
    assert index.requests == []
    assert intention_events(av, plugin) == []


def test_no_explicit_intention_is_local_without_a_stated_reason(tctx, index, av, plugin, monkeypatch):
    """AC #5: every local message/onboarding/note capture carries a reason or a code."""
    call(tctx, {"text": TEXT, "source": "message"})
    index.tool = tool_text({"success": False})
    call(tctx, {"text": TEXT, "source": "onboarding"}, tool_call_id="c2")
    call(tctx, {"text": TEXT, "source": "note", "publish": False, "reason": "personal"}, tool_call_id="c3")
    monkeypatch.setenv("INDEX_API_KEY", "")
    call(tctx, {"text": TEXT, "source": "message"}, tool_call_id="c4")
    for event in intention_events(av, plugin):
        payload = event["payload"]
        if payload["source"] != "ambient" and payload["index_intent_id"] is None:
            assert payload["publish_refused"] or payload["local_reason"]


# --------------------------------------------------------------------------
# Confirm and the other refusals
# --------------------------------------------------------------------------


def test_confirm_is_refused_without_approval(tctx, index, av, plugin):
    held = call(tctx, {"text": TEXT, "source": "ambient"})
    out = call(tctx, {"action": "confirm", "intention_id": held["intention_id"]}, tool_call_id="c2")
    assert out["success"] is False and out["error"] == "no_confirmation_channel"
    assert "approval.md" in out["message"]
    assert index.requests == []
    assert [e["event_type"] for e in intention_events(av, plugin)] == ["intention.captured"]


def test_confirm_is_refused_even_with_approval_url_until_wired(tctx, index, monkeypatch, av, plugin):
    monkeypatch.setenv("AV_APPROVAL_URL", "https://approval.example/")
    out = call(tctx, {"action": "confirm", "intention_id": "x-1"})
    assert out["error"] == "confirmation_not_wired"
    assert index.requests == [] and intention_events(av, plugin) == []


@pytest.mark.parametrize(
    "args,code",
    [
        ({"source": "message"}, "text_required"),
        ({"text": "   ", "source": "message"}, "text_required"),
        ({"text": TEXT}, "source_required"),
        ({"text": TEXT, "source": "index"}, "source_invalid"),
        ({"text": TEXT, "source": "message", "publish": "maybe"}, "publish_invalid"),
        ({"action": "retract", "text": TEXT, "source": "message"}, "action_invalid"),
        ({"action": "capture", "text": TEXT, "source": "message", "intention_id": "x-1"}, "intention_id_unexpected"),
        ({"action": "update", "text": TEXT}, "intention_id_required"),
        ({"action": "update", "intention_id": "x-1"}, "text_required"),
        ({"action": "withdraw", "intention_id": "bad id"}, "intention_id_invalid"),
    ],
)
def test_refusals_record_nothing(tctx, index, av, plugin, ri, args, code):
    out = call(tctx, args)
    assert out["success"] is False and out["error"] == code
    assert out["message"] == ri.REFUSALS[code]
    assert index.requests == []
    assert intention_events(av, plugin) == []


def test_handler_never_raises(tctx, ri, monkeypatch, caplog):
    def boom(*_a, **_k):  # noqa: ANN002, ANN003
        raise ValueError("secret text " + TEXT)

    monkeypatch.setattr(ri, "record_intention_answer", boom)
    out = json.loads(tctx.tools["record_intention"]["handler"]({"text": TEXT, "source": "message"}, session_id=SESSION))
    assert out["error"] == "internal"
    assert "av-events: record_intention failed=ValueError" in caplog.text
    assert TEXT not in caplog.text


def test_handler_lets_system_exit_through(tctx, ri, monkeypatch):
    def leave(*_a, **_k):  # noqa: ANN002, ANN003
        raise SystemExit(0)

    monkeypatch.setattr(ri, "record_intention_answer", leave)
    with pytest.raises(SystemExit):
        tctx.tools["record_intention"]["handler"]({}, session_id=SESSION)


# --------------------------------------------------------------------------
# Update and withdraw
# --------------------------------------------------------------------------


def test_update_and_withdraw_of_a_published_intention_mirror_to_index(tctx, index, av, plugin):
    call(tctx, {"text": TEXT, "source": "message"})
    index.requests.clear()
    index.tool = tool_text({"success": True, "data": {"intent": {"id": INDEX_ID}}})
    up = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": TEXT + " and bouldering"}, tool_call_id="c2")
    assert up["success"] is True and up["published"] is True and "publish_refused" not in up
    assert index.tool_calls() == [
        {"name": "update_intent", "arguments": {"id": INDEX_ID, "description": TEXT + " and bouldering"}}
    ]
    index.requests.clear()
    out = call(tctx, {"action": "withdraw", "intention_id": INDEX_ID}, tool_call_id="c3")
    assert out["success"] is True
    assert index.tool_calls() == [{"name": "update_intent", "arguments": {"id": INDEX_ID, "status": "archived"}}]
    events = intention_events(av, plugin)
    assert [e["event_type"] for e in events] == ["intention.captured", "intention.updated", "intention.withdrawn"]
    assert {e["intention_id"] for e in events} == {INDEX_ID}
    # The source stored at capture, not the restrictive default for a call that names none.
    assert [e["payload"]["source"] for e in events] == ["message", "message", "message"]
    assert events[1]["payload"]["index_intent_id"] == INDEX_ID


def test_update_mirror_failure_is_recorded_locally(tctx, index, av, plugin):
    call(tctx, {"text": TEXT, "source": "message"})
    index.tool = http_error(500)
    out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": TEXT + "!"}, tool_call_id="c2")
    assert out["success"] is True and out["publish_refused"] == "http_500"
    assert intention_events(av, plugin)[-1]["payload"]["publish_refused"] == "http_500"


def test_update_of_a_local_intention_never_calls_index(tctx, index, av, plugin):
    held = call(tctx, {"text": TEXT, "source": "ambient"})
    call(tctx, {"action": "update", "intention_id": held["intention_id"], "text": TEXT + "!"}, tool_call_id="c2")
    call(tctx, {"action": "withdraw", "intention_id": held["intention_id"]}, tool_call_id="c3")
    assert index.requests == []
    events = intention_events(av, plugin)
    assert [e["payload"]["source"] for e in events] == ["ambient", "ambient", "ambient"]


def test_unknown_id_is_local_and_ambient(tctx, index, av, plugin):
    out = call(tctx, {"action": "withdraw", "intention_id": "never-seen"})
    assert out["success"] is True and out["published"] is False
    assert index.requests == []
    assert intention_events(av, plugin)[0]["payload"]["source"] == "ambient"


# --------------------------------------------------------------------------
# The map, the logs, the key
# --------------------------------------------------------------------------


def test_map_is_ids_only_and_private(tctx, index, ri, home):
    call(tctx, {"text": TEXT, "source": "message"})
    call(tctx, {"text": TEXT, "source": "ambient"}, tool_call_id="c2")
    path = Path(ri.map_path())
    assert path == home / "av-events" / "intentions.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    raw = path.read_text(encoding="utf-8")
    assert TEXT not in raw and "Goa" not in raw
    data = json.loads(raw)
    entries = data["intentions"]
    assert entries[INDEX_ID] == {"published": True, "source": "message"}
    assert [v for v in entries.values() if v["source"] == "ambient"] == [{"published": False, "source": "ambient"}]


def test_map_is_bounded(ri, index, on, monkeypatch):
    monkeypatch.setattr(ri, "MAX_MAP_ENTRIES", 3)
    for i in range(5):
        ri.remember(f"id-{i}", published=False, source="ambient")
    assert list(ri._load_map()) == ["id-2", "id-3", "id-4"]


def test_an_unwritable_map_costs_nothing_but_a_log_line(tctx, index, ri, monkeypatch, caplog):
    def fail(_entries):  # noqa: ANN001
        raise PermissionError("ro")

    monkeypatch.setattr(ri, "_save_map", fail)
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["success"] is True
    assert "map_write_failed=PermissionError" in caplog.text


def test_logs_carry_codes_never_text_or_key(tctx, index, caplog):
    with caplog.at_level(logging.DEBUG, logger="av-events"):
        call(tctx, {"text": TEXT, "source": "message"})
        index.tool = tool_text({"success": False, "error": TEXT})
        call(tctx, {"text": TEXT, "source": "message"}, tool_call_id="c2")
        call(tctx, {"text": TEXT, "source": "message", "publish": False}, tool_call_id="c3")
    lines = [r.getMessage() for r in caplog.records if "record_intention" in r.getMessage()]
    assert "av-events: record_intention action=capture source=message published=1 refused=- reason=-" in lines
    assert "av-events: record_intention action=capture source=message published=0 refused=rejected reason=-" in lines
    assert "av-events: record_intention action=capture refused=reason_required" in lines
    assert TEXT not in caplog.text and KEY not in caplog.text


def test_the_key_is_registered_with_the_sanitiser(tctx, index, plugin, av):
    call(tctx, {"text": TEXT, "source": "message"})
    core = sys.modules[f"{av.MODULE_NAME}._core"]
    assert KEY not in core.sanitize(f"leaked {KEY}")


def test_the_key_never_reaches_the_result(tctx, index):
    index.tool = http_error(401)
    raw = tctx.tools["record_intention"]["handler"]({"text": TEXT, "source": "message"}, session_id=SESSION)
    assert KEY not in raw
