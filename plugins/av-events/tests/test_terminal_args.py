"""DATA-312: foreground `terminal` calls lose the background-only arguments the model fills.

Evidence (rc11 canary, Hermes v0.21.5 / 2026.9.24): `openai/gpt-6-luna` sends every
`terminal` parameter on every call, and `heartbeat`'s schema minimum of 60 makes its
filler value truthy, so Hermes rejects the foreground call before it runs anything.
The plugin's `pre_tool_call` now returns a `modify` directive that switches those
arguments off, and nothing else.

`deployed_handler_checks` below is the validation block of `_handle_terminal` at
Hermes tag v2026.9.24 (`tools/terminal_tool.py` lines 1441-1474), copied verbatim
apart from returning the error text instead of `tool_error(...)` and stopping before
the real `terminal_tool` call. It runs in CI. The Hermes-backed test at the end runs
the REAL dispatcher and handler instead, when a Hermes source tree is available
(`AV_HERMES_SRC` or `HERMES_AGENT_SRC`, default `~/.hermes/hermes-agent`, and its
interpreter `AV_HERMES_PYTHON`, default `<src>/venv/bin/python`).
"""

from __future__ import annotations

import builtins
import json
import os
import random
import subprocess
import sys
from pathlib import Path

import pytest

#: The exact arguments the fleet model sent (rc11 canary, 2026-10-04).
MODEL_PAYLOAD = {
    "command": "printenv X; date -u",
    "background": False,
    "timeout": 20,
    "workdir": "",
    "pty": False,
    "notify": False,
    "heartbeat": 60,
}

BACKGROUND_ONLY = ("notify", "heartbeat", "notify_on_complete", "watch_patterns")
OFF = {"notify": False, "heartbeat": 0, "notify_on_complete": False, "watch_patterns": None}
FOREGROUND_ERROR = "notify/heartbeat only apply to background commands"
HEARTBEAT_ERROR = "heartbeat must be a whole number of seconds"


def deployed_handler_checks(args: dict):
    """`_handle_terminal`'s checks at Hermes v2026.9.24, verbatim (see module docstring).

    Returns the error text the real handler would return, or the kwargs it would
    pass to `terminal_tool` when every check passes.
    """
    notify = args.get("notify")
    notify_on_complete = args.get("notify_on_complete", False)
    watch_patterns = args.get("watch_patterns")
    heartbeat = args.get("heartbeat") or 0
    if not isinstance(heartbeat, int) or isinstance(heartbeat, bool) or heartbeat < 0:
        return "heartbeat must be a whole number of seconds (min 60)."
    if not args.get("background", False):
        if notify or watch_patterns or notify_on_complete or heartbeat:
            return (
                "notify/heartbeat only apply to background commands (foreground "
                "results return directly). Either drop them, or run as "
                "terminal(command=..., background=true, notify=...)."
            )
        if args.get("pty", False):
            return (
                "pty requires background=true (a PTY session is interacted "
                "with via process(action='write'/'submit'), which needs a "
                "tracked background process). Retry as terminal(command=..., "
                "background=true, pty=true)."
            )
    if notify is not None:
        if isinstance(notify, bool):
            notify_on_complete = notify
            watch_patterns = None
        elif isinstance(notify, list):
            watch_patterns = notify
            notify_on_complete = False
        else:
            return (
                "notify must be true/false (notify on exit) or a list of "
                "strings (notify on output pattern match)."
            )
    if heartbeat:
        notify_on_complete = True  # the heartbeat rides the completion delivery path
    return {
        "command": args.get("command"),
        "background": args.get("background", False),
        "timeout": args.get("timeout"),
        "workdir": args.get("workdir"),
        "pty": args.get("pty", False),
        "notify_on_complete": notify_on_complete,
        "watch_patterns": watch_patterns,
        "heartbeat": heartbeat,
    }


def hermes_merge(args: dict, results: list) -> dict:
    """`_get_pre_tool_call_directive_details`'s modify merge at v2026.9.24 (plugins.py 1881-1888)."""
    modified = None
    for result in results:
        if isinstance(result, dict) and result.get("action") == "modify":
            partial = result.get("args")
            if isinstance(partial, dict) and partial:
                modified = {**(modified if modified is not None else args), **partial}
    return args if modified is None else modified


def _coerce_boolean(value: str):
    """`tools/arg_coercion.py` `_coerce_boolean` at v2026.9.24, verbatim."""
    return {"true": True, "false": False}.get(value.strip().lower(), value)


def _coerce_number(value: str, integer_only: bool = False):
    """`tools/arg_coercion.py` `_coerce_number` at v2026.9.24, verbatim."""
    try:
        f = float(value)
    except (ValueError, OverflowError):
        return value
    if f != f or f in (float("inf"), float("-inf")):
        return value  # not JSON-serializable
    return int(f) if f == int(f) else value if integer_only else f


