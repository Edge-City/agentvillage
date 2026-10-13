"""DATA-470 family: `approval.card_requested@1` / `approval.card_resolved@1`.

Every way an intention-publish card ends on the box (the resident's grant,
decline or revocation; a lapse; a void after a policy re-attest; a task the
log no longer knows; a withdrawal on the daemon; the agent's own withdraw)
emits exactly one resolved event per card, after exactly one requested event,
with the contract's closed payloads (`vectors/approval_card_contract.json`)
and never any of the card's text. `AV_APPROVAL_CARD_EVENTS` off emits nothing
and writes nothing new to the map.

The daemon and Index are the Lane B fakes of `test_intent_approval.py`,
loaded from that file so both suites speak to the same `FakeServe`.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "av_events_lane_b_fakes", Path(__file__).with_name("test_intent_approval.py"))
lane_b = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = lane_b
_SPEC.loader.exec_module(lane_b)

# The Lane B fixtures, by name (pytest finds a fixture in the module's globals);
# `mods` and `on` are this file's own (below), and the borrowed ones use them.
index = lane_b.index
serve = lane_b.serve
kicks = lane_b.kicks
tctx = lane_b.tctx
call = lane_b.call
entry = lane_b.entry
poll = lane_b.poll
task_id = lane_b.task_id
TEXT = lane_b.TEXT
STATED = lane_b.STATED
INFERRED = lane_b.INFERRED
STATED_CLASS = lane_b.STATED_CLASS

CONTRACT = json.loads((Path(__file__).parent / "vectors" / "approval_card_contract.json").read_text(encoding="utf-8"))
UUID = re.compile(CONTRACT["uuid_pattern"])
RFC3339 = re.compile(CONTRACT["rfc3339_pattern"])
REQUESTED = "approval.card_requested"
RESOLVED = "approval.card_resolved"


@pytest.fixture()
def mods(plugin, av):
    name = av.MODULE_NAME
    return type("Mods", (), {
        "ri": sys.modules[f"{name}._record_intention"],
        "ia": sys.modules[f"{name}._intent_approval"],
        "ap": sys.modules[f"{name}._approval"],
        "core": sys.modules[f"{name}._core"],
        "cards": sys.modules[f"{name}._card_events"],
    })


@pytest.fixture()
def on(monkeypatch, home):
    """Lane B's switches, plus this one."""
    for name, value in (("AV_RECORD_INTENTION", "1"), ("INDEX_API_KEY", lane_b.KEY), ("AV_APPROVAL_ENABLED", "1"),
                        ("AV_APPROVAL_URL", lane_b.FACADE), ("AV_APPROVAL_TOKEN", lane_b.TOKEN),
                        ("AV_APPROVAL_CARD_EVENTS", "1")):
        monkeypatch.setenv(name, value)


def cards(av, plugin) -> list[dict]:
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("approval.card_")]


def of(evs: list[dict], kind: str) -> list[dict]:
    return [e for e in evs if e["event_type"] == kind]


def conforms(event: dict) -> None:
    """The contract's closed shape, checked key by key."""
    schema = CONTRACT["schemas"][f"{event['event_type']}@{event['schema_version']}"]
    payload = event["payload"]
    assert sorted(payload) == sorted(schema["required"])  # closed: nothing more, nothing less
    for key in schema["uuid"]:
        if payload[key] is None:
            assert key in schema["nullable"]
        else:
            assert UUID.match(payload[key]), key
    for key in schema["times"]:
        assert isinstance(payload[key], str) and RFC3339.match(payload[key]), key
    for key, allowed in schema["enums"].items():
        assert payload[key] in allowed or (payload[key] is None and key in schema["nullable"]), key
    for key, value in payload.items():
        if value is None:
            assert key in schema["nullable"], key


def no_text(evs: list[dict], *texts: str) -> None:
    """Not the text, not a word of it, not the summary, anywhere in the event."""
    blob = json.dumps(evs, ensure_ascii=False)
    for text in texts:
        assert text not in blob
        for word in re.findall(r"[A-Za-z]{4,}", text):
            assert word not in blob, word
    for summary in ("Publish to Index", "inferred", "you stated"):
        assert summary not in blob.replace("intent_publish_inferred", "")


