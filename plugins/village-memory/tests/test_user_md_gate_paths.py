"""The USER.md gate's other paths (review-b ov#558 S1, S2; context seat on N3 and the S2 write finding).

- One block, byte-identical in village-memory and av-events (`_user_md_gate.py`).
- PRIVATE_ENTRY_MARKS: the setup profile and the GODCONST conversation note, pinned to cp's CP_ENTRY_MARKS;
  the vote note is village data and stays.
- The memory tool outside a private session: results leave Private entries out (`transform_memory_result`),
  except a line a non-private session wrote itself or the call carries (review-b ov#565 S1-r3), and a USER.md
  change or removal is refused while an add goes through (`memory_write_directive`, ov#565 N1-r3), on the
  target and action only (review-b ov#563 S1-d: no guess-confirm oracle; the matrix below).
- Fingerprints: an entry this process has seen marked is still known after its mark has gone, with one set
  per process that both copies read (ov#563 N4-d).
- Both copies fail closed and treat an unknown chat type as not private (ov#563 N1-d); a failed install is
  logged once (N7-d).
Synthetic fixtures only. Hermes is not imported here (stand-ins); the real-Hermes paths are in
test_village_memory_hermes.py.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import types
from pathlib import Path

import pytest

SEP = "═" * 46
SETUP = "[Edge City profile, written at setup]\nSynthetic Resident, Tidepool Bay. Builds kelp sensors for the harbour."
GODCONST = ("[God Constitution conversation, kept by the Agent Village control plane]\nYour human submitted a ballot "
            "on the draft constitution. Ask them one question at a time.")
VOTE = "[Village vote, kept by the Agent Village app]\nThe weekly theme vote closes Friday."
NOTE = "Prefers calls before noon."
BEGIN, END = "# ==== USER.md GATE: one block", "# ==== END USER.md GATE"
CP_MEMORY_ENTRY = Path(os.environ.get("AV_CP_SRC") or Path.home() / "dev" / "agentvillage" / "controlplane") / \
    "control-plane" / "src" / "memory-entry.js"


def user_block(*entries: str) -> str:
    """Hermes's `_render_block`: the usage figure counts the entries it holds (the gate recounts it for the
    entries a group sees, review-b ov#565 S1-r4)."""
    content = "\n§\n".join(entries)
    return f"{SEP}\nUSER PROFILE (who the user is) [{len(content) * 100 // 24000}% — {len(content):,}/24,000 chars]\n{SEP}\n{content}"


