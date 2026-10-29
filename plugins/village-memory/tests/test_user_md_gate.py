"""village-memory: the built-in USER.md outside a private session (review-b L32588).

Hermes core puts `memories/USER.md` into every session's prompt (`agent/system_prompt.py`
`_memory_parts`). `register()` wraps that seam: a session that is not private gets the USER.md block
without the app's raw setup-profile entry; a private one is untouched. Hermes is not imported here
(a stand-in `agent.system_prompt`); `test_village_memory_hermes.py` drives the real one. Synthetic
fixtures only.
"""

from __future__ import annotations

import sys
import types

import pytest

SEP = "═" * 46
MARK = "[Edge City profile, written at setup]"
SETUP = f"{MARK}\nSynthetic Resident, Tidepool Bay. Builds kelp sensors."
NOTE = "Prefers calls before noon."
TAGS = "[Context tags, kept in the Agent Village app]\nHere to:\n- Meet people who repair things (setup)"


def user_block(*entries: str) -> str:
    content = "\n§\n".join(entries)
    return f"{SEP}\nUSER PROFILE (who the user is) [12% — 165/1,375 chars]\n{SEP}\n{content}"


MEMORY_BLOCK = f"{SEP}\nMEMORY (your personal notes) [3% — 40/2,200 chars]\n{SEP}\nThe village meets on Fridays."


class Store:
    def __init__(self, user: str) -> None:
        self.user = user

    def format_for_system_prompt(self, target):
        return self.user if target == "user" else MEMORY_BLOCK


def fake_agent(session, chat_type="dm", platform="telegram", agent_context="primary", user=None, provider=True):
    manager = types.SimpleNamespace(providers=[session(chat_type=chat_type, platform=platform,
                                                       agent_context=agent_context)] if provider else [])
    return types.SimpleNamespace(_memory_manager=manager, _memory_store=Store(user or user_block(SETUP, NOTE, TAGS)),
                                 platform=platform, _chat_type=chat_type)


@pytest.fixture()
def hermes_sp(monkeypatch):
    """A stand-in `agent.system_prompt` whose `_memory_parts` is Hermes's shape: the built-in blocks, then
    the provider block (agent/system_prompt.py:515-540)."""

    def _memory_parts(agent):
        return [agent._memory_store.format_for_system_prompt("memory"), agent._memory_store.format_for_system_prompt("user")]

    module = types.ModuleType("agent.system_prompt")
    module._memory_parts = _memory_parts
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.system_prompt", module)
    return module


# ---- the filter ------------------------------------------------------------------------------------


def test_shared_block_drops_only_the_setup_profile_entry_and_keeps_the_header(vm):
    block = user_block(SETUP, NOTE, TAGS)
    shared = vm.shared_user_block(block)
    assert shared == user_block(NOTE, TAGS)
    assert MARK not in shared and "kelp sensors" not in shared
    assert shared.splitlines()[1] == block.splitlines()[1]  # the usage figure is the file's, kept


@pytest.mark.parametrize("entries", [(NOTE, SETUP, TAGS), (NOTE, TAGS, SETUP)])
def test_the_entry_goes_wherever_it_sits(vm, entries):
    assert vm.shared_user_block(user_block(*entries)) == user_block(NOTE, TAGS)


def test_a_block_with_only_the_setup_profile_is_dropped(vm):
    assert vm.shared_user_block(user_block(SETUP)) == ""


def test_a_block_without_the_mark_is_returned_as_is(vm):
    block = user_block(NOTE, TAGS)
    assert vm.shared_user_block(block) is block
    assert vm.shared_user_block(None) is None and vm.shared_user_block("") == ""


@pytest.mark.parametrize("shape", [
    f"USER PROFILE [1%]\n{SETUP}",                                       # no separator lines
    f"{SEP}\nSOMETHING ELSE [1%]\n{SEP}\n{SETUP}\n§\n{NOTE}",           # a renamed title
    f"{SETUP}",                                                          # bare text
])
def test_an_unknown_shape_holding_the_mark_is_dropped_whole(vm, shape):
    """Fail closed: a later Hermes that renders the block differently never lets the entry through."""
    assert vm.shared_user_block(shape) == ""


def test_the_mark_is_the_index_scripts_mark(vm, h):
    """One string for the app's entry: the Index scripts look for the same text in USER.md."""
    scripts = h.PLUGIN_DIR.parents[1] / "skills" / "index-network" / "scripts"
    assert f'SETUP_PROFILE_MARK = "{vm.SETUP_PROFILE_MARK}"' in (scripts / "context-tags.ts").read_text(encoding="utf-8").replace("export const ", "")
    assert f'SETUP_PROFILE_MARK = "{vm.SETUP_PROFILE_MARK}"' in (scripts / "memory_signal_gate.py").read_text(encoding="utf-8")


# ---- who is private ---------------------------------------------------------------------------------

