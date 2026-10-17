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
    assert line(fake_display, "village", '{"operation":"rolodex.search","query":"private person"}') == "Checking your village"
    assert len(plugin.VILLAGE_VERBS) == 3 * 14 + 1 + 3 + 1


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


class _Platform:
    def __init__(self, value):
        self.value = value


class TelegramAdapter:
    """Shaped like Hermes's: supports_code_blocks True (telegram/adapter.py:483), platform telegram."""
    supports_code_blocks = True

    def __init__(self):
        self.platform = _Platform("telegram")


class DiscordAdapter:
    supports_code_blocks = True

    def __init__(self):
        self.platform = _Platform("discord")



CURL = {"command": "curl -s https://api.example.invalid/v1/x -H 'Authorization: Bearer $TOKEN'"}


def test_terminal_on_telegram_gives_the_verb_alone_in_hermes_real_branch_order(plugin, fake_display, fake_runner):
    runner = fake_runner.TurnRunner(TelegramAdapter())
    # Before the plugin: the code-block branch wins, the command reaches the chat (refute M2).
    before = runner._progress_build_message("terminal", "curl -s https://api...", CURL)
    assert before.startswith("⚙️ terminal\n```\ncurl -s")
    plugin.register(None)
    assert runner._progress_build_message("terminal", "curl -s https://api...", CURL) == "⚙️ Running"
    assert runner._progress_build_message("execute_code", "import os", {"code": "import os"}) == "⚙️ Running code"


def test_other_platforms_keep_hermes_terminal_block(plugin, fake_display, fake_runner):
    plugin.register(None)
    runner = fake_runner.TurnRunner(DiscordAdapter())
    assert runner._progress_build_message("terminal", "curl", CURL).startswith("⚙️ terminal\n```\ncurl -s")


def test_the_wrap_is_idempotent_and_keeps_the_original(plugin, fake_display, fake_runner):
    plugin.register(None)
    wrapped = fake_runner.TurnRunner._progress_terminal_blocks
    plugin.register(None)
    assert fake_runner.TurnRunner._progress_terminal_blocks is wrapped
    assert getattr(wrapped, "__wrapped__").__name__ == "_progress_terminal_blocks"


def test_the_wrap_passes_every_argument_after_the_adapter_through(plugin, fake_display, monkeypatch):
    """A later Hermes may add a parameter (positional or keyword); off Telegram it reaches the original."""
    seen = []
    module = types.ModuleType("gateway.run_turn_runner")

    class TurnRunner:
        def _progress_terminal_blocks(self, adapter, tool_name, args, emoji, *extra, **options):
            seen.append((adapter, tool_name, args, emoji, extra, options))
            return "full", "short"

    module.TurnRunner = TurnRunner
    monkeypatch.setitem(sys.modules, "gateway.run_turn_runner", module)
    plugin.register(None)
    runner, discord = TurnRunner(), DiscordAdapter()
    assert runner._progress_terminal_blocks(discord, "terminal", CURL, "⚙️", "later", width=40) == ("full", "short")
    assert runner._progress_terminal_blocks(adapter=discord, tool_name="terminal", args=CURL, emoji="⚙️") == ("full", "short")
    assert seen == [
        (discord, "terminal", CURL, "⚙️", ("later",), {"width": 40}),
        (discord, "terminal", CURL, "⚙️", (), {}),
    ]
    assert runner._progress_terminal_blocks(TelegramAdapter(), "terminal", CURL, "⚙️", "later", width=40) == (None, None)
    assert len(seen) == 2


def test_a_runner_without_the_method_is_left_alone(plugin, fake_display, monkeypatch):
    module = types.ModuleType("gateway.run_turn_runner")

    class TurnRunner:
        pass

    module.TurnRunner = TurnRunner
    monkeypatch.setitem(sys.modules, "gateway.run_turn_runner", module)
    plugin.register(None)
    assert not hasattr(TurnRunner, "_progress_terminal_blocks")
    # The tables were still extended.
    assert "terminal" in fake_display._TOOL_VERBS_NO_PREVIEW


