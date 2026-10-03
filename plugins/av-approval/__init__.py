"""av-approval — the receipts half of approval.md for Agent Village (DATA-43).

A DOCUMENTED STUB at this version. It registers no hook and makes no request.

approval-md-hosted docs/03 section 3.3 gives this plugin one job beside the
gate: on `post_tool_call`, post a receipt (tool, outcome, execution token id)
to the tenant's facade, so the daemon closes the `execution.started` record the
gate opened and AV's `action.receipted` has its rows. It decides nothing; the
gate is the shell-hook shim `skills/approval` installs.

Why nothing is registered: the facade (`approval serve`, approval-md core at
6b74ca72) has no receipt endpoint. Its routes are `/verbs`, `/verb/<name>`,
`/hook/<harness>`, `/log/follow`, `/export` and `/status`, and the agent
credential reaches only the catalog, the hook route and five verbs
(instructions, hook_classify, request, wait, withdraw). A `post_tool_call` envelope posted to
`/hook/hermes` reaches the core's post half, but that half joins a receipt to
its `execution.started` by the envelope's top-level `tool_use_id`, while
Hermes puts the call id in `extra.tool_call_id` (and the result in
`extra.result`, where the core reads `tool_response`). The pre half therefore
mints a random task id for every Hermes call and the post half appends nothing.
Posting receipts that are guaranteed to record nothing would be traffic with
no effect, so the plugin says so once and stays out of the agent loop. The
DATA-43b follower derives receipts from the daemon log instead; once the core
reads Hermes's call id, this plugin is where the receipt post goes.

Kill switch: `AV_APPROVAL_ENABLED`. The fail-open line tracks the GATE, not
the plugin: `av-approval: disabled (fail-open)` is logged once only when the
switch is explicitly off (set, and not `1|true|yes|on`) AND `config.yaml`
carries no hook entry running the approval shim, i.e. the tenant really runs
ungated. Off with the entries still present logs that the gate is still in
force until the installer runs. Unset (never opted in) logs nothing. Unlike
`av-events` this plugin belongs to a gate, so the gap is logged as fail-open.

Python 3.11, standard library only. Never raises out of `register`.
"""

from __future__ import annotations

import logging
import os
from typing import Any

PLUGIN_VERSION = "0.1.0"
__version__ = PLUGIN_VERSION

#: The core version whose facade was read for a receipt surface.
CORE_VERSION = "approval-md 6b74ca72"

DISABLED_LINE = "av-approval: disabled (fail-open)"
STILL_GATED_LINE = ("av-approval: AV_APPROVAL_ENABLED is off but config.yaml still runs the approval shim; "
                    "the gate stays in force until the installer runs")
SHIM_SUFFIX = "/agent-hooks/hermes-hook-shim.sh"
RECEIPTS_DISABLED_LINE = f"av-approval: receipts disabled (no facade receipt surface at {CORE_VERSION})"

#: Hooks registered. Empty at this version; see the module docstring.
HOOKS: tuple[str, ...] = ()

_TRUTHY = frozenset({"1", "true", "yes", "on"})

logger = logging.getLogger("av-approval")

#: Kept on the logger, which outlives a module reload, so "once" means once per process.
_LOGGED_ATTR = "_av_approval_logged"


def switch() -> str:
    """`unset`, `on` (`1|true|yes|on`, any case) or `off`. Hermes has already loaded `.env` into the environment."""
    raw = os.environ.get("AV_APPROVAL_ENABLED", "").strip().lower()
    if not raw:
        return "unset"
    return "on" if raw in _TRUTHY else "off"


def enabled() -> bool:
    return switch() == "on"


def gate_entries_present() -> bool:
    """True when `$HERMES_HOME/config.yaml` has a `pre_tool_call` entry running the approval shim.

    Unreadable or unparseable reads as absent: the line this feeds is the
    fail-open warning, and a config nobody can read is no evidence of a gate.
    """
    home = os.environ.get("HERMES_HOME", "").strip() or os.path.join(os.path.expanduser("~"), ".hermes")
    try:
        import yaml  # Hermes ships PyYAML

        with open(os.path.join(home, "config.yaml"), encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh)
        entries = ((cfg or {}).get("hooks") or {}).get("pre_tool_call") or []
        return any(isinstance(e, dict) and str(e.get("command", "")).strip().endswith(SHIM_SUFFIX) for e in entries)
    except Exception:  # noqa: BLE001
        return False


def _log_once(key: str, line: str) -> None:
    logged = getattr(logger, _LOGGED_ATTR, None)
    if not isinstance(logged, set):
        logged = set()
        setattr(logger, _LOGGED_ATTR, logged)
    if key in logged:
        return
    logged.add(key)
    logger.warning(line)


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint. Registers nothing; logs which of the two states it is in, once."""
    try:
        state = switch()
        if state == "unset":
            return
        if state == "off":
            if gate_entries_present():
                _log_once("still-gated", STILL_GATED_LINE)
            else:
                _log_once("disabled", DISABLED_LINE)
            return
        _log_once("receipts-disabled", RECEIPTS_DISABLED_LINE)
    except Exception:  # noqa: BLE001 - a plugin must never break Hermes's plugin loading
        return


__all__ = [
    "CORE_VERSION",
    "DISABLED_LINE",
    "HOOKS",
    "PLUGIN_VERSION",
    "RECEIPTS_DISABLED_LINE",
    "STILL_GATED_LINE",
    "enabled",
    "gate_entries_present",
    "switch",
    "register",
]
