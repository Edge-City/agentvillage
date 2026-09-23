"""Rules that hold across every event family this plugin emits (DATA-28)."""

from __future__ import annotations

import json
import re
import sqlite3
import uuid

import pytest

SESSION = "sess-all"
ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
EVENT = "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a"
PARTICIPANT = "0d6e2f1a-3b4c-4d5e-8f60-718293a4b5c6"
USER_TEXT = "please RSVP me, my password is hunter2"
TOOLS = [{"type": "function", "function": {"name": "terminal", "description": "run", "parameters": {}}}]
SYSTEM_PROMPT = "You are the resident agent."
ID_FIELDS = (
    "event_id", "session_id", "turn_id", "run_id", "parent_run_id", "tool_call_id", "intention_id",
    "opportunity_id", "decision_id", "action_id", "outcome_id",
)


def drive(ctx, home):
    """One of everything the plugin can emit from hooks."""
    (home / "memories").mkdir(exist_ok=True)
    (home / "memories" / "USER.md").write_text("Likes hardware.\n")
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    ctx.fire("pre_llm_call", session_id=SESSION, task_id="task-1", turn_id="t0", user_message=USER_TEXT)
    ctx.fire("pre_api_request", session_id=SESSION, task_id="task-1", turn_id="t0", api_request_id="r0",
             system_prompt=SYSTEM_PROMPT, request={"method": "POST", "body": {"tools": TOOLS}}, started_at=1.7e9)
    ctx.fire("post_api_request", session_id=SESSION, task_id="task-1", turn_id="t0", api_request_id="r0",
             usage={"input_tokens": 10, "output_tokens": 2}, api_duration=0.5, finish_reason="stop")
    command = f"curl -s -X POST https://api.edgeos.world/api/v1/event-participants/portal/register/{EVENT} -d '{{}}'"
    ctx.fire("post_tool_call", session_id=SESSION, task_id="task-1", turn_id="t0", tool_name="terminal",
             # EdgeOS answers an RSVP with the participant record; `{}` is not
             # evidence the RSVP landed and would (rightly) wait for nothing.
             args={"command": command},
             result=json.dumps({"output": json.dumps({"id": PARTICIPANT, "event_id": EVENT, "status": "registered"}),
                                "exit_code": 0}),
             tool_call_id="call-1", status="ok", duration_ms=10)
    command = f"curl -s https://api.edgeos.world/api/v1/events/portal/events/{EVENT}"
    body = json.dumps({"id": EVENT, "my_rsvp_status": "registered"})
    ctx.fire("post_tool_call", session_id=SESSION, task_id="task-1", turn_id="t0", tool_name="terminal",
             args={"command": command}, result=json.dumps({"output": body, "exit_code": 0}),
             tool_call_id="call-2", status="ok", duration_ms=10)
    ctx.fire("post_tool_call", session_id=SESSION, task_id="task-1", turn_id="t0",
             tool_name="mcp__index__create_intent", args={"description": "find a cofounder"},
             result=json.dumps({"result": json.dumps({"success": True, "data": {"intent": {"id": "int-1"}}})}),
             tool_call_id="call-3", status="ok", duration_ms=10)
    ctx.fire("post_llm_call", session_id=SESSION, task_id="task-1", turn_id="t0", assistant_response="Done?")
    ctx.fire("on_session_finalize", session_id=SESSION)


@pytest.fixture()
def drive_mode(plugin, ctx, monkeypatch, home, av):
    def run(mode):
        monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
        monkeypatch.setenv("AV_CAPTURE", mode)
        plugin.register(ctx)
        drive(ctx, home)
        return av.read_buffer(plugin._COLLECTOR)

    return run


EXPECTED = {
    "session.started", "message.in", "llm.call", "tool.call", "action.attempted", "action.receipted",
    "intention.captured", "message.out", "session.ended", "profile.updated",
}


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_every_family_is_emitted_in_every_mode(drive_mode, mode):
    types = {e["event_type"] for e in drive_mode(mode)}
    assert EXPECTED <= types, EXPECTED - types


@pytest.mark.parametrize("mode", ["metadata", "sanitized"])
def test_prompt_registered_only_in_full(drive_mode, home, mode):
    events = drive_mode(mode)
    assert "prompt.registered" not in {e["event_type"] for e in events}
    assert SYSTEM_PROMPT not in json.dumps(events)
    assert not (home / "av-events" / "seen.json").exists()


