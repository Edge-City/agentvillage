"""DATA-487: `opportunity.headline_flagged@1`, the plugin's half (`_headline_flagged`).

The trigger's half (which headlines are flagged, the hand-off file) is
`skills/index-network/scripts/tests/match-naming.test.ts` ("detection"). The
trigger writes `av-events/proactive/headline-flagged/<name>.json` (0600, ids
and codes only); the flusher's pass emits one event per record and removes the
file. The payload is closed: exactly five keys, every one required, no text.
Every file here is in the agent's own home, where the model can write: a file
that is not exactly the shape is refused whole and removed, never emitted.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone

import pytest

TENANT = "tenant-0b7d"
OPP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
PEER = "9f8e7d6c-5b4a-4321-8fed-cba987654321"
RECORD = {"opportunity_id": OPP, "counterpart_index_user_id": PEER, "reason_code": "shape_withheld", "stage": "shape", "headline_length": 23}
EVENT_TYPE = "opportunity.headline_flagged"


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", TENANT)
    plugin.register(ctx)
    return plugin


def flag_dir(home):
    return home / "av-events" / "proactive" / "headline-flagged"


def hand_off(home, body, *, name: str = "1760250600000-4242-a1b2c3d4e5f6.json", mode: int = 0o600):
    """What the trigger writes (proactive.ts writeHeadlineFlags)."""
    folder = flag_dir(home)
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    path = folder / name
    path.write_text(body if isinstance(body, str) else json.dumps(body))
    os.chmod(path, mode)
    return path


def body(*records, at: float | None = None, **over) -> dict:
    data = {"v": 1, "written_at": iso(time.time() - 5 if at is None else at), "records": list(records) or [dict(RECORD)]}
    data.update(over)
    return data


def flagged(av, plugin) -> list[dict]:
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == EVENT_TYPE]


def tick(plugin) -> dict:
    return plugin._COLLECTOR.headline_tick()


# -- emitted ------------------------------------------------------------------


def test_one_event_per_record_with_exactly_the_closed_payload_and_the_file_removed(live, home, av):
    second = {**RECORD, "reason_code": "scanner_flagged", "stage": "scanner", "headline_length": 0}
    path = hand_off(home, body(dict(RECORD), second))
    assert tick(live).get("emitted") == 2
    assert not path.exists()
    events = flagged(av, live)
    assert [e["payload"] for e in events] == [RECORD, second]
    for event in events:
        assert list(event["payload"]) == ["opportunity_id", "counterpart_index_user_id", "reason_code", "stage", "headline_length"]
        assert event["schema_version"] == 1
        assert event["opportunity_id"] == OPP
        assert event["actor"] == "system"
        assert event["event_id"][14] == "7"  # a uuid v7
    # Nothing left to emit.
    assert tick(live).get("emitted") is None
    assert len(flagged(av, live)) == 2


def test_the_event_id_is_a_function_of_the_file_and_the_record(live, home, av):
    at = time.time() - 5
    hand_off(home, body(at=at))
    tick(live)
    hand_off(home, body(at=at))
    tick(live)
    first, again = flagged(av, live)
    assert first["event_id"] == again["event_id"]
    hand_off(home, body(at=at), name="1760250600001-4242-a1b2c3d4e5f6.json")
    tick(live)
    assert flagged(av, live)[-1]["event_id"] != first["event_id"]


@pytest.mark.parametrize("reason,stage", [
    ("cleaner_withheld", "cleaner"), ("scanner_flagged", "scanner"), ("scanner_flagged", "shape"),
    ("shape_withheld", "shape"), ("length_capped", "cleaner"),
])
def test_every_reason_code_the_trigger_writes_is_emitted(live, home, av, reason, stage):
    hand_off(home, body({**RECORD, "reason_code": reason, "stage": stage}))
    assert tick(live).get("emitted") == 1
    assert flagged(av, live)[0]["payload"]["reason_code"] == reason


def test_no_text_reaches_the_event(live, home, av):
    hand_off(home, body())
    tick(live)
    [event] = flagged(av, live)
    strings = [v for v in event["payload"].values() if isinstance(v, str)]
    assert set(strings) == {OPP, PEER, "shape_withheld", "shape"}


# -- dropped and counted: a closed payload, attributed strictly ----------------
#
# Commit review flag 1 (attribution): the ids are checked against the trigger's
# own shapes (proactive.ts FLAG_OPPORTUNITY_ID, FLAG_USER_ID: an Index user id is
# a UUID). Flag 2 (suppression): a bad record or file is dropped and counted
# (`flag_dropped_<reason>`), never silently, and never blocks the good ones.


@pytest.mark.parametrize("record", [
    {**RECORD, "headline": "Telegram handle evilbot"},                  # text
    {**RECORD, "name": "Maya"},                                         # a name
    {**RECORD, "intent": "x"},                                          # an intent
    {k: v for k, v in RECORD.items() if k != "stage"},                  # a key missing
    {k: v for k, v in RECORD.items() if k != "counterpart_index_user_id"},
    {**RECORD, "opportunity_id": "x" * 65},                             # too long
    {**RECORD, "opportunity_id": ""},
    {**RECORD, "opportunity_id": "op 1"},
    {**RECORD, "counterpart_index_user_id": "evil bot"},                # not an id
    {**RECORD, "counterpart_index_user_id": "u-arjun"},                 # not the Index user id shape (a UUID)
    {**RECORD, "counterpart_index_user_id": PEER + "0"},
    {**RECORD, "counterpart_index_user_id": "https://index.network/u/" + PEER},
    {**RECORD, "counterpart_index_user_id": None},
    {**RECORD, "reason_code": "lure"},
    {**RECORD, "stage": "model"},
    {**RECORD, "reason_code": "length_capped", "stage": "shape"},       # not a pair the trigger writes
    {**RECORD, "reason_code": "cleaner_withheld", "stage": "scanner"},
    {**RECORD, "headline_length": 2001},
    {**RECORD, "headline_length": -1},
    {**RECORD, "headline_length": 2.5},
    {**RECORD, "headline_length": True},
    {**RECORD, "headline_length": "23"},
    "not a record",
])
def test_a_record_not_exactly_the_shape_is_dropped_and_counted_and_the_good_ones_still_go(live, home, av, record):
    path = hand_off(home, body(record, dict(RECORD)))
    codes = tick(live)
    assert codes == {"emitted": 1, "flag_dropped_bad_record": 1}
    assert not path.exists()
    assert [e["payload"] for e in flagged(av, live)] == [RECORD]


@pytest.mark.parametrize("data", [
    body(note="x"),                                  # an extra top-level key
    body(v=2),
    body(records=[]),
    body(records="x"),
    body(written_at="yesterday"),
    {"v": 1, "records": [RECORD]},                   # written_at missing
    [RECORD],
])
def test_a_file_not_exactly_the_shape_is_dropped_and_counted(live, home, av, data):
    path = hand_off(home, data)
    assert tick(live) == {"flag_dropped_bad_file": 1}
    assert not path.exists()
    assert flagged(av, live) == []


def test_an_unreadable_file_is_dropped_and_counted(live, home, av):
    path = hand_off(home, "not json")
    assert tick(live) == {"flag_dropped_unreadable": 1}
    assert not path.exists()


def test_a_file_anyone_else_could_write_is_dropped_and_counted(live, home, av):
    path = hand_off(home, body(), mode=0o644)
    assert tick(live) == {"flag_dropped_not_private": 1}
    assert not path.exists()
    assert flagged(av, live) == []


def test_an_oversized_file_is_dropped_and_counted_and_the_next_file_still_goes(live, home, av):
    big = hand_off(home, json.dumps(body()) + " " * 40_000, name="1-1-a.json")
    good = hand_off(home, body(), name="2-1-b.json")
    assert tick(live) == {"flag_dropped_too_big": 1, "emitted": 1}
    assert not big.exists() and not good.exists()
    assert len(flagged(av, live)) == 1


def test_a_flood_keeps_the_first_records_and_counts_the_rest(live, home, av):
    module = sys.modules[f"{live.__name__}._headline_flagged"]
    records = [{**RECORD, "headline_length": n} for n in range(module.RECORDS_MAX + 10)]
    hand_off(home, body(*records))
    assert tick(live) == {"emitted": module.RECORDS_MAX, "flag_dropped_over_cap": 10}
    assert [e["payload"]["headline_length"] for e in flagged(av, live)] == list(range(module.RECORDS_MAX))


def test_a_failure_on_one_file_never_stops_the_others_or_raises(live, home, av, monkeypatch):
    module = sys.modules[f"{live.__name__}._headline_flagged"]
    real = module.valid_file
    calls = []

    def flaky(data):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return real(data)

    monkeypatch.setattr(module, "valid_file", flaky)
    first = hand_off(home, body(), name="1-1-a.json")
    hand_off(home, body(), name="2-1-b.json")
    assert tick(live) == {"flag_dropped_error": 1, "emitted": 1}
    assert not first.exists()


def test_the_drops_are_visible_on_the_collector_counters(live, home, av):
    hand_off(home, body(), mode=0o644)
    tick(live)
    assert live._COLLECTOR.counters.get("headline_flag_dropped_not_private") == 1


def test_a_symlink_is_dropped_and_never_followed(live, home, av, tmp_path):
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps(body()))
    os.chmod(target, 0o600)
    folder = flag_dir(home)
    folder.mkdir(parents=True)
    os.chmod(folder, 0o700)
    link = folder / "1760250600000-1-aa.json"
    link.symlink_to(target)
    assert tick(live) == {"flag_dropped_not_regular": 1}
    assert not os.path.lexists(link)
    assert target.exists()
    assert flagged(av, live) == []


def test_a_stale_or_future_file_is_dropped_and_counted(live, home, av):
    old = hand_off(home, body(at=time.time() - 4 * 24 * 3600), name="1-1-a.json")
    ahead = hand_off(home, body(at=time.time() + 3600), name="2-1-b.json")
    assert tick(live) == {"flag_dropped_stale": 1, "flag_dropped_future": 1}
    assert not old.exists() and not ahead.exists()
    assert flagged(av, live) == []


def test_a_temp_file_is_left_for_the_writer(live, home, av):
    folder = flag_dir(home)
    folder.mkdir(parents=True)
    os.chmod(folder, 0o700)
    tmp = folder / "1-1-a.json.tmp"
    tmp.write_text("{")
    os.chmod(tmp, 0o600)
    assert tick(live) == {}
    assert tmp.exists()


# -- switches -------------------------------------------------------------------


def test_off_with_headline_flagged_in_av_hooks_disabled(plugin, ctx, home, av, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "pre_tool_call, Headline_Flagged")
    plugin.register(ctx)
    path = hand_off(home, body())
    assert tick(plugin) == {}
    assert path.exists()


def test_an_inert_plugin_keeps_the_file_for_later(plugin, ctx, home, av, monkeypatch):
    plugin.register(ctx)  # no token: the plugin is inert, emit returns None
    path = hand_off(home, body())
    collector = plugin._COLLECTOR
    if collector is not None:
        collector.headline_tick()
    assert path.exists()


def test_the_flusher_runs_the_pass_beside_the_outcome_ask(live):
    module = sys.modules[f"{live.__name__}._collector"]
    source = open(module.__file__, encoding="utf-8").read()
    loop = source[source.index("    def _loop(self)"):source.index("    def tick(self)")]
    assert "self.outcome_tick()" in loop and "self.headline_tick()" in loop


def test_a_record_whose_emit_raises_or_is_refused_is_counted_and_the_file_is_still_consumed(live, home, av, monkeypatch):
    collector = live._COLLECTOR
    real = collector.emit
    calls = []

    def flaky(event_type, payload, **refs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        if len(calls) == 2:
            return None
        return real(event_type, payload, **refs)

    monkeypatch.setattr(collector, "emit", flaky)
    third = {**RECORD, "headline_length": 7}
    path = hand_off(home, body(dict(RECORD), dict(RECORD), third))
    assert tick(live) == {"flag_dropped_emit_error": 1, "flag_dropped_emit_refused": 1, "emitted": 1}
    assert not path.exists()
    assert [e["payload"] for e in flagged(av, live)] == [third]
    # Consumed: the next pass reads nothing.
    assert tick(live) == {}