def test_a_missing_runner_module_does_not_raise(plugin, fake_display, monkeypatch):
    monkeypatch.setitem(sys.modules, "gateway.run_turn_runner", None)
    plugin.register(None)
    assert "terminal" in fake_display._TOOL_VERBS_NO_PREVIEW


def test_is_telegram_reads_the_platform_value(plugin):
    assert plugin.is_telegram(TelegramAdapter())
    assert not plugin.is_telegram(DiscordAdapter())
    assert not plugin.is_telegram(None)
    assert plugin.is_telegram(types.SimpleNamespace(platform="telegram"))


# ── rc42: Hermes's session-hygiene compaction notices stay out of the chat ───────────────────────────

import asyncio
import os
import re
from pathlib import Path

HERMES_REF = Path(os.environ.get("HERMES_AGENT_SRC") or Path.home() / "dev" / "hermes-agent-ref-v2026.9.24")
DEFERRED = "ℹ️ Context compression deferred — summary still streaming. Continuing without compression this turn."


@pytest.fixture
def fake_run_turn(monkeypatch):
    """A stand-in for gateway.run_turn: GatewayTurnMixin._hmwa_hygiene_notify as at v2026.9.24
    (run_turn.py:902-910), sending through the adapter's emit_warning."""
    module = types.ModuleType("gateway.run_turn")
    sent = []

    class GatewayTurnMixin:
        async def _hmwa_hygiene_notify(self, source, meta, message, what):
            sent.append((source, meta, message, what))

    class GatewayRunner(GatewayTurnMixin):
        pass

    module.GatewayTurnMixin = GatewayTurnMixin
    module.GatewayRunner = GatewayRunner
    module.sent = sent
    monkeypatch.setitem(sys.modules, "gateway.run_turn", module)
    return module


def notify(runner, message, what):
    return asyncio.run(runner._hmwa_hygiene_notify("source", {"thread": 1}, message, what))


def test_turn_hold_and_aux_fallback_are_not_sent(plugin, fake_display, fake_runner, fake_run_turn):
    runner = fake_run_turn.GatewayRunner()
    notify(runner, DEFERRED, "compression-turnhold notice")
    assert len(fake_run_turn.sent) == 1  # before the plugin, Hermes sends it
    plugin.register(None)
    for what in ("compression-turnhold notice", "aux-model-fallback notice"):
        assert notify(runner, DEFERRED, what) is None
    # By keyword too.
    assert asyncio.run(fake_run_turn.GatewayRunner()._hmwa_hygiene_notify(
        "source", {}, DEFERRED, what="compression-turnhold notice")) is None
    assert len(fake_run_turn.sent) == 1
    assert plugin.HYGIENE_NOTICES == {"compression-turnhold notice", "aux-model-fallback notice"}


def test_timeout_and_failure_notices_stay_visible(plugin, fake_display, fake_runner, fake_run_turn):
    """Verify S1 (the lead's call): both tell the resident to run /compress or /new, their own commands."""
    plugin.register(None)
    runner = fake_run_turn.GatewayRunner()
    for what in ("compression-timeout warning", "compression-failure warning"):
        notify(runner, "⚠️ Shortening the conversation history ... Run /compress to try again or /new", what)
    assert [s[3] for s in fake_run_turn.sent] == ["compression-timeout warning", "compression-failure warning"]
    assert plugin.VISIBLE_HYGIENE_NOTICES == {"compression-timeout warning", "compression-failure warning"}
    assert not plugin.VISIBLE_HYGIENE_NOTICES & plugin.HYGIENE_NOTICES


@pytest.mark.parametrize("what", [
    "compression-commit warning", "compression-turnhold", "compression-turnhold notice ", "Compression-turnhold notice",
    "aux-model-fallback", "aux-model-fallback notices", "aux", "compression", "",
])
def test_near_miss_labels_are_sent(plugin, fake_display, fake_runner, fake_run_turn, what):
    """Verify N2: exact match only; a prefix or case-folding rule would swallow these."""
    plugin.register(None)
    notify(fake_run_turn.GatewayRunner(), "a notice", what)
    assert [s[3] for s in fake_run_turn.sent] == [what]