def test_full_registers_every_tools_hash_its_llm_calls_carry(drive_mode):
    """DATA-28 AC #1: a `prompt.registered` body for every distinct `tools_hash`."""
    events = drive_mode("full")
    hashes = {e["payload"]["tools_hash"] for e in events if e["event_type"] == "llm.call"}
    registered = {e["payload"]["hash"] for e in events
                  if e["event_type"] == "prompt.registered" and e["payload"]["kind"] == "tools"}
    assert hashes and hashes <= registered


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_no_participant_text_in_any_mode(drive_mode, mode):
    blob = json.dumps(drive_mode(mode))
    for leak in ("hunter2", "RSVP me", "find a cofounder", "Likes hardware"):
        assert leak not in blob, (mode, leak)


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_every_plugin_minted_id_is_a_v7_and_every_id_matches_the_pattern(drive_mode, mode):
    for event in drive_mode(mode):
        assert uuid.UUID(event["event_id"]).version == 7, event["event_type"]
        for field in ID_FIELDS:
            value = event[field]
            assert value is None or ID_PATTERN.match(value), (event["event_type"], field, value)
        if event["action_id"]:
            assert uuid.UUID(event["action_id"]).version == 7


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_only_a_receipted_action_claims_more_than_agent_report(drive_mode, mode):
    for event in drive_mode(mode):
        expected = "provider_receipt" if event["event_type"] == "action.receipted" else "agent_report"
        assert event["evidence_class"] == expected, event["event_type"]
        if expected == "provider_receipt":
            receipt = event["payload"]["receipt"]
            assert receipt["kind"] == "edgeos_confirming_read" and receipt["id"]


def test_the_only_v5_is_cron_run_and_it_matches_the_ingest_formula(plugin, ctx, monkeypatch, home, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", "tenant-x")
    plugin.register(ctx)
    drive(ctx, home)
    (home / "cron").mkdir()
    with sqlite3.connect(home / "cron" / "executions.db") as conn:
        conn.execute("CREATE TABLE executions (id TEXT, job_id TEXT, status TEXT, claimed_at TEXT, "
                     "started_at TEXT, finished_at TEXT)")
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        conn.execute("INSERT INTO executions VALUES ('e1','j1','completed',?,?,?)", (now, now, now))
    plugin._COLLECTOR.cron_tick()
    ns = uuid.UUID("6d1f2d4e-6a6b-5c29-9b3a-0f0f9b1d4a11")
    for event in av.read_buffer(plugin._COLLECTOR):
        version = uuid.UUID(event["event_id"]).version
        if event["event_type"] == "cron.run":
            assert event["event_id"] == str(uuid.uuid5(ns, "tenant-x|cron|e1"))
        else:
            assert version == 7, event["event_type"]


def test_a_failing_tool_call_does_not_cost_the_intention(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    monkeypatch.setattr(plugin, "tool_call_payload", lambda *a, **k: 1 / 0)
    ctx.fire("post_tool_call", session_id=SESSION, tool_name="mcp__index__create_intent",
             args={"description": "d"}, status="ok", tool_call_id="c1",
             result=json.dumps({"result": json.dumps({"success": True, "data": {"intent": {"id": "int-9"}}})}))
    types = [e["event_type"] for e in av.read_buffer(plugin._COLLECTOR)]
    assert "intention.captured" in types and "tool.call" not in types
    assert plugin._COLLECTOR.total_failures == 1


def test_a_failing_edgeos_path_does_not_cost_the_tool_call(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    monkeypatch.setattr(plugin._edgeos, "terminal_outcome", lambda result: 1 / 0)
    command = f"curl -s -X POST https://api.edgeos.world/api/v1/event-participants/portal/register/{EVENT}"
    ctx.fire("post_tool_call", session_id=SESSION, tool_name="terminal", args={"command": command},
             result="{}", status="ok", tool_call_id="c1")
    events = av.read_buffer(plugin._COLLECTOR)
    assert [e["event_type"] for e in events] == ["tool.call"]
    assert events[0]["payload"]["receipt"] is None
    assert plugin._COLLECTOR.total_failures == 1


def test_every_new_hook_path_is_off_under_the_global_kill_switch(plugin, ctx, monkeypatch, home, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    plugin.register(ctx)
    drive(ctx, home)
    assert plugin._COLLECTOR.cron_tick() == 0
    assert av.read_buffer(plugin._COLLECTOR) == []
    assert not (home / "av-events").exists()
