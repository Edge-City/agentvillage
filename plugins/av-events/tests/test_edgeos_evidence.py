"""EdgeOS actions: positive evidence only, a careful curl parser, occurrences (DATA-28 refutation)."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid

import pytest

SESSION = "sess-edge"
EVENT = "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a"
OTHER_EVENT = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d"
API = "https://api.edgeos.world/api/v1"
REGISTER_URL = f"{API}/event-participants/portal/register/{EVENT}"
REGISTERED = {"id": EVENT, "my_rsvp_status": "registered"}


def terminal_result(body, exit_code=0):
    output = body if isinstance(body, str) else json.dumps(body)
    return json.dumps({"output": output, "exit_code": exit_code, "error": None})


def fire(ctx, command, result, *, status="ok", call_id="call-1"):
    ctx.fire("post_tool_call", session_id=SESSION, task_id="task-edge", turn_id="turn-1", tool_name="terminal",
             args={"command": command}, result=result, tool_call_id=call_id, duration_ms=300, status=status)


def participant(event=EVENT, status="registered", occurrence=None):
    return {"id": str(uuid.uuid4()), "event_id": event, "profile_id": str(uuid.uuid4()), "status": status,
            "occurrence_start": occurrence, "first_name": "Alice"}


def rsvp(ctx, event=EVENT, occurrence=None, call_id="call-1"):
    body = participant(event, occurrence=occurrence)
    fire(ctx, f"curl -s -X POST '{API}/event-participants/portal/register/{event}' -d '{{}}'",
         terminal_result(body), call_id=call_id)
    return body["id"]


def cancel(ctx, event=EVENT, call_id="call-1"):
    body = participant(event, "cancelled")
    fire(ctx, f"curl -s -X POST '{API}/event-participants/portal/cancel-registration/{event}' -d '{{}}'",
         terminal_result(body), call_id=call_id)
    return body["id"]


def read_event(ctx, event=EVENT, status="registered", occurrence=None, call_id="call-1"):
    query = f"?occurrence_start={occurrence}" if occurrence else ""
    fire(ctx, f"curl -s '{API}/events/portal/events/{event}{query}'",
         terminal_result({"id": event, "my_rsvp_status": status}), call_id=call_id)


def of_type(av, plugin, *types):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] in types]


def actions(av, plugin):
    return [(e["event_type"], e["evidence_class"])
            for e in of_type(av, plugin, "action.attempted", "action.failed", "action.receipted")]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


# --------------------------------------------------------------------------
# H1 — positive evidence (probes p1 / p2)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("label,command,body", [
    ("attacker-host", f'curl -s -X POST https://evil.example/r -H "Referer: {REGISTER_URL}"', None),
    ("echo-dry-run", f"echo curl -X POST {REGISTER_URL}", f"curl -X POST {REGISTER_URL}"),
    ("curl -G", f"curl -s -G -d x=1 {REGISTER_URL}", "<html>405</html>"),
    ("502-html", f"curl -s -X POST {REGISTER_URL} -d '{{}}'", "<html>502 Bad Gateway</html>"),
    ("unauthorized", f"curl -s -X POST {REGISTER_URL} -d '{{}}'", {"message": "Unauthorized"}),
    ("empty-object", f"curl -s -X POST {REGISTER_URL} -d '{{}}'", {}),
    ("wrong-event", f"curl -s -X POST {REGISTER_URL} -d '{{}}'", participant(OTHER_EVENT)),
    ("non-uuid-id", f"curl -s -X POST {REGISTER_URL} -d '{{}}'", {"id": "p1", "event_id": EVENT}),
    ("empty-output", f"curl -s -X POST {REGISTER_URL} -d '{{}}'", ""),
    ("second-host", f"curl -s -X POST {REGISTER_URL} -d '{{}}' && echo https://evil.example/x", None),
    ("port-8443", f"curl -s -X POST https://api.edgeos.world:8443/api/v1/event-participants/portal/register/{EVENT}",
     None),
    ("userinfo", f"curl -s -X POST https://x@api.edgeos.world/api/v1/event-participants/portal/register/{EVENT}",
     None),
])
def test_a_read_never_confirms_an_rsvp_without_positive_evidence(live, ctx, av, label, command, body):
    fire(ctx, command, terminal_result(participant() if body is None else body), call_id="c1")
    fire(ctx, f"curl -s {API}/events/portal/events/{EVENT}", terminal_result(REGISTERED), call_id="c2")
    fire(ctx, f"curl -s {API}/events/portal/events/{EVENT}",
         terminal_result({"id": EVENT, "my_rsvp_status": None}), call_id="c3")
    assert of_type(av, live, "action.receipted") == [], label
    assert live._COLLECTOR.edgeos.pending == {}, label


@pytest.mark.parametrize("label,output,expected", [
    ("-w status appended", '{"detail":"Event is full"}403',
     [("action.attempted", "agent_report"), ("action.failed", "agent_report")]),
    ("jq pretty error", '{\n  "detail": "Event is full"\n}',
     [("action.attempted", "agent_report"), ("action.failed", "agent_report")]),
    ("message only", json.dumps({"message": "Unauthorized"}),
     [("action.attempted", "agent_report"), ("action.failed", "agent_report")]),
    ("html", "<html>502</html>", [("action.attempted", "agent_report")]),
])
def test_unconfirmed_outcomes_are_reported_but_never_wait(live, ctx, av, label, output, expected):
    fire(ctx, f"curl -s -X POST {REGISTER_URL} -d '{{}}'", terminal_result(output))
    assert actions(av, live) == expected, label
    assert live._COLLECTOR.edgeos.pending == {}
    failed = of_type(av, live, "action.failed")
    assert "full" not in json.dumps(failed) and "Unauthorized" not in json.dumps(failed)


@pytest.mark.parametrize("command", [
    f"curl -sX POST {REGISTER_URL}",
    f"curl -sXPOST {REGISTER_URL}",
    f"curl -sSfL -X POST {REGISTER_URL}",
    f"curl --request POST {REGISTER_URL}",
    f"curl --request=POST {REGISTER_URL}",
    f"curl -G -X POST {REGISTER_URL}",  # -X wins, as in curl
    f"curl -s -X POST https://api.edgeos.world:443/api/v1/event-participants/portal/register/{EVENT}",
    f"curl -s -X POST --url {REGISTER_URL} -H 'Authorization: Bearer x'",
    f"cd /tmp && curl -s -X POST '{REGISTER_URL}' -d '{{}}'",
    f"cd /tmp; curl -s -X POST '{REGISTER_URL}'",
    f"/usr/bin/curl -s -X POST {REGISTER_URL}",
])
def test_combined_flags_and_an_explicit_port_are_read(live, ctx, av, command):
    body = participant()
    fire(ctx, command, terminal_result(body))
    assert actions(av, live) == [("action.attempted", "agent_report")], command
    read_event(ctx)
    assert [e["payload"]["receipt"]["id"] for e in of_type(av, live, "action.receipted")] == [body["id"]]


@pytest.mark.parametrize("command", [
    f'curl -s -X POST {REGISTER_URL} -H "Referer: {API}/events/portal/events/{OTHER_EVENT}"',
    f"curl -s -X POST {REGISTER_URL} {API}/event-participants/portal/register/{OTHER_EVENT}",
    f"for e in {EVENT}; do curl -s -X POST {API}/event-participants/portal/register/$e; done",
    f"curl -s -X POST '{REGISTER_URL}",
    f"curl -s -X POST {REGISTER_URL}; curl -s -X POST {REGISTER_URL}",
    # Each of these would otherwise read as a well-formed RSVP with a participant record.
    f"echo curl -X POST {REGISTER_URL}",
    f"curl -s -G -d x=1 {REGISTER_URL}",
    f'curl -s -X POST {REGISTER_URL} -H "Origin: https://evil.example/api/v1/event-participants/portal/register/{EVENT}"',
    # The same URL twice is still two URL arguments.
    f"curl -s -X POST {REGISTER_URL} {REGISTER_URL}",
    # Anything after the curl: a second command, a pipe, a redirect, a new line.
    f"curl -s -X POST {REGISTER_URL}; echo done",
    f"curl -s -X POST {REGISTER_URL} && echo done",
    f"curl -s -X POST {REGISTER_URL} || echo failed",
    f"curl -s -X POST {REGISTER_URL} | jq .",
    f"curl -s -X POST {REGISTER_URL} > out.json",
    f"curl -s -X POST {REGISTER_URL}\necho done",
    # An operator where curl expects an option's value: the shell ends the
    # command there, so the value is not what the argv reader would take.
    f"curl -s -X POST {REGISTER_URL} -d ;",
    f"curl -s -X POST {REGISTER_URL} -d\nls",
    f"curl -s -X POST {REGISTER_URL} -d \"$(cat body.json)\"",
    f"curl -s -X POST {REGISTER_URL} -d `cat body.json`",
    # Options that redirect the request or drop the host check.
    f"curl -s -X POST --resolve api.edgeos.world:443:10.0.0.1 {REGISTER_URL}",
    f"curl -s -X POST --connect-to api.edgeos.world:443:evil.example:443 {REGISTER_URL}",
    f"curl -s -X POST -x http://proxy.example:8080 {REGISTER_URL}",
    f"curl -s -X POST --proxy=http://proxy.example:8080 {REGISTER_URL}",
    f"curl -s -X POST -K config.txt {REGISTER_URL}",
    f"curl -s -X POST --config config.txt {REGISTER_URL}",
    f"curl -sk -X POST {REGISTER_URL}",
    f"curl -s --insecure -X POST {REGISTER_URL}",
])
def test_ambiguous_commands_are_not_read(live, ctx, av, command):
    fire(ctx, command, terminal_result(participant()))
    assert actions(av, live) == []
    assert of_type(av, live, "tool.call")[0]["payload"]["operation"] is None


def test_a_read_with_a_second_edgeos_path_in_a_header_confirms_nothing(live, ctx, av):
    rsvp(ctx)
    fire(ctx, f'curl -s {API}/events/portal/events/{EVENT} -H "Referer: {API}/humans/me"',
         terminal_result(REGISTERED))
    assert of_type(av, live, "action.receipted") == []


# --------------------------------------------------------------------------
# M3 — participant receipts, occurrences, supersession
# --------------------------------------------------------------------------


def test_occurrences_are_kept_apart(live, ctx, av):
    first = rsvp(ctx, call_id="c1")
    second = rsvp(ctx, occurrence="2026-10-20T10:00:00Z", call_id="c2")
    read_event(ctx, call_id="c3")
    assert [e["payload"]["receipt"]["id"] for e in of_type(av, live, "action.receipted")] == [first]
    # The same instant at another offset, URL-encoded as a client must.
    read_event(ctx, occurrence="2026-10-20T15:30:00%2B05:30", call_id="c4")
    receipted = of_type(av, live, "action.receipted")
    assert [e["payload"]["receipt"]["id"] for e in receipted] == [first, second]
    assert receipted[-1]["payload"]["occurrence_start"] == "2026-10-20T10:00:00.000Z"


def test_a_list_item_of_a_recurring_series_is_keyed_by_its_start(live, ctx, av):
    second = rsvp(ctx, occurrence="2026-10-20T10:00:00Z")
    body = {"results": [{"id": EVENT, "recurrence_master_id": EVENT, "start_time": "2026-10-20T10:00:00Z",
                         "my_rsvp_status": "registered"}], "paging": {}}
    fire(ctx, f"curl -s '{API}/events/portal/events?rsvped_only=true'", terminal_result(body))
    assert [e["payload"]["receipt"]["id"] for e in of_type(av, live, "action.receipted")] == [second]


def test_a_re_rsvp_to_the_same_occurrence_supersedes_the_waiting_one(live, ctx, av):
    rsvp(ctx, call_id="c1")
    newer = rsvp(ctx, call_id="c2")
    attempts = of_type(av, live, "action.attempted")
    assert attempts[0]["payload"]["supersedes_action_id"] is None
    assert attempts[1]["payload"]["supersedes_action_id"] == attempts[0]["action_id"]
    read_event(ctx, call_id="c3")
    receipted = of_type(av, live, "action.receipted")
    assert [(e["action_id"], e["payload"]["receipt"]["id"]) for e in receipted] == [(attempts[1]["action_id"], newer)]


def test_a_null_status_never_confirms_a_cancel_of_an_unseen_rsvp(live, ctx, av):
    cancel(ctx)
    read_event(ctx, status=None)
    assert of_type(av, live, "action.receipted") == []
    read_event(ctx, status="cancelled")
    assert len(of_type(av, live, "action.receipted")) == 1


def test_a_null_status_confirms_a_cancel_of_a_seen_rsvp(live, ctx, av):
    rsvp(ctx)
    read_event(ctx)
    cancel_id = cancel(ctx)
    read_event(ctx, status=None)
    receipted = of_type(av, live, "action.receipted")
    assert receipted[-1]["payload"]["action_class"] == "cancel_rsvp"
    assert receipted[-1]["payload"]["receipt"]["id"] == cancel_id


def test_a_registered_read_leaves_a_pending_cancel_alone(live, ctx, av):
    rsvp(ctx)
    cancel(ctx)
    read_event(ctx, status="registered")
    assert of_type(av, live, "action.receipted") == []
    assert [v["action_class"] for v in live._COLLECTOR.edgeos.pending.values()] == ["cancel_rsvp"]


def test_the_tool_call_carries_a_receipt_only_when_exactly_one_action_was_confirmed(live, ctx, av):
    rsvp(ctx, call_id="c1")
    rsvp(ctx, event=OTHER_EVENT, call_id="c2")
    body = {"results": [dict(REGISTERED), {"id": OTHER_EVENT, "my_rsvp_status": "registered"}], "paging": {}}
    fire(ctx, f"curl -s '{API}/events/portal/events?rsvped_only=true'", terminal_result(body), call_id="c3")
    assert len(of_type(av, live, "action.receipted")) == 2
    assert of_type(av, live, "tool.call")[-1]["payload"]["receipt"] is None


# --------------------------------------------------------------------------
# L1, L2, L4, L6 — the ledger and metadata mode
# --------------------------------------------------------------------------


def restart_ledger(plugin):
    plugin._COLLECTOR.edgeos = type(plugin._COLLECTOR.edgeos)()


def test_a_pending_action_expires_after_seven_days(live, ctx, av, home):
    rsvp(ctx)
    path = home / "av-events" / "edgeos_actions.json"
    data = json.loads(path.read_text())
    for entry in data["pending"].values():
        entry["at"] -= 8 * 24 * 3600
    path.write_text(json.dumps(data))
    restart_ledger(live)
    read_event(ctx)
    assert of_type(av, live, "action.receipted") == []


def test_a_pending_action_inside_seven_days_survives_a_restart(live, ctx, av, home):
    rsvp(ctx)
    path = home / "av-events" / "edgeos_actions.json"
    data = json.loads(path.read_text())
    for entry in data["pending"].values():
        entry["at"] -= 6 * 24 * 3600
    path.write_text(json.dumps(data))
    restart_ledger(live)
    read_event(ctx)
    assert len(of_type(av, live, "action.receipted")) == 1


def test_malformed_ledger_entries_are_dropped_on_load(live, ctx, av, home):
    rsvp(ctx)
    path = home / "av-events" / "edgeos_actions.json"
    data = json.loads(path.read_text())
    good_key = next(iter(data["pending"]))
    good = data["pending"][good_key]
    # Otherwise valid, so only the `at` check can reject it.
    data["pending"][f"{OTHER_EVENT}|"] = {**good, "at": "yesterday"}
    data["pending"]["not-a-key"] = good
    data["pending"][f"{OTHER_EVENT}|tomorrow"] = good
    data["pending"][f"{OTHER_EVENT}|x"] = {**good, "participant_id": "not-a-uuid"}
    data["last"]["junk"] = {"rsvp": 5}
    path.write_text(json.dumps(data))
    restart_ledger(live)
    data["pending"][f"{OTHER_EVENT}|2026-10-20T10:00:00.000Z"] = {**good, "action_id": "x y"}
    path.write_text(json.dumps(data))
    restart_ledger(live)
    for _ in range(3):
        read_event(ctx, event=OTHER_EVENT)
    assert live._COLLECTOR.total_failures == 0
    assert list(live._COLLECTOR.edgeos.pending) == [good_key]
    read_event(ctx)
    assert len(of_type(av, live, "action.receipted")) == 1


@pytest.mark.parametrize("content", ["not json", "[]", '{"pending": 7}', '{"pending": {"a|": null}}'])
def test_a_corrupt_ledger_file_is_an_empty_ledger(live, ctx, av, home, content):
    (home / "av-events").mkdir(exist_ok=True)
    (home / "av-events" / "edgeos_actions.json").write_text(content)
    restart_ledger(live)
    read_event(ctx)
    rsvp(ctx)
    assert live._COLLECTOR.total_failures == 0
    assert len(live._COLLECTOR.edgeos.pending) == 1


def test_an_inert_emit_leaves_the_ledger_untouched(live, ctx, av, home, monkeypatch):
    collector = live._COLLECTOR
    real_emit = collector.emit
    monkeypatch.setattr(collector, "emit", lambda event_type, *a, **k: (
        None if event_type.startswith("action.") else real_emit(event_type, *a, **k)))
    rsvp(ctx)
    assert collector.edgeos.pending == {}
    assert not (home / "av-events" / "edgeos_actions.json").exists()


def test_an_inert_receipt_leaves_the_action_waiting(live, ctx, av, monkeypatch):
    rsvp(ctx)
    collector = live._COLLECTOR
    real_emit = collector.emit
    inert = {"on": True}
    monkeypatch.setattr(collector, "emit", lambda event_type, *a, **k: (
        None if inert["on"] and event_type == "action.receipted" else real_emit(event_type, *a, **k)))
    read_event(ctx)
    assert len(collector.edgeos.pending) == 1
    inert["on"] = False
    read_event(ctx)
    assert len(of_type(av, live, "action.receipted")) == 1


def test_metadata_replaces_the_event_id_with_its_keyed_hash(plugin, ctx, monkeypatch, av, home):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    participant_id = rsvp(ctx)
    read_event(ctx)
    key = bytes.fromhex((home / "av-events" / "hash.key").read_text().strip())
    expected = hmac.new(key, EVENT.encode(), hashlib.sha256).hexdigest()
    events = of_type(av, plugin, "action.attempted", "action.receipted")
    assert [e["payload"]["edgeos_event_id"] for e in events] == [expected, expected]
    # The participant id is hashed too: in `metadata` the receipt is not checkable.
    hashed_participant = hmac.new(key, participant_id.encode(), hashlib.sha256).hexdigest()
    assert events[1]["payload"]["receipt"]["id"] == hashed_participant
    assert of_type(av, plugin, "tool.call")[-1]["payload"]["receipt"]["id"] == hashed_participant
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    assert EVENT not in blob and participant_id not in blob


@pytest.mark.parametrize("mode", ["sanitized", "full"])
def test_sanitized_and_full_keep_the_receipt_checkable(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    participant_id = rsvp(ctx)
    read_event(ctx)
    receipted = of_type(av, plugin, "action.receipted")[0]
    assert receipted["payload"]["receipt"]["id"] == participant_id
    assert receipted["payload"]["edgeos_event_id"] == EVENT


# --------------------------------------------------------------------------
# L3 — bounded JSON search
# --------------------------------------------------------------------------


def test_first_json_gives_up_after_64_attempts(plugin):
    intentions = __import__(f"{plugin.__name__}._intentions", fromlist=["_intentions"])
    late = "\n".join(["{broken"] * 70 + ['{"id": 1}'])
    assert intentions._first_json(late) == late
    early = "\n".join(["{broken"] * 10 + ['{"id": 1}'])
    assert intentions._first_json(early) == {"id": 1}
    started = time.perf_counter()
    intentions._first_json('{"a":\n' * 25000)
    assert time.perf_counter() - started < 1.0


def test_an_adversarial_read_result_stays_inside_the_hook_budget(live, ctx, av):
    rsvp(ctx)
    started = time.perf_counter()
    fire(ctx, f"curl -s '{API}/events/portal/events?limit=100'", terminal_result('{"a":\n' * 25000))
    assert time.perf_counter() - started < 1.0


# --------------------------------------------------------------------------
# N3 — occurrences named and unnamed
# --------------------------------------------------------------------------


def test_a_read_without_an_occurrence_confirms_the_only_waiting_occurrence(live, ctx, av):
    only = rsvp(ctx, occurrence="2026-10-20T10:00:00Z")
    read_event(ctx)
    receipted = of_type(av, live, "action.receipted")
    assert [e["payload"]["receipt"]["id"] for e in receipted] == [only]
    assert receipted[0]["payload"]["occurrence_start"] == "2026-10-20T10:00:00.000Z"


def test_a_read_without_an_occurrence_is_ambiguous_with_two_waiting(live, ctx, av):
    rsvp(ctx, occurrence="2026-10-20T10:00:00Z", call_id="c1")
    rsvp(ctx, occurrence="2026-10-27T10:00:00Z", call_id="c2")
    read_event(ctx)
    assert of_type(av, live, "action.receipted") == []


def test_a_read_without_an_occurrence_prefers_the_one_off(live, ctx, av):
    one_off = rsvp(ctx, call_id="c1")
    rsvp(ctx, occurrence="2026-10-20T10:00:00Z", call_id="c2")
    read_event(ctx)
    assert [e["payload"]["receipt"]["id"] for e in of_type(av, live, "action.receipted")] == [one_off]


def test_a_literal_plus_in_the_query_is_an_offset(live, ctx, av):
    second = rsvp(ctx, occurrence="2026-10-20T10:00:00Z", call_id="c1")
    rsvp(ctx, occurrence="2026-10-27T10:00:00Z", call_id="c2")
    read_event(ctx, occurrence="2026-10-20T15:30:00+05:30", call_id="c3")
    assert [e["payload"]["receipt"]["id"] for e in of_type(av, live, "action.receipted")] == [second]


def test_a_read_naming_an_unparseable_occurrence_confirms_nothing(live, ctx, av):
    rsvp(ctx)
    read_event(ctx, occurrence="next-tuesday")
    assert of_type(av, live, "action.receipted") == []


def test_a_record_with_a_naive_occurrence_waits_on_nothing(live, ctx, av):
    body = participant(occurrence="2026-10-20T10:00:00")
    fire(ctx, f"curl -s -X POST {REGISTER_URL}", terminal_result(body))
    assert actions(av, live) == [("action.attempted", "agent_report")]
    assert live._COLLECTOR.edgeos.pending == {}
    read_event(ctx)
    assert of_type(av, live, "action.receipted") == []


def test_parse_query_keeps_plus_and_blank_values(plugin):
    edgeos = __import__(f"{plugin.__name__}._edgeos", fromlist=["_edgeos"])
    assert edgeos.parse_query("occurrence_start=2026-10-20T15:30:00+05:30&x=&x=2") == {
        "occurrence_start": "2026-10-20T15:30:00+05:30", "x": ""}
    assert edgeos.parse_query("occurrence_start=2026-10-20T15%3A30%3A00%2B05%3A30") == {
        "occurrence_start": "2026-10-20T15:30:00+05:30"}