#: `terminal`'s schema types at v2026.9.24 -> the coercer `coerce_tool_args` applies to a
#: string value. `command`/`workdir` are strings (no coercer); `notify` is an `anyOf` with no
#: `type` and is skipped; `notify_on_complete`/`watch_patterns` are not in the schema.
_TERMINAL_COERCERS = {
    "background": _coerce_boolean,
    "pty": _coerce_boolean,
    "timeout": lambda v: _coerce_number(v, integer_only=True),
    "heartbeat": lambda v: _coerce_number(v, integer_only=True),
}


def deployed_coerce(args: dict) -> dict:
    """`coerce_tool_args("terminal", args)` at v2026.9.24 for the terminal schema (on a copy)."""
    out = dict(args)
    for key, value in list(out.items()):
        if isinstance(value, str) and key in _TERMINAL_COERCERS:
            out[key] = _TERMINAL_COERCERS[key](value)
    return out


OURS = (FOREGROUND_ERROR, HEARTBEAT_ERROR, "notify must be true/false")


def handler_after_both_orderings(hooked, raw: dict) -> list:
    """What the handler returns on each Hermes path for the model's `raw` args.

    model_tools path: coerce, then the hook on the coerced args, then the handler.
    agent loop:       the hook on the raw args, then coerce (inside
                      `handle_function_call(skip_pre_tool_call_hook=True)`), then the handler.
    """
    coerced = deployed_coerce(raw)
    model_tools_path = deployed_handler_checks(hermes_merge(coerced, fire_terminal(hooked, dict(coerced))))
    agent_loop = deployed_handler_checks(deployed_coerce(hermes_merge(raw, fire_terminal(hooked, dict(raw)))))
    return [model_tools_path, agent_loop]


