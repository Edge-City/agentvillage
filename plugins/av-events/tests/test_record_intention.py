"""DATA-212: the `record_intention` tool, the one front door for intentions.

Index is faked in-process: the module's `_OPENER` is replaced by `FakeIndex`,
which answers Index's REST intent writes (DATA-249) and records every request. No
test reaches the network. The observer half is driven the way Hermes drives
it: the handler's own return value is handed to `post_tool_call`.
"""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import logging
import os
import stat
import sys
import re
import socket
import ssl
import threading
import urllib.error
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

SESSION = "sess-ri"
KEY = "index-key-for-record-intention-tests-0123456789"
TEXT = "Looking for a climbing partner in Goa on weekends"
INDEX_ID = "9b2f0c1e-0000-4000-8000-00000000abcd"
SECOND_ID = "9b2f0c1e-0000-4000-8000-0000000000b2"
ORIGIN = "https://protocol.index.network"
PROD_URL = ORIGIN + "/api/intents"
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
        self.headers = Headers(headers or {"content-type": "application/json"})
        self._body = io.BytesIO(body)

    def read(self, n: int = -1) -> bytes:
        return self._body.read(n)

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def created(intent_id: str = INDEX_ID) -> dict:
    """Index's `POST /api/intents` success body (`intent.controller.ts`)."""
    return {"intentId": intent_id, "networkIds": [], "sourceType": "agentvillage", "sourceId": None}


def http_error(code: int, body: Optional[dict] = None) -> urllib.error.HTTPError:
    raw = json.dumps(body if body is not None else {"error": "x"}).encode()
    return urllib.error.HTTPError(PROD_URL, code, "x", {}, io.BytesIO(raw))


def refused() -> urllib.error.HTTPError:
    """Index's 422 for a description it will not create (too vague)."""
    return http_error(422, {"error": "intent_rejected", "code": "intent_rejected", "detail": "Signal too vague"})


#: Which of Index's REST writes a request is, by method and path.
_OPS = (
    ("POST", re.compile(r"^/api/intents$"), "create_intent"),
    ("PATCH", re.compile(r"^/api/intents/[^/]+/archive$"), "archive_intent"),
    ("PATCH", re.compile(r"^/api/intents/[^/]+$"), "update_intent"),
)


class FakeIndex:
    """Index's REST intent writes, in-process.

    `tool` is what every write returns: a dict (a 200 JSON body), a
    `Response`, or an exception to raise (an `HTTPError` for a non-2xx). Every
    request is recorded.
    """

    def __init__(self, tool: Any = None) -> None:
        self.tool = created() if tool is None else tool
        self.requests: list[dict] = []
        #: When set, a write blocks until the event is set (no wall clock).
        self.gate: Optional[threading.Event] = None
        self._lock = threading.Lock()

    def open(self, request, timeout=None):  # noqa: ANN001 - urllib's opener API
        parts = urllib.parse.urlsplit(request.full_url)
        body = json.loads(request.data.decode()) if request.data is not None else None
        name = next((op for method, path, op in _OPS if method == request.get_method() and path.match(parts.path)), None)
        with self._lock:
            self.requests.append(
                {
                    "url": request.full_url,
                    "path": parts.path,
                    "method": request.get_method(),
                    "headers": {k.lower(): v for k, v in request.header_items()},
                    "body": body,
                    "raw": request.data,
                    "name": name,
                    "timeout": timeout,
                }
            )
        if self.gate is not None:
            self.gate.wait()
        answer = self.tool
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, Response):
            return answer
        return Response(200, json.dumps(answer).encode())

    def tool_calls(self) -> list[dict]:
        """Each write as `{name, arguments}`: the Index operation and its JSON body."""
        return [{"name": r["name"], "arguments": r["body"]} for r in self.requests]


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
    # F2: the tool sits behind Tool Search, so no `requires_tools` gate (it would hide
    # the skill); the text itself is conditional on the tool being reachable.
    assert "requires_tools" not in skill
    assert "tool_search" in skill and "tool_call" in skill


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


def test_publish_is_one_rest_create(tctx, index):
    """DATA-249: Index's MCP endpoint rejects the protocol versions this module
    could send, so a publish is one `POST /api/intents` with the same key."""
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["success"] is True
    [request] = index.requests
    assert request["url"] == PROD_URL
    assert request["method"] == "POST"
    assert request["headers"]["x-api-key"] == KEY
    assert request["headers"]["content-type"] == "application/json"
    assert request["headers"]["accept"] == "application/json"
    assert request["timeout"] is not None and request["timeout"] <= 30
    # Only these headers: no x-index-surface, no MCP session.
    assert set(request["headers"]) <= {"x-api-key", "content-type", "accept", "content-length", "host", "user-agent", "connection"}
    # DATA-249 O4: a stated capture marks the intent as ours, with no sourceId
    # (its intention_id is Index's id, corroborated by id). Nothing else in the
    # body: Index's schema is strict.
    assert index.tool_calls() == [{"name": "create_intent", "arguments": {"description": TEXT, "sourceType": "agentvillage"}}]


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
    index.tool = created(SECOND_ID)
    call(tctx, {"text": TEXT + " too", "source": "onboarding"}, tool_call_id="call-2")
    events = intention_events(av, plugin)
    assert [e["intention_id"] for e in events] == [INDEX_ID, SECOND_ID]
    assert events[1]["payload"]["source"] == "onboarding"


def test_note_source_publishes(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "note"})
    assert out["published"] is True
    assert intention_events(av, plugin)[0]["payload"]["source"] == "note"


def test_publish_with_a_source_id_sends_it(ri, index, on):
    """The held-then-published path (another lane) passes the held uuid v7."""
    held = "01927f3e-1b2c-7d4e-8f00-1234567890ab"
    assert ri.publish_intent(TEXT, source_id=held) == (INDEX_ID, None)
    assert index.tool_calls() == [{"name": "create_intent", "arguments": {
        "description": TEXT, "sourceType": "agentvillage", "sourceId": held}}]


@pytest.mark.parametrize(
    "text",
    [
        TEXT,
        "  Looking for a climbing partner  \n",
        "Café founders, équipe, 中文 and \U0001f9d7 climbers\tin Goa",
        "line one\r\nline two",
    ],
    ids=["plain", "edge-whitespace", "unicode-unnormalised", "crlf"],
)
def test_text_hash_is_the_sha256_of_the_bytes_sent_as_description(tctx, index, av, plugin, text):
    """DATA-249 item 4: the poller merges a capture with its Index intent only when
    the capture's `text_hash` equals the plain SHA-256 of the stored payload, so the
    hash must be over exactly the bytes sent as `description`: no trim, no
    Unicode or newline normalisation on either side."""
    out = call(tctx, {"text": text, "source": "message"})
    assert out["published"] is True
    [request] = index.requests
    # The bytes on the wire decode to exactly the text.
    description = json.loads(request["raw"].decode("utf-8"))["description"]
    assert description == text
    [event] = intention_events(av, plugin)
    assert event["payload"]["text_hash"] == hashlib.sha256(description.encode("utf-8")).hexdigest()