@pytest.fixture()
def gate(h):
    """av-events' copy, loaded as a plain module (it is self-contained), fingerprints cleared."""
    path = h.AV_EVENTS_DIR / "_user_md_gate.py"
    spec = importlib.util.spec_from_file_location("av_test_user_md_gate", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module._gate_reset_for_tests()
    return module


@pytest.fixture(params=["av-events", "village-memory"])
def gate_copy(request):
    """Each copy of the block in turn (they are byte-identical; a mutant in either must die)."""
    return request.getfixturevalue("gate" if request.param == "av-events" else "vm")


@pytest.fixture()
def group_session(monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.delenv("HERMES_PLATFORM", raising=False)


@pytest.fixture()
def dm_session(monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.delenv("HERMES_PLATFORM", raising=False)


@pytest.fixture()
def user_md(tmp_path, monkeypatch):
    """A stand-in `tools.memory_tool_store` whose `_path_for("user")` is a file we write."""
    path = tmp_path / "memories" / "USER.md"
    path.parent.mkdir(parents=True)

    class MemoryStore:
        @staticmethod
        def _path_for(target):
            return path if target == "user" else tmp_path / "memories" / "MEMORY.md"

    module = types.ModuleType("tools.memory_tool_store")
    module.MemoryStore = MemoryStore
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.memory_tool_store", module)

    def write(*entries):
        path.write_text("\n§\n".join(entries), encoding="utf-8")
        return path

    return write


# ---- one block, one set of marks ----------------------------------------------------------------------


def test_the_gate_block_is_byte_identical_in_both_plugins(h):
    def block(path):
        text = path.read_text(encoding="utf-8")
        start, end = text.index(BEGIN), text.index(END)
        return text[start:text.index("\n", end) + 1]

    assert block(h.PLUGIN_DIR / "__init__.py") == block(h.AV_EVENTS_DIR / "_user_md_gate.py")


def test_the_private_marks_are_cps_own_text(vm, gate):
    """Each mark is one of cp memory-entry.js CP_ENTRY_MARKS (the setup profile, the GODCONST note); the vote
    note and the tags entry are the other two and are not Private entries here."""
    cp_marks = ["[Edge City profile, written at setup]", "[Context tags, kept in the Agent Village app]",
                "[Village vote, kept by the Agent Village app]",
                "[God Constitution conversation, kept by the Agent Village control plane]"]
    if CP_MEMORY_ENTRY.is_file():
        body = CP_MEMORY_ENTRY.read_text(encoding="utf-8")
        listed = re.search(r"const CP_ENTRY_MARKS = Object\.freeze\(\[(.*?)\]\);", body, re.S)
        assert listed, "cp memory-entry.js CP_ENTRY_MARKS not found"
        assert re.findall(r"'([^']+)'", listed.group(1)) == cp_marks
    assert vm.PRIVATE_ENTRY_MARKS == gate.PRIVATE_ENTRY_MARKS == (cp_marks[0], cp_marks[3])


def test_the_godconst_note_goes_with_the_setup_profile_and_the_vote_note_stays(vm):
    out = vm.shared_user_block(user_block(SETUP, VOTE, GODCONST, NOTE))
    assert out == user_block(VOTE, NOTE)


# ---- the memory tool's results ------------------------------------------------------------------------


def _result(**fields):
    return json.dumps(fields, ensure_ascii=False)


def test_a_group_memory_result_leaves_private_entries_out(gate, group_session):
    raw = _result(success=False, error="No entry matched 'x'.", current_entries=[SETUP, NOTE, GODCONST, VOTE],
                  matches=[SETUP], replaced_entry=SETUP, removed_entry=GODCONST,
                  replaced_entries={"1": SETUP, "2": NOTE}, usage="12%")
    out = json.loads(gate.transform_memory_result(tool_name="memory", result=raw, session_id="tg-group"))
    assert out["current_entries"] == [NOTE, VOTE]
    assert out["matches"] == []
    assert out["replaced_entry"] == out["removed_entry"] == gate.LEFT_OUT
    assert out["replaced_entries"] == {"1": gate.LEFT_OUT, "2": NOTE}
    assert "usage" not in out  # no size figure outside a private session (review-b ov#565 S1-r4 (a))
    assert "kelp" not in json.dumps(out) and "ballot" not in json.dumps(out)


@pytest.mark.parametrize("session_id", ["cron_abc123", "tg-group"])
def test_a_cron_run_is_not_private(gate, monkeypatch, session_id):
    monkeypatch.delenv("HERMES_SESSION_CHAT_TYPE", raising=False)
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "cron" if session_id == "tg-group" else "")
    raw = _result(current_entries=[SETUP, NOTE])
    assert "kelp" not in gate.transform_memory_result(tool_name="memory", result=raw, session_id=session_id)


def test_a_dm_memory_result_is_untouched(gate, dm_session):
    raw = _result(current_entries=[SETUP, NOTE])
    assert gate.transform_memory_result(tool_name="memory", result=raw, session_id="tg-dm") is None


def test_other_tools_and_clean_results_are_untouched(gate, group_session):
    assert gate.transform_memory_result(tool_name="terminal", result=SETUP) is None
    assert gate.transform_memory_result(tool_name="memory", result=_result(success=True)) is None


def test_a_result_that_is_not_json_is_replaced_whole(gate, group_session):
    out = json.loads(gate.transform_memory_result(tool_name="memory", result=f"oops {SETUP}"))
    assert out == {"success": False, "error": gate.LEFT_OUT}


# ---- the memory tool's writes: target only, never content (review-b ov#563 S1-d) -----------------------

#: A whole line of SETUP (fingerprinted once seen marked), and a wrong guess of the same length.
RIGHT_GUESS = "Synthetic Resident, Tidepool Bay. Builds kelp sensors for the harbour."
WRONG_GUESS = "Synthetic Resident, Tidepool Bay. Builds kelp sensors for the estuary."
MARK_REFUSAL_TEXT = "That text carries a private-entry mark; only your private chat can write it."
REFUSAL_TEXT = ("Your human's profile notes (USER.md) can only be changed or removed in your private chat with "
                "them. You can still add a new note here.")


@pytest.mark.parametrize("args", [
    {"action": "replace", "target": "user", "old_text": "Builds kelp sensors", "content": "Builds kelp sensors"},
    {"action": "replace", "target": "user", "old_text": "[Edge City profile, written at setup]", "content": "x"},
    {"action": "replace", "target": "user", "old_text": "Prefers calls", "content": "Prefers calls after noon."},
    {"action": "remove", "target": "user", "old_text": "Tidepool Bay"},
    {"action": "remove", "target": "user", "old_text": "one question at a time"},
    {"action": "remove", "target": "user", "old_text": NOTE},
    {"action": "remove", "target": "user", "old_text": "no such text anywhere"},
    {"action": "batch", "target": "user", "operations": [{"action": "add", "content": "fine"},
                                                         {"action": "replace", "old_text": "Tidepool", "content": "y"}]},
    {"action": "batch", "target": "user", "operations": [{"action": "add", "content": "fine"}, {"content": "no action"}]},
    {"target": "user", "operations": [{"action": "add", "content": "fine"}, "not a dict"]},
    {"action": "batch", "target": "user", "operations": []},
    {"action": "view", "target": "user"},
    {"target": "user", "content": "no action"},
    {"action": "batch", "target": "memory", "operations": [{"action": "remove", "target": "user", "old_text": "x"}]},
])
def test_a_group_may_not_change_or_remove_user_md(gate_copy, group_session, user_md, args):
    """Every USER.md change or removal outside a private session (anything but an add, or a batch holding
    anything but adds) gets the same plain refusal, whatever it holds or matches, so no answer probes the
    setup text."""
    user_md(SETUP, NOTE, GODCONST)
    block = gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group")
    assert block == {"action": "block", "message": REFUSAL_TEXT}


@pytest.mark.parametrize("args", [
    {"action": "add", "target": "user", "content": "Likes kites."},
    {"action": "add", "target": "user", "content": RIGHT_GUESS},
    {"target": "user", "operations": [{"action": "add", "content": "fine"}, {"action": "add", "content": RIGHT_GUESS}]},
    {"action": "batch", "target": "user", "operations": [{"action": "add", "content": "fine"}]},
    {"action": "add", "target": "user", "content": "x", "operations": [{"action": "add", "content": "fine"}]},
    {"action": "batch", "target": "memory", "operations": [{"action": "add", "target": "user", "content": "x"}]},
    {"action": "add", "target": "user", "operations": []},
])
def test_a_group_may_add_an_unmarked_note_to_user_md(gate_copy, group_session, user_md, args):
    """Review-b ov#565 N1-r3: a group, a cron run and Hermes's background review fork after a group turn
    (agent/background_review.py:341) can add a note about the human to USER.md again, exactly like a
    MEMORY.md write (only a Private mark in the text is refused, on either target)."""
    user_md(SETUP, NOTE, GODCONST)
    assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None


@pytest.mark.parametrize("args", [
    {"action": "add", "target": "memory", "content": "Likes kites."},
    {"action": "add", "target": "memory", "content": RIGHT_GUESS},
    {"action": "replace", "target": "memory", "old_text": "[Edge City profile, written at setup]", "content": "y"},
    {"action": "replace", "target": "memory", "old_text": "Tidepool", "new_text": RIGHT_GUESS},
    {"action": "remove", "old_text": "an old note"},                                     # target defaults to memory
    {"action": "add", "target": None, "content": "Likes kites."},
    {"action": "batch", "target": "memory", "operations": [{"action": "add", "content": RIGHT_GUESS},
                                                           {"action": "remove", "old_text": "old"}]},
])
def test_a_group_may_write_memory_md_unless_it_writes_a_mark(gate_copy, group_session, user_md, args):
    """MEMORY.md writes go through whatever they hold, fingerprinted lines included; an old_text holding a
    mark only locates (the text written is what the mark check reads)."""
    user_md(SETUP, NOTE, GODCONST)
    assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None


def test_the_one_refusal_is_true_for_every_user_md_write(gate_copy):
    """Review-b ov#563 N3-d: one message, true for a replace, a remove and a batch holding one alike (an add
    is never refused now, ov#565 N1-r3, so "you can still add" is true); it names no entry."""
    assert gate_copy.MEMORY_WRITE_REFUSAL == REFUSAL_TEXT
    assert not hasattr(gate_copy, "MEMORY_WRITE_REFUSAL_ADD")
    assert not [mark for mark in gate_copy.PRIVATE_ENTRY_MARKS if mark in REFUSAL_TEXT]


@pytest.mark.parametrize("make_args", [
    lambda g: {"action": "add", "target": "memory", "content": g},
    lambda g: {"action": "add", "target": "memory", "content": f"remember for later:\n{g}\n"},
    lambda g: {"action": "add", "target": "user", "content": g},
    lambda g: {"action": "replace", "target": "memory", "old_text": g, "content": "x"},
    lambda g: {"action": "replace", "target": "memory", "old_text": "x", "content": g},
    lambda g: {"action": "replace", "target": "memory", "old_text": "x", "new_text": g},
    lambda g: {"action": "remove", "target": "memory", "old_text": g},
    lambda g: {"action": "remove", "old_text": g},
    lambda g: {"action": "replace", "target": "user", "old_text": g, "content": "y"},
    lambda g: {"action": "remove", "target": "user", "old_text": g},
    lambda g: {"action": "batch", "target": "memory", "operations": [{"action": "add", "content": g},
                                                                     {"action": "remove", "old_text": g}]},
], ids=["add-memory", "add-memory-multiline", "add-user", "replace-memory-old", "replace-memory-content",
        "replace-memory-new_text", "remove-memory", "remove-default-target", "replace-user", "remove-user", "batch"])
def test_a_right_guess_of_a_setup_line_gets_the_same_answer_as_a_wrong_one(gate_copy, group_session, user_md,
                                                                            make_args):
    """Review-b ov#563 S1-d: a group that guesses a whole setup-profile line exactly gets the answer a wrong
    guess gets, so the write check confirms nothing."""
    user_md(SETUP, NOTE)
    gate_copy.shared_user_block(user_block(SETUP, NOTE))  # this process saw the entry marked: fingerprints taken
    assert gate_copy.holds_private_entry(RIGHT_GUESS) and not gate_copy.holds_private_entry(WRONG_GUESS)
    right = gate_copy.memory_write_directive(tool_name="memory", args=make_args(RIGHT_GUESS), session_id="tg-group")
    wrong = gate_copy.memory_write_directive(tool_name="memory", args=make_args(WRONG_GUESS), session_id="tg-group")
    assert right == wrong


def test_a_guessed_setup_line_may_be_added_to_either_store(gate_copy, group_session, user_md):
    user_md(SETUP, NOTE)
    gate_copy.shared_user_block(user_block(SETUP, NOTE))
    for target in ("memory", "user"):
        note = {"action": "add", "target": target, "content": RIGHT_GUESS}
        assert gate_copy.memory_write_directive(tool_name="memory", args=note, session_id="tg-group") is None
    change = {"action": "replace", "target": "user", "old_text": "Tidepool", "content": RIGHT_GUESS}
    assert gate_copy.memory_write_directive(tool_name="memory", args=change, session_id="tg-group") == {
        "action": "block", "message": REFUSAL_TEXT}


# The memory tool's result shapes (Hermes v2026.9.24 tools/memory_tool_store.py): a write's success never
# echoes the entries (`_success_response`); a no-match edit echoes old_text in its error and the target's
# whole inventory (`_locate`: `current_entries`); an add or replace over the limit echoes the inventory
# (`_failure_with_entries`); a replace or remove echoes the entry it overwrote (`replaced_entry`,
# `removed_entry`, batch `replaced_entries` / `removed_entries`). A view stands for any read-back.
def _add_ok(target="memory"):
    return _result(success=True, done=True, target=target, usage="1% — 120/2,200", entry_count=3,
                   message="Entry added.", note="Write saved. This update is complete — do not repeat it.")


def _own(g, target="memory", content=None):
    """The group's own earlier write of the guess (recorded as self-written by the write check)."""
    return {"action": "add", "target": target, "content": g if content is None else content}


@pytest.mark.parametrize("call", [
    lambda g: (None, {"action": "add", "target": "memory", "content": g}, _add_ok()),
    lambda g: (_own(g), {"action": "view", "target": "memory"}, _result(success=True, current_entries=[NOTE, g])),
    lambda g: (None, {"action": "replace", "target": "memory", "old_text": "kites", "new_text": g},
               _result(success=True, done=True, target="memory", message="Entry replaced.", replaced_entry="Likes kites.")),
    lambda g: (_own(g), {"action": "remove", "target": "memory", "old_text": f"x\n{g}\ny"},
               _result(success=False, error=f"No entry matched 'x\n{g}\ny'. Check current_entries below.",
                       current_entries=[NOTE, g])),
    lambda g: (None, {"action": "remove", "target": "memory", "old_text": f"x\n{g}\ny"},
               _result(success=False, error=f"No entry matched 'x\n{g}\ny'. Check current_entries below.",
                       current_entries=[NOTE])),
    lambda g: (_own(g, content=f"remember for later:\n{g}"), {"action": "remove", "target": "memory", "old_text": "remember"},
               _result(success=True, done=True, target="memory", message="Entry removed.",
                       removed_entry=f"remember for later:\n{g}")),
    lambda g: (_own(g), {"action": "add", "target": "memory", "content": "Likes kites."},
               _result(success=False, error="Memory at 2,190/2,200 chars.", current_entries=[NOTE, g])),
    lambda g: (None, {"action": "add", "target": "memory", "operations": [{"action": "add", "content": g}]},
               _result(success=False, error=f"Operation 1 (add): content is required. {g}")),
    lambda g: (_own(g), {"action": "batch", "operations": [{"action": "remove", "old_text": "remember"}]},
               _result(success=True, done=True, target="memory", removed_entries={"1": g})),
    lambda g: (None, {"action": "add", "target": "user", "content": g}, _add_ok("user")),
    lambda g: (_own(g, "user"), {"action": "add", "target": "user", "content": "Likes kites."},
               _result(success=False, error="Memory at 23,990/24,000 chars.", current_entries=[NOTE, g])),
    lambda g: (_own(g, "user"), {"action": "add", "target": "user", "content": g},
               _result(success=True, done=True, target="user", message="Entry already exists (no duplicate added).")),
], ids=["add", "view", "replace", "no-match-echo-and-inventory", "no-match-echo-only", "removed-own-note",
        "add-over-limit", "operations-batch", "batch-removed-entries", "add-user", "add-user-over-limit",
        "add-user-again"])
def test_a_group_result_is_the_same_for_a_right_and_a_wrong_guess(gate_copy, group_session, user_md, call):
    """Review-b ov#563 S1-d and ov#565 S1-r3, the result half: a group's own note (USER.md or MEMORY.md)
    reads back unchanged even when it equals a setup-profile line (a fingerprint does not count for an
    entry a non-private session wrote itself or the call carries), so the answer is the same, with the
    guess in place, for a right and a wrong guess. An add's reply loses its size figures and reads
    "Entry added." even when Hermes deduped it (ov#565 S1-r4 (a)); nothing else is touched."""
    user_md(SETUP, NOTE)
    answers = []
    for guess in (RIGHT_GUESS, WRONG_GUESS):
        gate_copy._gate_reset_for_tests()
        gate_copy.shared_user_block(user_block(SETUP, NOTE))  # fingerprints taken
        assert gate_copy.holds_private_entry(RIGHT_GUESS) and not gate_copy.holds_private_entry(WRONG_GUESS)
        prior, args, raw = call(guess)
        if prior is not None:
            assert gate_copy.memory_write_directive(tool_name="memory", args=prior, session_id="tg-group") is None
        assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None
        out = gate_copy.transform_memory_result(tool_name="memory", args=args, result=raw, session_id="tg-group")
        answers.append(None if out is None else out.replace(guess, "<guess>"))
    assert answers[0] == answers[1]
    if '"usage"' not in raw and '"entry_count"' not in raw and "already exists" not in raw and not re.search(r"\d/\d", raw):
        assert answers == [None, None]
    else:
        assert answers[0] is not None and '"usage"' not in answers[0] and '"entry_count"' not in answers[0]
        assert "already exists" not in answers[0] and not re.search(r"\d/\d", answers[0])


@pytest.mark.parametrize("args", [
    None, "not a dict", {"action": "view", "target": "user"}, {"target": "user"},
    {"action": "add", "target": "memory", "operations": [{"action": "add", "target": "user"}]},
    {"target": "MEMORY"}, {"target": "memory", "operations": ["not a dict"]},
    {"action": "view", "target": "memory"}, {"action": "remove", "target": "memory", "old_text": "no such note"},
    {"action": "add", "content": "Likes kites."}, {"target": "memory", "operations": [{"action": "add", "content": "x"}]},
])
def test_a_line_nobody_outside_a_private_session_wrote_is_lost_on_either_target(gate_copy, group_session, args):
    """A read-back on either store (or a call whose target is unknown: fail closed) still loses a mark-stripped
    line this process has seen marked, when no session that is not private wrote it (review-b ov#565 S1-r3:
    MEMORY.md results are fingerprinted again)."""
    gate_copy.shared_user_block(user_block(SETUP, NOTE))
    raw = _result(success=True, current_entries=[RIGHT_GUESS, NOTE])
    out = json.loads(gate_copy.transform_memory_result(tool_name="memory", args=args, result=raw,
                                                       session_id="tg-group"))
    assert out == {"success": True, "current_entries": [NOTE]}


@pytest.mark.parametrize("target", ["memory", "user"])
def test_a_group_result_always_loses_every_marked_entry(gate_copy, group_session, target):
    args = {"action": "remove", "target": target, "old_text": "nothing"}
    raw = _result(success=False, error="No entry matched 'nothing'.", current_entries=[SETUP, NOTE, GODCONST, VOTE],
                  replaced_entries={"1": SETUP, "2": NOTE})
    out = json.loads(gate_copy.transform_memory_result(tool_name="memory", args=args, result=raw, session_id="g"))
    assert out["current_entries"] == [NOTE, VOTE]
    assert out["replaced_entries"] == {"1": gate_copy.LEFT_OUT, "2": NOTE}
    assert gate_copy.transform_memory_result(tool_name="memory", args=args, result=f"oops {SETUP}") == json.dumps(
        {"success": False, "error": gate_copy.LEFT_OUT}, ensure_ascii=False)


@pytest.mark.parametrize(("args", "target"), [
    ({"action": "add", "target": "memory"}, "memory"), ({"action": "add"}, "memory"), ({}, "memory"),
    ({"action": "add", "target": None}, "memory"), ({"action": "add", "target": "user"}, "user"),
    ({"target": "memory", "operations": [{"action": "add"}, {"action": "remove", "target": "user"}]}, "user"),
    ({"target": "memory", "operations": [{"action": "add", "target": "memory"}]}, "memory"),
    ({"target": "memory", "operations": [None]}, "user"), ({"target": "USER"}, "user"), (None, "user"),
    ("memory", "user"),
])
def test_which_store_a_memory_call_reaches(gate_copy, args, target):
    assert gate_copy.memory_call_target(args) == target


def test_a_dm_keeps_the_whole_memory_tool(gate_copy, dm_session, user_md):
    """DM unchanged on all of it: every write goes through and no result is touched, fingerprinted or not."""
    user_md(SETUP, NOTE)
    gate_copy.shared_user_block(user_block(SETUP, NOTE))
    for args in ({"action": "replace", "target": "user", "old_text": "Tidepool", "content": "Harbour Bay"},
                 {"action": "add", "target": "user", "content": "[Edge City profile, written at setup]\nx"},
                 {"action": "add", "target": "user", "content": RIGHT_GUESS},
                 {"action": "remove", "target": "user", "old_text": NOTE},
                 {"action": "batch", "target": "user", "operations": [{"action": "remove", "old_text": "x"}]},
                 {"action": "add", "target": "memory", "content": RIGHT_GUESS}):
        assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-dm") is None
        raw = _result(success=False, current_entries=[SETUP, RIGHT_GUESS, NOTE])
        assert gate_copy.transform_memory_result(tool_name="memory", args=args, result=raw, session_id="tg-dm") is None


def test_malformed_args_are_refused_outside_a_private_session(gate, group_session):
    assert gate.memory_write_directive(tool_name="memory", args="not a dict")["action"] == "block"
    assert gate.memory_write_directive(tool_name="memory", args={"action": "batch", "operations": "x"})["action"] == "block"
    assert gate.memory_write_directive(tool_name="memory", args={"target": "memory", "operations": {"a": 1}})["action"] == "block"
    assert gate.memory_write_directive(tool_name="terminal", args={"command": "x"}) is None


# ---- fingerprints: text derived from a Private entry is still known -------------------------------------


def test_a_line_of_an_entry_seen_marked_is_still_private_after_its_mark_is_gone(gate, group_session):
    gate.shared_user_block(user_block(SETUP, NOTE))  # this process saw the entry with its mark
    stripped = "Synthetic Resident, Tidepool Bay. Builds kelp sensors for the harbour."
    assert gate.holds_private_entry(stripped)
    assert gate.shared_user_block(user_block(stripped, NOTE)) == user_block(NOTE)
    out = gate.transform_memory_result(tool_name="memory", result=_result(current_entries=[stripped, NOTE]))
    assert json.loads(out)["current_entries"] == [NOTE]
    assert not gate.holds_private_entry("Short line")


def test_load_from_disk_fingerprints_what_it_loads(gate, monkeypatch):
    class MemoryStore:
        def load_from_disk(self):
            self.user_entries = [SETUP, NOTE]

        def format_for_system_prompt(self, target):
            return None

    module = types.ModuleType("tools.memory_tool_store")
    module.MemoryStore = MemoryStore
    system_prompt = types.ModuleType("agent.system_prompt")
    system_prompt._memory_parts = lambda agent: []
    for name, value in (("tools", types.ModuleType("tools")), ("tools.memory_tool_store", module),
                        ("agent", types.ModuleType("agent")), ("agent.system_prompt", system_prompt)):
        monkeypatch.setitem(sys.modules, name, value)
    assert gate.install_user_md_gate() is True
    assert gate.install_user_md_gate() is True  # idempotent
    MemoryStore().load_from_disk()
    assert gate.holds_private_entry("Synthetic Resident, Tidepool Bay. Builds kelp sensors for the harbour.")


def test_a_group_that_strips_the_mark_then_reads_gets_no_setup_text(gate, group_session, user_md):
    """The context seat's scenario: the replace that strips the mark is refused; the next no-match read is
    redacted, so the raw text never reaches the group."""
    path = user_md(SETUP, NOTE)
    strip = {"action": "replace", "target": "user", "old_text": "[Edge City profile, written at setup]\n",
             "content": ""}
    assert gate.memory_write_directive(tool_name="memory", args=strip)["action"] == "block"
    assert path.read_text(encoding="utf-8").startswith("[Edge City profile")  # nothing written
    miss = _result(success=False, error="No entry matched.", current_entries=path.read_text(encoding="utf-8").split("\n§\n"))
    out = gate.transform_memory_result(tool_name="memory", result=miss)
    assert "kelp" not in out and "Tidepool" not in out


def test_tools_md_says_never_edit_the_setup_entry(h):
    """Review-b #558 N2: the setup entry is matched by its mark, so the agent must never rewrite it."""
    tools = (h.PLUGIN_DIR.parents[1] / "skills" / "index-network" / "tools.md").read_text(encoding="utf-8")
    assert "Never edit, rewrite or remove the entry headed `[Edge City profile, written at setup]` either" in tools
    # ov#565 N1-r3: outside the private chat USER.md takes a new note but no change or removal.
    # Worded without "cannot ... change": own-profile-copy.test.ts holds tools.md free of any line that reads
    # as "the agent cannot change the profile" (DATA-413).
    assert ("Outside your private chat with them (a group, a cron run) you can add a new note to `memories/USER.md`; "
            "changing or removing a USER.md note works only in your private chat.") in tools


# ---- private only on positive evidence (security review: no fail-open default) -----------------------------


@pytest.mark.parametrize(("platform", "chat_type", "session_id", "private"), [
    ("telegram", "dm", "tg-dm", True), ("telegram", "private", "tg-dm", True), ("cli", "", "s", True),
    ("telegram", "group", "tg-g", False), ("telegram", "", "tg-x", False), ("", "", "", False),
    ("", "", "unknown-session", False), ("api_server", "", "s", False), ("telegram", "dm", "cron_1", False),
    ("cron", "", "s", False),
])
def test_session_privacy_needs_positive_evidence(gate, monkeypatch, platform, chat_type, session_id, private):
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", platform)
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    monkeypatch.delenv("HERMES_PLATFORM", raising=False)
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.setitem(sys.modules, "hermes_state", None)  # no session store either
    assert gate.session_is_private_now(session_id) is private


@pytest.mark.parametrize(("row", "private"), [
    ({"source": "cli", "chat_type": None}, True), ({"source": "telegram", "chat_type": "dm"}, True),
    ({"source": "telegram", "chat_type": "group"}, False), ({"source": "telegram", "chat_type": None}, False),
    ({"source": "cron", "chat_type": "dm"}, False), (None, False),
    ({"source": "telegram", "chat_type": "thread"}, False), ({"source": "discord", "chat_type": "forum"}, False),
    ({"source": "telegram", "chat_type": "supergroup"}, False), ({"source": "cli", "chat_type": "x-unknown"}, False),
])
def test_with_no_session_context_hermess_session_row_decides(gate, monkeypatch, row, private):
    for name in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_TYPE", "HERMES_PLATFORM", "HERMES_CRON_SESSION"):
        monkeypatch.delenv(name, raising=False)

    class SessionDB:
        def __init__(self, read_only=False):
            assert read_only is True

        def get_session(self, session_id):
            return row if session_id == "s-1" else None

        def close(self):
            pass

    module = types.ModuleType("hermes_state")
    module.SessionDB = SessionDB
    monkeypatch.setitem(sys.modules, "hermes_state", module)
    assert gate.session_is_private_now("s-1") is private
    assert gate.session_is_private_now("") is False


def test_an_empty_gateway_session_gets_the_group_treatment(gate, monkeypatch, user_md):
    """The fail-open default the review found: empty platform and chat type are not private."""
    for name in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_TYPE", "HERMES_PLATFORM", "HERMES_CRON_SESSION"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setitem(sys.modules, "hermes_state", None)
    user_md(SETUP, NOTE)
    raw = _result(current_entries=[SETUP, NOTE])
    assert "kelp" not in gate.transform_memory_result(tool_name="memory", result=raw, session_id="")
    args = {"action": "remove", "target": "user", "old_text": "x"}
    assert gate.memory_write_directive(tool_name="memory", args=args)["action"] == "block"


# ---- review-b ov#563 N1-d: the three surviving mutants --------------------------------------------------


@pytest.mark.parametrize("platform", ["telegram", "discord", "cli"])
@pytest.mark.parametrize("chat_type", ["thread", "forum", "supergroup", "topic", "x-unknown-7"])
def test_an_unknown_chat_type_is_not_private(gate_copy, monkeypatch, user_md, platform, chat_type):
    """Only a direct chat type is private; a thread, forum, supergroup or any value this gate does not know
    is not, whatever the platform."""
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", platform)
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    monkeypatch.delenv("HERMES_PLATFORM", raising=False)
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.setitem(sys.modules, "hermes_state", None)
    user_md(SETUP, NOTE)
    assert gate_copy.session_is_private_now("s-1") is False
    out = gate_copy.transform_memory_result(tool_name="memory", result=_result(current_entries=[SETUP, NOTE]),
                                            session_id="s-1")
    assert json.loads(out)["current_entries"] == [NOTE]
    args = {"action": "remove", "target": "user", "old_text": NOTE}
    assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="s-1") == {
        "action": "block", "message": gate_copy.MEMORY_WRITE_REFUSAL}


def _boom(*_args, **_kwargs):
    raise RuntimeError("helper failed")


@pytest.mark.parametrize("broken", ["session_is_private_now", "redact_memory_result"])
def test_a_raising_result_filter_fails_closed(gate_copy, group_session, monkeypatch, broken):
    monkeypatch.setattr(gate_copy, broken, _boom)
    out = gate_copy.transform_memory_result(tool_name="memory", result=_result(current_entries=[SETUP, NOTE]),
                                            session_id="tg-group")
    assert out is not None and json.loads(out) == {"success": False, "error": gate_copy.LEFT_OUT}


@pytest.mark.parametrize("broken", ["session_is_private_now", "memory_call_target", "remember_self_written"])
def test_a_raising_write_check_fails_closed(gate_copy, group_session, monkeypatch, broken):
    """An add the check would allow is blocked when a helper raises (fail closed, never None)."""
    args = {"action": "add", "target": "memory", "content": "Likes kites."}
    assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None
    monkeypatch.setattr(gate_copy, broken, _boom)
    assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") == {
        "action": "block", "message": gate_copy.MEMORY_WRITE_REFUSAL}


