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
    "List who is going to one event": "edgeos.participants_list",
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


# --------------------------------------------------------------------------
# DATA-326: the skill text agrees with the EdgeOS source (sweep of 2026-10-05,
# p2p-lanes/edgeos-monorepo). File and line references are in the PR body.
# --------------------------------------------------------------------------

SEED = Path(__file__).resolve().parents[1] / "edgeos_tool_allowlist.json"
ESMERALDA = SKILL.parents[1] / "edge-esmeralda" / "SKILL.md"


def recipe(heading: str) -> str:
    return dict(every_recipe())[heading]


@pytest.mark.parametrize("doc", [SKILL, ESMERALDA], ids=["edgeos", "edge-esmeralda"])
def test_scope_strings_are_the_ones_edgeos_checks(doc):
    """`needs("portal:directory:read")` guards the directory; `/humans/me`
    needs `portal:profile:read` / `portal:profile:write`. The old underscore
    spellings match no scope EdgeOS defines."""
    text = doc.read_text(encoding="utf-8")
    assert "portal:directory_read" not in text
    assert "portal:self_read" not in text
    assert "portal:directory:read" in text


def test_the_skill_says_the_api_key_cannot_reach_the_directory_or_profile():
    text = SKILL.read_text(encoding="utf-8")
    section0 = re.search(r"^## 0\..*?(?=^## )", text, re.S | re.M).group(0)
    assert "cannot** reach the attendee directory" in section0
    assert "never retry those calls with the API key" in section0
    for number in (8, 9):
        body = re.search(rf"^## {number}\..*?(?=^## )", text, re.S | re.M).group(0)
        assert "human session token only" in body.splitlines()[0], number
    # The directory and profile recipes carry the human bearer, never the key.
    for heading in ("Search attendees in a popup", "Read the calling user's profile", "Update basic profile fields"):
        assert "<EDGEOS_BEARER_TOKEN>" in recipe(heading) and "<EDGEOS_API_KEY>" not in recipe(heading), heading


def test_the_participants_recipe_names_one_event():
    """`GET /event-participants/portal/participants` takes a required
    `event_id`: it lists one event's participants, not the caller's RSVPs."""
    command = recipe("List who is going to one event")
    assert f"/event-participants/portal/participants?event_id={EVENT}" in command
    text = SKILL.read_text(encoding="utf-8")
    assert "own RSVPs across events" not in text
    assert "no route that lists one person's RSVPs across events" in text
    assert "rsvped_only=true" in recipe("Only events you've RSVPed to")


def test_the_events_list_is_not_paged():
    """`GET /events/portal/events` has no `skip` or `limit`: it returns every
    match, and its `paging` is informational."""
    for heading, command in every_recipe():
        if "/events/portal/events?" in command:
            assert "limit=" not in command and "skip=" not in command, heading
    text = SKILL.read_text(encoding="utf-8")
    assert "**No pagination:** the events list returns every matching event in one response" in text
    assert "results.length < limit" not in text


@pytest.mark.parametrize("doc", [SKILL, ESMERALDA], ids=["edgeos", "edge-esmeralda"])
def test_list_responses_are_results_and_paging(doc):
    text = doc.read_text(encoding="utf-8")
    assert "pagination: {" not in text
    assert "paging: { offset, limit, total }" in text


# --------------------------------------------------------------------------
# DATA-326 follow-ups (lane B7b): more of the skill text against the source,
# p2p-lanes/edgeos-monorepo df0a10a. File and line references are in the PR.
# --------------------------------------------------------------------------

README = SKILL.parents[2] / "README.md"


def test_every_events_list_recipe_has_a_popup_status_and_window():
    """Without a window a recurring series is not expanded into occurrences
    (event/crud.py find_by_popup), so `rsvped_only` misses RSVPs to later
    instances; the 30-day recipe needs its end bound or it returns every
    future event."""
    lists = [(h, c) for h, c in every_recipe() if "/events/portal/events?" in c]
    assert len(lists) == 5
    for heading, command in lists:
        assert f"popup_id={POPUP}" in command and "event_status=published" in command, heading
        assert "start_after=" in command or "start_before=" in command, heading
    upcoming = recipe("List upcoming events")
    assert "start_after=2026-10-11T00:00:00Z" in upcoming
    assert "start_before=2026-10-12T00:00:00Z" in upcoming


