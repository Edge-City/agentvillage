"""Session close: cost from `state.db` on `session.ended`, and `profile.updated` from USER.md."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid

import pytest

SESSION = "sess-end"
PROFILE = "# About the user\n- Prefers mornings\n- Building a café ☕ robot\n"


def write_state(home, session=SESSION, actual=None, estimated=0.0123, status="estimated", source="models_dev"):
    with sqlite3.connect(home / "state.db") as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, estimated_cost_usd REAL, "
            "actual_cost_usd REAL, cost_status TEXT, cost_source TEXT, input_tokens INTEGER)"
        )
        conn.execute(
            "INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?)",
            (session, "telegram", estimated, actual, status, source, 10),
        )


def write_profile(home, text=PROFILE):
    (home / "memories").mkdir(exist_ok=True)
    (home / "memories" / "USER.md").write_bytes(text.encode("utf-8"))


def close(ctx, session=SESSION):
    ctx.fire("on_session_start", session_id=session, model="m", platform="telegram")
    ctx.fire("on_session_finalize", session_id=session)


def of_type(av, plugin, event_type):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == event_type]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    return plugin


# --------------------------------------------------------------------------
# Cost
# --------------------------------------------------------------------------


def test_session_ended_carries_hermes_cost_columns(live, ctx, av, home):
    write_state(home, actual=0.0456, estimated=0.05, status="actual", source="openrouter_generation")
    close(ctx)
    payload = of_type(av, live, "session.ended")[0]["payload"]
    assert payload["actual_cost_usd"] == pytest.approx(0.0456)
    assert payload["estimated_cost_usd"] == pytest.approx(0.05)
    assert payload["cost_status"] == "actual"
    assert payload["cost_source"] == "openrouter_generation"


def test_an_estimate_is_never_promoted_to_actual(live, ctx, av, home):
    write_state(home, actual=None, estimated=0.0123)
    close(ctx)
    payload = of_type(av, live, "session.ended")[0]["payload"]
    assert payload["actual_cost_usd"] is None
    assert payload["estimated_cost_usd"] == pytest.approx(0.0123)


def test_no_state_db_means_null_cost_keys(live, ctx, av):
    close(ctx)
    payload = of_type(av, live, "session.ended")[0]["payload"]
    for key in ("actual_cost_usd", "cost_source", "estimated_cost_usd", "cost_status"):
        assert key in payload and payload[key] is None


def test_another_sessions_row_is_not_read(live, ctx, av, home):
    write_state(home, session="someone-else", actual=9.99)
    close(ctx)
    assert of_type(av, live, "session.ended")[0]["payload"]["actual_cost_usd"] is None


@pytest.mark.parametrize("actual,status,source", [
    (-1.0, "estimated", "models_dev"),
    (float("inf"), "Estimated With Words", "a b c"),
])
def test_malformed_cost_values_are_nulled(live, ctx, av, home, actual, status, source):
    write_state(home, actual=actual, status=status, source=source)
    close(ctx)
    payload = of_type(av, live, "session.ended")[0]["payload"]
    assert payload["actual_cost_usd"] is None
    if " " in status:
        assert payload["cost_status"] is None and payload["cost_source"] is None


def test_a_locked_or_corrupt_state_db_fails_open(live, ctx, av, home):
    (home / "state.db").write_bytes(b"not sqlite")
    close(ctx)
    assert of_type(av, live, "session.ended")[0]["payload"]["actual_cost_usd"] is None
    assert live._COLLECTOR.total_failures == 0


def test_state_db_is_opened_read_only(live, ctx, av, home):
    write_state(home, actual=0.01)
    before = (home / "state.db").read_bytes()
    close(ctx)
    assert (home / "state.db").read_bytes() == before


# --------------------------------------------------------------------------
# profile.updated
# --------------------------------------------------------------------------


def test_profile_updated_on_first_sight_and_on_change_only(live, ctx, av, home):
    write_profile(home)
    close(ctx, "s1")
    close(ctx, "s2")
    events = of_type(av, live, "profile.updated")
    assert len(events) == 1
    payload = events[0]["payload"]
    assert payload["user_md_hash"] == hashlib.sha256(PROFILE.encode("utf-8")).hexdigest()
    assert payload["length"] == len(PROFILE) < len(PROFILE.encode("utf-8"))
    assert events[0]["session_id"] == "s1"
    assert uuid.UUID(events[0]["event_id"]).version == 7

    write_profile(home, PROFILE + "- Now vegetarian\n")
    close(ctx, "s3")
    assert len(of_type(av, live, "profile.updated")) == 2


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_profile_text_never_leaves(plugin, ctx, monkeypatch, av, home, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    write_profile(home)
    close(ctx)
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    assert "Prefers mornings" not in blob and "robot" not in blob
    payload = of_type(av, plugin, "profile.updated")[0]["payload"]
    # The hash is the key `core.tasks` joins on and rides in every mode.
    assert payload["user_md_hash"] == hashlib.sha256(PROFILE.encode("utf-8")).hexdigest()
    assert ("length" in payload) is (mode != "metadata")


def test_no_profile_means_no_event(live, ctx, av):
    close(ctx)
    assert of_type(av, live, "profile.updated") == []


def test_an_inert_emit_does_not_record_the_hash(live, ctx, monkeypatch, av, home):
    """The plugin is active and reaches the emit; only the emit itself is inert."""
    write_profile(home)
    collector = live._COLLECTOR
    real_emit = collector.emit
    inert = {"on": True}
    monkeypatch.setattr(collector, "emit", lambda event_type, *a, **k: (
        None if inert["on"] and event_type == "profile.updated" else real_emit(event_type, *a, **k)))
    close(ctx, "s1")
    assert of_type(av, live, "session.ended")  # the session did close
    assert not (home / "av-events" / "profile.json").exists()
    inert["on"] = False
    close(ctx, "s2")
    assert len(of_type(av, live, "profile.updated")) == 1
    assert (home / "av-events" / "profile.json").exists()


def test_an_oversized_profile_is_not_read(live, ctx, av, home):
    write_profile(home, "x" * (2 * 1024 * 1024))
    close(ctx)
    assert of_type(av, live, "profile.updated") == []


def test_a_failing_profile_check_fails_open_and_the_session_still_ends(live, ctx, av, monkeypatch):
    monkeypatch.setattr(live._COLLECTOR, "check_profile", lambda session_id: 1 / 0)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    assert ctx.fire("on_session_finalize", session_id=SESSION) == []
    assert live._COLLECTOR.total_failures == 1
    assert len(of_type(av, live, "session.ended")) == 1
