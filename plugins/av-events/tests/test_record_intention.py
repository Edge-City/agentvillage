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
        "action", "text", "summary", "source", "publish", "reason", "intention_id", "confirmed_in_chat",
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
        # A raw socket timeout comes from waiting for the answer: after the send.
        (TimeoutError(), "timeout"),
        # urllib wraps a connect timeout in URLError: nothing was sent.
        (urllib.error.URLError(TimeoutError()), "transport"),
        # A config error found while opening, before the send.
        (http.client.InvalidURL("nonnumeric port"), "url_refused"),
        (ValueError("unknown url type"), "url_refused"),
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


@pytest.mark.parametrize("publish", [None, True])
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
    # DATA-387: and beside it the punctuation-blind v2 hash.
    norm_v2 = hashlib.sha256(" ".join(TEXT.split()).casefold().encode()).hexdigest()  # no punctuation in TEXT
    assert held == [{"published": False, "source": "ambient", "held_norm_hash": norm, "held_norm_hash_v2": norm_v2}]
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


# DATA-387: a held text re-captured with only punctuation, quote, dash, width or
# case differences is held_ambient_exists too (refuter SF6: the draft plus a
# full stop captured as message published at once).

#: A held text with an apostrophe and a dash, so every variant has something to vary.
HELD = "I'd like a climbing partner in Goa - weekends only"


def _fullwidth(text: str) -> str:
    """ASCII to its full-width forms (NFKC maps them back), space to U+3000."""
    return "".join("　" if c == " " else chr(ord(c) + 0xFEE0) if "!" <= c <= "~" else c for c in text)


#: (held text, re-captured text): each pair differs only in punctuation, quotes,
#: dashes, whitespace, case or width.
NEAR_COPIES = [
    pytest.param(HELD, HELD + ".", id="trailing-full-stop"),
    pytest.param(HELD, HELD + "!", id="trailing-bang"),
    pytest.param(HELD, HELD + "?", id="trailing-question"),
    pytest.param(HELD, HELD + "…", id="trailing-ellipsis-char"),
    pytest.param(HELD, HELD + "...", id="trailing-three-dots"),
    pytest.param(HELD, HELD + " .", id="spaced-full-stop"),
    pytest.param(HELD + ".", HELD, id="held-has-the-full-stop"),
    pytest.param(HELD, '"' + HELD + '"', id="straight-double-quotes"),
    pytest.param(HELD, "'" + HELD + "'", id="straight-single-quotes"),
    pytest.param(HELD, "“" + HELD + "”", id="curly-double-quotes"),
    pytest.param(HELD, "‘" + HELD + "’", id="curly-single-quotes"),
    pytest.param(HELD, "«" + HELD + "»", id="guillemets"),
    pytest.param(HELD, HELD.replace("'", "’"), id="curly-apostrophe"),
    pytest.param(HELD.replace("'", "’"), HELD, id="held-curly-apostrophe"),
    pytest.param(HELD, HELD.replace("'", "ʼ"), id="modifier-letter-apostrophe"),
    pytest.param(HELD, HELD.replace(" - ", " – "), id="en-dash"),
    pytest.param(HELD, HELD.replace(" - ", " — "), id="em-dash"),
    pytest.param(HELD, HELD.replace(" - ", "—"), id="em-dash-unspaced"),
    pytest.param(HELD, HELD.replace(" - ", ", "), id="comma-for-dash"),
    pytest.param(HELD, HELD.replace(" ", "  ") + " ", id="extra-spaces"),
    pytest.param(HELD, HELD.upper(), id="upper-case"),
    pytest.param(HELD, HELD.lower(), id="lower-case"),
    pytest.param(HELD, _fullwidth(HELD), id="full-width-forms"),
    pytest.param(HELD, HELD + " \U0001f642", id="trailing-emoji"),
    pytest.param(HELD, "“" + HELD.upper().replace("'", "’").replace(" - ", " — ") + ".”",
                 id="all-at-once"),
    pytest.param(TEXT, TEXT + ".", id="unpunctuated-held-plus-stop"),
    # Fix round 1, N2: apostrophes filed as letters or as a spacing accent.
    pytest.param(HELD, HELD.replace("'", "\u00b4"), id="acute-accent-apostrophe"),
    pytest.param(HELD, HELD.replace("'", "\u02b9"), id="modifier-prime-apostrophe"),
    # Fix round 1, N1: invisible format characters and variation selectors.
    pytest.param(HELD, HELD.replace("climbing", "clim\u200bbing"), id="zero-width-space-in-a-word"),
    pytest.param(HELD, HELD.replace("partner", "part\u200dner"), id="zwj-in-a-word"),
    pytest.param(HELD, HELD.replace("partner", "part\u200cner"), id="zwnj-in-a-word"),
    pytest.param(HELD, "\ufeff" + HELD, id="leading-bom"),
    pytest.param(HELD, HELD.replace("weekends", "week\u00adends"), id="soft-hyphen"),
    pytest.param(HELD, HELD.replace("weekends", "week\u2060ends"), id="word-joiner"),
    pytest.param(HELD + " \u2764", HELD + " \u2764\ufe0f", id="vs16-added"),
    pytest.param(HELD, HELD + " \U0001f468\u200d\U0001f4bb", id="zwj-emoji-appended"),
    # Fix round 1, S1: Markdown markup stays punctuation.
    pytest.param(HELD, "> " + HELD, id="markdown-quote"),
    pytest.param(HELD, "# " + HELD, id="markdown-heading"),
    pytest.param(HELD, "## " + HELD + "\n", id="markdown-subheading"),
    pytest.param(HELD, "**" + HELD + "**", id="markdown-bold"),
    pytest.param(HELD, "_" + HELD + "_", id="markdown-italic"),
    pytest.param(HELD, "`" + HELD + "`", id="markdown-code"),
    pytest.param(HELD, "- " + HELD, id="markdown-list-dash"),
    pytest.param(HELD, "\u2022 " + HELD, id="bullet"),
    pytest.param("Rent under $500 in Goa", "\u201cRent under $500 in Goa.\u201d", id="currency-kept-quotes-dropped"),
    pytest.param("Swim when it is -5", "Swim when it is \u22125.", id="minus-sign-forms"),
    pytest.param("Swim when it is -5", "Swim when it is \u20135", id="en-dash-sign"),
    pytest.param("Tea at 5-6 in Goa", "Tea at 5\u20136 in Goa", id="en-dash-range"),
    pytest.param("Need 1/2 kg of coffee", "Need \u00bd kg of coffee", id="vulgar-fraction-is-its-slash-form"),
]