# ---- review-b ov#563 N4-d: one fingerprint set per process ----------------------------------------------

STRIPPED = "Synthetic Resident, Tidepool Bay. Builds kelp sensors for the harbour."


def test_both_copies_read_one_fingerprint_set(vm, gate, group_session, user_md):
    """Fingerprints taken by either copy (the one whose hooks installed first) are seen by the other: the set
    lives on Hermes's MemoryStore class (here the stand-in), not in each module."""
    user_md(SETUP, NOTE)
    store = sys.modules["tools.memory_tool_store"].MemoryStore
    assert not gate.holds_private_entry(STRIPPED) and not vm.holds_private_entry(STRIPPED)
    vm.shared_user_block(user_block(SETUP, NOTE))  # the provider's copy sees the entry marked
    assert gate.holds_private_entry(STRIPPED)
    out = gate.transform_memory_result(tool_name="memory", result=_result(current_entries=[STRIPPED, NOTE]))
    assert json.loads(out)["current_entries"] == [NOTE]
    assert getattr(store, gate.DIGESTS_ATTR) is gate._private_line_digests() is vm._private_line_digests()
    assert not gate._PRIVATE_LINE_DIGESTS and not vm._PRIVATE_LINE_DIGESTS
    gate._gate_reset_for_tests()
    assert not vm.holds_private_entry(STRIPPED)
    gate.shared_user_block(user_block(SETUP, NOTE))  # and the other way round
    assert vm.holds_private_entry(STRIPPED)


