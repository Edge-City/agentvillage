"""Intention capture from Index tool calls and `record_intention` (spec §4.1, §7.1)."""

from __future__ import annotations

import copy
import hashlib
import json
import sys
import uuid

import pytest

SESSION = "sess-int"
TASK = "task-int"

DESCRIPTION = "Looking for a cofounder who has shipped hardware"
SUMMARY = "Seeking hardware cofounder"
SECRET_DESCRIPTION = "my key is sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ, find me an investor"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def index_result(data, *, success=True) -> str:
    """What an Index MCP tool hands `post_tool_call`: Hermes wraps the text content."""
    return json.dumps({"result": json.dumps({"success": success, "data": data})})


def fire_tool(ctx, tool_name, args, result, *, status="ok", session=SESSION, tool_call_id="call-1", **extra):
    ctx.fire(
        "post_tool_call",
        tool_name=tool_name,
        args=args,
        result=result,
        session_id=session,
        task_id=extra.pop("task_id", TASK),
        turn_id=extra.pop("turn_id", "turn-3"),
        tool_call_id=tool_call_id,
        api_request_id="req-9",
        duration_ms=extra.pop("duration_ms", 840),
        status=status,
        error_type=None,
        error_message=None,
        **extra,
    )


def intention_events(av, plugin):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("intention.")]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


# --------------------------------------------------------------------------
# Each emitted type
# --------------------------------------------------------------------------


def test_create_intent_emits_intention_captured(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": DESCRIPTION},
        index_result({"intent": {"id": "int-abc", "summary": SUMMARY, "status": "active"}}),
    )
    events = intention_events(av, live)
    assert [e["event_type"] for e in events] == ["intention.captured"]
    event = events[0]
    payload = event["payload"]
    # §4.1 required keys, spelled as the catalogue spells them.
    for key in ("text_hash", "summary_hash", "index_intent_id", "source", "conditional"):
        assert key in payload
    assert payload["text_hash"] == sha(DESCRIPTION)
    assert payload["summary_hash"] == sha(SUMMARY)
    assert payload["index_intent_id"] == "int-abc"
    assert payload["source"] == "message"
    assert payload["conditional"] is None
    assert payload["capture_path"] == "index_tool"
    # Funnel id is Index's own intent id (§4.2), and provenance rides the envelope.
    assert event["intention_id"] == "int-abc"
    assert event["tool_call_id"] == "call-1"
    assert event["run_id"] == TASK
    assert event["session_id"] == SESSION
    assert event["turn_id"] == "turn-3"
    assert event["parent_run_id"] is None
    assert event["evidence_class"] == "agent_report"
    assert event["actor"] == "agent"


def test_captured_occurred_window_spans_the_tool_call(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": DESCRIPTION},
        index_result({"intent": {"id": "int-abc"}}),
        duration_ms=2500,
    )
    event = intention_events(av, live)[0]
    assert event["occurred_at_earliest"] < event["occurred_at_latest"]
    assert event["occurred_at"] == event["occurred_at_latest"]


def test_update_intent_emits_intention_updated_with_the_argument_id(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__update_intent",
        {"id": "int-abc", "description": DESCRIPTION + " (and firmware)"},
        index_result({"intent": {"id": "int-abc", "summary": SUMMARY + " v2"}}),
    )
    events = intention_events(av, live)
    assert [e["event_type"] for e in events] == ["intention.updated"]
    assert events[0]["intention_id"] == "int-abc"
    assert events[0]["payload"]["text_hash"] == sha(DESCRIPTION + " (and firmware)")
    assert events[0]["payload"]["summary_hash"] == sha(SUMMARY + " v2")


def test_update_intent_archiving_is_a_withdrawal(live, ctx, av):
    """The heartbeat prunes stale signals with `update_intent(id, status="archived")`."""
    fire_tool(
        ctx,
        "mcp__index__update_intent",
        {"id": "int-abc", "status": "archived"},
        index_result({"intent": {"id": "int-abc", "summary": SUMMARY, "status": "archived"}}),
    )
    events = intention_events(av, live)
    assert [e["event_type"] for e in events] == ["intention.withdrawn"]
    payload = events[0]["payload"]
    assert events[0]["intention_id"] == "int-abc"
    assert payload["index_status"] == "archived"
    assert payload["text_hash"] is None and payload["summary_hash"] is None


def test_delete_intent_is_a_withdrawal(live, ctx, av):
    fire_tool(ctx, "mcp__index__delete_intent", {"intentId": "int-abc"}, index_result({"deleted": True}))
    events = intention_events(av, live)
    assert [e["event_type"] for e in events] == ["intention.withdrawn"]
    assert events[0]["intention_id"] == "int-abc"


