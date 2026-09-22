"""Intention capture from Index tool calls and `record_intention` (spec §4.1, §7.1)."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
import uuid

import pytest

SESSION = "sess-int"
TASK = "task-int"

DESCRIPTION = "Looking for a cofounder who has shipped hardware"
SUMMARY = "Seeking hardware cofounder"
SECRET_DESCRIPTION = "my key is sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ, find me an investor"
SENTENCE = "Alice Example wants to meet an investor next Tuesday"
LONE_SURROGATE = "\ud800"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest()


def index_result(data, *, success=True) -> str:
    """What an Index MCP tool hands `post_tool_call`: Hermes wraps the text content."""
    return json.dumps({"result": json.dumps({"success": success, "data": data})})


def created(intent_id="int-abc", summary=SUMMARY, **fields) -> str:
    return index_result({"intent": {"id": intent_id, "summary": summary, **fields}})


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


def record(ctx, args, result="{}", **kw):
    fire_tool(ctx, "record_intention", args, result, **kw)


def intention_events(av, plugin):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("intention.")]


def types(events):
    return [e["event_type"] for e in events]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


# --------------------------------------------------------------------------
# Index: each emitted type
# --------------------------------------------------------------------------


def test_create_intent_emits_intention_captured(live, ctx, av):
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(status="active"))
    events = intention_events(av, live)
    assert types(events) == ["intention.captured"]
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
    assert payload["index_status"] == "active"
    assert payload["parent_session_id"] is None
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
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), duration_ms=2500)
    event = intention_events(av, live)[0]
    assert event["occurred_at_earliest"] < event["occurred_at_latest"]
    assert event["occurred_at"] == event["occurred_at_latest"]


def test_update_intent_emits_intention_updated_with_the_argument_id(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__update_intent",
        {"id": "int-abc", "description": DESCRIPTION + " (and firmware)"},
        created(summary=SUMMARY + " v2"),
    )
    events = intention_events(av, live)
    assert types(events) == ["intention.updated"]
    assert events[0]["intention_id"] == "int-abc"
    assert events[0]["payload"]["text_hash"] == sha(DESCRIPTION + " (and firmware)")
    assert events[0]["payload"]["summary_hash"] == sha(SUMMARY + " v2")


@pytest.mark.parametrize("status", ["archived", "  Archived ", "DELETED", "withdrawn"])
def test_update_intent_archiving_is_a_withdrawal(live, ctx, av, status):
    """The heartbeat prunes stale signals with `update_intent(id, status="archived")`."""
    fire_tool(ctx, "mcp__index__update_intent", {"id": "int-abc", "status": status}, created(status="archived"))
    events = intention_events(av, live)
    assert types(events) == ["intention.withdrawn"]
    payload = events[0]["payload"]
    assert events[0]["intention_id"] == "int-abc"
    assert payload["index_status"] == status.strip().lower()
    assert payload["text_hash"] is None and payload["summary_hash"] is None


def test_a_withdrawal_status_can_come_from_the_result(live, ctx, av):
    fire_tool(ctx, "mcp__index__update_intent", {"id": "int-abc"}, created(status="Archived"))
    events = intention_events(av, live)
    assert types(events) == ["intention.withdrawn"]
    assert events[0]["payload"]["index_status"] == "archived"


def test_a_withdrawn_result_status_wins_over_an_active_argument(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__update_intent",
        {"id": "int-abc", "description": DESCRIPTION, "status": "active"},
        created(status="archived"),
    )
    events = intention_events(av, live)
    assert types(events) == ["intention.withdrawn"]
    assert events[0]["payload"]["index_status"] == "archived"


def test_a_withdrawn_argument_status_wins_over_an_active_result(live, ctx, av):
    fire_tool(ctx, "mcp__index__update_intent", {"id": "int-abc", "status": "deleted"}, created(status="active"))
    events = intention_events(av, live)
    assert types(events) == ["intention.withdrawn"]
    assert events[0]["payload"]["index_status"] == "deleted"


def test_a_status_only_update_emits_nothing(live, ctx, av):
    fire_tool(ctx, "mcp__index__update_intent", {"id": "int-abc", "status": "active"}, created(status="active"))
    assert intention_events(av, live) == []


def test_delete_intent_is_a_withdrawal(live, ctx, av):
    fire_tool(ctx, "mcp__index__delete_intent", {"intentId": "int-abc"}, index_result({"deleted": True}))
    events = intention_events(av, live)
    assert types(events) == ["intention.withdrawn"]
    assert events[0]["intention_id"] == "int-abc"


def test_update_without_an_id_is_not_emitted(live, ctx, av):
    fire_tool(ctx, "mcp__index__update_intent", {"description": "x"}, created())
    assert intention_events(av, live) == []


@pytest.mark.parametrize("status", ["paused", "needs review please", LONE_SURROGATE])
def test_an_unlisted_status_is_reported_as_other(live, ctx, av, status):
    fire_tool(ctx, "mcp__index__update_intent", {"id": "int-abc", "description": DESCRIPTION, "status": status}, "{}")
    events = intention_events(av, live)
    assert types(events) == ["intention.updated"]
    assert events[0]["payload"]["index_status"] == "other"


# --------------------------------------------------------------------------
# Index: reading the create result
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "result",
    [
        json.dumps({"result": "Signal saved."}),
        json.dumps({"result": json.dumps({"success": True, "data": {"id": "int-top"}})}),
        json.dumps({"result": json.dumps({"success": True, "id": "int-top"})}),
        json.dumps({"result": json.dumps({"success": True, "data": {"intent": {"summary": "no id"}}})}),
        json.dumps({"result": json.dumps({"success": True, "data": ["int-1"]})}),
    ],
    ids=["plain-text", "id-on-data", "id-on-top", "intent-without-id", "data-is-a-list"],
)
def test_a_create_whose_id_cannot_be_read_emits_nothing(live, ctx, av, result):
    """No minted-id fallback for Index: an unnamed create joins nothing."""
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result)
    assert intention_events(av, live) == []


def test_a_single_item_intents_list_is_accepted(live, ctx, av):
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, index_result({"intents": [{"id": "int-1"}]}))
    assert [e["intention_id"] for e in intention_events(av, live)] == ["int-1"]


def test_a_create_returning_several_intents_emits_nothing(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": DESCRIPTION},
        index_result({"intents": [{"id": "int-1", "summary": "a"}, {"id": "int-2", "summary": "b"}]}),
    )
    assert intention_events(av, live) == []


@pytest.mark.parametrize(
    "structured",
    [{"success": True, "data": {"intent": {"id": "int-s"}}}, {"intent": {"id": "int-s"}}],
    ids=["data.intent", "intent"],
)
def test_structured_content_is_preferred(live, ctx, av, structured):
    result = json.dumps({"result": "Created your signal.", "structuredContent": structured})
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result)
    assert intention_events(av, live)[0]["intention_id"] == "int-s"


def test_only_the_first_json_object_of_joined_text_blocks_is_read(live, ctx, av):
    """Hermes joins an MCP result's text blocks with a newline."""
    first = json.dumps({"success": True, "data": {"intent": {"id": "int-first"}}})
    second = json.dumps({"success": True, "data": {"intent": {"id": "int-second"}}})
    result = json.dumps({"result": first + "\nDiscovery will run next.\n" + second})
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result)
    assert [e["intention_id"] for e in intention_events(av, live)] == ["int-first"]


