"""The USER.md gate's other paths (review-b ov#558 S1, S2; context seat on N3 and the S2 write finding).

- One block, byte-identical in village-memory and av-events (`_user_md_gate.py`).
- PRIVATE_ENTRY_MARKS: the setup profile and the GODCONST conversation note, pinned to cp's CP_ENTRY_MARKS;
  the vote note is village data and stays.
- The memory tool outside a private session: results leave Private entries out (`transform_memory_result`)
  and writes that touch one, or add or remove a mark, are refused (`memory_write_directive`), on the marks,
  target and action only (review-b ov#563 S1-d: no guess-confirm oracle).
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
    content = "\n§\n".join(entries)
    return f"{SEP}\nUSER PROFILE (who the user is) [12% — 165/24,000 chars]\n{SEP}\n{content}"


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
    assert out["usage"] == "12%"
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


# ---- the memory tool's writes ---------------------------------------------------------------------------


@pytest.mark.parametrize(("args", "refusal"), [
    ({"action": "replace", "target": "user", "old_text": "Builds kelp sensors", "content": "Builds kelp sensors"},
     "MEMORY_WRITE_REFUSAL"),
    ({"action": "replace", "target": "user", "old_text": "[Edge City profile, written at setup]", "content": "x"},
     "MEMORY_WRITE_REFUSAL"),
    ({"action": "remove", "target": "user", "old_text": "Tidepool Bay"}, "MEMORY_WRITE_REFUSAL"),
    ({"action": "remove", "target": "user", "old_text": "one question at a time"}, "MEMORY_WRITE_REFUSAL"),
    ({"action": "add", "target": "user", "content": "[Edge City profile, written at setup]\nforged"},
     "MEMORY_WRITE_REFUSAL_ADD"),
    ({"action": "add", "target": "memory",
      "content": "[God Constitution conversation, kept by the Agent Village control plane]"}, "MEMORY_WRITE_REFUSAL_ADD"),
    ({"action": "replace", "target": "memory", "old_text": "x", "content": "[Edge City profile, written at setup]"},
     "MEMORY_WRITE_REFUSAL"),
    ({"action": "batch", "target": "user", "operations": [{"action": "add", "content": "fine"},
                                                          {"action": "replace", "old_text": "Tidepool", "content": "y"}]},
     "MEMORY_WRITE_REFUSAL"),
    ({"action": "batch", "target": "memory", "operations": [
        {"action": "add", "content": "fine"}, {"action": "add", "content": "[Edge City profile, written at setup]"}]},
     "MEMORY_WRITE_REFUSAL_ADD"),
    ({"action": "replace", "target": "user", "old_text": "", "content": "y"} | {"old_text": "Synthetic Resident"},
     "MEMORY_WRITE_REFUSAL"),
])
def test_a_group_may_not_touch_a_private_entry_or_its_mark(gate_copy, group_session, user_md, args, refusal):
    user_md(SETUP, NOTE, GODCONST)
    block = gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group")
    assert block == {"action": "block", "message": getattr(gate_copy, refusal)}
    assert "kelp" not in block["message"] and "Tidepool" not in block["message"]


def test_a_refused_add_is_not_told_to_add(gate_copy):
    """Review-b ov#563 N3-d: the replace/remove refusal offers an add; the refusal of an add (a marked one)
    does not, and neither echoes an entry."""
    assert gate_copy.MEMORY_WRITE_REFUSAL.endswith("You can still add a new note here.")
    assert "add" not in gate_copy.MEMORY_WRITE_REFUSAL_ADD.lower()
    assert gate_copy.MEMORY_WRITE_REFUSAL_ADD.startswith(gate_copy.MEMORY_WRITE_REFUSAL.split(". ")[0])
    for mark in gate_copy.PRIVATE_ENTRY_MARKS:
        assert mark not in gate_copy.MEMORY_WRITE_REFUSAL_ADD


# ---- the write check is no oracle (review-b ov#563 S1-d) -------------------------------------------------

#: A whole line of SETUP (fingerprinted once seen marked), and a wrong guess of the same length class.
RIGHT_GUESS = "Synthetic Resident, Tidepool Bay. Builds kelp sensors for the harbour."
WRONG_GUESS = "Synthetic Resident, Tidepool Bay. Builds kelp sensors for the estuary."


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
    """Review-b ov#563 S1-d: outside a private session the write check decides only on the marks, the target
    and the action. A group that guesses a whole setup-profile line exactly gets the answer a wrong guess
    gets, so the refusal confirms nothing (the fingerprints still filter results)."""
    user_md(SETUP, NOTE)
    gate_copy.shared_user_block(user_block(SETUP, NOTE))  # this process saw the entry marked: fingerprints taken
    assert gate_copy.holds_private_entry(RIGHT_GUESS) and not gate_copy.holds_private_entry(WRONG_GUESS)
    right = gate_copy.memory_write_directive(tool_name="memory", args=make_args(RIGHT_GUESS), session_id="tg-group")
    wrong = gate_copy.memory_write_directive(tool_name="memory", args=make_args(WRONG_GUESS), session_id="tg-group")
    assert right == wrong


def test_a_guessed_setup_line_may_be_noted_in_a_group(gate_copy, group_session, user_md):
    user_md(SETUP, NOTE)
    gate_copy.shared_user_block(user_block(SETUP, NOTE))
    for target in ("memory", "user"):
        args = {"action": "add", "target": target, "content": RIGHT_GUESS}
        assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None


# The memory tool's result shapes (Hermes v2026.9.24 tools/memory_tool_store.py): a write's success never
# echoes the entries (`_success_response`); a no-match edit echoes old_text in its error and the target's
# whole inventory (`_locate`: `current_entries`); an add or replace over the limit echoes the inventory
# (`_failure_with_entries`); a replace or remove echoes the entry it overwrote (`replaced_entry`,
# `removed_entry`, batch `replaced_entries` / `removed_entries`). Every memory-tool action is a write.
def _add_ok(target="memory"):
    return _result(success=True, done=True, target=target, usage="1% — 120/2,200", entry_count=3,
                   message="Entry added.", note="Write saved. This update is complete — do not repeat it.")


@pytest.mark.parametrize("call", [
    # an add: nothing echoed
    lambda g: ({"action": "add", "target": "memory", "content": g}, _add_ok()),
    lambda g: ({"action": "replace", "target": "memory", "old_text": "kites", "new_text": g},
               _result(success=True, done=True, target="memory", message="Entry replaced.", replaced_entry="Likes kites.")),
    # a multi-line old_text echoed by the no-match error, beside an inventory holding the group's own earlier note
    lambda g: ({"action": "remove", "target": "memory", "old_text": f"x\n{g}\ny"},
               _result(success=False, error=f"No entry matched 'x\n{g}\ny'. Check current_entries below.",
                       current_entries=[NOTE, g])),
    # the group's own note, echoed when it is replaced or removed
    lambda g: ({"action": "remove", "target": "memory", "old_text": "remember"},
               _result(success=True, done=True, target="memory", message="Entry removed.",
                       removed_entry=f"remember for later:\n{g}")),
    # a USER.md add over the limit: the inventory comes back; the marked entries go, the group's note stays
    lambda g: ({"action": "add", "target": "user", "content": "Likes kites."},
               _result(success=False, error="Memory at 23,990/24,000 chars.", current_entries=[SETUP, NOTE, g, GODCONST])),
    # a batch, by `operations` whatever `action` says
    lambda g: ({"action": "add", "target": "memory", "operations": [{"action": "add", "content": g}]},
               _result(success=False, error=f"Operation 1 (add): content is required. {g}")),
    lambda g: ({"action": "batch", "target": "memory", "operations": [{"action": "remove", "old_text": "remember"}]},
               _result(success=True, done=True, target="memory", removed_entries={"1": g})),
], ids=["add", "replace", "no-match-echo-and-inventory", "removed-own-note", "user-add-over-limit", "operations-batch",
        "batch-removed-entries"])
def test_a_group_write_result_is_the_same_for_a_right_and_a_wrong_guess(gate_copy, group_session, user_md, call):
    """Review-b ov#563 S1-d, the result half (security review of the first fold): a group may now write a
    line equal to a setup-profile line, so the result of a write must not redact on fingerprints either, or
    a right guess would come back as LEFT_OUT where a wrong one comes back whole. Write results are judged
    on the marks only: the same answer, with the guess in place, for a right and a wrong guess."""
    user_md(SETUP, NOTE)
    gate_copy.shared_user_block(user_block(SETUP, NOTE))  # fingerprints taken
    assert gate_copy.holds_private_entry(RIGHT_GUESS) and not gate_copy.holds_private_entry(WRONG_GUESS)
    answers = []
    for guess in (RIGHT_GUESS, WRONG_GUESS):
        args, raw = call(guess)
        assert gate_copy.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None
        out = gate_copy.transform_memory_result(tool_name="memory", args=args, result=raw, session_id="tg-group")
        answers.append(None if out is None else out.replace(guess, "<guess>"))
        shown = raw if out is None else out
        assert not [mark for mark in gate_copy.PRIVATE_ENTRY_MARKS if mark in shown]  # marked entries never show
    assert answers[0] == answers[1]


@pytest.mark.parametrize("args", [None, {}, {"action": "view"}, {"action": "search", "query": "kelp"},
                                  {"action": "batch", "operations": []}, {"action": "ADD"}, "not a dict"])
def test_a_result_whose_call_is_not_a_known_write_keeps_the_fingerprint_test(gate_copy, group_session, args):
    """A view or search (Hermes's memory tool has none today), or a call whose args are missing or unknown,
    still loses a fingerprinted line: only a known write is judged on the marks alone."""
    gate_copy.shared_user_block(user_block(SETUP, NOTE))
    raw = _result(success=True, results=[RIGHT_GUESS, NOTE], current_entries=[RIGHT_GUESS, NOTE])
    out = json.loads(gate_copy.transform_memory_result(tool_name="memory", args=args, result=raw,
                                                       session_id="tg-group"))
    assert out == {"success": True, "results": [NOTE], "current_entries": [NOTE]}


def test_a_write_result_still_loses_every_marked_entry(gate_copy, group_session):
    args = {"action": "remove", "target": "memory", "old_text": "nothing"}
    raw = _result(success=False, error="No entry matched 'nothing'.", current_entries=[SETUP, NOTE, GODCONST, VOTE],
                  replaced_entries={"1": SETUP, "2": NOTE})
    out = json.loads(gate_copy.transform_memory_result(tool_name="memory", args=args, result=raw, session_id="g"))
    assert out["current_entries"] == [NOTE, VOTE]
    assert out["replaced_entries"] == {"1": gate_copy.LEFT_OUT, "2": NOTE}
    assert gate_copy.transform_memory_result(tool_name="memory", args=args, result=f"oops {SETUP}") == json.dumps(
        {"success": False, "error": gate_copy.LEFT_OUT}, ensure_ascii=False)


@pytest.mark.parametrize(("args", "write"), [
    ({"action": "add"}, True), ({"action": "replace"}, True), ({"action": "remove"}, True),
    ({"action": "batch", "operations": [{}]}, True), ({"action": "add", "operations": [{}]}, True),
    ({"operations": [{"action": "remove"}]}, True), ({"action": "view"}, False), ({}, False), (None, False),
    ("add", False), ({"action": "ADD"}, False), ({"action": "batch", "operations": []}, False),
])
def test_which_memory_calls_are_writes(gate_copy, args, write):
    assert gate_copy.memory_call_is_write(args) is write


@pytest.mark.parametrize("args", [
    {"action": "replace", "target": "user", "old_text": "Prefers calls", "content": "Prefers calls after noon."},
    {"action": "remove", "target": "user", "old_text": NOTE},
    {"action": "remove", "target": "user", "old_text": "no such text anywhere"},
    {"action": "batch", "target": "user", "operations": [{"action": "add", "content": "fine"},
                                                         {"action": "remove", "old_text": "nothing"}]},
])
def test_every_group_replace_or_remove_on_user_md_is_refused_the_same_way(gate, group_session, user_md, args):
    """Security review (membership oracle): a refusal only when old_text hits the setup text would let a group
    probe it one guess at a time. Every USER.md replace or remove outside a private session gets the same
    plain refusal, whatever it matches."""
    user_md(SETUP, NOTE, GODCONST)
    assert gate.memory_write_directive(tool_name="memory", args=args) == {
        "action": "block", "message": gate.MEMORY_WRITE_REFUSAL}


@pytest.mark.parametrize("args", [
    {"action": "add", "target": "user", "content": "Likes kites."},
    {"action": "replace", "target": "memory", "old_text": "Tidepool", "content": "y"},   # MEMORY.md is not USER.md
    {"action": "remove", "old_text": "an old note"},                                      # target defaults to memory
])
def test_a_group_may_still_add_to_user_md_and_edit_memory_md(gate, group_session, user_md, args):
    user_md(SETUP, NOTE, GODCONST)
    assert gate.memory_write_directive(tool_name="memory", args=args) is None


def test_a_dm_keeps_the_whole_memory_tool(gate, dm_session, user_md):
    user_md(SETUP, NOTE)
    for args in ({"action": "replace", "target": "user", "old_text": "Tidepool", "content": "Harbour Bay"},
                 {"action": "add", "target": "user", "content": "[Edge City profile, written at setup]\nx"}):
        assert gate.memory_write_directive(tool_name="memory", args=args) is None


def test_malformed_args_are_refused_outside_a_private_session(gate, group_session):
    assert gate.memory_write_directive(tool_name="memory", args="not a dict")["action"] == "block"
    assert gate.memory_write_directive(tool_name="memory", args={"action": "batch", "operations": "x"})["action"] == "block"
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


@pytest.mark.parametrize("broken", ["session_is_private_now", "holds_private_mark"])
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
