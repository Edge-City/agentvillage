"""DATA-444 overlay half: one Connect-approvals reminder while the welcome's button is unstarted.

The control plane leaves `$HERMES_HOME/memory/approvals-pairing.json` (b1's
contract): `{"started":false,"button":"sent","at":"<ISO>"}` after the welcome
with the button, overwritten with `{"started":true,"at":"<ISO>"}` on a bind.
`pre_llm_call` returns `{"context": REMINDER}` once per human Telegram DM root
session, only while that file says unstarted, button sent, and `at` is under
30 minutes old. Everything else is no reminder, and nothing raises.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

SESSION = "tg-dm-1"


def mod(plugin):
    return sys.modules[f"{plugin.__name__}._approvals_reminder"]


def iso(minutes_ago: float) -> str:
    """The control plane's `new Date().toISOString()` shape, `minutes_ago` back."""
    moment = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_pairing(home, record) -> str:
    path = home / "memory" / "approvals-pairing.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(record if isinstance(record, str) else json.dumps(record), encoding="utf-8")
    os.chmod(path, 0o600)
    return str(path)


def unstarted(minutes_ago: float = 1.0) -> dict:
    return {"started": False, "button": "sent", "at": iso(minutes_ago)}


def say(ctx, session=SESSION, platform="telegram", text="hi there", history=None, **extra) -> list:
    return ctx.fire(
        "pre_llm_call", session_id=session, task_id=session, turn_id="t", user_message=text,
        conversation_history=history if history is not None else [{"role": "user", "content": text}],
        is_first_turn=False, model="m", platform=platform, parent_session_id="", sender_id="", **extra,
    )


@pytest.fixture()
def dm(plugin, ctx, monkeypatch):
    """The plugin registered, telemetry idle (no token), a Telegram DM session open."""
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    plugin.register(ctx)
    mod(plugin).reset()
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