def test_a_brace_inside_a_sentence_is_not_a_result(live, ctx, av):
    """The "too vague" refusal quotes an example signal inline; it must not read as a create."""
    example = json.dumps({"success": True, "data": {"intent": {"id": "int-example"}}})
    result = json.dumps({"result": "Too vague. A good signal looks like " + example})
    fire_tool(ctx, "mcp__index__create_intent", {"description": "stuff"}, result)
    assert intention_events(av, live) == []


def test_braces_in_a_prose_line_do_not_hide_the_json_line(live, ctx, av):
    block = json.dumps({"success": True, "data": {"intent": {"id": "int-created"}}})
    result = json.dumps({"result": "Created {1} signal.\n" + block})
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result)
    assert [e["intention_id"] for e in intention_events(av, live)] == ["int-created"]


def test_a_pretty_printed_json_block_is_read(live, ctx, av):
    block = json.dumps({"success": True, "data": {"intent": {"id": "int-pretty"}}}, indent=2)
    result = json.dumps({"result": "Saved.\n" + block})
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result)
    assert [e["intention_id"] for e in intention_events(av, live)] == ["int-pretty"]


def test_a_json_block_after_a_prose_block_is_read(live, ctx, av):
    block = json.dumps({"success": True, "data": {"intent": {"id": "int-after-prose"}}})
    result = json.dumps({"result": "Signal created.\n" + block})
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result)
    assert [e["intention_id"] for e in intention_events(av, live)] == ["int-after-prose"]


