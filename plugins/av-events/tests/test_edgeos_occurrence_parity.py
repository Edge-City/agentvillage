"""EDGEOS-OCCURRENCE: the observer reads `--occurrence` exactly as the EdgeOS script does.

`skills/edgeos/scripts/edgeos.ts` now percent-decodes an `--occurrence` value once
(a portal link's `?occ=` is `encodeURIComponent(start_time)`) and sends an
offset as the same instant in UTC. The av-events observer parses the same argv
on its own (`script_call`) for the action events and the confirming-read
receipt; if the two disagreed, the evidence could name another occurrence than
the one EdgeOS was sent. One table, `skills/edgeos/scripts/tests/occurrence-parity.json`,
runs through both parsers (the script's side: `skills/edgeos/scripts/tests/edgeos.test.ts`).
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path

import pytest

TABLE = Path(__file__).resolve().parents[3] / "skills" / "edgeos" / "scripts" / "tests" / "occurrence-parity.json"
CASES = json.loads(TABLE.read_text(encoding="utf-8"))["cases"]
EVENT = "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a"
SCRIPT = "bun skills/edgeos/scripts/edgeos.ts"


@pytest.fixture()
def edgeos(plugin):
    return __import__(f"{plugin.__name__}._edgeos", fromlist=["_edgeos"])


@pytest.fixture()
def box(home, tmp_path_factory, monkeypatch):
    """`home` is $HERMES_HOME, the folder the observer trusts as the script's working directory; HOME is a
    separate clean directory (no global bunfig), as in test_edgeos_skill_recipes.py."""
    monkeypatch.setenv("HOME", str(tmp_path_factory.mktemp("user-home")))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    return home


def test_the_table_covers_every_form():
    assert len(CASES) > 30
    assert any(c["sends"] is None for c in CASES)
    assert any("%25" in c["input"] and c["sends"] is None for c in CASES), "a doubly-encoded row"
    assert any("%2B05%3A30" in c["input"] and c["sends"] for c in CASES), "an encoded offset row"
    assert any(c["input"].endswith("+05:30") and c["sends"] for c in CASES), "an offset row"


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_script_occurrence_matches_the_script(edgeos, case):
    assert edgeos.script_occurrence(case["input"]) == case["sends"], case["input"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_a_read_names_the_occurrence_the_script_sends(edgeos, box, case):
    """A single-event read keys the confirming read by its `occurrence_start`:
    it must be the value the script sent, or no label at all when the script
    refuses the argument (it then sends nothing)."""
    command = f"{SCRIPT} event {EVENT} --occurrence {shlex.quote(case['input'])}"
    call = edgeos.http_call("terminal", {"command": command, "workdir": str(box)})
    if case["sends"] is None:
        assert call is None, command
    else:
        assert call is not None, command
        assert call.query == {"occurrence_start": case["sends"]}


@pytest.mark.parametrize("verb", ["rsvp", "cancel", "participants"])
def test_every_occurrence_verb_reads_the_same_forms(edgeos, box, verb):
    for case in CASES:
        command = f"{SCRIPT} {verb} {EVENT} --occurrence {shlex.quote(case['input'])}"
        call = edgeos.http_call("terminal", {"command": command, "workdir": str(box)})
        assert (call is not None) == (case["sends"] is not None), command
        if call is not None and verb == "participants":
            assert call.query["occurrence_start"] == case["sends"]