@pytest.fixture()
def ta(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._terminal_args"]


@pytest.fixture()
def hooked(plugin, ctx):
    plugin.register(ctx)
    return ctx


def fire_terminal(ctx, args, tool_name="terminal", **extra):
    return ctx.fire("pre_tool_call", tool_name=tool_name, args=args, session_id="s",
                    task_id="t", tool_call_id="c", turn_id="u", **extra)


# --------------------------------------------------------------------------
# The model's payload
# --------------------------------------------------------------------------


def test_model_payload_gets_heartbeat_zero_and_nothing_else(hooked):
    original = dict(MODEL_PAYLOAD)
    results = fire_terminal(hooked, MODEL_PAYLOAD)
    assert results == [{"action": "modify", "args": {"heartbeat": 0}}]
    assert type(results[0]["args"]["heartbeat"]) is int  # 0, not False: the handler's int check
    assert MODEL_PAYLOAD == original, "the hook must not mutate the args Hermes passes"


def test_model_payload_is_rejected_without_and_accepted_with_the_directive(hooked):
    assert deployed_handler_checks(MODEL_PAYLOAD).startswith(FOREGROUND_ERROR)
    merged = hermes_merge(MODEL_PAYLOAD, fire_terminal(hooked, MODEL_PAYLOAD))
    passed = deployed_handler_checks(merged)
    assert isinstance(passed, dict), passed
    assert passed == {
        "command": "printenv X; date -u", "background": False, "timeout": 20, "workdir": "",
        "pty": False, "notify_on_complete": False, "watch_patterns": None, "heartbeat": 0,
    }


@pytest.mark.parametrize("key,value", [
    ("notify", True),
    ("notify", ["ready"]),
    ("heartbeat", 60),
    ("heartbeat", 3600),
    ("notify_on_complete", True),
    ("watch_patterns", ["x"]),
])
def test_each_offending_key_alone(hooked, key, value):
    args = {"command": "ls", key: value}
    assert fire_terminal(hooked, args) == [{"action": "modify", "args": {key: OFF[key]}}]
    assert isinstance(deployed_handler_checks(hermes_merge(args, fire_terminal(hooked, args))), dict)


def test_all_four_offending_keys_together(hooked):
    args = {"command": "ls", "notify": True, "heartbeat": 60, "notify_on_complete": True,
            "watch_patterns": ["x"], "pty": False, "workdir": "/home/hermes", "timeout": 5}
    (result,) = fire_terminal(hooked, args)
    assert result == {"action": "modify", "args": dict(OFF)}
    assert list(result["args"]) == ["notify", "heartbeat", "notify_on_complete", "watch_patterns"]
    assert {k: type(v) for k, v in result["args"].items()} == {
        "notify": bool, "heartbeat": int, "notify_on_complete": bool, "watch_patterns": type(None)}
    passed = deployed_handler_checks(hermes_merge(args, fire_terminal(hooked, args)))
    assert passed["workdir"] == "/home/hermes" and passed["timeout"] == 5 and passed["command"] == "ls"


@pytest.mark.parametrize("args", [
    {"command": "ls"},
    {"command": "ls", "notify": False, "heartbeat": 0, "notify_on_complete": False, "watch_patterns": None},
    {"command": "ls", "notify": [], "watch_patterns": [], "heartbeat": None},
    {"command": "ls", "pty": True},  # pty is not ours to touch: the handler's own error stands
    {"command": "ls", "workdir": "", "timeout": 20},
])
def test_clean_foreground_calls_are_left_alone(hooked, args):
    assert fire_terminal(hooked, args) == []


# --------------------------------------------------------------------------
# Never touched
# --------------------------------------------------------------------------


@pytest.mark.parametrize("background", [True, 1, "true", " TRUE ", "0", "no", "off", ["x"]])
def test_background_truthy_is_never_touched(hooked, background):
    """Truthy as the handler sees it after coercion: only "true"/"false" strings are coerced."""
    args = {"command": "make test", "background": background, "notify": True, "heartbeat": 120}
    assert fire_terminal(hooked, args) == []
    passed = deployed_handler_checks(deployed_coerce(args))
    assert passed["heartbeat"] == 120 and passed["notify_on_complete"] is True


@pytest.mark.parametrize("tool_name", ["shell", "process", "execute_code", "Terminal", "terminal ",
                                       "mcp__x__terminal", "", None, 7])
def test_other_tools_are_never_touched(hooked, tool_name):
    assert fire_terminal(hooked, dict(MODEL_PAYLOAD), tool_name=tool_name) == []


@pytest.mark.parametrize("args", [None, [], "notify", 60, ("heartbeat", 60), {}])
def test_missing_or_non_dict_args(hooked, args):
    assert fire_terminal(hooked, args) == []


def test_no_args_kwarg_at_all(hooked):
    assert hooked.fire("pre_tool_call", tool_name="terminal", session_id="s") == []


def test_no_tool_name_kwarg_at_all(hooked):
    assert hooked.fire("pre_tool_call", args=dict(MODEL_PAYLOAD), session_id="s") == []


# --------------------------------------------------------------------------
# Odd types: every value the handler rejects on a foreground call is switched off
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", [True, -1, 60.0, 0.5, float("nan"), [1], {"a": 1}])
def test_odd_truthy_heartbeat_is_switched_off(hooked, value):
    args = {"command": "ls", "heartbeat": value}
    assert deployed_handler_checks(args).startswith((FOREGROUND_ERROR, HEARTBEAT_ERROR))
    assert fire_terminal(hooked, args) == [{"action": "modify", "args": {"heartbeat": 0}}]
    assert isinstance(deployed_handler_checks(hermes_merge(args, fire_terminal(hooked, args))), dict)


@pytest.mark.parametrize("value", [0, 0.0, False, "", None, []])
def test_falsy_heartbeat_already_passes_and_is_left_alone(hooked, value):
    args = {"command": "ls", "heartbeat": value}
    assert isinstance(deployed_handler_checks(args), dict)
    assert fire_terminal(hooked, args) == []


def test_notify_empty_list_is_left_alone(hooked):
    args = {"command": "ls", "notify": []}
    assert isinstance(deployed_handler_checks(args), dict)
    assert fire_terminal(hooked, args) == []


@pytest.mark.parametrize("value", ["yes", 1, ["x"], {"a": 1}])
def test_odd_truthy_notify_is_switched_off(hooked, value):
    args = {"command": "ls", "notify": value}
    assert fire_terminal(hooked, args) == [{"action": "modify", "args": {"notify": False}}]
    assert isinstance(deployed_handler_checks(hermes_merge(args, fire_terminal(hooked, args))), dict)


def test_watch_patterns_list_is_switched_off(hooked):
    args = {"command": "ls", "watch_patterns": ["x"]}
    assert fire_terminal(hooked, args) == [{"action": "modify", "args": {"watch_patterns": None}}]
    passed = deployed_handler_checks(hermes_merge(args, fire_terminal(hooked, args)))
    assert passed["watch_patterns"] is None


# --------------------------------------------------------------------------
# Precedence, kill switch, independence from telemetry, failure
# --------------------------------------------------------------------------


def test_an_existing_directive_wins(plugin):
    block = {"action": "block", "message": "no"}
    hook = plugin.with_terminal_args_fix(lambda *a, **kw: block)
    assert hook(tool_name="terminal", args=dict(MODEL_PAYLOAD)) is block
    modify = {"action": "modify", "args": {"timeout": 5}}
    hook = plugin.with_terminal_args_fix(lambda *a, **kw: modify)
    assert hook(tool_name="terminal", args=dict(MODEL_PAYLOAD)) is modify


def test_the_telemetry_counter_still_counts(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) == [{"action": "modify", "args": {"heartbeat": 0}}]
    assert plugin._COLLECTOR.sessions["s"].tool_call_count == 1


@pytest.mark.parametrize("value", ["0", "false", "no", "off", " OFF ", "False"])
def test_kill_switch_off(plugin, ctx, monkeypatch, value):
    monkeypatch.setenv("AV_TERMINAL_ARGS_FIX", value)
    plugin.register(ctx)
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) == []


