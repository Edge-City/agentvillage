"""`tool.call` (spec §4.1, §7.1): allowlisted names, hashes and lengths only."""

from __future__ import annotations

import hashlib
import json
import re
import uuid

import pytest

SESSION = "sess-tool"
SECRET_ARG = "cat /home/agent/notes-about-alice.txt"
SECRET_RESULT = "Alice Example lives at 12 Example Road; key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ"
ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest()


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


def fire(ctx, tool_name="terminal", args=None, result="{}", *, status="ok", **extra):
    ctx.fire(
        "post_tool_call",
        session_id=extra.pop("session_id", SESSION),
        task_id=extra.pop("task_id", "task-1"),
        turn_id=extra.pop("turn_id", "turn-1"),
        tool_name=tool_name,
        args={"command": SECRET_ARG} if args is None else args,
        result=result,
        tool_call_id=extra.pop("tool_call_id", "call-1"),
        api_request_id="req-1",
        duration_ms=extra.pop("duration_ms", 250),
        status=status,
        error_type=extra.pop("error_type", None),
        error_message=extra.pop("error_message", None),
        **extra,
    )


def tool_calls(av, plugin):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "tool.call"]


def test_every_tool_call_emits_one_event_with_the_catalogue_keys(live, ctx, av):
    fire(ctx, result=SECRET_RESULT)
    events = tool_calls(av, live)
    assert len(events) == 1
    event = events[0]
    payload = event["payload"]
    for key in ("tool_name", "args_hash", "result_hash", "ok", "latency_ms", "receipt"):
        assert key in payload, key
    assert payload["tool_name"] == "terminal"
    assert payload["tool_category"] == "system"
    assert payload["ok"] is True
    assert payload["status"] == "ok"
    assert payload["latency_ms"] == 250
    assert payload["receipt"] is None
    assert payload["args_hash"] == sha(json.dumps({"command": SECRET_ARG}, sort_keys=True, separators=(",", ":")))
    assert payload["result_hash"] == sha(SECRET_RESULT)
    assert payload["category_version"] == "tool_categories_v1"
    assert event["tool_call_id"] == "call-1"
    assert event["session_id"] == SESSION
    assert event["run_id"] == "task-1"
    assert event["evidence_class"] == "agent_report"
    assert event["occurred_at_earliest"] <= event["occurred_at"] == event["occurred_at_latest"]


def test_the_event_id_is_a_uuid_v7(live, ctx, av):
    fire(ctx)
    event_id = tool_calls(av, live)[0]["event_id"]
    assert uuid.UUID(event_id).version == 7


def test_an_mcp_tool_is_listed_under_its_prefixed_name(live, ctx, av):
    fire(ctx, "mcp__index__list_opportunities", {"limit": 5}, "{}")
    payload = tool_calls(av, live)[0]["payload"]
    assert payload["tool_name"] == "mcp__index__list_opportunities"
    assert payload["tool_category"] == "opportunity"


@pytest.mark.parametrize(
    "name",
    ["mcp__someserver__exfiltrate_contacts", "create_intent", "mcp__notindex__create_intent", "my_private_tool"],
)
def test_an_unlisted_tool_leaves_as_other_with_no_name(live, ctx, av, name):
    fire(ctx, name, {"q": "x"}, "{}")
    payload = tool_calls(av, live)[0]["payload"]
    assert payload["tool_name"] is None
    assert payload["tool_category"] == "other"
    assert name not in json.dumps(tool_calls(av, live))


@pytest.mark.parametrize("status,ok,normalised", [
    ("ok", True, "ok"),
    ("error", False, "error"),
    ("blocked", False, "blocked"),
    ("timeout", False, "timeout"),
    ("cancelled", False, "cancelled"),
    ("CANCELLED ", False, "cancelled"),
    ("exploded", False, "other"),
    (None, True, None),
])
def test_status_and_ok(live, ctx, av, status, ok, normalised):
    fire(ctx, status=status)
    payload = tool_calls(av, live)[0]["payload"]
    assert payload["ok"] is ok
    assert payload["status"] == normalised