@pytest.mark.parametrize("held,again", NEAR_COPIES)
def test_data387_a_near_copy_of_a_held_text_is_held_ambient_exists(tctx, index, held, again):
    call(tctx, {"text": held, "source": "ambient"})
    out = call(tctx, {"text": again, "source": "message"}, tool_call_id="c2")
    assert out["success"] is True and out["published"] is False
    assert out["publish_refused"] == "held_ambient_exists"
    assert index.tool_calls() == []


@pytest.mark.parametrize("source", ["onboarding", "note"])
def test_data387_every_explicit_source_is_checked_for_a_near_copy(tctx, index, source):
    call(tctx, {"text": HELD, "source": "ambient"})
    out = call(tctx, {"text": "“" + HELD + ".”", "source": source}, tool_call_id="c2")
    assert out["publish_refused"] == "held_ambient_exists" and index.tool_calls() == []


#: (held text, re-captured text) in other scripts: punctuation variants only.
NON_LATIN = [
    pytest.param("東京で週末に一緒に登山する仲間を探しています", "「東京で週末に一緒に登山する仲間を探しています！」",
                 id="japanese-brackets-fullwidth-bang"),
    pytest.param("東京で週末に一緒に登山する仲間を探しています。", "東京で週末に一緒に登山する仲間を探しています",
                 id="japanese-ideographic-full-stop"),
    pytest.param("Ищу партнёра по скалолазанию в Гоа", "«Ищу партнёра по скалолазанию в Гоа».", id="russian"),
    pytest.param("أبحث عن شريك تسلق في غوا", "أبحث عن شريك تسلق في غوا؟", id="arabic-question-mark"),
    pytest.param("गोवा में चढ़ाई का साथी चाहिए", "गोवा में चढ़ाई का साथी चाहिए।", id="devanagari-danda"),
    pytest.param("Ψάχνω συνεργάτη για αναρρίχηση", "ΨΆΧΝΩ ΣΥΝΕΡΓΆΤΗ ΓΙΑ ΑΝΑΡΡΊΧΗΣΗ;", id="greek-case-and-question"),
]


@pytest.mark.parametrize("held,again", NON_LATIN)
def test_data387_non_latin_punctuation_variants_are_held(tctx, index, held, again):
    call(tctx, {"text": held, "source": "ambient"})
    out = call(tctx, {"text": again, "source": "message"}, tool_call_id="c2")
    assert out["publish_refused"] == "held_ambient_exists" and index.tool_calls() == []


#: (held text, re-captured text): a real change of words, digits or letters.
#: Nothing fuzzier than punctuation is matched; these are the resident's own words.
REWORDINGS = [
    pytest.param(HELD, HELD.replace("climbing", "surfing"), id="one-word-changed"),
    pytest.param(HELD, HELD + " please", id="one-word-added"),
    pytest.param(HELD, HELD.replace("climbing ", ""), id="one-word-dropped"),
    pytest.param(HELD, HELD.replace("climbing", "climbin"), id="one-letter-dropped"),
    pytest.param("Need 1.5 kg of coffee beans", "Need 15 kg of coffee beans", id="digits-kept-apart"),
    pytest.param("Looking for a cafe to work from", "Looking for a café to work from", id="accent-is-a-letter"),
    pytest.param("東京で週末に一緒に登山する仲間を探しています", "大阪で週末に一緒に登山する仲間を探しています",
                 id="japanese-one-word-changed"),
    pytest.param("Ищу партнёра по скалолазанию в Гоа", "Ищу партнёра по скалолазанию в Пуне", id="russian-one-word"),
    # Fix round 1, S1: a one-symbol correction is the resident's own words.
    pytest.param("Looking for a C++ developer in Goa", "Looking for a C# developer in Goa", id="cpp-vs-csharp"),
    pytest.param("Looking for a C++ developer in Goa", "Looking for a C developer in Goa", id="cpp-vs-c"),
    pytest.param("Looking for a C# developer in Goa", "Looking for a C developer in Goa", id="csharp-vs-c"),
    pytest.param("Rent under $500 in Goa", "Rent under \u20ac500 in Goa", id="dollar-vs-euro"),
    pytest.param("Rent under $500 in Goa", "Rent under \u20b9500 in Goa", id="dollar-vs-rupee"),
    pytest.param("Want 100% remote work", "Want 100 remote work", id="percent-dropped"),
    pytest.param("Meet @alice in Goa", "Meet alice in Goa", id="at-dropped"),
    pytest.param("Swim when it is +5", "Swim when it is -5", id="plus-vs-minus"),
    pytest.param("Swim when it is 5", "Swim when it is -5", id="sign-added"),
    pytest.param("Flats < 500 in Goa", "Flats > 500 in Goa", id="less-vs-greater"),
    pytest.param("Need \u00bd kg of coffee", "Need 1.2 kg of coffee", id="half-vs-one-point-two"),
    pytest.param("Need 1/2 kg of coffee", "Need 1.2 kg of coffee", id="slash-vs-point-in-a-number"),
    pytest.param("Tea & cake in Goa", "Tea cake in Goa", id="ampersand-dropped"),
    pytest.param("Price = 500 in Goa", "Price 500 in Goa", id="equals-dropped"),
]


