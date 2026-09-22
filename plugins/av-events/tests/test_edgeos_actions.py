"""The EdgeOS path: RSVP → `action.attempted`, confirming read → `action.receipted`."""

from __future__ import annotations

import json
import uuid

import pytest

SESSION = "sess-edge"
EVENT = "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a"
OTHER_EVENT = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d"
API = "https://api.edgeos.world/api/v1"
KEY = "eos_live_SECRETKEYVALUE1234567890"


def curl(method, path, *, data=None):
    parts = ["curl -s"]
    if method != "GET":
        parts.append(f"-X {method}")
    parts.append(f'-H "Authorization: Bearer {KEY}"')
    parts.append('-H "Content-Type: application/json"')
    parts.append(f'"{API}{path}"')
    if data is not None:
        parts.append(f"-d '{data}'")
    return " ".join(parts)


def terminal_result(body, exit_code=0):
    output = body if isinstance(body, str) else json.dumps(body)
    return json.dumps({"output": output, "exit_code": exit_code, "error": None})


def fire(ctx, command, result, *, status="ok", tool_name="terminal", call_id="call-1", session=SESSION):
    ctx.fire(
        "post_tool_call",
        session_id=session,
        task_id="task-edge",
        turn_id="turn-1",
        tool_name=tool_name,
        args={"command": command},
        result=result,
        tool_call_id=call_id,
        duration_ms=300,
        status=status,
    )


def participant(event=EVENT, status="registered", occurrence=None):
    """The EventParticipantPublic record EdgeOS answers an RSVP or cancellation with."""
    return {"id": str(uuid.uuid4()), "event_id": event, "profile_id": str(uuid.uuid4()), "status": status,
            "occurrence_start": occurrence, "first_name": "Alice"}


def rsvp(ctx, event=EVENT, body=None, occurrence=None, **kw):
    """Fire an RSVP; returns the participant id EdgeOS answered with."""
    body = body if body is not None else participant(event, occurrence=occurrence)
    fire(ctx, curl("POST", f"/event-participants/portal/register/{event}", data="{}"), terminal_result(body), **kw)
    return body.get("id") if isinstance(body, dict) else None


def cancel(ctx, event=EVENT, occurrence=None, **kw):
    body = participant(event, "cancelled", occurrence)
    fire(ctx, curl("POST", f"/event-participants/portal/cancel-registration/{event}", data="{}"),
         terminal_result(body), **kw)
    return body["id"]


def read_event(ctx, event=EVENT, status="registered", occurrence=None, **kw):
    body = {"id": event, "title": "Hardware dinner with Alice", "my_rsvp_status": status}
    path = f"/events/portal/events/{event}" + (f"?occurrence_start={occurrence}" if occurrence else "")
    fire(ctx, curl("GET", path), terminal_result(body), **kw)


def of_type(av, plugin, *types):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] in types]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


def test_an_rsvp_is_attempted_and_a_confirming_read_receipts_it(live, ctx, av):
    participant_id = rsvp(ctx, call_id="c1")
    attempted = of_type(av, live, "action.attempted")
    assert len(attempted) == 1
    action_id = attempted[0]["action_id"]
    assert uuid.UUID(action_id).version == 7
    assert attempted[0]["tool_call_id"] == "c1"
    assert attempted[0]["evidence_class"] == "agent_report"
    payload = attempted[0]["payload"]
    assert payload["action_class"] == "rsvp"
    assert payload["target_system"] == "edgeos"
    assert payload["receipt"] is None
    assert payload["reversal"] is False and payload["reverses_action_id"] is None
    assert payload["edgeos_event_id"] == EVENT
    assert of_type(av, live, "action.receipted") == []

    read_event(ctx, call_id="c2")
    receipted = of_type(av, live, "action.receipted")
    assert len(receipted) == 1
    event = receipted[0]
    assert event["action_id"] == action_id
    assert event["tool_call_id"] == "c2"
    assert event["evidence_class"] == "provider_receipt"
    # The receipt names the participant record the RSVP created: the thing a
    # checker re-reads (`GET /event-participants/{id}`).
    assert event["payload"]["receipt"] == {"kind": "edgeos_confirming_read", "id": participant_id}
    assert event["payload"]["edgeos_event_id"] == EVENT
    assert event["payload"]["action_class"] == "rsvp"
    assert event["payload"]["operation"] == "edgeos.event_read"
    assert uuid.UUID(event["event_id"]).version == 7

    # The read's own tool.call carries the receipt reference too.
    calls = of_type(av, live, "tool.call")
    assert calls[-1]["payload"]["receipt"] == {"kind": "edgeos_confirming_read", "id": participant_id}
    assert calls[-1]["payload"]["operation"] == "edgeos.event_read"

    # Resolved: a second read receipts nothing more.
    read_event(ctx, call_id="c3")
    assert len(of_type(av, live, "action.receipted")) == 1


