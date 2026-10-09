"""av-display: Telegram tool-progress lines name the tool, never the command (RC28).

Hermes is never imported: a fake ``agent.display`` stands in with the two
tables as they are at v2026.9.24, and ``line()`` renders a progress line the way
``gateway/run_turn_runner.py`` 292-300 does in "new"/"all" mode.
"""

from __future__ import annotations

import sys
import types

import pytest


def line(display, name, preview="the preview"):
    verb = display.get_tool_verb(name)
    if not verb:
        return f'{name}: "{preview}"'
    return verb if display.verb_drops_preview(name) else f"{verb} {preview}"


def test_terminal_and_the_other_command_tools_lose_their_preview(plugin, fake_display):
    assert line(fake_display, "terminal", "curl -s https://x") == "Running curl -s https://x"
    plugin.register(None)
    assert "terminal" in fake_display._TOOL_VERBS_NO_PREVIEW
    assert line(fake_display, "terminal", "curl -s https://x") == "Running"
    for name in ("execute_code", "read_file", "write_file", "patch", "search_files", "memory",
                 "todo_list", "delegate_task", "cronjob_manage"):
        assert name in fake_display._TOOL_VERBS_NO_PREVIEW, name
        assert line(fake_display, name) == fake_display._TOOL_VERBS[name], name
    assert line(fake_display, "memory", "secret note") == "Updating memory"
    # Hermes's own entries stay; the table keeps its type (frozenset in 0.21.5).
    assert {"skills_list", "session_search"} <= fake_display._TOOL_VERBS_NO_PREVIEW
    assert isinstance(fake_display._TOOL_VERBS_NO_PREVIEW, frozenset)


def test_village_tools_get_a_verb_and_no_arguments(plugin, fake_display):
    plugin.register(None)
    for prefix in ("mcp__index__", "mcp_index_", "index_"):
        assert line(fake_display, prefix + "list_opportunities", '{"status": "pending"}') == "Checking Index"
        assert line(fake_display, prefix + "get_my_profile") == "Checking Index"
        assert line(fake_display, prefix + "create_intent", "I want to meet founders") == "Working on Index"
        assert line(fake_display, prefix + "accept_opportunity") == "Working on Index"
    assert line(fake_display, "recall", "what did I say about kombucha") == "Looking back"
    for name in ("record_intention", "share_digest", "village_vote"):
        assert line(fake_display, name) == "Noting that"
    assert plugin.VILLAGE_VERBS["index_enrich_my_profile"] == "Working on Index"
    assert len(plugin.VILLAGE_VERBS) == 3 * 14 + 1 + 3


def test_web_search_and_web_extract_keep_their_preview(plugin, fake_display):
    plugin.register(None)
    for name in ("web_search", "web_extract"):
        assert name not in fake_display._TOOL_VERBS_NO_PREVIEW
    assert fake_display._TOOL_VERBS["web_search"] == "Searching the web"
    assert fake_display._TOOL_VERBS["web_extract"] == "Reading"
    assert line(fake_display, "web_search", "goa monsoon") == "Searching the web goa monsoon"


def test_an_unknown_tool_keeps_hermes_default_rendering(plugin, fake_display):
    plugin.register(None)
    assert line(fake_display, "mcp__other__thing", "x") == 'mcp__other__thing: "x"'
    assert line(fake_display, "consent_status", "x") == 'consent_status: "x"'


def test_a_verb_hermes_already_has_is_never_replaced(plugin, fake_display):
    fake_display._TOOL_VERBS["recall"] = "Remembering"
    plugin.register(None)
    assert fake_display._TOOL_VERBS["recall"] == "Remembering"
    assert line(fake_display, "recall") == "Remembering"


def test_a_built_in_without_a_verb_is_not_added_to_the_no_preview_set(plugin, fake_display):
    del fake_display._TOOL_VERBS["todo_list"]
    plugin.register(None)
    assert "todo_list" not in fake_display._TOOL_VERBS_NO_PREVIEW


def test_register_twice_is_idempotent(plugin, fake_display):
    plugin.register(None)
    verbs = dict(fake_display._TOOL_VERBS)
    no_preview = fake_display._TOOL_VERBS_NO_PREVIEW
    plugin.register(None)
    assert fake_display._TOOL_VERBS == verbs
    assert fake_display._TOOL_VERBS_NO_PREVIEW == no_preview


@pytest.mark.parametrize("shape", ["missing", "wrong-type"])
def test_a_future_hermes_without_the_tables_is_left_untouched(plugin, monkeypatch, shape):
    module = types.ModuleType("agent.display")
    if shape == "wrong-type":
        module._TOOL_VERBS = [("terminal", "Running")]
        module._TOOL_VERBS_NO_PREVIEW = frozenset()
    else:
        module.get_tool_verb = lambda name: None
    before = dict(vars(module))
    monkeypatch.setitem(sys.modules, "agent.display", module)
    plugin.register(None)
    assert dict(vars(module)) == before


def test_a_missing_agent_display_does_not_raise(plugin, monkeypatch):
    monkeypatch.setitem(sys.modules, "agent.display", None)  # import raises ImportError
    plugin.register(None)


def test_a_mutable_set_is_extended_in_kind(plugin, fake_display):
    fake_display._TOOL_VERBS_NO_PREVIEW = {"skills_list"}
    plugin.register(None)
    assert isinstance(fake_display._TOOL_VERBS_NO_PREVIEW, set)
    assert "terminal" in fake_display._TOOL_VERBS_NO_PREVIEW


def test_the_manifest_names_the_plugin_and_registers_nothing(plugin):
    import yaml
    from pathlib import Path

    manifest = yaml.safe_load((Path(plugin.__file__).parent / "plugin.yaml").read_text())
    assert manifest["name"] == "av-display"
    assert "provides_tools" not in manifest and "provides_hooks" not in manifest


def test_the_index_names_match_index_links(plugin):
    from pathlib import Path

    source = (Path(plugin.__file__).parents[1] / "index-links" / "__init__.py").read_text()
    assert 'INDEX_TOOL_PREFIXES = ("mcp__index__", "mcp_index_", "index_")' in source
    tools_md = (Path(plugin.__file__).parents[2] / "skills" / "index-network" / "tools.md").read_text()
    for name in plugin.INDEX_READ_TOOLS + plugin.INDEX_CHANGE_TOOLS:
        assert f"`{name}`" in tools_md, name


def test_the_village_tool_names_match_their_plugins(plugin):
    from pathlib import Path

    plugins = Path(plugin.__file__).parents[1]
    assert 'TOOL_NAME = "recall"' in (plugins / "recall" / "__init__.py").read_text()
    share_vote = (plugins / "av-events" / "_share_vote.py").read_text()
    assert 'SHARE_TOOL = "share_digest"' in share_vote and 'VOTE_TOOL = "village_vote"' in share_vote
    manifest = (plugins / "av-events" / "plugin.yaml").read_text()
    assert "  - record_intention\n" in manifest