def test_mirror_with_nothing_to_change_calls_nothing(ri, index, on):
    assert ri.mirror_update(INDEX_ID) is None
    assert index.requests == []


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
# Where the writes go (DATA-249 api_origin)
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "api_url,mcp_url,expected",
    [
        (None, None, "https://protocol.index.network/api/intents"),
        ("https://protocol.dev.index.network", None, "https://protocol.dev.index.network/api/intents"),
        ("https://protocol.dev.index.network/", None, "https://protocol.dev.index.network/api/intents"),
        ("http://127.0.0.1:3001", None, "http://127.0.0.1:3001/api/intents"),
        ("http://localhost:3001", None, "http://localhost:3001/api/intents"),
        ("https://protocol.dev.index.network", "https://protocol.index.network/mcp", "https://protocol.dev.index.network/api/intents"),
        (None, "https://protocol.dev.index.network/mcp", "https://protocol.dev.index.network/api/intents"),
        (None, "https://protocol.dev.index.network:8443/mcp/", "https://protocol.dev.index.network:8443/api/intents"),
        # A2: Index's own Hermes plugin names the API as <origin>/api.
        ("https://protocol.dev.index.network/api", None, "https://protocol.dev.index.network/api/intents"),
        ("https://protocol.dev.index.network/api/", None, "https://protocol.dev.index.network/api/intents"),
        ("HTTPS://Protocol.Dev.Index.Network", None, "https://Protocol.Dev.Index.Network/api/intents"),
    ],
)
def test_the_rest_origin(tctx, index, monkeypatch, api_url, mcp_url, expected):
    for name, value in (("INDEX_API_URL", api_url), ("INDEX_MCP_URL", mcp_url)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["published"] is True
    assert [r["url"] for r in index.requests] == [expected]


@pytest.mark.parametrize(
    "api_url,mcp_url",
    [
        ("http://protocol.index.network", None),
        ("ftp://protocol.index.network", None),
        ("https://", None),
        ("https://user:pw@protocol.index.network", None),
        ("https://protocol.index.network/api/v1", None),
        ("https://protocol.index.network/?", None),
        ("https://protocol.index.network#", None),
        ("https://protocol.index.network/api?x", None),
        ("https://protocol.index.network/api#frag", None),
        (None, "https://protocol.index.network/mcp?x=1"),
        (None, "https://protocol.index.network/mcp#"),
        ("https://protocol.index.network?x=1", None),
        (None, "http://protocol.index.network/mcp"),
        (None, "http://127.0.0.1:9/mcp"),
        (None, "https://protocol.index.network/other"),
        (None, "ftp://x/mcp"),
    ],
)
def test_a_refused_origin_carries_no_key_and_never_falls_back(tctx, index, monkeypatch, api_url, mcp_url):
    """https only (plain http to loopback alone), an origin with no path; an
    unusable legacy INDEX_MCP_URL refuses rather than writing to production."""
    for name, value in (("INDEX_API_URL", api_url), ("INDEX_MCP_URL", mcp_url)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == "url_refused" and out["published"] is False
    assert index.requests == []


# --------------------------------------------------------------------------
# Capture, Index refused or unreachable: local, with publish_refused
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "answer,code",
    [
        # 422: Index will not create it from this text (too vague). The one
        # refusal the map labels `rejected` and the data side reads as
        # index_rejected.
        (refused(), "rejected"),
        (Response(422, b'{"error":"intent_rejected"}'), "rejected"),
        # Our request, our key, our receipt: never the resident's words.
        (http_error(400, {"error": "Validation failed"}), "http_400"),
        (http_error(401), "http_401"),
        (http_error(403, {"error": "invalid_preparation"}), "http_403"),
        (http_error(403, {"error": "forbidden", "code": "network_membership"}), "http_403"),
        (http_error(429), "http_429"),
        # 503 preparation_failed: retryable, and nothing was written.
        (http_error(503, {"error": "preparation_failed", "retryable": True}), "http_503"),
        # B1: a 5xx other than 503 may come after the write landed: the ambiguous code.
        (http_error(500, {"error": "Failed to create intent"}), "timeout"),
        (http_error(502), "timeout"),
        (http_error(504), "timeout"),
        (Response(500, b"{}"), "timeout"),
        (http_error(302), "redirect"),
        # A 2xx without a usable intentId is never a publish, and the create
        # may have landed: the ambiguous code (B1, B3).
        ({}, "timeout"),
        ({"success": True}, "timeout"),
        ({"intentId": None}, "timeout"),
        ({"intentId": "bad id with spaces"}, "timeout"),
        ({"intentId": 7}, "timeout"),
        ({"intentId": [INDEX_ID]}, "timeout"),
        ({"intentId": ".."}, "timeout"),
        ({"intentId": "a"}, "timeout"),
        ({"intentId": "x:y"}, "timeout"),
        ({"intentId": "int-7f3a"}, "timeout"),
        (Response(200, b"not json"), "timeout"),
        (Response(200, b"[1, 2]"), "timeout"),
        (Response(201, b""), "timeout"),
        (Response(204, b""), "timeout"),
        (Response(200, b"x" * (300 * 1024)), "timeout"),
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
        # Before anything was sent: urllib wraps connect, DNS, TLS and send failures in URLError.
        (urllib.error.URLError(ConnectionRefusedError(61, "refused")), "transport"),
        (urllib.error.URLError(socket.gaierror(8, "nodename nor servname")), "transport"),
        (urllib.error.URLError(ssl.SSLError(1, "handshake")), "transport"),
        # After the request was sent (getresponse / read): Index may have written (B1).
        (http.client.RemoteDisconnected("closed"), "timeout"),
        (ConnectionResetError(54, "reset"), "timeout"),
        (http.client.IncompleteRead(b"{\"intentId\": \""), "timeout"),
        (OSError("read failed"), "timeout"),
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


@pytest.mark.parametrize(
    "answer",
    [http_error(400), http_error(401), http_error(403), refused(), http_error(503), TimeoutError(), OSError("boom")],
)
def test_no_key_in_any_log_line_result_or_event(tctx, index, av, plugin, caplog, answer):
    caplog.set_level(logging.DEBUG)
    index.tool = answer
    out = call(tctx, {"text": TEXT, "source": "message"})
    index.tool = created()
    published = call(tctx, {"text": TEXT + " too", "source": "message"}, tool_call_id="c2")
    assert out["published"] is False
    for text in (caplog.text, json.dumps(out), json.dumps(published), json.dumps(av.read_buffer(plugin._COLLECTOR))):
        assert KEY not in text and TEXT not in caplog.text


def test_index_failures_carry_only_a_code(ri, index, on, monkeypatch):
    """No exception text on the failure path names the URL, the key or the body."""
    index.tool = http_error(401)
    seen: list[BaseException] = []
    real = ri._send

    def spy(*args, **kwargs):
        try:
            return real(*args, **kwargs)
        except BaseException as exc:
            seen.append(exc)
            raise

    monkeypatch.setattr(ri, "_send", spy)
    assert ri.publish_intent(TEXT) == (None, "http_401")
    [exc] = seen
    assert str(exc) == "http_401" and exc.__cause__ is None and exc.__suppress_context__
    assert KEY not in repr(exc) and TEXT not in repr(exc)


def test_one_deadline_bounds_the_whole_request(ri, index, on, monkeypatch):
    """F12: the wait is injected; the worker is held by an event, not a sleep."""
    index.gate = threading.Event()
    waited: list[float] = []
    monkeypatch.setattr(ri, "_join", lambda worker, deadline: waited.append(deadline))
    try:
        payload, code = ri.index_request("POST", ri.CREATE_PATH, {"description": TEXT, "sourceType": "agentvillage"})
    finally:
        index.gate.set()
    assert (payload, code) == (None, "timeout")
    assert waited == [ri.INDEX_DEADLINE_S] == [30.0]


def test_timeout_capture_tells_the_agent_not_to_retry(tctx, index, ri, monkeypatch):
    index.gate = threading.Event()
    monkeypatch.setattr(ri, "_join", lambda worker, deadline: None)
    try:
        out = call(tctx, {"text": TEXT, "source": "message"})
    finally:
        index.gate.set()
    assert out["publish_refused"] == "timeout"
    assert "Whether Index took it is unknown" in out["message"] and "do not retry it" in out["message"]
    assert "could not take it" not in out["message"]


def test_default_deadline_is_thirty_seconds(ri):
    assert ri.INDEX_DEADLINE_S == 30.0
    assert ri.INDEX_TIMEOUT_S <= 30.0


def test_no_key_is_a_local_capture_without_a_request(tctx, index, monkeypatch, av, plugin):
    monkeypatch.setenv("INDEX_API_KEY", "")
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == "no_key" and out["published"] is False
    assert index.requests == []
    assert intention_events(av, plugin)[0]["payload"]["publish_refused"] == "no_key"


def test_the_real_opener_refuses_redirects(ri, plugin, av):
    core = sys.modules[f"{av.MODULE_NAME}._core"]
    assert ri.NO_REDIRECT_OPENER is core.NO_REDIRECT_OPENER


def test_the_mcp_client_is_gone(ri):
    """DATA-249: nothing in the plugin speaks MCP to Index any more."""
    for name in ("_Session", "_read_rpc", "_tool_payload", "_mcp_tool", "index_tool_call", "DEFAULT_MCP_URL"):
        assert not hasattr(ri, name), name


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


def test_a_lineage_check_that_raises_holds_as_ambient(ri, index, on, monkeypatch):
    ri.note_platform(SESSION, "telegram")

    def broken(_sid):  # noqa: ANN001
        raise RuntimeError("x")

    monkeypatch.setattr(ri, "held_reason", broken)
    out = ri.record_intention_answer({"text": TEXT, "source": "message"}, SESSION)
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
    index.tool = refused()
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
    index.tool = {"intentId": INDEX_ID, "description": TEXT + " and bouldering", "sourceType": "agentvillage", "sourceId": None}
    up = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": TEXT + " and bouldering"}, tool_call_id="c2")
    assert up["success"] is True and up["published"] is True and "publish_refused" not in up
    assert index.tool_calls() == [
        {"name": "update_intent", "arguments": {"description": TEXT + " and bouldering"}}
    ]
    assert [(r["method"], r["path"]) for r in index.requests] == [("PATCH", f"/api/intents/{INDEX_ID}")]
    index.requests.clear()
    index.tool = {"success": True}
    out = call(tctx, {"action": "withdraw", "intention_id": INDEX_ID}, tool_call_id="c3")
    assert out["success"] is True and "publish_refused" not in out
    # DATA-249: archive is its own route, with no body; no `status` anywhere.
    assert index.tool_calls() == [{"name": "archive_intent", "arguments": None}]
    assert [(r["method"], r["path"], r["raw"]) for r in index.requests] == [("PATCH", f"/api/intents/{INDEX_ID}/archive", None)]
    events = intention_events(av, plugin)
    assert [e["event_type"] for e in events] == ["intention.captured", "intention.updated", "intention.withdrawn"]
    assert {e["intention_id"] for e in events} == {INDEX_ID}
    # The source stored at capture, not the restrictive default for a call that names none.
    assert [e["payload"]["source"] for e in events] == ["message", "message", "message"]
    assert events[1]["payload"]["index_intent_id"] == INDEX_ID


def test_update_mirror_failure_is_recorded_locally(tctx, index, av, plugin):
    call(tctx, {"text": TEXT, "source": "message"})
    index.tool = http_error(409)
    out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": TEXT + "!"}, tool_call_id="c2")
    assert out["success"] is True and out["publish_refused"] == "http_409"
    assert "Index was not updated" in out["message"]
    assert intention_events(av, plugin)[-1]["payload"]["publish_refused"] == "http_409"
    # B1: a 500 on an edit may have landed: unknown, never "not updated".
    index.tool = http_error(500)
    out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": TEXT + "!!"}, tool_call_id="c3")
    assert out["publish_refused"] == "timeout" and "unknown" in out["message"] and "not updated" not in out["message"]


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
    # R9 revised: the normalised text's hash, and only for the held ambient entry.
    norm = hashlib.sha256(" ".join(TEXT.split()).casefold().encode()).hexdigest()
    held = [v for v in entries.values() if v["source"] == "ambient"]
    assert held == [{"published": False, "source": "ambient", "held_norm_hash": norm}]
    assert len(data["publishes"]) == 1  # one create_intent attempt, a timestamp only
    assert stat.S_IMODE(os.stat(str(path) + ".lock").st_mode) == 0o600


def test_map_is_bounded(ri, index, on, monkeypatch):
    monkeypatch.setattr(ri, "MAX_MAP_ENTRIES", 3)
    for i in range(5):
        ri.remember(f"id-{i}", published=False, source="ambient")
    assert list(ri._load_map()) == ["id-2", "id-3", "id-4"]


def test_an_unsavable_map_still_publishes_and_logs_the_count_failure_once(tctx, index, ri, monkeypatch, caplog):
    """L2: the count was read, only the save failed, so the attempt proceeds."""
    def fail(*_args):  # noqa: ANN002
        raise PermissionError("ro")

    monkeypatch.setattr(ri, "_save_locked", fail)
    out = call(tctx, {"text": TEXT, "source": "message"})
    index.tool = created(SECOND_ID)
    out2 = call(tctx, {"text": TEXT + " 2", "source": "message"}, tool_call_id="c2")
    assert out["published"] is True and out2["published"] is True
    assert "map_write_failed=PermissionError" in caplog.text
    assert caplog.text.count("rate_count_failed=PermissionError") == 1


def test_an_unreadable_count_fails_closed(tctx, index, ri, monkeypatch):
    def unreadable():
        raise ri.MapUnreadable()

    monkeypatch.setattr(ri, "_load_locked", unreadable)
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == "rate_unavailable" and index.requests == []


def test_logs_carry_codes_never_text_or_key(tctx, index, caplog):
    with caplog.at_level(logging.DEBUG, logger="av-events"):
        call(tctx, {"text": TEXT, "source": "message"})
        index.tool = refused()
        call(tctx, {"text": TEXT, "source": "message"}, tool_call_id="c2")
        call(tctx, {"text": TEXT, "source": "message", "publish": False}, tool_call_id="c3")
    lines = [r.getMessage() for r in caplog.records if "record_intention" in r.getMessage()]
    assert "av-events: record_intention action=capture source=message held=- published=1 refused=- reason=-" in lines
    assert "av-events: record_intention action=capture source=message held=- published=0 refused=rejected reason=-" in lines
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


# --------------------------------------------------------------------------
# Refutation round 1
# --------------------------------------------------------------------------

CRON = "cron_job1_20260928_010000"
CHILD = "20260928_010001_abcd"


def _delegate(ctx: ToolFireCtx, parent: str, child: str) -> None:
    ctx.fire(
        "subagent_start",
        parent_session_id=parent,
        parent_turn_id="t",
        child_session_id=child,
        child_role="leaf",
        child_goal="g",
    )


def _run(ctx: ToolFireCtx, args: dict, session: str) -> dict:
    return json.loads(ctx.tools["record_intention"]["handler"](args, session_id=session))


# F3: the cron gate is the tool's own and fails closed.


def test_f3_cron_subagent_with_telemetry_disabled(plugin, index, on, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "t")
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="nightly", model="m", platform="cron")
    _delegate(ctx, "nightly", CHILD)
    out = _run(ctx, {"text": TEXT, "source": "message"}, CHILD)
    assert index.tool_calls() == [] and out["source"] == "ambient"


def test_f3_cron_subagent_with_the_telemetry_subagent_hook_disabled(plugin, index, on, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "t")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "subagent_start")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="nightly", model="m", platform="cron")
    _delegate(ctx, "nightly", CHILD)
    out = _run(ctx, {"text": TEXT, "source": "message"}, CHILD)
    assert index.tool_calls() == [] and out["source"] == "ambient"