def test_a_read_that_does_not_show_the_rsvp_receipts_nothing(live, ctx, av):
    rsvp(ctx)
    read_event(ctx, status=None)
    read_event(ctx, status="cancelled")
    assert of_type(av, live, "action.receipted") == []
    # Still waiting: a later read that does show it receipts.
    read_event(ctx, status="registered")
    assert len(of_type(av, live, "action.receipted")) == 1


def test_a_list_read_can_confirm(live, ctx, av):
    rsvp(ctx)
    body = {"results": [
        {"id": OTHER_EVENT, "my_rsvp_status": "registered"},
        {"id": EVENT, "my_rsvp_status": "registered"},
    ], "paging": {}}
    fire(ctx, curl("GET", "/events/portal/events?popup_id=x&rsvped_only=true"), terminal_result(body))
    receipted = of_type(av, live, "action.receipted")
    assert [e["payload"]["edgeos_event_id"] for e in receipted] == [EVENT]


def test_a_read_without_my_rsvp_status_says_nothing(live, ctx, av):
    rsvp(ctx)
    fire(ctx, curl("GET", f"/events/portal/events/{EVENT}"), terminal_result({"id": EVENT, "title": "x"}))
    assert of_type(av, live, "action.receipted") == []


def test_a_failed_read_confirms_nothing(live, ctx, av):
    rsvp(ctx)
    body = {"id": EVENT, "my_rsvp_status": "registered"}
    fire(ctx, curl("GET", f"/events/portal/events/{EVENT}"), terminal_result(body, exit_code=7))
    fire(ctx, curl("GET", f"/events/portal/events/{EVENT}"), terminal_result(body), status="timeout")
    assert of_type(av, live, "action.receipted") == []


@pytest.mark.parametrize("status,exit_code,body,error", [
    ("error", 0, {}, "tool_error"),
    ("timeout", 0, {}, "tool_timeout"),
    ("cancelled", 0, {}, "tool_cancelled"),
    ("ok", 22, {}, "exit_nonzero"),
    ("ok", 0, {"detail": [{"msg": "event is full, sorry Alice"}]}, "edgeos_error"),
])
def test_a_failed_rsvp_is_attempted_and_failed_and_never_pending(live, ctx, av, status, exit_code, body, error):
    fire(ctx, curl("POST", f"/event-participants/portal/register/{EVENT}", data="{}"),
         terminal_result(body, exit_code=exit_code), status=status)
    attempted = of_type(av, live, "action.attempted")
    failed = of_type(av, live, "action.failed")
    assert len(attempted) == 1 and len(failed) == 1
    assert failed[0]["action_id"] == attempted[0]["action_id"]
    assert failed[0]["payload"]["error"] == error
    assert "Alice" not in json.dumps(av.read_buffer(live._COLLECTOR))
    read_event(ctx)
    assert of_type(av, live, "action.receipted") == []