def test_fingerprints_taken_at_load_by_one_copy_reach_the_other(vm, gate, monkeypatch):
    """village-memory installs the load gate; av-events' result filter (never installed here) still knows the
    stripped line."""

    class MemoryStore:
        def load_from_disk(self):
            self.user_entries = [SETUP, NOTE]

    module = types.ModuleType("tools.memory_tool_store")
    module.MemoryStore = MemoryStore
    system_prompt = types.ModuleType("agent.system_prompt")
    system_prompt._memory_parts = lambda agent: []
    for name, value in (("tools", types.ModuleType("tools")), ("tools.memory_tool_store", module),
                        ("agent", types.ModuleType("agent")), ("agent.system_prompt", system_prompt)):
        monkeypatch.setitem(sys.modules, name, value)
    assert vm.install_user_md_gate() is True
    MemoryStore().load_from_disk()
    assert gate.holds_private_entry(STRIPPED)


def test_fingerprints_taken_before_hermess_store_loads_are_kept(gate, monkeypatch):
    monkeypatch.delitem(sys.modules, "tools.memory_tool_store", raising=False)
    gate.shared_user_block(user_block(SETUP, NOTE))
    assert gate.holds_private_entry(STRIPPED) and gate._PRIVATE_LINE_DIGESTS
    module = types.ModuleType("tools.memory_tool_store")
    module.MemoryStore = type("MemoryStore", (), {})
    monkeypatch.setitem(sys.modules, "tools.memory_tool_store", module)
    assert gate.holds_private_entry(STRIPPED)
    assert not gate._PRIVATE_LINE_DIGESTS and getattr(module.MemoryStore, gate.DIGESTS_ATTR)