def test_f3_cron_subagent_after_unload(plugin, index, on, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "t")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="nightly", model="m", platform="cron")
    _delegate(ctx, "nightly", "child-1")
    plugin._on_unload()
    out = _run(ctx, {"text": TEXT, "source": "message"}, "child-1")
    assert index.tool_calls() == [] and out["source"] == "ambient"


def test_f3_cron_subagent_of_a_degraded_parent(tctx, index, plugin):
    tctx.fire("on_session_start", session_id="nightly", model="m", platform="cron")
    state = plugin._COLLECTOR.peek_session("nightly")
    state.degraded = True
    _delegate(tctx, "nightly", CHILD)
    out = _run(tctx, {"text": TEXT, "source": "message"}, CHILD)
    assert index.tool_calls() == [] and out["source"] == "ambient"


def test_f3_a_session_never_seen_is_held(tctx, index):
    out = _run(tctx, {"text": TEXT, "source": "message"}, "never-started")
    assert index.tool_calls() == [] and out["source"] == "ambient" and out["held"] is True


def test_f3_a_subagent_with_unknown_ancestry_is_held(tctx, index):
    tctx.fire("pre_api_request", session_id=CHILD, platform="subagent", task_id="t", turn_id="u")
    out = _run(tctx, {"text": TEXT, "source": "message"}, CHILD)
    assert index.tool_calls() == [] and out["source"] == "ambient"