def test_error_message_never_leaves_and_error_type_only_as_a_name(live, ctx, av):
    fire(ctx, status="error", error_type="ToolError", error_message=f"failed reading {SECRET_ARG}")
    fire(ctx, status="error", error_type="failed reading the notes about alice", tool_call_id="call-2")
    events = tool_calls(av, live)
    assert events[0]["payload"]["error_type"] == "ToolError"
    assert events[1]["payload"]["error_type"] is None
    assert "notes" not in json.dumps(events)


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_arguments_and_results_never_leave_in_any_mode(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    fire(ctx, "terminal", {"command": SECRET_ARG}, SECRET_RESULT)
    fire(ctx, "mcp__index__create_intent", {"description": SECRET_ARG}, SECRET_RESULT, tool_call_id="c2")
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    for leak in ("alice", "Alice", "Example Road", "sk-ant-", "notes-about"):
        assert leak not in blob, (mode, leak)


def test_metadata_carries_neither_hashes_nor_lengths(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    fire(ctx, result=SECRET_RESULT)
    payload = tool_calls(av, plugin)[0]["payload"]
    assert payload["args_hash"] is None and payload["result_hash"] is None
    assert "args_length" not in payload and "result_length" not in payload
    # The structural fields stay.
    assert payload["tool_name"] == "terminal" and payload["ok"] is True and payload["latency_ms"] == 250


@pytest.mark.parametrize("mode", ["sanitized", "full"])
def test_sanitized_and_full_add_hashes_and_character_lengths(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    result = "café ☕ done"
    fire(ctx, result=result)
    payload = tool_calls(av, plugin)[0]["payload"]
    assert payload["result_hash"] == sha(result)
    assert payload["result_length"] == len(result) < len(result.encode("utf-8"))
    assert payload["args_length"] == len(json.dumps({"command": SECRET_ARG}, separators=(",", ":")))


def test_full_is_no_different_from_sanitized_for_tool_calls(plugin, ctx, monkeypatch, av):
    """Tool arguments and results are archive-only; `full` adds nothing here."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    fire(ctx, result=SECRET_RESULT)
    payload = tool_calls(av, plugin)[0]["payload"]
    assert set(payload) == {
        "tool_name", "tool_category", "args_hash", "result_hash", "ok", "status", "latency_ms", "receipt",
        "error_type", "operation", "target_system", "category_version", "args_length", "result_length",
    }


def test_a_lone_surrogate_in_a_result_hashes(live, ctx, av):
    fire(ctx, result="broken \ud800 text")
    assert tool_calls(av, live)[0]["payload"]["result_hash"] == sha("broken \ud800 text")


def test_unserialisable_args_hash_to_null_rather_than_failing(live, ctx, av):
    fire(ctx, args={"blob": object()})
    payload = tool_calls(av, live)[0]["payload"]
    assert payload["args_hash"] is None
    assert live._COLLECTOR.total_failures == 0


def test_a_bad_tool_call_id_is_nulled_and_the_event_kept(live, ctx, av):
    fire(ctx, tool_call_id="call with spaces and a sentence")
    event = tool_calls(av, live)[0]
    assert event["tool_call_id"] is None


def test_every_envelope_id_matches_the_id_pattern(live, ctx, av):
    fire(ctx, tool_call_id="call_ABC-1.2:3")
    event = tool_calls(av, live)[0]
    for key in ("event_id", "session_id", "turn_id", "run_id", "tool_call_id"):
        assert ID_PATTERN.match(event[key]), key


def test_no_token_means_no_tool_calls(plugin, ctx, av):
    plugin.register(ctx)
    fire(ctx)
    assert av.read_buffer(plugin._COLLECTOR) == []


def test_disabling_post_tool_call_disables_tool_call(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "post_tool_call")
    plugin.register(ctx)
    fire(ctx)
    assert tool_calls(av, plugin) == []


def test_pre_tool_call_emits_nothing(live, ctx, av):
    before = len(av.read_buffer(live._COLLECTOR))
    ctx.fire("pre_tool_call", session_id=SESSION, tool_name="terminal", args={"command": "ls"})
    assert len(av.read_buffer(live._COLLECTOR)) == before


def test_a_failing_payload_builder_fails_open(live, ctx, av, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("builder exploded")

    monkeypatch.setattr(live, "tool_call_payload", boom)
    results = ctx.fire(
        "post_tool_call", session_id=SESSION, tool_name="terminal", args={}, result="", status="ok"
    )
    assert results == []
    assert live._COLLECTOR.total_failures == 1
    assert tool_calls(av, live) == []


def test_the_seed_is_well_formed_and_loaded(plugin):
    tools = __import__(f"{plugin.__name__}._tools", fromlist=["_tools"])
    version, categories = tools.load_categories()
    assert version == "tool_categories_v1"
    assert categories == tools.TOOL_CATEGORIES
    assert all(name.startswith("mcp__index__") for name in categories if name.startswith("mcp__"))
    assert "create_intent" not in categories  # bare Index names are not listed


def test_a_missing_seed_lists_nothing(plugin, tmp_path):
    tools = __import__(f"{plugin.__name__}._tools", fromlist=["_tools"])
    assert tools.load_categories(str(tmp_path / "nope.json")) == (None, {})
    (tmp_path / "bad.json").write_text("{not json")
    assert tools.load_categories(str(tmp_path / "bad.json")) == (None, {})
