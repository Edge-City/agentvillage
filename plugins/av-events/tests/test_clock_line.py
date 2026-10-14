"""CLOCK-1: every turn ends with the village clock, `Now: <Wkd YYYY-MM-DD HH:MM> IST (<h:mm AM/PM>)`.

A chat turn already carries Hermes's per-message stamp; a cron run and a delegated child carried
the date and no time, and the gate refuses `date`. `pre_llm_call` now returns the Now line on every
turn type, appended by Hermes to the current user message (never the system prompt), outside the
telemetry guard, with `clock_line` in `AV_HOOKS_DISABLED` as its kill switch. It never raises.
Synthetic fixtures only.
"""

from __future__ import annotations

import inspect
import logging
import re
import sys
from datetime import datetime, timezone

import pytest

LINE = re.compile(r"^Now: [A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} IST \(\d{1,2}:\d{2} [AP]M\)$")


def clock(plugin):
    return sys.modules[f"{plugin.__name__}._clock"]


def reminders(plugin):
    return sys.modules[f"{plugin.__name__}._approvals_reminder"]


def utc(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def turn(ctx, session="tg-dm-1", platform="telegram", text="hi there", parent="", turn_id="t1", **extra) -> list:
    """One `pre_llm_call`, shaped as Hermes v2026.9.24 `_collect_pre_llm_call_context` sends it."""
    history = extra.pop("history", None)
    return ctx.fire(
        "pre_llm_call", session_id=session, task_id=session, turn_id=turn_id, user_message=text,
        conversation_history=history if history is not None else [{"role": "user", "content": text}],
        is_first_turn=False, model="m", platform=platform, parent_session_id=parent, sender_id="", **extra,
    )


def context_of(results: list) -> str:
    assert len(results) == 1, results
    assert isinstance(results[0], dict) and set(results[0]) == {"context"}, results
    return results[0]["context"]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    """The plugin registered (telemetry idle: no token), the clock memo and reminder memo cleared."""
    monkeypatch.delenv("HERMES_TIMEZONE", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_TYPE", raising=False)
    plugin.register(ctx)
    clock(plugin).reset()
    reminders(plugin).reset()
    return plugin


# ---- every turn type -------------------------------------------------------------------------


def test_cron_run_gets_the_now_line(live, ctx):
    """A heartbeat / digest / resident job: `platform=cron`, a `cron_<job>_<stamp>` session."""
    text = "[SYSTEM: You are running as a scheduled cron job.] Check what is on now."
    got = context_of(turn(ctx, session="cron_93a5503a_20261015_003000", platform="cron", text=text))
    assert LINE.match(got), got


def test_delegated_child_gets_the_now_line(live, ctx):
    """A subagent: `parent_session_id` set, no gateway stamp on its goal message."""
    got = context_of(turn(ctx, session="child-1", platform="", parent="tg-dm-1", text="Find tonight's sessions."))
    assert LINE.match(got), got


def test_child_of_a_cron_run_gets_the_now_line(live, ctx):
    got = context_of(turn(ctx, session="child-2", platform="cron", parent="cron_job_20261015_003000"))
    assert LINE.match(got), got


def test_chat_turn_with_the_message_stamp_keeps_both(live, ctx, monkeypatch):
    """A DM turn already starts with Hermes's `[... IST]` stamp; the Now line comes at the end.
    What the model then sees as the user message: `<stamp> <text>\\n\\n<Now line>`."""
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    text = "[Thu 2026-10-15 00:54:12 IST] what's on now?"
    got = context_of(turn(ctx, text=text))
    assert LINE.match(got), got
    # Hermes `compose_user_api_content`: content + "\n\n" + injection.
    sent = text + "\n\n" + got
    assert sent.startswith("[Thu 2026-10-15 00:54:12 IST] what's on now?\n\nNow: ")
    assert sent.count("Now: ") == 1


def test_group_and_injected_turns_get_the_now_line(live, ctx, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    assert LINE.match(context_of(turn(ctx, session="tg-group-1", text="[Thu 2026-10-15 00:54:12 IST] hi")))
    injected = "[SYSTEM: background process finished]"
    assert LINE.match(context_of(turn(ctx, session="tg-dm-2", turn_id="t9", text=injected)))


def test_order_is_telemetry_then_now_line_then_the_data444_reminder(live, ctx, home, monkeypatch):
    import json

    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    path = home / "memory" / "approvals-pairing.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    path.write_text(json.dumps({"started": False, "button": "sent", "at": at}), encoding="utf-8")
    got = context_of(turn(ctx))
    now, reminder = got.split("\n\n")
    assert LINE.match(now), got
    assert reminder == reminders(live).REMINDER


# ---- outside the telemetry guard; the kill switch ----------------------------------------------


@pytest.mark.parametrize("env", [
    {"AV_EVENTS_ENABLED": "0"},
    {"AV_EVENTS_ENABLED": "0", "AV_EVENTS_TOKEN": "test-token"},
    {"AV_HOOKS_DISABLED": "pre_llm_call"},
    {"AV_HOOKS_DISABLED": "pre_llm_call,approvals_reminder,cron_run"},
])
def test_telemetry_off_still_gives_the_line(plugin, ctx, monkeypatch, env):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    plugin.register(ctx)
    clock(plugin).reset()
    assert LINE.match(context_of(turn(ctx, session="cron_j_20261015_010000", platform="cron")))


@pytest.mark.parametrize("value", ["clock_line", " Clock_Line ", "pre_llm_call, clock_line", "CLOCK_LINE,approvals_reminder"])
def test_kill_switch_clock_line_turns_it_off(plugin, ctx, monkeypatch, value):
    monkeypatch.setenv("AV_HOOKS_DISABLED", value)
    plugin.register(ctx)
    clock(plugin).reset()
    assert turn(ctx, session="cron_j_20261015_010000", platform="cron") == []


def test_kill_switch_from_the_dotenv_and_without_a_collector(plugin, home, monkeypatch):
    """No collector (a bare wrapper): the same parse of `AV_HOOKS_DISABLED`, process env then `.env`."""
    hook = clock(plugin).with_clock_line(lambda **_k: None, lambda: None)
    assert LINE.match(hook(session_id="s", turn_id="a")["context"])
    (home / ".env").write_text("AV_HOOKS_DISABLED=clock_line\n", encoding="utf-8")
    assert hook(session_id="s", turn_id="b") is None


def test_kill_switch_leaves_the_data444_reminder_alone(plugin, ctx, home, monkeypatch):
    import json

    monkeypatch.setenv("AV_HOOKS_DISABLED", "clock_line")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    path = home / "memory" / "approvals-pairing.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    path.write_text(json.dumps({"started": False, "button": "sent", "at": at}), encoding="utf-8")
    plugin.register(ctx)
    reminders(plugin).reset()
    ctx.fire("on_session_start", session_id="tg-dm-1", model="m", platform="telegram")
    assert turn(ctx) == [{"context": reminders(plugin).REMINDER}]


# ---- never the system prompt ---------------------------------------------------------------------


def test_only_ever_returns_context_and_never_touches_history_or_system_prompt(live, ctx):
    """`pre_llm_call` can only append to the user message; the hook returns `{"context": ...}` and
    leaves what it is given (the system message included) byte for byte as it was."""
    system = {"role": "system", "content": "You are Edge. Conversation started: Wednesday, October 14, 2026"}
    history = [dict(system), {"role": "user", "content": "hi"}]
    snapshot = [dict(m) for m in history]
    results = turn(ctx, session="cron_j_20261015_010000", platform="cron", text="hi", history=history)
    assert set(results[0]) == {"context"}
    assert "system" not in str(sorted(results[0]))
    assert history == snapshot
    assert "Conversation started" not in results[0]["context"]


def test_the_registered_hook_is_one_callback_hermes_sees_as_args_kwargs(live, ctx):
    assert len(ctx.hooks["pre_llm_call"]) == 1
    hook = ctx.hooks["pre_llm_call"][0]
    assert getattr(hook, "av_hook_name", None) == "pre_llm_call"
    assert not hasattr(hook, "__wrapped__")
    params = list(inspect.signature(hook).parameters.values())
    assert [p.kind for p in params] == [inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD]


# ---- idempotence --------------------------------------------------------------------------------


def test_hook_called_twice_in_one_turn_gives_the_same_bytes(live, ctx):
    first = turn(ctx, session="cron_j_20261015_010000", platform="cron", turn_id="same")
    second = turn(ctx, session="cron_j_20261015_010000", platform="cron", turn_id="same")
    assert first == second
    assert context_of(second).count("Now: ") == 1


def test_a_now_line_in_the_inbound_return_is_replaced_not_duplicated(plugin):
    mod = clock(plugin)
    stale = "Now: Wed 2026-10-14 18:30 IST (6:30 PM)"
    fresh = mod.now_line(utc("2026-10-14T19:30:00Z"), "Asia/Kolkata")
    assert mod.compose({"context": stale}, fresh) == {"context": fresh}
    assert mod.compose({"context": f"A\n\n{stale}"}, fresh) == {"context": f"A\n\n{fresh}"}
    assert mod.compose(stale, fresh) == {"context": fresh}
    assert mod.compose(f"A\n\n{stale}\n\nB", fresh) == {"context": f"A\n\nB\n\n{fresh}"}
    assert mod.compose({"context": "A", "x": 1}, fresh) == {"context": f"A\n\n{fresh}", "x": 1}
    assert mod.compose(None, fresh) == {"context": fresh}
    assert mod.compose("  ", fresh) == {"context": fresh}
    assert mod.compose(42, fresh) == {"context": fresh}


def test_wrapping_twice_still_gives_one_line(plugin):
    mod = clock(plugin)
    inner = mod.with_clock_line(lambda **_k: None, lambda: None)
    outer = mod.with_clock_line(inner, lambda: None)
    got = outer(session_id="s", turn_id="t")["context"]
    assert got.count("Now: ") == 1 and LINE.match(got), got
    # Different turns that land in the same minute get identical bytes too.
    later = outer(session_id="s", turn_id="t2")["context"]
    assert later.count("Now: ") == 1


def test_a_user_message_that_already_ends_with_the_line_gets_no_second_copy(plugin):
    mod = clock(plugin)
    line = mod.line_for({"session_id": "s", "turn_id": "t"}, None)
    assert line and LINE.match(line)
    assert mod.line_for({"session_id": "s", "turn_id": "t", "user_message": f"hi\n\n{line}\n"}, None) is None


def test_the_turn_memo_is_bounded(plugin):
    mod = clock(plugin)
    for i in range(mod.MAX_TURNS + 50):
        mod.line_for({"session_id": "s", "turn_id": str(i)}, None)
    assert len(mod._TURNS) == mod.MAX_TURNS


# ---- format and zones ---------------------------------------------------------------------------


@pytest.mark.parametrize("instant, expected", [
    # ov#347 events.test.ts vectors, byte for byte.
    ("2026-10-14T13:00:00Z", "Now: Wed 2026-10-14 18:30 IST (6:30 PM)"),
    ("2026-10-14T04:30:00Z", "Now: Wed 2026-10-14 10:00 IST (10:00 AM)"),
    ("2026-10-14T18:45:00Z", "Now: Thu 2026-10-15 00:15 IST (12:15 AM)"),
    ("2026-10-13T18:15:00Z", "Now: Tue 2026-10-13 23:45 IST (11:45 PM)"),
    ("2026-10-14T00:30:00Z", "Now: Wed 2026-10-14 06:00 IST (6:00 AM)"),
    # IST midnight: a different UTC date on either side of it.
    ("2026-10-14T18:29:00Z", "Now: Wed 2026-10-14 23:59 IST (11:59 PM)"),
    ("2026-10-14T18:30:00Z", "Now: Thu 2026-10-15 00:00 IST (12:00 AM)"),
    ("2026-10-14T23:59:00Z", "Now: Thu 2026-10-15 05:29 IST (5:29 AM)"),
    ("2026-10-15T06:30:00Z", "Now: Thu 2026-10-15 12:00 IST (12:00 PM)"),
])
def test_ist_format_matches_events_ts(plugin, instant, expected):
    assert clock(plugin).now_line(utc(instant), "Asia/Kolkata") == expected


def test_default_zone_is_asia_kolkata_not_utc(plugin, monkeypatch):
    monkeypatch.delenv("HERMES_TIMEZONE", raising=False)
    assert clock(plugin).now_line(utc("2026-10-14T18:45:00Z")) == "Now: Thu 2026-10-15 00:15 IST (12:15 AM)"
    monkeypatch.setenv("HERMES_TIMEZONE", "   ")
    assert clock(plugin).now_line(utc("2026-10-14T18:45:00Z")) == "Now: Thu 2026-10-15 00:15 IST (12:15 AM)"


@pytest.mark.parametrize("zone, instant, expected", [
    ("America/New_York", "2026-10-14T18:45:00Z", "Now: Wed 2026-10-14 14:45 EDT (2:45 PM)"),
    ("America/Los_Angeles", "2026-12-01T08:05:00Z", "Now: Tue 2026-12-01 00:05 PST (12:05 AM)"),
    ("Europe/Berlin", "2026-10-14T18:45:00Z", "Now: Wed 2026-10-14 20:45 GMT+2 (8:45 PM)"),
    ("Europe/London", "2026-12-01T09:00:00Z", "Now: Tue 2026-12-01 09:00 GMT (9:00 AM)"),
    ("Asia/Kathmandu", "2026-10-14T18:45:00Z", "Now: Thu 2026-10-15 00:30 GMT+5:45 (12:30 AM)"),
    ("America/Sao_Paulo", "2026-10-14T18:45:00Z", "Now: Wed 2026-10-14 15:45 GMT-3 (3:45 PM)"),
    ("UTC", "2026-10-14T18:45:00Z", "Now: Wed 2026-10-14 18:45 UTC (6:45 PM)"),
])
def test_another_zone_prints_its_own_label(plugin, monkeypatch, zone, instant, expected):
    monkeypatch.setenv("HERMES_TIMEZONE", zone)
    assert clock(plugin).now_line(utc(instant)) == expected


@pytest.mark.parametrize("zone", ["Mars/Olympus_Mons", "not a zone", "../../etc/passwd", "IST", "Asia/"])
def test_an_invalid_zone_is_asia_kolkata(plugin, monkeypatch, zone):
    monkeypatch.setenv("HERMES_TIMEZONE", zone)
    assert clock(plugin).now_line(utc("2026-10-14T18:45:00Z")) == "Now: Thu 2026-10-15 00:15 IST (12:15 AM)"


def test_zone_from_the_dotenv(plugin, home, monkeypatch):
    monkeypatch.delenv("HERMES_TIMEZONE", raising=False)
    (home / ".env").write_text("HERMES_TIMEZONE=America/New_York\n", encoding="utf-8")
    assert clock(plugin).now_line(utc("2026-10-14T18:45:00Z")) == "Now: Wed 2026-10-14 14:45 EDT (2:45 PM)"


def test_without_tzdata_asia_kolkata_is_fixed_plus_0530(plugin, monkeypatch):
    import zoneinfo

    def missing(_name):
        raise zoneinfo.ZoneInfoNotFoundError("no tzdata")

    monkeypatch.setattr(zoneinfo, "ZoneInfo", missing)
    monkeypatch.setenv("HERMES_TIMEZONE", "Europe/Berlin")
    assert clock(plugin).now_line(utc("2026-10-14T18:45:00Z")) == "Now: Thu 2026-10-15 00:15 IST (12:15 AM)"


def test_a_naive_instant_is_utc(plugin):
    assert clock(plugin).now_line(datetime(2026, 10, 14, 18, 45), "Asia/Kolkata") == "Now: Thu 2026-10-15 00:15 IST (12:15 AM)"


def test_the_live_line_is_this_minute_in_ist(plugin, monkeypatch):
    monkeypatch.delenv("HERMES_TIMEZONE", raising=False)
    before = clock(plugin).now_line(datetime.now(timezone.utc), "Asia/Kolkata")
    got = clock(plugin).now_line()
    after = clock(plugin).now_line(datetime.now(timezone.utc), "Asia/Kolkata")
    assert got in (before, after)


# ---- never raises -------------------------------------------------------------------------------


@pytest.mark.parametrize("error", [RuntimeError("secret text"), SystemExit(3), KeyboardInterrupt(), MemoryError()])
def test_a_failure_is_no_line_and_one_warning_without_content(plugin, ctx, monkeypatch, caplog, error):
    plugin.register(ctx)
    mod = clock(plugin)
    mod.reset()

    def boom(*_a, **_k):
        raise error

    monkeypatch.setattr(mod, "now_line", boom)
    with caplog.at_level(logging.WARNING, logger="av-events"):
        assert turn(ctx, session="cron_j_20261015_010000", platform="cron") == []
    warnings = [r for r in caplog.records if "clock_line" in r.getMessage()]
    assert len(warnings) == 1
    assert warnings[0].getMessage() == f"av-events: clock_line failed ({type(error).__name__})"
    assert "secret" not in caplog.text


def test_a_failure_keeps_the_telemetry_return(plugin, monkeypatch):
    mod = clock(plugin)
    monkeypatch.setattr(mod, "compose", lambda *_a: (_ for _ in ()).throw(ValueError("x")))
    hook = mod.with_clock_line(lambda **_k: {"context": "EARLIER"}, lambda: None)
    assert hook(session_id="s", turn_id="t") == {"context": "EARLIER"}


def test_a_collector_ref_that_raises_is_no_line(plugin):
    def bad_ref():
        raise RuntimeError("no collector")

    hook = clock(plugin).with_clock_line(lambda **_k: None, bad_ref)
    assert hook(session_id="s", turn_id="t") is None