@pytest.mark.parametrize("value", ["1", "true", "on", "", "anything"])
def test_kill_switch_on_values(plugin, ctx, monkeypatch, value):
    monkeypatch.setenv("AV_TERMINAL_ARGS_FIX", value)
    plugin.register(ctx)
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) == [{"action": "modify", "args": {"heartbeat": 0}}]


def test_kill_switch_is_read_per_call(plugin, ctx, monkeypatch):
    plugin.register(ctx)
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) != []
    monkeypatch.setenv("AV_TERMINAL_ARGS_FIX", "0")
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) == []
    monkeypatch.delenv("AV_TERMINAL_ARGS_FIX")
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) != []


def test_kill_switch_ignores_the_dotenv_file(plugin, ctx, home):
    """The switch is a process-env lookup only; `.env` reaches it through Hermes's own load."""
    (home / ".env").write_text("AV_TERMINAL_ARGS_FIX=0\n", encoding="utf-8")
    plugin.register(ctx)
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) == [{"action": "modify", "args": {"heartbeat": 0}}]


@pytest.mark.parametrize("env", [
    {"AV_EVENTS_ENABLED": "0"},
    {"AV_HOOKS_DISABLED": "pre_tool_call"},
    {},  # no token: telemetry idles
])
def test_fix_runs_whatever_the_telemetry_switches_say(plugin, ctx, monkeypatch, env):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    if env:
        monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) == [{"action": "modify", "args": {"heartbeat": 0}}]


def test_fix_runs_without_a_collector(plugin):
    hooks = plugin.build_hooks(collector_ref=lambda: None)
    assert hooks["pre_tool_call"](tool_name="terminal", args=dict(MODEL_PAYLOAD)) == {
        "action": "modify", "args": {"heartbeat": 0}}


def test_an_internal_error_returns_what_the_hook_returned_before(plugin, ctx, ta, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(ta, "directive", boom)
    plugin.register(ctx)
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) == []


class _ExplodingDict(dict):
    def get(self, *a, **kw):
        raise KeyError("explodes")


class _Unbooly:
    def __bool__(self):
        raise ValueError("no truth value")


@pytest.mark.parametrize("args", [
    _ExplodingDict(MODEL_PAYLOAD),
    {"command": "ls", "background": _Unbooly()},
    {"command": "ls", "heartbeat": _Unbooly()},
])
def test_hostile_args_never_raise(hooked, args):
    assert fire_terminal(hooked, args) == []


def test_a_broken_logger_does_not_cost_the_fix(plugin, ctx, monkeypatch):
    class Broken:
        def debug(self, *a, **kw):
            raise OSError("disk full")

    monkeypatch.setattr(plugin, "logger", Broken())
    plugin.register(ctx)
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) == [{"action": "modify", "args": {"heartbeat": 0}}]


def test_log_line_names_keys_never_values_or_command(plugin, ctx, caplog):
    import logging

    plugin.register(ctx)
    with caplog.at_level(logging.DEBUG, logger="av-events"):
        fire_terminal(ctx, {"command": "cat /secret/path", "heartbeat": 60, "notify": ["needle-pattern"]})
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "neutralised=notify,heartbeat" in text
    assert "/secret/path" not in text and "needle-pattern" not in text and "60" not in text


def test_the_fix_does_no_io(plugin, ctx, monkeypatch):
    plugin.register(ctx)
    calls: list[str] = []
    for target, name in ((builtins, "open"), (os, "stat"), (os, "makedirs"), (os, "listdir")):
        original = getattr(target, name)

        def spy(*args, _o=original, _n=name, **kwargs):
            calls.append(_n)
            return _o(*args, **kwargs)

        monkeypatch.setattr(target, name, spy)
    assert fire_terminal(ctx, dict(MODEL_PAYLOAD)) != []
    assert calls == []


