"""DATA-222: the morning brief's read-only reader of the intention map.

The map is written by the real `record_intention` flow through approval.md
(the fakes and fixtures of `test_intent_approval.py`, loaded from its file
because this suite runs in importlib mode), so a change to what that flow
writes shows up here. A few tests write a map by hand for the edges.
"""

from __future__ import annotations

import importlib
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
STATED_CLASS = _tia.STATED_CLASS
TEXT = _tia.TEXT
STATED = _tia.STATED
INDEX_ID = _tia.INDEX_ID

READER = Path(__file__).resolve().parents[1] / "_brief_items.py"
SECOND = "Hoping to find someone to practise Konkani with over breakfast"
EMPTY = {"heldCount": 0, "published": [], "publishedCount": 0, "skipped": 0}


@pytest.fixture()
def bi(plugin, av):
    return importlib.import_module(f"{av.MODULE_NAME}._brief_items")


def items(bi, now=None, exclude=()) -> dict:
    return bi.brief_items(now, exclude)


def no_text(out: dict, *texts: str) -> None:
    dumped = json.dumps(out)
    for text in texts:
        assert text not in dumped


# --------------------------------------------------------------------------
# Off is inert
# --------------------------------------------------------------------------


def test_record_intention_off_returns_nothing_even_with_held_entries(tctx, mods, bi, monkeypatch):
    call(tctx, {"text": TEXT, "source": "ambient"})
    assert items(bi)["heldCount"] == 1
    monkeypatch.setenv("AV_RECORD_INTENTION", "0")
    assert items(bi) == {"v": 2, "status": "off", "reason": "record_intention_off", **EMPTY}


def test_approval_url_missing_returns_nothing(tctx, mods, bi, monkeypatch):
    call(tctx, {"text": TEXT, "source": "ambient"})
    monkeypatch.delenv("AV_APPROVAL_URL")
    assert items(bi) == {"v": 2, "status": "off", "reason": "approval_off", **EMPTY}


def test_approval_switched_off_returns_nothing(tctx, mods, bi, monkeypatch):
    call(tctx, {"text": TEXT, "source": "ambient"})
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "0")
    assert items(bi) == {"v": 2, "status": "off", "reason": "approval_off", **EMPTY}


def test_no_map_is_empty_and_nothing_is_created(on, bi, home):
    out = items(bi)
    assert out == {"v": 2, "status": "ok", "reason": None, **EMPTY}
    assert not (Path(home) / "av-events").exists()


# --------------------------------------------------------------------------
# Held: a count of open approval requests, never their text (R16)
# --------------------------------------------------------------------------


