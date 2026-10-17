"""Telegram tool-progress lines name the tool, never the command (RC28); Hermes's
turn-hold and aux-fallback compaction notices stay out of the chat (rc42).

Hermes v2026.9.24 composes each "new"/"all" progress line in
``gateway/run_turn_runner.py`` (``_progress_build_message``, 292-300) from
``agent.display``: ``get_tool_verb(name)`` reads ``_TOOL_VERBS`` and
``verb_drops_preview(name)`` reads ``_TOOL_VERBS_NO_PREVIEW``, both at call time
(``agent/display.py`` 503-516, 551-564; the runner imports them lazily). A tool
with a verb in the no-preview set renders as ``<emoji> <verb>``; with a verb
only, ``<emoji> <verb> <40-char preview>``; with no verb,
``<emoji> <name>: "<preview>"``. No config key reaches those tables, so this
plugin extends them once, at ``register()``:

* ``_TOOL_VERBS_NO_PREVIEW`` gains the built-ins whose preview is a shell
  command, code, a path, memory text or a task (``NO_PREVIEW_BUILTINS``), but
  only those that have a verb in ``_TOOL_VERBS`` (a name without one would
  still print its preview), plus the Village's own tools below.
* ``_TOOL_VERBS`` gains a verb for the Village's own tools (``VILLAGE_VERBS``):
  the Index tools under each of the three prefixes (reads "Checking Index",
  changes "Working on Index"), ``recall`` ("Looking back") and av-events'
  ``record_intention``, ``share_digest`` and ``village_vote`` ("Noting that").
  A verb Hermes already has for a name is never replaced.
* The ``terminal`` code block, on Telegram only. Before the tables are read,
  ``_progress_build_message`` asks ``TurnRunner._progress_terminal_blocks``
  (run_turn_runner.py:238-258, called at :270, returned at :276) for a fenced
  block holding the command, built whenever the adapter's
  ``supports_code_blocks`` is true, and ``TelegramAdapter`` sets it true
  (plugins/platforms/telegram/adapter.py:483). run_turn_runner.py:246 is the
  only reader of that flag at the tag, so the flag itself could be turned off,
  but the live Telegram class cannot be reached at ``register()``: Hermes loads
  the bundled platform lazily, on first use, as ``hermes_plugins.<slug>.adapter``
  (hermes_cli/plugins_loader.py:236-281, 624-660), a different class object from
  ``plugins.platforms.telegram.adapter.TelegramAdapter``. So this plugin wraps
  that one method instead: for an adapter whose ``platform`` is ``telegram`` it
  returns ``(None, None)`` (no block), and the line falls through to the verb
  path ("Running"); every other adapter gets Hermes's own result.

* Two of Hermes's session-hygiene compaction notices, on every platform (rc42).
  Before a turn, the gateway may summarise a long session ("hygiene"); four
  outcomes post a notice to the resident's chat, each through ``GatewayTurnMixin
  ._hmwa_hygiene_notify(source, meta, message, what)`` (gateway/run_turn.py:902-910),
  which calls ``adapter.emit_warning``. This plugin drops two of them, which give
  the resident nothing to do: the turn-hold expiry, "ℹ️ Context compression
  deferred — summary still streaming. Continuing without compression this turn."
  (``what`` "compression-turnhold notice", :999-1001, text locales/en.yaml:127;
  the conversation is kept and the summary is adopted later or retried), and the
  auxiliary-model fallback ("aux-model-fallback notice", :1221-1227; its remedy,
  ``auxiliary.compression.model`` in config.yaml, is the operator's). The other
  two stay visible because their remedy is the resident's: the no-progress
  timeout ("compression-timeout warning", :1054-1061, text gateway/run.py:195-206)
  and the aborted summary ("compression-failure warning", :1210-1215) both say
  "Run /compress to try again or /new to start fresh", Hermes writes that copy
  for chat users (run.py:197-199), and both commands are in the resident command
  list (install/config.ts ``RESIDENT_SLASH_COMMANDS``). The one config key that
  reaches any of them, ``display.suppress_warning_notifications`` (default false:
  gateway/display_config.py:24, hermes_cli/config_defaults.py:897, read in
  gateway/warning_notifications.py:90-101), also hides failures a resident must
  act on (a turn-error's detail, a failed upload, a stuck-turn or aborted-turn
  notice, background-task and cron failures), so rc28 refused it (install/config.ts
  ``setCompactionSettings``) and this plugin never sets it. Instead it wraps that
  one method, fail-open: only when Hermes's method is a coroutine function, and
  a call is dropped only when its ``what`` (4th argument, or ``what=``) is a str
  that is exactly one of ``HYGIENE_NOTICES``; every other call, a near-miss label,
  a renamed or missing argument, or any error in that check, is awaited through
  Hermes's own method. Compaction itself, its cooldowns and its gateway log lines
  are untouched.

* A ``/village`` command (rc44, RESIDENT-UX): ``register()`` calls
  ``ctx.register_command("village", village_command, description=...)``
  (hermes_cli/plugins.py:658-685). The gateway runs a plugin command's handler
  before any agent turn and sends what it returns as the reply
  (gateway/run_inbound.py:1056-1080): a fixed text (``VILLAGE_TEXT``), no LLM
  call, no network. No ``args_hint``, so Hermes lists it with the plugin
  commands for Telegram's menu (hermes_cli/commands_platforms.py:89-96,
  281-297); the 67 core commands fill the 60-slot menu first, so the installer
  names ``village`` in ``platforms.telegram.extra.command_menu.priority``
  (install/av_display.ts ``configureVillageMenu``). Residents may run it:
  ``village`` is in install/config.ts ``RESIDENT_SLASH_COMMANDS``.

* The first-contact note points at ``/village``, not ``/help`` (rc44). On the
  box's very first message ever (no session yet), Hermes adds a system note to
  that turn telling the agent to introduce itself and "mention that /help shows
  available commands" (gateway/run_turn.py:1418-1422), or, with
  ``onboarding.profile_build`` at its default ``ask``, the profile-build
  directive, "(mention /help shows commands)" (agent/onboarding.py:131), both
  through ``GatewayTurnMixin._hmwa_first_contact_notes(source, history,
  turn_sidecar_notes)`` (run_turn.py:1410, called at :2107). This plugin wraps
  that one method, fail-open: after Hermes's own method has run, each note it
  appended to ``turn_sidecar_notes`` has the exact phrases in
  ``FIRST_CONTACT_REWRITES`` replaced; any other text, a list it cannot find,
  or any error leaves the notes as Hermes wrote them.

``web_search`` and ``web_extract`` keep their preview (the query or URL is the
useful part). Verbose mode, which a resident can pick with ``/verbose``, still
shows the full arguments (on Telegram as Hermes's JSON line rather than a code
block). Only the two tables and those three methods are touched, and one command
registered; tool execution and compaction are not. A Hermes without either
table, or with a table of an unexpected type, or without
``TurnRunner._progress_terminal_blocks``,
``GatewayTurnMixin._hmwa_hygiene_notify`` or
``GatewayTurnMixin._hmwa_first_contact_notes``, or a context without
``register_command``, has that part left alone with one log line, and a missing
module never raises. Idempotent.
"""