#: Documented misses (fix round 1, N2): near-copies left to publish rather than
#: add fuzzy rules. Each would need a rule that also merges real differences.
DOCUMENTED_MISSES = [
    pytest.param("Rent under $1,000 in Goa", "Rent under $1000 in Goa", id="thousands-separator"),
    pytest.param("Tea at 5pm in Goa", "Tea at 5 pm in Goa", id="5pm-vs-5-pm"),
    pytest.param(HELD, HELD.replace("I'd", "Id"), id="apostrophe-dropped"),
    pytest.param(HELD, "1. " + HELD, id="numbered-list-marker"),
    pytest.param("\u0130zmir trip with friends", "Izmir trip with friends", id="turkish-dotted-capital-i"),
    pytest.param("Tea in Goa - 5pm", "Tea in Goa -5pm", id="spaced-dash-vs-sign"),
    pytest.param("Need 1/2 kg of coffee", "Need 1 / 2 kg of coffee", id="spaced-slash-in-a-number"),
]


@pytest.mark.parametrize("held,again", DOCUMENTED_MISSES)
def test_data387_documented_misses_publish(tctx, index, held, again):
    call(tctx, {"text": held, "source": "ambient"})
    out = call(tctx, {"text": again, "source": "message"}, tool_call_id="c2")
    assert out["published"] is True and "publish_refused" not in out


@pytest.mark.parametrize("held,again", REWORDINGS)
def test_data387_a_rewording_publishes(tctx, index, held, again):
    call(tctx, {"text": held, "source": "ambient"})
    out = call(tctx, {"text": again, "source": "message"}, tool_call_id="c2")
    assert out["published"] is True and "publish_refused" not in out
    assert [c["name"] for c in index.tool_calls()] == ["create_intent"]


@pytest.mark.parametrize("raw,norm", [
    ("“I’d like tea — at 5…”", "i d like tea at 5"),
    ("I'd like tea - at 5.", "i d like tea at 5"),
    ("Ｔｅａ　！", "tea"),
    ("ﬁne  tea\t", "fine tea"),
    ("Need 1.5 kg", "need 1 5 kg"),
    ("café", "café"),
    ("café", "café"),
    ("STRASSE straße", "strasse strasse"),
    ("price: $5 + 10%", "price $5 + 10 %"),
    ("\U0001f642", ""),
    ("Looking for a C++ dev", "looking for a c + + dev"),
    ("C# dev", "c # dev"),
    ("Rent under \u20ac500.", "rent under \u20ac500"),
    ("Meet @alice & bob", "meet @alice & bob"),
    ("It is \u22125, not +5 or 5-6", "it is -5 not +5 or 5 6"),
    ("covid-19", "covid 19"),
    ("flats < 500 > 100 = ok ~ ^ |", "flats < 500 > 100 = ok ~ ^ |"),
    ("Need \u00bd kg, 1/2 kg, and/or 1.2", "need 1/2 kg 1/2 kg and or 1 2"),
    ("> # Meet *founders*", "meet founders"),
    ("#1 priority, >5 flats", "#1 priority >5 flats"),
    ("I\u00b4d I\u02b9d I\u02bcd I\u2019d", "i d i d i d i d"),
    ("clim\u200bbing\u00ad \ufeffgoa\u2060 \u2764\ufe0f", "climbing goa"),
    ("\u2764\ufe0f", ""),
    # Fix round 2: NFKC after casefold recomposes (one NFKC leaves these decomposed).
    ("\u01f0 \u0390", "\u01f0 \u0390"),
    # Fix round 2: NFKC makes U+02BC of U+0149 and U+02B9 of U+0374; both are apostrophes.
    ("\u0149 x\u0374y", "n x y"),
    ("e\u200b\u0301", "\u00e9"),
    ("-5 \u20135 \u22125 5\u20136 5-6", "-5 -5 -5 5 6 5 6"),
])
def test_data387_the_v2_normal_form(ri, raw, norm):
    assert ri.held_norm_text_v2(raw) == norm
    assert ri.held_norm_text_v2(norm) == norm  # idempotent


#: A mixed alphabet for the idempotence property: letters that NFKC or casefold
#: expand or compose, combining marks, invisible characters, apostrophe forms,
#: signs, slashes, kept symbols, Markdown, emoji, CJK, whitespace.
_IDEMPOTENCE_ALPHABET = (
    "aAeEiIjJnN05 \t\n.,'\"-/#>+$%@"
    "\u0301\u0308\u030c\u0342\u0345"
    "\u200b\u200c\u200d\ufeff\u00ad\u2060\ufe0f"
    "\u0149\u0374\u00b4\u02b9\u02bc\u2019"
    "\u2212\u2013\u2014\u2044\u00bd\ufb01\uff34\uff10\u3000"
    "\u0130\u00df\u01f0\u0390\u03c2\u1e9e\u2126\u212b"
    "\u20ac\u20b9\U0001f642\U0001f468\u6771\u3002\u300c"
)


def test_data387_the_v2_normal_form_is_idempotent_over_a_random_sample(ri):
    """Fix round 2 (recheck N-R1): normalise(normalise(x)) == normalise(x), so
    a stored v1 equal to a capture's v2 is that text's own v2 (`_held_match`)."""
    import random

    rng = random.Random(387)
    misses = []
    for _ in range(20_000):
        raw = "".join(rng.choice(_IDEMPOTENCE_ALPHABET) for _ in range(rng.randint(0, 12)))
        once = ri.held_norm_text_v2(raw)
        if ri.held_norm_text_v2(once) != once:
            misses.append(raw)
    assert misses == []


def test_data387_two_emoji_only_texts_with_vs16_do_not_match(tctx, index, ri):
    """N1: a variation selector is deleted, not kept as the whole normal form."""
    assert ri.held_norm_hash_v2("\u2764\ufe0f") is None and ri.held_norm_hash_v2("\u263a\ufe0f") is None
    call(tctx, {"text": "\u2764\ufe0f", "source": "ambient"})
    assert call(tctx, {"text": "\u263a\ufe0f", "source": "message"}, tool_call_id="c2")["published"] is True