SESSIONS = [
    ("dm", "telegram", "primary", True), ("private", "telegram", "primary", True), ("", "cli", "primary", True),
    ("", "tui", "primary", True), ("group", "telegram", "primary", False), ("forum", "telegram", "primary", False),
    ("thread", "slack", "primary", False), ("something-new", "telegram", "primary", False),
    ("", "cron", "cron", False), ("dm", "telegram", "cron", False), ("", "api_server", "primary", False),
]


@pytest.mark.parametrize(("chat_type", "platform", "agent_context", "private"), SESSIONS)
def test_the_gate_uses_the_providers_own_private_session(vm, session, chat_type, platform, agent_context, private):
    """The same notion as the profile block and the tools (ov#555): `private_session()`."""
    agent = fake_agent(session, chat_type, platform, agent_context)
    assert agent._memory_manager.providers[0].private_session() is private
    assert vm.agent_is_private(agent) is private


@pytest.mark.parametrize(("chat_type", "platform", "private"), [
    ("dm", "telegram", True), ("group", "telegram", False), (None, None, True), ("", "cron", False),
    ("", "subagent", False), ("", "telegram", False),
])
def test_an_agent_without_the_provider_is_judged_on_the_facts_hermes_hands_one(vm, session, chat_type, platform,
                                                                                 private):
    """A subagent or review fork in this process has the built-in store but no provider: Hermes's own
    init facts (platform defaults to cli; agent_context is cron/subagent from the platform)."""
    agent = types.SimpleNamespace(_memory_manager=None, platform=platform, _chat_type=chat_type)
    assert vm.agent_is_private(agent) is private


@pytest.mark.parametrize(("chat_type", "platform", "private"), [
    ("group", "telegram", False), ("", "cron", False), ("", "telegram", False), ("dm", "telegram", True),
])
def test_an_uninitialised_provider_never_decides(vm, chat_type, platform, private):
    """Security review: before `initialize` the provider's `private_session()` says True (tool routing).
    The gate never asks it then: it judges the agent's own chat facts, so it cannot fail open."""
    provider = vm.VillageMemoryProvider()
    assert provider.private_session() is True and provider.session_known() is False
    agent = types.SimpleNamespace(_memory_manager=types.SimpleNamespace(providers=[provider]), platform=platform,
                                  _chat_type=chat_type, _memory_store=Store(user_block(SETUP, NOTE)))
    assert vm.agent_is_private(agent) is private
    shown = vm.user_block_for(agent, user_block(SETUP, NOTE))
    assert ("kelp sensors" in shown) is private
    assert vm.VillageMemoryProvider().get_tool_schemas() != []  # the routing default is unchanged


def test_a_provider_without_session_known_is_not_trusted(vm, session):
    """An object named village-memory that cannot say whether it knows the session: agent facts decide."""
    stranger = types.SimpleNamespace(name="village-memory", private_session=lambda: True)
    agent = types.SimpleNamespace(_memory_manager=types.SimpleNamespace(providers=[stranger]), platform="telegram",
                                  _chat_type="group")
    assert vm.agent_is_private(agent) is False


# ---- the wrapped seam -------------------------------------------------------------------------------


def test_register_wraps_memory_parts_once(vm, hermes_sp, h):
    original = hermes_sp._memory_parts
    for _ in range(3):
        vm.register(h.FakeCtx())
    wrapped = hermes_sp._memory_parts
    assert wrapped is not original and wrapped.__wrapped__ is original
    assert getattr(wrapped, vm.USER_GATE_ATTR) is vm.user_block_for
    vm.register(object())  # the general plugin manager's context: nothing installed, nothing raised


def test_a_reloaded_plugin_does_not_wrap_twice(vm, hermes_sp, h):
    vm.register(h.FakeCtx())
    wrapped = hermes_sp._memory_parts
    again = h.load(h.PLUGIN_DIR, "hermes_plugins.village_memory")
    again.register(h.FakeCtx())
    assert hermes_sp._memory_parts is wrapped


@pytest.mark.parametrize(("chat_type", "platform", "agent_context"), [
    ("group", "telegram", "primary"), ("", "cron", "cron"), ("thread", "slack", "primary"),
])
def test_a_shared_or_cron_session_gets_user_md_without_the_setup_profile(vm, hermes_sp, session, h, chat_type,
                                                                          platform, agent_context):
    vm.register(h.FakeCtx())
    parts = hermes_sp._memory_parts(fake_agent(session, chat_type, platform, agent_context))
    assert parts == [MEMORY_BLOCK, user_block(NOTE, TAGS)]
    assert not any(MARK in p or "kelp sensors" in p for p in parts)


@pytest.mark.parametrize(("chat_type", "platform"), [("dm", "telegram"), ("", "cli"), ("private", "telegram")])
def test_a_private_session_keeps_user_md_byte_for_byte(vm, hermes_sp, session, h, chat_type, platform):
    vm.register(h.FakeCtx())
    agent = fake_agent(session, chat_type, platform)
    assert hermes_sp._memory_parts(agent) == hermes_sp._memory_parts.__wrapped__(agent)
    assert "kelp sensors" in hermes_sp._memory_parts(agent)[1]


