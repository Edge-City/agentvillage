"""av-events installs the USER.md gate itself (review-b ov#558 S1) and wires the memory tool's two hooks
(S2: `transform_tool_result` leaves Private entries out of results, `pre_tool_call` refuses writes that touch
one), outside a private session only. Stand-in Hermes modules; synthetic text only."""

from __future__ import annotations

import json
import sys
import types

import pytest

SETUP = "[Edge City profile, written at setup]\nSynthetic Resident, Tidepool Bay. Builds kelp sensors."
SEP = "═" * 46


def user_block(*entries):
    return f"{SEP}\nUSER PROFILE (who the user is) [1% — 10/24,000 chars]\n{SEP}\n" + "\n§\n".join(entries)


@pytest.fixture()
def hermes_seams(monkeypatch, tmp_path):
    path = tmp_path / "USER.md"
    path.write_text(f"{SETUP}\n§\nPrefers calls before noon.", encoding="utf-8")

    class MemoryStore:
        @staticmethod
        def _path_for(target):
            return path

        def load_from_disk(self):
            self.user_entries = path.read_text(encoding="utf-8").split("\n§\n")

    system_prompt = types.ModuleType("agent.system_prompt")
    system_prompt._memory_parts = lambda agent: [user_block(SETUP, "Prefers calls before noon.")]
    store = types.ModuleType("tools.memory_tool_store")
    store.MemoryStore = MemoryStore
    for name, value in (("agent", types.ModuleType("agent")), ("agent.system_prompt", system_prompt),
                        ("tools", types.ModuleType("tools")), ("tools.memory_tool_store", store)):
        monkeypatch.setitem(sys.modules, name, value)
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    return system_prompt


def test_register_installs_the_gate_without_the_provider(plugin, ctx, hermes_seams):
    plugin.register(ctx)
    gate = sys.modules[f"{plugin.__name__}._user_md_gate"]
    assert callable(getattr(hermes_seams._memory_parts, gate.USER_GATE_ATTR, None))
    group_agent = types.SimpleNamespace(_memory_manager=None, platform="telegram", _chat_type="group")
    assert hermes_seams._memory_parts(group_agent) == [user_block("Prefers calls before noon.")]
    dm_agent = types.SimpleNamespace(_memory_manager=None, platform="telegram", _chat_type="dm")
    assert hermes_seams._memory_parts(dm_agent) == [user_block(SETUP, "Prefers calls before noon.")]


def test_register_wires_the_memory_result_filter(plugin, ctx, hermes_seams):
    plugin.register(ctx)
    raw = json.dumps({"success": False, "current_entries": [SETUP, "Prefers calls before noon."]})
    (out,) = ctx.fire("transform_tool_result", tool_name="memory", args={}, result=raw, session_id="tg-group")
    assert "kelp" not in out and json.loads(out)["current_entries"] == ["Prefers calls before noon."]
    assert ctx.fire("transform_tool_result", tool_name="terminal", args={}, result=raw, session_id="tg-group") == []


def test_pre_tool_call_refuses_a_group_user_md_write_and_lets_a_memory_md_note_through(plugin, ctx, hermes_seams,
                                                                                         monkeypatch):
    plugin.register(ctx)
    gate = sys.modules[f"{plugin.__name__}._user_md_gate"]
    args = {"action": "replace", "target": "user", "old_text": "Tidepool Bay", "content": "Harbour"}
    results = ctx.fire("pre_tool_call", tool_name="memory", args=args, session_id="tg-group", task_id="t")
    assert {"action": "block", "message": gate.MEMORY_WRITE_REFUSAL} in results
    add_user = {"action": "add", "target": "user", "content": "Brings snacks to the Friday meetup."}
    results = ctx.fire("pre_tool_call", tool_name="memory", args=add_user, session_id="tg-group", task_id="t")
    assert {"action": "block", "message": gate.MEMORY_WRITE_REFUSAL} in results
    ok = {"action": "add", "target": "memory", "content": "Brings snacks to the Friday meetup."}
    assert not [r for r in ctx.fire("pre_tool_call", tool_name="memory", args=ok, session_id="tg-group", task_id="t")
                if isinstance(r, dict) and r.get("action") == "block"]
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    assert not [r for r in ctx.fire("pre_tool_call", tool_name="memory", args=args, session_id="tg-dm", task_id="t")
                if isinstance(r, dict) and r.get("action") == "block"]


def test_a_failed_gate_install_is_logged_once_and_never_costs_the_hooks(plugin, ctx, monkeypatch, caplog):
    """Review-b ov#563 N7-d: register() no longer swallows an install failure silently: one WARNING naming
    the exception class (no text, no path), and the memory hooks are wired all the same."""
    gate = sys.modules[f"{plugin.__name__}._user_md_gate"]

    def boom():
        raise RuntimeError("install failed")

    monkeypatch.setattr(gate, "install_user_md_gate", boom)
    with caplog.at_level("DEBUG", logger="av-user-md-gate"):
        plugin.register(ctx)
    records = [r for r in caplog.records if "USER.md gate install failed" in r.getMessage()]
    assert [r.levelname for r in records] == ["WARNING"]
    assert records[0].getMessage() == "av-events: USER.md gate install failed (RuntimeError)"
    assert gate.transform_memory_result in ctx.hooks.get("transform_tool_result", [])
