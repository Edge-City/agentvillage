"""The `edgeos` skill's own recipes, verbatim, are recognised (DATA-28 recheck R1).

Since v2.1.10 (EDGEOS-BLOCK step B) every recipe is a run of the skill's own
script, `bun skills/edgeos/scripts/edgeos.ts <verb> …`, not a curl: approval.md
core 0.4.6 refuses a curl naming `$EDGEOS_API_KEY` from the Hermes folder. The
agent copies the recipes; if the parser does not read them, the whole action
path is dead in production while every hand-written test passes. The v2.1.9
curl recipes are kept below (`LEGACY`) for sessions that still hold them, and
each must read as the same operation as the verb that replaced it.
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


SCRIPT_RUN = "bun skills/edgeos/scripts/edgeos.ts "


def fill(command: str) -> str:
    for placeholder, value in SUBSTITUTIONS.items():
        command = command.replace(placeholder, value)
    return command


def recipes(section: str) -> list[str]:
    """Every fenced shell block in `## <section>.` of the skill that runs the
    EdgeOS script, verbatim, placeholders filled."""
    text = SKILL.read_text(encoding="utf-8")
    body = re.search(rf"^## {section}\..*?(?=^## )", text, re.S | re.M).group(0)
    blocks = re.findall(r"```(?:sh|bash)\n(.*?)```", body, re.S)
    return [fill(block).rstrip("\n") for block in blocks if SCRIPT_RUN in block]


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
    assert all(command.startswith(SCRIPT_RUN) and "\n" not in command for command in commands)


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
    # DATA-454b: §8 has no curl; the profile goes through the script (pinned below).
    (8, []),
    # DATA-454: §9 has no curl; the directory goes through the script (pinned below).
    (9, []),
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
    read = recipe("Fetch a single event")
    ctx.fire("post_tool_call", session_id="s", tool_name="terminal", args={"command": read},
             result=json.dumps({"output": json.dumps({"id": EVENT, "my_rsvp_status": "registered"}),
                                "exit_code": 0}), status="ok")
    events = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("action.")]
    assert [e["event_type"] for e in events] == ["action.attempted", "action.receipted"]
    # The participant id leaves keyed (DATA-308).
    assert events[1]["payload"]["receipt"]["id"] == plugin._COLLECTOR.keyed_hash(participant["id"])


def test_a_verbatim_occurrence_rsvp_and_its_cancel_get_their_receipts(plugin, ctx, monkeypatch, av):
    """A recurring event: the RSVP's record names the occurrence, the verb's
    `--occurrence` read confirms it; the cancel reverses it and a read showing
    `cancelled` confirms that too."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    _, occurrence_rsvp, cancel, _ = recipes(6)
    occurrence = SUBSTITUTIONS["{occurrence_iso}"]
    cancel = f"{cancel} --occurrence {occurrence}"
    read = f'{recipe("Fetch a single event")} --occurrence {occurrence}'
    participant = {"id": str(uuid.uuid4()), "event_id": EVENT, "status": "registered", "occurrence_start": occurrence}

    def fire(command, body):
        ctx.fire("post_tool_call", session_id="s", tool_name="terminal", args={"command": command},
                 result=json.dumps({"output": json.dumps(body), "exit_code": 0}), status="ok")

    fire(occurrence_rsvp, participant)
    fire(read, {"id": EVENT, "my_rsvp_status": "registered"})
    fire(cancel, {**participant, "status": "cancelled"})
    fire(read, {"id": EVENT, "my_rsvp_status": "cancelled"})
    events = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("action.")]
    assert [(e["event_type"], e["payload"]["action_class"]) for e in events] == [
        ("action.attempted", "rsvp"), ("action.receipted", "rsvp"),
        ("action.attempted", "cancel_rsvp"), ("action.receipted", "cancel_rsvp")]
    assert all(e["payload"]["occurrence_start"] == "2026-10-20T10:00:00.000Z" for e in events)
    assert events[2]["payload"]["reversal"] is True and events[2]["payload"]["reverses_action_id"] is not None