def test_a_cancellation_reverses_the_rsvp_it_undoes(live, ctx, av):
    rsvp(ctx)
    rsvp_id = of_type(av, live, "action.attempted")[0]["action_id"]
    read_event(ctx)
    cancel(ctx)
    attempts = of_type(av, live, "action.attempted")
    cancel_event = attempts[-1]
    assert cancel_event["payload"]["action_class"] == "cancel_rsvp"
    assert cancel_event["payload"]["reversal"] is True
    assert cancel_event["payload"]["reverses_action_id"] == rsvp_id
    assert cancel_event["action_id"] != rsvp_id
    # A read showing the RSVP gone receipts the cancellation, still a reversal.
    read_event(ctx, status=None)
    receipted = of_type(av, live, "action.receipted")
    assert [e["action_id"] for e in receipted] == [rsvp_id, cancel_event["action_id"]]
    assert receipted[-1]["payload"]["reversal"] is True
    assert receipted[-1]["payload"]["reverses_action_id"] == rsvp_id


def test_a_cancellation_of_an_unknown_rsvp_is_still_a_reversal(live, ctx, av):
    cancel(ctx)
    payload = of_type(av, live, "action.attempted")[0]["payload"]
    assert payload["reversal"] is True
    assert payload["reverses_action_id"] is None


def test_a_failed_rsvp_is_not_what_a_cancellation_reverses(live, ctx, av):
    rsvp(ctx)
    good = of_type(av, live, "action.attempted")[0]["action_id"]
    fire(ctx, curl("POST", f"/event-participants/portal/register/{EVENT}", data="{}"),
         terminal_result({}), status="error")
    cancel(ctx)
    assert of_type(av, live, "action.attempted")[-1]["payload"]["reverses_action_id"] == good


def test_the_ledger_survives_a_restart(live, ctx, av, home):
    rsvp(ctx)
    action_id = of_type(av, live, "action.attempted")[0]["action_id"]
    assert (home / "av-events" / "edgeos_actions.json").exists()

    module = av.load_plugin()
    module._COLLECTOR = None
    module._REGISTERED = False
    ctx2 = type(ctx)()
    module.register(ctx2)
    try:
        ctx2.fire("on_session_start", session_id="sess-2", model="m", platform="telegram")
        read_event(ctx2, session="sess-2")
        receipted = [e for e in av.read_buffer(module._COLLECTOR) if e["event_type"] == "action.receipted"]
        assert [e["action_id"] for e in receipted] == [action_id]
        cancel(ctx2, session="sess-2")
        cancelled = [e for e in av.read_buffer(module._COLLECTOR) if e["event_type"] == "action.attempted"][-1]
        assert cancelled["payload"]["reverses_action_id"] == action_id
    finally:
        module._COLLECTOR = None
        module._REGISTERED = False


@pytest.mark.parametrize("command", [
    # Two curls: ambiguous, even to the same path (one RSVP or two?).
    curl("POST", f"/event-participants/portal/register/{EVENT}") + " && " + curl("GET", f"/events/portal/events/{EVENT}"),
    curl("POST", f"/event-participants/portal/register/{EVENT}") + "; "
    + curl("POST", f"/event-participants/portal/register/{EVENT}"),
    # Another host.
    f"curl -s -X POST https://evil.example.com/api/v1/event-participants/portal/register/{EVENT}",
    # Not a UUID.
    curl("POST", "/event-participants/portal/register/not-a-uuid"),
    # Two conflicting methods.
    f"curl -X POST -X GET {API}/event-participants/portal/register/{EVENT}",
    # No curl at all.
    f"echo {API}/event-participants/portal/register/{EVENT}",
    # Wrong method for the path.
    curl("GET", f"/event-participants/portal/register/{EVENT}"),
])
def test_an_ambiguous_or_foreign_call_is_not_an_action(live, ctx, av, command):
    fire(ctx, command, terminal_result({"status": "registered"}))
    assert of_type(av, live, "action.attempted", "action.failed", "action.receipted") == []


