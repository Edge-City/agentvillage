"""A receipt only for the EdgeOS call that actually ran (DATA-269).

Each case here is a parser differential between `_edgeos.http_call` and the
shell or curl: a command the plugin read as an EdgeOS call while the shell
ran something else. The fixture output is what the other host (or the
command) would print; the test shows the plugin no longer emits any
`action.*` event for it and leaves the `tool.call` without an EdgeOS label.
"""

from __future__ import annotations

import json
import uuid

import pytest

SESSION = "sess-edge"
EVENT = "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a"
API = "https://api.edgeos.world/api/v1"
EVIL = "https://evil.example/api/v1"
REGISTER = f"/event-participants/portal/register/{EVENT}"
READ = f"/events/portal/events/{EVENT}"
REGISTER_URL = f"{API}{REGISTER}"
READ_URL = f"{API}{READ}"
REGISTERED = {"id": EVENT, "my_rsvp_status": "registered"}
BASE = '"${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}'


def terminal_result(body, exit_code=0):
    output = body if isinstance(body, str) else json.dumps(body)
    return json.dumps({"output": output, "exit_code": exit_code, "error": None})


def participant():
    return {"id": str(uuid.uuid4()), "event_id": EVENT, "status": "registered"}


def fire(ctx, command, body, call_id):
    ctx.fire("post_tool_call", session_id=SESSION, task_id="t", turn_id="turn-1", tool_name="terminal",
             args={"command": command}, result=terminal_result(body), tool_call_id=call_id, duration_ms=5,
             status="ok")


def of_type(av, plugin, *types):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] in types]


def action_events(av, plugin):
    return of_type(av, plugin, "action.attempted", "action.failed", "action.receipted")


def labels(av, plugin):
    return [e["payload"]["operation"] for e in of_type(av, plugin, "tool.call")]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.delenv("EDGEOS_API_BASE", raising=False)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


@pytest.fixture()
def edgeos(plugin):
    return __import__(f"{plugin.__name__}._edgeos", fromlist=["_edgeos"])


def classify(edgeos, command):
    call = edgeos.http_call("terminal", {"command": command})
    matched = edgeos.match_operation(call) if call is not None else None
    return matched[0].operation if matched else None


def forged_pair(ctx, rsvp_command, read_command):
    """An RSVP answered with a participant record, then a read answered
    `registered`: the two outputs a forger's server (or `echo`) prints."""
    fire(ctx, rsvp_command, participant(), "c1")
    fire(ctx, read_command, REGISTERED, "c2")


def assert_no_receipt_and_no_label(av, live):
    assert action_events(av, live) == []
    assert labels(av, live) == [None, None]


# --------------------------------------------------------------------------
# Full matches: a trailing newline is not part of a UUID or a path
# --------------------------------------------------------------------------


def test_a_uuid_with_a_trailing_newline_is_not_a_uuid(edgeos):
    assert edgeos.participant_record({"id": str(uuid.uuid4()) + "\n", "event_id": EVENT}, EVENT) is None
    assert edgeos.rsvp_statuses({"id": EVENT + "\n", "my_rsvp_status": "registered"}, {}) == []
    assert edgeos.UUID_RE.fullmatch(EVENT) is not None


def test_a_path_with_a_trailing_newline_matches_no_operation(edgeos):
    assert edgeos.match_operation(edgeos.HttpCall("POST", REGISTER_URL[len("https://api.edgeos.world"):] + "\n", {})) is None
    assert edgeos.match_operation(edgeos.HttpCall("POST", f"/api/v1{REGISTER}", {}))[0].operation == "edgeos.rsvp"


def test_a_ledger_entry_with_a_trailing_newline_is_dropped(edgeos):
    ledger = edgeos.Ledger()
    good = {"action_id": "0190f0f0-0000-7000-8000-000000000000", "action_class": "rsvp", "at": 1.0,
            "reversal": False, "reverses_action_id": None, "participant_id": str(uuid.uuid4())}
    assert edgeos._valid_pending(good)
    assert not edgeos._valid_pending({**good, "participant_id": good["participant_id"] + "\n"})
    assert not edgeos._valid_key(f"{EVENT}\n|")