# --------------------------------------------------------------------------
# Hermes's argument coercion (refuter SF1) and the notify type check (N1)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("raw,expected_off", [
    ({"command": "ls", "background": "false", "heartbeat": 60}, {"heartbeat": 0}),
    ({"command": "ls", "background": " False ", "heartbeat": "60"}, {"heartbeat": 0}),
    ({"command": "ls", "background": "FALSE", "notify": "false"}, {"notify": False}),
    ({"command": "ls", "heartbeat": "60"}, {"heartbeat": 0}),
    ({"command": "ls", "heartbeat": " 60 "}, {"heartbeat": 0}),
    ({"command": "ls", "heartbeat": "1e2"}, {"heartbeat": 0}),
    ({"command": "ls", "heartbeat": "0.5"}, {"heartbeat": 0}),   # not integral: stays a string
    ({"command": "ls", "heartbeat": "abc"}, {"heartbeat": 0}),
    ({"command": "ls", "heartbeat": "nan"}, {"heartbeat": 0}),
    ({"command": "ls", "heartbeat": "-1"}, {"heartbeat": 0}),
    ({"command": "ls", "notify": "true"}, {"notify": False}),    # notify is never coerced
    ({"command": "ls", "notify_on_complete": "false"}, {"notify_on_complete": False}),  # nor this
    ({"command": "ls", "watch_patterns": "[]"}, {"watch_patterns": None}),  # nor this
])
def test_string_arguments_are_judged_after_coercion(hooked, raw, expected_off):
    assert fire_terminal(hooked, dict(raw)) == [{"action": "modify", "args": expected_off}]
    for result in handler_after_both_orderings(hooked, raw):
        assert isinstance(result, dict), (raw, result)
        assert result["background"] is False and result["heartbeat"] == 0


@pytest.mark.parametrize("raw", [
    {"command": "ls", "heartbeat": "0"},
    {"command": "ls", "heartbeat": " 0 "},
    {"command": "ls", "heartbeat": "0.0"},
    {"command": "ls", "heartbeat": "-0"},
    {"command": "ls", "background": "false"},
    {"command": "ls", "background": "false", "heartbeat": "0", "pty": "false", "timeout": "20"},
])
def test_strings_that_coerce_to_off_are_left_alone(hooked, raw):
    assert fire_terminal(hooked, dict(raw)) == []
    for result in handler_after_both_orderings(hooked, raw):
        assert isinstance(result, dict), (raw, result)


@pytest.mark.parametrize("raw", [
    {"command": "make", "background": "true", "notify": True, "heartbeat": "120"},
    {"command": "make", "background": " True", "heartbeat": 60},
    {"command": "make", "background": "0", "notify": True},     # "0" is not coerced: truthy
    {"command": "make", "background": "no", "heartbeat": 60},   # nor "no"
])
def test_strings_the_handler_runs_in_the_background_are_untouched(hooked, raw):
    assert fire_terminal(hooked, dict(raw)) == []
    assert fire_terminal(hooked, deployed_coerce(raw)) == []


_COERCION_PROBES = ("true", "false", " TRUE ", "False\n", "0", "1", "no", "off", "", " ", "60", " 60 ", "0", "-0",
                    "0.0", "0.5", "60.0", "1e2", "1e400", "-1e400", "nan", "inf", "abc", "6 0", "0x10", "١٢",
                    0, 1, 60, 0.5, True, False, None, [], ["x"], {})


@pytest.mark.parametrize("value", _COERCION_PROBES)
def test_the_coercion_mirrors_equal_hermes_exactly(ta, value):
    """Not just the same truthiness: the same value and type as v2026.9.24's coercers."""
    expected_bool = _coerce_boolean(value) if isinstance(value, str) else value
    expected_int = _coerce_number(value, integer_only=True) if isinstance(value, str) else value
    assert ta.coerced_boolean(value) == expected_bool
    assert type(ta.coerced_boolean(value)) is type(expected_bool)
    assert ta.coerced_integer(value) == expected_int or (expected_int != expected_int)
    assert type(ta.coerced_integer(value)) is type(expected_int)


def test_the_refuters_case_fails_without_the_fix_on_the_agent_loop(plugin, ctx, monkeypatch):
    """`{"background": "false", "heartbeat": 60}`: coercion makes it foreground after the hook."""
    raw = {"command": "ls", "background": "false", "heartbeat": 60}
    assert deployed_handler_checks(deployed_coerce(raw)).startswith(FOREGROUND_ERROR)
    plugin.register(ctx)
    assert all(isinstance(r, dict) for r in handler_after_both_orderings(ctx, raw))


@pytest.mark.parametrize("value", [0, "", "maybe", 0.0, {}, (), ("x",), b"", 1.5])
def test_notify_of_a_type_the_handler_rejects_is_set_false(hooked, value):
    raw = {"command": "ls", "notify": value}
    if not value:
        # Falsy, so the foreground check passes, but the type check after it rejects.
        assert deployed_handler_checks(raw).startswith("notify must be true/false")
    assert fire_terminal(hooked, dict(raw)) == [{"action": "modify", "args": {"notify": False}}]
    for result in handler_after_both_orderings(hooked, raw):
        assert isinstance(result, dict), (raw, result)