def test_data387_text_with_nothing_but_symbols_gets_no_v2_hash(tctx, index, ri):
    """Two emoji-only texts are not the same want: no v2, v1 alone decides."""
    assert ri.held_norm_hash_v2("\U0001f642!") is None
    held = call(tctx, {"text": "\U0001f642", "source": "ambient"})
    assert ri.HELD_HASH_V2_KEY not in ri._load_map()[held["intention_id"]]
    assert call(tctx, {"text": "\U0001f375", "source": "message"}, tool_call_id="c2")["published"] is True
    again = call(tctx, {"text": " \U0001f642 ", "source": "message"}, tool_call_id="c3")
    assert again["publish_refused"] == "held_ambient_exists"


def test_data387_the_held_entry_carries_both_hashes(tctx, index, ri):
    held = call(tctx, {"text": HELD, "source": "ambient"})
    stored = ri._load_map()[held["intention_id"]]
    assert stored[ri.HELD_HASH_KEY] == ri.held_norm_hash(HELD)
    assert stored[ri.HELD_HASH_V2_KEY] == ri.held_norm_hash_v2(HELD)
    assert stored[ri.HELD_HASH_KEY] != stored[ri.HELD_HASH_V2_KEY]  # HELD has punctuation
    raw = Path(ri.map_path()).read_text(encoding="utf-8")
    assert "climbing" not in raw and ri.held_norm_text_v2(HELD) not in raw


def _v1_only(ri, intention_id: str, text: str) -> None:
    """A held entry as a release before DATA-387 wrote it: the v1 hash alone."""
    ri.remember(intention_id, published=False, source="ambient", norm_hash=ri.held_norm_hash(text))
    assert ri.HELD_HASH_V2_KEY not in ri._load_map()[intention_id]


V1_ID = "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0387"


@pytest.mark.parametrize("again", ["  " + HELD.upper() + " ", HELD.lower(), HELD.replace(" ", "\t")])
def test_data387_a_v1_only_entry_still_matches_a_case_and_space_variant(tctx, index, ri, again):
    _v1_only(ri, V1_ID, HELD)
    out = call(tctx, {"text": again, "source": "message"})
    assert out["publish_refused"] == "held_ambient_exists" and index.tool_calls() == []


def test_data387_a_v1_only_unpunctuated_entry_matches_the_draft_plus_a_stop(tctx, index, ri):
    """A capture's v2 equal to a stored v1: that v1 has no punctuation left, so it is its own v2."""
    _v1_only(ri, V1_ID, TEXT)
    out = call(tctx, {"text": "“" + TEXT + ".”", "source": "message"})
    assert out["publish_refused"] == "held_ambient_exists" and index.tool_calls() == []


def test_data387_a_v1_only_punctuated_entry_is_not_rehashed(tctx, index, ri):
    """The map keeps no text to rehash: a pre-DATA-387 held text with punctuation
    is matched on case and whitespace only, as before, until it ages out."""
    _v1_only(ri, V1_ID, HELD)
    assert call(tctx, {"text": HELD + ".", "source": "message"})["published"] is True


def test_data387_a_v2_hash_without_its_v1_is_dropped_and_never_matches(tctx, index, ri):
    with ri._Locked():
        entries, publishes = ri._load_locked()
        entries[V1_ID] = {"published": False, "source": "ambient",
                          ri.HELD_HASH_V2_KEY: ri.held_norm_hash_v2(HELD)}
        # The save itself drops a v2 left alone.
        ri._save_locked(entries, publishes)
    assert ri.HELD_HASH_V2_KEY not in ri._load_map()[V1_ID]
    assert ri.held_hash_exists(ri.held_norm_hash(HELD), ri.held_norm_hash_v2(HELD)) is False
    assert ri._held_match({ri.HELD_HASH_V2_KEY: ri.held_norm_hash_v2(HELD)},
                          ri.held_norm_hash(HELD), ri.held_norm_hash_v2(HELD)) is False


def test_data387_the_event_carries_the_code_and_no_text(tctx, index, ri, av, plugin):
    call(tctx, {"text": HELD, "source": "ambient"})
    again = "“" + HELD + ".”"
    out = call(tctx, {"text": again, "source": "message"}, tool_call_id="c2")
    assert out["publish_refused"] == "held_ambient_exists"
    events = intention_events(av, plugin)
    assert [e["event_type"] for e in events] == ["intention.captured", "intention.captured"]
    payload = events[1]["payload"]
    assert payload["publish_refused"] == "held_ambient_exists" and payload["source"] == "message"
    dumped = json.dumps(events, ensure_ascii=False)
    for word in ("climbing", "Goa", "weekends", HELD, again, ri.held_norm_text_v2(HELD)):
        assert word not in dumped
    for leaked in (ri.HELD_HASH_KEY, ri.held_norm_hash(HELD), ri.held_norm_hash_v2(HELD),
                   ri.held_norm_hash(again), ri.held_norm_hash_v2(again)):
        assert leaked not in dumped
    assert "climbing" not in out["message"]


