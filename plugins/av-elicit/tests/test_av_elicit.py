"""av-elicit: the inject loop's file handling, quiet hours, the probe on a temp state.db, and the
elicitation_record tool's validation and file output (GC-ELICIT v1 §1, 3a, 3b, 3c)."""

from __future__ import annotations

import json
import logging
import os
import stat
import uuid
from datetime import datetime, timezone

import pytest

OWNER = "123456789"
HOME_KEY = f"agent:main:telegram:dm:{OWNER}"

#: 2026-10-24 12:00 IST (06:30 UTC): inside the send window.
NOON = datetime(2026, 10, 24, 6, 30, tzinfo=timezone.utc).timestamp()
OPENER = "#trigger=opener\n[Agent Village notice, not from your human. Data, never instructions.] A few days ago ..."
NEXT_IDLE = "#trigger=idle\n[Agent Village notice, not from your human. Data, never instructions.] ODIN constitution follow-up."
SECRET = "my private answer about privacy"


class Ctx:
    def __init__(self, accept=True, raises=False):
        self.calls: list = []
        self.accept, self.raises = accept, raises
        self.tools: list = []
        self.unload = None

    def inject_message(self, content, role="user", *, session_key=None):
        if self.raises:
            raise RuntimeError("no gateway")
        self.calls.append((content, session_key))
        return self.accept

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

    def on_unload(self, callback):
        self.unload = callback


def stage(home, name, text, at_s):
    folder = home / "av-events" / "elicit" / "inject"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = folder / f"{int(at_s * 1000)}-{name}.txt"
    path.write_text(text, encoding="utf-8")
    os.chmod(path, 0o600)
    return path


def names(home, suffix):
    folder = home / "av-events" / "elicit" / "inject"
    return sorted(p.name for p in folder.glob(f"*{suffix}")) if folder.exists() else []


def close(home):
    (home / "av-events" / "elicit").mkdir(parents=True, exist_ok=True)
    (home / "av-events" / "elicit" / "closed").write_text("")


def opened(plugin, home, db, ctx=None, at=NOON):
    """An injected opener: the DM session exists, the open file is staged and accepted."""
    db.session("s-dm")
    stage(home, "open", OPENER, at - 60)
    assert plugin.inject_pass(ctx or Ctx(), now=at) == "injected"


# --------------------------------------------------------------------------- pure helpers


@pytest.mark.parametrize("hour_ist,quiet", [(7, True), (8, False), (12, False), (21, False), (22, True), (23, True), (0, True), (3, True)])
def test_quiet_hours_are_22_to_08_ist(plugin, hour_ist, quiet):
    # IST is UTC+05:30: hour_ist:15 IST.
    utc_minutes = (hour_ist * 60 + 15 - 330) % (24 * 60)
    epoch = datetime(2026, 10, 24, utc_minutes // 60, utc_minutes % 60, tzinfo=timezone.utc).timestamp()
    assert plugin.in_quiet_hours(epoch) is quiet


def test_stage_names_parse(plugin):
    assert plugin.parse_stage_name("1792776425160-open.txt") == (1792776425160, "open")
    assert plugin.parse_stage_name("1792776425160-next.done") == (1792776425160, "next")
    assert plugin.parse_stage_name("open.txt") is None
    assert plugin.parse_stage_name("x-1-open.txt") is None


def test_trigger_line_is_split_off_and_validated(plugin):
    assert plugin.split_trigger(OPENER) == ("opener", OPENER.split("\n", 1)[1])
    assert plugin.split_trigger("#trigger=bogus\nbody") == (None, "body")
    assert plugin.split_trigger("no trigger line\nbody") == (None, "no trigger line\nbody")
    assert plugin.split_trigger("#trigger=idle\r\n\r\nbody") == ("idle", "body")


@pytest.mark.parametrize("name,line,want", [
    ("1792776425160-open.done", None, "opener"), ("1792776425160-next.done", "idle", "idle"), ("1792776425160-next.done", "answer", "answer"),
    ("1792776425160-next.done", None, "answer"), ("1792776425160-replan.done", None, "replan"), ("1792776425160-next.done", "human_message", "human_message"),
    ("weird.done", None, None),
])
def test_trigger_for(plugin, name, line, want):
    assert plugin.trigger_for(name, line) == want


def test_session_key_from_home_channel_or_override(plugin, monkeypatch):
    assert plugin.session_key() == HOME_KEY
    monkeypatch.setenv("AV_ELICIT_SESSION_KEY", "agent:main:telegram:dm:42")
    assert plugin.session_key() == "agent:main:telegram:dm:42"
    monkeypatch.delenv("AV_ELICIT_SESSION_KEY")
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", "")
    assert plugin.session_key() is None


def test_session_key_falls_back_to_dotenv(plugin, home, monkeypatch):
    monkeypatch.delenv("TELEGRAM_HOME_CHANNEL")
    (home / ".env").write_text("export TELEGRAM_HOME_CHANNEL='555'\n")
    assert plugin.session_key() == "agent:main:telegram:dm:555"


# --------------------------------------------------------------------------- the inject pass


def test_injects_once_strips_trigger_and_renames_done(plugin, home, db):
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 60)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "injected"
    assert ctx.calls == [(OPENER.split("\n", 1)[1], HOME_KEY)]
    assert ctx.calls[0][0].startswith(plugin.NOTICE_PREFIX)
    assert names(home, ".txt") == [] and len(names(home, ".done")) == 1
    assert plugin.inject_pass(ctx, now=NOON) == "idle"


def test_done_mtime_is_the_accept_time(plugin, home, db):
    db.session("s-dm")
    path = stage(home, "open", OPENER, NOON - 60)
    os.utime(path, (1_000_000, 1_000_000))
    plugin.inject_pass(Ctx(), now=NOON)
    done = home / "av-events" / "elicit" / "inject" / names(home, ".done")[0]
    assert done.stat().st_mtime > 1_000_000 + 3600


def test_one_injection_per_pass_oldest_first(plugin, home, db):
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 120)
    stage(home, "next", NEXT_IDLE, NOON - 60)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "injected"
    assert len(ctx.calls) == 1 and "A few days ago" in ctx.calls[0][0]
    assert len(names(home, ".txt")) == 1
    assert plugin.inject_pass(ctx, now=NOON) == "injected"
    assert len(ctx.calls) == 2 and names(home, ".txt") == []


def test_waits_for_dm_session(plugin, home, db):
    stage(home, "open", OPENER, NOON - 60)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "waiting_dm_session"
    db.session("s-other", key="agent:main:telegram:dm:999")
    assert plugin.inject_pass(ctx, now=NOON) == "waiting_dm_session"
    assert ctx.calls == [] and len(names(home, ".txt")) == 1
    db.session("s-dm")
    assert plugin.inject_pass(ctx, now=NOON) == "injected"


def test_no_state_db_waits(plugin, home):
    stage(home, "open", OPENER, NOON - 60)
    assert plugin.inject_pass(Ctx(), now=NOON) == "waiting_dm_session"


def test_no_session_key(plugin, home, db, monkeypatch):
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", "")
    stage(home, "open", OPENER, NOON - 60)
    assert plugin.inject_pass(Ctx(), now=NOON) == "no_session_key"


def test_refused_or_raising_injection_keeps_the_file(plugin, home, db):
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 60)
    assert plugin.inject_pass(Ctx(accept=False), now=NOON) == "inject_refused"
    assert plugin.inject_pass(Ctx(raises=True), now=NOON) == "inject_error"
    assert plugin.inject_pass(object(), now=NOON) == "inject_no_ctx"
    assert len(names(home, ".txt")) == 1 and names(home, ".done") == []


def test_quiet_hours_hold(plugin, home, db):
    db.session("s-dm")
    night = NOON + 11 * 3600  # 23:00 IST
    stage(home, "open", OPENER, night - 60)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=night) == "held_quiet_hours"
    assert ctx.calls == [] and len(names(home, ".txt")) == 1
    morning = NOON - 3 * 3600 - 30 * 60 + 24 * 3600  # 08:30 IST next day
    assert plugin.inject_pass(ctx, now=morning) == "injected"


def test_age_cap_skips_old_files(plugin, home, db):
    db.session("s-dm")
    stage(home, "next", NEXT_IDLE, NOON - 25 * 3600)
    stage(home, "open", OPENER, NOON - 60)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "injected"
    assert len(names(home, ".skipped")) == 1 and names(home, ".skipped")[0].endswith("-next.skipped")
    assert len(ctx.calls) == 1