def test_f3_a_subagent_of_a_chat_session_publishes(tctx, index):
    tctx.fire("pre_api_request", session_id=CHILD, platform="subagent", task_id="t", turn_id="u")
    _delegate(tctx, SESSION, CHILD)
    out = _run(tctx, {"text": TEXT, "source": "message"}, CHILD)
    assert out["published"] is True and [c["name"] for c in index.tool_calls()] == ["create_intent"]


def test_f3_platform_from_pre_api_request_alone(plugin, index, on):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("pre_api_request", session_id="s-api", platform="telegram", task_id="t", turn_id="u")
    assert _run(ctx, {"text": TEXT, "source": "message"}, "s-api")["published"] is True


def test_f3_cron_stays_cron(ri, plugin, on):
    ri.note_platform("s", "cron")
    ri.note_platform("s", "telegram")
    assert ri.held_reason("s") == "cron"


def test_f3_lineage_listeners_are_registered_with_the_tool(plugin, ri, index, on):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    for name, listener in ri.LINEAGE_HOOKS.items():
        assert listener in ctx.hooks[name]


# F4: a cron session never rewrites a live Index intent.


def test_f4_cron_update_and_withdraw_of_a_published_id_are_held(tctx, index, av, plugin):
    pub = call(tctx, {"text": TEXT, "source": "message"})
    tctx.fire("on_session_start", session_id="cron_memsync_20260929_030000", model="m", platform="cron")
    out = call(
        tctx,
        {"action": "update", "intention_id": pub["intention_id"], "text": "Inferred: wants a fintech cofounder"},
        session="cron_memsync_20260929_030000",
        tool_call_id="c2",
    )
    assert [c["name"] for c in index.tool_calls()] == ["create_intent"]
    assert out["publish_refused"] == "held_cron" and out["source"] == "ambient"
    event = intention_events(av, plugin)[-1]
    assert event["event_type"] == "intention.updated"
    assert event["payload"]["publish_refused"] == "held_cron"
    assert event["payload"]["source"] == out["source"]
    # B2: a withdrawal of a published intention from a held session is refused:
    # no archive on Index, no event.
    before = len(intention_events(av, plugin))
    gone = call(tctx, {"action": "withdraw", "intention_id": pub["intention_id"]},
                session="cron_memsync_20260929_030000", tool_call_id="c3")
    assert gone["success"] is False and gone["error"] == "held_cron"
    assert [c["name"] for c in index.tool_calls()] == ["create_intent"]
    assert len(intention_events(av, plugin)) == before


# F5: the map is locked across processes and survives corruption.


RACE = """
import importlib.util, sys, types
P = sys.argv[1]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
spec = importlib.util.spec_from_file_location("hermes_plugins.av_events", P + "/__init__.py", submodule_search_locations=[P])
m = importlib.util.module_from_spec(spec); sys.modules["hermes_plugins.av_events"] = m; spec.loader.exec_module(m)
ri = sys.modules["hermes_plugins.av_events._record_intention"]
for i in range(150):
    ri.remember(f"{sys.argv[2]}-{i}", published=True, source="message")
"""


def test_f5_two_processes_keep_every_entry(ri, home, av):
    import subprocess

    env_vars = {**os.environ, "HERMES_HOME": str(home)}
    procs = [
        subprocess.Popen([sys.executable, "-c", RACE, str(av.PLUGIN_DIR), tag], env=env_vars)
        for tag in ("a", "b")
    ]
    assert [p.wait(timeout=120) for p in procs] == [0, 0]
    entries = ri._load_map()
    assert {f"{t}-{i}" for t in "ab" for i in range(150)} <= set(entries)