from __future__ import annotations

import importlib
import inspect
import logging
from typing import Any, Dict, FrozenSet

logger = logging.getLogger(__name__)

#: Built-ins whose argument preview is a command, code, a path or private text.
NO_PREVIEW_BUILTINS: FrozenSet[str] = frozenset({
    "terminal", "execute_code", "read_file", "write_file", "patch", "search_files",
    "memory", "todo_list", "delegate_task", "cronjob_manage",
})

#: Index tool-name prefixes, as plugins/index-links (MCP server ``index`` in two
#: Hermes spellings, and Index's own Hermes plugin under bare names).
INDEX_TOOL_PREFIXES = ("mcp__index__", "mcp_index_", "index_")
#: The Index tools (skills/index-network/tools.md, "Tool families").
INDEX_READ_TOOLS = ("get_my_profile", "list_intents", "get_intent", "list_opportunities", "get_opportunity")
INDEX_CHANGE_TOOLS = (
    "update_my_profile", "enrich_my_profile", "create_intent", "update_intent", "pause_intent",
    "resume_intent", "archive_intent", "accept_opportunity", "reject_opportunity",
)
CHECKING_INDEX = "Checking Index"
WORKING_ON_INDEX = "Working on Index"
LOOKING_BACK = "Looking back"
NOTING_THAT = "Noting that"