def test_notify_type_fix_keeps_the_key_order(hooked):
    raw = {"command": "ls", "notify": 0, "heartbeat": 60, "watch_patterns": ["x"]}
    (result,) = fire_terminal(hooked, raw)
    assert list(result["args"]) == ["notify", "heartbeat", "watch_patterns"]


@pytest.mark.parametrize("value", [False, True, [], ["x"], None])
def test_notify_bool_list_or_none_is_judged_by_truthiness_only(hooked, value):
    expected = [{"action": "modify", "args": {"notify": False}}] if value else []
    assert fire_terminal(hooked, {"command": "ls", "notify": value}) == expected


def test_notify_type_fix_never_touches_a_background_call(hooked):
    assert fire_terminal(hooked, {"command": "ls", "background": True, "notify": "maybe"}) == []


# --------------------------------------------------------------------------
# Fuzz
# --------------------------------------------------------------------------

_KEYS = ("command", "background", "timeout", "workdir", "pty") + BACKGROUND_ONLY + ("extra",)
_VALUES = (None, True, False, 0, 1, -1, 60, 60.0, 0.0, "", "60", "0", " 0 ", "0.5", "x", "false", " FALSE ",
           "true", "no", "nan", "1e2", [], ["x"], {}, {"a": 1}, float("nan"), b"", (), ("x",))


def _random_args(rng: random.Random) -> dict:
    return {key: rng.choice(_VALUES) for key in rng.sample(_KEYS, rng.randint(0, len(_KEYS)))}


def test_fuzz_never_raises_and_decides_exactly_as_the_handler_does(hooked):
    """On both Hermes orderings: a directive appears exactly when the handler, after coercion,
    would reject the call for a background-only argument (or notify's type), and with it the
    handler never does; a call the handler runs in the background is never touched."""
    rng = random.Random(312)
    touched = 0
    for _ in range(800):
        args = _random_args(rng)
        snapshot = dict(args)
        results = fire_terminal(hooked, args)
        assert args == snapshot, "the hook must not mutate the args Hermes passes"
        coerced = deployed_coerce(args)
        assert fire_terminal(hooked, dict(coerced)) == results, "coerced and raw args must decide alike"
        if coerced.get("background", False):
            assert results == [], args
            continue
        # `pty` is not ours, and the handler checks it before notify's type: judge with it off.
        unfixed = deployed_handler_checks({**coerced, "pty": False})
        ours = isinstance(unfixed, str) and unfixed.startswith(OURS)
        assert bool(results) == ours, (args, unfixed, results)
        if not results:
            continue
        touched += 1
        (directive,) = results
        assert directive["action"] == "modify"
        assert set(directive["args"]) <= set(BACKGROUND_ONLY)
        assert all(directive["args"][k] == OFF[k] for k in directive["args"])
        for checked in handler_after_both_orderings(hooked, args):
            if isinstance(checked, str):
                assert not checked.startswith(OURS), (args, checked)
    assert touched > 100


def test_fuzz_other_tools_and_background(hooked):
    rng = random.Random(2026)
    for _ in range(300):
        args = _random_args(rng)
        assert fire_terminal(hooked, args, tool_name=rng.choice(["shell", "process", "read_file"])) == []
        args["background"] = True
        assert fire_terminal(hooked, args) == []


# --------------------------------------------------------------------------
# Real Hermes: the plugin-hook dispatcher, then the terminal handler
# --------------------------------------------------------------------------

_HERMES_SRC = Path(os.environ.get("AV_HERMES_SRC") or os.environ.get("HERMES_AGENT_SRC")
                   or Path.home() / ".hermes" / "hermes-agent")
_HERMES_PY = os.environ.get("AV_HERMES_PYTHON") or str(_HERMES_SRC / "venv" / "bin" / "python")