def test_f5_a_corrupt_map_is_set_aside(tctx, index, ri, caplog):
    first = call(tctx, {"text": TEXT, "source": "message"})
    path = Path(ri.map_path())
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("garbage")
    index.tool = created(SECOND_ID)
    call(tctx, {"text": TEXT + " 2", "source": "message"}, tool_call_id="c2")
    aside = Path(str(path) + ".corrupt-1")
    assert aside.exists() and first["intention_id"] in aside.read_text(encoding="utf-8")
    assert "av-events: record_intention map_corrupt=1" in caplog.text
    assert set(json.loads(path.read_text(encoding="utf-8"))["intentions"]) == {SECOND_ID}
    path.write_text("[]", encoding="utf-8")
    ri.lookup("x")
    assert Path(str(path) + ".corrupt-2").exists()


@pytest.mark.parametrize("action", ["update", "withdraw"])
def test_f5_unknown_id_mirrors_nothing_and_claims_nothing(tctx, index, av, plugin, action):
    args: dict[str, Any] = {"action": action, "intention_id": "int-from-elsewhere"}
    if action == "update":
        args["text"] = TEXT
    out = call(tctx, args)
    assert index.requests == []
    assert out["publish_refused"] == "unknown_id" and out["source"] == "ambient"
    assert "may still be there" in out["message"]
    payload = intention_events(av, plugin)[0]["payload"]
    assert payload["publish_refused"] == "unknown_id" and payload["source"] == "ambient"
    assert payload["index_intent_id"] is None


# F6: the result's index_intent_id decides, null included.


def test_f6_model_index_id_never_reaches_a_held_capture(tctx, index, av, plugin):
    call(tctx, {"text": TEXT, "source": "ambient", "index_intent_id": "fake-idx-1"})
    assert intention_events(av, plugin)[0]["payload"]["index_intent_id"] is None


def test_f6_model_index_id_never_reaches_a_personal_capture(tctx, index, av, plugin):
    call(tctx, {"text": TEXT, "source": "message", "publish": False, "reason": "personal", "index_intent_id": "fake-idx-2"})
    assert intention_events(av, plugin)[0]["payload"]["index_intent_id"] is None


def test_f6_argument_counts_when_the_result_is_silent(plugin, av):
    it = sys.modules[f"{av.MODULE_NAME}._intentions"]
    calls = it.plan("record_intention", {"action": "capture", "text": TEXT, "index_intent_id": "idx-9"},
                    json.dumps({"intention_id": "local-1"}), "ok")
    assert calls[0].index_intent_id == "idx-9"
    calls = it.plan("record_intention", {"action": "capture", "text": TEXT, "index_intent_id": "idx-9"},
                    json.dumps({"intention_id": "local-1", "index_intent_id": None}), "ok")
    assert calls[0].index_intent_id is None


# F7: an unknown id is ambient whatever source the call claims.


def test_f7_unknown_id_update_with_source_message_is_ambient(tctx, index, av, plugin):
    out = call(tctx, {"action": "update", "intention_id": "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000", "text": "x", "source": "message"})
    assert out["source"] == "ambient"
    assert intention_events(av, plugin)[0]["payload"]["source"] == "ambient"


# M2 (R9 revised): held ambient text is not published around the confirmation.


def test_m2_verbatim_explicit_capture_is_recorded_locally_with_the_code(tctx, index, av, plugin):
    call(tctx, {"text": TEXT, "source": "ambient"})
    out = call(tctx, {"text": TEXT, "source": "message"}, tool_call_id="c2")
    assert out["success"] is True and out["published"] is False
    assert out["publish_refused"] == "held_ambient_exists"
    assert "published only through the resident's confirmation" in out["message"]
    assert index.tool_calls() == []
    events = intention_events(av, plugin)
    assert [e["event_type"] for e in events] == ["intention.captured", "intention.captured"]
    assert events[1]["payload"]["publish_refused"] == "held_ambient_exists"
    assert events[1]["payload"]["source"] == "message"
    assert "held_norm_hash" not in json.dumps(events)


@pytest.mark.parametrize("source", ["onboarding", "note"])
def test_m2_every_explicit_source_is_checked(tctx, index, source):
    call(tctx, {"text": TEXT, "source": "ambient"})
    out = call(tctx, {"text": TEXT, "source": source}, tool_call_id="c2")
    assert out["publish_refused"] == "held_ambient_exists" and index.tool_calls() == []


def test_m2_a_personal_capture_of_the_same_text_is_unaffected(tctx, index):
    call(tctx, {"text": TEXT, "source": "ambient"})
    out = call(tctx, {"text": TEXT, "source": "message", "publish": False, "reason": "personal"}, tool_call_id="c2")
    assert out["success"] is True and out["local_reason"] == "personal"
    assert "publish_refused" not in out


def test_m2_after_a_withdrawal_the_text_publishes(tctx, index):
    held = call(tctx, {"text": TEXT, "source": "ambient"})
    call(tctx, {"action": "withdraw", "intention_id": held["intention_id"]}, tool_call_id="c2")
    out = call(tctx, {"text": TEXT, "source": "message"}, tool_call_id="c3")
    assert out["published"] is True


def test_m2_an_update_refreshes_the_hash(tctx, index):
    held = call(tctx, {"text": "wants a cofounder", "source": "ambient"})
    call(tctx, {"action": "update", "intention_id": held["intention_id"], "text": TEXT}, tool_call_id="c2")
    blocked = call(tctx, {"text": TEXT, "source": "message"}, tool_call_id="c3")
    assert blocked["publish_refused"] == "held_ambient_exists" and index.tool_calls() == []
    freed = call(tctx, {"text": "wants a cofounder", "source": "message"}, tool_call_id="c4")
    assert freed["published"] is True


@pytest.mark.parametrize("variant", [TEXT + " ", TEXT.lower(), TEXT.replace(" ", "  ", 1), TEXT.upper(), "\t" + TEXT])
def test_m2_whitespace_and_case_variants_are_caught(tctx, index, variant):
    call(tctx, {"text": TEXT, "source": "ambient"})
    out = call(tctx, {"text": variant, "source": "message"}, tool_call_id="c2")
    assert out["publish_refused"] == "held_ambient_exists" and index.tool_calls() == []


def test_m2_other_text_still_publishes(tctx, index):
    call(tctx, {"text": TEXT, "source": "ambient"})
    assert call(tctx, {"text": TEXT + " indoors", "source": "message"}, tool_call_id="c2")["published"] is True


# M3: a held explicit capture leaves a trace.


def test_m3_explicit_capture_in_a_cron_session_is_held_cron(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "message"}, session="cron_job_20261012")
    assert out["source"] == "ambient" and out["publish_refused"] == "held_cron"
    payload = intention_events(av, plugin)[0]["payload"]
    assert payload["publish_refused"] == "held_cron" and payload["source"] == "ambient"


def test_m3_explicit_capture_in_an_unknown_session_is_held_unknown(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "onboarding"}, session="never-seen")
    assert out["publish_refused"] == "held_unknown"
    assert intention_events(av, plugin)[0]["payload"]["publish_refused"] == "held_unknown"


