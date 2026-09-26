"""Regressions for the defects found in adversarial review.

One test (or group) per finding, named for it. Each of these failed before the
corresponding fix.
"""

from __future__ import annotations

import builtins
import json
import os
import sys
import time

import pytest


def mod(plugin, name):
    return sys.modules[f"{plugin.__name__}.{name}"]


def make_collector(plugin, monkeypatch, *, url="", token="test-token", **env):
    monkeypatch.setenv("AV_EVENTS_TOKEN", token)
    if url:
        monkeypatch.setenv("AV_EVENTS_URL", url)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    collector = mod(plugin, "_collector").Collector()
    collector._ensure_buffer()
    return collector


def ready_files(collector, sub=""):
    root = os.path.join(collector.config.buffer_dir, sub) if sub else collector.config.buffer_dir
    if not os.path.isdir(root):
        return []
    return sorted(
        name for name in os.listdir(root)
        if name.endswith(".jsonl") and not name.startswith("current-")
    )


@pytest.fixture()
def exploding(plugin, ctx, monkeypatch):
    def boom(collector, **kwargs):
        raise RuntimeError("payload text that must never be reported: hunter2")

    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setattr(plugin, "HOOK_BODIES", {k: boom for k in plugin.HOOK_BODIES})
    plugin.register(ctx)
    return plugin


# --------------------------------------------------------------------------
# 1 — the breaker must survive interleaved session ids
# --------------------------------------------------------------------------


def test_interleaved_sessions_still_trip_the_breaker(exploding, ctx, av):
    """Subagents and cron share a process; A/B/A/B must not reset the count."""
    for index in range(20):
        for session in ("sess-a", "sess-b"):
            ctx.fire("post_tool_call", session_id=session, tool_name="shell")

    degraded = [e for e in av.read_buffer(exploding._COLLECTOR) if e["event_type"] == "plugin.degraded"]
    assert len(degraded) == 2, "each session trips its own breaker"
    assert {e["session_id"] for e in degraded} == {"sess-a", "sess-b"}
    for event in degraded:
        assert event["payload"]["error_count"] == 10


def test_a_session_breaker_does_not_disable_another_session(exploding, ctx):
    collector = exploding._COLLECTOR
    for _ in range(12):
        ctx.fire("post_tool_call", session_id="sess-a", tool_name="shell")
    assert collector.sessions["sess-a"].degraded is True

    ctx.fire("post_tool_call", session_id="sess-b", tool_name="shell")
    assert collector.sessions["sess-b"].degraded is False
    assert collector.sessions["sess-a"].degraded is True


def test_a_process_wide_backstop_disables_everything(exploding, ctx):
    """Enough churning sessions and the plugin gives up entirely."""
    collector = exploding._COLLECTOR
    core = mod(exploding, "_core")
    for index in range(core.MAX_PROCESS_FAILURES + 10):
        ctx.fire("post_tool_call", session_id=f"s{index}", tool_name="shell")
    assert collector.plugin_disabled is True
    assert collector.total_failures == core.MAX_PROCESS_FAILURES


