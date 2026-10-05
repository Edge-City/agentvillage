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
    # The participant id leaves keyed (DATA-308).
    assert events[1]["payload"]["receipt"]["id"] == plugin._COLLECTOR.keyed_hash(participant["id"])


def test_a_continuation_does_not_hide_a_second_command(edgeos):
    command = recipes(6)[0] + " \\\n; curl -s https://api.edgeos.world/api/v1/humans/me"
    assert edgeos.http_call("terminal", {"command": command}) is None


def test_every_section_6_recipe_is_recognised_with_trailing_whitespace(edgeos):
    for command in recipes(6):
        for trailing in ("\n", "\n\n", "  \n"):
            call, _, _ = recognise(edgeos, command + trailing)
            assert call is not None


def test_recipes_are_read_only_on_an_edgeos_base(edgeos, monkeypatch):
    """DATA-269: the base is the plugin's own `EDGEOS_API_BASE`, and only an
    allowlisted EdgeOS authority counts. Before, any value (a dev tunnel) was
    accepted, and with it the literal host it named — so whatever set that
    variable could make another host's answers read as EdgeOS receipts."""
    register = recipes(6)[0]
    monkeypatch.setenv("EDGEOS_API_BASE", "https://api.edgeos.world/api/v1")
    call, op, _ = recognise(edgeos, register)
    assert (call.path, op.operation) == (f"/api/v1/event-participants/portal/register/{EVENT}", "edgeos.rsvp")
    monkeypatch.setenv("EDGEOS_API_BASE", "https://edgeos-dev.example.test/api/v1")
    assert edgeos.http_call("terminal", {"command": register}) is None
    # A literal production URL is still EdgeOS; an unrelated host, or the dev
    # host written out, is not.
    literal = register.replace("${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}", "https://api.edgeos.world/api/v1")
    assert edgeos.http_call("terminal", {"command": literal}) is not None
    foreign = register.replace("${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}", "https://evil.example/api/v1")
    assert edgeos.http_call("terminal", {"command": foreign}) is None
    dev = literal.replace("api.edgeos.world", "edgeos-dev.example.test")
    assert edgeos.http_call("terminal", {"command": dev}) is None
    monkeypatch.delenv("EDGEOS_API_BASE")
    assert edgeos.http_call("terminal", {"command": dev}) is None
    assert recognise(edgeos, register)[1].operation == "edgeos.rsvp"


# --------------------------------------------------------------------------
# DATA-269: every recipe in the skill, by its heading, against one table
# --------------------------------------------------------------------------

#: Each recipe's bold heading in `skills/edgeos/SKILL.md` (parenthetical and
#: trailing colon dropped) → the operation it must be classified as. A recipe
#: added, renamed or removed in the skill fails
#: `test_the_recipe_table_names_every_recipe_in_the_skill` until this table
#: follows; a recipe the classifier stops reading fails the table test.
RECIPE_OPERATIONS = {
    "List upcoming events": "edgeos.events_list",
    "List events in a date range": "edgeos.events_list",
    "Search events by title": "edgeos.events_list",
    "Filter by tag, kind, venue, or track": "edgeos.events_list",
    "Only events you've RSVPed to": "edgeos.events_list",
    "Fetch a single event": "edgeos.event_read",
    "RSVP to a one-off event": "edgeos.rsvp",
    "RSVP to one occurrence of a recurring event": "edgeos.rsvp",
    "Cancel a previous RSVP": "edgeos.cancel_rsvp",
    "List your own RSVPs across events": "edgeos.participants_list",
    "List active venues for a popup": "edgeos.venues_list",
    "Read the calling user's profile": "edgeos.profile_read",
    "Update basic profile fields": "edgeos.profile_update",
    "Search attendees in a popup": "edgeos.directory_search",
}


def every_recipe() -> list[tuple[str, str]]:
    """(heading, command) for every ```bash block in the skill that runs curl,
    the heading being the last bold text before it."""
    text = SKILL.read_text(encoding="utf-8")
    out = []
    for block in re.finditer(r"```bash\n(.*?)```", text, re.S):
        command = block.group(1)
        if "curl" not in command:
            continue
        headings = re.findall(r"\*\*(.+?)\*\*", text[:block.start()])
        heading = re.sub(r"\s*\(.*\)", "", headings[-1]).rstrip(":").strip()
        for placeholder, value in SUBSTITUTIONS.items():
            command = command.replace(placeholder, value)
        out.append((heading, command.rstrip("\n")))
    return out


def test_the_recipe_table_names_every_recipe_in_the_skill():
    headings = [heading for heading, _ in every_recipe()]
    assert len(headings) == len(set(headings)), headings
    assert sorted(headings) == sorted(RECIPE_OPERATIONS)


@pytest.mark.parametrize("base", [None, "", "https://api.edgeos.world/api/v1"])
@pytest.mark.parametrize("heading,command", every_recipe())
def test_every_recipe_in_the_skill_is_classified(edgeos, monkeypatch, base, heading, command):
    if base is None:
        monkeypatch.delenv("EDGEOS_API_BASE", raising=False)
    else:
        monkeypatch.setenv("EDGEOS_API_BASE", base)
    call, op, params = recognise(edgeos, command)
    assert op.operation == RECIPE_OPERATIONS[heading], heading
    assert not call.piped, heading
    if op.role == "action":
        assert params["event_id"] == EVENT