def one_card(av, plugin, iid: str, resolution: str, decided_by: str) -> tuple[dict, dict]:
    evs = cards(av, plugin)
    [req], [res] = of(evs, REQUESTED), of(evs, RESOLVED)
    for e in (req, res):
        conforms(e)
        assert e["intention_id"] == iid and e["payload"]["intent_id"] == iid
    assert res["payload"]["card_id"] == req["payload"]["card_id"]
    assert res["payload"]["requested_at"] == req["payload"]["requested_at"]
    assert res["payload"]["resolution"] == resolution and res["payload"]["decided_by"] == decided_by
    assert res["payload"]["resolved_at"] >= res["payload"]["requested_at"]
    assert req["occurred_at"] == req["payload"]["requested_at"] and res["occurred_at"] == res["payload"]["resolved_at"]
    no_text(evs, TEXT)
    return req, res


# --------------------------------------------------------------------------
# Requested
# --------------------------------------------------------------------------


def test_an_ambient_capture_requests_one_card_and_a_pending_poll_adds_nothing(tctx, serve, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    [req] = cards(av, plugin)
    conforms(req)
    assert req["event_type"] == REQUESTED and req["schema_version"] == 1
    assert req["payload"]["kind"] == "intent_publish_inferred" and req["payload"]["origin"] is None
    assert req["payload"]["intent_id"] == iid and req["payload"]["card_id"] != iid
    assert req["payload"]["card_id"][14] == "7"  # uuid v7
    for _ in range(3):
        poll(mods)
    assert cards(av, plugin) == [req]
    no_text(cards(av, plugin), TEXT)
    [card] = entry(mods, iid)["approval"]["cards"]
    assert card["requested_sent"] is True and card["resolution"] is None


def test_a_class_the_policy_clears_raises_no_card(tctx, serve, index, av, plugin):
    out = call(tctx, {"text": STATED, "source": "message"})  # stated: autonomous in the fake's policy
    assert out["published"] is True
    serve.autonomy[INFERRED] = "autonomous"
    assert call(tctx, {"text": TEXT, "source": "ambient"}, tool_call_id="c2")["published"] is True
    assert cards(av, plugin) == []


def test_a_stated_capture_under_a_manual_policy_is_a_stated_card(tctx, serve, index, mods, av, plugin):
    serve.autonomy[STATED_CLASS] = "manual"
    iid = call(tctx, {"text": STATED, "source": "message"})["intention_id"]
    serve.grant(f"{STATED_CLASS}:{iid}")
    poll(mods)
    req, _ = one_card(av, plugin, iid, "granted", "resident")
    assert req["payload"]["kind"] == "intent_publish_stated"
    no_text(cards(av, plugin), STATED)


# --------------------------------------------------------------------------
# Each way a card ends: exactly one resolved event
# --------------------------------------------------------------------------


def test_granted_by_the_resident_once_however_often_it_is_polled_or_confirmed(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    assert len(index.creates()) == 1
    for n in range(3):
        poll(mods)
        call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id=f"c{n}")
    one_card(av, plugin, iid, "granted", "resident")


def test_a_grant_read_by_a_resume_pass_that_stops_before_start_resolves_the_card_once(tctx, serve, index, mods, av,
                                                                                    plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    mods.ia.run_intent_pass(execute=False)  # the grant is read; nothing is started
    assert index.requests == [] and entry(mods, iid)["approval"]["state"] == "requested"
    poll(mods)  # the gateway's pass starts and publishes it
    assert len(index.creates()) == 1
    one_card(av, plugin, iid, "granted", "resident")


def test_declined_by_the_resident(tctx, serve, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    poll(mods)
    one_card(av, plugin, iid, "declined", "resident")


def test_a_revoked_grant_is_declined_by_the_resident(tctx, serve, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.on_wait = lambda n: (1, None, {"ok": False, "status": "revoked", "task": "t", "actions": []})
    poll(mods)
    poll(mods)
    assert entry(mods, iid)["approval"]["state"] == "rejected"
    one_card(av, plugin, iid, "declined", "resident")


def test_withdrawn_on_the_daemon_is_withdrawn_by_the_system(tctx, serve, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.tasks[task_id(INFERRED, f"{INFERRED}:{iid}")]["state"] = "withdrawn"
    poll(mods)
    one_card(av, plugin, iid, "withdrawn", "system")


def test_the_agents_withdraw_resolves_the_card_once(tctx, serve, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    out = call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c2")
    assert out["success"] is True
    poll(mods)
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c3")
    one_card(av, plugin, iid, "withdrawn", "system")


def test_each_lapse_ends_its_card_and_every_re_ask_is_a_new_card(tctx, serve, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    for _ in range(3):  # two re-asks, then the cap
        serve.expire(key)
        poll(mods)
        poll(mods)
    assert entry(mods, iid)["approval"]["state"] == "expired"
    evs = cards(av, plugin)
    reqs, ress = of(evs, REQUESTED), of(evs, RESOLVED)
    assert len(reqs) == len(ress) == 3 == len(serve.proposals())
    ids = [e["payload"]["card_id"] for e in reqs]
    assert len(set(ids)) == 3 and [e["payload"]["card_id"] for e in ress] == ids
    assert {(e["payload"]["resolution"], e["payload"]["decided_by"]) for e in ress} == {("expired", "timeout")}
    for e in evs:
        conforms(e)
    assert len({e["event_id"] for e in evs}) == 6
    no_text(evs, TEXT)


def test_a_void_after_a_policy_re_attest_is_withdrawn_by_the_system_and_re_asked(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    serve.reattest()
    poll(mods)
    serve.grant(key)
    poll(mods)
    assert len(index.creates()) == 1
    evs = cards(av, plugin)
    reqs, ress = of(evs, REQUESTED), of(evs, RESOLVED)
    assert len(reqs) == len(ress) == 2
    assert [(e["payload"]["resolution"], e["payload"]["decided_by"]) for e in ress] == [
        ("withdrawn", "system"), ("granted", "resident")]
    assert [e["payload"]["card_id"] for e in ress] == [e["payload"]["card_id"] for e in reqs]


def test_a_grant_voided_before_start_stays_granted_and_the_re_ask_is_a_second_card(tctx, serve, index, mods, av,
                                                                                    plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    granted = (0, {"ok": True, "status": "granted", "task": "t", "actions": []}, None)

    def drift(n: int):
        if n == 2:  # the re-read reads granted, then the re-attest lands before start
            serve.reattest()
            return granted
        return None

    serve.on_wait = drift
    poll(mods)
    evs = cards(av, plugin)
    assert [e["event_type"] for e in evs] == [REQUESTED, RESOLVED, REQUESTED]
    assert evs[1]["payload"]["resolution"] == "granted"
    assert evs[2]["payload"]["card_id"] != evs[0]["payload"]["card_id"]


def test_a_task_the_log_no_longer_knows_ends_the_card_and_the_re_ask_is_new(tctx, serve, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.tasks.clear()  # a fresh log: not-registered
    poll(mods)
    evs = cards(av, plugin)
    assert [e["event_type"] for e in evs] == [REQUESTED, RESOLVED, REQUESTED]
    assert (evs[1]["payload"]["resolution"], evs[1]["payload"]["decided_by"]) == ("withdrawn", "system")


def test_an_answer_that_arrived_before_the_first_reply_was_read(tctx, serve, mods, av, plugin):
    """The first `propose` reply was lost (map left `unfiled`); the resident
    answered meanwhile; the next `propose` reads the decided request."""
    serve.down = True
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    assert cards(av, plugin) == []
    serve.down = False
    key = f"{INFERRED}:{iid}"
    original = serve._propose

    def decided(pos, flags):
        code, out, err = original(pos, flags)
        serve._by_key(key)["state"] = "rejected"
        return original(pos, flags)

    serve._propose = decided
    poll(mods)
    one_card(av, plugin, iid, "declined", "resident")


# --------------------------------------------------------------------------
# Idempotency: one event per card per kind, whatever retries
# --------------------------------------------------------------------------


def test_an_emitter_that_failed_is_retried_by_the_next_pass_with_the_same_ids(tctx, serve, mods, av, plugin,
                                                                             monkeypatch):
    real = mods.cards._emit_fn
    monkeypatch.setattr(mods.cards, "_emit_fn", lambda *a, **k: False)
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    assert cards(av, plugin) == []
    [card] = entry(mods, iid)["approval"]["cards"]
    assert card["requested_sent"] is False and card["resolution"] == "declined"
    monkeypatch.setattr(mods.cards, "_emit_fn", real)
    poll(mods)  # the sweep sends what is owed, in order
    poll(mods)
    req, res = one_card(av, plugin, iid, "declined", "resident")
    assert req["event_id"] == mods.cards.event_id(REQUESTED, card)
    assert res["event_id"] == mods.cards.event_id(RESOLVED, card)


def test_a_raising_emitter_costs_no_transition(tctx, serve, index, mods, av, plugin, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("x")

    monkeypatch.setattr(mods.cards, "_emit_fn", boom)
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    assert len(index.creates()) == 1 and entry(mods, iid)["approval"]["state"] == "published"
    assert cards(av, plugin) == []


def test_a_crash_after_the_buffer_append_re_sends_the_same_event_id(tctx, serve, mods, av, plugin, monkeypatch):
    """The sent mark is lost (the save after the emit failed): the re-send is
    the same event id, so ingest keeps one row."""
    ri = mods.ri
    real_save = ri._save_locked
    calls = {"n": 0}

    def flaky(entries, publishes):
        if any("cards" in (e.get("approval") or {}) and any(c.get("requested_sent") for c in e["approval"]["cards"])
               for e in entries.values()) and calls["n"] == 0:
            calls["n"] += 1
            raise OSError("disk")
        return real_save(entries, publishes)

    monkeypatch.setattr(ri, "_save_locked", flaky)
    call(tctx, {"text": TEXT, "source": "ambient"})
    monkeypatch.setattr(ri, "_save_locked", real_save)
    poll(mods)
    poll(mods)
    reqs = of(cards(av, plugin), REQUESTED)
    assert len(reqs) == 2 and reqs[0]["event_id"] == reqs[1]["event_id"]
    assert reqs[0]["payload"] == reqs[1]["payload"]


def test_two_passes_racing_send_each_event_once(tctx, serve, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    for _ in range(3):
        mods.cards.flush(iid)
        mods.cards.sweep()
    one_card(av, plugin, iid, "declined", "resident")


def test_the_event_id_is_a_v7_fixed_by_the_card(mods):
    card = {"id": "0199d0a4-1b2c-7d3e-8f40-123456789abc", "requested_at": 1760200000.5, "resolved_at": 1760203600.25}
    a, b = mods.cards.event_id(REQUESTED, card), mods.cards.event_id(RESOLVED, card)
    assert a == mods.cards.event_id(REQUESTED, dict(card)) and a != b
    assert UUID.match(a) and a[14] == "7" and b[14] == "7"


# --------------------------------------------------------------------------
# The switch, origin, kind
# --------------------------------------------------------------------------


def test_with_the_switch_off_nothing_is_emitted_and_the_map_is_unchanged(tctx, serve, index, mods, av, plugin,
                                                                         monkeypatch):
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "0")
    granted = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    declined = call(tctx, {"text": TEXT + " too", "source": "ambient"}, tool_call_id="c2")["intention_id"]
    lapsed = call(tctx, {"text": TEXT + " three", "source": "ambient"}, tool_call_id="c3")["intention_id"]
    gone = call(tctx, {"text": TEXT + " four", "source": "ambient"}, tool_call_id="c4")["intention_id"]
    serve.grant(f"{INFERRED}:{granted}")
    serve.reject(f"{INFERRED}:{declined}")
    serve.expire(f"{INFERRED}:{lapsed}")
    poll(mods)
    call(tctx, {"action": "withdraw", "intention_id": gone}, tool_call_id="c5")
    serve.reattest()
    poll(mods)
    assert cards(av, plugin) == []
    for iid in (granted, declined, lapsed, gone):
        e = entry(mods, iid)
        assert "cards" not in e["approval"] and "origin" not in e
    assert "cards" not in Path(mods.ri.map_path()).read_text(encoding="utf-8")


def test_a_card_opened_while_the_switch_was_off_is_never_reported(tctx, serve, mods, av, plugin, monkeypatch):
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "0")
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "1")
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    assert cards(av, plugin) == []


def test_origin_is_null_even_when_the_entry_names_one(tctx, serve, mods, av, plugin):
    """Ruling S2: the data side derives origin from intention.captured by intent_id."""
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    ri = mods.ri
    with ri._Locked():
        entries, publishes = ri._load_locked()
        entries[iid]["origin"] = "memory_signal_sync"
        ri._save_locked(entries, publishes)
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    req, _ = one_card(av, plugin, iid, "declined", "resident")
    assert req["payload"]["origin"] is None
    assert not hasattr(mods.cards, "note_origin")


# --------------------------------------------------------------------------
# Fix round: S1 (the switch gates creation only), N1, N2, N3/N4, N5
# --------------------------------------------------------------------------


def test_s1_a_card_resolved_while_the_switch_was_off_is_sent_when_it_is_back(tctx, serve, mods, av, plugin,
                                                                            monkeypatch):
    """The refuter's probe: on at capture, off at the decline, on again."""
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    assert [e["event_type"] for e in cards(av, plugin)] == [REQUESTED]
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "0")
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    [card] = entry(mods, iid)["approval"]["cards"]
    assert card["resolution"] == "declined" and card["resolved_sent"] is False  # closed, not sent
    assert [e["event_type"] for e in cards(av, plugin)] == [REQUESTED]
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "1")
    poll(mods)  # the entry is terminal: only the sweep can send it
    poll(mods)
    one_card(av, plugin, iid, "declined", "resident")


@pytest.mark.parametrize("ending", ["grant", "withdraw", "expire"])
def test_s1_every_close_applies_with_the_switch_off(tctx, serve, index, mods, av, plugin, monkeypatch, ending):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "0")
    if ending == "grant":
        serve.grant(key)
    elif ending == "expire":
        serve.expire(key)
    else:
        call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c2")
    poll(mods)
    cs = entry(mods, iid)["approval"]["cards"]
    assert len(cs) == 1 and cs[0]["resolution"] is not None  # closed; a re-ask opens no card while off
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "1")
    mods.cards.sweep()
    expected = {"grant": ("granted", "resident"), "withdraw": ("withdrawn", "system"),
                "expire": ("expired", "timeout")}[ending]
    evs = cards(av, plugin)
    [res] = of(evs, RESOLVED)
    assert (res["payload"]["resolution"], res["payload"]["decided_by"]) == expected


def test_s1_never_on_writes_no_bytes_across_every_ending(tctx, serve, index, mods, av, plugin, monkeypatch):
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "0")
    ids = [call(tctx, {"text": f"{TEXT} {n}", "source": "ambient"}, tool_call_id=f"c{n}")["intention_id"]
           for n in range(3)]
    path = Path(mods.ri.map_path())
    serve.grant(f"{INFERRED}:{ids[0]}")
    mods.ia.run_intent_pass(execute=False)  # a grant read with nothing started
    before = path.read_bytes()
    for _ in range(3):
        mods.ia.run_intent_pass(execute=False)
    assert path.read_bytes() == before  # repeated grant reads write nothing
    serve.reject(f"{INFERRED}:{ids[1]}")
    serve.expire(f"{INFERRED}:{ids[2]}")
    poll(mods)
    text = path.read_text(encoding="utf-8")
    assert '"cards"' not in text and cards(av, plugin) == []


def test_n1_flush_and_sweep_respect_the_switch(tctx, serve, mods, av, plugin, monkeypatch):
    real = mods.cards._emit_fn
    monkeypatch.setattr(mods.cards, "_emit_fn", lambda *a, **k: False)
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    monkeypatch.setattr(mods.cards, "_emit_fn", real)
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "0")
    mods.cards.flush(iid)
    mods.cards.sweep()
    poll(mods)
    assert cards(av, plugin) == []  # owed while on, not sent while off
    monkeypatch.setenv("AV_APPROVAL_CARD_EVENTS", "1")
    mods.cards.sweep()
    one_card(av, plugin, iid, "declined", "resident")


@pytest.mark.parametrize("bad", [
    "00000000-0000-0000-0000-000000000000",  # no version, no variant
    "0199d0a4-1b2c-4d3e-8f40-123456789abc",  # v4
    "0199d0a4-1b2c-7d3e-cf40-123456789abc",  # wrong variant
])
def test_n2_a_card_id_must_be_a_v7_of_the_rfc_variant(mods, bad):
    card = {"id": bad, "requested_at": 1760200000.0, "resolution": "declined", "decided_by": "resident",
            "resolved_at": 1760200001.0}
    assert mods.cards.requested_payload("0199d0a4-1b2c-7d3e-8f40-123456789abc", {"source": "ambient"},
                                        {"class": INFERRED}, card) is None
    assert mods.cards.resolved_payload("0199d0a4-1b2c-7d3e-8f40-123456789abc", card) is None
    with pytest.raises(ValueError):
        mods.cards.event_id(REQUESTED, card)


def test_n2_an_intent_id_off_the_variant_goes_out_null(mods):
    card = {"id": "0199d0a4-1b2c-7d3e-8f40-123456789abc", "requested_at": 1760200000.0}
    body = mods.cards.requested_payload("00000000-0000-0000-0000-000000000000", {"source": "ambient"},
                                        {"class": INFERRED}, card)
    assert body["intent_id"] is None


def test_n3_first_close_wins_granted_then_revoked_before_start(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    serve.grant(key)
    mods.ia.run_intent_pass(execute=False)  # the grant is read; the start waits
    serve.on_wait = lambda n: (1, None, {"ok": False, "status": "revoked", "task": "t", "actions": []})
    poll(mods)
    assert entry(mods, iid)["approval"]["state"] == "rejected" and index.requests == []
    one_card(av, plugin, iid, "granted", "resident")  # the resident did grant it; documented


def test_n4_first_close_wins_granted_then_the_agents_withdraw(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    mods.ia.run_intent_pass(execute=False)
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c2")
    poll(mods)
    assert entry(mods, iid)["approval"]["state"] == "withdrawn" and index.requests == []
    one_card(av, plugin, iid, "granted", "resident")


def test_n5_a_grant_close_that_could_not_be_saved_is_closed_by_the_claim(tctx, serve, index, mods, av, plugin,
                                                                         monkeypatch):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    real_cas = mods.ia._cas
    failed = {"n": 0}

    def flaky(intention_id, expect, change, *, claim=None):
        if failed["n"] == 0 and expect == frozenset({"requested"}) and claim is None:
            failed["n"] += 1  # the `_card_close` write is lost
            return None
        return real_cas(intention_id, expect, change, claim=claim)

    monkeypatch.setattr(mods.ia, "_cas", flaky)
    poll(mods)
    assert failed["n"] == 1 and len(index.creates()) == 1
    one_card(av, plugin, iid, "granted", "resident")


def test_n5_a_lost_grant_close_in_a_resume_pass_is_closed_by_a_later_pass(tctx, serve, mods, av, plugin,
                                                                          monkeypatch):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    real_cas = mods.ia._cas
    monkeypatch.setattr(mods.ia, "_cas", lambda *a, **k: None)  # every map write fails
    mods.ia.run_intent_pass(execute=False)
    assert entry(mods, iid)["approval"]["cards"][-1]["resolution"] is None
    monkeypatch.setattr(mods.ia, "_cas", real_cas)
    mods.ia.run_intent_pass(execute=False)  # the grant is read again: closed now
    one_card(av, plugin, iid, "granted", "resident")


def test_kind_for(mods):
    k = mods.cards.kind_for
    assert k(INFERRED, "ambient") == "intent_publish_inferred"
    assert k(STATED_CLASS, "message") == "intent_publish_stated"
    assert k(STATED_CLASS, "onboarding") == "intent_publish_stated"
    assert k(STATED_CLASS, "note") == "intent_publish_stated"
    assert k(INFERRED, "message") == "other"
    assert k(STATED_CLASS, "ambient") == "other"
    assert k("digest.share", None) == "other"


def test_resolution_of_every_status(mods):
    r = mods.cards.resolution_of
    assert r("granted") == r("executed") == r("nothing-to-wait-for") == ("granted", "resident")
    assert r("rejected") == r("revoked") == ("declined", "resident")
    assert r("expired") == ("expired", "timeout")
    assert r("withdrawn") == r("void") == r("anything") == ("withdrawn", "system")


def test_a_forged_card_on_the_map_is_never_sent(tctx, serve, mods, av, plugin):
    """The map is the agent's to write: a card with a malformed id, time or
    code, or text where an id belongs, is marked unsendable, not sent."""
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    ri = mods.ri
    with ri._Locked():
        entries, publishes = ri._load_locked()
        forged = entries[iid]["approval"]["cards"]
        forged += [
            {"id": TEXT, "requested_at": 1760200000.0, "resolution": None, "decided_by": None, "resolved_at": None,
             "requested_sent": False, "resolved_sent": False},
            {"id": "0199d0a4-1b2c-7d3e-8f40-123456789abc", "requested_at": "yesterday", "resolution": None,
             "decided_by": None, "resolved_at": None, "requested_sent": False, "resolved_sent": False},
            {"id": "0199d0a4-1b2c-7d3e-8f40-123456789abd", "requested_at": 1760200000.0, "resolution": TEXT,
             "decided_by": "resident", "resolved_at": 1760200001.0, "requested_sent": True, "resolved_sent": False},
        ]
        ri._save_locked(entries, publishes)
    mods.cards.sweep()
    evs = cards(av, plugin)
    assert len(evs) == 1 and evs[0]["event_type"] == REQUESTED  # the genuine one, from the capture
    no_text(evs, TEXT)
    assert all(c["requested_sent"] and (c["resolution"] is None or c["resolved_sent"])
               for c in entry(mods, iid)["approval"]["cards"][1:])


SENTINEL = "SENTINEL-7f3a9c-CARD-TEXT"


@pytest.mark.parametrize("ending", ["grant", "reject", "expire", "withdraw"])
def test_a_sentinel_in_the_card_text_and_title_reaches_no_payload_and_no_event_id(tctx, serve, index, mods, av,
                                                                                 plugin, monkeypatch, ending):
    """Coordinator's audit: the card's text (the proposal payload) and its title
    (the summary the resident's prompt shows) both carry a sentinel; it appears
    in neither event's payload, envelope or idempotency key (the event id and
    the string it is derived from)."""
    monkeypatch.setitem(mods.ia.SUMMARIES, INFERRED, f"Publish {SENTINEL} to Index")
    derived: list[str] = []
    real_derive = mods.cards.derived_uuid7

    def spy(ms, name):
        derived.append(name)
        return real_derive(ms, name)

    monkeypatch.setattr(mods.cards, "derived_uuid7", spy)
    text = f"Looking for {SENTINEL} partners in Goa"
    iid = call(tctx, {"text": text, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    assert SENTINEL in serve.proposals()[0]["flags"]["--summary"]  # the title really carries it
    assert SENTINEL in serve.proposals()[0]["flags"]["--payload-json"]  # and so does the text
    if ending == "grant":
        serve.grant(key)
    elif ending == "reject":
        serve.reject(key)
    elif ending == "expire":
        serve.expire(key)
    else:
        call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c2")
    poll(mods)
    evs = cards(av, plugin)
    assert of(evs, REQUESTED) and of(evs, RESOLVED)
    blob = json.dumps(evs, ensure_ascii=False)
    assert SENTINEL not in blob and "7f3a9c" not in blob
    for e in evs:
        conforms(e)
        assert SENTINEL not in json.dumps(e["payload"]) and SENTINEL not in e["event_id"]
    assert derived and all(SENTINEL not in name for name in derived)
    assert all(re.fullmatch(r"av-events\|approval\.card_(requested|resolved)\|[0-9a-f-]{36}", n) for n in derived)
    # Every payload value is a uuid, a closed code, an RFC 3339 time or null.
    codes = {v for sch in CONTRACT["schemas"].values() for vals in sch["enums"].values() for v in vals}
    for e in evs:
        for k, v in e["payload"].items():
            assert v is None or UUID.match(v) or v in codes or RFC3339.match(v), (k, v)


def test_a_forged_intention_key_never_reaches_the_envelope(mods):
    card = {"id": "0199d0a4-1b2c-7d3e-8f40-123456789abc", "requested_at": 1760200000.0, "resolution": None,
            "decided_by": None, "resolved_at": None}
    body = mods.cards.requested_payload(SENTINEL, {"source": "ambient", "origin": SENTINEL},
                                        {"class": INFERRED}, card)
    assert body["intent_id"] is None and body["origin"] is None and SENTINEL not in json.dumps(body)
    with pytest.raises(ValueError):
        mods.cards.event_id(REQUESTED, {**card, "id": SENTINEL})
