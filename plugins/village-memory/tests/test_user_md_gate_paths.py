"""The USER.md gate's other paths (review-b ov#558 S1, S2; context seat on N3 and the S2 write finding).

- One block, byte-identical in village-memory and av-events (`_user_md_gate.py`).
- PRIVATE_ENTRY_MARKS: the setup profile and the GODCONST conversation note, pinned to cp's CP_ENTRY_MARKS;
  the vote note is village data and stays.
- The memory tool outside a private session: results leave Private entries out (`transform_memory_result`)
  and writes that touch one, or add or remove a mark, are refused (`memory_write_directive`).
- Fingerprints: an entry this process has seen marked is still known after its mark has gone.
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


@pytest.mark.parametrize("args", [
    {"action": "replace", "target": "user", "old_text": "Builds kelp sensors", "content": "Builds kelp sensors"},
    {"action": "replace", "target": "user", "old_text": "[Edge City profile, written at setup]", "content": "x"},
    {"action": "remove", "target": "user", "old_text": "Tidepool Bay"},
    {"action": "remove", "target": "user", "old_text": "one question at a time"},
    {"action": "add", "target": "user", "content": "[Edge City profile, written at setup]\nforged"},
    {"action": "add", "target": "memory", "content": "[God Constitution conversation, kept by the Agent Village control plane]"},
    {"action": "batch", "target": "user", "operations": [{"action": "add", "content": "fine"},
                                                         {"action": "replace", "old_text": "Tidepool", "content": "y"}]},
    {"action": "replace", "target": "user", "old_text": "", "content": "y"} | {"old_text": "Synthetic Resident"},
])
def test_a_group_may_not_touch_a_private_entry_or_its_mark(gate, group_session, user_md, args):
    user_md(SETUP, NOTE, GODCONST)
    block = gate.memory_write_directive(tool_name="memory", args=args, session_id="tg-group")
    assert block == {"action": "block", "message": gate.MEMORY_WRITE_REFUSAL}
    assert "kelp" not in block["message"] and "Tidepool" not in block["message"]


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