def test_a_held_inferred_intention_is_counted_without_its_text_until_granted(tctx, serve, index, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    out = items(bi)
    assert out["status"] == "ok" and out["heldCount"] == 1 and out["published"] == []
    assert "held" not in out
    no_text(out, TEXT, iid)
    poll(mods)  # no answer yet: still held
    assert items(bi)["heldCount"] == 1
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    out = items(bi)
    assert out["heldCount"] == 0
    [pub] = out["published"]
    assert pub == {"id": iid, "indexIntentId": INDEX_ID, "publishedAt": pub["publishedAt"], "approvedBy": "individual"}
    assert out["publishedCount"] == 1
    no_text(out, TEXT)


def test_a_rejected_held_intention_leaves_both(tctx, serve, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    out = items(bi)
    assert out["heldCount"] == 0 and out["published"] == []


def test_an_expired_held_intention_leaves_both(tctx, serve, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    for _ in range(3):  # core's expiry, re-proposed twice, then final
        serve.expire(f"{INFERRED}:{iid}")
        poll(mods)
    assert mods.ri._load_map()[iid]["approval"]["state"] == "expired"
    out = items(bi)
    assert out["heldCount"] == 0 and out["published"] == []


def test_a_withdrawn_held_intention_leaves_the_count(tctx, serve, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c2")
    assert items(bi)["heldCount"] == 0


def test_two_held_count_two(tctx, serve, mods, bi):
    call(tctx, {"text": TEXT, "source": "ambient"})
    call(tctx, {"text": SECOND, "source": "ambient"}, tool_call_id="c2")
    out = items(bi)
    assert out["heldCount"] == 2
    no_text(out, TEXT, SECOND)


# --------------------------------------------------------------------------
# Published: what the receipt is built from
# --------------------------------------------------------------------------


def test_a_rule_publish_is_listed_as_rule(tctx, serve, index, mods, bi):
    serve.autonomy[INFERRED] = "autonomous"  # "publish, then tell me" and "publish" are this one policy
    out = call(tctx, {"text": TEXT, "source": "ambient"})
    assert out["published"] is True
    [pub] = items(bi)["published"]
    assert pub["id"] == out["intention_id"] and pub["approvedBy"] == "rule" and pub["indexIntentId"] == INDEX_ID
    assert items(bi)["heldCount"] == 0


def test_stated_and_personal_captures_are_never_returned(tctx, serve, index, mods, bi):
    stated = call(tctx, {"text": STATED, "source": "message"})
    assert stated["published"] is True  # the day-one policy clears a stated capture
    personal = call(tctx, {"text": SECOND, "source": "message", "publish": False, "reason": "personal"},
                    tool_call_id="c2")
    assert personal["published"] is False and personal.get("local_reason") == "personal"
    out = items(bi)
    assert out["heldCount"] == 0 and out["published"] == [] and out["publishedCount"] == 0


def test_a_published_intention_withdrawn_since_is_not_receipted(tctx, serve, index, mods, bi):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    index.default = {"success": True}
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c3")
    assert mods.ri._load_map()[iid].get("archived") is True
    assert items(bi)["published"] == []


def test_the_window_is_fourteen_days(tctx, serve, index, mods, bi):
    assert bi.RECEIPT_WINDOW_S == 14 * 86400
    serve.autonomy[INFERRED] = "autonomous"
    call(tctx, {"text": TEXT, "source": "ambient"})
    now = time.time()
    assert len(items(bi, now=now + 13 * 86400)["published"]) == 1
    assert items(bi, now=now + bi.RECEIPT_WINDOW_S + 5)["published"] == []


def test_excluded_ids_are_left_out_before_the_cap(tctx, serve, index, mods, bi):
    serve.autonomy[INFERRED] = "autonomous"
    first = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    out = items(bi, exclude=[first])
    assert out["published"] == [] and out["publishedCount"] == 0


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


def published_entry(iid: str, at: float, authorization="policy", **extra) -> dict:
    approval = {"class": INFERRED, "key": f"{INFERRED}:{iid}", "state": "published", "updated_at": at}
    if authorization is not None:
        approval["authorization"] = authorization
    return {"published": True, "source": "ambient", "index_intent_id": f"aaaaaaaa-{iid[-12:]}", "approval": approval,
            **extra}


def uid(n: int) -> str:
    return f"01900000-0000-7000-8000-{n:012d}"


T0 = 1_800_000_000.0


def test_only_requested_counts_as_held(on, bi, home):
    write_map(home, {
        uid(1): held_entry(uid(1), TEXT, T0),
        uid(2): {**held_entry(uid(2), TEXT, T0), "source": "message"},  # not an inferred capture
        uid(3): {"published": False, "source": "ambient", "approval": {
            **held_entry(uid(3), TEXT, T0)["approval"], "key": f"{INFERRED}:{uid(4)}"}},  # key of another id
        uid(5): held_entry(uid(5), TEXT, T0, state="unfiled"),  # not yet asked
        uid(6): held_entry(uid(6), TEXT, T0, state="refused"),
        uid(7): {"published": False, "source": "ambient", "held_norm_hash": "0" * 64},  # held before approvals
        uid(9): held_entry(uid(9), TEXT, T0, cls=STATED_CLASS),  # a stated proposal, whatever its source
        uid(10): held_entry(uid(10), TEXT, T0, state="cleared"),
        uid(11): held_entry(uid(11), TEXT, T0, state="starting"),
        uid(12): held_entry(uid(12), TEXT, T0, state="publishing"),
        "not an id": held_entry(uid(8), TEXT, T0),
    })
    out = items(bi, now=T0 + 60)
    assert out["heldCount"] == 1 and out["published"] == []
    no_text(out, TEXT)


def test_published_requires_published_true_and_the_published_state(on, bi, home):
    write_map(home, {
        uid(1): published_entry(uid(1), T0),
        uid(2): {**published_entry(uid(2), T0), "published": False},
        uid(3): {**published_entry(uid(3), T0), "published": "true"},
        uid(4): {**published_entry(uid(4), T0), "approval": {**published_entry(uid(4), T0)["approval"], "state": "publishing"}},
        uid(5): {**published_entry(uid(5), T0), "source": "message"},
    })
    out = items(bi, now=T0 + 60)
    assert [p["id"] for p in out["published"]] == [uid(1)] and out["publishedCount"] == 1


def test_a_missing_or_unknown_authorization_is_listed_without_a_qualifier(on, bi, home):
    write_map(home, {
        uid(1): published_entry(uid(1), T0, authorization=None),
        uid(2): published_entry(uid(2), T0 + 1, authorization="something"),
        uid(3): published_entry(uid(3), T0 + 2, authorization="grant"),
    })
    out = items(bi, now=T0 + 60)
    assert [(p["id"], p["approvedBy"]) for p in out["published"]] == [(uid(1), None), (uid(2), None), (uid(3), "individual")]


def test_published_is_oldest_first_capped_with_the_total(on, bi, home):
    n = bi.MAX_ITEMS + 5
    # Written newest first, so the order is the reader's own.
    write_map(home, {uid(i): published_entry(uid(i), T0 + i) for i in reversed(range(n))})
    out = items(bi, now=T0 + 3600)
    assert out["publishedCount"] == n
    assert [p["id"] for p in out["published"]] == [uid(i) for i in range(bi.MAX_ITEMS)]
    # The receipted oldest are left out before the cap, so the next ones come in.
    out = items(bi, now=T0 + 3600, exclude=[uid(i) for i in range(10)])
    assert out["publishedCount"] == n - 10
    assert [p["id"] for p in out["published"]] == [uid(i) for i in range(10, n)]
    out = items(bi, now=T0 + 3600, exclude=[uid(i) for i in range(3)])
    assert [p["id"] for p in out["published"]] == [uid(i) for i in range(3, 3 + bi.MAX_ITEMS)]


def test_one_bad_entry_never_blanks_the_answer(on, bi, home):
    path = write_map(home, {})
    good = published_entry(uid(1), T0)
    bad_nan = published_entry(uid(2), T0)
    bad_nan["approval"]["updated_at"] = float("nan")
    huge = published_entry(uid(3), T0)
    huge["approval"]["updated_at"] = 1e300
    future = published_entry(uid(6), T0)
    future["approval"]["updated_at"] = T0 + 1e10  # a representable time, centuries ahead
    text = json.dumps({"v": 1, "publishes": [], "intentions": {
        uid(1): good, uid(2): bad_nan, uid(3): huge, uid(4): held_entry(uid(4), TEXT, T0), uid(6): future,
        uid(5): {"published": True, "source": "ambient", "approval": ["not", "a", "dict"]},
    }})
    assert "NaN" in text
    path.write_text(text, encoding="utf-8")
    out = items(bi, now=T0 + 60)
    assert out["status"] == "ok" and out["heldCount"] == 1
    assert [p["id"] for p in out["published"]] == [uid(1)]
    # Rejected as times, not by the guard: nothing was skipped.
    assert out["skipped"] == 0


def test_an_entry_that_raises_is_skipped_alone(on, bi, home, monkeypatch):
    write_map(home, {uid(1): published_entry(uid(1), T0), uid(2): published_entry(uid(2), T0 + 1)})
    real = bi._published_item

    def flaky(intention_id, *args):
        if intention_id == uid(1):
            raise ValueError("boom")
        return real(intention_id, *args)

    monkeypatch.setattr(bi, "_published_item", flaky)
    out = items(bi, now=T0 + 60)
    assert out["status"] == "ok" and out["skipped"] == 1 and [p["id"] for p in out["published"]] == [uid(2)]


def test_a_corrupt_map_is_an_error_and_is_left_where_it_is(on, bi, home):
    path = write_map(home, {})
    path.write_text("{not json", encoding="utf-8")
    out = items(bi)
    assert out["status"] == "error" and out["reason"] == "map_unreadable" and out["published"] == []
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


def run_reader(home: Path, env_extra: dict, *args: str, stdin: str = "") -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("AV_")}
    env.update(HERMES_HOME=str(home), **env_extra)
    done = subprocess.run([sys.executable, "-I", "-B", str(READER), *args], env=env, capture_output=True,
                          text=True, timeout=60, input=stdin)
    assert done.returncode == 0, done.stderr
    assert done.stderr == ""
    return json.loads(done.stdout)


def test_run_as_a_file_reads_the_switches_from_dotenv_and_the_exclusions_from_stdin(tmp_path):
    now = time.time()
    write_map(tmp_path, {uid(1): held_entry(uid(1), TEXT, now), uid(2): published_entry(uid(2), now),
                         uid(3): published_entry(uid(3), now + 1)})
    assert run_reader(tmp_path, {})["status"] == "off"
    (tmp_path / ".env").write_text(
        "AV_RECORD_INTENTION=1\nAV_APPROVAL_ENABLED=true\nAV_APPROVAL_URL=http://127.0.0.1:4680\n", encoding="utf-8")
    out = run_reader(tmp_path, {})
    assert out["status"] == "ok" and out["heldCount"] == 1 and [p["id"] for p in out["published"]] == [uid(2), uid(3)]
    assert TEXT not in json.dumps(out)
    out = run_reader(tmp_path, {}, "--exclude-stdin", stdin=json.dumps([uid(2)]))
    assert [p["id"] for p in out["published"]] == [uid(3)]
    # Garbage on stdin excludes nothing.
    assert len(run_reader(tmp_path, {}, "--exclude-stdin", stdin="not json")["published"]) == 2
    # A blank variable in the process environment wins over the dotfile (`_core.env`).
    assert run_reader(tmp_path, {"AV_RECORD_INTENTION": ""})["reason"] == "record_intention_off"