def test_age_cap_applies_in_quiet_hours(plugin, home, db):
    night = NOON + 11 * 3600
    stage(home, "open", OPENER, night - 25 * 3600)
    assert plugin.inject_pass(Ctx(), now=night) == "skipped_aged"
    assert len(names(home, ".skipped")) == 1


def ballot_page(home, touched=NOON - 60):
    folder = home / "av-events" / "godconst"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "page-open").write_text("")
    os.utime(folder / "page-open", (touched, touched))
    return folder / "page-open"


def test_stale_ballot_page_marker_no_longer_holds(plugin, home, db, caplog):
    caplog.set_level(logging.INFO, logger="av-elicit")
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 60)
    marker = ballot_page(home, touched=NOON - 12 * 3600 + 60)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "held_ballot_page"  # 11 h 59 m old: still holds
    os.utime(marker, (NOON - 12 * 3600 - 60, NOON - 12 * 3600 - 60))
    assert plugin.ballot_page_open(now=NOON) is False
    assert plugin.ballot_page_open(now=NOON) is False
    assert plugin.inject_pass(ctx, now=NOON) == "injected" and len(ctx.calls) == 1
    stale = [r for r in caplog.records if "outcome=stale_ballot_page" in r.getMessage()]
    assert len(stale) == 1
    os.utime(marker, (NOON - 30, NOON - 30))  # av-godconst sent a new page: holds again
    stage(home, "next", NEXT_IDLE, NOON)
    assert plugin.inject_pass(ctx, now=NOON) == "held_ballot_page"


def test_ballot_page_open_holds_injection(plugin, home, db):
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 60)
    marker = ballot_page(home)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "held_ballot_page"
    assert plugin.inject_pass(ctx, now=NOON + 3600) == "held_ballot_page"
    assert ctx.calls == [] and len(names(home, ".txt")) == 1 and names(home, ".skipped") == []
    marker.unlink()
    assert plugin.inject_pass(ctx, now=NOON + 3600) == "injected"
    assert len(ctx.calls) == 1


def test_ballot_page_hold_still_honours_the_age_cap(plugin, home, db):
    db.session("s-dm")
    stage(home, "next", NEXT_IDLE, NOON - 25 * 3600)
    stage(home, "open", OPENER, NOON - 60)
    ballot_page(home)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "held_ballot_page"
    assert [n.split("-", 1)[1] for n in names(home, ".skipped")] == ["next.skipped"]
    assert [n.split("-", 1)[1] for n in names(home, ".txt")] == ["open.txt"] and ctx.calls == []


def test_closed_marker_skips_everything_pending(plugin, home, db):
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 120)
    stage(home, "next", NEXT_IDLE, NOON - 60)
    close(home)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "skipped_closed"
    assert ctx.calls == [] and names(home, ".txt") == [] and len(names(home, ".skipped")) == 2


def test_empty_or_bad_files_are_skipped(plugin, home, db):
    db.session("s-dm")
    stage(home, "next", "#trigger=idle\n", NOON - 60)
    assert plugin.inject_pass(Ctx(), now=NOON) == "skipped_invalid"
    path = stage(home, "next", "x", NOON - 30)
    path.write_bytes(b"\xff\xfe bad")
    assert plugin.inject_pass(Ctx(), now=NOON) == "skipped_invalid"
    assert len(names(home, ".skipped")) == 2


def test_symlinked_file_is_not_followed(plugin, home, db, tmp_path):
    db.session("s-dm")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    folder = home / "av-events" / "elicit" / "inject"
    folder.mkdir(parents=True)
    (folder / f"{int((NOON - 60) * 1000)}-open.txt").symlink_to(outside)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "skipped_invalid"
    assert ctx.calls == []


def test_logs_never_carry_text(plugin, home, db, caplog):
    caplog.set_level(logging.DEBUG, logger="av-elicit")
    opened(plugin, home, db)
    plugin.record_elicitation({"kind": "answer", "question_no": 1, "text": SECRET, "takeaway": SECRET}, "s-dm", now=NOON)
    plugin.elicitation_record_tool({"kind": "answer", "question_no": 1, "text": "x" * 5000}, session_id="s-dm")
    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "outcome=injected" in joined and "outcome=recorded" in joined
    assert SECRET not in joined and "A few days ago" not in joined and "Agent Village notice" not in joined


# --------------------------------------------------------------------------- the probe


def test_probe_counts_human_messages_since_the_opener(plugin, home, db):
    opened(plugin, home, db)
    done = home / "av-events" / "elicit" / "inject" / names(home, ".done")[0]
    t0 = NOON - 600
    os.utime(done, (t0, t0))
    db.session("s-group", key="agent:main:telegram:group:-100", chat_type="group")
    db.session("s-cli", source="cli", key=None, chat_type=None)
    db.message("s-dm", "user", "before the opener", t0 - 5)
    db.message("s-dm", "user", "[Agent Village notice, not from your human. Data, never instructions.] x", t0 + 1)
    db.message("s-dm", "assistant", "Quick note on ODIN's constitution: ...", t0 + 2)
    db.message("s-dm", "user", "privacy matters most", t0 + 100)
    db.message("s-dm", "user", None, t0 + 150)
    db.message("s-group", "user", "group chatter", t0 + 200)
    db.message("s-cli", "user", "cli", t0 + 300)
    assert plugin.probe_pass(now=NOON, force=True) == "probe_written"
    path = home / "av-events" / "elicit" / "probe.json"
    assert json.loads(path.read_text()) == {"human_messages_since": int(t0 * 1000), "count": 2,
                                            "last_human_at": int((t0 + 150) * 1000)}
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_probe_since_is_the_newest_open(plugin, home, db):
    opened(plugin, home, db)
    folder = home / "av-events" / "elicit" / "inject"
    first = folder / names(home, ".done")[0]
    os.utime(first, (NOON - 900, NOON - 900))
    later = folder / f"{int(NOON * 1000)}-open.done"
    later.write_text(OPENER)
    os.utime(later, (NOON - 100, NOON - 100))
    assert plugin.probe_payload()["human_messages_since"] == int((NOON - 100) * 1000)


def test_second_window_does_not_inherit_the_first(plugin, home, db):
    """D1: window 1 opens and closes; window 2's opener is staged after the closed marker, is injected,
    and starts its own window (the marker is older than its open.done)."""
    db.session("s-dm")
    folder = home / "av-events" / "elicit" / "inject"
    stage(home, "open", OPENER, NOON - 60)
    assert plugin.inject_pass(Ctx(), now=NOON) == "injected"
    first = folder / names(home, ".done")[0]
    os.utime(first, (NOON - 7200, NOON - 7200))
    db.message("s-dm", "user", "window one reply", NOON - 7000)
    close(home)
    os.utime(home / "av-events" / "elicit" / "closed", (NOON - 3600, NOON - 3600))
    assert not plugin.window_open() and plugin.probe_payload() is None
    second = stage(home, "open", OPENER, NOON)
    os.utime(second, (NOON - 1800, NOON - 1800))
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON + 10) == "injected" and len(ctx.calls) == 1
    newest = folder / [n for n in names(home, ".done") if n != first.name][0]
    os.utime(newest, (NOON - 1700, NOON - 1700))
    assert plugin.window_open()
    db.message("s-dm", "user", "window two reply", NOON - 1000)
    assert plugin.probe_payload() == {"human_messages_since": int((NOON - 1700) * 1000), "count": 1,
                                      "last_human_at": int((NOON - 1000) * 1000)}


def test_closed_marker_newer_than_the_newest_open_closes(plugin, home, db):
    opened(plugin, home, db)
    done = home / "av-events" / "elicit" / "inject" / names(home, ".done")[0]
    os.utime(done, (NOON - 600, NOON - 600))
    close(home)
    marker = home / "av-events" / "elicit" / "closed"
    os.utime(marker, (NOON - 600, NOON - 600))  # same instant: closed
    assert not plugin.window_open(now=NOON)
    # M1: once seen, the closure is kept in window.json; re-touching or deleting the marker never reopens.
    os.utime(marker, (NOON - 601, NOON - 601))
    assert not plugin.window_open(now=NOON)
    marker.unlink()
    assert not plugin.window_open(now=NOON)
    state = json.loads((home / "av-events" / "elicit" / "window.json").read_text())
    assert state["closed_at_ms"] == int((NOON - 600) * 1000) and state["close_reason"] == "unknown"