def test_m3_ambient_in_a_held_session_carries_no_code(tctx, index):
    out = call(tctx, {"text": TEXT, "source": "ambient"}, session="cron_job_20261012")
    assert "publish_refused" not in out


@pytest.mark.parametrize("session,code", [("cron_job_20261012", "held_cron"), ("never-seen", "held_unknown")])
def test_m3_held_update_of_a_published_id(tctx, index, av, plugin, session, code):
    pub = call(tctx, {"text": TEXT, "source": "message"})
    out = call(tctx, {"action": "update", "intention_id": pub["intention_id"], "text": TEXT + "!"},
               session=session, tool_call_id="c2")
    assert out["publish_refused"] == code
    assert [c["name"] for c in index.tool_calls()] == ["create_intent"]
    assert intention_events(av, plugin)[-1]["payload"]["publish_refused"] == code


# R10: the gate is an allowlist of human-facing platforms.


@pytest.mark.parametrize("platform", ["telegram", "discord", "slack", "whatsapp", "signal", "matrix", "cli", "tui", "desktop", "Telegram"])
def test_r10_human_platforms_publish(plugin, index, on, platform):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s-h", model="m", platform=platform)
    assert _run(ctx, {"text": TEXT, "source": "message"}, "s-h")["published"] is True


@pytest.mark.parametrize("platform", ["api_server", "webhook", "msgraph_webhook", "batch", "acp", "curator", "local",
                                      "homeassistant", "relay", "some_plugin_platform", ""])
def test_r10_other_platforms_are_held_unknown(plugin, index, on, platform):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s-m", model="m", platform=platform)
    out = _run(ctx, {"text": TEXT, "source": "message"}, "s-m")
    assert index.tool_calls() == []
    assert out["source"] == "ambient" and out["publish_refused"] == "held_unknown"


def test_r10_cron_is_held_cron(plugin, index, on):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s-c", model="m", platform="cron")
    assert _run(ctx, {"text": TEXT, "source": "message"}, "s-c")["publish_refused"] == "held_cron"


@pytest.mark.parametrize("root,expected", [("telegram", None), ("cli", None), ("api_server", "held_unknown"), ("cron", "held_cron")])
def test_r10_a_subagent_inherits_its_roots_allowance(plugin, index, on, root, expected):
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="root", model="m", platform=root)
    ctx.fire("on_session_start", session_id="kid", model="m", platform="subagent")
    _delegate(ctx, "root", "kid")
    ctx.fire("on_session_start", session_id="grandkid", model="m", platform="subagent")
    _delegate(ctx, "kid", "grandkid")
    out = _run(ctx, {"text": TEXT, "source": "message"}, "grandkid")
    assert out.get("publish_refused") == expected
    assert out["published"] is (expected is None)


# F13: only the overlay's own result is read for action, source, ids and codes.


def test_f13_an_mcp_record_intention_result_is_not_trusted(tctx, av, plugin):
    result = json.dumps({
        "intention_id": "srv-1", "action": "capture", "source": "message",
        "index_intent_id": "idx-claimed", "publish_refused": "rejected", "local_reason": "personal",
    })
    tctx.fire(
        "post_tool_call", tool_name="mcp__x__record_intention",
        args={"action": "capture", "text": TEXT, "source": "ambient"}, result=result,
        session_id=SESSION, task_id="t", turn_id="u", tool_call_id="c9", api_request_id="r",
        duration_ms=5, status="ok", error_type=None, error_message=None,
    )
    event = intention_events(av, plugin)[0]
    assert event["intention_id"] == "srv-1"
    payload = event["payload"]
    assert payload["index_intent_id"] is None
    assert payload["publish_refused"] is None and payload["local_reason"] is None
    assert payload["source"] == "ambient"


def test_f13_no_action_on_an_mcp_tool_records_nothing(tctx, av, plugin):
    tctx.fire(
        "post_tool_call", tool_name="mcp__x__record_intention",
        args={"text": TEXT, "source": "message"}, result=json.dumps({"intention_id": "srv-2", "action": "capture"}),
        session_id=SESSION, task_id="t", turn_id="u", tool_call_id="c9", api_request_id="r",
        duration_ms=5, status="ok", error_type=None, error_message=None,
    )
    assert intention_events(av, plugin) == []


# Rate cap.


def test_rate_cap_counts_attempts_per_rolling_hour(tctx, index, ri, monkeypatch, av, plugin):
    now = [1_000_000.0]
    monkeypatch.setattr(ri, "_clock", lambda: now[0])
    monkeypatch.setenv("AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR", "2")
    assert call(tctx, {"text": "a one", "source": "message"})["published"] is True
    index.tool = refused()  # a refused attempt still counts
    assert call(tctx, {"text": "a two", "source": "message"}, tool_call_id="c2")["publish_refused"] == "rejected"
    index.tool = created(SECOND_ID)
    third = call(tctx, {"text": "a three", "source": "message"}, tool_call_id="c3")
    assert third["publish_refused"] == "rate_capped" and third["published"] is False
    assert "hourly limit" in third["message"]
    assert len(index.tool_calls()) == 2
    assert intention_events(av, plugin)[-1]["payload"]["publish_refused"] == "rate_capped"
    now[0] += 3601
    assert call(tctx, {"text": "a four", "source": "message"}, tool_call_id="c4")["published"] is True


def test_rate_cap_is_shared_through_the_map(ri, index, on, monkeypatch):
    """Another process's attempts are in the file, so they count here."""
    monkeypatch.setattr(ri, "_clock", lambda: 5_000.0)
    monkeypatch.setenv("AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR", "1")
    Path(ri.map_path()).parent.mkdir(parents=True, exist_ok=True)
    Path(ri.map_path()).write_text(json.dumps({"v": 1, "intentions": {}, "publishes": [4_000.0]}), encoding="utf-8")
    assert ri.reserve_publish() == "rate_capped"


@pytest.mark.parametrize("value,cap", [("", 20), ("x", 20), ("-3", 20), ("0", 0), ("5", 5)])
def test_rate_cap_setting(ri, on, monkeypatch, value, cap):
    monkeypatch.setenv("AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR", value)
    assert ri.rate_cap() == cap


def test_no_key_does_not_spend_the_cap(tctx, index, ri, monkeypatch):
    monkeypatch.setenv("INDEX_API_KEY", "")
    call(tctx, {"text": TEXT, "source": "message"})
    assert ri._load_map() and json.loads(Path(ri.map_path()).read_text())["publishes"] == []


# B4: no success result looks like a failure to Hermes.


@pytest.mark.parametrize("answer", ["ok", "server_error"])
def test_success_results_never_trip_the_failure_heuristic(tctx, index, answer):
    if answer == "server_error":
        index.tool = http_error(500, {"error": "Failed to create intent"})
    res = tctx.tools["record_intention"]["handler"]({"text": TEXT, "source": "message"}, session_id=SESSION)
    low = res[:500].lower()
    assert '"error"' not in low and '"failed"' not in low and not res.startswith("Error")


# F8 / F2: one front door in every overlay-owned prompt.