def test_the_no_popup_id_path_is_described_as_the_source_has_it():
    """`list_portal_events` without `popup_id`: a popup-bound key falls back to
    its popup; anything else drops every filter but `search` and returns the
    100 newest-created rows. Nothing filters by `created_at`."""
    text = SKILL.read_text(encoding="utf-8")
    assert "filters by `created_at`" not in text
    section3 = re.search(r"^## 3\..*?(?=^## )", text, re.S | re.M).group(0)
    assert "ignores every filter except `search`" in section3
    assert "100 most recently created events" in section3
    assert "This API key does not have access to this popup" in section3


@pytest.mark.parametrize("doc", [SKILL, ESMERALDA, README], ids=["edgeos", "edge-esmeralda", "README"])
def test_no_pointer_to_an_openapi_recipe(doc):
    text = doc.read_text(encoding="utf-8")
    assert "§11" not in text
    assert "OpenAPI" not in text


def test_the_directory_search_parameter_is_q():
    """`list_attendees_directory(..., q, hide_empty_rows)`: there is no
    `search` parameter and no per-popup filter; `q` matches name, email and
    Telegram only."""
    assert "q=QUERY" in recipe("Search attendees in a popup")
    for doc in (SKILL, ESMERALDA):
        text = doc.read_text(encoding="utf-8")
        assert "?search=" not in text, doc.name
        assert "beyond `search`" not in text, doc.name
        assert "hide_empty_rows=true" in text, doc.name
    text = SKILL.read_text(encoding="utf-8")
    assert "with a name, organization, or role" not in text
    assert "does not search `role` or `organization`" in text


DIRECTORY_FIELDS = ("id", "first_name", "last_name", "email", "telegram", "role", "organization",
                    "residence", "age", "gender", "picture_url", "category", "participation",
                    "associated_attendees")
MASKABLE = ("first_name", "last_name", "email", "telegram", "role", "organization", "residence",
            "age", "gender")


@pytest.mark.parametrize("doc", [SKILL, ESMERALDA], ids=["edgeos", "edge-esmeralda"])
def test_the_directory_fields_are_the_ones_the_source_returns(doc):
    """`AttendeesDirectoryEntry` and `_build_directory_entry`: no
    `personal_goals`, `social_media` or `builder_*`; `associated_attendees`
    is always `[]`; nine fields can be masked as "*"."""
    text = doc.read_text(encoding="utf-8")
    for gone in ("personal_goals", "social_media", "builder_boolean", "builder_description", "start_date"):
        assert gone not in text, gone
    for field in DIRECTORY_FIELDS:
        assert f"`{field}`" in text, field
    masked = "can hide any of " + ", ".join(f"`{f}`" for f in MASKABLE[:-1]) + f" and `{MASKABLE[-1]}`"
    assert masked in text
    assert "always an empty list" in text
    assert "`picture_url`, `category` and `participation` are never masked" in text


def test_esmeralda_lists_no_venue_creation():
    text = ESMERALDA.read_text(encoding="utf-8")
    assert "POST /event-venues" not in text
    assert "Agents cannot create or change events or venues" in text


def test_the_participants_prose_says_what_a_missing_occurrence_start_does():
    """`find_by_event` with a host and no `occurrence_start` filters to
    `occurrence_start IS NULL`."""
    text = SKILL.read_text(encoding="utf-8")
    section6 = re.search(r"^## 6\..*?(?=^## )", text, re.S | re.M).group(0)
    assert "If you leave it out, the list holds only the RSVPs not tied to any occurrence" in section6
    assert "does **not** mean nobody is going" in section6


def test_the_profile_read_returns_only_the_self_fields():
    """`GET /humans/me` answers `HumanSelfPublic`: no application content,
    participation or platform handles."""
    text = SKILL.read_text(encoding="utf-8")
    assert "your own application content, registered participation" not in text
    assert "X handles" not in text


def test_the_cancel_seed_path_is_the_portal_route():
    """EdgeOS has both `POST /events/{id}/cancel` (backoffice: an admin or an
    admin-owned key with `events:write`) and `POST /events/portal/events/{id}/cancel`
    (a resident who owns or hosts the event). A resident's agent can only aim
    at the portal one, so that is the path the seed labels."""
    ops = {op["operation"]: op for op in json.loads(SEED.read_text(encoding="utf-8"))["operations"]}
    assert (ops["edgeos.event_cancel"]["method"], ops["edgeos.event_cancel"]["path"]) == (
        "POST", "/api/v1/events/portal/events/{event_id}/cancel")
    assert ops["edgeos.participants_list"]["path"] == "/api/v1/event-participants/portal/participants"