def test_closed_marker_skips_only_files_staged_before_it(plugin, home, db):
    db.session("s-dm")
    old = stage(home, "next", NEXT_IDLE, NOON - 120)
    os.utime(old, (NOON - 120, NOON - 120))
    close(home)
    os.utime(home / "av-events" / "elicit" / "closed", (NOON - 100, NOON - 100))
    new = stage(home, "open", OPENER, NOON - 60)
    os.utime(new, (NOON - 60, NOON - 60))
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "injected"
    assert [n.split("-", 1)[1] for n in names(home, ".skipped")] == ["next.skipped"]
    assert len(ctx.calls) == 1 and "A few days ago" in ctx.calls[0][0]


def test_probe_counts_only_the_home_dm(plugin, home, db):
    """D2: other DMs, groups and other platforms never count; a rotated home DM session (same key) does."""
    opened(plugin, home, db)
    done = home / "av-events" / "elicit" / "inject" / names(home, ".done")[0]
    t0 = NOON - 600
    os.utime(done, (t0, t0))
    db.session("s-dm-rotated")
    db.session("s-otherdm", key="agent:main:telegram:dm:999")
    db.session("s-group", key="agent:main:telegram:group:-100", chat_type="group")
    db.session("s-homekey-group", key=HOME_KEY, chat_type="group")
    db.session("s-discord", source="discord", key=HOME_KEY)
    db.message("s-dm", "user", "home", t0 + 10)
    db.message("s-dm-rotated", "user", "home after /new", t0 + 20)
    for sid in ("s-otherdm", "s-group", "s-homekey-group", "s-discord"):
        db.message(sid, "user", "not the resident's DM", t0 + 30)
    assert plugin.probe_payload() == {"human_messages_since": int(t0 * 1000), "count": 2,
                                      "last_human_at": int((t0 + 20) * 1000)}


def test_probe_needs_a_home_key(plugin, home, db, monkeypatch):
    opened(plugin, home, db)
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", "")
    assert plugin.probe_payload() is None


def test_probe_none_without_human_messages(plugin, home, db):
    opened(plugin, home, db)
    payload = plugin.probe_payload()
    assert payload["count"] == 0 and payload["last_human_at"] is None


def test_probe_cadence_and_gates(plugin, home, db):
    assert plugin.probe_pass(now=NOON, force=True) == "probe_no_files"
    stage(home, "open", OPENER, NOON - 60)
    assert plugin.probe_pass(now=NOON, force=True) == "probe_no_window"  # staged, not yet injected
    db.session("s-dm")
    plugin.inject_pass(Ctx(), now=NOON)
    assert plugin.probe_pass(now=NOON) == "probe_written"
    assert plugin.probe_pass(now=NOON + 30) == "probe_not_due"
    assert plugin.probe_pass(now=NOON + 61) == "probe_written"
    close(home)
    assert plugin.probe_pass(now=NOON + 200) == "probe_no_window"


def test_probe_unreadable_db_writes_nothing(plugin, home, db):
    opened(plugin, home, db)
    (home / "state.db").unlink()
    assert plugin.probe_pass(now=NOON, force=True) == "probe_no_window"
    assert not (home / "av-events" / "elicit" / "probe.json").exists()