def test_a_failed_script_rsvp_is_attempted_and_failed_and_waits_on_nothing(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    register = recipes(6)[0]
    ctx.fire("post_tool_call", session_id="s", tool_name="terminal", args={"command": register},
             result=json.dumps({"output": "edgeos: EdgeOS answered 404: Event not found\n", "exit_code": 1}), status="ok")
    events = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("action.")]
    assert [e["event_type"] for e in events] == ["action.attempted", "action.failed"]
    assert events[1]["payload"]["error"] == "exit_nonzero"


def test_a_continuation_does_not_hide_a_second_command(edgeos):
    command = recipes(6)[0] + " \\\n; curl -s https://api.edgeos.world/api/v1/humans/me"
    assert edgeos.http_call("terminal", {"command": command}) is None
    for tail in (" ; curl -s https://api.edgeos.world/api/v1/humans/me", " && true", " | jq .", " > out.json",
                 " 2>&1", "\nbun skills/edgeos/scripts/edgeos.ts rsvp " + EVENT):
        assert edgeos.http_call("terminal", {"command": recipes(6)[0] + tail}) is None, tail


def test_every_section_6_recipe_is_recognised_with_trailing_whitespace(edgeos):
    for command in recipes(6):
        for trailing in ("\n", "\n\n", "  \n"):
            call, _, _ = recognise(edgeos, command + trailing)
            assert call is not None


def test_the_legacy_curl_is_read_only_on_an_edgeos_base(edgeos, monkeypatch):
    """DATA-269: the base is the plugin's own `EDGEOS_API_BASE`, and only an
    allowlisted EdgeOS authority counts. Before, any value (a dev tunnel) was
    accepted, and with it the literal host it named — so whatever set that
    variable could make another host's answers read as EdgeOS receipts.
    (The script verbs need no such rule: the script itself refuses any base
    but https on an EdgeOS host under /api/v1 and sends nothing then.)"""
    register = LEGACY["RSVP to a one-off event"]
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
}


def every_recipe() -> list[tuple[str, str]]:
    """(heading, command) for every fenced shell block in the skill that runs
    the EdgeOS script, the heading being the last bold text before it."""
    text = SKILL.read_text(encoding="utf-8")
    out = []
    for block in re.finditer(r"```(?:sh|bash)\n(.*?)```", text, re.S):
        command = block.group(1)
        if SCRIPT_RUN not in command:
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
# EDGEOS-BLOCK step B (v2.1.10): the recipes are script verbs. approval.md core
# 0.4.6 refuses a curl whose header word holds `$EDGEOS_API_KEY` from the
# Hermes folder (the terminal's default directory) as `account.credential`.
# No agent-facing command names the key; each verb reads as the operation the
# v2.1.9 curl recipe it replaced was, with the same path parameters, so labels,
# RSVP actions and their receipts carry on unchanged.
# --------------------------------------------------------------------------

_AUTH = '-H "Authorization: Bearer $EDGEOS_API_KEY"'
_BASE = "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}"
#: The v2.1.9 curl recipes, verbatim (continuations joined), placeholders
#: filled: sessions begun before v2.1.10 may still run them.
LEGACY = {
    "List upcoming events": f'curl -s {_AUTH} --url "{_BASE}/events/portal/events?popup_id={POPUP}&event_status=published&start_after=2026-10-11T00:00:00Z&start_before=2026-10-12T00:00:00Z"',
    "List events in a date range": f'curl -s {_AUTH} --url "{_BASE}/events/portal/events?popup_id={POPUP}&event_status=published&start_after=2026-10-11T00:00:00Z&start_before=2026-10-12T00:00:00Z"',
    "Search events by title": f'curl -s {_AUTH} --url "{_BASE}/events/portal/events?popup_id={POPUP}&event_status=published&search=KEYWORD&start_after=2026-10-11T00:00:00Z"',
    "Filter by tag, kind, venue, or track": f'curl -s {_AUTH} --url "{_BASE}/events/portal/events?popup_id={POPUP}&event_status=published&tags=AI&tags=Privacy&start_after=2026-10-11T00:00:00Z&start_before=2026-10-12T00:00:00Z"',
    "Only events you've RSVPed to": f'curl -s {_AUTH} --url "{_BASE}/events/portal/events?popup_id={POPUP}&event_status=published&rsvped_only=true&start_after=2026-10-11T00:00:00Z"',
    "Fetch a single event": f'curl -s {_AUTH} --url "{_BASE}/events/portal/events/{EVENT}"',
    "RSVP to a one-off event": f'curl -s -X POST {_AUTH} -H "Content-Type: application/json" --url "{_BASE}/event-participants/portal/register/{EVENT}" -d \'{{}}\'',
    "RSVP to one occurrence of a recurring event": f'curl -s -X POST {_AUTH} -H "Content-Type: application/json" --url "{_BASE}/event-participants/portal/register/{EVENT}" -d \'{{"occurrence_start":"2026-10-20T10:00:00Z"}}\'',
    "Cancel a previous RSVP": f'curl -s -X POST {_AUTH} -H "Content-Type: application/json" --url "{_BASE}/event-participants/portal/cancel-registration/{EVENT}" -d \'{{}}\'',
    "List who is going to one event": f'curl -s {_AUTH} --url "{_BASE}/event-participants/portal/participants?event_id={EVENT}&skip=0&limit=100"',
    "List active venues for a popup": f'curl -s {_AUTH} --url "{_BASE}/event-venues/portal/venues?popup_id={POPUP}&limit=100"',
}


