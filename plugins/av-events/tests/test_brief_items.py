"""DATA-314 brief-lite (carried from DATA-222, PR #183): the morning brief's
read-only count of inferred intentions awaiting the resident's answer.

The map is written by the real `record_intention` flow through approval.md
(the fakes and fixtures of `test_intent_approval.py`, loaded from its file
because this suite runs in importlib mode); a few tests write a map by hand.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import subprocess
import sys
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

READER = Path(__file__).resolve().parents[1] / "_brief_items.py"
SECOND = "Hoping to find someone to practise Konkani with over breakfast"


@pytest.fixture()
def bi(plugin, av):
    return importlib.import_module(f"{av.MODULE_NAME}._brief_items")


def test_off_switches_count_nothing(tctx, mods, bi, monkeypatch):
    call(tctx, {"text": TEXT, "source": "ambient"})
    assert bi.brief_items()["heldCount"] == 1
    monkeypatch.setenv("AV_RECORD_INTENTION", "0")
    assert bi.brief_items() == {"v": 1, "status": "off", "reason": "record_intention_off", "heldCount": 0}
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "0")
    assert bi.brief_items() == {"v": 1, "status": "off", "reason": "approval_off", "heldCount": 0}


def test_held_is_a_count_without_text_until_answered(tctx, serve, mods, bi):
    first = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    call(tctx, {"text": SECOND, "source": "ambient"}, tool_call_id="c2")
    out = bi.brief_items()
    assert out == {"v": 1, "status": "ok", "reason": None, "heldCount": 2}
    assert TEXT not in json.dumps(out) and SECOND not in json.dumps(out) and first not in json.dumps(out)
    serve.grant(f"{INFERRED}:{first}")
    poll(mods)
    assert bi.brief_items()["heldCount"] == 1


def write_map(home, intentions: dict) -> Path:
    path = Path(home) / "av-events" / "intentions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"v": 1, "intentions": intentions, "publishes": []}), encoding="utf-8")
    return path


def held_entry(iid: str, cls: str = INFERRED, state: str = "requested", source: str = "ambient") -> dict:
    return {"published": False, "source": source, "approval": {
        "class": cls, "key": f"{cls}:{iid}", "payload": json.dumps({"text": TEXT}), "state": state,
        "opened_at": 1_800_000_000.0, "updated_at": 1_800_000_000.0}}


def uid(n: int) -> str:
    return f"01900000-0000-7000-8000-{n:012d}"


def test_only_open_inferred_ambient_proposals_count(on, bi, home):
    write_map(home, {
        uid(1): held_entry(uid(1)),
        uid(2): held_entry(uid(2), source="message"),
        uid(3): {**held_entry(uid(3)), "approval": {**held_entry(uid(3))["approval"], "key": f"{INFERRED}:{uid(4)}"}},
        uid(5): held_entry(uid(5), state="unfiled"),
        uid(6): held_entry(uid(6), state="published"),
        uid(7): held_entry(uid(7), cls=STATED_CLASS),
        uid(8): {"published": True, "source": "ambient", "approval": ["not", "a", "dict"]},
        "not an id": held_entry(uid(9)),
    })
    assert bi.brief_items() == {"v": 1, "status": "ok", "reason": None, "heldCount": 1}


def test_a_corrupt_map_is_an_error_and_is_left_as_it_is(on, bi, home):
    path = write_map(home, {})
    path.write_text("{not json", encoding="utf-8")
    assert bi.brief_items() == {"v": 1, "status": "error", "reason": "map_unreadable", "heldCount": 0}
    assert path.read_text(encoding="utf-8") == "{not json"
    assert sorted(p.name for p in path.parent.iterdir()) == ["intentions.json"]


def test_no_map_counts_nothing_and_creates_nothing(on, bi, home):
    assert bi.brief_items()["heldCount"] == 0
    assert not (Path(home) / "av-events").exists()


def test_run_as_a_file_reads_the_switches_from_dotenv(tmp_path):
    write_map(tmp_path, {uid(1): held_entry(uid(1)), uid(2): held_entry(uid(2))})
    env = {k: v for k, v in os.environ.items() if not k.startswith("AV_")}
    env["HERMES_HOME"] = str(tmp_path)

    def run(extra: dict) -> dict:
        done = subprocess.run([sys.executable, "-I", "-B", str(READER)], env={**env, **extra},
                              capture_output=True, text=True, timeout=60)
        assert done.returncode == 0, done.stderr
        assert done.stderr == ""
        return json.loads(done.stdout)

    assert run({})["status"] == "off"
    (tmp_path / ".env").write_text(
        "AV_RECORD_INTENTION=1\nAV_APPROVAL_ENABLED=true\nAV_APPROVAL_URL=http://127.0.0.1:4680\n", encoding="utf-8")
    out = run({})
    assert out == {"v": 1, "status": "ok", "reason": None, "heldCount": 2}
    assert TEXT not in json.dumps(out)
    # A blank variable in the process environment wins over the dotfile (`_core.env`).
    assert run({"AV_RECORD_INTENTION": ""})["reason"] == "record_intention_off"