def test_run_once_never_raises(plugin, home, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("x")

    monkeypatch.setattr(plugin, "inject_pass", boom)
    monkeypatch.setattr(plugin, "probe_pass", boom)
    assert plugin.run_once() == ("pass_failed", "probe_failed")


# --------------------------------------------------------------------------- the tool: validation


@pytest.mark.parametrize("args,code", [
    (None, "bad_args"),
    ({"question_no": 1, "text": "q"}, "bad_kind"),
    ({"kind": "note", "question_no": 1, "text": "q"}, "bad_kind"),
    ({"kind": "question", "text": "q"}, "bad_question_no"),
    ({"kind": "question", "question_no": 0, "text": "q"}, "bad_question_no"),
    ({"kind": "question", "question_no": True, "text": "q"}, "bad_question_no"),
    ({"kind": "question", "question_no": "1", "text": "q"}, "bad_question_no"),
    ({"kind": "question", "question_no": 1.5, "text": "q"}, "bad_question_no"),
    ({"kind": "question", "question_no": 1}, "missing_text"),
    ({"kind": "answer", "question_no": 1, "text": "   "}, "missing_text"),
    ({"kind": "question", "question_no": 1, "text": "q", "category": "Privacy and consent"}, "bad_category"),
    ({"kind": "question", "question_no": 1, "text": "q", "form": "multiple_choice"}, "bad_form"),
    ({"kind": "question", "question_no": 1, "text": "x" * 4001}, "long_text"),
    ({"kind": "answer", "question_no": 1, "text": "a", "statement_ids": "s004"}, "bad_statement_ids"),
    ({"kind": "answer", "question_no": 1, "text": "a", "statement_ids": ["s 004"]}, "bad_statement_ids"),
    ({"kind": "answer", "question_no": 1, "text": "a", "statement_ids": [4]}, "bad_statement_ids"),
])
def test_validation_refuses(plugin, args, code):
    with pytest.raises(plugin.Refused) as info:
        plugin.validate_record(args)
    assert info.value.code == code


def test_validation_shapes_fields_by_kind(plugin):
    q = plugin.validate_record({"kind": "question", "question_no": 2.0, "text": " q? ", "category": "privacy_and_consent",
                                "takeaway": "ignored", "statement_ids": ["s001"]})
    assert q == {"kind": "question", "question_no": 2, "category": "privacy_and_consent", "form": "other",
                 "text": "q?", "takeaway": None, "statement_ids": []}
    a = plugin.validate_record({"kind": "answer", "question_no": 2, "text": "a", "form": "open", "takeaway": "t",
                                "statement_ids": ["s004", "s012", "s004"]})
    assert a["form"] is None and a["takeaway"] == "t" and a["statement_ids"] == ["s004", "s012"]
    s = plugin.validate_record({"kind": "stop", "question_no": 3})
    assert s["text"] is None and s["statement_ids"] == [] and s["form"] is None


# --------------------------------------------------------------------------- the tool: gates and output


def records(home):
    folder = home / "av-events" / "elicit" / "records"
    return sorted(folder.glob("*.json")) if folder.exists() else []


def test_question_record_file(plugin, home, db):
    opened(plugin, home, db)
    line = plugin.elicitation_record_tool({"kind": "question", "question_no": 1, "category": "privacy_and_consent",
                                           "form": "open", "text": "What matters most?"}, session_id="s-dm")
    assert line == "Recorded question 1 (privacy_and_consent)."
    [path] = records(home)
    body = json.loads(path.read_text())
    assert set(body) == {"record_id", "window_ms", "kind", "question_no", "agent_question_no", "category", "form", "trigger",
                         "text", "takeaway", "statement_ids", "late", "text_long", "recorded_at"}
    assert body["late"] is False and body["text_long"] is False
    assert body["trigger"] == "opener" and body["form"] == "open" and body["text"] == "What matters most?"
    assert uuid.UUID(body["record_id"]).version == 4
    ms, rid = path.stem.split("-", 1)
    assert rid == body["record_id"] and ms.isdigit()
    assert body["recorded_at"].endswith("Z")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert [p.name for p in path.parent.iterdir()] == [path.name]  # no temp file left


def test_trigger_follows_the_last_injected_file_never_the_agent(plugin, home, db):
    opened(plugin, home, db)
    stage(home, "next", NEXT_IDLE, NOON)
    assert plugin.inject_pass(Ctx(), now=NOON + 5) == "injected"
    folder = home / "av-events" / "elicit" / "inject"
    for name in names(home, ".done"):  # make the order unambiguous
        os.utime(folder / name, (NOON + (100 if "-next" in name else 0),) * 2)
    plugin.elicitation_record_tool({"kind": "question", "question_no": 2, "text": "q", "trigger": "opener"},
                                   session_id="s-dm")
    assert json.loads(records(home)[-1].read_text())["trigger"] == "idle"


def q(plugin, n, now):
    plugin.record_elicitation({"kind": "question", "question_no": n, "text": f"q{n}"}, "s-dm", now=now)
    return json.loads(records(home_of(plugin))[-1].read_text())


def a(plugin, n, now):
    plugin.record_elicitation({"kind": "answer", "question_no": n, "text": f"a{n}"}, "s-dm", now=now)


def home_of(plugin):
    from pathlib import Path
    return Path(plugin.hermes_home())


def opened_at(plugin, home, db, accepted):
    opened(plugin, home, db)
    done = home / "av-events" / "elicit" / "inject" / names(home, ".done")[0]
    os.utime(done, (accepted, accepted))


def test_v3_follow_up_question_in_the_answer_reply_is_answer(plugin, home, db):
    """3c v3: question 1 is opener; questions asked in the reply that records an answer, with no file
    injected since, are answer."""
    opened_at(plugin, home, db, NOON - 600)
    assert q(plugin, 1, NOON - 500)["trigger"] == "opener"
    a(plugin, 1, NOON - 400)
    assert q(plugin, 2, NOON - 399)["trigger"] == "answer"
    a(plugin, 2, NOON - 300)
    assert q(plugin, 3, NOON - 299)["trigger"] == "answer"
    answers = [json.loads(p.read_text()) for p in records(home) if json.loads(p.read_text())["kind"] == "answer"]
    assert all(r["trigger"] is None for r in answers)


def test_v3_second_question_without_an_answer_keeps_the_file_trigger(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    assert q(plugin, 1, NOON - 500)["trigger"] == "opener"
    assert q(plugin, 2, NOON - 400)["trigger"] == "opener"


def test_v3_a_file_accepted_after_the_answer_wins(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    q(plugin, 1, NOON - 500)
    a(plugin, 1, NOON - 400)
    stage(home, "next", NEXT_IDLE, NOON - 300)
    assert plugin.inject_pass(Ctx(), now=NOON - 290) == "injected"
    nxt = home / "av-events" / "elicit" / "inject" / [n for n in names(home, ".done") if "-next" in n][0]
    os.utime(nxt, (NOON - 290, NOON - 290))
    assert q(plugin, 2, NOON - 280)["trigger"] == "idle"
    a(plugin, 2, NOON - 200)
    assert q(plugin, 3, NOON - 199)["trigger"] == "answer"


def test_v3_an_answer_from_a_previous_window_does_not_carry_over(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    (home / "av-events" / "elicit" / "last_answer.json").write_text(json.dumps({"at_ms": int((NOON - 7200) * 1000)}))
    os.chmod(home / "av-events" / "elicit" / "last_answer.json", 0o600)
    assert q(plugin, 1, NOON - 500)["trigger"] == "opener"


def test_v3_unreadable_last_answer_falls_back_to_the_file(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    (home / "av-events" / "elicit").mkdir(parents=True, exist_ok=True)
    (home / "av-events" / "elicit" / "last_answer.json").write_text("not json")
    assert q(plugin, 1, NOON - 500)["trigger"] == "opener"
    a(plugin, 1, NOON - 400)
    body = json.loads((home / "av-events" / "elicit" / "last_answer.json").read_text())
    assert body == {"at_ms": int((NOON - 400) * 1000)}
    assert stat.S_IMODE((home / "av-events" / "elicit" / "last_answer.json").stat().st_mode) == 0o600


def rec(plugin, home, kind, n, now, **extra):
    args = {"kind": kind, "question_no": n, **({"text": f"{kind} {n}"} if kind != "stop" else {}), **extra}
    plugin.record_elicitation(args, "s-dm", now=now)
    return json.loads(records(home)[-1].read_text())


def test_agent_number_8_still_stores_1(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    body = rec(plugin, home, "question", 8, NOON - 500)
    assert body["question_no"] == 1 and body["agent_question_no"] == 8 and body["trigger"] == "opener"
    body = rec(plugin, home, "answer", 8, NOON - 400)
    assert body["question_no"] == 1 and body["agent_question_no"] == 8
    body = rec(plugin, home, "question", 9, NOON - 399)
    assert body["question_no"] == 2 and body["agent_question_no"] == 9 and body["trigger"] == "answer"
    state = home / "av-events" / "elicit" / "window.json"
    assert json.loads(state.read_text())["questions"] == 2
    assert stat.S_IMODE(state.stat().st_mode) == 0o600


def test_answer_to_an_earlier_question_of_the_window(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    for n, t in ((1, 500), (2, 450), (3, 400)):
        rec(plugin, home, "question", n + 10, NOON - t)
    assert rec(plugin, home, "answer", 2, NOON - 300)["question_no"] == 2   # names question 2 of this window
    assert rec(plugin, home, "answer", 13, NOON - 290)["question_no"] == 3  # not a number of this window: latest
    assert rec(plugin, home, "answer", 4, NOON - 280)["question_no"] == 3   # not asked yet: latest
    assert rec(plugin, home, "stop", 1, NOON - 270)["question_no"] == 1
    assert rec(plugin, home, "question", 1, NOON - 260)["question_no"] == 4


def test_answer_before_any_question_is_1(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    assert rec(plugin, home, "answer", 5, NOON - 500)["question_no"] == 1
    assert rec(plugin, home, "question", 5, NOON - 400)["question_no"] == 1


def test_second_window_starts_at_1(plugin, home, db):
    opened_at(plugin, home, db, NOON - 7200)
    folder = home / "av-events" / "elicit" / "inject"
    first = names(home, ".done")[0]
    rec(plugin, home, "question", 1, NOON - 7100)
    rec(plugin, home, "question", 2, NOON - 7000)
    close(home)
    os.utime(home / "av-events" / "elicit" / "closed", (NOON - 3600, NOON - 3600))
    second = stage(home, "open", OPENER, NOON)
    os.utime(second, (NOON - 1800, NOON - 1800))
    assert plugin.inject_pass(Ctx(), now=NOON + 10) == "injected"
    newest = folder / [n for n in names(home, ".done") if n != first][0]
    os.utime(newest, (NOON - 1700, NOON - 1700))
    body = rec(plugin, home, "question", 3, NOON - 1600)
    assert body["question_no"] == 1 and body["agent_question_no"] == 3 and body["trigger"] == "opener"


def test_unreadable_window_state_counts_from_0(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    (home / "av-events" / "elicit" / "window.json").write_text("{bad")
    assert plugin.window_questions(int((NOON - 600) * 1000)) == 0
    assert rec(plugin, home, "question", 4, NOON - 500)["question_no"] == 1


def closed_at(home, when):
    close(home)
    os.utime(home / "av-events" / "elicit" / "closed", (when, when))


def test_late_answer_and_stop_go_to_the_closed_window(plugin, home, db):
    opened_at(plugin, home, db, NOON - 7200)
    rec(plugin, home, "question", 1, NOON - 7100)
    rec(plugin, home, "question", 2, NOON - 7000)
    closed_at(home, NOON - 3600)
    body = rec(plugin, home, "answer", 1, NOON)
    assert body["late"] is True and body["question_no"] == 1 and body["trigger"] is None
    body = rec(plugin, home, "stop", 9, NOON + 60)
    assert body["late"] is True and body["question_no"] == 2
    out = plugin.elicitation_record_tool({"kind": "question", "question_no": 3, "text": "q"}, session_id="s-dm")
    assert "No ODIN" in json.loads(out)["error"]


def test_late_answers_stop_after_24_hours(plugin, home, db):
    opened_at(plugin, home, db, NOON - 7200)
    rec(plugin, home, "question", 1, NOON - 7100)
    closed_at(home, NOON - 3600)
    assert rec(plugin, home, "answer", 1, NOON - 3600 + 24 * 3600)["late"] is True  # exactly 24 h: kept
    with pytest.raises(plugin.Refused) as info:
        plugin.record_elicitation({"kind": "answer", "question_no": 1, "text": "a"}, "s-dm", now=NOON - 3600 + 24 * 3600 + 1)
    assert info.value.code == "no_window"


def test_late_needs_a_window_that_was_opened(plugin, home, db):
    db.session("s-dm")
    closed_at(home, NOON - 60)
    with pytest.raises(plugin.Refused):
        plugin.record_elicitation({"kind": "stop", "question_no": 1}, "s-dm", now=NOON)


def test_late_answers_still_need_the_dm(plugin, home, db):
    opened_at(plugin, home, db, NOON - 7200)
    closed_at(home, NOON - 3600)
    db.session("s-group", key="agent:main:telegram:group:-100", chat_type="group")
    with pytest.raises(plugin.Refused) as info:
        plugin.record_elicitation({"kind": "answer", "question_no": 1, "text": "a"}, "s-group", now=NOON)
    assert info.value.code == "not_dm"


def test_long_question_text_is_kept_and_flagged(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    sixty = " ".join(["word"] * 60)
    body = rec(plugin, home, "question", 1, NOON - 500, text=sixty)
    assert body["text_long"] is False and body["text"] == sixty
    long = " ".join(["word"] * 61) + "?"
    body = rec(plugin, home, "question", 2, NOON - 400, text=long)
    assert body["text_long"] is True and body["text"] == long
    body = rec(plugin, home, "answer", 2, NOON - 300, text=long)
    assert body["text_long"] is False  # only questions are checked


def test_description_says_question_sentence_only(plugin):
    assert "question sentence only" in plugin.TOOL_DESCRIPTION
    assert "question sentence" in plugin.TOOL_SCHEMA["parameters"]["properties"]["text"]["description"]


def test_answer_and_stop_records(plugin, home, db):
    opened(plugin, home, db)
    line = plugin.elicitation_record_tool({"kind": "answer", "question_no": 1, "category": "privacy_and_consent",
                                           "text": SECRET, "takeaway": "values consent", "statement_ids": ["s004"]},
                                          session_id="s-dm")
    assert "informing 1 statement(s)" in line
    assert plugin.elicitation_record_tool({"kind": "stop", "question_no": 2}, session_id="s-dm").startswith("Recorded stop")
    bodies = [json.loads(p.read_text()) for p in records(home)]
    kinds = sorted(b["kind"] for b in bodies)
    assert kinds == ["answer", "stop"]
    answer = next(b for b in bodies if b["kind"] == "answer")
    assert answer["trigger"] is None and answer["statement_ids"] == ["s004"] and answer["text"] == SECRET


def test_refused_outside_the_telegram_dm(plugin, home, db):
    opened(plugin, home, db)
    db.session("s-group", key="agent:main:telegram:group:-100", chat_type="group")
    db.session("s-cli", source="cli", key=None, chat_type=None)
    db.session("s-otherdm", key="agent:main:telegram:dm:999")
    args = {"kind": "question", "question_no": 1, "text": "q"}
    for sid in ("s-group", "s-cli", "s-otherdm", "s-unknown", None):
        out = plugin.elicitation_record_tool(args, session_id=sid)
        assert "Telegram DM" in json.loads(out)["error"]
    assert plugin.elicitation_record_tool(args).startswith("{")
    assert records(home) == []


def test_refused_without_an_open_window(plugin, home, db):
    db.session("s-dm")
    args = {"kind": "question", "question_no": 1, "text": "q"}
    assert "No ODIN" in json.loads(plugin.elicitation_record_tool(args, session_id="s-dm"))["error"]
    stage(home, "open", OPENER, NOON - 60)  # staged, not injected: still no window
    assert "No ODIN" in json.loads(plugin.elicitation_record_tool(args, session_id="s-dm"))["error"]
    plugin.inject_pass(Ctx(), now=NOON)
    assert plugin.elicitation_record_tool(args, session_id="s-dm").startswith("Recorded")
    close(home)
    assert "No ODIN" in json.loads(plugin.elicitation_record_tool(args, session_id="s-dm"))["error"]
    assert len(records(home)) == 1


def test_validation_error_is_a_string_not_a_raise(plugin, home, db):
    opened(plugin, home, db)
    out = plugin.elicitation_record_tool({"kind": "question", "question_no": 1}, session_id="s-dm")
    assert json.loads(out) == {"error": "text is required for kind question."}


def test_internal_error_is_a_string(plugin, home, db, monkeypatch):
    opened(plugin, home, db)

    def boom(*_a, **_k):
        raise RuntimeError("disk")

    monkeypatch.setattr(plugin, "build_record", boom)
    out = plugin.elicitation_record_tool({"kind": "stop", "question_no": 1}, session_id="s-dm")
    assert "error" in json.loads(out)


def test_records_cap(plugin, home, db, monkeypatch):
    opened(plugin, home, db)
    monkeypatch.setattr(plugin, "RECORDS_MAX", 2)
    args = {"kind": "stop", "question_no": 1}
    assert plugin.elicitation_record_tool(args, session_id="s-dm").startswith("Recorded")
    assert plugin.elicitation_record_tool(args, session_id="s-dm").startswith("Recorded")
    assert "error" in json.loads(plugin.elicitation_record_tool(args, session_id="s-dm"))


# --------------------------------------------------------------------------- registration


def test_register_tool_schema_and_unload(plugin, home, monkeypatch):
    monkeypatch.setattr(plugin, "_loop", lambda stop: None)
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    ctx = Ctx()
    plugin.register(ctx)
    plugin.register(ctx)  # idempotent
    assert len(ctx.tools) == 1
    tool = ctx.tools[0]
    assert tool["name"] == "elicitation_record" and tool["toolset"] == "av-elicit"
    params = tool["schema"]["parameters"]
    assert params["required"] == ["kind", "question_no"]
    assert set(params["properties"]) == {"kind", "question_no", "category", "form", "text", "takeaway", "statement_ids"}
    assert "trigger" not in params["properties"]
    assert params["properties"]["form"]["enum"] == ["open", "trade_off", "direct_rating", "other"]
    assert (home / "av-events" / "elicit" / "inject").is_dir()
    assert callable(ctx.unload)
    ctx.unload()
    assert plugin._STOP.is_set()


def test_register_without_register_tool_still_runs(plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_loop", lambda stop: None)

    class Bare:
        pass

    plugin.register(Bare())
    assert plugin._REGISTERED


def test_register_tool_failure_is_contained(plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_loop", lambda stop: None)

    class Bad(Ctx):
        def register_tool(self, **kwargs):
            raise RuntimeError("refused")

    plugin.register(Bad())
    assert plugin._REGISTERED


def test_manifest_matches(plugin):
    import yaml

    with open(os.path.join(os.path.dirname(plugin.__file__), "plugin.yaml"), encoding="utf-8") as handle:
        manifest = yaml.safe_load(handle)
    assert manifest["name"] == "av-elicit" and manifest["kind"] == "backend"
    assert manifest["provides_tools"] == ["elicitation_record"]
    assert "allow_gateway_injection" in manifest["description"]


# --------------------------------------------------------------------------- review fixes (H1, H2, M1-M5, L1-L3)


def test_h1_loop_only_in_the_gateway(plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_loop", lambda stop: None)
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.setattr(plugin.sys, "argv", ["hermes", "chat"])
    assert plugin.start_loop() is False
    assert plugin.gateway_process(["hermes", "gateway", "run"]) and plugin.gateway_process(["hermes", "gateway"])
    assert not plugin.gateway_process(["hermes", "gateway", "status"])
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    assert plugin.start_loop() is True


def test_l1_each_registration_gets_its_own_stop_event(plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_loop", lambda stop: None)
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    plugin.start_loop()
    first = plugin._STOP
    plugin.start_loop()
    assert first.is_set() and plugin._STOP is not first and not plugin._STOP.is_set()


# --------------------------------------------------------------------------- gateway start|restart (lazy loop)


def _counting_loop(plugin, monkeypatch):
    """Replace the loop body with one that records each start and runs until stopped."""
    import threading

    starts = []
    lock = threading.Lock()

    def loop(stop):
        with lock:
            starts.append(stop)
        stop.wait(5)

    monkeypatch.setattr(plugin, "_loop", loop)
    monkeypatch.setattr(plugin, "MARKER_POLL_S", 0.01)
    return starts


def _wait_for(predicate, timeout=2.0):
    import time as _time

    deadline = _time.monotonic() + timeout
    while _time.monotonic() < deadline:
        if predicate():
            return True
        _time.sleep(0.01)
    return bool(predicate())


def test_gw_argv_kinds(plugin):
    assert plugin.gateway_argv(["hermes", "gateway", "run"]) and plugin.gateway_argv(["hermes", "gateway"])
    assert plugin.gateway_argv(["python", "-m", "hermes_cli.main", "gateway", "run"])
    for sub in ("start", "restart"):
        argv = ["hermes", "gateway", sub]
        assert not plugin.gateway_argv(argv) and plugin.gateway_handoff_argv(argv)
    for argv in (["hermes", "gateway", "status"], ["hermes", "gateway", "stop"], ["hermes", "chat"], ["hermes"]):
        assert not plugin.gateway_argv(argv) and not plugin.gateway_handoff_argv(argv)


def test_gw_restart_starts_the_loop_once_the_marker_is_set(plugin, home, monkeypatch):
    """Live rig: a foreground `hermes gateway restart` registers plugins before gateway/run.py sets
    _HERMES_GATEWAY=1. The loop starts when the marker appears, exactly once."""
    starts = _counting_loop(plugin, monkeypatch)
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.setattr(plugin.sys, "argv", ["hermes", "gateway", "restart"])
    plugin.register(Ctx())
    assert plugin._REGISTERED and plugin._THREAD is None and plugin._WAITER.is_alive()
    assert not _wait_for(lambda: starts, timeout=0.1)
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    assert _wait_for(lambda: len(starts) == 1)
    assert _wait_for(lambda: not plugin._WAITER.is_alive())
    assert not _wait_for(lambda: len(starts) > 1, timeout=0.1)
    assert plugin.start_loop() is True  # a reload with the marker set replaces the loop, never adds one
    assert _wait_for(lambda: len(starts) == 2) and starts[0].is_set() and not starts[1].is_set()
    plugin._STOP.set()


def test_gw_handoff_without_the_marker_never_runs_a_loop(plugin, home, monkeypatch):
    """`gateway start`, or a `restart` that only asks the service manager, exits without the marker."""
    starts = _counting_loop(plugin, monkeypatch)
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    for sub in ("start", "restart"):
        monkeypatch.setattr(plugin.sys, "argv", ["hermes", "gateway", sub])
        assert plugin.start_loop() is False
    assert not _wait_for(lambda: starts, timeout=0.2)
    assert plugin._THREAD is None
    waiter = plugin._WAITER
    plugin._on_unload()  # unload stops the waiter: a marker set afterwards starts nothing
    assert _wait_for(lambda: not waiter.is_alive())
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    assert not _wait_for(lambda: starts, timeout=0.1)


def test_gw_one_waiter_and_a_direct_start_stops_it(plugin, home, monkeypatch):
    starts = _counting_loop(plugin, monkeypatch)
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.setattr(plugin.sys, "argv", ["hermes", "gateway", "restart"])
    plugin.start_loop()
    first = plugin._WAITER
    plugin.start_loop()
    assert plugin._WAITER is first  # never a second waiter
    monkeypatch.setattr(plugin.sys, "argv", ["hermes", "gateway", "run"])
    assert plugin.start_loop() is True
    assert _wait_for(lambda: not first.is_alive())
    monkeypatch.setenv("_HERMES_GATEWAY", "1")
    assert _wait_for(lambda: len(starts) == 1) and not _wait_for(lambda: len(starts) > 1, timeout=0.1)
    plugin._STOP.set()


def test_gw_tui_never_waits(plugin, home, monkeypatch):
    starts = _counting_loop(plugin, monkeypatch)
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.setattr(plugin.sys, "argv", ["hermes", "chat"])
    assert plugin.start_loop() is False
    assert plugin._WAITER is None and plugin._THREAD is None
    assert not _wait_for(lambda: starts, timeout=0.05)


def test_h2_claims_before_injecting_and_unclaims_on_refusal(plugin, home, db):
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 60)
    seen = []

    class Peek(Ctx):
        def inject_message(self, content, role="user", *, session_key=None):
            seen.append((names(home, ".txt"), names(home, ".sending")))
            return False

    assert plugin.inject_pass(Peek(), now=NOON) == "inject_refused"
    assert seen[0][0] == [] and len(seen[0][1]) == 1  # claimed while injecting
    assert len(names(home, ".txt")) == 1 and names(home, ".sending") == []  # back to .txt


def test_h2_no_injection_when_the_claim_fails(plugin, home, db, monkeypatch):
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 60)
    real = os.rename

    def refuse(src, dst):
        if str(dst).endswith(".sending"):
            raise OSError("busy")
        return real(src, dst)

    monkeypatch.setattr(plugin.os, "rename", refuse)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "claim_failed"
    assert ctx.calls == []


def test_m5_invalid_names_and_texts_are_skipped(plugin, home, db):
    db.session("s-dm")
    stage(home, "nudge", "[Agent Village notice x", NOON - 90)
    stage(home, "open", "#trigger=opener\nhello, not a notice", NOON - 60)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "skipped_invalid"
    assert ctx.calls == [] and len(names(home, ".skipped")) == 2
    stage(home, "open", "﻿#trigger=opener\n" + OPENER.split("\n", 1)[1], NOON - 30)
    assert plugin.inject_pass(ctx, now=NOON) == "injected"
    assert ctx.calls[0][0].startswith(plugin.NOTICE_PREFIX)


def test_m4_holds_while_the_human_wrote_recently_or_a_turn_runs(plugin, home, db):
    import sqlite3
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 60)
    db.message("s-dm", "user", "hi", NOON - 120)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "held_human_recent"
    con = sqlite3.connect(home / "state.db")
    con.execute("CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, holder TEXT, acquired_at REAL, expires_at REAL)")
    con.execute("INSERT INTO session_turn_leases VALUES ('c', 'h', ?, ?)", (NOON + 200, NOON + 400))
    con.commit()
    con.close()
    assert plugin.inject_pass(ctx, now=NOON + 301) == "held_turn_active"
    assert plugin.inject_pass(ctx, now=NOON + 401) == "injected"


def write_marker(home, body, when):
    (home / "av-events" / "elicit").mkdir(parents=True, exist_ok=True)
    path = home / "av-events" / "elicit" / "closed"
    path.write_text(json.dumps(body) if body is not None else "")
    os.utime(path, (when, when))


def test_m2_withdrawn_refuses_late_records(plugin, home, db):
    opened_at(plugin, home, db, NOON - 7200)
    rec(plugin, home, "question", 1, NOON - 7100)
    write_marker(home, {"reason": "withdrawn", "window_ms": WIN}, NOON - 3600)
    with pytest.raises(plugin.Refused) as info:
        plugin.record_elicitation({"kind": "answer", "question_no": 1, "text": "a"}, "s-dm", now=NOON)
    assert info.value.code == "withdrawn"


def test_m2_late_records_stop_after_a_stop(plugin, home, db):
    opened_at(plugin, home, db, NOON - 7200)
    rec(plugin, home, "question", 1, NOON - 7100)
    rec(plugin, home, "stop", 1, NOON - 7000)
    write_marker(home, {"reason": "stopped", "window_ms": WIN}, NOON - 3600)
    with pytest.raises(plugin.Refused) as info:
        plugin.record_elicitation({"kind": "answer", "question_no": 1, "text": "a"}, "s-dm", now=NOON)
    assert info.value.code == "stopped"


def test_m2_marker_for_another_window_does_not_close_this_one(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    write_marker(home, {"reason": "manual", "window_ms": WIN - 1}, NOON - 60)
    assert plugin.window_open(now=NOON)
    body = rec(plugin, home, "question", 1, NOON - 30)
    assert body["window_ms"] == WIN  # the open file's name, not its accept time
    assert json.loads((home / "av-events" / "elicit" / "window.json").read_text())["window_ms"] == WIN
    write_marker(home, {"reason": "manual", "window_ms": WIN}, NOON - 20)
    assert not plugin.window_open(now=NOON)


def test_m1_late_period_runs_from_first_sight(plugin, home, db):
    opened_at(plugin, home, db, NOON - 7200)
    write_marker(home, {"reason": "manual"}, NOON - 3600)
    assert not plugin.window_open(now=NOON)
    os.utime(home / "av-events" / "elicit" / "closed", (NOON + 20 * 3600, NOON + 20 * 3600))
    with pytest.raises(plugin.Refused):
        plugin.record_elicitation({"kind": "stop", "question_no": 1}, "s-dm", now=NOON - 3600 + 24 * 3600 + 5)


def test_m3_recount_covers_renamed_records(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    rec(plugin, home, "question", 1, NOON - 500)
    rec(plugin, home, "question", 2, NOON - 400)
    for path in records(home):
        path.rename(str(path) + ".sent")
    (home / "av-events" / "elicit" / "window.json").unlink()
    assert rec(plugin, home, "question", 1, NOON - 300)["question_no"] == 3


def test_l2_no_home_key_fails_closed(plugin, home, db, monkeypatch):
    db.session("s-dm")
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", "")
    assert plugin.telegram_dm_session("s-dm") is False


def test_l3_accept_time_sidecar_when_utime_fails(plugin, home, db, monkeypatch):
    db.session("s-dm")
    stage(home, "open", OPENER, NOON - 60)

    def no_utime(*_a, **_k):
        raise OSError("ro")

    monkeypatch.setattr(plugin.os, "utime", no_utime)
    assert plugin.inject_pass(Ctx(), now=NOON) == "injected"
    assert plugin.current_window_ms() == WIN
    assert plugin.window_start(now=NOON) == NOON  # T0 from the sidecar, not the staging mtime


WIN = int((NOON - 60) * 1000)
NEXT_ANSWER = NEXT_IDLE.replace("#trigger=idle", "#trigger=answer")


def test_s9_human_hold_is_for_open_and_idle_only(plugin, home, db):
    opened_at(plugin, home, db, NOON - 3600)
    db.message("s-dm", "user", "typing away", NOON - 60)
    stage(home, "next", NEXT_IDLE, NOON - 30)
    ctx = Ctx()
    assert plugin.inject_pass(ctx, now=NOON) == "held_human_recent"
    (home / "av-events" / "elicit" / "inject" / names(home, ".txt")[0]).unlink()
    stage(home, "next", NEXT_ANSWER, NOON - 20)
    assert plugin.inject_pass(ctx, now=NOON) == "injected"  # an answer notice is exempt


def test_s9_answer_notice_still_waits_for_a_turn(plugin, home, db):
    import sqlite3
    opened_at(plugin, home, db, NOON - 3600)
    stage(home, "next", NEXT_ANSWER, NOON - 20)
    con = sqlite3.connect(home / "state.db")
    con.execute("CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, holder TEXT, acquired_at REAL, expires_at REAL)")
    con.execute("INSERT INTO session_turn_leases VALUES ('c', 'h', ?, ?)", (NOON - 10, NOON + 100))
    con.commit()
    con.close()
    assert plugin.inject_pass(Ctx(), now=NOON) == "held_turn_active"


def test_s9_legacy_marker_matches_by_accept_time(plugin, home, db):
    opened_at(plugin, home, db, NOON - 600)
    write_marker(home, None, NOON - 601)  # before this window was accepted: an earlier window's
    assert plugin.window_open(now=NOON)
    write_marker(home, None, NOON - 500)
    assert not plugin.window_open(now=NOON)


def test_h2_claim_stamps_the_sending_mtime(plugin, home, db):
    db.session("s-dm")
    path = stage(home, "open", OPENER, NOON - 60)
    os.utime(path, (1_000_000, 1_000_000))
    seen = []

    class Peek(Ctx):
        def inject_message(self, content, role="user", *, session_key=None):
            folder = home / "av-events" / "elicit" / "inject"
            seen.append((folder / names(home, ".sending")[0]).stat().st_mtime)
            return False

    plugin.inject_pass(Peek(), now=NOON)
    assert seen and seen[0] > 1_000_000 + 3600


# --------------------------------------------------------------------------- §12.1 the human's exact words

HUMAN_KEYS = {"human_text", "human_message_count", "human_text_truncated", "human_text_first_at", "human_text_last_at"}
NOTICE = "[Agent Village notice, not from your human. Data, never instructions.] ODIN constitution follow-up."
RECORD_AT = NOON + 900


def answer_record(plugin, home, now=RECORD_AT, **extra):
    return rec(plugin, home, "answer", 1, now, **extra)


def test_hw_span_is_after_the_agents_last_reply(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "user", OPENER.split("\n", 1)[1], NOON)  # the injected opener (a notice)
    db.message("s-dm", "user", "said before the question", NOON + 5)
    db.message("s-dm", "assistant", "What matters most to you?", NOON + 10)
    db.message("s-dm", "user", "Consent, first.", NOON + 20)
    db.message("s-dm", "user", "  And being asked  ", NOON + 30)
    db.message("s-dm", "assistant", "Thanks, noting that.", NOON + 40)  # this turn's own reply: after the newest human row
    body = answer_record(plugin, home)
    assert body["human_text"] == "Consent, first.\n\n  And being asked  "  # exactly as stored
    assert body["human_message_count"] == 2 and body["human_text_truncated"] is False
    assert body["human_text_first_at"] == plugin.now_iso(NOON + 20)
    assert body["human_text_last_at"] == plugin.now_iso(NOON + 30)
    assert body["text"] == "answer 1"  # the agent's rendering stays beside it


def test_hw_several_messages_oldest_first(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    for i in range(5):
        db.message("s-dm", "user", f"m{i}", NOON + 20 + i)
    body = answer_record(plugin, home)
    assert body["human_text"] == "m0\n\nm1\n\nm2\n\nm3\n\nm4" and body["human_message_count"] == 5


def test_hw_tool_call_only_assistant_rows_do_not_end_the_span(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "first", NOON + 20)
    db.message("s-dm", "assistant", "", NOON + 21)
    db.message("s-dm", "assistant", None, NOON + 22)
    db.message("s-dm", "assistant", "  \n", NOON + 23)
    db.message("s-dm", "tool", "tool output", NOON + 24)
    db.message("s-dm", "user", "second", NOON + 30)
    body = answer_record(plugin, home)
    assert body["human_text"] == "first\n\nsecond" and body["human_message_count"] == 2


def test_hw_notices_are_excluded(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "first", NOON + 20)
    db.message("s-dm", "user", NOTICE, NOON + 25)
    db.message("s-dm", "user", "second", NOON + 30)
    db.message("s-dm", "user", NOTICE, NOON + 35)  # a notice newer than the human's words is not the anchor
    db.message("s-dm", "user", "", NOON + 36)  # nor a blank row
    body = answer_record(plugin, home)
    assert body["human_text"] == "first\n\nsecond" and body["human_message_count"] == 2
    assert "Agent Village notice" not in body["human_text"]


def test_hw_messages_before_the_window_are_excluded(plugin, home, db):
    opened(plugin, home, db)  # window_ms is the open file's name: NOON - 60
    db.message("s-dm", "user", "last week", NOON - 3600)
    db.message("s-dm", "user", "just before the open", NOON - 61)
    db.message("s-dm", "user", "at the open", NOON - 60)
    db.message("s-dm", "user", "after", NOON + 20)
    body = answer_record(plugin, home)
    assert body["window_ms"] == int((NOON - 60) * 1000)
    assert body["human_text"] == "at the open\n\nafter" and body["human_message_count"] == 2


def test_hw_only_the_home_dm(plugin, home, db):
    opened(plugin, home, db)
    db.session("s-dm-2")  # a later session under the same home key counts
    db.session("s-group", key="agent:main:telegram:group:-100", chat_type="group")
    db.session("s-otherdm", key="agent:main:telegram:dm:999")
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "first", NOON + 20)
    db.message("s-group", "user", "group chatter", NOON + 25)
    db.message("s-otherdm", "user", "someone else", NOON + 26)
    db.message("s-dm-2", "user", "second", NOON + 30)
    body = answer_record(plugin, home)
    assert body["human_text"] == "first\n\nsecond"


def test_hw_message_cap_keeps_the_most_recent_ten(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    for i in range(12):
        db.message("s-dm", "user", f"m{i:02d}", NOON + 20 + i)
    body = answer_record(plugin, home)
    assert body["human_message_count"] == 10 and body["human_text_truncated"] is True
    assert body["human_text"].split("\n\n") == [f"m{i:02d}" for i in range(2, 12)]
    assert body["human_text_first_at"] == plugin.now_iso(NOON + 22)


def test_hw_exactly_ten_is_not_truncated(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    for i in range(10):
        db.message("s-dm", "user", f"m{i}", NOON + 20 + i)
    body = answer_record(plugin, home)
    assert body["human_message_count"] == 10 and body["human_text_truncated"] is False


def test_hw_character_cap_keeps_the_most_recent_whole_messages(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    for i, ch in enumerate("abc"):
        db.message("s-dm", "user", ch * 3000, NOON + 20 + i)
    body = answer_record(plugin, home)
    assert body["human_text"] == "b" * 3000 + "\n\n" + "c" * 3000
    assert body["human_message_count"] == 2 and body["human_text_truncated"] is True
    assert body["human_text_first_at"] == plugin.now_iso(NOON + 21)


def test_hw_exactly_8000_characters_is_not_truncated(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "a" * 3999, NOON + 20)
    db.message("s-dm", "user", "b" * 3999, NOON + 21)
    body = answer_record(plugin, home)
    assert len(body["human_text"]) == 8000 and body["human_text_truncated"] is False


def test_hw_one_message_over_the_cap_keeps_its_first_8000(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "older", NOON + 20)
    db.message("s-dm", "user", "x" * 7000 + "y" * 2000, NOON + 30)
    body = answer_record(plugin, home)
    assert body["human_text"] == "x" * 7000 + "y" * 1000
    assert body["human_message_count"] == 1 and body["human_text_truncated"] is True
    assert body["human_text_first_at"] == body["human_text_last_at"] == plugin.now_iso(NOON + 30)


def test_hw_inactive_rows_are_ignored(plugin, home, active_db):
    db = active_db
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "first", NOON + 20)
    db.message("s-dm", "user", "rewound", NOON + 25, active=0)
    db.message("s-dm", "assistant", "an inactive reply", NOON + 26, active=0)  # does not end the span
    db.message("s-dm", "user", "second", NOON + 30)
    body = answer_record(plugin, home)
    assert body["human_text"] == "first\n\nsecond" and body["human_message_count"] == 2


def test_hw_compaction_summaries_are_neither_side(plugin, home, active_db):
    db = active_db
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "first", NOON + 20)
    db.message("s-dm", "assistant", "[summary of earlier turns]", NOON + 25, summary=1)  # does not end the span
    db.message("s-dm", "user", "[CONTEXT COMPACTION] earlier turns", NOON + 26, summary=1)
    db.message("s-dm", "user", "second", NOON + 30)
    body = answer_record(plugin, home)
    assert body["human_text"] == "first\n\nsecond" and body["human_message_count"] == 2


def test_hw_8000_three_byte_characters_beside_maximal_agent_fields_fit_untruncated(plugin, home, db):
    """The cp's RECORD_FILE_MAX is 64 KiB (agentvillage-controlplane #397): the whole capped span always fits."""
    assert plugin.RECORD_FILE_BYTES == 65_536
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    words = ["अ" * 3999, "ब" * 3999]  # 7998 + the "\n\n" join = 8000 characters, 24000 bytes
    db.message("s-dm", "user", words[0], NOON + 20)
    db.message("s-dm", "user", words[1], NOON + 21)
    ids = [f"s{i:03d}" + "x" * 60 for i in range(plugin.STATEMENT_IDS_MAX)]  # 64 ids of 64 characters
    body = answer_record(plugin, home, text="स" * plugin.TEXT_MAX, takeaway="क" * plugin.TAKEAWAY_MAX,
                         category="c" * 64, statement_ids=ids)
    [path] = records(home)
    assert path.stat().st_size <= plugin.RECORD_FILE_BYTES
    assert len(body["human_text"]) == plugin.HUMAN_TEXT_MAX
    assert body["human_text"] == "\n\n".join(words)
    assert body["human_message_count"] == 2 and body["human_text_truncated"] is False
    assert body["statement_ids"] == ids and len(body["text"]) == plugin.TEXT_MAX


def test_hw_record_always_fits_the_control_planes_file_bound(plugin, home, db, monkeypatch):
    """Under a smaller bound (the old cp's 16 KiB), the words are cut further (oldest message first) until the
    record fits, never the agent's fields."""
    monkeypatch.setattr(plugin, "RECORD_FILE_BYTES", 16_384)
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "अ" * 3000, NOON + 20)
    db.message("s-dm", "user", "ब" * 3000, NOON + 21)
    long_text = "स" * 4000
    body = answer_record(plugin, home, text=long_text, takeaway="t" * 2000)
    [path] = records(home)
    assert path.stat().st_size <= plugin.RECORD_FILE_BYTES
    assert body["text"] == long_text  # the agent's fields are never cut
    assert body["human_message_count"] == 1 and body["human_text_truncated"] is True
    assert body["human_text"] == "ब" * len(body["human_text"]) and 0 < len(body["human_text"]) < 3000
    assert body["human_text_first_at"] == body["human_text_last_at"] == plugin.now_iso(NOON + 21)


def test_hw_fit_drops_the_oldest_whole_message_first(plugin):
    messages = [("a" * 50, 1.0), ("b" * 50, 2.0)]
    record = {"kind": "answer", **plugin.human_fields(messages, False)}
    limit = plugin.record_bytes(record) - 10
    plugin.fit_human_words(record, messages, False, limit=limit)
    assert record["human_text"] == "b" * 50 and record["human_message_count"] == 1
    assert record["human_text_truncated"] is True and plugin.record_bytes(record) <= limit
    small = {"kind": "answer", **plugin.human_fields(messages, False)}
    plugin.fit_human_words(small, messages, False)  # already fits: untouched
    assert small["human_message_count"] == 2 and small["human_text_truncated"] is False


def test_hw_no_human_words_yet(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    body = answer_record(plugin, home)
    assert {k: body[k] for k in HUMAN_KEYS} == {"human_text": None, "human_message_count": 0,
                                                "human_text_truncated": False, "human_text_first_at": None,
                                                "human_text_last_at": None}


def test_hw_unreadable_db_still_writes_the_record(plugin, home, db, monkeypatch, caplog):
    opened(plugin, home, db)
    db.message("s-dm", "user", SECRET, NOON + 20)
    real = plugin._sqlite_rows

    def no_messages(path, sql, params=()):
        return None if "messages" in sql else real(path, sql, params)

    monkeypatch.setattr(plugin, "_sqlite_rows", no_messages)
    caplog.set_level(logging.INFO, logger="av-elicit")
    line = plugin.elicitation_record_tool({"kind": "answer", "question_no": 1, "text": "their words"}, session_id="s-dm")
    assert line.startswith("Recorded the answer to question 1")  # the confirmation is unchanged
    body = json.loads(records(home)[-1].read_text())
    assert body["human_message_count"] == 0 and body["human_text"] is None and body["human_text_truncated"] is False
    assert "outcome=human_text_unavailable" in caplog.text


def test_hw_a_raise_while_reading_still_writes_the_record(plugin, home, db, monkeypatch, caplog):
    opened(plugin, home, db)

    def boom(*args, **kwargs):
        raise RuntimeError("disk")

    monkeypatch.setattr(plugin, "human_words", boom)
    caplog.set_level(logging.INFO, logger="av-elicit")
    body = answer_record(plugin, home)
    assert body["human_message_count"] == 0 and body["human_text"] is None
    assert "outcome=human_text_error" in caplog.text and "outcome=human_text_unavailable" in caplog.text


def test_hw_question_and_stop_records_carry_none_of_the_fields(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "user", "words", NOON + 20)
    question = rec(plugin, home, "question", 1, NOON + 100)
    stop = rec(plugin, home, "stop", 1, NOON + 200)
    assert not HUMAN_KEYS & set(question) and not HUMAN_KEYS & set(stop)


def test_hw_the_agent_cannot_supply_the_fields(plugin, home, db):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", "the real words", NOON + 20)
    body = answer_record(plugin, home, human_text="made up", human_message_count=9)
    assert body["human_text"] == "the real words" and body["human_message_count"] == 1
    assert not HUMAN_KEYS & set(plugin.TOOL_SCHEMA["parameters"]["properties"])


def test_hw_late_answer_uses_the_same_rule(plugin, home, db):
    opened_at(plugin, home, db, NOON)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    closed_at(home, NOON + 60)
    db.message("s-dm", "user", NOTICE, NOON + 3600)
    db.message("s-dm", "user", "sorry, late: consent", NOON + 3700)
    body = answer_record(plugin, home, now=NOON + 3800)
    assert body["late"] is True and body["human_text"] == "sorry, late: consent"


def test_hw_logs_carry_counts_never_the_words(plugin, home, db, caplog):
    opened(plugin, home, db)
    db.message("s-dm", "assistant", "Question?", NOON + 10)
    db.message("s-dm", "user", SECRET, NOON + 20)
    caplog.set_level(logging.DEBUG, logger="av-elicit")
    body = answer_record(plugin, home)
    assert body["human_text"] == SECRET
    assert SECRET not in caplog.text and "human_messages=1" in caplog.text and "human_truncated=0" in caplog.text