# --------------------------------------------------------------------------
# record_intention
# --------------------------------------------------------------------------


def test_record_intention_capture_mints_a_uuid7_id(live, ctx, av):
    record(ctx, {"action": "capture", "text": DESCRIPTION, "summary": SUMMARY, "source": "ambient", "conditional": True})
    events = intention_events(av, live)
    assert types(events) == ["intention.captured"]
    event = events[0]
    assert uuid.UUID(event["intention_id"]).version == 7
    payload = event["payload"]
    assert payload["source"] == "ambient"
    assert payload["conditional"] is True
    assert payload["index_intent_id"] is None
    assert payload["capture_path"] == "record_intention"
    assert payload["text_hash"] == sha(DESCRIPTION)


@pytest.mark.parametrize(
    "result",
    [
        json.dumps({"intention_id": "local-8"}),
        # A native tool that returns its id beside a `result` message.
        json.dumps({"result": "Saved.", "intention_id": "local-8"}),
        # The same tool served over MCP: the id is inside the wrapped text.
        json.dumps({"result": json.dumps({"success": True, "data": {"intention_id": "local-8"}})}),
    ],
)
def test_record_intention_uses_the_id_its_tool_returned(live, ctx, av, result):
    fire_tool(ctx, "mcp__overlay__record_intention", {"action": "capture", "text": DESCRIPTION}, result)
    assert intention_events(av, live)[0]["intention_id"] == "local-8"


def test_record_intention_update_and_withdraw_use_the_returned_id(live, ctx, av):
    """The tool hands the agent its id; the agent names it on later calls."""
    record(ctx, {"action": "capture", "text": DESCRIPTION, "source": "onboarding"}, json.dumps({"intention_id": "local-1"}))
    returned = "local-1"  # what the tool's result told the agent
    record(ctx, {"action": "update", "intention_id": returned, "text": DESCRIPTION + "!"}, tool_call_id="c2")
    record(ctx, {"action": "archive", "intention_id": returned}, tool_call_id="c3")
    events = intention_events(av, live)
    assert types(events) == ["intention.captured", "intention.updated", "intention.withdrawn"]
    assert {e["intention_id"] for e in events} == {"local-1"}
    assert events[0]["payload"]["source"] == "onboarding"


@pytest.mark.parametrize("action", ["archive", "withdraw", "delete", " Withdraw "])
def test_record_intention_withdrawal_actions(live, ctx, av, action):
    record(ctx, {"action": action, "intention_id": "local-1"})
    events = intention_events(av, live)
    assert types(events) == ["intention.withdrawn"]
    assert events[0]["payload"]["text_hash"] is None


@pytest.mark.parametrize("action", ["retract", "capturing", "remove", "noop"])
def test_record_intention_unknown_action_emits_nothing(live, ctx, av, action):
    record(ctx, {"action": action, "intention_id": "local-1", "text": DESCRIPTION})
    assert intention_events(av, live) == []


def test_record_intention_with_no_action_and_no_id_emits_nothing(live, ctx, av):
    record(ctx, {"text": DESCRIPTION, "source": "message"})
    assert intention_events(av, live) == []


def test_record_intention_with_no_action_but_an_id_is_an_update(live, ctx, av):
    record(ctx, {"intention_id": "local-1", "text": DESCRIPTION})
    assert types(intention_events(av, live)) == ["intention.updated"]


def test_capture_of_an_existing_id_is_an_update(live, ctx, av):
    record(ctx, {"action": "capture", "intention_id": "local-1", "text": DESCRIPTION})
    events = intention_events(av, live)
    assert types(events) == ["intention.updated"]
    assert events[0]["intention_id"] == "local-1"