@pytest.mark.parametrize("what", [None, 7, ["compression-turnhold notice"], {"compression-turnhold notice": 1}])
def test_a_non_string_or_unhashable_label_fails_open(plugin, fake_display, fake_runner, fake_run_turn, what):
    """Verify N1: an unhashable label must not raise out of the wrapper; it is sent."""
    plugin.register(None)
    notify(fake_run_turn.GatewayRunner(), "a notice", what)
    assert [s[3] for s in fake_run_turn.sent] == [what]


def test_a_renamed_keyword_or_missing_label_fails_open(plugin, fake_display, fake_runner, monkeypatch):
    """Verify N1: a later Hermes that renames `what` (passed by keyword) or drops it still gets its own method."""
    seen = []
    module = types.ModuleType("gateway.run_turn")

    class GatewayTurnMixin:
        async def _hmwa_hygiene_notify(self, source, meta, message, label=None):
            seen.append((source, meta, message, label))
            return "receipt"

    module.GatewayTurnMixin = GatewayTurnMixin
    monkeypatch.setitem(sys.modules, "gateway.run_turn", module)
    plugin.register(None)
    runner = GatewayTurnMixin()
    assert asyncio.run(runner._hmwa_hygiene_notify("s", {}, DEFERRED, label="compression-turnhold notice")) == "receipt"
    assert asyncio.run(runner._hmwa_hygiene_notify("s", {}, DEFERRED)) == "receipt"
    assert seen == [("s", {}, DEFERRED, "compression-turnhold notice"), ("s", {}, DEFERRED, None)]


def test_a_synchronous_method_is_left_alone(plugin, fake_display, fake_runner, monkeypatch):
    """Verify N1: wrapping a sync method in an async one would drop every notice un-awaited."""
    module = types.ModuleType("gateway.run_turn")

    class GatewayTurnMixin:
        def _hmwa_hygiene_notify(self, source, meta, message, what):
            return "sent"

    original = GatewayTurnMixin._hmwa_hygiene_notify
    module.GatewayTurnMixin = GatewayTurnMixin
    monkeypatch.setitem(sys.modules, "gateway.run_turn", module)
    plugin.register(None)
    assert GatewayTurnMixin._hmwa_hygiene_notify is original
    assert GatewayTurnMixin()._hmwa_hygiene_notify("s", {}, DEFERRED, "compression-turnhold notice") == "sent"
    assert plugin.apply_hygiene_notices(module) is False


def test_any_other_notice_still_goes_through_with_every_argument(plugin, fake_display, fake_runner, monkeypatch):
    seen = []
    module = types.ModuleType("gateway.run_turn")

    class GatewayTurnMixin:
        async def _hmwa_hygiene_notify(self, source, meta, message, what, *extra, **options):
            seen.append((source, meta, message, what, extra, options))
            return "receipt"

    module.GatewayTurnMixin = GatewayTurnMixin
    monkeypatch.setitem(sys.modules, "gateway.run_turn", module)
    plugin.register(None)
    runner = GatewayTurnMixin()
    out = asyncio.run(runner._hmwa_hygiene_notify("s", {}, "⚠️ Something new", "a later notice", "x", level=2))
    assert out == "receipt"
    assert seen == [("s", {}, "⚠️ Something new", "a later notice", ("x",), {"level": 2})]


def test_the_hygiene_wrap_is_idempotent_and_keeps_the_original(plugin, fake_display, fake_runner, fake_run_turn):
    plugin.register(None)
    wrapped = fake_run_turn.GatewayTurnMixin._hmwa_hygiene_notify
    plugin.register(None)
    assert fake_run_turn.GatewayTurnMixin._hmwa_hygiene_notify is wrapped
    assert wrapped.__wrapped__.__name__ == "_hmwa_hygiene_notify"


def test_a_run_turn_without_the_method_or_module_is_left_alone(plugin, fake_display, fake_runner, monkeypatch):
    module = types.ModuleType("gateway.run_turn")

    class GatewayTurnMixin:
        pass

    module.GatewayTurnMixin = GatewayTurnMixin
    monkeypatch.setitem(sys.modules, "gateway.run_turn", module)
    plugin.register(None)
    assert not hasattr(GatewayTurnMixin, "_hmwa_hygiene_notify")
    monkeypatch.setitem(sys.modules, "gateway.run_turn", None)
    plugin.register(None)
    # The other two patches still applied.
    assert "terminal" in fake_display._TOOL_VERBS_NO_PREVIEW