#: Files that mention `create_intent` without telling the agent to call it.
NOT_AN_INSTRUCTION = {
    "skills/index-network/heartbeat.md",  # "Do not call `create_intent` ... here."
}


def test_f8_no_overlay_prompt_calls_create_intent_unconditionally():
    offenders = []
    for root in ("skills", "workspace"):
        for path in (REPO / root).rglob("*.md"):
            rel = path.relative_to(REPO).as_posix()
            if rel.startswith("skills/edge-esmeralda/references/") or rel in NOT_AN_INSTRUCTION:
                continue  # bot-synced reference text, or a prohibition
            text = path.read_text(encoding="utf-8")
            if "create_intent" in text and "if `record_intention` is available" not in text.lower():
                offenders.append(rel)
    assert offenders == []


def test_f2_agents_md_routes_intentions_through_the_tool():
    agents = (REPO / "workspace" / "AGENTS.md").read_text(encoding="utf-8")
    line = next(l for l in agents.splitlines() if "record_intention" in l)
    assert "tool_search" in line and "tool_call" in line
    assert "if" in line.lower()


# M1: the cap holds under concurrency.


class StepClock:
    """A fake clock that advances one second on every read, thread-safe."""

    def __init__(self, start: float = 1_000_000.0) -> None:
        self.now = start
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            self.now += 1.0
            return self.now


def test_m1_threads_never_exceed_the_cap(tctx, index, ri, monkeypatch):
    monkeypatch.setattr(ri, "_clock", StepClock())
    monkeypatch.setenv("AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR", "5")
    handler = tctx.tools["record_intention"]["handler"]
    outs: list[dict] = []
    lock = threading.Lock()

    def go(i: int) -> None:
        out = json.loads(handler({"text": f"{TEXT} {i}", "source": "message"}, session_id=SESSION))
        with lock:
            outs.append(out)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(30)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    published = sum(1 for o in outs if o.get("published"))
    capped = sum(1 for o in outs if o.get("publish_refused") == "rate_capped")
    assert (published, capped) == (5, 25)
    assert len(index.tool_calls()) == 5


def test_m1_a_future_stamp_from_another_writer_is_kept(ri, index, on, monkeypatch):
    monkeypatch.setattr(ri, "_clock", lambda: 10_000.0)
    monkeypatch.setenv("AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR", "2")
    path = Path(ri.map_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    # One stale stamp (dropped), one ahead of this writer's clock (kept).
    path.write_text(json.dumps({"v": 1, "intentions": {}, "publishes": [5_000.0, 10_050.0]}), encoding="utf-8")
    assert ri.reserve_publish() is None
    assert sorted(json.loads(path.read_text())["publishes"]) == [10_000.0, 10_050.0]
    assert ri.reserve_publish() == "rate_capped"


RATE_RACE = """
import importlib.util, itertools, os, sys, types
P = sys.argv[1]
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
spec = importlib.util.spec_from_file_location("hermes_plugins.av_events", P + "/__init__.py", submodule_search_locations=[P])
m = importlib.util.module_from_spec(spec); sys.modules["hermes_plugins.av_events"] = m; spec.loader.exec_module(m)
ri = sys.modules["hermes_plugins.av_events._record_intention"]
# A fake clock per process, the two slightly apart: no wall clock.
tick = itertools.count()
ri._clock = lambda: 1_000_000.0 + float(sys.argv[2]) + next(tick) * 0.001
os.environ["AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR"] = "50"
print(sum(1 for _ in range(100) if ri.reserve_publish() is None))
"""


def test_m1_two_processes_never_exceed_the_cap(ri, home, av):
    import subprocess

    env_vars = {**os.environ, "HERMES_HOME": str(home)}
    procs = [
        subprocess.Popen([sys.executable, "-c", RATE_RACE, str(av.PLUGIN_DIR), offset],
                         env=env_vars, stdout=subprocess.PIPE, text=True)
        for offset in ("0", "0.5")
    ]
    counts = [int(p.communicate(timeout=120)[0].strip()) for p in procs]
    assert [p.returncode for p in procs] == [0, 0]
    assert sum(counts) == 50
    assert len(json.loads(Path(ri.map_path()).read_text())["publishes"]) == 50


# Data-half follow-up.


def test_capture_path_for_the_bare_and_a_prefixed_record_intention(tctx, index, av, plugin):
    """The bare overlay tool is `record_intention`. A prefixed one keeps the
    pre-DATA-212 value, which at b630d4c was also `record_intention`: before
    this task `plan_record` stamped that path for any server prefix."""
    call(tctx, {"text": TEXT, "source": "message"})
    tctx.fire(
        "post_tool_call", tool_name="mcp__x__record_intention",
        args={"action": "capture", "text": TEXT, "source": "message"}, result=json.dumps({"intention_id": "srv-1"}),
        session_id=SESSION, task_id="t", turn_id="u", tool_call_id="c9", api_request_id="r",
        duration_ms=5, status="ok", error_type=None, error_message=None,
    )
    events = intention_events(av, plugin)
    assert [e["payload"]["capture_path"] for e in events] == ["record_intention", "record_intention"]


def test_update_of_a_rejected_capture_is_refused_capture_again(tctx, index, ri, av, plugin):
    index.tool = refused()
    rejected = call(tctx, {"text": "something", "source": "message"})
    assert rejected["publish_refused"] == "rejected"
    assert ri.lookup(rejected["intention_id"]) == {"published": False, "source": "message", "refused": "rejected"}
    index.requests.clear()
    index.tool = created()
    out = call(tctx, {"action": "update", "intention_id": rejected["intention_id"], "text": TEXT}, tool_call_id="c2")
    assert out["success"] is False and out["error"] == "capture_again"
    assert "Capture the clarified text as a new intention" in out["message"]
    assert index.requests == []
    assert [e["event_type"] for e in intention_events(av, plugin)] == ["intention.captured"]
    # The clarified text is captured anew and publishes; the rejected one can still be withdrawn.
    assert call(tctx, {"text": TEXT, "source": "message"}, tool_call_id="c3")["published"] is True
    gone = call(tctx, {"action": "withdraw", "intention_id": rejected["intention_id"]}, tool_call_id="c4")
    assert gone["success"] is True and gone["published"] is False


@pytest.mark.parametrize("code_answer", [http_error(503), {"success": True}])
def test_only_rejected_is_labelled_in_the_map(tctx, index, ri, code_answer):
    index.tool = code_answer
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] != "rejected"
    assert "refused" not in ri.lookup(out["intention_id"])
    upd = call(tctx, {"action": "update", "intention_id": out["intention_id"], "text": TEXT + "!"}, tool_call_id="c2")
    assert upd["success"] is True



# --------------------------------------------------------------------------
# Refutation fix round (DATA-249)
# --------------------------------------------------------------------------

from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402


