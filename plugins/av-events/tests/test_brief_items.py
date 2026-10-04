"""DATA-222: the morning brief's read-only reader of the intention map.

The map is written by the real `record_intention` flow through approval.md
(the fakes and fixtures of `test_intent_approval.py`, loaded from its file
because this suite runs in importlib mode), so a change to what that flow
writes shows up here. A few tests write a map by hand for the edges.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

_TIA_PATH = Path(__file__).resolve().parent / "test_intent_approval.py"
_spec = importlib.util.spec_from_file_location("_av_events_tia_for_brief", _TIA_PATH)
_tia = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_tia)

# The Lane B fixtures, re-exported so pytest finds them in this module.
mods = _tia.mods
index = _tia.index
serve = _tia.serve
kicks = _tia.kicks
on = _tia.on
tctx = _tia.tctx
call = _tia.call
poll = _tia.poll
INFERRED = _tia.INFERRED
TEXT = _tia.TEXT
STATED = _tia.STATED
INDEX_ID = _tia.INDEX_ID

READER = Path(__file__).resolve().parents[1] / "_brief_items.py"
SECOND = "Hoping to find someone to practise Konkani with over breakfast"


@pytest.fixture()
def bi(plugin, av):
    return importlib.import_module(f"{av.MODULE_NAME}._brief_items")


def items(bi, now=None) -> dict:
    return bi.brief_items(now)


# --------------------------------------------------------------------------
# Off is inert
# --------------------------------------------------------------------------


def test_record_intention_off_returns_nothing_even_with_held_entries(tctx, mods, bi, monkeypatch):
    call(tctx, {"text": TEXT, "source": "ambient"})
    assert items(bi)["heldCount"] == 1
    monkeypatch.setenv("AV_RECORD_INTENTION", "0")
    out = items(bi)
    assert out == {"v": 1, "status": "off", "reason": "record_intention_off", "held": [], "heldCount": 0,
                   "published": []}


def test_approval_not_configured_returns_nothing(tctx, mods, bi, monkeypatch):
    call(tctx, {"text": TEXT, "source": "ambient"})
    monkeypatch.delenv("AV_APPROVAL_URL")
    out = items(bi)
    assert out["status"] == "off" and out["reason"] == "approval_off"
    assert out["held"] == [] and out["published"] == [] and out["heldCount"] == 0


def test_no_map_is_empty_and_nothing_is_created(on, bi, home):
    out = items(bi)
    assert out["status"] == "ok" and out["held"] == [] and out["published"] == []
    assert not (Path(home) / "av-events").exists()


# --------------------------------------------------------------------------
# Held: open approval requests
# --------------------------------------------------------------------------


def test_a_held_inferred_intention_is_listed_with_its_text_until_granted(tctx, serve, index, mods, bi):
    before = time.time()
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    out = items(bi)
    assert out["status"] == "ok" and out["heldCount"] == 1 and out["published"] == []
    [held] = out["held"]
    assert held["id"] == iid and held["text"] == TEXT
    assert held["heldSince"].endswith("Z") and held["heldSince"][:4] == time.strftime("%Y", time.gmtime(before))
    poll(mods)  # no answer yet: still held
    assert [h["id"] for h in items(bi)["held"]] == [iid]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    out = items(bi)
    assert out["held"] == [] and out["heldCount"] == 0
    [pub] = out["published"]
    assert pub == {"id": iid, "indexIntentId": INDEX_ID, "publishedAt": pub["publishedAt"], "approvedBy": "individual"}
    # R16 holds: the text is gone from the map, and the reader never returns any.
    assert "text" not in pub and TEXT not in json.dumps(out)


def test_a_rejected_held_intention_leaves_both_lists(tctx, serve, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    out = items(bi)
    assert out["held"] == [] and out["published"] == []


def test_an_expired_held_intention_leaves_both_lists(tctx, serve, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    for _ in range(3):  # core's expiry, re-proposed twice, then final
        serve.expire(f"{INFERRED}:{iid}")
        poll(mods)
    assert mods.ri._load_map()[iid]["approval"]["state"] == "expired"
    out = items(bi)
    assert out["held"] == [] and out["published"] == []


def test_a_withdrawn_held_intention_leaves_the_list(tctx, serve, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c2")
    assert items(bi)["held"] == []


def test_held_is_oldest_first(tctx, serve, mods, bi, monkeypatch):
    clock = [1_800_000_000.0]
    monkeypatch.setattr(mods.ri, "_clock", lambda: clock[0])
    first = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    clock[0] += 60
    second = call(tctx, {"text": SECOND, "source": "ambient"}, tool_call_id="c2")["intention_id"]
    assert [h["id"] for h in items(bi, now=clock[0])["held"]] == [first, second]
    assert items(bi, now=clock[0])["held"][0]["heldSince"] == "2027-01-15T08:00:00Z"


# --------------------------------------------------------------------------
# Published: what the receipt is built from
# --------------------------------------------------------------------------


def test_a_rule_publish_is_listed_as_rule(tctx, serve, index, mods, bi):
    serve.autonomy[INFERRED] = "autonomous"  # "publish, then tell me" and "publish" are this one policy
    out = call(tctx, {"text": TEXT, "source": "ambient"})
    assert out["published"] is True
    [pub] = items(bi)["published"]
    assert pub["id"] == out["intention_id"] and pub["approvedBy"] == "rule" and pub["indexIntentId"] == INDEX_ID
    assert items(bi)["held"] == []


def test_stated_and_personal_captures_are_never_returned(tctx, serve, index, mods, bi):
    stated = call(tctx, {"text": STATED, "source": "message"})
    assert stated["published"] is True  # the day-one policy clears a stated capture
    personal = call(tctx, {"text": SECOND, "source": "message", "publish": False, "reason": "personal"},
                    tool_call_id="c2")
    assert personal["published"] is False and personal.get("local_reason") == "personal"
    out = items(bi)
    assert out["held"] == [] and out["published"] == [] and out["heldCount"] == 0


def test_a_published_intention_withdrawn_since_is_not_receipted(tctx, serve, index, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    index.default = {"success": True}
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c3")
    assert mods.ri._load_map()[iid].get("archived") is True
    assert items(bi)["published"] == []


def test_a_publish_older_than_the_window_is_not_returned(tctx, serve, index, mods, bi):
    serve.autonomy[INFERRED] = "autonomous"
    call(tctx, {"text": TEXT, "source": "ambient"})
    now = time.time()
    assert len(items(bi, now=now)["published"]) == 1
    assert items(bi, now=now + bi.RECEIPT_WINDOW_S + 5)["published"] == []


# --------------------------------------------------------------------------
# Hand-written maps: the edges
# --------------------------------------------------------------------------


def write_map(home, intentions: dict) -> Path:
    path = Path(home) / "av-events" / "intentions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"v": 1, "intentions": intentions, "publishes": []}), encoding="utf-8")
    return path


def held_entry(iid: str, text: str, at: float, cls: str = INFERRED, state: str = "requested") -> dict:
    return {"published": False, "source": "ambient", "approval": {
        "class": cls, "key": f"{cls}:{iid}", "payload": json.dumps({"text": text}), "state": state,
        "opened_at": at, "updated_at": at}}


def uid(n: int) -> str:
    return f"01900000-0000-7000-8000-{n:012d}"


def test_a_long_text_is_shortened_and_the_count_is_the_total(on, bi, home):
    many = {uid(i): held_entry(uid(i), "word " * 100 if i == 0 else f"thing {i}", 1_000 + i) for i in range(25)}
    write_map(home, many)
    out = items(bi, now=2_000)
    assert out["heldCount"] == 25 and len(out["held"]) == bi.MAX_ITEMS
    first = out["held"][0]["text"]
    assert len(first) == bi.SUMMARY_CHARS and first.endswith("…") and "  " not in first


def test_malformed_entries_and_other_states_are_skipped(on, bi, home):
    write_map(home, {
        uid(1): held_entry(uid(1), TEXT, 1_000),
        uid(2): {**held_entry(uid(2), TEXT, 1_000), "source": "message"},  # not an inferred capture
        uid(3): {"published": False, "source": "ambient", "approval": {
            **held_entry(uid(3), TEXT, 1_000)["approval"], "key": f"{INFERRED}:{uid(4)}"}},  # key of another id
        uid(5): held_entry(uid(5), TEXT, 1_000, state="unfiled"),  # not yet asked
        uid(6): held_entry(uid(6), TEXT, 1_000, state="refused"),
        uid(7): {"published": False, "source": "ambient", "held_norm_hash": "0" * 64},  # held before approvals
        uid(9): held_entry(uid(9), TEXT, 1_000, cls=_tia.STATED_CLASS),  # a stated proposal, whatever its source
        "not an id": held_entry(uid(8), TEXT, 1_000),
    })
    out = items(bi, now=2_000)
    assert [h["id"] for h in out["held"]] == [uid(1)] and out["heldCount"] == 1


def test_a_corrupt_map_is_an_error_and_is_left_where_it_is(on, bi, home):
    path = write_map(home, {})
    path.write_text("{not json", encoding="utf-8")
    out = items(bi)
    assert out["status"] == "error" and out["reason"] == "map_unreadable" and out["held"] == []
    assert path.read_text(encoding="utf-8") == "{not json"
    assert sorted(p.name for p in path.parent.iterdir()) == ["intentions.json"]


def test_reading_never_writes_the_map(tctx, serve, mods, bi):
    call(tctx, {"text": TEXT, "source": "ambient"})
    path = Path(mods.ri.map_path())
    before = (path.read_bytes(), os.stat(path).st_mtime_ns)
    items(bi)
    assert (path.read_bytes(), os.stat(path).st_mtime_ns) == before


# --------------------------------------------------------------------------
# Run as a file, the way the brief script runs it
# --------------------------------------------------------------------------


def run_reader(home: Path, env_extra: dict, *args: str) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("AV_")}
    env.update(HERMES_HOME=str(home), **env_extra)
    done = subprocess.run([sys.executable, "-I", "-B", str(READER), *args], env=env, capture_output=True,
                          text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert done.stderr == ""
    return json.loads(done.stdout)


def test_run_as_a_file_reads_the_switches_from_dotenv(tmp_path):
    write_map(tmp_path, {uid(1): held_entry(uid(1), TEXT, 1_000)})
    assert run_reader(tmp_path, {})["status"] == "off"
    (tmp_path / ".env").write_text(
        "AV_RECORD_INTENTION=1\nAV_APPROVAL_ENABLED=true\nAV_APPROVAL_URL=http://127.0.0.1:4680\n", encoding="utf-8")
    out = run_reader(tmp_path, {}, "--now", "2000")
    assert out["status"] == "ok" and [h["text"] for h in out["held"]] == [TEXT]
    # A blank variable in the process environment wins over the dotfile (`_core.env`).
    assert run_reader(tmp_path, {"AV_RECORD_INTENTION": ""})["reason"] == "record_intention_off"