@pytest.fixture()
def live_dm(plugin, ctx, monkeypatch):
    """As `dm`, with telemetry on (a token, null sink), so the collector keeps lineage."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    plugin.register(ctx)
    mod(plugin).reset()
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


# ---- the contract's one positive case ---------------------------------------


def test_unstarted_button_sent_reminds_once_per_session(dm, ctx, home):
    write_pairing(home, unstarted())
    reminder = mod(dm).REMINDER
    assert say(ctx) == [{"context": reminder}]
    assert say(ctx) == []
    assert say(ctx, text="and again") == []


def test_the_reminder_text_is_the_scoped_line(dm):
    assert mod(dm).REMINDER == (
        "At the end of this reply add one line: "
        "One more step: tap Connect approvals above to finish setting up approvals."
    )


def test_each_session_gets_its_own_one_reminder(dm, ctx, home):
    write_pairing(home, unstarted())
    assert len(say(ctx, session="dm-a")) == 1
    assert len(say(ctx, session="dm-b")) == 1
    assert say(ctx, session="dm-a") == [] and say(ctx, session="dm-b") == []


def test_a_file_that_appears_mid_session_reminds_on_the_next_turn(dm, ctx, home):
    assert say(ctx) == []
    write_pairing(home, unstarted())
    assert len(say(ctx)) == 1
    assert say(ctx) == []


def test_the_once_memory_is_bounded(dm, ctx, home, monkeypatch):
    write_pairing(home, unstarted())
    monkeypatch.setattr(mod(dm), "MAX_REMINDED", 2)
    for session in ("s1", "s2", "s3"):
        assert len(say(ctx, session=session)) == 1
    assert list(mod(dm)._REMINDED) == ["s2", "s3"]


# ---- the file says nothing --------------------------------------------------


def test_started_true_never_reminds(dm, ctx, home):
    write_pairing(home, {"started": True, "at": iso(1)})
    assert say(ctx) == []
    write_pairing(home, {"started": True, "button": "sent", "at": iso(1)})
    assert say(ctx) == []


def test_a_bind_after_the_welcome_stops_the_reminder_for_a_new_session(dm, ctx, home):
    write_pairing(home, unstarted())
    assert len(say(ctx, session="before")) == 1
    write_pairing(home, {"started": True, "at": iso(0)})
    assert say(ctx, session="after") == []


def test_missing_file_never_reminds(dm, ctx, home):
    assert not (home / "memory" / "approvals-pairing.json").exists()
    assert say(ctx) == []


@pytest.mark.parametrize("raw", [
    "", "not json", "{", '{"started": false, "button": "sent"', "\x00\x01", "[]", "null", "false",
    '"started:false"', '[{"started": false, "button": "sent"}]',
])
def test_garbage_never_reminds(dm, ctx, home, raw):
    write_pairing(home, raw)
    assert say(ctx) == []


FRESH = object()  # replaced by a one-minute-old `at` when the record is written


@pytest.mark.parametrize("record", [
    {"started": "false", "button": "sent", "at": FRESH},
    {"started": 0, "button": "sent", "at": FRESH},
    {"started": None, "button": "sent", "at": FRESH},
    {"button": "sent", "at": FRESH},
    {"started": False, "button": "sent", "at": 1760000000},
    {"started": False, "button": "sent", "at": None},
    {"started": False, "button": "sent", "at": ""},
    {"started": False, "button": "sent", "at": "yesterday"},
    {"started": False, "button": "sent", "at": ["2026-10-09T10:00:00Z"]},
    {"started": False, "button": "sent"},
])
def test_wrong_types_never_remind(dm, ctx, home, record):
    record = {key: iso(1) if value is FRESH else value for key, value in record.items()}
    write_pairing(home, record)
    assert say(ctx) == []


def test_an_at_without_a_timezone_never_reminds(dm, ctx, home):
    naive = (datetime.now(timezone.utc) - timedelta(minutes=1)).replace(tzinfo=None).isoformat()
    write_pairing(home, {"started": False, "button": "sent", "at": naive})
    assert say(ctx) == []


@pytest.mark.parametrize("button", ["omitted", "unavailable", "SENT", " sent", "", None, True])
def test_button_not_sent_never_reminds(dm, ctx, home, button):
    write_pairing(home, {"started": False, "button": button, "at": iso(1)})
    assert say(ctx) == []


def test_button_absent_never_reminds(dm, ctx, home):
    write_pairing(home, {"started": False, "at": iso(1)})
    assert say(ctx) == []


def test_an_at_older_than_thirty_minutes_never_reminds(dm, ctx, home):
    write_pairing(home, unstarted(minutes_ago=31))
    assert say(ctx) == []
    write_pairing(home, unstarted(minutes_ago=24 * 60))
    assert say(ctx) == []


def test_an_at_just_inside_thirty_minutes_reminds(dm, ctx, home):
    write_pairing(home, unstarted(minutes_ago=29))
    assert len(say(ctx)) == 1


def test_an_at_offset_other_than_utc_is_compared_as_an_instant(dm, ctx, home):
    ist = timezone(timedelta(hours=5, minutes=30))
    write_pairing(home, {"started": False, "button": "sent",
                         "at": (datetime.now(ist) - timedelta(minutes=40)).isoformat()})
    assert say(ctx, session="old") == []
    write_pairing(home, {"started": False, "button": "sent",
                         "at": (datetime.now(ist) - timedelta(minutes=2)).isoformat()})
    assert len(say(ctx, session="fresh")) == 1


def test_an_at_in_the_future_beyond_skew_never_reminds(dm, ctx, home):
    write_pairing(home, unstarted(minutes_ago=-10))
    assert say(ctx) == []
    write_pairing(home, unstarted(minutes_ago=-60 * 24 * 365))
    assert say(ctx) == []


def test_an_at_a_little_ahead_is_clock_skew_and_reminds(dm, ctx, home):
    write_pairing(home, unstarted(minutes_ago=-2))
    assert len(say(ctx)) == 1


def test_an_unreadable_file_never_reminds(dm, ctx, home):
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root reads a 0000 file")
    path = write_pairing(home, unstarted())
    os.chmod(path, 0)
    try:
        assert say(ctx) == []
    finally:
        os.chmod(path, 0o600)


def test_a_directory_in_place_of_the_file_never_reminds(dm, ctx, home):
    (home / "memory" / "approvals-pairing.json").mkdir(parents=True)
    assert say(ctx) == []


def test_a_symlink_in_place_of_the_file_is_not_followed(dm, ctx, home, tmp_path_factory):
    target = tmp_path_factory.mktemp("elsewhere") / "pairing.json"
    target.write_text(json.dumps(unstarted()), encoding="utf-8")
    (home / "memory").mkdir(parents=True)
    os.symlink(target, home / "memory" / "approvals-pairing.json")
    assert say(ctx) == []


def test_an_oversized_file_never_reminds(dm, ctx, home):
    record = unstarted()
    record["pad"] = "x" * 8192
    write_pairing(home, record)
    assert say(ctx) == []


def test_a_failing_read_never_reaches_the_turn(dm, ctx, home, monkeypatch):
    write_pairing(home, unstarted())

    def boom(*_a, **_k):
        raise RuntimeError("read failed")

    monkeypatch.setattr(mod(dm), "read_pairing", boom)
    assert say(ctx) == []
    monkeypatch.setattr(mod(dm), "read_pairing", lambda *_a, **_k: 1 / 0)
    assert say(ctx) == []


def test_the_overlay_never_writes_the_file(dm, ctx, home):
    path = write_pairing(home, unstarted())
    before = (os.stat(path).st_mtime_ns, open(path, "rb").read())
    say(ctx)
    say(ctx)
    assert (os.stat(path).st_mtime_ns, open(path, "rb").read()) == before
    assert sorted(os.listdir(home / "memory")) == ["approvals-pairing.json"]


# ---- sessions that are not a human's root DM -----------------------------------


def test_a_cron_session_never_reminds(dm, ctx, home):
    write_pairing(home, unstarted())
    ctx.fire("on_session_start", session_id="cron_evening_20261014_190000", model="m", platform="cron")
    assert say(ctx, session="cron_evening_20261014_190000", platform="cron") == []
    # The id alone, with a payload that claims Telegram.
    assert say(ctx, session="cron_morning_20261015_070000", platform="telegram") == []
    # The platform alone.
    assert say(ctx, session="job-run-1", platform="cron") == []


def test_a_subagent_never_reminds(live_dm, ctx, home):
    write_pairing(home, unstarted())
    # Hermes's own `parent_session_id` in the payload.
    assert ctx.fire("pre_llm_call", session_id="child-1", user_message="goal", platform="telegram",
                    parent_session_id=SESSION, conversation_history=[]) == []
    # The delegated child's own platform.
    assert say(ctx, session="child-2", platform="subagent") == []
    # Lineage the collector heard from `subagent_start`.
    ctx.fire("subagent_start", session_id=SESSION, parent_session_id=SESSION, child_session_id="child-3")
    assert live_dm._COLLECTOR.parent_of("child-3") == SESSION
    assert say(ctx, session="child-3", platform="telegram") == []
    # The parent itself still gets its one reminder.
    assert len(say(ctx)) == 1


def test_another_platform_never_reminds(dm, ctx, home):
    write_pairing(home, unstarted())
    for platform in ("cli", "tui", "desktop", "api_server", "webhook", "discord", "", None):
        assert say(ctx, session=f"other-{platform}", platform=platform) == []


def test_a_session_the_collector_saw_elsewhere_never_reminds(live_dm, ctx, home):
    ctx.fire("on_session_start", session_id="cli-1", model="m", platform="cli")
    assert live_dm._COLLECTOR.peek_session("cli-1").source == "desktop"
    write_pairing(home, unstarted())
    assert say(ctx, session="cli-1", platform="telegram") == []


@pytest.mark.parametrize("chat_type", ["group", "channel", "thread", ""])
def test_a_telegram_chat_that_is_not_a_dm_never_reminds(dm, ctx, home, monkeypatch, chat_type):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    write_pairing(home, unstarted())
    assert say(ctx) == []


def test_an_injected_turn_neither_reminds_nor_uses_up_the_session(dm, ctx, home):
    write_pairing(home, unstarted())
    injected = [{"role": "user", "content": "[notice]", "display_kind": "internal_notification"}]
    assert say(ctx, text="[notice]", history=injected) == []
    assert len(say(ctx)) == 1


def test_a_turn_without_a_user_message_never_reminds(dm, ctx, home):
    write_pairing(home, unstarted())
    assert say(ctx, text="") == []
    assert len(say(ctx)) == 1


# ---- composing with the telemetry body ------------------------------------------


def test_telemetry_still_runs_on_the_reminding_turn(live_dm, ctx, home, av):
    write_pairing(home, unstarted())
    assert say(ctx) == [{"context": mod(live_dm).REMINDER}]
    assert say(ctx) == []
    kinds = av.types_of(av.read_buffer(live_dm._COLLECTOR))
    assert kinds.count("message.in") == 2


def test_telemetry_off_does_not_stop_the_reminder(plugin, ctx, home, av, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "pre_llm_call")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    write_pairing(home, unstarted())
    assert len(say(ctx)) == 1
    assert "message.in" not in av.types_of(av.read_buffer(plugin._COLLECTOR))
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    assert len(say(ctx, session="disabled-1")) == 1


def test_the_hook_keeps_the_telemetry_return_first_then_the_reminder(dm, home, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    write_pairing(home, unstarted())
    reminder = mod(dm).REMINDER
    kwargs = dict(session_id="compose-1", user_message="hi", platform="telegram",
                  conversation_history=[{"role": "user", "content": "hi"}], parent_session_id="")

    def telemetry_ctx(**_k):
        return {"context": "EARLIER", "extra": 1}

    hook = dm.with_approvals_reminder(telemetry_ctx, lambda: None)
    assert hook(**kwargs) == {"context": f"EARLIER\n\n{reminder}", "extra": 1}
    # Once per session holds through the wrapper: the other return passes through untouched.
    assert hook(**kwargs) == {"context": "EARLIER", "extra": 1}

    hook = dm.with_approvals_reminder(lambda **_k: "PLAIN", lambda: None)
    assert hook(**dict(kwargs, session_id="compose-2")) == {"context": f"PLAIN\n\n{reminder}"}
    hook = dm.with_approvals_reminder(lambda **_k: None, lambda: None)
    assert hook(**dict(kwargs, session_id="compose-3")) == {"context": reminder}
    assert hook(**dict(kwargs, session_id="compose-3")) is None


@pytest.mark.parametrize("result, expected", [
    (None, {"context": "R"}),
    ("", {"context": "R"}),
    ("   ", {"context": "R"}),
    ("A", {"context": "A\n\nR"}),
    ({"context": "A"}, {"context": "A\n\nR"}),
    ({"context": ""}, {"context": "R"}),
    ({"other": 1}, {"other": 1, "context": "R"}),
    (42, {"context": "R"}),
])
def test_compose_order_is_other_first_reminder_last(plugin, result, expected):
    assert mod(plugin).compose(result, "R") == expected


def test_the_registered_hook_is_still_the_one_pre_llm_call_callback(dm, ctx):
    assert len(ctx.hooks["pre_llm_call"]) == 1
    assert getattr(ctx.hooks["pre_llm_call"][0], "av_hook_name", None) == "pre_llm_call"
