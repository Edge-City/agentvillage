"""The suggestion rating cards' events (`_rating_cards`): av-rate's hand-off files become
`opportunity.rating_asked` / `opportunity.rated` / `opportunity.pre_planned` with exactly the
contract's payloads, and the old text ask is off by default."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

import pytest

TENANT = "tenant-0b7d"
OPP = "0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D"
HASH = "ab" * 32
AT = "2026-10-21T13:31:00.000Z"


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", TENANT)
    plugin.register(ctx)
    return plugin


def folder(home):
    return home / "av-events" / "proactive" / "rating-events"


def hand_off(home, *records, name="1760250600000-4242-a1b2c3d4.json", at=None, mode=0o600, **over):
    folder(home).mkdir(parents=True, exist_ok=True)
    os.chmod(folder(home), 0o700)
    data = {"v": 1, "written_at": iso(time.time() - 5 if at is None else at), "records": list(records)}
    data.update(over)
    path = folder(home) / name
    path.write_text(json.dumps(data))
    os.chmod(path, mode)
    return path


def asked(**over):
    data = {"event_type": "opportunity.rating_asked", "opportunity_id": OPP, "intention_id": None, "card": "fit", "revision": 1, "value": None, "at": AT, "message_hash": HASH}
    data.update(over)
    return data


def rated(**over):
    data = {"event_type": "opportunity.rated", "opportunity_id": OPP, "intention_id": None, "card": "fit", "revision": 1, "value": 4, "at": AT, "message_hash": None}
    data.update(over)
    return data


def planned(**over):
    data = {"event_type": "opportunity.pre_planned", "opportunity_id": OPP, "intention_id": "intent-1", "card": "planned", "revision": 2, "value": "no", "at": AT, "message_hash": None}
    data.update(over)
    return data


def collab(**over):
    data = {"event_type": "opportunity.collab_interest", "opportunity_id": OPP, "intention_id": None, "card": "collab", "revision": 1, "value": "yes", "at": AT, "message_hash": None}
    data.update(over)
    return data


def events(av, plugin):
    kinds = ("opportunity.pre_planned", "opportunity.collab_interest")
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("opportunity.rat") or e["event_type"] in kinds]


def test_three_records_become_three_events_with_the_contracts_payloads(live, home, av):
    path = hand_off(home, asked(), rated(), planned())
    assert live._COLLECTOR.rating_tick().get("emitted") == 3
    assert not path.exists()
    got = events(av, live)
    assert [e["event_type"] for e in got] == ["opportunity.rating_asked", "opportunity.rated", "opportunity.pre_planned"]
    ask, rate, plan = got
    assert ask["payload"] == {"question_version": "match_fit_5_v1", "card": "fit", "message_hash": HASH, "window_hours": 24}
    assert ask["actor"] == "system" and ask["evidence_class"] == "agent_report"
    assert rate["payload"] == {"value": 4, "scale": "match_fit_5_v1", "channel": "telegram_button", "revision": 1, "rated_at": AT}
    assert rate["actor"] == "participant" and rate["evidence_class"] == "self_report"
    assert plan["payload"] == {"value": "no", "channel": "telegram_button", "revision": 2, "answered_at": AT}
    assert plan["actor"] == "participant" and plan["intention_id"] == "intent-1"
    for event in got:
        assert event["opportunity_id"] == OPP.lower()
        assert event["occurred_at"] == AT
        assert event["event_id"][14] == "7"
        assert event["schema_version"] == 1
    assert live._COLLECTOR.rating_tick().get("emitted") is None


def test_the_collab_ask_and_answer_carry_the_collab_interest_scale(live, home, av):
    hand_off(home, asked(card="collab"), collab(value="unsure"))
    assert live._COLLECTOR.rating_tick().get("emitted") == 2
    ask, answer = events(av, live)
    assert ask["payload"] == {"question_version": "collab_interest_v1", "card": "collab", "message_hash": HASH, "window_hours": 24}
    assert answer["event_type"] == "opportunity.collab_interest"
    assert answer["payload"] == {"value": "unsure", "scale": "collab_interest_v1", "channel": "telegram_button", "revision": 1, "answered_at": AT}
    assert answer["actor"] == "participant" and answer["evidence_class"] == "self_report"


def test_event_ids_derive_from_type_opportunity_card_and_revision(live, home, av):
    hand_off(home, rated(), name="a.json")
    hand_off(home, rated(), name="b.json")
    hand_off(home, rated(revision=2, value=5), name="c.json")
    live._COLLECTOR.rating_tick()
    ids = [e["event_id"] for e in events(av, live)]
    assert ids[0] == ids[1] and ids[2] != ids[0]


@pytest.mark.parametrize("record", [
    asked(message_hash=None), asked(value=3), asked(revision=2), asked(message_hash="x" * 64),
    rated(value=0), rated(value=6), rated(value="4"), rated(card="planned"), rated(message_hash=HASH),
    planned(value="maybe"), planned(card="fit"), planned(revision=0),
    collab(value="maybe"), collab(value=["yes"]), collab(value={"v": 1}), collab(value="spark"), collab(card="planned"), collab(card="type"), collab(message_hash=HASH), rated(card="collab"), asked(card="type"),
    {**rated(), "note": "text"}, rated(opportunity_id="has space"), rated(intention_id=5), rated(at="2026-10-21T13:31:00"), rated(event_type="outcome.reported"),
])
def test_a_record_not_exactly_the_shape_is_dropped_and_counted(live, home, av, record):
    path = hand_off(home, record)
    codes = live._COLLECTOR.rating_tick()
    assert codes == {"rating_dropped_bad_record": 1}
    assert not path.exists() and events(av, live) == []


def test_file_level_drops(live, home, av):
    hand_off(home, rated(), mode=0o644, name="open.json")
    hand_off(home, rated(), at=time.time() - 73 * 3600, name="stale.json")
    hand_off(home, rated(), at=time.time() + 3600, name="future.json")
    hand_off(home, name="empty.json")
    codes = live._COLLECTOR.rating_tick()
    assert codes == {"rating_dropped_not_private": 1, "rating_dropped_stale": 1, "rating_dropped_future": 1, "rating_dropped_bad_file": 1}
    assert not list(folder(home).iterdir())
    assert events(av, live) == []


def test_switch_in_hooks_disabled_skips_the_pass(live, home, av, monkeypatch):
    monkeypatch.setenv("AV_HOOKS_DISABLED", "rating_cards")
    live._COLLECTOR.reload_config()
    path = hand_off(home, rated())
    assert live._COLLECTOR.rating_tick() == {}
    assert path.exists()


def test_the_old_text_ask_is_off_unless_switched_on(live, monkeypatch):
    monkeypatch.delenv("AV_OUTCOME_TEXT_ASK", raising=False)
    assert live._COLLECTOR.outcome_tick() == {}
    calls = []
    live._outcome_guarded(live._COLLECTOR, {}, "post_llm_call", lambda: calls.append(1))
    assert calls == []
    monkeypatch.setenv("AV_OUTCOME_TEXT_ASK", "1")
    live._outcome_guarded(live._COLLECTOR, {}, "post_llm_call", lambda: calls.append(1))
    assert calls == [1]