def test_record_update_without_text_emits_nothing(live, ctx, av):
    record(ctx, {"action": "update", "intention_id": "local-1", "conditional": True})
    assert intention_events(av, live) == []


def test_record_withdraw_without_an_id_is_not_emitted(live, ctx, av):
    record(ctx, {"action": "withdraw"})
    assert intention_events(av, live) == []


# --------------------------------------------------------------------------
# Source
# --------------------------------------------------------------------------


def test_index_create_in_a_conversation_is_message(live, ctx, av):
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created())
    assert intention_events(av, live)[0]["payload"]["source"] == "message"


def test_index_create_in_a_cron_session_is_ambient(live, ctx, av):
    """The nightly memory-signal sync calls `create_intent` from a cron run."""
    ctx.fire("on_session_start", session_id="sess-nightly", model="m", platform="cron")
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), session="sess-nightly")
    assert intention_events(av, live)[0]["payload"]["source"] == "ambient"


def test_a_cron_session_id_is_enough_without_a_session_start(live, ctx, av):
    fire_tool(
        ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), session="cron_abc123_20260922_031500"
    )
    assert intention_events(av, live)[0]["payload"]["source"] == "ambient"


def _delegate(ctx, parent, child):
    ctx.fire(
        "subagent_start",
        parent_session_id=parent,
        parent_turn_id="t",
        child_session_id=child,
        child_role="r",
        child_goal="g",
    )


def test_a_subagent_of_a_cron_run_is_ambient(live, ctx, av):
    ctx.fire("on_session_start", session_id="sess-nightly", model="m", platform="cron")
    _delegate(ctx, "sess-nightly", "sess-kid")
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), session="sess-kid")
    event = intention_events(av, live)[0]
    assert event["payload"]["source"] == "ambient"
    assert event["payload"]["parent_session_id"] == "sess-nightly"


def test_a_grandchild_of_a_cron_session_id_is_ambient(live, ctx, av):
    _delegate(ctx, "cron_job_20260922_031500", "sess-kid")
    _delegate(ctx, "sess-kid", "sess-grandkid")
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), session="sess-grandkid")
    assert intention_events(av, live)[0]["payload"]["source"] == "ambient"


def test_a_subagent_of_a_conversation_is_message(live, ctx, av):
    _delegate(ctx, SESSION, "sess-kid")
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), session="sess-kid")
    assert intention_events(av, live)[0]["payload"]["source"] == "message"


def test_record_onboarding_source_is_kept(live, ctx, av):
    record(ctx, {"action": "capture", "text": DESCRIPTION, "source": "onboarding"})
    assert intention_events(av, live)[0]["payload"]["source"] == "onboarding"


@pytest.mark.parametrize("source", [None, "", "telepathy", "index", 3])
def test_a_missing_or_unknown_record_source_is_ambient(live, ctx, av, source):
    args = {"action": "capture", "text": DESCRIPTION}
    if source is not None:
        args["source"] = source
    record(ctx, args)
    assert intention_events(av, live)[0]["payload"]["source"] == "ambient"


def test_record_in_a_cron_session_is_ambient_whatever_it_claims(live, ctx, av):
    record(ctx, {"action": "capture", "text": DESCRIPTION, "source": "message"}, session="cron_job_20260922_031500")
    assert intention_events(av, live)[0]["payload"]["source"] == "ambient"


# --------------------------------------------------------------------------
# What does not count
# --------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["error", "blocked"])
@pytest.mark.parametrize(
    "result",
    [json.dumps({"error": "boom"}), created()],
    ids=["error-body", "success-looking-body"],
)
def test_a_failed_or_blocked_call_records_nothing(live, ctx, av, status, result):
    """Hermes's status alone is enough, whatever the body looks like."""
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result, status=status)
    assert intention_events(av, live) == []


@pytest.mark.parametrize("status", ["timeout", "cancelled", "Timeout ", "interrupted"])
@pytest.mark.parametrize(
    "call",
    [
        ("mcp__index__create_intent", {"description": DESCRIPTION}),
        ("mcp__index__update_intent", {"id": "int-abc", "status": "archived"}),
        ("mcp__index__delete_intent", {"id": "int-abc"}),
        ("record_intention", {"action": "capture", "text": DESCRIPTION}),
        ("record_intention", {"action": "withdraw", "intention_id": "local-1"}),
    ],
    ids=["create", "withdraw-by-archive", "delete", "record-capture", "record-withdraw"],
)
def test_only_status_ok_records_an_intention(live, ctx, av, status, call):
    """Hermes also reports `timeout` and `cancelled`; neither is a recorded intention."""
    tool_name, args = call
    fire_tool(ctx, tool_name, args, created(), status=status)
    assert intention_events(av, live) == []