@pytest.mark.skipif(not (HERMES_REF / "gateway" / "run_turn.py").is_file(), reason="Hermes source not available")
def test_the_labels_match_hermes_pinned_source(plugin):
    """The dropped and the visible labels are, together, the `what` of the four _hmwa_hygiene_notify calls at
    v2026.9.24; the method keeps its signature and stays a coroutine function; it sends through emit_warning; the
    reported notice is the turn-hold one; and the two kept visible are the ones that name /compress and /new."""
    source = (HERMES_REF / "gateway" / "run_turn.py").read_text(encoding="utf-8")
    assert "    async def _hmwa_hygiene_notify(self, source, meta, message, what):\n" in source
    assert "await _adapter.emit_warning(source.chat_id, message, metadata=meta," in source
    starts = [m.end() for m in re.finditer(r"await self\._hmwa_hygiene_notify\(", source)]
    assert len(starts) == 4
    labels = {re.search(r'"([a-z-]+ (?:notice|warning))",?\n', source[at:at + 800]).group(1) for at in starts}
    assert labels == set(plugin.HYGIENE_NOTICES) | set(plugin.VISIBLE_HYGIENE_NOTICES)
    run = (HERMES_REF / "gateway" / "run.py").read_text(encoding="utf-8")
    assert "Run /compress to try again or /new to start fresh." in run
    assert '"Run /compress to try again or /new to start fresh. If this keeps happening, "' in source
    assert '"compression-failure warning",' in source
    assert 't("gateway.compress.turnhold_deferred"), "compression-turnhold notice"' in source
    locale = (HERMES_REF / "locales" / "en.yaml").read_text(encoding="utf-8")
    assert f'turnhold_deferred:     "{DEFERRED}"' in locale
    # The config key we do not set, and its default.
    display_config = (HERMES_REF / "gateway" / "display_config.py").read_text(encoding="utf-8")
    assert '    "suppress_warning_notifications": False,\n' in display_config


# ── rc44 (RESIDENT-UX): the /village command and the first-contact note ──────────────────────────────

import socket

#: Hermes v2026.9.24's two first-contact notes (gateway/run_turn.py:1418-1422; agent/onboarding.py:131), cut.
INTRO_NOTE = (
    "[System note: This is the user's very first message ever. "
    "Briefly introduce yourself and mention that /help shows available commands. "
    "Keep the introduction concise -- one or two sentences max.]"
)
PROFILE_NOTE = (
    "\n\n[System note: This is the user's very first message ever. After a one-sentence introduction (mention /help "
    "shows commands), OFFER — do not assume — to build a short profile of them ...]"
)


class FakeCtx:
    """Hermes's PluginContext.register_command as at v2026.9.24 (hermes_cli/plugins.py:658-685)."""

    def __init__(self):
        self.commands = {}

    def register_command(self, name, handler, description="", args_hint="", argument_mode=None):
        self.commands[name] = {"handler": handler, "description": description, "args_hint": args_hint,
                               "argument_mode": argument_mode}


def test_village_is_registered_as_a_no_argument_command(plugin, fake_display, fake_runner, fake_run_turn):
    ctx = FakeCtx()
    plugin.register(ctx)
    assert list(ctx.commands) == ["village"]
    entry = ctx.commands["village"]
    assert entry["description"] == "What Agent Village can do"
    # No args_hint: Hermes's Telegram menu keeps it (commands_platforms.py _requires_argument: hint starts with "<").
    assert entry["args_hint"] == "" and entry["argument_mode"] is None
    assert entry["handler"]("") == plugin.VILLAGE_TEXT
    assert entry["handler"]("anything after it") == plugin.VILLAGE_TEXT
    # The table patches still happen alongside it.
    assert fake_display._TOOL_VERBS["village"] == "Checking your village"