def test_config_is_not_reloaded_on_every_hook(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    collector = plugin._COLLECTOR

    reloads = []
    original = collector.reload_config
    monkeypatch.setattr(collector, "reload_config", lambda: (reloads.append(1), original())[1])

    for _ in range(30):
        ctx.fire("post_tool_call", session_id="sess-a", tool_name="shell")
        ctx.fire("post_tool_call", session_id="sess-b", tool_name="shell")
    assert len(reloads) <= 2, f"one reload per new session id, got {len(reloads)}"


# --------------------------------------------------------------------------
# 2 — pre_tool_call is fail-closed in Hermes: it must do no I/O at all
# --------------------------------------------------------------------------


def test_pre_tool_call_touches_no_filesystem(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    # Open the session first, through a hook that is allowed to do work.
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")

    calls: list[str] = []
    for target, name in ((builtins, "open"), (os, "stat"), (os, "makedirs")):
        original = getattr(target, name)

        def spy(*args, _o=original, _n=name, **kwargs):
            calls.append(_n)
            return _o(*args, **kwargs)

        monkeypatch.setattr(target, name, spy)

    ctx.fire("pre_tool_call", session_id="s", tool_name="shell", args={"command": "ls"})
    assert calls == [], f"pre_tool_call did I/O: {calls}"
    assert plugin._COLLECTOR.sessions["s"].tool_call_count == 1


def test_pre_tool_call_does_not_open_an_unknown_session(plugin, ctx, monkeypatch, av, home):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("pre_tool_call", session_id="never-seen", tool_name="shell")
    assert "never-seen" not in plugin._COLLECTOR.sessions
    assert av.read_buffer(plugin._COLLECTOR) == []


def test_pre_tool_call_does_not_spawn_the_flusher(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("pre_tool_call", session_id="s", tool_name="shell")
    assert plugin._COLLECTOR._thread is None


# --------------------------------------------------------------------------
# 3 — the seen-set must not outrun the emit
# --------------------------------------------------------------------------


def test_prompt_registered_is_not_lost_when_emit_is_inert(plugin, ctx, monkeypatch, av, home):
    """Marking a hash seen before it is buffered loses the body forever."""
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)

    tools = [{"type": "function", "function": {"name": "t"}}]
    payload = dict(
        session_id="s1", turn_id="t0", api_request_id="r0", system_prompt="SP",
        tool_count=1, request={"method": "POST", "body": {"tools": tools}},
    )
    # No token yet: the plugin idles, so nothing is buffered.
    ctx.fire("pre_api_request", **payload)
    assert av.read_buffer(plugin._COLLECTOR) == []

    # The token arrives; the next session must still register the prompt.
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx.fire("pre_api_request", **{**payload, "session_id": "s2"})
    kinds = [
        e["payload"]["kind"]
        for e in av.read_buffer(plugin._COLLECTOR)
        if e["event_type"] == "prompt.registered"
    ]
    assert sorted(kinds) == ["system_prompt", "tools"]


def test_a_registered_prompt_is_still_only_sent_once(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    tools = [{"type": "function", "function": {"name": "t"}}]
    for index in range(3):
        ctx.fire(
            "pre_api_request", session_id="s", turn_id=f"t{index}", api_request_id=f"r{index}",
            system_prompt="SP", tool_count=1, request={"method": "POST", "body": {"tools": tools}},
        )
    registered = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "prompt.registered"]
    assert len(registered) == 2


# --------------------------------------------------------------------------
# 4 — register() is idempotent
# --------------------------------------------------------------------------


def test_registering_twice_does_not_double_register_hooks(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    plugin.register(ctx)
    for name, callbacks in ctx.hooks.items():
        assert len(callbacks) == 1, f"{name} registered {len(callbacks)} times"

    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    starts = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "session.started"]
    assert len(starts) == 1


# --------------------------------------------------------------------------
# 5 — api_request_error
# --------------------------------------------------------------------------


def test_a_failed_api_request_still_emits_llm_call(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    assert "api_request_error" in ctx.hooks

    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    ctx.fire(
        "pre_api_request", session_id="s", turn_id="t0", api_request_id="r0", model="m",
        system_prompt="SP", tool_count=0, request={"method": "POST", "body": {}},
    )
    ctx.fire(
        "api_request_error", session_id="s", turn_id="t0", api_request_id="r0", model="m",
        provider="openrouter", api_duration=0.5, status_code=500, retryable=True,
        error={"type": "APITimeoutError", "message": "secret prompt text leaked here"},
    )
    calls = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"]
    assert len(calls) == 1
    payload = calls[0]["payload"]
    assert payload["finish_reason"] == "error"
    assert payload["error_type"] == "APITimeoutError"
    assert payload["input_tokens"] == 0
    assert payload["system_prompt_hash"], "the pre_api_request stash was consumed"
    assert "secret prompt text" not in json.dumps(calls[0])


def test_an_errored_request_does_not_leave_a_stash_behind(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    ctx.fire("pre_api_request", session_id="s", turn_id="t0", api_request_id="r0",
             system_prompt="SP", tool_count=0, request={"method": "POST", "body": {}})
    ctx.fire("api_request_error", session_id="s", turn_id="t0", api_request_id="r0",
             error={"type": "APIError", "message": "x"})
    assert plugin._COLLECTOR.sessions["s"].pending_llm == {}


# --------------------------------------------------------------------------
# 6 — source must not latch to "unknown"
# --------------------------------------------------------------------------


def test_session_started_waits_for_a_known_source(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)

    # A hook with no platform opens the session but must not emit
    # `session.started` yet (its own `tool.call` is not held back).
    ctx.fire("post_tool_call", session_id="s", tool_name="shell")
    assert av.types_of(av.read_buffer(plugin._COLLECTOR)) == ["tool.call"]

    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    starts = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "session.started"]
    assert len(starts) == 1
    assert starts[0]["payload"]["source"] == "telegram", "source must not have latched to unknown"


def test_a_session_that_never_learns_its_source_still_reports(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("post_tool_call", session_id="s", tool_name="shell")
    ctx.fire("on_session_finalize", session_id="s")
    types = [t for t in av.types_of(av.read_buffer(plugin._COLLECTOR)) if t.startswith("session.")]
    assert types == ["session.started", "session.ended"], types


# --------------------------------------------------------------------------
# 7 — env semantics
# --------------------------------------------------------------------------


def test_a_blank_process_env_value_is_authoritative(plugin, ctx, home, av):
    """`AV_EVENTS_TOKEN=""` revokes a tenant even though `.env` still has one."""
    (home / ".env").write_text("AV_EVENTS_TOKEN=dotenv-token\n", encoding="utf-8")
    os.environ["AV_EVENTS_TOKEN"] = ""
    try:
        plugin.register(ctx)
        ctx.fire("on_session_start", session_id="s", model="m", platform="cli")
        assert plugin._COLLECTOR.config.idle is True
        assert av.read_buffer(plugin._COLLECTOR) == []
    finally:
        del os.environ["AV_EVENTS_TOKEN"]


def test_an_absent_process_env_value_falls_back_to_dotenv(plugin, ctx, home, av):
    (home / ".env").write_text("AV_EVENTS_TOKEN=dotenv-token\n", encoding="utf-8")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="cli")
    assert plugin._COLLECTOR.config.idle is False


@pytest.mark.parametrize("value", ["0", "false", "FALSE", "No", "off", " Off "])
def test_every_falsey_spelling_disables_the_plugin(plugin, ctx, monkeypatch, av, value):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_ENABLED", value)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="cli")
    assert av.read_buffer(plugin._COLLECTOR) == [], f"{value!r} should disable"


@pytest.mark.parametrize("value", ["1", "true", "yes", "on", ""])
def test_other_spellings_leave_it_enabled(plugin, ctx, monkeypatch, av, value):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_ENABLED", value)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="cli")
    assert av.types_of(av.read_buffer(plugin._COLLECTOR)) == ["session.started"]


def test_hook_names_are_matched_case_insensitively(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "  ON_SESSION_START , Pre_Tool_Call ")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="cli")
    assert av.read_buffer(plugin._COLLECTOR) == []


# --------------------------------------------------------------------------
# 8 — a rejected batch must not be retried forever
# --------------------------------------------------------------------------


@pytest.mark.parametrize("status", [400, 413, 422])
def test_a_rejected_batch_is_quarantined_not_retried(plugin, monkeypatch, home, av, status):
    with av.StubIngest(statuses=[status]) as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        for index in range(50):
            collector.emit("session.started", {"n": index}, session_id="s")
        collector.tick()

        assert ingest.request_count == 1
        assert ready_files(collector) == [], "the batch left the send queue"
        assert len(ready_files(collector, "rejected")) == 1, "and is kept on disk"

        collector.tick()
        assert ingest.request_count == 1, "a rejected batch is never offered again"
        assert collector._dropped["rejected_files"] == 1


def test_a_rejection_is_reported_with_a_reason(plugin, monkeypatch, home, av):
    with av.StubIngest(statuses=[400]) as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        for index in range(50):
            collector.emit("session.started", {"n": index}, session_id="s")
        collector.tick()
        for index in range(50):
            collector.emit("session.started", {"n": index}, session_id="s")
        collector.tick()
        collector.buffer.rotate_if_due(force=True)
        collector.tick()

        reports = [e for e in ingest.received if e["event_type"] == "plugin.buffer_dropped"]
        assert len(reports) == 1
        assert reports[0]["payload"]["reason"] == "rejected"
        assert reports[0]["payload"]["rejected_files"] == 1
        assert reports[0]["payload"]["rejected_events"] == 50


@pytest.mark.parametrize("status", [408, 429, 500, 503])
def test_a_transient_status_is_still_retried(plugin, monkeypatch, home, av, status):
    with av.StubIngest(statuses=[status]) as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        for index in range(50):
            collector.emit("session.started", {"n": index}, session_id="s")
        collector.tick()
        assert len(ready_files(collector)) == 1
        assert ready_files(collector, "rejected") == []


def test_at_most_five_files_are_attempted_per_tick(plugin, monkeypatch, home, av):
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        for batch in range(8):
            for index in range(50):
                collector.emit("session.started", {"n": index}, session_id="s")
        assert len(ready_files(collector)) == 8
        collector.tick()
        assert ingest.request_count == 5
        collector.tick()
        assert ingest.request_count == 8


# --------------------------------------------------------------------------
# 9 — hook stats reach session.ended
# --------------------------------------------------------------------------


def test_session_ended_carries_the_hook_stats(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")

    def slow(collector, **kwargs):
        time.sleep(0.06)

    bodies = dict(plugin.HOOK_BODIES)
    bodies["post_tool_call"] = slow
    monkeypatch.setattr(plugin, "HOOK_BODIES", bodies)
    plugin.register(ctx)

    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    ctx.fire("post_tool_call", session_id="s", tool_name="shell")
    ctx.fire("on_session_finalize", session_id="s")

    ended = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "session.ended"][0]
    payload = ended["payload"]
    assert payload["hook_calls"] >= 2
    assert payload["hook_failures"] == 0
    assert payload["hook_overruns"] == 1
    assert payload["hook_max_ms"] >= 50
    assert payload["slowest_hook"] == "post_tool_call"


def test_hook_failures_are_reported_per_session(plugin, ctx, monkeypatch, av):
    """One broken hook; the rest of the session still reports it cleanly."""

    def boom(collector, **kwargs):
        raise RuntimeError("nope")

    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    bodies = dict(plugin.HOOK_BODIES)
    bodies["post_tool_call"] = boom
    monkeypatch.setattr(plugin, "HOOK_BODIES", bodies)
    plugin.register(ctx)

    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    for _ in range(3):
        ctx.fire("post_tool_call", session_id="s", tool_name="shell")
    ctx.fire("on_session_finalize", session_id="s")

    ended = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "session.ended"]
    assert ended[0]["payload"]["hook_failures"] == 3
    assert ended[0]["payload"]["degraded"] is False


# --------------------------------------------------------------------------
# 10 — permissions
# --------------------------------------------------------------------------


def test_buffer_directory_and_files_are_private(plugin, monkeypatch, home):
    collector = make_collector(plugin, monkeypatch)
    collector.emit("session.started", {}, session_id="s")
    root = collector.config.buffer_dir
    assert oct(os.stat(root).st_mode & 0o777) == "0o700"
    assert oct(os.stat(collector.config.state_dir).st_mode & 0o777) == "0o700"
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if os.path.isfile(path):
            assert oct(os.stat(path).st_mode & 0o777) == "0o600", name


def test_the_seen_set_is_private(plugin, ctx, monkeypatch, home):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    ctx.fire("pre_api_request", session_id="s", turn_id="t0", api_request_id="r0",
             system_prompt="SP", tool_count=0, request={"method": "POST", "body": {}})
    seen = home / "av-events" / "seen.json"
    assert seen.exists()
    assert oct(os.stat(seen).st_mode & 0o777) == "0o600"


# --------------------------------------------------------------------------
# 13 — llm.call timestamps and run_id
# --------------------------------------------------------------------------


def test_llm_call_is_stamped_with_the_request_window(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    started = time.time() - 30
    ended = started + 1.25

    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    ctx.fire("pre_api_request", session_id="s", turn_id="t0", api_request_id="r0",
             system_prompt="SP", tool_count=0, started_at=started,
             request={"method": "POST", "body": {}})
    ctx.fire("post_api_request", session_id="s", turn_id="t0", api_request_id="r0", model="m",
             started_at=started, ended_at=ended, api_duration=1.25, finish_reason="stop",
             usage={"input_tokens": 1, "output_tokens": 1})

    call = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"][0]
    assert call["occurred_at"] < call["emitted_at"], "occurred_at is the request, not the emit"
    assert call["occurred_at_earliest"] == call["occurred_at"]
    assert call["occurred_at_latest"] > call["occurred_at"]


def test_run_id_is_null_when_the_task_id_is_just_the_session_id(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    ctx.fire("pre_api_request", session_id="s", task_id="s", turn_id="t0", api_request_id="r0",
             system_prompt="SP", tool_count=0, request={"method": "POST", "body": {}})
    ctx.fire("post_api_request", session_id="s", task_id="s", turn_id="t0", api_request_id="r0",
             model="m", usage={})
    call = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"][0]
    assert call["run_id"] is None

    ctx.fire("pre_api_request", session_id="s", task_id="task-9", turn_id="t1", api_request_id="r1",
             system_prompt="SP", tool_count=0, request={"method": "POST", "body": {}})
    ctx.fire("post_api_request", session_id="s", task_id="task-9", turn_id="t1",
             api_request_id="r1", model="m", usage={})
    call = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"][-1]
    assert call["run_id"] == "task-9"


# --------------------------------------------------------------------------
# 14 — the session map is bounded
# --------------------------------------------------------------------------


def test_a_finished_session_is_evicted(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    assert "s" in plugin._COLLECTOR.sessions
    ctx.fire("on_session_finalize", session_id="s")
    assert "s" not in plugin._COLLECTOR.sessions


def test_the_session_map_is_capped(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    core = mod(plugin, "_core")
    for index in range(core.MAX_TRACKED_SESSIONS + 50):
        ctx.fire("on_session_start", session_id=f"s{index}", model="m", platform="cli")
    assert len(plugin._COLLECTOR.sessions) <= core.MAX_TRACKED_SESSIONS


# --------------------------------------------------------------------------
# 15 — the degraded event carries no payload text
# --------------------------------------------------------------------------


def test_degraded_reports_the_exception_class_only(exploding, ctx, av):
    for _ in range(12):
        ctx.fire("post_tool_call", session_id="s", tool_name="shell")
    degraded = [e for e in av.read_buffer(exploding._COLLECTOR) if e["event_type"] == "plugin.degraded"][0]
    assert degraded["payload"]["last_error"] == "RuntimeError"
    assert "hunter2" not in json.dumps(degraded)