def test_update_without_an_id_is_not_emitted(live, ctx, av):
    fire_tool(ctx, "mcp__index__update_intent", {"description": "x"}, index_result({"ok": True}))
    assert intention_events(av, live) == []


def test_record_intention_mints_a_uuid7_id(live, ctx, av):
    fire_tool(
        ctx,
        "record_intention",
        {"text": DESCRIPTION, "summary": SUMMARY, "source": "ambient", "conditional": True},
        json.dumps({"ok": True}),
    )
    events = intention_events(av, live)
    assert [e["event_type"] for e in events] == ["intention.captured"]
    event = events[0]
    minted = uuid.UUID(event["intention_id"])
    assert minted.version == 7
    payload = event["payload"]
    assert payload["source"] == "ambient"
    assert payload["conditional"] is True
    assert payload["index_intent_id"] is None
    assert payload["capture_path"] == "record_intention"
    assert payload["text_hash"] == sha(DESCRIPTION)


def test_record_intention_uses_an_id_the_tool_returned(live, ctx, av):
    fire_tool(ctx, "record_intention", {"text": DESCRIPTION}, json.dumps({"intention_id": "local-7"}))
    assert intention_events(av, live)[0]["intention_id"] == "local-7"


def test_record_intention_update_and_withdraw_name_the_same_intention(live, ctx, av):
    fire_tool(ctx, "record_intention", {"text": DESCRIPTION, "source": "onboarding"}, "{}", tool_call_id="c1")
    first = intention_events(av, live)[0]
    fire_tool(
        ctx,
        "record_intention",
        {"intention_id": first["intention_id"], "text": DESCRIPTION + "!"},
        "{}",
        tool_call_id="c2",
    )
    fire_tool(
        ctx,
        "record_intention",
        {"intention_id": first["intention_id"], "action": "withdraw"},
        "{}",
        tool_call_id="c3",
    )
    events = intention_events(av, live)
    assert [e["event_type"] for e in events] == [
        "intention.captured",
        "intention.updated",
        "intention.withdrawn",
    ]
    assert len({e["intention_id"] for e in events}) == 1
    assert events[0]["payload"]["source"] == "onboarding"


def test_record_intention_withdraw_without_an_id_is_not_emitted(live, ctx, av):
    fire_tool(ctx, "record_intention", {"action": "withdraw"}, "{}")
    assert intention_events(av, live) == []


def test_an_unknown_record_source_falls_back_to_message(live, ctx, av):
    fire_tool(ctx, "record_intention", {"text": DESCRIPTION, "source": "telepathy"}, "{}")
    assert intention_events(av, live)[0]["payload"]["source"] == "message"


def test_a_create_whose_id_cannot_be_read_still_captures(live, ctx, av):
    """Index said yes; losing the capture is worse than a minted id the core links by hash."""
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, json.dumps({"result": "Signal saved."}))
    events = intention_events(av, live)
    assert [e["event_type"] for e in events] == ["intention.captured"]
    assert uuid.UUID(events[0]["intention_id"]).version == 7
    assert events[0]["payload"]["index_intent_id"] is None


def test_a_create_returning_several_intents_emits_one_each(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": DESCRIPTION},
        index_result({"intents": [{"id": "int-1", "summary": "a"}, {"id": "int-2", "summary": "b"}]}),
    )
    assert [e["intention_id"] for e in intention_events(av, live)] == ["int-1", "int-2"]


def test_structured_content_is_preferred(live, ctx, av):
    result = json.dumps(
        {"result": "Created your signal.", "structuredContent": {"success": True, "data": {"intent": {"id": "int-s"}}}}
    )
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result)
    assert intention_events(av, live)[0]["intention_id"] == "int-s"


# --------------------------------------------------------------------------
# What does not count
# --------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["error", "blocked"])
def test_a_failed_or_blocked_call_records_nothing(live, ctx, av, status):
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": DESCRIPTION},
        json.dumps({"error": "boom"}),
        status=status,
    )
    assert intention_events(av, live) == []


def test_an_index_refusal_records_nothing(live, ctx, av):
    """"Too vague" comes back as `success: false` inside an `ok` Hermes status."""
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": "stuff"},
        index_result({"reason": "too vague"}, success=False),
    )
    assert intention_events(av, live) == []


@pytest.mark.parametrize(
    "tool_name",
    ["mcp__other__create_intent", "mcp__index__read_intents", "mcp__index__search_intents", "shell", ""],
)
def test_other_tools_are_ignored(live, ctx, av, tool_name):
    fire_tool(ctx, tool_name, {"description": DESCRIPTION}, index_result({"intent": {"id": "int-x"}}))
    assert intention_events(av, live) == []


def test_the_bare_index_tool_name_is_recognised(live, ctx, av):
    fire_tool(ctx, "create_intent", {"description": DESCRIPTION}, index_result({"intent": {"id": "int-b"}}))
    assert intention_events(av, live)[0]["intention_id"] == "int-b"