def test_the_village_reply_needs_no_network_and_no_model(plugin, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("/village must not touch the network")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    assert plugin.village_command("") == plugin.VILLAGE_TEXT
    assert plugin.village_command() == plugin.VILLAGE_TEXT


def test_the_village_text_names_the_features_as_the_app_does(plugin):
    text = plugin.VILLAGE_TEXT
    lines = text.split("\n")
    assert lines[0] == "Agent Village, from here:"
    assert lines[-1] == "More in the web app: https://agents.edgecity.live"
    bullets = [line for line in lines if line.startswith("\u2022 ")]
    assert [b[2:].split(":", 1)[0] for b in bullets] == [
        "Intents", "Rolodex", "Ask the village", "Calendar", "Decisions", "Gold Stars", "Approvals",
    ]
    assert len(lines) == len(bullets) + 2
    # Plain text: no dashes of any kind, no Markdown, ASCII but the bullets.
    assert not any(ch in text for ch in "\u2014\u2013*_`[]")
    assert all(ord(ch) < 128 for ch in text.replace("\u2022", ""))
    assert len(text) < 700


def test_a_context_without_register_command_or_a_failing_one_does_not_stop_the_rest(plugin, fake_display):
    plugin.register(None)  # the existing suite's call
    assert plugin.register_village_command(types.SimpleNamespace()) is False

    class Broken:
        def register_command(self, *args, **kwargs):
            raise RuntimeError("conflict")

    plugin.register(Broken())
    assert "terminal" in fake_display._TOOL_VERBS_NO_PREVIEW


@pytest.fixture
def fake_first_contact(monkeypatch):
    """gateway.run_turn with GatewayTurnMixin._hmwa_first_contact_notes as at v2026.9.24 (run_turn.py:1410-1438):
    on a box with no session yet it appends one note to turn_sidecar_notes in place."""
    module = types.ModuleType("gateway.run_turn")

    class GatewayTurnMixin:
        note = INTRO_NOTE

        async def _hmwa_hygiene_notify(self, source, meta, message, what):
            return None

        async def _hmwa_first_contact_notes(self, source, history, turn_sidecar_notes):
            if history:
                return
            turn_sidecar_notes.append(self.note)

    class GatewayRunner(GatewayTurnMixin):
        pass

    module.GatewayTurnMixin = GatewayTurnMixin
    module.GatewayRunner = GatewayRunner
    monkeypatch.setitem(sys.modules, "gateway.run_turn", module)
    return module


def first_contact(runner, notes, history=(), **kwargs):
    if kwargs:
        return asyncio.run(runner._hmwa_first_contact_notes("source", list(history), turn_sidecar_notes=notes))
    return asyncio.run(runner._hmwa_first_contact_notes("source", list(history), notes))


def test_the_first_contact_notes_name_village_not_help(plugin, fake_display, fake_runner, fake_first_contact):
    runner = fake_first_contact.GatewayRunner()
    notes = []
    first_contact(runner, notes)
    assert notes == [INTRO_NOTE]  # before the plugin, Hermes's own words
    plugin.register(FakeCtx())
    for note, by_keyword in ((INTRO_NOTE, False), (PROFILE_NOTE, True)):
        fake_first_contact.GatewayTurnMixin.note = note
        notes = ["a note from earlier in the turn mentioning /help shows available commands"]
        if by_keyword:
            first_contact(runner, notes, keyword=True)
        else:
            first_contact(runner, notes)
        assert notes[0] == "a note from earlier in the turn mentioning /help shows available commands"
        assert len(notes) == 2
        assert "/help" not in notes[1]
        assert "/village shows what Agent Village can do" in notes[1]
    # The rest of the note is Hermes's, word for word.
    assert plugin.point_at_village(INTRO_NOTE) == INTRO_NOTE.replace(
        "mention that /help shows available commands", "mention that /village shows what Agent Village can do")


def test_first_contact_with_history_or_other_text_is_left_as_hermes_wrote_it(plugin, fake_display, fake_runner, fake_first_contact):
    plugin.register(FakeCtx())
    runner = fake_first_contact.GatewayRunner()
    notes = []
    first_contact(runner, notes, history=[{"role": "user"}])
    assert notes == []
    fake_first_contact.GatewayTurnMixin.note = "Type /help to see commands."  # a near miss: not rewritten
    first_contact(runner, notes)
    assert notes == ["Type /help to see commands."]
    assert plugin.point_at_village(None) is None
    assert plugin.point_at_village(42) == 42


def test_the_first_contact_wrap_is_idempotent_fail_open_and_keeps_the_original(plugin, fake_display, fake_runner, fake_first_contact, monkeypatch):
    original = fake_first_contact.GatewayTurnMixin._hmwa_first_contact_notes
    plugin.register(FakeCtx())
    wrapped = fake_first_contact.GatewayTurnMixin._hmwa_first_contact_notes
    plugin.register(FakeCtx())
    assert fake_first_contact.GatewayTurnMixin._hmwa_first_contact_notes is wrapped
    assert wrapped.__wrapped__ is original
    # A notes argument that is not a list: passed through, nothing rewritten, no error.
    runner = fake_first_contact.GatewayRunner()

    class Notes:
        def __init__(self):
            self.items = []

        def append(self, item):
            self.items.append(item)

    odd = Notes()
    asyncio.run(runner._hmwa_first_contact_notes("source", [], odd))
    assert odd.items == [INTRO_NOTE]
    # A rewrite that fails leaves Hermes's note.
    monkeypatch.setattr(plugin, "point_at_village", lambda note: (_ for _ in ()).throw(RuntimeError("boom")))
    notes = []
    asyncio.run(runner._hmwa_first_contact_notes("source", [], notes))
    assert notes == [INTRO_NOTE]


def test_a_synchronous_or_missing_first_contact_method_is_left_alone(plugin, fake_display, fake_runner, monkeypatch):
    module = types.ModuleType("gateway.run_turn")

    class GatewayTurnMixin:
        def _hmwa_first_contact_notes(self, source, history, notes):
            notes.append(INTRO_NOTE)

    module.GatewayTurnMixin = GatewayTurnMixin
    monkeypatch.setitem(sys.modules, "gateway.run_turn", module)
    original = GatewayTurnMixin._hmwa_first_contact_notes
    plugin.register(FakeCtx())
    assert GatewayTurnMixin._hmwa_first_contact_notes is original
    assert plugin.apply_first_contact_notes(types.ModuleType("gateway.run_turn")) is False


@pytest.mark.skipif(not (HERMES_REF / "gateway" / "run_turn.py").is_file(), reason="Hermes source not available")
def test_the_command_and_the_note_match_hermes_pinned_source(plugin):
    """register_command's signature and the reply path; a no-hint plugin command joins Telegram's menu list;
    no core command is named village; and both first-contact phrases are in the pinned source as written."""
    plugins_py = (HERMES_REF / "hermes_cli" / "plugins.py").read_text(encoding="utf-8")
    assert ("    def register_command(\n        self, name: str, handler: Callable, description: str = \"\", "
            "args_hint: str = \"\",\n") in plugins_py
    inbound = (HERMES_REF / "gateway" / "run_inbound.py").read_text(encoding="utf-8")
    assert "plugin_handler = get_plugin_command_handler(command.replace(\"_\", \"-\"))" in inbound
    assert "return True, str(result) if result else None, command" in inbound
    platforms = (HERMES_REF / "hermes_cli" / "commands_platforms.py").read_text(encoding="utf-8")
    assert "    return args_hint.strip().startswith(\"<\")\n" in platforms
    assert "if not _requires_argument(hint)]" in platforms
    commands = (HERMES_REF / "hermes_cli" / "commands.py").read_text(encoding="utf-8")
    assert 'CommandDef("village"' not in commands and '"village"' not in commands
    run_turn = (HERMES_REF / "gateway" / "run_turn.py").read_text(encoding="utf-8")
    assert "    async def _hmwa_first_contact_notes(self, source, history, turn_sidecar_notes):\n" in run_turn
    assert "await self._hmwa_first_contact_notes(source, history, turn_sidecar_notes)" in run_turn
    assert '"Briefly introduce yourself and mention that /help shows available commands. "' in run_turn
    onboarding = (HERMES_REF / "agent" / "onboarding.py").read_text(encoding="utf-8")
    assert re.search(r'\(mention /help "\n\s+"shows commands\)', onboarding)