@pytest.mark.parametrize("status", ["ok", "OK", "", None])
def test_status_ok_or_empty_records(live, ctx, av, status):
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), status=status)
    assert len(intention_events(av, live)) == 1


@pytest.mark.parametrize("success", ["false", "true", None, 1, 0, "yes"])
def test_success_must_be_boolean_true(live, ctx, av, success):
    result = json.dumps({"result": json.dumps({"success": success, "data": {"intent": {"id": "int-x"}}})})
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, result)
    assert intention_events(av, live) == []


def test_an_index_refusal_records_nothing(live, ctx, av):
    """"Too vague" comes back as `success: false` inside an `ok` Hermes status."""
    fire_tool(
        ctx,
        "mcp__index__create_intent",
        {"description": "stuff"},
        index_result({"intent": {"id": "int-x"}}, success=False),
    )
    assert intention_events(av, live) == []


@pytest.mark.parametrize(
    "tool_name",
    ["mcp__other__create_intent", "mcp__index__read_intents", "mcp__index__search_intents", "shell", ""],
)
def test_other_tools_are_ignored(live, ctx, av, tool_name):
    fire_tool(ctx, tool_name, {"description": DESCRIPTION}, created())
    assert intention_events(av, live) == []


def test_the_bare_index_tool_name_is_recognised(live, ctx, av):
    fire_tool(ctx, "create_intent", {"description": DESCRIPTION}, created("int-b"))
    assert intention_events(av, live)[0]["intention_id"] == "int-b"


def test_two_creates_with_one_tool_call_id_both_emit(live, ctx, av):
    """Some providers reuse one `tool_call_id` for every call; ingest dedupes on `event_id`."""
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created("int-1"), tool_call_id="call-0")
    fire_tool(ctx, "mcp__index__create_intent", {"description": SUMMARY}, created("int-2"), tool_call_id="call-0")
    events = intention_events(av, live)
    assert [e["intention_id"] for e in events] == ["int-1", "int-2"]
    assert {e["tool_call_id"] for e in events} == {"call-0"}
    assert events[0]["event_id"] != events[1]["event_id"]


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
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), task_id=SESSION)
    assert intention_events(av, live)[0]["run_id"] is None


def test_a_subagent_capture_names_its_parent_session_in_the_payload(live, ctx, av):
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
        created("int-kid"),
        session="sess-child",
        task_id="task-child",
    )
    event = intention_events(av, live)[0]
    assert event["session_id"] == "sess-child"
    assert event["run_id"] == "task-child"
    assert event["parent_run_id"] is None
    assert event["payload"]["parent_session_id"] == SESSION


# --------------------------------------------------------------------------
# Id and status hygiene
# --------------------------------------------------------------------------


