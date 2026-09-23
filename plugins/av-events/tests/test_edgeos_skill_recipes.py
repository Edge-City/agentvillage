"""The `edgeos` skill's own curl recipes, verbatim, are recognised (DATA-28 recheck R1).

The skill writes its recipes as multi-line `curl` with `\\`-newline
continuations; the agent copies them. If the parser does not read them, the
whole action path is dead in production while every hand-written test passes.
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[3] / "skills" / "edgeos" / "SKILL.md"
EVENT = "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a"
POPUP = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d"
SUBSTITUTIONS = {
    "{event_id}": EVENT,
    "{popup_id}": POPUP,
    "{occurrence_iso}": "2026-10-20T10:00:00Z",
    "{current_iso_timestamp}": "2026-10-11T00:00:00Z",
    "{start_iso}": "2026-10-11T00:00:00Z",
    "{end_iso}": "2026-10-12T00:00:00Z",
}


def recipes(section: str) -> list[str]:
    """Every ```bash block in `## <section>.` of the skill, verbatim."""
    text = SKILL.read_text(encoding="utf-8")
    body = re.search(rf"^## {section}\..*?(?=^## )", text, re.S | re.M).group(0)
    blocks = re.findall(r"```bash\n(.*?)```", body, re.S)
    out = []
    for block in blocks:
        for placeholder, value in SUBSTITUTIONS.items():
            block = block.replace(placeholder, value)
        out.append(block.rstrip("\n"))
    return out


@pytest.fixture()
def edgeos(plugin):
    return __import__(f"{plugin.__name__}._edgeos", fromlist=["_edgeos"])


def recognise(edgeos, command):
    call = edgeos.http_call("terminal", {"command": command})
    assert call is not None, command
    matched = edgeos.match_operation(call)
    assert matched is not None, command
    op, params = matched
    return call, op, params


def test_section_6_has_the_four_recipes_this_test_expects():
    commands = recipes(6)
    assert len(commands) == 4
    assert all("\\\n" in command for command in commands)  # multi-line, as the skill writes them


def test_every_section_6_recipe_is_recognised(edgeos):
    expected = [
        ("POST", f"/api/v1/event-participants/portal/register/{EVENT}", "edgeos.rsvp", "action", "rsvp"),
        ("POST", f"/api/v1/event-participants/portal/register/{EVENT}", "edgeos.rsvp", "action", "rsvp"),
        ("POST", f"/api/v1/event-participants/portal/cancel-registration/{EVENT}", "edgeos.cancel_rsvp",
         "action", "cancel_rsvp"),
        ("GET", "/api/v1/event-participants/portal/participants", "edgeos.participants_list", "read", None),
    ]
    for command, (method, path, operation, role, action_class) in zip(recipes(6), expected):
        call, op, params = recognise(edgeos, command)
        assert (call.method, call.path, op.operation, op.role, op.action_class) == (
            method, path, operation, role, action_class), command
        assert not call.piped
        if role == "action":
            assert params["event_id"] == EVENT


def label(edgeos, command):
    call = edgeos.http_call("terminal", {"command": command})
    matched = edgeos.match_operation(call) if call is not None else None
    return matched[0].operation if matched else None


@pytest.mark.parametrize("section,operations", [
    (3, ["edgeos.events_list"] * 5 + ["edgeos.event_read"]),
    # The profile update's body carries `"picture_url":"https://..."`: a URL
    # inside a request body is content, not a target, so it is recognised.
    (8, ["edgeos.profile_read", "edgeos.profile_update"]),
    (9, ["edgeos.directory_search"]),
])
def test_the_other_recipes_carry_their_labels(edgeos, section, operations):
    assert [label(edgeos, command) for command in recipes(section)] == operations


def test_a_verbatim_rsvp_recipe_waits_for_and_gets_its_receipt(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    register, _, _, _ = recipes(6)
    participant = {"id": str(uuid.uuid4()), "event_id": EVENT, "status": "registered"}
    ctx.fire("post_tool_call", session_id="s", tool_name="terminal", args={"command": register},
             result=json.dumps({"output": json.dumps(participant), "exit_code": 0}), status="ok")
    read = [c for c in recipes(3) if f"/events/portal/events/{EVENT}" in c][0]
    ctx.fire("post_tool_call", session_id="s", tool_name="terminal", args={"command": read},
             result=json.dumps({"output": json.dumps({"id": EVENT, "my_rsvp_status": "registered"}),
                                "exit_code": 0}), status="ok")
    events = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("action.")]
    assert [e["event_type"] for e in events] == ["action.attempted", "action.receipted"]
    assert events[1]["payload"]["receipt"]["id"] == participant["id"]


def test_a_continuation_does_not_hide_a_second_command(edgeos):
    command = recipes(6)[0] + " \\\n; curl -s https://api.edgeos.world/api/v1/humans/me"
    assert edgeos.http_call("terminal", {"command": command}) is None


def test_every_section_6_recipe_is_recognised_with_trailing_whitespace(edgeos):
    for command in recipes(6):
        for trailing in ("\n", "\n\n", "  \n"):
            call, _, _ = recognise(edgeos, command + trailing)
            assert call is not None