def _village_verbs() -> Dict[str, str]:
    verbs: Dict[str, str] = {}
    for prefix in INDEX_TOOL_PREFIXES:
        verbs.update({prefix + name: CHECKING_INDEX for name in INDEX_READ_TOOLS})
        verbs.update({prefix + name: WORKING_ON_INDEX for name in INDEX_CHANGE_TOOLS})
    verbs["village"] = "Checking your village"
    verbs["recall"] = LOOKING_BACK  # plugins/recall TOOL_NAME
    for name in ("record_intention", "share_digest", "village_vote"):  # plugins/av-events
        verbs[name] = NOTING_THAT
    return verbs


#: Our own tools and their verbs.
VILLAGE_VERBS: Dict[str, str] = _village_verbs()


def apply(display: Any) -> bool:
    """Extend ``display``'s two tables in place. False (and nothing touched) when either is missing."""
    verbs = getattr(display, "_TOOL_VERBS", None)
    no_preview = getattr(display, "_TOOL_VERBS_NO_PREVIEW", None)
    if not isinstance(verbs, dict) or not isinstance(no_preview, (set, frozenset)):
        logger.info("av-display: agent.display has no _TOOL_VERBS dict and _TOOL_VERBS_NO_PREVIEW set; left as is")
        return False
    added_verbs = 0
    for name, verb in VILLAGE_VERBS.items():
        if name not in verbs:
            verbs[name] = verb
            added_verbs += 1
    wanted = {name for name in NO_PREVIEW_BUILTINS | set(VILLAGE_VERBS) if name in verbs}
    missing = len(wanted - set(no_preview))
    if missing:
        # A frozenset in Hermes 0.21.5: rebind the module attribute, keeping its type.
        display._TOOL_VERBS_NO_PREVIEW = type(no_preview)(set(no_preview) | wanted)
    logger.info("av-display: agent.display _TOOL_VERBS +%d, _TOOL_VERBS_NO_PREVIEW +%d", added_verbs, missing)
    return True


_WRAPPED_MARK = "_av_display_wrapped"


def is_telegram(adapter: Any) -> bool:
    """Whether ``adapter`` is Hermes's Telegram adapter: ``platform`` is ``telegram`` (gateway/config.py
    ``Platform.TELEGRAM``, set in BasePlatformAdapter.__init__), whichever module the class came from."""
    platform = getattr(adapter, "platform", None)
    return getattr(platform, "value", platform) == "telegram"


def apply_terminal_blocks(runner_module: Any) -> bool:
    """Wrap ``TurnRunner._progress_terminal_blocks`` so Telegram gets no command block. False when absent."""
    runner = getattr(runner_module, "TurnRunner", None)
    original = getattr(runner, "_progress_terminal_blocks", None) if runner is not None else None
    if not callable(original):
        logger.info("av-display: gateway.run_turn_runner has no TurnRunner._progress_terminal_blocks; left as is")
        return False
    if getattr(original, _WRAPPED_MARK, False):
        return True

    # Hermes calls it as (adapter, tool_name, args, emoji) (run_turn_runner.py:270); everything after
    # the adapter passes through untouched, so a later Hermes that adds a parameter loses nothing.
    def _progress_terminal_blocks(self: Any, adapter: Any, *args: Any, **kwargs: Any) -> Any:
        if is_telegram(adapter):
            return None, None
        return original(self, adapter, *args, **kwargs)

    setattr(_progress_terminal_blocks, _WRAPPED_MARK, True)
    _progress_terminal_blocks.__wrapped__ = original  # type: ignore[attr-defined]
    runner._progress_terminal_blocks = _progress_terminal_blocks
    logger.info("av-display: gateway.run_turn_runner TurnRunner._progress_terminal_blocks wrapped (no command block on telegram)")
    return True