_REAL_HERMES = r'''
import inspect, json, os, shutil, sys
home, plugin_dir, payload, cases = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4])
for name in [n for n in os.environ if n.startswith("AV_")]:
    del os.environ[name]
os.environ["HERMES_HOME"] = home
try:
    import yaml
    with open(os.path.join(home, "config.yaml"), "w") as fh:
        fh.write(yaml.safe_dump({"plugins": {"enabled": ["av-events"]}}))
    shutil.copytree(plugin_dir, os.path.join(home, "plugins", "av-events"),
                    ignore=shutil.ignore_patterns("tests", "__pycache__"))
    from hermes_cli.plugins import discover_plugins, get_plugin_manager, _dispatch_pre_tool_call_hooks
    import model_tools
    from tools import terminal_tool as tt
except ImportError as exc:
    print(json.dumps({"import_error": repr(exc)}))
    sys.exit(0)

discover_plugins()
manager = get_plugin_manager()
ours = manager._hooks.get("pre_tool_call", [])
loaded = any(getattr(cb, "__module__", "").endswith("av_events") for cb in ours)

# Stands in for the approval shim: a pre_tool_call callback registered AFTER the
# plugins, the way gateway startup registers config shell hooks.
gate_saw = []
def gate(**kw):
    gate_saw.append(dict(kw.get("args") or {}))
    return blocker[0]
blocker = [None]
manager._hooks.setdefault("pre_tool_call", []).append(gate)
post_saw = []
def post(**kw):
    post_saw.append(dict(kw.get("args") or {}))
manager._hooks.setdefault("post_tool_call", []).append(post)

# The real handler, with only the final process spawn replaced.
spawned = []
def fake_terminal_tool(**kw):
    spawned.append({k: v for k, v in kw.items() if k not in ("task_id", "session_id")})
    return json.dumps({"output": "ok", "exit_code": 0, "error": None})
tt.terminal_tool = fake_terminal_tool
knows_heartbeat = "heartbeat" in inspect.getsource(tt._handle_terminal)

def run(args, switch=None, block=None):
    gate_saw.clear(); post_saw.clear(); spawned.clear(); blocker[0] = block
    if switch is None:
        os.environ.pop("AV_TERMINAL_ARGS_FIX", None)
    else:
        os.environ["AV_TERMINAL_ARGS_FIX"] = switch
    block_msg, modified = _dispatch_pre_tool_call_hooks("terminal", dict(args), session_id="s1",
                                                         tool_call_id="c-direct", turn_id="u1")
    result = model_tools.handle_function_call("terminal", dict(args), task_id="t1", tool_call_id="c1",
                                              session_id="s1", turn_id="u1")
    return {"block": block_msg, "modified": modified, "result": result, "gate_saw": list(gate_saw),
            "post_saw": list(post_saw), "spawned": list(spawned)}

def run_agent_loop(args, switch=None):
    """The agent loop's order (agent/tool_executor.py): the hook on the parsed args, then
    handle_function_call with skip_pre_tool_call_hook=True, which coerces and dispatches."""
    gate_saw.clear(); post_saw.clear(); spawned.clear(); blocker[0] = None
    if switch is None:
        os.environ.pop("AV_TERMINAL_ARGS_FIX", None)
    else:
        os.environ["AV_TERMINAL_ARGS_FIX"] = switch
    raw = json.loads(json.dumps(args))
    block_msg, modified = _dispatch_pre_tool_call_hooks("terminal", raw, session_id="s1",
                                                         tool_call_id="c2", turn_id="u1")
    final = raw if modified is None else modified
    result = model_tools.handle_function_call(
        "terminal", final, task_id="t1", tool_call_id="c2", session_id="s1", turn_id="u1",
        skip_pre_tool_call_hook=True, skip_tool_request_middleware=True, skip_tool_execution_middleware=True)
    return {"block": block_msg, "modified": modified, "result": result, "spawned": list(spawned)}

print(json.dumps({
    "coercion": [{"case": case, "model_tools": run(case), "agent_loop": run_agent_loop(case)} for case in cases],
    "coercion_off": [{"case": case, "model_tools": run(case, switch="0"),
                      "agent_loop": run_agent_loop(case, switch="0")} for case in cases[:1]],
    "loaded": loaded,
    "knows_heartbeat": knows_heartbeat,
    "fixed": run(payload),
    "switched_off": run(payload, switch="0"),
    "notify_true_off": run({**payload, "notify": True}, switch="0"),
    "notify_true": run({**payload, "notify": True}),
    "background": run({"command": "make test", "background": True, "notify": True, "heartbeat": 120}),
    "blocked": run(payload, block={"action": "block", "message": "gate says no"}),
}, default=repr))
'''


#: (raw args, background as the handler passes it on) for the real-Hermes coercion check.
#: The first is the refuter's case; it is also run with the switch off as the control.
REAL_COERCION_CASES = [
    ({"command": "ls", "background": "false", "heartbeat": 60}, False),
    ({"command": "ls", "background": " False ", "heartbeat": "60", "notify": "false"}, False),
    ({"command": "ls", "heartbeat": "0"}, False),
    ({"command": "ls", "notify": 0}, False),
    ({"command": "ls", "notify": "maybe", "heartbeat": " 60 "}, False),
    ({"command": "make", "background": "true", "notify": True, "heartbeat": "120"}, True),
    ({"command": "make", "background": "0", "notify": True}, "0"),
]