# ---- review-b ov#563 N7-d: an install that fails on import is logged once ------------------------------


def test_a_prompt_module_that_raises_on_import_is_logged_once_and_never_raises(gate_copy, tmp_path, monkeypatch,
                                                                                caplog):
    pkg = tmp_path / "fakehermes" / "agent"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "system_prompt.py").write_text("raise RuntimeError('import-time failure')\n", encoding="utf-8")
    agent = types.ModuleType("agent")
    agent.__path__ = [str(pkg)]  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "agent", agent)
    monkeypatch.delitem(sys.modules, "agent.system_prompt", raising=False)
    with caplog.at_level("DEBUG", logger="av-user-md-gate"):
        assert gate_copy.install_user_md_gate() is False
        assert gate_copy.install_user_md_gate() is False
    records = [r for r in caplog.records if r.name == "av-user-md-gate"]
    assert [r.levelname for r in records] == ["WARNING", "DEBUG"]
    assert all("RuntimeError" in r.getMessage() and str(tmp_path) not in r.getMessage() for r in records)


# ---- the write check reads a call the way Hermes dispatches it ------------------------------------------


@pytest.mark.parametrize("args", [
    # Hermes runs a batch whenever `operations` is non-empty, whatever `action` says (tools/memory_tool.py)
    {"action": "add", "target": "user", "operations": [{"action": "remove", "old_text": "Tidepool"}]},
    {"target": "user", "operations": [{"action": "replace", "old_text": "Tidepool", "new_text": "Harbour"}]},
    # and applies every op to the call's own target; an op's `target` is not read (memory_tool_store._batch)
    {"action": "batch", "target": "user", "operations": [{"action": "remove", "target": "memory", "old_text": "Tidepool"}]},
    # an op naming USER.md inside a MEMORY.md batch: refused all the same (fail closed)
    {"action": "batch", "target": "memory", "operations": [{"action": "remove", "target": "user", "old_text": "x"}]},
])
def test_the_write_check_reads_a_batch_the_way_hermes_runs_it(gate_copy, group_session, user_md, args):
    """A batch Hermes runs on USER.md is a USER.md write, however the call spells it."""
    user_md(SETUP, NOTE)
    assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") == {
        "action": "block", "message": gate_copy.MEMORY_WRITE_REFUSAL}


@pytest.mark.parametrize("args", [
    {"action": "add", "target": "memory", "content": "fine", "operations": [{"action": "add", "content": "also fine"}]},
    {"target": "memory", "operations": [{"action": "add", "content": "fine"}, {"action": "remove", "old_text": "old"}]},
])
def test_a_memory_md_batch_still_works_in_a_group(gate_copy, group_session, user_md, args):
    user_md(SETUP, NOTE)
    assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None


# ---- review-b ov#565 S1-r3 + N1-r3: self-written lines, the oracle matrix ---------------------------------

#: Hermes v2026.9.24's entry delimiter.
DELIM = "\n§\n"
FILLER = "Filler note about the harbour garden rota. " * 12


class FakeMemoryTool:
    """Hermes v2026.9.24's memory tool, its dispatch and result shapes (tools/memory_tool.py `memory_tool`,
    tools/memory_tool_store.py `add`, `_edit`, `_locate`, `_batch`, `_success_response`,
    `_failure_with_entries`, `_batch_failure`), on two in-memory stores with small limits. The real tool is
    driven in test_village_memory_hermes.py; this keeps the matrix in CI."""

    def __init__(self, user, memory, limits=(600, 400)):
        self.entries = {"user": list(user), "memory": list(memory)}
        self.limits = {"user": limits[0], "memory": limits[1]}

    def _usage(self, target):
        return f"{len(DELIM.join(self.entries[target])):,}/{self.limits[target]:,}"

    def _ok(self, target, message, **extra):
        return {"success": True, "done": True, "target": target, "usage": self._usage(target),
                "entry_count": len(self.entries[target]), "message": message, **extra}

    def _with_entries(self, target, message):
        return {"success": False, "error": message, "current_entries": list(self.entries[target]),
                "usage": self._usage(target)}

    def _find(self, entries, old_text):
        exact = [i for i, e in enumerate(entries) if e == old_text]
        hits = exact or [i for i, e in enumerate(entries) if old_text in e]
        return (hits[0] if len(hits) == 1 else None), len(hits) > 1

    def __call__(self, action=None, target="memory", content=None, old_text=None, new_text=None, operations=None):
        if content is None and new_text is not None:
            content = new_text
        target = "memory" if target is None else target
        if target not in ("memory", "user"):
            return json.dumps({"success": False, "error": f"Invalid memory target '{target}'. Use 'memory' or 'user'."})
        if operations:
            return json.dumps(self._batch(target, operations), ensure_ascii=False)
        if action == "add":
            return json.dumps(self._add(target, (content or "").strip()), ensure_ascii=False)
        if action in ("replace", "remove"):
            if not old_text:  # tools/memory_tool.py `_validate_single_op`: the inventory and its usage
                return json.dumps({"success": False, "error": f"'{action}' needs old_text. Reissue it with old_text set "
                                                             "to part of one of the current_entries below.",
                                   "current_entries": list(self.entries[target]), "usage": self._usage(target)},
                                  ensure_ascii=False)
            if not old_text.strip():
                return json.dumps({"success": False, "error": "old_text cannot be empty."})
            if action == "replace" and not (content or "").strip():
                return json.dumps({"success": False, "error": "new_content cannot be empty. Use 'remove' to delete entries."})
            new = (content or "").strip() if action == "replace" else None
            return json.dumps(self._edit(target, old_text.strip(), new), ensure_ascii=False)
        return json.dumps({"success": False, "error": f"Unknown action '{action}'. Use: add, replace, remove"})

    def _add(self, target, content):
        entries = self.entries[target]
        if not content:
            return {"success": False, "error": "Content cannot be empty."}
        if content in entries:
            return self._ok(target, "Entry already exists (no duplicate added).")
        if len(DELIM.join(entries + [content])) > self.limits[target]:
            return self._with_entries(target, f"Memory at {self._usage(target)} chars. Adding this entry "
                                              f"({len(content)} chars) would exceed the limit.")
        entries.append(content)
        return self._ok(target, "Entry added.")

    def _edit(self, target, old_text, new):
        entries = self.entries[target]
        idx, ambiguous = self._find(entries, old_text)
        if ambiguous:
            return {"success": False, "error": f"Multiple entries matched '{old_text}'. Be more specific.",
                    "matches": [e[:80] for e in entries if old_text in e]}
        if idx is None:
            verb = "replace" if new else "remove"
            return {"success": False, "error": f"No entry matched '{old_text}'. Check current_entries below and retry "
                                               f"with the exact text of the entry you want to {verb}.",
                    "current_entries": list(entries)}
        previous = entries[idx]
        changed = entries[:idx] + ([] if new is None else [new]) + entries[idx + 1:]
        if new is not None and len(DELIM.join(changed)) > self.limits[target]:
            return self._with_entries(target, "Replacement would put memory over the limit.")
        self.entries[target] = changed
        if new is None:
            return self._ok(target, "Entry removed.", removed_entry=previous)
        return self._ok(target, "Entry replaced.", replaced_entry=previous)

    def _batch(self, target, operations):
        working, matched = list(self.entries[target]), []
        for i, op in enumerate(op or {} for op in operations):
            act, pos = op.get("action"), f"Operation {i + 1} ({op.get('action') or 'unknown'})"
            content = (op.get("content") or op.get("new_text") or "").strip()
            old_text = (op.get("old_text") or "").strip()
            previous, msg = None, None
            if act == "add":
                if not content:
                    msg = f"{pos}: content is required."
                elif content not in working:
                    working.append(content)
            elif act not in ("replace", "remove"):
                msg = f"{pos}: unknown action. Use add, replace, or remove."
            elif not old_text:
                msg = f"{pos}: old_text is required."
            else:
                idx, ambiguous = self._find(working, old_text)
                if idx is None:
                    msg = f"{pos}: no entry matched '{old_text}'." if not ambiguous else f"{pos}: ambiguous."
                else:
                    previous = working[idx]
                    working[idx:idx + 1] = [content] if act == "replace" else []
            if msg:
                return {"success": False, "error": msg + " No operations were applied (batch is all-or-nothing).",
                        "usage": self._usage(target)}
            matched.append((act, previous))
        if len(DELIM.join(working)) > self.limits[target]:
            return {"success": False, "error": "Over the limit. No operations were applied (batch is all-or-nothing).",
                    "usage": self._usage(target)}
        self.entries[target] = working
        extra = {}
        for i, (act, previous) in enumerate(matched, 1):
            if previous is not None:
                extra.setdefault("replaced_entries" if act == "replace" else "removed_entries", {})[str(i)] = previous
        return self._ok(target, f"Applied {len(operations)} operation(s).", **extra)