def test_a_sentence_in_any_id_or_status_never_reaches_the_buffer(plugin, ctx, monkeypatch, av):
    """Every id is pattern-checked; a failing id drops the event and counts it."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")

    # intention_id (from Index, so also the index_intent_id)
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(SENTENCE))
    # intention_id named by record_intention
    record(ctx, {"action": "update", "intention_id": SENTENCE, "text": DESCRIPTION})
    # index_intent_id named by record_intention
    record(ctx, {"action": "capture", "text": DESCRIPTION, "index_intent_id": SENTENCE})
    # tool_call_id: Hermes's, so nulled and the event kept
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created("int-ok"), tool_call_id=SENTENCE)
    # status: kept, as `other`
    fire_tool(ctx, "mcp__index__update_intent", {"id": "int-ok", "description": DESCRIPTION, "status": SENTENCE}, "{}")

    buffered = json.dumps(av.read_buffer(plugin._COLLECTOR))
    assert SENTENCE not in buffered
    assert "Alice" not in buffered
    events = intention_events(av, plugin)
    assert types(events) == ["intention.captured", "intention.updated"]
    assert events[0]["intention_id"] == "int-ok"
    assert events[0]["tool_call_id"] is None
    assert events[1]["payload"]["index_status"] == "other"
    assert plugin._COLLECTOR.intention_drops == {"intention_id": 2, "index_intent_id": 1}


@pytest.mark.parametrize("bad_id", ["", "x" * 129, "int abc", "int/abc", "int\nabc"])
def test_ids_outside_the_pattern_are_dropped(live, ctx, av, bad_id):
    record(ctx, {"action": "update", "intention_id": bad_id, "text": DESCRIPTION})
    assert intention_events(av, live) == []


def test_ids_inside_the_pattern_pass(live, ctx, av):
    record(ctx, {"action": "update", "intention_id": "A-z_0.9:" + "x" * 120, "text": DESCRIPTION})
    assert len(intention_events(av, live)) == 1


# --------------------------------------------------------------------------
# Lone surrogates
# --------------------------------------------------------------------------


def test_a_lone_surrogate_in_the_description_hashes(live, ctx, av):
    text = "cofounder " + LONE_SURROGATE
    fire_tool(ctx, "mcp__index__create_intent", {"description": text}, created())
    events = intention_events(av, live)
    assert types(events) == ["intention.captured"]
    assert events[0]["payload"]["text_hash"] == sha(text)
    assert live._COLLECTOR.sessions[SESSION].failure_count == 0


def test_a_lone_surrogate_in_an_id_drops_the_event(live, ctx, av):
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created("int" + LONE_SURROGATE))
    record(ctx, {"action": "update", "intention_id": "id" + LONE_SURROGATE, "text": DESCRIPTION})
    assert intention_events(av, live) == []
    assert live._COLLECTOR.sessions[SESSION].failure_count == 0


def test_a_lone_surrogate_in_the_status_becomes_other(live, ctx, av):
    fire_tool(
        ctx,
        "mcp__index__update_intent",
        {"id": "int-abc", "description": DESCRIPTION, "status": "archived" + LONE_SURROGATE},
        "{}",
    )
    events = intention_events(av, live)
    assert types(events) == ["intention.updated"]
    assert events[0]["payload"]["index_status"] == "other"


def test_sha256_text_accepts_a_lone_surrogate(plugin):
    core = sys.modules[f"{plugin.__name__}._core"]
    assert core.sha256_text(LONE_SURROGATE) == sha(LONE_SURROGATE)
    # Well-formed text is unchanged by `surrogatepass`.
    assert core.sha256_text(DESCRIPTION) == hashlib.sha256(DESCRIPTION.encode("utf-8")).hexdigest()


def test_an_unencodable_line_writes_nothing_and_the_buffer_keeps_working(plugin, home):
    core = sys.modules[f"{plugin.__name__}._core"]
    buffer = core.Buffer(str(home / "av-events" / "buffer"))
    buffer.append({"n": 1})
    with pytest.raises(UnicodeEncodeError):
        buffer.append({"bad": LONE_SURROGATE})
    buffer.append({"n": 2})
    lines = open(buffer._current, encoding="utf-8").read().splitlines()
    assert [json.loads(line) for line in lines] == [{"n": 1}, {"n": 2}]
    assert buffer.pending_count == 2


class _OsProxy:
    """Forwards to `os` except `write` (fails) and `close` (counted)."""

    def __init__(self) -> None:
        self.closed: list[int] = []

    def __getattr__(self, name):
        return getattr(os, name)

    def write(self, fd, data):
        raise OSError("disk full")

    def close(self, fd):
        self.closed.append(fd)
        os.close(fd)


def test_a_failed_write_closes_its_fd_exactly_once(plugin, home, monkeypatch):
    core = sys.modules[f"{plugin.__name__}._core"]
    buffer = core.Buffer(str(home / "av-events" / "buffer"))
    proxy = _OsProxy()
    closed = proxy.closed
    # Only `_core`'s view of `os` changes; the global module is untouched.
    monkeypatch.setattr(core, "os", proxy)
    with pytest.raises(OSError):
        buffer.append({"n": 1})
    assert len(closed) == 1
    assert buffer.pending_count == 0


# --------------------------------------------------------------------------
# Capture modes
# --------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_intention_text_never_leaves_in_any_mode(plugin, ctx, monkeypatch, av, mode):
    """§7.1 "with hashes only"; catalogue §A "text in the archive only" — `full` included."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), tool_call_id="c1")
    record(ctx, {"action": "capture", "text": DESCRIPTION, "summary": SUMMARY}, tool_call_id="c2")
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
    record(ctx, {"action": "capture", "text": DESCRIPTION, "summary": SUMMARY})
    payload = intention_events(av, plugin)[0]["payload"]
    assert "text_length" not in payload and "summary_length" not in payload