#: The two ``what`` labels (of four) that Hermes v2026.9.24 passes to
#: ``GatewayTurnMixin._hmwa_hygiene_notify`` that give the resident nothing to do: the turn-hold
#: notice (gateway/run_turn.py:999-1001) and the aux-model fallback (:1221-1227). The timeout
#: (:1054-1061) and failure (:1210-1215) notices name /compress and /new, the resident's own
#: commands, so they stay visible (verify S1, the lead's call).
HYGIENE_NOTICES: FrozenSet[str] = frozenset({
    "compression-turnhold notice",
    "aux-model-fallback notice",
})
#: Hermes's labels this plugin leaves visible on purpose.
VISIBLE_HYGIENE_NOTICES: FrozenSet[str] = frozenset({
    "compression-timeout warning",
    "compression-failure warning",
})


def _dropped(args: Any, kwargs: Any) -> Any:
    """The label to drop, or None. ``what`` is the 4th argument after self (run_turn.py:902)."""
    what = kwargs["what"] if "what" in kwargs else (args[3] if len(args) > 3 else None)
    if isinstance(what, str) and what in HYGIENE_NOTICES:
        return what
    return None


def apply_hygiene_notices(run_turn_module: Any) -> bool:
    """Wrap ``GatewayTurnMixin._hmwa_hygiene_notify`` so two compaction notices stay out of chat. Fail-open."""
    mixin = getattr(run_turn_module, "GatewayTurnMixin", None)
    original = getattr(mixin, "_hmwa_hygiene_notify", None) if mixin is not None else None
    if not callable(original):
        logger.info("av-display: gateway.run_turn has no GatewayTurnMixin._hmwa_hygiene_notify; left as is")
        return False
    if getattr(original, _WRAPPED_MARK, False):
        return True
    if not inspect.iscoroutinefunction(original):
        # A synchronous method would get an un-awaited coroutine back from an async wrapper.
        logger.info("av-display: GatewayTurnMixin._hmwa_hygiene_notify is not a coroutine function; left as is")
        return False

    # Hermes calls it as (source, meta, message, what) and awaits it (run_turn.py:902). Every argument
    # passes through as given; only the exact label check decides, and any error in it sends the notice.
    async def _hmwa_hygiene_notify(self: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            what = _dropped(args, kwargs)
        except Exception:  # noqa: BLE001 - fail open: Hermes's own method decides
            what = None
        if what is not None:
            logger.info("av-display: Hermes's %s kept out of the chat (compaction housekeeping)", what)
            return None
        return await original(self, *args, **kwargs)

    setattr(_hmwa_hygiene_notify, _WRAPPED_MARK, True)
    _hmwa_hygiene_notify.__wrapped__ = original  # type: ignore[attr-defined]
    mixin._hmwa_hygiene_notify = _hmwa_hygiene_notify
    logger.info("av-display: gateway.run_turn GatewayTurnMixin._hmwa_hygiene_notify wrapped (turn-hold and aux-fallback notices kept out of chat)")
    return True


# ── rc44 (RESIDENT-UX): the /village command and the first-contact note ─────────────────────────────

#: The command, as residents type it (Telegram menu name too: lowercase letters only).
VILLAGE_COMMAND = "village"
#: Its line in Telegram's command menu and in /help.
VILLAGE_DESCRIPTION = "What Agent Village can do"
#: The reply. Fixed text: no LLM call, no network. Names as the app nav and the skills use them.
VILLAGE_TEXT = "\n".join((
    "Agent Village, from here:",
    "\u2022 Intents: tell me what you want to do or who you want to meet; I find matches and introduce you.",
    "\u2022 Rolodex: ask me who someone is, or mark someone as met.",
    "\u2022 Ask the village: ask what people in the group have said about a topic.",
    "\u2022 Calendar: what's on, and your RSVPs.",
    "\u2022 Decisions: vote on the village's questions when a vote is open.",
    "\u2022 Gold Stars: thank someone (you approve each one first).",
    "\u2022 Approvals: I check with you in the approval bot before I act for you.",
    "More in the web app: https://agents.edgecity.live",
))


def village_command(raw_args: str = "") -> str:
    """The ``/village`` handler: the same fixed text whatever follows the command."""
    return VILLAGE_TEXT


def register_village_command(ctx: Any) -> bool:
    """Register ``/village`` on Hermes's plugin context. False when the context cannot register commands."""
    register_command = getattr(ctx, "register_command", None)
    if not callable(register_command):
        logger.info("av-display: no register_command on the plugin context; /%s not registered", VILLAGE_COMMAND)
        return False
    register_command(VILLAGE_COMMAND, village_command, description=VILLAGE_DESCRIPTION)
    logger.info("av-display: registered /%s", VILLAGE_COMMAND)
    return True


#: Exact phrases of Hermes v2026.9.24's first-contact notes, and what each becomes.
FIRST_CONTACT_REWRITES: Dict[str, str] = {
    # gateway/run_turn.py:1420, the plain intro note.
    "mention that /help shows available commands": "mention that /village shows what Agent Village can do",
    # agent/onboarding.py:131, the profile-build directive (onboarding.profile_build: ask, the default).
    "(mention /help shows commands)": "(mention /village shows what Agent Village can do)",
}


def point_at_village(note: Any) -> Any:
    """``note`` with each phrase of ``FIRST_CONTACT_REWRITES`` replaced; anything else as given."""
    if not isinstance(note, str):
        return note
    for phrase, replacement in FIRST_CONTACT_REWRITES.items():
        note = note.replace(phrase, replacement)
    return note


def apply_first_contact_notes(run_turn_module: Any) -> bool:
    """Wrap ``GatewayTurnMixin._hmwa_first_contact_notes`` so its notes name /village. Fail-open."""
    mixin = getattr(run_turn_module, "GatewayTurnMixin", None)
    original = getattr(mixin, "_hmwa_first_contact_notes", None) if mixin is not None else None
    if not callable(original):
        logger.info("av-display: gateway.run_turn has no GatewayTurnMixin._hmwa_first_contact_notes; left as is")
        return False
    if getattr(original, _WRAPPED_MARK, False):
        return True
    if not inspect.iscoroutinefunction(original):
        logger.info("av-display: GatewayTurnMixin._hmwa_first_contact_notes is not a coroutine function; left as is")
        return False

    # Hermes calls it as (source, history, turn_sidecar_notes) and awaits it (run_turn.py:2107); it appends
    # to that list in place. Every argument passes through as given; only notes it appended are rewritten.
    async def _hmwa_first_contact_notes(self: Any, *args: Any, **kwargs: Any) -> Any:
        notes = kwargs.get("turn_sidecar_notes", args[2] if len(args) > 2 else None)
        before = len(notes) if isinstance(notes, list) else None
        result = await original(self, *args, **kwargs)
        if before is not None:
            try:
                for i in range(before, len(notes)):
                    notes[i] = point_at_village(notes[i])
            except Exception:  # noqa: BLE001 - fail open: Hermes's notes as written
                logger.debug("av-display: first-contact note left as is", exc_info=True)
        return result

    setattr(_hmwa_first_contact_notes, _WRAPPED_MARK, True)
    _hmwa_first_contact_notes.__wrapped__ = original  # type: ignore[attr-defined]
    mixin._hmwa_first_contact_notes = _hmwa_first_contact_notes
    logger.info("av-display: gateway.run_turn GatewayTurnMixin._hmwa_first_contact_notes wrapped (first-contact note names /village)")
    return True


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint. No tools, no hooks: two display tables, three methods and /village, once."""
    try:
        register_village_command(ctx)
    except Exception:  # noqa: BLE001 - a command must never stop the gateway
        logger.warning("av-display: could not register /%s", VILLAGE_COMMAND, exc_info=True)
    for name, patch in (
        ("agent.display", apply),
        ("gateway.run_turn_runner", apply_terminal_blocks),
        ("gateway.run_turn", apply_hygiene_notices),
        ("gateway.run_turn", apply_first_contact_notes),
    ):
        try:
            module = importlib.import_module(name)
        except Exception:  # noqa: BLE001 - a display tweak must never stop the gateway
            logger.info("av-display: %s not importable; left as is", name)
            continue
        try:
            patch(module)
        except Exception:  # noqa: BLE001
            logger.warning("av-display: could not patch %s; left as is", name, exc_info=True)