#: Session kinds that are not private: a group, a cron run, an unknown chat type, no session metadata at all.
SESSION_KINDS = {
    "group": ({"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_TYPE": "group"}, "tg-group"),
    "cron": ({"HERMES_SESSION_PLATFORM": "telegram", "HERMES_CRON_SESSION": "1"}, "cron_abc123"),
    "unknown": ({"HERMES_SESSION_PLATFORM": "discord", "HERMES_SESSION_CHAT_TYPE": "forum"}, "dc-forum"),
    "no-metadata": ({}, ""),
}


@pytest.fixture(params=sorted(SESSION_KINDS))
def outside(request, monkeypatch):
    """Each non-private session kind in turn: its session id."""
    for name in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_TYPE", "HERMES_CRON_SESSION", "HERMES_PLATFORM"):
        monkeypatch.delenv(name, raising=False)
    env, session_id = SESSION_KINDS[request.param]
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setitem(sys.modules, "hermes_state", None)
    return session_id


NO_SUCH = "no such note anywhere in here"
SETUP_MARK = "[Edge City profile, written at setup]"

#: Review-b's 16 call shapes (ROUND 3 Q1) plus the round-3 fold's own (USER.md adds and their read-backs),
#: each a list of calls built from the guess. The guess equals a setup-profile line (right) or not (wrong).
MATRIX = {
    "add-memory": lambda g: [{"action": "add", "target": "memory", "content": g}],
    "add-user": lambda g: [{"action": "add", "target": "user", "content": g}],
    "replace-memory": lambda g: [{"action": "replace", "target": "memory", "old_text": g, "content": "Likes kites a lot."}],
    "remove-memory": lambda g: [{"action": "remove", "target": "memory", "old_text": g}],
    "remove-memory-multiline": lambda g: [{"action": "remove", "target": "memory", "old_text": f"x\n{g}\ny"}],
    "replace-user": lambda g: [{"action": "replace", "target": "user", "old_text": g, "content": "Likes kites a lot."}],
    "remove-user": lambda g: [{"action": "remove", "target": "user", "old_text": g}],
    "missing-old_text-memory": lambda g: [{"action": "replace", "target": "memory", "content": g}],
    "batch-user": lambda g: [{"target": "user", "operations": [{"action": "add", "content": g},
                                                                {"action": "remove", "old_text": g}]}],
    "add-shape-batch-user": lambda g: [{"action": "add", "target": "user",
                                        "operations": [{"action": "remove", "old_text": g}]}],
    "batch-op-memory-call-user": lambda g: [{"action": "batch", "target": "user", "operations": [
        {"action": "replace", "target": "memory", "old_text": g, "content": "x"}]}],
    "batch-memory": lambda g: [{"target": "memory", "operations": [{"action": "add", "content": g},
                                                                  {"action": "replace", "old_text": "kites",
                                                                   "content": "Likes kites a lot."}]}],
    "batch-memory-op-user": lambda g: [{"target": "memory", "operations": [
        {"action": "remove", "target": "user", "old_text": g}]}],
    "target-null": lambda g: [{"action": "add", "target": None, "content": g}],
    "read-back-memory": lambda g: [{"action": "add", "target": "memory", "content": g},
                                   {"action": "remove", "target": "memory", "old_text": NO_SUCH}],
    "read-back-in-batch": lambda g: [{"target": "memory", "operations": [{"action": "add", "content": g}]},
                                     {"action": "replace", "target": "memory", "old_text": NO_SUCH, "content": "y"}],
    "over-limit-memory": lambda g: [{"action": "add", "target": "memory", "content": g},
                                    {"action": "add", "target": "memory", "content": FILLER}],
    "own-note-removed": lambda g: [{"action": "add", "target": "memory", "content": f"remember for later:\n{g}"},
                                   {"action": "remove", "target": "memory", "old_text": "remember for later"}],
    "own-note-replaced": lambda g: [{"action": "add", "target": "memory", "content": g},
                                    {"action": "replace", "target": "memory", "old_text": g, "content": "Likes kites a lot."}],
    "batch-user-adds": lambda g: [{"target": "user", "operations": [{"action": "add", "content": g}]}],
    "over-limit-user": lambda g: [{"action": "add", "target": "user", "content": g},
                                  {"action": "add", "target": "user", "content": FILLER}],
    "add-user-twice": lambda g: [{"action": "add", "target": "user", "content": g},
                                 {"action": "add", "target": "user", "content": g}],
    "memory-batch-add-op-user": lambda g: [{"target": "memory", "operations": [
        {"action": "add", "target": "user", "content": g}]}, {"action": "remove", "old_text": NO_SUCH}],
    "add-user-whole-marked-entry": lambda g: [{"action": "add", "target": "user", "content": f"{SETUP_MARK}\n{g}"}],
    "add-memory-whole-marked-entry": lambda g: [{"action": "add", "target": "memory", "content": f"{SETUP_MARK}\n{g}"}],
    # ROUND 4 (a) widened: after an add, no later result shows by a size figure whether Hermes deduped it.
    "add-user-then-view": lambda g: [{"action": "add", "target": "user", "content": g}, {"action": "view", "target": "user"}],
    "add-user-then-search": lambda g: [{"action": "add", "target": "user", "content": g},
                                       {"action": "search", "target": "memory", "content": g}],
    "add-user-then-missing-old_text": lambda g: [{"action": "add", "target": "user", "content": g},
                                                 {"action": "replace", "target": "memory", "content": "Likes kites a lot."}],
    "add-memory-then-view": lambda g: [{"action": "add", "target": "memory", "content": g},
                                       {"action": "view", "target": "memory"}],
    "add-memory-then-missing-old_text": lambda g: [{"action": "add", "target": "memory", "content": g},
                                                   {"action": "remove", "target": "memory"}],
    "add-whole-dm-entry-then-missing-old_text": lambda g: [
        {"action": "add", "target": "memory", "content": f"{g}\n{DM_ONLY}"},
        {"action": "replace", "target": "memory", "content": "Likes kites a lot."}],
    "batch-user-marked-add": lambda g: [{"target": "user", "operations": [
        {"action": "add", "content": "Likes kites a lot."}, {"action": "add", "new_text": f"{SETUP_MARK}\n{g}"}]}],
}
#: The shapes the write check refuses (a USER.md change or removal); every other call runs.
MARKED = {"add-user-whole-marked-entry", "add-memory-whole-marked-entry", "batch-user-marked-add"}
REFUSED = {"replace-user", "remove-user", "batch-user", "add-shape-batch-user", "batch-op-memory-call-user",
           "batch-memory-op-user"} | MARKED
#: The shapes whose own call carries the DM-only line (a guess of the whole DM-made entry): it may show there.
CARRIES_DM_ONLY = {"add-whole-dm-entry-then-missing-old_text"}


def _run(gate_mod, session_id, calls, store):
    """Each call through the write check, then the tool, then the result filter: what the model sees, and
    the USER.md block a group prompt carries at the next load."""
    seen = []
    for args in calls:
        directive = gate_mod.memory_write_directive(tool_name="memory", args=args, session_id=session_id)
        if directive is not None:
            seen.append(["blocked", directive])
            continue
        raw = store(**args)
        out = gate_mod.transform_memory_result(tool_name="memory", args=args, result=raw, session_id=session_id)
        seen.append(["ran", raw if out is None else out])
    prompt = gate_mod.shared_user_block(user_block(*store.entries["user"]))
    return seen, prompt


#: A DM-only line that sits beside a setup line in a DM-made entry (fictional).
DM_ONLY = "Owner's partner works night shifts at the lighthouse."
#: Review-b ov#565 ROUND 4's seeds, the stores before the group's calls: A, only the marked setup entry;
#: B, plus an UNMARKED USER.md entry equal to one setup line (a DM-made copy); C, plus an unmarked USER.md
#: entry holding that line and a DM-only line; D, a MEMORY.md entry with the same two lines.
SEEDS = {
    "A": ([SETUP, NOTE], ["Likes kites."]),
    "B": ([SETUP, NOTE, RIGHT_GUESS], ["Likes kites."]),
    "C": ([SETUP, NOTE, f"{RIGHT_GUESS}\n{DM_ONLY}"], ["Likes kites."]),
    "D": ([SETUP, NOTE], ["Likes kites.", f"{RIGHT_GUESS}\n{DM_ONLY}"]),
}
#: Seed D's known differences (review-b ov#565 N2-r4, round-1 S4, owned by data, since v2.1.23): a MEMORY.md
#: replace or remove whose old_text is a substring of a DM-made MEMORY.md entry succeeds, a wrong one finds
#: no match. Nothing else may differ on D.
SEED_D_KNOWN = {"replace-memory", "remove-memory"}


def _matrix_transcripts(gate_mod, session_id, shape, seed):
    """Right and wrong guess, each from a fresh process state and the seed's stores: what the model sees
    and the next USER.md prompt block, the guess normalised out."""
    transcripts = []
    for guess in (RIGHT_GUESS, WRONG_GUESS):
        gate_mod._gate_reset_for_tests()
        gate_mod.shared_user_block(user_block(SETUP, NOTE))  # the process saw the entry marked
        assert gate_mod.holds_private_entry(RIGHT_GUESS) and not gate_mod.holds_private_entry(WRONG_GUESS)
        store = FakeMemoryTool(*SEEDS[seed])
        seen, prompt = _run(gate_mod, session_id, MATRIX[shape](guess), store)
        transcripts.append(json.dumps([seen, prompt], ensure_ascii=False).replace(json.dumps(guess)[1:-1], "<guess>"))
    return transcripts