def _real_hermes_available() -> bool:
    return (_HERMES_SRC / "hermes_cli" / "plugins.py").is_file() and Path(_HERMES_PY).is_file()


@pytest.mark.skipif(not _real_hermes_available(),
                    reason="no Hermes source tree + interpreter (AV_HERMES_SRC / AV_HERMES_PYTHON)")
def test_model_payload_through_the_real_hermes_dispatcher_and_handler(tmp_path, av):
    home = tmp_path / ".hermes"
    home.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("AV_")}
    env.update(PYTHONPATH=str(_HERMES_SRC), PYTHONDONTWRITEBYTECODE="1", HERMES_HOME=str(home))
    out = subprocess.run([_HERMES_PY, "-c", _REAL_HERMES, str(home), str(av.PLUGIN_DIR), json.dumps(MODEL_PAYLOAD),
                          json.dumps([case for case, _ in REAL_COERCION_CASES])],
                         capture_output=True, text=True, env=env, timeout=300, cwd=str(tmp_path))
    assert out.returncode == 0, out.stderr[-3000:]
    report = json.loads(out.stdout.strip().splitlines()[-1])
    if "import_error" in report:
        pytest.skip(f"Hermes not importable with {_HERMES_PY}: {report['import_error']}")
    assert report["loaded"], "Hermes did not load av-events from $HERMES_HOME/plugins"

    fixed = report["fixed"]
    assert fixed["block"] is None
    assert fixed["modified"] == {**MODEL_PAYLOAD, "heartbeat": 0}
    assert "only apply to background" not in fixed["result"], fixed["result"]
    assert json.loads(fixed["result"]) == {"output": "ok", "exit_code": 0, "error": None}
    (spawn,) = fixed["spawned"]
    assert spawn["command"] == MODEL_PAYLOAD["command"] and spawn["background"] is False
    assert spawn["workdir"] == "" and spawn["timeout"] == 20 and spawn["pty"] is False
    assert spawn["notify_on_complete"] is False and spawn["watch_patterns"] is None
    if report["knows_heartbeat"]:
        assert spawn["heartbeat"] == 0
    # The gate (any later pre_tool_call callback) judges the ORIGINAL args;
    # post_tool_call records the MODIFIED ones.
    assert fixed["gate_saw"] and all(seen == MODEL_PAYLOAD for seen in fixed["gate_saw"])
    assert fixed["post_saw"] == [{**MODEL_PAYLOAD, "heartbeat": 0}]

    off = report["switched_off"]
    assert off["modified"] is None
    if report["knows_heartbeat"]:
        # The deployed release (v2026.9.24): the model's own payload is the bug.
        assert off["spawned"] == []
        assert "notify/heartbeat only apply to background commands" in off["result"], off["result"]
    else:
        # An older tree has no `heartbeat`; the same rule holds for `notify`.
        assert report["notify_true_off"]["spawned"] == []
        assert "only applies to background commands" in report["notify_true_off"]["result"]

    notify = report["notify_true"]
    assert notify["modified"] == {**MODEL_PAYLOAD, "notify": False, "heartbeat": 0}
    assert len(notify["spawned"]) == 1 and notify["spawned"][0]["notify_on_complete"] is False

    background = report["background"]
    assert background["modified"] is None
    (spawn,) = background["spawned"]
    assert spawn["background"] is True and spawn["notify_on_complete"] is True
    if report["knows_heartbeat"]:
        assert spawn["heartbeat"] == 120

    blocked = report["blocked"]
    assert blocked["block"] == "gate says no" and blocked["spawned"] == []
    assert "gate says no" in blocked["result"]

    # Refuter SF1/N1 against the real coerce_tool_args, on both orderings Hermes uses.
    for entry, (_, background) in zip(report["coercion"], REAL_COERCION_CASES):
        for order in ("model_tools", "agent_loop"):
            run = entry[order]
            assert not any(text in run["result"] for text in (
                "only apply to background", "only applies to background", "heartbeat must be",
                "notify must be")), (entry["case"], order, run["result"])
            assert len(run["spawned"]) == 1, (entry["case"], order, run["result"])
            assert run["spawned"][0]["background"] == background, (entry["case"], order)
            if background is not False:
                assert run["modified"] is None, (entry["case"], order)
            if report["knows_heartbeat"] and background is False:
                assert run["spawned"][0]["heartbeat"] == 0, (entry["case"], order)
    if report["knows_heartbeat"]:
        assert report["coercion"][5]["agent_loop"]["spawned"][0]["heartbeat"] == 120
        for order in ("model_tools", "agent_loop"):
            control = report["coercion_off"][0][order]
            assert control["spawned"] == [] and "only apply to background" in control["result"], order