def test_data387_an_update_refreshes_both_hashes_and_a_withdrawal_drops_both(tctx, index, ri):
    held = call(tctx, {"text": "wants a cofounder", "source": "ambient"})
    iid = held["intention_id"]
    call(tctx, {"action": "update", "intention_id": iid, "text": HELD}, tool_call_id="c2")
    stored = ri._load_map()[iid]
    assert stored[ri.HELD_HASH_KEY] == ri.held_norm_hash(HELD)
    assert stored[ri.HELD_HASH_V2_KEY] == ri.held_norm_hash_v2(HELD)
    blocked = call(tctx, {"text": HELD + "!", "source": "message"}, tool_call_id="c3")
    assert blocked["publish_refused"] == "held_ambient_exists" and index.tool_calls() == []
    assert call(tctx, {"text": "Wants a cofounder.", "source": "message"}, tool_call_id="c4")["published"] is True
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c5")
    stored = ri._load_map()[iid]
    assert ri.HELD_HASH_KEY not in stored and ri.HELD_HASH_V2_KEY not in stored
    assert call(tctx, {"text": HELD + ".", "source": "message"}, tool_call_id="c6")["published"] is True


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
NOT_AN_INSTRUCTION: set[str] = {
    # The tools map is a routing table the daemon reads, not a prompt.
    "skills/approval/templates/APPROVAL.md",
    # The skill's README describes that routing table for humans; SKILL.md is the prompt.
    "skills/approval/README.md",
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



# --------------------------------------------------------------------------
# Recheck: a config error never hides behind `timeout`; the held-withdraw wording
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://exa\x01mple.invalid",
        "https://exa mple.invalid",
        "https://ex ample.invalid:443",
        "https://exa\tmple.invalid",
        "https://exa\nmple.invalid",
        "https://exa\x7fmple.invalid",
        "https://exa_mple.invalid",
        "https://exa%41mple.invalid",
        "https://[not-an-ip]",
    ],
)
def test_a_hostname_outside_the_dns_alphabet_is_url_refused(tctx, index, monkeypatch, ri, url):
    monkeypatch.setenv("INDEX_API_URL", url)
    assert ri.url_allowed(url) is False
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == "url_refused"
    assert index.requests == []


@pytest.mark.parametrize("url", ["https://[::1]", "http://[::1]:3001", "https://10.0.0.7:8443", "https://protocol.index.network"])
def test_ipv6_ipv4_and_dns_hosts_are_accepted(ri, url):
    assert ri.url_allowed(url) is True


def test_a_blackholed_connect_is_transport_and_logged_as_unreachable(ri, on, monkeypatch, caplog):
    """Nothing was sent: `transport`, with a log line an operator can act on.
    10.255.255.1 is not routed; a network that answers at once with
    unreachable gives the same code."""
    monkeypatch.setenv("INDEX_API_URL", "https://10.255.255.1")
    with caplog.at_level(logging.WARNING, logger="av-events"):
        payload, code = ri.index_request("POST", ri.CREATE_PATH, {"description": TEXT, "sourceType": "agentvillage"},
                                         timeout=0.3, deadline=10.0)
    assert (payload, code) == (None, "transport")
    assert "index_unreachable=" in caplog.text
    assert KEY not in caplog.text and TEXT not in caplog.text


def test_a_connect_timeout_is_logged_as_connect_timeout(tctx, index, caplog):
    index.tool = urllib.error.URLError(TimeoutError())
    with caplog.at_level(logging.WARNING, logger="av-events"):
        out = call(tctx, {"text": TEXT, "source": "message"})
    assert out["publish_refused"] == "transport"
    assert "index_unreachable=connect_timeout" in caplog.text


def test_the_deadline_logs_how_far_the_worker_got(ri, index, on, monkeypatch, caplog):
    """When the deadline passes first, whether the request was sent is unknown: the
    metric gets `timeout` (the safe direction), the log says the phase."""
    index.gate = threading.Event()
    monkeypatch.setattr(ri, "_join", lambda worker, deadline: None)
    try:
        with caplog.at_level(logging.WARNING, logger="av-events"):
            got = ri.index_request("POST", ri.CREATE_PATH, {"description": TEXT, "sourceType": "agentvillage"})
    finally:
        index.gate.set()
    assert got == (None, "timeout")
    assert "index_deadline=opening" in caplog.text


def test_the_socket_timeout_is_below_the_deadline(ri):
    """So a connect that never completes fails inside the worker as `transport`."""
    assert ri.INDEX_TIMEOUT_S < ri.INDEX_DEADLINE_S


@pytest.mark.parametrize("session,platform", [("cron_memsync_20261003_030000", "cron"), ("sess-webhook", "webhook")])
def test_the_held_withdraw_refusal_says_not_to_archive_another_way(tctx, index, session, platform):
    pub = call(tctx, {"text": TEXT, "source": "message"})
    tctx.fire("on_session_start", session_id=session, model="m", platform=platform)
    out = call(tctx, {"action": "withdraw", "intention_id": pub["intention_id"]}, session=session, tool_call_id="c2")
    assert out["success"] is False
    assert "Do not archive or withdraw it another way" in out["message"]
    assert "archive_intent" in out["message"]


# --------------------------------------------------------------------------
# DATA-311: an explicit publish=false is honoured in every lineage and for
# every source (approval off here; the approval path is in
# test_intent_approval.py).
# --------------------------------------------------------------------------

PERSONAL = "my health worry"


@pytest.mark.parametrize("source", ["message", "note", "onboarding", "ambient"])
@pytest.mark.parametrize("session", ["cron_job_1", "never-seen"])
def test_data311_a_personal_capture_in_a_held_session_is_local_not_held(tctx, index, av, plugin, ri, session, source):
    out = call(tctx, {"text": PERSONAL, "source": source, "publish": False, "reason": "personal"}, session=session)
    assert out["success"] is True and out["published"] is False and out["local_reason"] == "personal"
    assert out["source"] == "ambient" and "held" not in out and "publish_refused" not in out
    assert index.requests == []
    assert ri.lookup(out["intention_id"]) == {"published": False, "source": "ambient", "local_reason": "personal"}
    [event] = intention_events(av, plugin)
    payload = event["payload"]
    assert event["event_type"] == "intention.captured"
    assert payload["local_reason"] == "personal" and payload["publish_refused"] is None
    assert payload["source"] == "ambient" and payload["index_intent_id"] is None
    # Not held: the same words stated later in a human session publish.
    pub = call(tctx, {"text": PERSONAL, "source": "message"}, tool_call_id="c2")
    assert pub["published"] is True and "publish_refused" not in pub


def test_data311_the_map_keeps_the_local_reason_in_every_session(tctx, index, ri):
    normal = call(tctx, {"text": TEXT, "source": "message", "publish": False, "reason": "participant_asked"})
    assert ri.lookup(normal["intention_id"]) == {"published": False, "source": "message",
                                                 "local_reason": "participant_asked"}
    ambient = call(tctx, {"text": TEXT, "source": "ambient"}, tool_call_id="c2")
    assert "local_reason" not in ri.lookup(ambient["intention_id"])