def test_every_recipe_is_one_script_run_and_none_names_the_key():
    found = every_recipe()
    assert len(found) == len(RECIPE_OPERATIONS) == len(LEGACY) == 11
    for heading, command in found:
        assert command.startswith(SCRIPT_RUN) and command.count("bun ") == 1, heading
        assert "$" not in command and "curl" not in command, heading
    # No agent-facing command anywhere in the skill names the key or runs curl.
    text = SKILL.read_text(encoding="utf-8")
    for block in re.findall(r"```[a-z]*\n(.*?)```", text, re.S):
        assert "EDGEOS_API_KEY" not in block and "curl" not in block, block
    for span in re.findall(r"`([^`\n]+)`", text):
        assert not re.match(r"\s*(curl|wget)\s", span), span
    assert "$EDGEOS_API_KEY" not in text


def test_the_scripts_run_from_the_absolute_hermes_folder_and_no_curl_sentence_is_left():
    """Replaces ov#436's pin (v2.1.9: curl from `~`, the bun scripts from the Hermes folder). With
    no curl left, the curl-from-`~` sentence goes; every run names its absolute `HERMES_HOME`
    workdir as AGENTS.md does (the approval gate refuses a `terminal` call without one), and a
    script not found means the wrong folder, never "EdgeOS unreachable" (review-b N5)."""
    text = SKILL.read_text(encoding="utf-8")
    flat = re.sub(r"\s+", " ", text)
    assert "workdir` set to your home directory (`~`)" not in text
    assert "Run every `curl` command" not in text
    assert ("Run every `bun skills/edgeos/scripts/…` command from your Hermes folder (the paths are relative to it): "
            "call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) "
            "and nothing else; the approval gate refuses a `terminal` call without that absolute `workdir`.") in flat
    assert "(a `workdir` is fine)" not in text
    assert ("If bun answers that the script or module was not found, the command ran from the wrong folder: run it "
            "again with `workdir` set to your absolute `HERMES_HOME` directory; that is not EdgeOS being unreachable") in flat


@pytest.mark.parametrize("base", [None, "https://api.edgeos.world/api/v1"])
@pytest.mark.parametrize("heading,command", every_recipe())
def test_each_verb_reads_as_the_curl_recipe_it_replaced(edgeos, monkeypatch, base, heading, command):
    if base is None:
        monkeypatch.delenv("EDGEOS_API_BASE", raising=False)
    else:
        monkeypatch.setenv("EDGEOS_API_BASE", base)
    verb_call, verb_op, verb_params = recognise(edgeos, command)
    old_call, old_op, old_params = recognise(edgeos, LEGACY[heading])
    assert (verb_call.method, verb_call.path, verb_op.operation, verb_op.role, verb_op.action_class) == (
        old_call.method, old_call.path, old_op.operation, old_op.role, old_op.action_class), heading
    assert verb_params == old_params, heading
    assert verb_op.operation == RECIPE_OPERATIONS[heading], heading
    assert not verb_call.piped