class _IndexServer:
    """A real HTTP server on loopback, for the failures only real sockets show."""

    def __init__(self) -> None:
        self.mode: Any = (200, {"intentId": INDEX_ID})
        self.requests: list[tuple[str, str]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _any(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                outer.requests.append((self.command, self.path))
                mode = outer.mode
                if mode == "close":
                    # The request arrived; the socket closes with no answer.
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                if mode == "cut":
                    # A 2xx whose body is cut short.
                    self.send_response(200)
                    self.send_header("Content-Length", "500")
                    self.end_headers()
                    self.wfile.write(b'{"intentId": "')
                    self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                status, payload = mode
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_POST = do_PATCH = _any

            def log_message(self, *args: Any) -> None:
                return None

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def real_index(plugin, on, monkeypatch):
    """The plugin registered with the real opener, writing to a loopback Index."""
    server = _IndexServer()
    monkeypatch.setenv("INDEX_API_URL", f"http://127.0.0.1:{server.port}")
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    yield ctx, server
    server.close()


@pytest.mark.parametrize(
    "mode",
    ["close", "cut", (500, {"error": "Failed to create intent"}), (502, {}), (504, {}), (200, {"intentId": "x:y"})],
    ids=["closed-after-request", "truncated-2xx", "500", "502", "504", "2xx-bad-id"],
)
def test_b1_an_ambiguous_failure_is_timeout_and_a_local_capture(real_index, av, plugin, mode):
    """B1: Index may have written, so the code is `timeout` (the one the data side
    reconciles against a later Index capture), never a definite non-publish."""
    ctx, server = real_index
    server.mode = mode
    out = call(ctx, {"text": TEXT, "source": "message"})
    assert server.requests == [("POST", "/api/intents")]
    assert out["success"] is True and out["published"] is False
    assert out["publish_refused"] == "timeout"
    assert "unknown" in out["message"] and "could not take it" not in out["message"]
    [event] = intention_events(av, plugin)
    assert event["event_type"] == "intention.captured"
    assert event["payload"]["publish_refused"] == "timeout" and event["payload"]["index_intent_id"] is None


@pytest.mark.parametrize("status,code", [(400, "http_400"), (401, "http_401"), (403, "http_403"), (404, "http_404"),
                                         (409, "http_409"), (429, "http_429"), (503, "http_503"), (422, "rejected")])
def test_b1_a_definite_refusal_keeps_its_code(real_index, status, code):
    ctx, server = real_index
    server.mode = (status, {"error": "x"})
    out = call(ctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == code and out["published"] is False


def test_b1_nothing_sent_is_transport(plugin, on, monkeypatch, real_index):
    """A refused connection: nothing reached Index."""
    ctx, server = real_index
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
    monkeypatch.setenv("INDEX_API_URL", f"http://127.0.0.1:{closed_port}")
    out = call(ctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == "transport"


def test_b1_the_real_server_happy_path(real_index, av, plugin):
    ctx, server = real_index
    out = call(ctx, {"text": TEXT, "source": "message"})
    assert out["published"] is True and out["intention_id"] == INDEX_ID


def test_b1_status_code_table(ri):
    assert [ri.status_code(s) for s in (400, 401, 403, 404, 409, 422, 429, 500, 501, 502, 503, 504, 302)] == [
        "http_400", "http_401", "http_403", "http_404", "http_409", "rejected", "http_429",
        "timeout", "timeout", "timeout", "http_503", "timeout", "redirect",
    ]


@pytest.mark.parametrize(
    "session,platform,code",
    [
        ("cron_memsync_20261003_030000", "cron", "held_cron"),
        ("sess-webhook", "webhook", "held_unknown"),
        ("sess-api", "api_server", "held_unknown"),
        ("sess-never-seen", None, "held_unknown"),
    ],
)
def test_b2_a_held_session_cannot_withdraw_a_published_intention(tctx, index, av, plugin, session, platform, code):
    pub = call(tctx, {"text": TEXT, "source": "message"})
    assert pub["published"] is True
    if platform is not None:
        tctx.fire("on_session_start", session_id=session, model="m", platform=platform)
    before = intention_events(av, plugin)
    index.requests.clear()
    out = call(tctx, {"action": "withdraw", "intention_id": pub["intention_id"]}, session=session, tool_call_id="c2")
    assert out["success"] is False and out["error"] == code
    assert "direct chat" in out["message"]
    assert index.requests == []
    assert intention_events(av, plugin) == before


def test_b2_a_held_session_still_withdraws_a_local_intention(tctx, index, av, plugin):
    local = call(tctx, {"text": TEXT, "source": "message", "publish": False, "reason": "personal"})
    tctx.fire("on_session_start", session_id="cron_x_1", model="m", platform="cron")
    out = call(tctx, {"action": "withdraw", "intention_id": local["intention_id"]}, session="cron_x_1", tool_call_id="c2")
    assert out["success"] is True and out["published"] is False
    assert index.requests == []
    assert intention_events(av, plugin)[-1]["event_type"] == "intention.withdrawn"


def test_b2_a_second_withdrawal_does_not_archive_again(tctx, index, av, plugin, ri):
    pub = call(tctx, {"text": TEXT, "source": "message"})
    index.tool = {"success": True}
    first = call(tctx, {"action": "withdraw", "intention_id": pub["intention_id"]}, tool_call_id="c2")
    second = call(tctx, {"action": "withdraw", "intention_id": pub["intention_id"]}, tool_call_id="c3")
    assert [c["name"] for c in index.tool_calls()] == ["create_intent", "archive_intent"]
    assert first["success"] is True and "publish_refused" not in first
    assert second["success"] is True and "already withdrawn on Index" in second["message"]
    assert ri.lookup(pub["intention_id"])["archived"] is True


def test_b2_a_failed_archive_is_not_marked(tctx, index, ri):
    pub = call(tctx, {"text": TEXT, "source": "message"})
    index.tool = http_error(404)
    out = call(tctx, {"action": "withdraw", "intention_id": pub["intention_id"]}, tool_call_id="c2")
    assert out["publish_refused"] == "http_404"
    assert "archived" not in ri.lookup(pub["intention_id"])
    index.tool = {"success": True}
    call(tctx, {"action": "withdraw", "intention_id": pub["intention_id"]}, tool_call_id="c3")
    assert [c["name"] for c in index.tool_calls()] == ["create_intent", "archive_intent", "archive_intent"]


@pytest.mark.parametrize("text", ["climbing \ud800 partner", "\udfff", "ok \ud83d"])
def test_c1_a_lone_surrogate_is_refused_at_the_tool(tctx, index, av, plugin, text):
    out = call(tctx, {"text": text, "source": "message"})
    assert out["success"] is False and out["error"] == "text_invalid"
    pub = call(tctx, {"text": TEXT, "source": "message"}, tool_call_id="c2")
    index.requests.clear()
    upd = call(tctx, {"action": "update", "intention_id": pub["intention_id"], "text": text}, tool_call_id="c3")
    assert upd["success"] is False and upd["error"] == "text_invalid"
    assert index.requests == []
    assert [e["event_type"] for e in intention_events(av, plugin)] == ["intention.captured"]


def test_c1_a_paired_surrogate_is_fine(tctx, index):
    """An emoji outside the BMP is one code point in Python; it is not refused."""
    out = call(tctx, {"text": "climbing partner \U0001f9d7", "source": "message"})
    assert out["published"] is True