def test_only_carrier_tools_count(live, ctx, av):
    fire(ctx, curl("POST", f"/event-participants/portal/register/{EVENT}"), terminal_result({}),
         tool_name="mcp__someserver__terminal")
    fire(ctx, curl("POST", f"/event-participants/portal/register/{EVENT}"), terminal_result({}),
         tool_name="execute_code")
    assert of_type(av, live, "action.attempted") == []


def test_a_data_flag_implies_post(live, ctx, av):
    fire(ctx, f"curl -s {API}/event-participants/portal/register/{EVENT} --data '{{}}'",
         terminal_result(participant()))
    assert len(of_type(av, live, "action.attempted")) == 1


def test_read_and_write_operations_only_label_the_tool_call(live, ctx, av):
    fire(ctx, curl("GET", "/humans/me"), terminal_result({"first_name": "Alice"}))
    fire(ctx, curl("PATCH", "/humans/me", data='{"telegram":"alice"}'), terminal_result({}), call_id="c2")
    calls = of_type(av, live, "tool.call")
    assert [c["payload"]["operation"] for c in calls] == ["edgeos.profile_read", "edgeos.profile_update"]
    assert all(c["payload"]["target_system"] == "edgeos" for c in calls)
    assert of_type(av, live, "action.attempted", "action.receipted") == []


def test_nothing_from_the_command_or_the_response_leaves(live, ctx, av):
    rsvp(ctx)
    read_event(ctx)
    blob = json.dumps(av.read_buffer(live._COLLECTOR))
    for leak in (KEY, "SECRETKEY", "Authorization", "Hardware dinner", "Alice", "api.edgeos.world"):
        assert leak not in blob, leak


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_actions_are_emitted_in_every_capture_mode(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    rsvp(ctx)
    read_event(ctx)
    assert len(of_type(av, plugin, "action.attempted")) == 1
    assert len(of_type(av, plugin, "action.receipted")) == 1
    assert "Alice" not in json.dumps(av.read_buffer(plugin._COLLECTOR))


def test_no_token_means_no_actions_and_no_ledger(plugin, ctx, av, home):
    plugin.register(ctx)
    rsvp(ctx)
    assert av.read_buffer(plugin._COLLECTOR) == []
    assert not (home / "av-events" / "edgeos_actions.json").exists()


def test_an_unwritable_ledger_fails_open(live, ctx, av, monkeypatch):
    monkeypatch.setattr(live._COLLECTOR.edgeos, "save", lambda path: (_ for _ in ()).throw(OSError("ro")))
    assert ctx.fire("post_tool_call", session_id=SESSION, tool_name="terminal",
                    args={"command": curl("POST", f"/event-participants/portal/register/{EVENT}")},
                    result=terminal_result(participant()), status="ok") == []
    assert live._COLLECTOR.total_failures == 1
    # The events were buffered before the save was attempted.
    assert len(of_type(av, live, "tool.call")) == 1
    assert len(of_type(av, live, "action.attempted")) == 1


def test_the_seed_loads_and_compiles(plugin):
    edgeos = __import__(f"{plugin.__name__}._edgeos", fromlist=["_edgeos"])
    allowlist = edgeos.load_allowlist()
    assert allowlist.version == "edgeos_tool_allowlist_v1"
    assert allowlist.hosts == frozenset({"api.edgeos.world"})
    assert allowlist.carriers == frozenset({"terminal"})
    roles = {op.operation: op.role for op in allowlist.operations}
    assert roles["edgeos.rsvp"] == "action" and roles["edgeos.cancel_rsvp"] == "action"
    assert roles["edgeos.event_read"] == "confirming_read"
    empty = edgeos.load_allowlist("/nonexistent/edgeos.json")
    assert empty.operations == [] and edgeos.http_call("terminal", {"command": "curl x"}, empty) is None