def test_the_same_tool_call_is_recorded_once(live, ctx, av):
    for _ in range(2):
        fire_tool(
            ctx,
            "mcp__index__create_intent",
            {"description": DESCRIPTION},
            index_result({"intent": {"id": "int-abc"}}),
            tool_call_id="dup",
        )
    assert len(intention_events(av, live)) == 1


def test_pre_tool_call_writes_nothing(live, ctx, av):
    """It fails closed in Hermes: intention capture must not touch it."""
    before = len(av.read_buffer(live._COLLECTOR))
    ctx.fire(
        "pre_tool_call",
        tool_name="mcp__index__create_intent",
        args={"description": DESCRIPTION},
        session_id=SESSION,
        tool_call_id="call-1",
    )
    assert len(av.read_buffer(live._COLLECTOR)) == before


def test_run_id_is_null_when_task_id_repeats_the_session(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": DESCRIPTION},
        index_result({"intent": {"id": "int-abc"}}),
        task_id=SESSION,
    )
    assert intention_events(av, live)[0]["run_id"] is None


def test_a_subagent_capture_carries_its_parent(live, ctx, av):
    ctx.fire(
        "subagent_start",
        parent_session_id=SESSION,
        parent_turn_id="turn-3",
        child_session_id="sess-child",
        child_role="researcher",
        child_goal="find cofounders",
    )
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": DESCRIPTION},
        index_result({"intent": {"id": "int-kid"}}),
        session="sess-child",
        task_id="task-child",
    )
    event = intention_events(av, live)[0]
    assert event["session_id"] == "sess-child"
    assert event["run_id"] == "task-child"
    assert event["parent_run_id"] == SESSION