def test_a_second_url_flag_is_two_urls_and_not_a_request(edgeos):
    """curl fetches every `--url`; the observer reads one URL only, so a doubled
    `--url` stays unrecognised (README: "the same URL twice is two")."""
    command = LEGACY["Fetch a single event"]
    url = command[command.index("--url "):].split()[1]
    assert edgeos.http_call("terminal", {"command": f"{command} --url {url}"}) is None


@pytest.mark.parametrize("command", [
    # Not the script, or not only the script.
    f"bun ./skills/edgeos/scripts/edgeos.ts event {EVENT}",
    f"bun /root/.hermes/skills/edgeos/scripts/edgeos.ts event {EVENT}",
    f"bun run skills/edgeos/scripts/edgeos.ts event {EVENT}",
    f"cd /tmp && bun skills/edgeos/scripts/edgeos.ts event {EVENT}",
    f"FOO=1 bun skills/edgeos/scripts/edgeos.ts event {EVENT}",
    f"bun skills/edgeos/scripts/edgeos.ts event $EVENT",
    f"bun skills/edgeos/scripts/edgeos.ts event {EVENT} > /tmp/out",
    f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT}; bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT}",
    f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT}\nbun skills/edgeos/scripts/edgeos.ts cancel {EVENT}",
    f"bun skills/edgeos/scripts/events.ts --when today",
    # Arguments the script refuses: it sends nothing, so nothing is labelled.
    "bun skills/edgeos/scripts/edgeos.ts rsvp not-a-uuid",
    "bun skills/edgeos/scripts/edgeos.ts rsvp",
    f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT} --occurrence 2026-10-20T10:00:00",
    f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT} --occurrence 2026-02-30T10:00:00Z",
    f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT} --occurrence=2026-10-20T10:00:00Z",
    f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT} --occurrence 2026-10-20T10:00:00Z --occurrence 2026-10-21T10:00:00Z",
    f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT} --skip 0",
    f"bun skills/edgeos/scripts/edgeos.ts event {EVENT} extra",
    "bun skills/edgeos/scripts/edgeos.ts list --before 2026-10-12T00:00:00Z",
    "bun skills/edgeos/scripts/edgeos.ts list --after 2026-10-12T00:00:00Z --before 2026-10-11T00:00:00Z",
    "bun skills/edgeos/scripts/edgeos.ts venues --limit 1001",
    "bun skills/edgeos/scripts/edgeos.ts venues --popup not-a-uuid",
    "bun skills/edgeos/scripts/edgeos.ts delete " + EVENT,
])
def test_anything_but_one_clean_script_run_is_not_read(edgeos, command):
    assert edgeos.http_call("terminal", {"command": command}) is None, command


def test_the_verbs_name_the_occurrence_as_the_curl_did(edgeos):
    """An occurrence read keys the confirming read; quoted values read as the
    shell hands them over; repeated filters keep the first value, as
    `parse_query` does for a curl's query."""
    call = edgeos.http_call("terminal", {"command": f"bun skills/edgeos/scripts/edgeos.ts event {EVENT.upper()} --occurrence 2026-10-20T15:30:00+05:30"})
    assert call.path == f"/api/v1/events/portal/events/{EVENT}"
    # EDGEOS-OCCURRENCE: the script sends an offset as the same UTC instant, and the observer reads what it sends.
    assert call.query == {"occurrence_start": "2026-10-20T10:00:00Z"}
    call = edgeos.http_call("terminal", {"command": "bun skills/edgeos/scripts/edgeos.ts list --after 2026-10-11T00:00:00Z --search 'yoga class' --tag AI --tag Privacy\n"})
    assert call.query["search"] == "yoga class" and call.query["tags"] == "AI"
    assert edgeos.http_call("carrier-not-on-the-list", {"command": recipe("Fetch a single event")}) is None


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
    body = re.search(r"^## 8\..*?(?=^## )", text, re.S | re.M).group(0)
    assert "through the Agent Village control plane; read only" in body.splitlines()[0]
    # Neither the profile (DATA-454b) nor the directory (DATA-454) has a curl: both go through a script.
    assert "```bash" not in body and "curl -" not in body


def test_the_participants_recipe_names_one_event():
    """`GET /event-participants/portal/participants` takes a required
    `event_id`: it lists one event's participants, not the caller's RSVPs."""
    command = recipe("List who is going to one event")
    assert command.startswith(f"{SCRIPT_RUN}participants {EVENT}")
    text = SKILL.read_text(encoding="utf-8")
    assert "own RSVPs across events" not in text
    assert "no route that lists one person's RSVPs across events" in text
    assert recipe("Only events you've RSVPed to").endswith(" --rsvped")