@pytest.mark.parametrize("mode", ["sanitized", "full"])
def test_sanitized_and_full_add_character_lengths_only(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    text = "café ☕ " + DESCRIPTION  # multi-byte: lengths count characters, not bytes
    record(ctx, {"action": "capture", "text": text, "summary": SUMMARY})
    payload = intention_events(av, plugin)[0]["payload"]
    assert payload["text_length"] == len(text) < len(text.encode("utf-8"))
    assert payload["summary_length"] == len(SUMMARY)
    assert "text" not in payload and "summary" not in payload


def test_a_secret_in_the_intention_text_does_not_leave(live, ctx, av):
    fire_tool(ctx, "mcp__index__create_intent", {"description": SECRET_DESCRIPTION}, created("i"))
    events = av.read_buffer(live._COLLECTOR)
    assert "sk-ant-" not in json.dumps(events)
    assert intention_events(av, live)[0]["payload"]["text_hash"] == sha(SECRET_DESCRIPTION)


# --------------------------------------------------------------------------
# Kill switches and idling
# --------------------------------------------------------------------------


def test_no_token_means_no_intention_events(plugin, ctx, av):
    plugin.register(ctx)
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created("i"))
    assert av.read_buffer(plugin._COLLECTOR) == []


def test_disabling_post_tool_call_disables_capture(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "post_tool_call")
    plugin.register(ctx)
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created("i"))
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
def test_malformed_results_emit_nothing_and_never_raise(live, ctx, av, result):
    results = ctx.fire(
        "post_tool_call",
        tool_name="mcp__index__create_intent",
        args={"description": 1},
        result=result,
        session_id=SESSION,
        tool_call_id="c",
        status="ok",
    )
    assert results == []
    assert intention_events(av, live) == []
    assert live._COLLECTOR.sessions[SESSION].failure_count == 0


def test_malformed_args_never_raise(live, ctx):
    for args in (None, "a string", ["list"], {"id": None, "status": 7, "description": ["x"]}):
        ctx.fire(
            "post_tool_call",
            tool_name="mcp__index__update_intent",
            args=args,
            result=created("i"),
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

    returned = ctx.fire(
        "post_tool_call",
        tool_name="mcp__index__create_intent",
        args=args,
        result=created(),
        session_id=SESSION,
        tool_call_id="c",
        status="ok",
    )

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
    """A valid create, but over the cap: the guard, not a missing id, stops it."""
    intentions = sys.modules[f"{live.__name__}._intentions"]
    padding = "x" * (intentions.MAX_RESULT_CHARS + 1)
    huge = index_result({"intent": {"id": "int-big", "summary": padding}})
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, huge)
    assert intention_events(av, live) == []
    # The same create under the cap is captured, so the cap is what stopped it.
    fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created("int-big"))
    assert [e["intention_id"] for e in intention_events(av, live)] == ["int-big"]


# --------------------------------------------------------------------------
# event_id idempotency across a retried flush
# --------------------------------------------------------------------------


def test_event_id_is_stable_across_a_retried_flush(plugin, ctx, monkeypatch, av):
    """Ingest dedupes on `event_id` (scenario 1), so a retry must resend the same ids."""
    with av.StubIngest(statuses=[503, 200]) as ingest:
        monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
        monkeypatch.setenv("AV_EVENTS_URL", ingest.url)
        plugin.register(ctx)
        fire_tool(ctx, "mcp__index__create_intent", {"description": DESCRIPTION}, created(), tool_call_id="c1")
        record(ctx, {"action": "capture", "text": DESCRIPTION}, tool_call_id="c2")
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