# --------------------------------------------------------------------------
# Capture modes
# --------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_intention_text_never_leaves_in_any_mode(plugin, ctx, monkeypatch, av, mode):
    """§7.1 "with hashes only"; catalogue §A "text in the archive only" — `full` included."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": DESCRIPTION},
        index_result({"intent": {"id": "int-abc", "summary": SUMMARY}}),
        tool_call_id="c1",
    )
    fire_tool(ctx, "record_intention", {"text": DESCRIPTION, "summary": SUMMARY}, "{}", tool_call_id="c2")
    events = intention_events(av, plugin)
    assert len(events) == 2
    raw = json.dumps(events)
    assert DESCRIPTION not in raw
    assert SUMMARY not in raw
    for event in events:
        # The hashes are the join keys and ride in every mode.
        assert event["payload"]["text_hash"] == sha(DESCRIPTION)
        assert event["payload"]["summary_hash"] == sha(SUMMARY)


def test_metadata_omits_lengths(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    fire_tool(ctx, "record_intention", {"text": DESCRIPTION, "summary": SUMMARY}, "{}")
    payload = intention_events(av, plugin)[0]["payload"]
    assert "text_length" not in payload and "summary_length" not in payload


@pytest.mark.parametrize("mode", ["sanitized", "full"])
def test_sanitized_and_full_add_lengths_only(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    fire_tool(ctx, "record_intention", {"text": DESCRIPTION, "summary": SUMMARY}, "{}")
    payload = intention_events(av, plugin)[0]["payload"]
    assert payload["text_length"] == len(DESCRIPTION)
    assert payload["summary_length"] == len(SUMMARY)
    assert "text" not in payload and "summary" not in payload


def test_a_secret_in_the_intention_text_does_not_leave(live, ctx, av):
    fire_tool(
        ctx, "mcp__index__create_intent", {"description": SECRET_DESCRIPTION}, index_result({"intent": {"id": "i"}})
    )
    events = av.read_buffer(live._COLLECTOR)
    assert "sk-ant-" not in json.dumps(events)
    assert intention_events(av, live)[0]["payload"]["text_hash"] == sha(SECRET_DESCRIPTION)


# --------------------------------------------------------------------------
# Kill switches and idling
# --------------------------------------------------------------------------


def test_no_token_means_no_intention_events(plugin, ctx, av):
    plugin.register(ctx)
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, index_result({"intent": {"id": "i"}}))
    assert av.read_buffer(plugin._COLLECTOR) == []


def test_disabling_post_tool_call_disables_capture(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "post_tool_call")
    plugin.register(ctx)
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, index_result({"intent": {"id": "i"}}))
    assert intention_events(av, plugin) == []


# --------------------------------------------------------------------------
# Fail-open
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "result",
    [
        None,
        "",
        "not json {",
        "{\"result\": \"{broken\"}",
        json.dumps({"result": json.dumps({"success": True, "data": ["x", 3, None]})}),
        json.dumps({"result": json.dumps({"success": True, "data": {"intent": {"id": {"nested": 1}}}})}),
        12345,
        ["a", "b"],
    ],
)
def test_malformed_results_never_raise_or_count_as_failures(live, ctx, av, result):
    results = ctx.fire("post_tool_call", tool_name="mcp__index__create_intent", args={"description": 1},
                       result=result, session_id=SESSION, tool_call_id="c", status="ok")
    assert results == []
    assert live._COLLECTOR.sessions[SESSION].failure_count == 0


def test_malformed_args_never_raise(live, ctx):
    for args in (None, "a string", ["list"], {"id": None, "status": 7, "description": ["x"]}):
        ctx.fire(
            "post_tool_call",
            tool_name="mcp__index__update_intent",
            args=args,
            result=index_result({"intent": {"id": "i"}}),
            session_id=SESSION,
            status="ok",
        )
    assert live._COLLECTOR.sessions[SESSION].failure_count == 0


def test_a_throwing_intention_path_cannot_reach_the_tool_call(live, ctx, monkeypatch, av):
    """Forced fault inside the capture path: swallowed, counted, nothing returned."""

    def boom(*args, **kwargs):
        raise RuntimeError(f"injected fault quoting {DESCRIPTION}")

    monkeypatch.setattr(live, "plan_intentions", boom)
    args = {"description": DESCRIPTION}
    before = copy.deepcopy(args)
    result = index_result({"intent": {"id": "int-abc"}})

    returned = ctx.fire("post_tool_call", tool_name="mcp__index__create_intent", args=args, result=result,
                        session_id=SESSION, tool_call_id="c", status="ok")

    assert returned == []  # an observer return is discarded anyway; we return nothing
    assert args == before  # the tool's arguments are untouched
    state = live._COLLECTOR.sessions[SESSION]
    assert state.failure_count == 1
    assert state.failures_by_hook == {"post_tool_call": 1}
    assert intention_events(av, live) == []
    # The exception text (which quotes the intention) goes nowhere.
    assert DESCRIPTION not in json.dumps(av.read_buffer(live._COLLECTOR))


def test_capture_never_mutates_the_arguments_or_result(live, ctx):
    args = {"description": DESCRIPTION, "id": "int-abc", "nested": {"k": [1, 2]}}
    result = {"result": json.dumps({"success": True, "data": {"intent": {"id": "int-abc"}}})}
    args_before, result_before = copy.deepcopy(args), copy.deepcopy(result)
    fire_tool(ctx, "mcp__index__update_intent", args, result)
    assert args == args_before
    assert result == result_before


def test_an_oversized_result_is_not_parsed(live, ctx, av):
    intentions = sys.modules[f"{live.__name__}._intentions"]
    huge = json.dumps({"result": "x" * (intentions.MAX_RESULT_CHARS + 1)})
    fire_tool(ctx, "mcp__index__update_intent", {"description": "d"}, huge)
    # No id in the args and none readable in the result: nothing to join, nothing emitted.
    assert intention_events(av, live) == []


# --------------------------------------------------------------------------
# event_id idempotency across a retried flush
# --------------------------------------------------------------------------


def test_event_id_is_stable_across_a_retried_flush(plugin, ctx, monkeypatch, av):
    """Ingest dedupes on `event_id` (scenario 1), so a retry must resend the same ids."""
    with av.StubIngest(statuses=[503, 200]) as ingest:
        monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
        monkeypatch.setenv("AV_EVENTS_URL", ingest.url)
        plugin.register(ctx)
        fire_tool(
            ctx,
            "mcp__index__create_intent",
            {"description": DESCRIPTION},
            index_result({"intent": {"id": "int-abc"}}),
            tool_call_id="c1",
        )
        fire_tool(ctx, "record_intention", {"text": DESCRIPTION}, "{}", tool_call_id="c2")
        collector = plugin._COLLECTOR
        collector.buffer.rotate_if_due(force=True)

        collector.tick()  # 503: the batch stays on disk
        assert ingest.request_count == 1
        for name in list(collector._backoff):
            collector._backoff[name] = (0.0, 1)
        collector.tick()  # 200
        assert ingest.request_count == 2

        first, second = ingest.attempts
        assert [e["event_id"] for e in first] == [e["event_id"] for e in second]
        assert first == second, "a retry resends the buffered bytes, not a rebuilt event"
        sent = [e for e in second if e["event_type"].startswith("intention.")]
        assert len(sent) == 2
        for event in sent:
            assert uuid.UUID(event["event_id"]).version == 7
        # Including the minted intention id: it was fixed at capture, not at send.
        assert [e["intention_id"] for e in first if e["event_type"].startswith("intention.")] == [
            e["intention_id"] for e in sent
        ]
        # Delivered once; nothing left to send twice.
        collector.tick()
        assert ingest.request_count == 2
