"""R-DEON: the village tools, and av-elicit's `elicitation_record`, stay in the model's tool list
when Hermes's `tool_search` is on.

Why. Hermes v2026.9.24 (`tools/tool_search.py`) replaces every deferrable tool in the model's
tool list with three bridge tools (`tool_search`, `tool_describe`, `tool_call`). A tool is
deferrable when it is named in `tools.tool_search.defer`, or when it is neither a core tool
(`_core_tool_names()`, which reads `toolsets._HERMES_CORE_TOOLS`) nor in a session-gated GUI
toolset (`is_deferrable_tool_name`, :150-162); every plugin tool is therefore deferred, and the
bridge activates whenever one deferrable tool exists (`should_activate`, :198-206). On a resident's
box (R-DEON, 17 Oct) the turn log read "tool_search activated (tier 1): 22 core/visible tools kept,
48 deferred": `ask_village` sat behind the bridge, and a Haiku turn asked "what's going on in the
group chat" answered that it was unable instead of searching for the tool.

Hermes has no setting that keeps a plugin tool visible. Its `tools.tool_search` schema
(`hermes_cli/config_defaults.py:1959-1995`; `ToolSearchConfig.from_raw`, tool_search.py:62-86)
has `enabled`, `threshold_pct`, `search_default_limit`, `max_search_limit`, `listing`,
`listing_max_tokens` and `defer`; `defer` only ADDS tools to the deferred set (it is checked
before the core test), so no `config.yaml` line the installer could write keeps `ask_village` out
of the bridge, short of `enabled: off`, which would put all 48 deferred tools back in every turn.

GC-ELICIT (24 Oct) added av-elicit's `elicitation_record`, the one tool not of the village toolset:
deferred behind the bridge, the GODCONST elicitation tool was never called in two live Haiku runs
(the agent saved what it learned to memory instead), even when the notice named `tool_search` and
`tool_call`.

How. `install()` rebinds `tools.tool_search._core_tool_names` (one module attribute, as
`_prompt_refresh` rebinds `build_turn_context`) to Hermes's own set plus each name in
`VISIBLE_TOOLS` that is registered right now under the toolset this overlay registers it with.
Hermes calls it by bare name on every assembly (`is_deferrable_tool_name`, via `classify_tools`
in `assemble_tool_defs`, model_tools.py:533-536) and from `tool_call`'s wrong-door error
(`tools/tool_search_validation.py:219-220`, a call-time import), so the village tools are
classified visible exactly like a core tool: listed in full, called directly, never in the
catalog. Nothing else changes: `toolsets._HERMES_CORE_TOOLS` itself is untouched (the toolset
bundles, `bundle_non_core_tools` and the memory manager's reserved-name check keep reading
Hermes's list), a name that is not registered (its switch off, its plugin absent) or is
registered under another toolset is not added, and every other plugin tool still defers.

Switch: `AV_VILLAGE_TOOLS_VISIBLE` = `0|false|no|off` (process environment, else
`$HERMES_HOME/.env`, read once at plugin load) leaves Hermes's function as is. Unset or anything
else: on. Unload puts Hermes's function back. A Hermes without the seam is one log line, nothing
touched. Logs carry names and codes only.
"""

from __future__ import annotations

import functools
import importlib
import logging
from typing import Any, Callable, Dict, FrozenSet

from ._core import env_flag_disabled

logger = logging.getLogger("av-events")

SWITCH = "AV_VILLAGE_TOOLS_VISIBLE"
MODULE = "tools.tool_search"
WRAPPED_NAME = "_core_tool_names"

#: The village toolset, by the exact name and toolset each plugin registers it with:
#: av-events `ask_village` (`_ask_village.py`), `search_village` (`_search_village.py`) and
#: `query_village` (`_query_village.py`); village-bridge's one `village` tool (rolodex and gold
#: stars are its operations, `plugins/village-bridge/__init__.py`, `ctx.register_tool`). Plus
#: av-elicit's `elicitation_record` (`plugins/av-elicit/__init__.py` TOOL_NAME, TOOLSET; GC-ELICIT),
#: which Haiku never reached through the bridge. The registry is read on every assembly, so a
#: plugin that registers after av-events installs the wrapper (av-elicit loads later) still counts.
VISIBLE_TOOLS: Dict[str, str] = {
    "ask_village": "av-events",
    "search_village": "av-events",
    "query_village": "av-events",
    "village": "village",
    "elicitation_record": "av-elicit",
}

_MARK = "__av_village_visible__"
_TOKEN = object()


def switch_on() -> bool:
    """On unless `AV_VILLAGE_TOOLS_VISIBLE` holds an "off" spelling. A read that fails is on."""
    try:
        return not env_flag_disabled(SWITCH)
    except Exception:  # noqa: BLE001 - a broken .env never turns the fix off
        return True


def _registered_village_tools(module: Any) -> FrozenSet[str]:
    """The `VISIBLE_TOOLS` names registered now under their own toolset (Hermes's lookup)."""
    lookup = getattr(module, "_registry_toolset", None)
    if not callable(lookup):
        return frozenset()
    return frozenset(name for name, toolset in VISIBLE_TOOLS.items() if lookup(name) == toolset)


def _wrap(original: Callable[[], FrozenSet[str]], module: Any) -> Callable[[], FrozenSet[str]]:
    @functools.wraps(original)
    def core_tool_names() -> FrozenSet[str]:
        names = original()
        try:
            extra = _registered_village_tools(module)
        except Exception:  # noqa: BLE001 - never fail Hermes's assembly: its own set
            return names
        return frozenset(names) | extra if extra else names

    setattr(core_tool_names, _MARK, _TOKEN)
    return core_tool_names


def install() -> bool:
    """Wrap `tools.tool_search._core_tool_names`. False (one log line, nothing touched) when the
    switch is off, Hermes is not importable or the seam is missing. Idempotent; a reloaded
    av-events re-wraps Hermes's original rather than its predecessor's wrapper."""
    if not switch_on():
        logger.info("av-events: village_visible skipped=switch_off")
        return False
    try:
        module = importlib.import_module(MODULE)
    except Exception:  # noqa: BLE001 - not under Hermes, or a broken import: today's behaviour
        logger.info("av-events: village_visible skipped=no_tool_search")
        return False
    current = getattr(module, WRAPPED_NAME, None)
    if getattr(current, _MARK, None) is _TOKEN:
        return True
    original = getattr(current, "__wrapped__", None) if getattr(current, _MARK, None) is not None else current
    if not callable(original) or not callable(getattr(module, "_registry_toolset", None)):
        logger.info("av-events: village_visible skipped=no_seam")
        return False
    setattr(module, WRAPPED_NAME, _wrap(original, module))
    logger.info("av-events: village_visible installed tools=%s", ",".join(VISIBLE_TOOLS))
    return True


def uninstall() -> None:
    """Put Hermes's own function back (plugin unload). Only ever removes this module's wrapper."""
    try:
        module = importlib.import_module(MODULE)
        current = getattr(module, WRAPPED_NAME, None)
        if getattr(current, _MARK, None) is _TOKEN:
            setattr(module, WRAPPED_NAME, current.__wrapped__)
    except Exception:  # noqa: BLE001 - an unload never fails on us
        pass


__all__ = ["SWITCH", "VISIBLE_TOOLS", "install", "uninstall", "switch_on"]
