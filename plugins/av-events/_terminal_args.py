"""DATA-312: switch off background-only `terminal` arguments on a foreground call.

The fleet model (`openai/gpt-6-luna`) fills every parameter of Hermes's
`terminal` tool on every call, `heartbeat` included, and the schema's
`minimum: 60` makes its filler value 60. Hermes v0.21.5 (release 2026.9.24)
rejects a foreground call that carries a truthy `notify`, `watch_patterns`,
`notify_on_complete` or `heartbeat` before it runs anything
(`tools/terminal_tool.py` `_handle_terminal`, lines 1441-1453 at that tag):

    heartbeat = args.get("heartbeat") or 0
    if not isinstance(heartbeat, int) or isinstance(heartbeat, bool) or heartbeat < 0:
        return tool_error(...)
    if not args.get("background", False):
        if notify or watch_patterns or notify_on_complete or heartbeat:
            return tool_error("notify/heartbeat only apply to background commands ...")

`pre_tool_call` may return `{"action": "modify", "args": {...}}`, which Hermes
shallow-merges into the tool input before dispatch (`hermes_cli/plugins.py`
1881-1888 at that tag). This module builds that directive. It sets ONLY the
offending keys to values the handler treats as off and whose types it accepts;
a modify directive cannot delete a key, so "off" is a value, not an absence.

Pure: no I/O, no logging, no clock. The switch is a dict lookup on the process
environment, never the `.env` fallback the rest of the plugin uses (that costs
a `stat`, and `pre_tool_call` is the hook Hermes fails closed on). Hermes loads
`$HERMES_HOME/.env` into the process environment with override at start, so a
`.env` line still takes effect, at the next gateway start.
"""

from __future__ import annotations

import os
from typing import Any, Mapping, Optional

from ._core import DISABLED_VALUES

TOOL_NAME = "terminal"

#: Kill switch. Default on; any of `0`, `false`, `no`, `off` turns it off.
SWITCH = "AV_TERMINAL_ARGS_FIX"

#: The background-only arguments and the value that switches each one off.
#: Every value is falsy, so the foreground check passes; `heartbeat` 0 is a
#: non-bool int >= 0, so the type check before it passes too. `notify` False is
#: a bool, which the later `notify` type check accepts. `watch_patterns` None
#: is the handler's own default (`args.get("watch_patterns")` on a missing key).
#: Order is fixed so the directive and the log line are deterministic.
OFF_VALUES: tuple[tuple[str, Any], ...] = (
    ("notify", False),
    ("heartbeat", 0),
    ("notify_on_complete", False),
    ("watch_patterns", None),
)


def switch_on(environ: Optional[Mapping[str, str]] = None) -> bool:
    """True unless `AV_TERMINAL_ARGS_FIX` holds an accepted spelling of "off"."""
    raw = (os.environ if environ is None else environ).get(SWITCH)
    if raw is None:
        return True
    return str(raw).strip().lower() not in DISABLED_VALUES


def directive(tool_name: Any, args: Any) -> Optional[dict]:
    """The modify directive for one `pre_tool_call`, or None to leave the call alone.

    None unless all of: the tool is exactly `terminal`; `args` is a dict;
    `background` is not truthy (the handler's own test, so a call the handler
    runs in the background is never touched); and at least one background-only
    argument is truthy. `command`, `workdir`, `timeout`, `pty` and `background`
    are never in the directive.
    """
    if tool_name != TOOL_NAME or not isinstance(args, dict):
        return None
    if args.get("background", False):
        return None
    off = {key: value for key, value in OFF_VALUES if args.get(key)}
    if not off:
        return None
    return {"action": "modify", "args": off}


def safe_directive(tool_name: Any, args: Any, environ: Optional[Mapping[str, str]] = None) -> Optional[dict]:
    """`directive` behind the kill switch, and never raising.

    Any internal error returns None, which is what the plugin's `pre_tool_call`
    returned before DATA-312: the call goes to Hermes unchanged. A raise would
    be worse than the bug, since Hermes 2026.9.24 turns a raising
    `pre_tool_call` callback into a block (`hermes_cli/plugins_dispatch.py`
    `invoke_hook`, `_policy_error_block_directive`).
    """
    try:
        if not switch_on(environ):
            return None
        return directive(tool_name, args)
    except BaseException:  # noqa: BLE001 - a raise here would block the tool call
        return None


__all__ = ["TOOL_NAME", "SWITCH", "OFF_VALUES", "switch_on", "directive", "safe_directive"]