@pytest.mark.parametrize("session", ["cron_job_1", "never-seen", SESSION])
def test_data311_an_update_of_a_local_intention_never_makes_it_held(tctx, index, ri, session):
    iid = call(tctx, {"text": PERSONAL, "source": "note", "publish": False, "reason": "personal"},
               session="cron_job_1")["intention_id"]
    out = call(tctx, {"action": "update", "intention_id": iid, "text": PERSONAL + "!"}, session=session,
               tool_call_id="c2")
    assert out["success"] is True and out["published"] is False and index.requests == []
    assert ri.lookup(iid) == {"published": False, "source": "ambient", "local_reason": "personal"}
    pub = call(tctx, {"text": PERSONAL + "!", "source": "message"}, tool_call_id="c3")
    assert pub["published"] is True


def test_data311_ambient_publish_false_needs_a_reason(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "ambient", "publish": False})
    assert out["success"] is False and out["error"] == "reason_required"
    assert index.requests == [] and intention_events(av, plugin) == []


def test_data311_the_schema_says_publish_false_holds_for_every_source(ri):
    text = ri.TOOL_SCHEMA["parameters"]["properties"]["publish"]["description"]
    assert "Ignored for ambient" not in text and "every source" in text


# --------------------------------------------------------------------------
# DATA-410: confirmed_in_chat, the agent's words the resident adopted in chat
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["yes", "standing", " Standing "])
def test_confirmed_in_chat_goes_with_message_and_reaches_the_payload(tctx, index, av, plugin, value):
    out = call(tctx, {"text": TEXT, "source": "message", "confirmed_in_chat": value})
    assert out["success"] is True and out["published"] is True and out["source"] == "message"
    assert out["confirmed_in_chat"] == value.strip().lower()
    [event] = intention_events(av, plugin)
    assert event["event_type"] == "intention.captured"
    assert event["payload"]["source"] == "message"
    assert event["payload"]["confirmed_in_chat"] == value.strip().lower()
    # The marker is a code: no text of the resident's travels with it.
    assert TEXT not in json.dumps(event)


def test_the_residents_own_words_carry_no_marker(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "message"})
    assert "confirmed_in_chat" not in out
    assert "confirmed_in_chat" not in intention_events(av, plugin)[0]["payload"]
    # null is the same as leaving it out.
    out = call(tctx, {"text": TEXT + " too", "source": "message", "confirmed_in_chat": None}, tool_call_id="c2")
    assert out["success"] is True and "confirmed_in_chat" not in out
    assert "confirmed_in_chat" not in intention_events(av, plugin)[1]["payload"]


@pytest.mark.parametrize("source", ["ambient", "onboarding", "note"])
@pytest.mark.parametrize("value", ["yes", "silence", "standing"])
def test_confirmed_in_chat_with_another_source_is_refused(tctx, index, av, plugin, ri, source, value):
    out = call(tctx, {"text": TEXT, "source": source, "confirmed_in_chat": value})
    assert out == {"success": False, "error": "confirmed_not_message", "message": ri.REFUSALS["confirmed_not_message"]}
    assert index.requests == []
    assert intention_events(av, plugin) == []


@pytest.mark.parametrize("value", [True, False, 1, "true", "maybe", "", "  ", ["yes"]])
def test_a_confirmed_in_chat_that_is_not_one_of_the_codes_is_refused(tctx, index, av, plugin, ri, value):
    out = call(tctx, {"text": TEXT, "source": "message", "confirmed_in_chat": value})
    assert out["success"] is False and out["error"] == "confirmed_invalid"
    assert index.requests == []
    assert intention_events(av, plugin) == []


def test_the_refusals_name_the_codes_and_the_ambient_alternative(ri):
    assert ri.REFUSALS["confirmed_invalid"] == (
        "Nothing was recorded: confirmed_in_chat must be yes, silence or standing, or left out."
    )
    assert "source=ambient" in ri.REFUSALS["confirmed_not_message"]


@pytest.mark.parametrize("session,code", [("cron_job_20261012", "held_cron"), ("never-seen", "held_unknown")])
def test_a_silence_capture_from_the_agents_own_send_is_held_and_keeps_its_marker(tctx, index, av, plugin, session, code):
    """DATA-410 option A: the silence capture is made at the agent's next message
    of its own, a cron (or unknown) session. The lineage gate (R10, unchanged)
    holds it as ambient for the resident's tap on the card; the marker stays
    beside the held_* code, so the event says what happened."""
    out = call(tctx, {"text": TEXT, "source": "message", "confirmed_in_chat": "silence"}, session=session)
    assert out["success"] is True and out["source"] == "ambient" and out["publish_refused"] == code
    assert out["published"] is False and out["held"] is True
    assert out["confirmed_in_chat"] == "silence"
    assert index.requests == []
    payload = intention_events(av, plugin)[0]["payload"]
    assert payload["source"] == "ambient" and payload["publish_refused"] == code
    assert payload["confirmed_in_chat"] == "silence"


def test_the_marker_survives_a_local_or_refused_stated_capture(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "message", "confirmed_in_chat": "yes",
                      "publish": False, "reason": "personal"})
    assert out["published"] is False and out["confirmed_in_chat"] == "yes"
    index.tool = refused()
    out = call(tctx, {"text": TEXT + " again", "source": "message", "confirmed_in_chat": "yes"}, tool_call_id="c2")
    assert out["publish_refused"] == "rejected" and out["confirmed_in_chat"] == "yes"
    assert [e["payload"]["confirmed_in_chat"] for e in intention_events(av, plugin)] == ["yes", "yes"]


def test_the_observer_reads_the_marker_only_from_the_overlay_tools_result(tctx, av, plugin):
    # An MCP server's record_intention is not trusted for codes (F13).
    tctx.fire(
        "post_tool_call", tool_name="mcp__x__record_intention",
        args={"action": "capture", "text": TEXT, "source": "message", "confirmed_in_chat": "yes"},
        result=json.dumps({"intention_id": "srv-1", "action": "capture", "source": "message", "confirmed_in_chat": "yes"}),
        session_id=SESSION, task_id="t", turn_id="u", tool_call_id="c9", api_request_id="r",
        duration_ms=5, status="ok", error_type=None, error_message=None,
    )
    assert "confirmed_in_chat" not in intention_events(av, plugin)[0]["payload"]


