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


def coerced_boolean(value: Any) -> Any:
    """`background` as Hermes's coercion leaves it (`tools/arg_coercion.py` `_coerce_boolean`).

    The schema types `background` as boolean, so a string whose stripped,
    lower-cased form is exactly "true" or "false" becomes that bool; any other
    value, string or not, is left as it is. Nothing broader: "0", "no", "off"
    stay strings, and stay truthy, exactly as the handler will see them.
    """
    if isinstance(value, str):
        return {"true": True, "false": False}.get(value.strip().lower(), value)
    return value


def coerced_integer(value: Any) -> Any:
    """`heartbeat` as Hermes's coercion leaves it (`_coerce_number(..., integer_only=True)`).

    A string that parses as a finite float with an integral value becomes that
    int ("60" -> 60, " 0 " -> 0, "1e2" -> 100); any other string, and any
    non-string, is left as it is.
    """
    if not isinstance(value, str):
        return value
    try:
        number = float(value)
    except (ValueError, OverflowError):
        return value
    if number != number or number in (float("inf"), float("-inf")):
        return value
    return int(number) if number == int(number) else value


#: Post-coercion view of each argument the rule reads. `notify` (an `anyOf`
#: with no `type`), `notify_on_complete` and `watch_patterns` (not in the
#: schema) are never coerced; `background` and `heartbeat` are
#: (`tools/arg_coercion.py` at v2026.9.24, `coerce_tool_args`).
_COERCED = {"background": coerced_boolean, "heartbeat": coerced_integer}


def _seen(args: dict, key: str) -> Any:
    """`args[key]` as the terminal handler will see it, after Hermes's coercion."""
    value = args.get(key)
    coerce = _COERCED.get(key)
    return coerce(value) if coerce is not None else value


def directive(tool_name: Any, args: Any) -> Optional[dict]:
    """The modify directive for one `pre_tool_call`, or None to leave the call alone.

    Hermes coerces string-typed arguments against the tool schema, BEFORE this
    hook on the `model_tools.handle_function_call` path (`model_tools.py:888`)
    and AFTER it on the agent loop (`agent/tool_executor.py` fires the hook on
    the parsed arguments, then dispatches through `handle_function_call` with
    `skip_pre_tool_call_hook=True`). Every decision here is therefore made on
    the post-coercion value (`_seen`), which is what the handler checks on
    either path; on already-coerced arguments it is the identity.

    None unless all of: the tool is exactly `terminal`; `args` is a dict;
    `background` is not truthy as the handler will see it (so a call the
    handler runs in the background is never touched); and at least one
    background-only argument is truthy as the handler will see it, or `notify`
    is present but neither a bool nor a list (the handler's later "notify must
    be true/false" rejection). `command`, `workdir`, `timeout`, `pty` and
    `background` are never in the directive.
    """
    if tool_name != TOOL_NAME or not isinstance(args, dict):
        return None
    if _seen(args, "background"):
        return None
    off = {key: value for key, value in OFF_VALUES if _seen(args, key)}
    notify = args.get("notify")
    if notify is not None and not isinstance(notify, (bool, list)):
        off["notify"] = False
        off = {key: off[key] for key, _ in OFF_VALUES if key in off}
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


__all__ = ["TOOL_NAME", "SWITCH", "OFF_VALUES", "switch_on", "coerced_boolean", "coerced_integer",
           "directive", "safe_directive"]