def test_the_events_list_is_not_paged():
    """`GET /events/portal/events` has no `skip` or `limit`: it returns every
    match, and its `paging` is informational."""
    for heading, command in every_recipe():
        if command.startswith(f"{SCRIPT_RUN}list "):
            assert "--limit" not in command and "--skip" not in command, heading
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
    lists = [(h, c) for h, c in every_recipe() if c.startswith(f"{SCRIPT_RUN}list ")]
    assert len(lists) == 5
    script = (SKILL.parent / "scripts" / "edgeos.ts").read_text(encoding="utf-8")
    # The script, not the recipe, sends the popup and the status, on every list.
    assert 'q.set("popup_id", args.popup || popup);' in script
    assert 'q.set("event_status", "published");' in script
    for heading, command in lists:
        assert " --after " in command, heading
        assert "--popup" not in command, heading
    upcoming = recipe("List upcoming events")
    assert "--after 2026-10-11T00:00:00Z" in upcoming
    assert "--before 2026-10-12T00:00:00Z" in upcoming


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
    assert '--search "Priya"' in section(9)
    assert 'params.set("q", args.q)' in DIRECTORY_SCRIPT.read_text(encoding="utf-8")
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
    participation or platform handles. DATA-454b: the profile script prints
    eight of its fields (not EdgeOS's `id` or `tenant_id`), and §8 names
    exactly those."""
    text = SKILL.read_text(encoding="utf-8")
    assert "your own application content, registered participation" not in text
    assert "X handles" not in text
    fields = ("first_name", "last_name", "email", "telegram", "gender", "age", "residence", "picture_url")
    script = PROFILE_SCRIPT.read_text(encoding="utf-8")
    listed = re.search(r"PROFILE_FIELDS = \[(.*?)\]", script, re.S).group(1)
    assert re.findall(r'"([a-z_]+)"', listed) == list(fields)
    flat8 = re.sub(r"\s+", " ", section(8))
    assert "one line per filled-in field: " + ", ".join(f"`{f}`" for f in fields) + "." in flat8
    assert "`tenant_id`" not in flat8


def test_the_cancel_seed_path_is_the_portal_route():
    """EdgeOS has both `POST /events/{id}/cancel` (backoffice: an admin or an
    admin-owned key with `events:write`) and `POST /events/portal/events/{id}/cancel`
    (a resident who owns or hosts the event). A resident's agent can only aim
    at the portal one, so that is the path the seed labels."""
    ops = {op["operation"]: op for op in json.loads(SEED.read_text(encoding="utf-8"))["operations"]}
    assert (ops["edgeos.event_cancel"]["method"], ops["edgeos.event_cancel"]["path"]) == (
        "POST", "/api/v1/events/portal/events/{event_id}/cancel")
    assert ops["edgeos.participants_list"]["path"] == "/api/v1/event-participants/portal/participants"


# --------------------------------------------------------------------------
# DATA-454: the directory goes through the Agent Village control plane, by
# the script, on the resident's own Edge City grant held by the app. The box's
# EDGEOS_BEARER_TOKEN lives 15 minutes since EdgeOS v1.47, so §9's old curl
# answered 401 within minutes of provisioning.
# --------------------------------------------------------------------------

DIRECTORY_SCRIPT = SKILL.parent / "scripts" / "directory.ts"
PROFILE_SCRIPT = SKILL.parent / "scripts" / "profile.ts"


def section(number: int) -> str:
    text = SKILL.read_text(encoding="utf-8")
    return re.search(rf"^## {number}\..*?(?=^## )", text, re.S | re.M).group(0)


def test_section_9_runs_the_directory_script_and_no_curl():
    body = section(9)
    assert "Agent Village control plane" in body.splitlines()[0]
    runs = re.findall(r"```sh\n(.*?)```", body, re.S)
    assert len(runs) == 1
    commands = runs[0].strip().splitlines()
    assert commands and all(c.startswith("bun skills/edgeos/scripts/directory.ts") for c in commands)
    assert DIRECTORY_SCRIPT.is_file()
    assert "curl -" not in body and "```bash" not in body
    assert "EDGEOS_BEARER_TOKEN" not in body
    assert "/applications/my/directory" not in body
    # The terminal rule reads as §2's and §3's do.
    assert ("Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) "
            "and nothing else.") in body


def test_section_9_maps_the_script_exit_codes_to_the_fail_soft_answers():
    flat = re.sub(r"\s+", " ", section(9))
    assert "**Exit 2** means the directory isn't connected to this agent" in flat
    assert "follow §0" in flat and "don't retry in this conversation" in flat
    assert "**Exit 1** means it can't be reached right now" in flat
    assert "Never show the error text, a status code or a key." in flat
    flat0 = re.sub(r"\s+", " ", section(0))
    assert "When the script exits 2, tell the person the directory isn't connected" in flat0
    assert "never retry those calls with the API key" in flat0


def test_the_skill_no_longer_uses_the_bearer():
    """DATA-454b: the box's EDGEOS_BEARER_TOKEN dies 15 minutes after the agent
    is made, so the profile goes through the profile script as the directory
    does, and nothing in the skill names the bearer any more. The script exits
    4 when the person's sign-in to the app has lapsed."""
    text = SKILL.read_text(encoding="utf-8")
    assert "EDGEOS_BEARER_TOKEN" not in text
    assert "required_for: own profile (" not in text
    assert "directory, own profile (the directory and profile scripts send it to the Agent Village control plane only)" in text
    flat0 = re.sub(r"\s+", " ", section(0))
    assert "the person's own profile through the profile script (§8), the directory through the directory script (§9)" in flat0
    # The old expired-token rule is gone: signing in again is now exactly the fix.
    assert "don't suggest that signing in again will reconnect you" not in flat0
    assert "treat it like an unset one" not in flat0
    assert ("**Exit 4** (profile or directory script) means the person's Edge City sign-in in the Agent Village "
            "app has lapsed.") in flat0
    assert "Sign in once at https://agents.edgecity.live/signin and I can look them up again." in flat0
    assert "Never ask for a code, password or token." in flat0
    assert "Don't call again in this conversation unless the person says they have signed in; then try once." in flat0
    assert "Required for `/humans/me` only." not in section(1)
    for doc in (SKILL, ESMERALDA):
        assert "/applications/my/directory" not in doc.read_text(encoding="utf-8"), doc.name


def test_section_8_runs_the_profile_script_reads_only_and_sends_edits_to_the_app():
    body = section(8)
    runs = re.findall(r"```sh\n(.*?)```", body, re.S)
    assert len(runs) == 1
    commands = runs[0].strip().splitlines()
    assert commands and all(c.startswith("bun skills/edgeos/scripts/profile.ts") for c in commands)
    assert PROFILE_SCRIPT.is_file()
    assert "curl -" not in body and "```bash" not in body
    assert "PATCH" not in SKILL.read_text(encoding="utf-8")
    assert ("Call `terminal` with exactly `command` (plus `workdir` set to your absolute `HERMES_HOME` directory) "
            "and nothing else.") in body
    flat = re.sub(r"\s+", " ", body)
    assert "**Edits are made in the Edge City portal app, never by you.** There is no write call" in flat
    # Refute O-N3: the owner's profile is read and shared in their private chat only.
    assert ("**Private chat only.** Read and share the person's profile only in your private chat with them "
            "(or in your own scheduled job delivering to that private chat); never in a group or shared chat, "
            "and never for anyone but the person whose agent you are.") in flat
    # Refute O-N2: no bare "in the app" for edits anywhere in the skill.
    assert "themselves, in the app" not in SKILL.read_text(encoding="utf-8")
    assert "**Exit 4** means the person's sign-in to the Agent Village app has lapsed: follow §0" in flat
    assert "**Exit 2** means the profile isn't connected to this agent" in flat
    assert "Never show the error text, a status code or a key." in flat
    script = PROFILE_SCRIPT.read_text(encoding="utf-8")
    assert "BEARER_TOKEN" not in script
    assert "/edgeos/profile" in script and "/humans/me" in script
    # The directory script gives the same exit 4 for the same cause.
    assert "**Exit 4** means the person's sign-in to the Agent Village app has lapsed: follow §0." in re.sub(r"\s+", " ", section(9))
    assert 'signinLapsed("directory"' in DIRECTORY_SCRIPT.read_text(encoding="utf-8")


# --------------------------------------------------------------------------
# Security review of #437 (20 Oct): a script run is read only when the
# relative path names the installed script, and only with ASCII digits.
# --------------------------------------------------------------------------

RSVP_RUN = f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT}"