def test_only_the_setup_profile_leaves_a_group_block_and_an_empty_block_goes(vm, hermes_sp, session, h):
    vm.register(h.FakeCtx())
    assert hermes_sp._memory_parts(fake_agent(session, "group", user=user_block(SETUP))) == [MEMORY_BLOCK]


def test_the_kill_switch_does_not_reopen_the_entry(vm, hermes_sp, session, h, monkeypatch):
    """`AV_VILLAGE_MEMORY=off` empties the profile block; the USER.md gate is privacy and stays."""
    monkeypatch.setenv("AV_VILLAGE_MEMORY", "off")
    vm.register(h.FakeCtx())
    assert hermes_sp._memory_parts(fake_agent(session, "group")) == [MEMORY_BLOCK, user_block(NOTE, TAGS)]


def test_a_failing_gate_never_costs_the_build_and_fails_closed(vm, hermes_sp, session, h, monkeypatch, caplog):
    vm.register(h.FakeCtx())

    def boom(_agent):
        raise RuntimeError("resident text must not be logged")

    monkeypatch.setattr(vm, "agent_is_private", boom)
    with caplog.at_level("DEBUG", logger="av-user-md-gate"):
        parts = hermes_sp._memory_parts(fake_agent(session, "group"))
    assert parts == [MEMORY_BLOCK]  # the part holding the mark is left out whole
    assert "RuntimeError" in caplog.text and "resident text" not in caplog.text


def test_f1_renders_through_the_same_gate(vm, hermes_sp, session, h):
    """av-events/_prompt_refresh.py reads `village_user_gate` off the wrapped seam (USER_GATE_ATTR), so its
    exact test sees the block the prompt carries and a group turn never reads as stale."""
    vm.register(h.FakeCtx())
    gate = getattr(hermes_sp._memory_parts, "village_user_gate")
    block = user_block(SETUP, NOTE, TAGS)
    assert gate(fake_agent(session, "group"), block) == user_block(NOTE, TAGS)
    assert gate(fake_agent(session, "dm"), block) is block
    av_gate = (h.AV_EVENTS_DIR / "_user_md_gate.py").read_text(encoding="utf-8")
    assert f'USER_GATE_ATTR = "{vm.USER_GATE_ATTR}"' in av_gate
    assert "USER_GATE_ATTR = _user_md_gate.USER_GATE_ATTR" in (h.AV_EVENTS_DIR / "_prompt_refresh.py").read_text(encoding="utf-8")


def test_without_hermes_register_installs_nothing_and_logs_no_warning(vm, h, caplog, monkeypatch):
    monkeypatch.setitem(sys.modules, "agent.system_prompt", None)  # import raises ImportError
    with caplog.at_level("WARNING", logger="village-memory"):
        vm.register(h.FakeCtx())
        assert vm.install_user_md_gate() is False
    assert not caplog.records


def test_a_hermes_without_the_seam_fails_closed_for_every_session(vm, h, caplog, monkeypatch):
    """Review-b #558 S1: no `_memory_parts` seam means the store's USER.md block leaves the Private entries
    out for EVERY session (the DM keeps the setup text under _profile.md), with one WARNING."""

    class Store:
        def __init__(self, user):
            self.user = user

        def format_for_system_prompt(self, target):
            return self.user if target == "user" else MEMORY_BLOCK

    store_mod = types.ModuleType("tools.memory_tool_store")
    store_mod.MemoryStore = Store
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.system_prompt", types.ModuleType("agent.system_prompt"))
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.memory_tool_store", store_mod)
    with caplog.at_level("DEBUG", logger="av-user-md-gate"):
        vm.register(h.FakeCtx())
        vm.register(h.FakeCtx())
    levels = [r.levelname for r in caplog.records if "no _memory_parts" in r.getMessage()]
    assert levels == ["WARNING", "DEBUG"]
    assert vm.gate_state() == "snapshot"
    block = Store(user_block(SETUP, NOTE, TAGS))
    assert block.format_for_system_prompt("user") == user_block(NOTE, TAGS)  # whatever the session
    assert Store(user_block(SETUP)).format_for_system_prompt("user") is None
    assert block.format_for_system_prompt("memory") == MEMORY_BLOCK


def test_a_hermes_with_neither_seam_warns_once_and_says_none(vm, h, caplog, monkeypatch):
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.system_prompt", types.ModuleType("agent.system_prompt"))
    monkeypatch.setitem(sys.modules, "tools.memory_tool_store", None)
    with caplog.at_level("DEBUG", logger="av-user-md-gate"):
        assert vm.install_user_md_gate() is False
        assert vm.install_user_md_gate() is False
    levels = [r.levelname for r in caplog.records if "USER.md gate not installed" in r.getMessage()]
    assert levels == ["WARNING", "DEBUG"]
    assert vm.gate_state() == "none"