@pytest.mark.parametrize("seed", sorted(SEEDS))
@pytest.mark.parametrize("shape", sorted(MATRIX))
def test_the_oracle_matrix_a_right_guess_gets_what_a_wrong_one_gets(gate_copy, outside, shape, seed):
    """Review-b ov#565 Q1, the round-3 fold and ROUND 4 (S1-r4 fold (c)): in a group, a cron run, an
    unknown chat type and with no session metadata, a right guess of a setup line and a same-length wrong
    one get byte-identical write checks, results and next-load USER.md prompt blocks (the guess normalised
    out), on every call shape and on seeds A, B and C. On seed D only N2-r4's two shapes differ. No
    transcript ever carries the DM-only line, or a DM-made copy of the setup line beside a wrong guess."""
    right, wrong = _matrix_transcripts(gate_copy, outside, shape, seed)
    if seed == "D" and shape in SEED_D_KNOWN:
        assert right != wrong  # N2-r4, stated in the README; the S4 fix is data's
    else:
        assert right == wrong
    first = json.loads(right)[0][0]
    assert first[0] == ("blocked" if shape in REFUSED else "ran")
    if shape in REFUSED:
        assert first[1] == {"action": "block", "message": MARK_REFUSAL_TEXT if shape in MARKED else REFUSAL_TEXT}
    for transcript in (right, wrong):
        assert "kelp sensors for the harbour" not in transcript and "Tidepool" not in transcript
        assert ("lighthouse" not in transcript or shape in CARRIES_DM_ONLY) and "already exists" not in transcript
        assert '\\"usage\\"' not in transcript and "entry_count" not in transcript  # escaped: results are JSON in JSON


def test_seeds_b_and_c_are_not_vacuous(gate, group_session, monkeypatch):
    """Review-b ov#565 S1-r4 on the stand-in, before the fold's normalisation: on seed B Hermes dedupes a
    right guess's USER.md add (a wrong one is added), and on seed C the DM-made entry holds the DM-only
    line; after the fold the group sees the same either way and never the DM-only line."""
    gate.shared_user_block(user_block(SETUP, NOTE))
    store = FakeMemoryTool(*SEEDS["B"])
    add = {"action": "add", "target": "user", "content": RIGHT_GUESS}
    assert gate.memory_write_directive(tool_name="memory", args=add, session_id="tg-group") is None
    raw = store(**add)
    assert json.loads(raw)["message"] == "Entry already exists (no duplicate added)."
    out = json.loads(gate.transform_memory_result(tool_name="memory", result=raw, session_id="tg-group", args=add))
    assert out == {"success": True, "done": True, "target": "user", "message": "Entry added."}
    # The group's own line and the DM's identical copy are one text: the prompt shows it once, as typed.
    assert gate.shared_user_block(user_block(*store.entries["user"])) == user_block(NOTE, RIGHT_GUESS)
    gate._gate_reset_for_tests()
    gate.shared_user_block(user_block(SETUP, NOTE))
    store = FakeMemoryTool(*SEEDS["C"])
    seen, prompt = _run(gate, "tg-group", MATRIX["add-user"](RIGHT_GUESS) + MATRIX["over-limit-user"](RIGHT_GUESS)[1:],
                        store)
    assert any(DM_ONLY in entry for entry in store.entries["user"])
    assert json.loads(seen[-1][1])["current_entries"] == [NOTE, RIGHT_GUESS]
    assert prompt == user_block(NOTE, RIGHT_GUESS) and DM_ONLY not in json.dumps(seen)
    # A DM keeps Hermes's own replies, the dedupe answer and the figures included.
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    store = FakeMemoryTool(*SEEDS["B"])
    for add in ({"action": "add", "target": "user", "content": RIGHT_GUESS},
                {"target": "user", "operations": [{"action": "add", "content": RIGHT_GUESS}]}):
        assert gate.memory_write_directive(tool_name="memory", args=add, session_id="tg-dm") is None
        raw = store(**add)
        assert '"entry_count": 3' in raw
        assert gate.transform_memory_result(tool_name="memory", result=raw, session_id="tg-dm", args=add) is None


def test_the_matrix_reads_back_the_guess_on_both_stores(gate, group_session):
    """The matrix is not vacuous: the read-back shapes return the group's own right-guess line in
    `current_entries`, a removed or replaced entry, and the next group prompt's USER.md block."""
    for shape, where in (("read-back-memory", "current_entries"), ("over-limit-memory", "current_entries"),
                         ("over-limit-user", "current_entries"), ("own-note-removed", "removed_entry"),
                         ("own-note-replaced", "replaced_entry")):
        gate._gate_reset_for_tests()
        gate.shared_user_block(user_block(SETUP, NOTE))
        store = FakeMemoryTool([SETUP, NOTE], ["Likes kites."])
        seen, _ = _run(gate, "tg-group", MATRIX[shape](RIGHT_GUESS), store)
        assert RIGHT_GUESS in json.dumps(json.loads(seen[-1][1])[where], ensure_ascii=False), shape
    _, prompt = _run(gate, "tg-group", MATRIX["add-user"](RIGHT_GUESS), FakeMemoryTool([SETUP, NOTE], []))
    assert prompt == user_block(NOTE, RIGHT_GUESS)


@pytest.mark.parametrize("copied_to", ["memory", "user"])
def test_s1_r3_a_private_line_a_dm_copied_stays_hidden_from_a_group(gate_copy, monkeypatch, copied_to):
    """Review-b ov#565 S1-r3: a DM copies an unmarked setup line into MEMORY.md (or USER.md); a group's
    no-match edit, over-limit add and next prompt never carry it, since no non-private session wrote it."""
    gate_copy.shared_user_block(user_block(SETUP, NOTE))
    store = FakeMemoryTool([SETUP, NOTE], ["Likes kites."])
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    copy = {"action": "add", "target": copied_to, "content": RIGHT_GUESS}
    seen, _ = _run(gate_copy, "tg-dm", [copy], store)
    assert json.loads(seen[0][1])["message"] == "Entry added."
    assert not gate_copy._self_written_digests()  # a DM's write is never recorded
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    seen, prompt = _run(gate_copy, "tg-group", [
        {"action": "remove", "target": copied_to, "old_text": NO_SUCH} if copied_to == "memory"
        else {"action": "add", "target": "user", "content": FILLER},
        {"target": "memory", "operations": [{"action": "add", "content": FILLER}]},
    ], store)
    assert RIGHT_GUESS not in json.dumps(seen, ensure_ascii=False)
    assert "Likes kites." in json.dumps(seen) if copied_to == "memory" else NOTE in json.dumps(seen)
    assert RIGHT_GUESS not in prompt and NOTE in prompt


def test_the_restart_residual_a_groups_own_right_guess_is_hidden_again_after_a_restart(gate, group_session):
    """The stated residual (review-b ov#565 S1-r3 fold): the self-written set lives in memory. After a
    restart (the set cleared, fingerprints retaken at load) a line the group wrote earlier that equals a
    setup line is hidden again, and a wrong guess is not: one bit per restart, only for a line that group
    already wrote."""
    reads = {}
    for guess in (RIGHT_GUESS, WRONG_GUESS):
        gate._gate_reset_for_tests()
        gate.shared_user_block(user_block(SETUP, NOTE))
        store = FakeMemoryTool([SETUP, NOTE], ["Likes kites."])
        before, before_prompt = _run(gate, "tg-group", MATRIX["read-back-memory"](guess) + MATRIX["add-user"](guess),
                                     store)
        gate._gate_reset_for_tests()  # the restart: nothing in memory survives ...
        gate.shared_user_block(user_block(SETUP, NOTE))  # ... and the load fingerprints the setup entry again
        after, after_prompt = _run(gate, "tg-group", [{"action": "remove", "target": "memory", "old_text": NO_SUCH}],
                                   store)
        reads[guess] = (guess in json.dumps(before, ensure_ascii=False), guess in before_prompt,
                        guess in json.dumps(after, ensure_ascii=False), guess in after_prompt)
    assert reads[WRONG_GUESS] == (True, True, True, True)
    assert reads[RIGHT_GUESS] == (True, True, False, False)