@pytest.fixture()
def box(home, tmp_path_factory, monkeypatch):
    """`home` is $HERMES_HOME; HOME is a separate clean directory (no global bunfig)."""
    user = tmp_path_factory.mktemp("user-home")
    monkeypatch.setenv("HOME", str(user))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    return home, user


def read(edgeos, command, **extra):
    return edgeos.http_call("terminal", {"command": command, **extra})


def test_review1_a_script_run_is_read_from_the_hermes_folder_only(edgeos, box, tmp_path_factory):
    hermes, user = box
    alias = tmp_path_factory.mktemp("alias") / "hermes-link"
    alias.symlink_to(hermes)
    for workdir in (None, "", str(hermes), str(hermes) + "/", str(alias)):
        extra = {} if workdir is None else {"workdir": workdir}
        assert read(edgeos, RSVP_RUN, **extra) is not None, workdir
    # Another directory could hold another file at the same relative path.
    other = tmp_path_factory.mktemp("other")
    (other / "skills" / "edgeos" / "scripts").mkdir(parents=True)
    (other / "skills" / "edgeos" / "scripts" / "edgeos.ts").write_text("console.log('{}')\n")
    for workdir in (str(user), "~", str(other), "skills", ".", str(hermes / "skills"), 7, ["/"]):
        assert read(edgeos, RSVP_RUN, workdir=workdir) is None, workdir