@pytest.mark.parametrize("result_value,source,expected", [
    ("yes", "message", "yes"),
    ("standing", "message", "standing"),
    ("sure", "message", None),
    (True, "message", None),
    # The tool names the marker beside a held (ambient) source only when the
    # lineage held a capture passed as message: kept.
    ("silence", "ambient", "silence"),
])
def test_plan_record_keeps_only_a_known_code_on_a_message_capture(av, result_value, source, expected):
    intentions = sys.modules[f"{av.MODULE_NAME}._intentions"]
    payload = {"intention_id": INDEX_ID, "action": "capture", "source": source, "confirmed_in_chat": result_value}
    [planned] = intentions.plan_record({"text": TEXT, "source": source}, payload)
    assert planned.confirmed_in_chat == expected
    # Never on an update, whatever the result says.
    [update] = intentions.plan_record({"action": "update", "intention_id": INDEX_ID, "text": TEXT, "source": source},
                                      {**payload, "action": "update"})
    assert update.confirmed_in_chat is None
    # A cron lineage the observer saw itself makes the source ambient; the
    # tool's marker stays beside it.
    [cron] = intentions.plan_record({"text": TEXT, "source": source}, payload, cron=True)
    assert cron.source == "ambient" and cron.confirmed_in_chat == expected


def test_the_schema_offers_the_three_codes(ri):
    prop = ri.TOOL_SCHEMA["parameters"]["properties"]["confirmed_in_chat"]
    assert prop["type"] == "string" and prop["enum"] == ["yes", "silence", "standing"]


# DATA-410 refutation 2: silence is held in code (B1); the refuter's probes M14-M16 (S4).


@pytest.mark.parametrize("source", ["message", " MESSAGE "])
@pytest.mark.parametrize("marker", ["silence", " Silence ", "SILENCE"])
def test_b1_silence_from_a_human_facing_session_is_held_silence_never_published(tctx, index, av, plugin, ri,
                                                                                source, marker):
    """The Telegram session may publish a message capture, but never one passed
    with confirmed_in_chat=silence: it is held as ambient with its own code.
    The hold follows the folded marker and source (recheck SF-1, mutants R11/R12)."""
    out = call(tctx, {"text": TEXT, "source": source, "confirmed_in_chat": marker})
    assert out["success"] is True and out["published"] is False and out["held"] is True
    assert out["source"] == "ambient" and out["publish_refused"] == "held_silence"
    assert out["confirmed_in_chat"] == "silence"
    assert "stays off Index until the resident confirms it" in out["message"]
    assert index.requests == []
    [event] = intention_events(av, plugin)
    assert event["payload"]["source"] == "ambient" and event["payload"]["publish_refused"] == "held_silence"
    assert event["payload"]["confirmed_in_chat"] == "silence" and event["payload"]["index_intent_id"] is None
    # The R10 lineage is untouched: the same session still publishes a yes.
    assert call(tctx, {"text": TEXT + " too", "source": "message", "confirmed_in_chat": "yes"},
                tool_call_id="c2")["published"] is True


def test_b1_silence_from_cron_is_still_held_cron(tctx, index, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "message", "confirmed_in_chat": "silence"}, session="cron_job_20261012")
    assert out["publish_refused"] == "held_cron" and out["source"] == "ambient" and out["published"] is False
    assert index.requests == []


def test_b1_silence_with_publish_false_stays_local_and_unheld(tctx, index, ri):
    """DATA-311 still wins: a capture kept local on purpose is never held or proposed."""
    out = call(tctx, {"text": TEXT, "source": "message", "confirmed_in_chat": "silence",
                      "publish": False, "reason": "personal"})
    assert out["published"] is False and out["local_reason"] == "personal" and "held" not in out
    assert "publish_refused" not in out and out["confirmed_in_chat"] == "silence"
    assert "held_norm_hash" not in ri._load_map()[out["intention_id"]]
    assert index.requests == []


@pytest.mark.parametrize("session,code", [("cron_job_20261012", "held_cron"), ("never-seen", "held_unknown")])
@pytest.mark.parametrize("value", ["yes", "silence", "standing"])
@pytest.mark.parametrize("text", [TEXT, "Meet founders building on Solana in Goa"])
def test_m14_every_marker_from_a_cron_or_unknown_session_is_held(tctx, index, av, plugin, session, code, value, text):
    """Refuter probe M14: no marker gets past the lineage hold (yes and standing included)."""
    out = call(tctx, {"text": text, "source": "message", "confirmed_in_chat": value}, session=session)
    assert out["success"] is True and out["published"] is False and out["held"] is True
    assert out["source"] == "ambient" and out["publish_refused"] == code
    assert index.requests == []
    assert intention_events(av, plugin)[0]["payload"]["source"] == "ambient"


@pytest.mark.parametrize("session,value", [
    ("cron_job_20261012", "yes"), ("never-seen", "standing"), (SESSION, "silence"),
])
def test_m16_a_held_marker_capture_keeps_its_fingerprint_so_a_chat_yes_cannot_publish_around_it(
        tctx, index, ri, av, plugin, session, value):
    """Refuter probe M16: the held capture stores its held fingerprint, so the
    same words captured later in chat as message + yes are recorded locally
    (held_ambient_exists), never published around the card."""
    held = call(tctx, {"text": TEXT, "source": "message", "confirmed_in_chat": value}, session=session)
    stored = ri._load_map()[held["intention_id"]]
    assert stored["source"] == "ambient" and stored["held_norm_hash"] == ri.held_norm_hash(TEXT)
    again = call(tctx, {"text": "  " + TEXT.upper() + " ", "source": "message", "confirmed_in_chat": "yes"},
                 tool_call_id="c2")
    assert again["published"] is False and again["publish_refused"] == "held_ambient_exists"
    assert index.requests == []