def test_a_whole_entry_the_call_itself_names_is_its_own(gate_copy, group_session):
    """The own-call exemption, whole entry (review-b ov#565 S1-r4 (b)): after a restart (the self-written
    record gone) a group that removes its own earlier note by naming the whole of it gets the entry back in
    `removed_entry` for a right guess as for a wrong one; a DM-made entry that only HOLDS the named line
    beside other text stays out of the inventory."""
    replies = []
    for guess in (RIGHT_GUESS, WRONG_GUESS):
        gate_copy._gate_reset_for_tests()
        gate_copy.shared_user_block(user_block(SETUP, NOTE))
        store = FakeMemoryTool([SETUP, NOTE], ["Likes kites.", f"{RIGHT_GUESS}\n{DM_ONLY}"])
        _run(gate_copy, "tg-group", [{"action": "add", "target": "memory", "content": guess}], store)
        gate_copy._self_written_digests().clear()  # the restart
        seen, _ = _run(gate_copy, "tg-group", [{"action": "remove", "target": "memory", "old_text": guess},
                                               {"action": "remove", "target": "memory", "old_text": NO_SUCH}], store)
        replies.append(json.dumps(seen, ensure_ascii=False).replace(guess, "<guess>"))
    assert replies[0] == replies[1]
    removed, missing = json.loads(replies[0])
    assert json.loads(removed[1])["removed_entry"] == "<guess>"
    assert json.loads(missing[1])["current_entries"] == ["Likes kites."]


def test_only_an_allowed_non_private_write_of_a_fingerprinted_line_is_recorded(gate, group_session, monkeypatch):
    gate.shared_user_block(user_block(SETUP, NOTE))
    right = gate._line_digest(RIGHT_GUESS)
    calls = (
        {"action": "add", "target": "memory", "content": WRONG_GUESS},              # not a fingerprint
        {"action": "remove", "target": "memory", "old_text": RIGHT_GUESS},          # old_text only locates
        {"action": "replace", "target": "user", "old_text": "x", "content": RIGHT_GUESS},  # refused
    )
    for args in calls:
        gate.memory_write_directive(tool_name="memory", args=args, session_id="tg-group")
    assert not gate._self_written_digests()
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    gate.memory_write_directive(tool_name="memory", args={"action": "add", "content": RIGHT_GUESS}, session_id="tg-dm")
    assert not gate._self_written_digests()
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    note = f"note:\n{RIGHT_GUESS}"
    for args, key in (({"action": "add", "content": f"  {note}\n"}, f"memory:{gate._line_digest(note)}"),
                      ({"action": "replace", "old_text": "kites", "new_text": RIGHT_GUESS}, f"memory:{right}"),
                      ({"target": "user", "operations": [{"action": "add", "target": "memory", "new_text": RIGHT_GUESS}]},
                       f"user:{right}")):
        gate._self_written_digests().clear()
        assert gate.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None
        # The WHOLE stripped text, never its lines, with the store Hermes writes it to (a batch: the call's
        # target), review-b ov#565 S1-r4 (b).
        assert list(gate._self_written_digests()) == [key]
    assert gate._line_digest(note) != right


def test_the_self_written_set_is_bounded_and_drops_the_oldest(gate, group_session, monkeypatch):
    lines = [f"Synthetic line number {i} of the setup profile text." for i in range(4)]
    gate.shared_user_block(user_block("[Edge City profile, written at setup]\n" + "\n".join(lines), NOTE))
    monkeypatch.setattr(gate, "SELF_WRITTEN_MAX", 2)
    for line in lines[:3]:
        gate.memory_write_directive(tool_name="memory", args={"action": "add", "content": line}, session_id="g")
    assert list(gate._self_written_digests()) == [f"memory:{gate._line_digest(line)}" for line in lines[1:3]]
    gate.memory_write_directive(tool_name="memory", args={"action": "add", "content": lines[1]}, session_id="g")
    assert list(gate._self_written_digests()) == [f"memory:{gate._line_digest(line)}" for line in (lines[2], lines[1])]
    # Lines that are no fingerprint never take a place, however many a group writes.
    for i in range(50):
        gate.memory_write_directive(tool_name="memory", args={"action": "add", "content": f"A chatty group note, number {i}."},
                                    session_id="g")
    assert list(gate._self_written_digests()) == [f"memory:{gate._line_digest(line)}" for line in (lines[2], lines[1])]


def test_both_copies_read_one_self_written_set(vm, gate, group_session, user_md):
    """Like the fingerprints (N4-d): a line one copy's write check recorded is exempt in the other copy's
    result filter, through one dict on Hermes's MemoryStore class."""
    user_md(SETUP, NOTE)
    store = sys.modules["tools.memory_tool_store"].MemoryStore
    vm.shared_user_block(user_block(SETUP, NOTE))
    raw = _result(success=True, current_entries=[RIGHT_GUESS, NOTE])
    assert json.loads(gate.transform_memory_result(tool_name="memory", args={}, result=raw))["current_entries"] == [NOTE]
    assert vm.memory_write_directive(tool_name="memory", args={"action": "add", "content": RIGHT_GUESS}) is None
    assert gate.transform_memory_result(tool_name="memory", args={}, result=raw) is None
    assert getattr(store, gate.SELF_WRITTEN_ATTR) is gate._self_written_digests() is vm._self_written_digests()
    assert not gate._SELF_WRITTEN_DIGESTS and not vm._SELF_WRITTEN_DIGESTS


def test_a_group_write_of_a_line_never_unhides_an_older_dm_entry_holding_it(gate, group_session, monkeypatch):
    """Review-b ov#565 S1-r4 (b), which replaces round 3's process-wide residual: the self-written set is
    process-wide (an agent's memory files are shared by all its chats; a per-session key would redact one
    group's own note from another group), but it holds WHOLE texts. So a group that writes a line a
    DM-made entry also holds (with other text beside it) un-hides nothing: the DM's entry stays hidden,
    and a right guess reads back what a wrong one does."""
    dm_copy = f"From our private chat:\n{RIGHT_GUESS}"
    views = {}
    for guess in (RIGHT_GUESS, WRONG_GUESS):
        gate._gate_reset_for_tests()
        gate.shared_user_block(user_block(SETUP, NOTE))
        store = FakeMemoryTool([SETUP, NOTE], ["Likes kites.", dm_copy])
        seen, prompt = _run(gate, "tg-group", [{"action": "add", "target": "memory", "content": f"Group note:\n{guess}"},
                                               {"action": "remove", "target": "memory", "old_text": NO_SUCH}], store)
        views[guess] = (json.loads(seen[-1][1])["current_entries"], prompt)
    assert views[WRONG_GUESS][0] == ["Likes kites.", f"Group note:\n{WRONG_GUESS}"]
    assert views[RIGHT_GUESS][0] == ["Likes kites.", f"Group note:\n{RIGHT_GUESS}"]  # the DM's entry stays out
    assert views[RIGHT_GUESS][1] == views[WRONG_GUESS][1] == user_block(NOTE)  # the marked entry stays hidden


@pytest.mark.parametrize("args", [
    {"action": "add", "target": "user", "content": SETUP},                              # the whole setup entry
    {"action": "add", "target": "user", "content": f"{SETUP_MARK}\n{WRONG_GUESS}"},       # a forged one
    {"action": "add", "target": "memory", "content": GODCONST},
    {"action": "add", "content": f"note\n{SETUP_MARK}"},
    {"action": "replace", "target": "memory", "old_text": "kites", "new_text": f"{SETUP_MARK}\nx"},
    {"target": "user", "operations": [{"action": "add", "content": "fine"}, {"action": "add", "content": GODCONST}]},
    {"action": "add", "target": "memory", "content": "fine", "operations": [{"action": "add", "content": SETUP_MARK}]},
    {"target": "memory", "operations": [{"action": "add", "target": "user", "new_text": SETUP_MARK}]},
])
def test_a_group_write_carrying_a_private_mark_is_refused_on_any_target(gate_copy, group_session, user_md, args):
    """The mark check (lead L33448 follow-up): outside a private session a write whose text (content or
    new_text, of the call or an op) holds a Private mark is refused on either target with one message. It
    keys on the public constant the session itself supplied, never a fingerprint, so it answers nothing
    about the Private text, and no group can forge a setup entry or test a whole reproduced one."""
    user_md(SETUP, NOTE)
    gate_copy.shared_user_block(user_block(SETUP, NOTE))
    assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") == {
        "action": "block", "message": MARK_REFUSAL_TEXT}
    assert not gate_copy._self_written_digests()
    assert not [mark for mark in gate_copy.PRIVATE_ENTRY_MARKS if mark in MARK_REFUSAL_TEXT]


def test_a_reproduced_whole_setup_entry_gets_the_reply_any_marked_write_gets(gate_copy, group_session, user_md,
                                                                            monkeypatch):
    """The whole marked setup entry, reproduced exactly (right) or not (wrong), is refused with the same
    reply, before Hermes's add could answer "Entry already exists"; an unmarked add still works; a DM
    keeps it all."""
    user_md(SETUP, NOTE)
    gate_copy.shared_user_block(user_block(SETUP, NOTE))
    replies = [gate_copy.memory_write_directive(tool_name="memory", session_id="tg-group",
                                                args={"action": "add", "target": "user", "content": f"{SETUP_MARK}\n{g}"})
               for g in (RIGHT_GUESS, WRONG_GUESS)]
    assert replies[0] == replies[1] == {"action": "block", "message": MARK_REFUSAL_TEXT}
    assert gate_copy.memory_write_directive(tool_name="memory", session_id="tg-group",
                                            args={"action": "add", "target": "user", "content": RIGHT_GUESS}) is None
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    for target in ("user", "memory"):
        assert gate_copy.memory_write_directive(tool_name="memory", session_id="tg-dm",
                                                args={"action": "add", "target": target, "content": SETUP}) is None