def test_review1_a_bunfig_that_could_preload_code_stops_the_read(edgeos, box):
    hermes, user = box
    assert read(edgeos, RSVP_RUN) is not None
    (hermes / "bunfig.toml").write_text('preload = ["./x.ts"]\n')
    assert read(edgeos, RSVP_RUN) is None
    assert read(edgeos, RSVP_RUN, workdir=str(hermes)) is None
    (hermes / "bunfig.toml").unlink()
    (user / ".bunfig.toml").write_text('preload = ["./x.ts"]\n')
    assert read(edgeos, RSVP_RUN) is None


def test_review1_a_run_elsewhere_forges_no_receipt(plugin, ctx, monkeypatch, av, box, tmp_path_factory):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    other = tmp_path_factory.mktemp("elsewhere")
    participant = {"id": str(uuid.uuid4()), "event_id": EVENT, "status": "registered"}
    for command, body in ((RSVP_RUN, participant),
                          (f"bun skills/edgeos/scripts/edgeos.ts event {EVENT}", {"id": EVENT, "my_rsvp_status": "registered"})):
        ctx.fire("post_tool_call", session_id="s", tool_name="terminal", args={"command": command, "workdir": str(other)},
                 result=json.dumps({"output": json.dumps(body), "exit_code": 0}), status="ok")
    assert [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("action.")] == []


@pytest.mark.parametrize("command", [
    f"bun skills/edgeos/scripts/edgeos.ts participants {EVENT} --skip ١٢",
    f"bun skills/edgeos/scripts/edgeos.ts participants {EVENT} --limit １２",
    "bun skills/edgeos/scripts/edgeos.ts venues --limit ١٢",
    "bun skills/edgeos/scripts/edgeos.ts venues --skip １２",
    f"bun skills/edgeos/scripts/edgeos.ts rsvp {EVENT} --occurrence 2026-10-2٠T10:00:00Z",
    f"bun skills/edgeos/scripts/edgeos.ts event {EVENT} --occurrence ２026-10-20T10:00:00Z",
    "bun skills/edgeos/scripts/edgeos.ts list --after 2026-10-11T00:00:00Z --before 2026-10-1٢T00:00:00Z",
])
def test_review2_non_ascii_digits_are_refused(edgeos, box, command):
    assert read(edgeos, command) is None
    ascii_form = command.translate(str.maketrans("٠١٢１２", "01212"))
    assert read(edgeos, ascii_form) is not None, ascii_form