# --------------------------------------------------------------------------
# DATA-447: with approval off, an update of a published id to a held ambient
# text is held_ambient_exists, as a capture of it is (refuter DATA-387 S3).
# --------------------------------------------------------------------------

#: The text held as ambient in these tests; TEXT is the published one.
HELD_B = "I'd like a fintech cofounder in Bangalore - evenings only"


def _published_and_held(tctx, index, ri) -> dict:
    """TEXT published under INDEX_ID, HELD_B captured as ambient (held); Index's log cleared."""
    pub = call(tctx, {"text": TEXT, "source": "message"})
    assert pub["published"] is True and pub["intention_id"] == INDEX_ID
    held = call(tctx, {"text": HELD_B, "source": "ambient"}, tool_call_id="c-held")
    assert held["held"] is True and [c["name"] for c in index.tool_calls()] == ["create_intent"]
    index.requests.clear()
    return held


@pytest.mark.parametrize("variant", [
    pytest.param(HELD_B, id="exact"),
    pytest.param(HELD_B + ".", id="trailing-full-stop"),
    pytest.param(HELD_B.upper(), id="upper-case"),
    pytest.param(HELD_B.swapcase(), id="swapped-case"),
    pytest.param(HELD_B.replace("'", "’").replace(" - ", " — "), id="curly-quote-em-dash"),
])
def test_data447_update_of_a_published_id_to_held_text_is_refused(tctx, index, ri, av, plugin, variant):
    """Refuter probe S3: publish A, hold B, update A's id to B (or a DATA-387
    near-copy): never mirrored. Index sees no update_intent."""
    held = _published_and_held(tctx, index, ri)
    entry_before = ri.lookup(INDEX_ID)
    held_before = ri.lookup(held["intention_id"])
    out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": variant}, tool_call_id="c-up")
    assert out["success"] is True and out["action"] == "update"
    assert out["publish_refused"] == "held_ambient_exists"
    # Still published (Index keeps the old wording), under its own id.
    assert out["published"] is True and out["index_intent_id"] == INDEX_ID
    assert "already held as ambient" in out["message"] and "Do not publish it another way" in out["message"]
    assert index.requests == []
    # The local record: the published entry and the held one are unchanged.
    assert ri.lookup(INDEX_ID) == entry_before
    assert ri.lookup(held["intention_id"]) == held_before
    # The event carries the code and a hash, never the words.
    event = intention_events(av, plugin)[-1]
    assert event["event_type"] == "intention.updated" and event["intention_id"] == INDEX_ID
    assert event["payload"]["publish_refused"] == "held_ambient_exists"
    assert event["payload"]["index_intent_id"] == INDEX_ID
    for words in (variant, HELD_B, "fintech"):
        assert words not in json.dumps(event) and words not in json.dumps(out)


@pytest.mark.parametrize("gate", [True, None], ids=["approval-on", "approval-unreadable"])
def test_data447_with_approval_on_the_update_is_still_approval_required(tctx, index, ri, monkeypatch, gate):
    """AC2: approval on (or unreadable) answers before the held check, unchanged."""
    _published_and_held(tctx, index, ri)
    monkeypatch.setattr(ri, "_approval_on", lambda: gate)
    for n, text in enumerate((HELD_B, HELD_B + ".", TEXT + " indoors")):
        out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": text}, tool_call_id=f"c{n}")
        assert out["publish_refused"] == "approval_required" and out["published"] is True
    assert index.requests == []


def test_data447_an_update_to_unrelated_text_still_publishes(tctx, index, ri, av, plugin):
    _published_and_held(tctx, index, ri)
    index.tool = {"intentId": INDEX_ID, "description": TEXT + " indoors", "sourceType": "agentvillage", "sourceId": None}
    out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": TEXT + " indoors"}, tool_call_id="c-up")
    assert out["success"] is True and out["published"] is True and "publish_refused" not in out
    assert index.tool_calls() == [{"name": "update_intent", "arguments": {"description": TEXT + " indoors"}}]
    assert intention_events(av, plugin)[-1]["payload"]["publish_refused"] is None


def test_data447_a_no_op_edit_of_its_own_text_is_not_refused(tctx, index, ri):
    """Decision: only a HELD entry refuses. The published text plus a full stop
    matches no held entry (a published entry carries no held hash), so it is mirrored."""
    _published_and_held(tctx, index, ri)
    index.tool = {"intentId": INDEX_ID, "description": TEXT + ".", "sourceType": "agentvillage", "sourceId": None}
    out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": TEXT + "."}, tool_call_id="c-up")
    assert "publish_refused" not in out
    assert index.tool_calls() == [{"name": "update_intent", "arguments": {"description": TEXT + "."}}]


def test_data447_once_the_held_text_is_withdrawn_the_update_publishes(tctx, index, ri):
    held = _published_and_held(tctx, index, ri)
    call(tctx, {"action": "withdraw", "intention_id": held["intention_id"]}, tool_call_id="c-wd")
    assert index.requests == []
    index.tool = {"intentId": INDEX_ID, "description": HELD_B, "sourceType": "agentvillage", "sourceId": None}
    out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": HELD_B}, tool_call_id="c-up")
    assert "publish_refused" not in out
    assert index.tool_calls() == [{"name": "update_intent", "arguments": {"description": HELD_B}}]


def test_data447_a_held_session_still_answers_first(tctx, index, ri, av, plugin):
    """F4 is unchanged: a cron update of a published id is held_cron, whatever its text."""
    _published_and_held(tctx, index, ri)
    cron = "cron_memsync_20261009_030000"
    tctx.fire("on_session_start", session_id=cron, model="m", platform="cron")
    out = call(tctx, {"action": "update", "intention_id": INDEX_ID, "text": HELD_B}, session=cron, tool_call_id="c-up")
    assert out["publish_refused"] == "held_cron" and index.requests == []
