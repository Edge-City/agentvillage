"""Telegram tool-progress lines name the tool, never the command (RC28).

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

``web_search`` and ``web_extract`` keep their preview (the query or URL is the
useful part). Verbose mode, which a resident can pick with ``/verbose``, still
shows the full arguments: Hermes builds that line without the tables. Only the
two tables are touched; tool execution is not. A Hermes without either table,
or with a table of an unexpected type, is left alone with one log line, and a
missing ``agent.display`` never raises. Idempotent.
"""

from __future__ import annotations

import importlib
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


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint. No tools, no hooks: two display tables, once."""
    try:
        display = importlib.import_module("agent.display")
    except Exception:  # noqa: BLE001 - a display tweak must never stop the gateway
        logger.info("av-display: agent.display not importable; left as is")
        return
    try:
        apply(display)
    except Exception:  # noqa: BLE001
        logger.warning("av-display: could not extend agent.display; left as is", exc_info=True)
