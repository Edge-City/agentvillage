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


# -- refused: a closed payload -------------------------------------------------


@pytest.mark.parametrize("record", [
    {**RECORD, "headline": "Telegram handle evilbot"},                  # text
    {**RECORD, "name": "Maya"},                                         # a name
    {**RECORD, "intent": "x"},                                          # an intent
    {k: v for k, v in RECORD.items() if k != "stage"},                  # a key missing
    {k: v for k, v in RECORD.items() if k != "counterpart_index_user_id"},
    {**RECORD, "opportunity_id": "x" * 65},                             # too long
    {**RECORD, "opportunity_id": ""},
    {**RECORD, "counterpart_index_user_id": "evil bot"},                # not an id
    {**RECORD, "counterpart_index_user_id": "https://index.network/u/x"},
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
])
def test_a_record_not_exactly_the_shape_refuses_the_whole_file(live, home, av, record):
    path = hand_off(home, body(dict(RECORD), record))
    assert tick(live).get("refused") == 1
    assert not path.exists()
    assert flagged(av, live) == []


@pytest.mark.parametrize("data", [
    body(note="x"),                                  # an extra top-level key
    body(v=2),
    body(records=[]),
    body(records=[dict(RECORD)] * 51),               # more than a run can flag
    body(records="x"),
    body(written_at="yesterday"),
    {"v": 1, "records": [RECORD]},                   # written_at missing
    [RECORD],
    "not json",
])
def test_a_file_not_exactly_the_shape_is_refused(live, home, av, data):
    path = hand_off(home, data)
    assert tick(live).get("refused") == 1
    assert not path.exists()
    assert flagged(av, live) == []


def test_a_file_anyone_else_could_write_is_refused(live, home, av):
    path = hand_off(home, body(), mode=0o644)
    assert tick(live).get("refused") == 1
    assert not path.exists()
    assert flagged(av, live) == []


def test_a_symlink_is_refused_and_never_followed(live, home, av, tmp_path):
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps(body()))
    os.chmod(target, 0o600)
    folder = flag_dir(home)
    folder.mkdir(parents=True)
    os.chmod(folder, 0o700)
    link = folder / "1760250600000-1-aa.json"
    link.symlink_to(target)
    assert tick(live).get("refused") == 1
    assert not os.path.lexists(link)
    assert target.exists()
    assert flagged(av, live) == []


def test_a_stale_or_future_file_is_dropped(live, home, av):
    old = hand_off(home, body(at=time.time() - 4 * 24 * 3600), name="1-1-a.json")
    ahead = hand_off(home, body(at=time.time() + 3600), name="2-1-b.json")
    codes = tick(live)
    assert codes.get("stale") == 1 and codes.get("refused") == 1
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
