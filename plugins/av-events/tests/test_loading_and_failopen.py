"""Loading, hook wiring, and the fail-open contract (spec scenario 25)."""

from __future__ import annotations

import sys

import pytest

# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def test_loads_the_way_hermes_loads_a_hyphenated_plugin(home, av):
    """`spec_from_file_location` + `submodule_search_locations`, like the loader."""
    module = av.load_plugin()
    assert callable(module.register)
    assert module.__version__ == "0.1.0"
    # The relative imports inside the plugin resolved as real submodules.
    assert f"{av.MODULE_NAME}._core" in sys.modules
    assert f"{av.MODULE_NAME}._collector" in sys.modules


def test_manifest_matches_the_dashboard_auth_shape(home, av):
    import yaml  # noqa: PLC0415 - optional; skipped when absent

    raw = (av.PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
    manifest = yaml.safe_load(raw)
    assert manifest["name"] == "av-events"
    assert manifest["kind"] == "backend"
    assert manifest["version"] == "0.1.0"


def test_register_wires_every_spec_hook(plugin, ctx):
    plugin.register(ctx)
    for name in plugin.SPEC_HOOKS:
        assert name in ctx.hooks, f"spec §7.1 hook {name} not registered"
    for name in plugin.EXTRA_HOOKS:
        assert name in ctx.hooks
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)


def test_hooks_accept_the_full_additive_payload(plugin, ctx):
    """Hermes only passes the complete payload to VAR_KEYWORD callbacks.

    `hermes_cli/plugins.py:5537` filters kwargs down to the names a narrow
    signature declares, and follows `__wrapped__`. If either broke, a growing
    payload would silently stop reaching us.
    """
    import inspect

    plugin.register(ctx)
    for name, callbacks in ctx.hooks.items():
        params = inspect.signature(callbacks[0]).parameters
        assert any(
            p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
        ), f"{name} would receive a filtered payload"


# --------------------------------------------------------------------------
# Scenario 25 — fault injection
# --------------------------------------------------------------------------


@pytest.fixture()
def exploding(plugin, ctx, monkeypatch):
    """Every hook body replaced with one that raises."""

    def boom(collector, **kwargs):
        raise RuntimeError("injected fault with sk-ant-AAAAAAAAAAAAAAAAAAAAAA inside")

    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setattr(plugin, "HOOK_BODIES", {k: boom for k in plugin.HOOK_BODIES})
    plugin.register(ctx)
    return plugin


def _drive_session(ctx, session_id="sess-1", turns=3):
    """Fire a plausible sequence of hooks for one session."""
    ctx.fire("on_session_start", session_id=session_id, model="m", platform="telegram")
    for turn in range(turns):
        ctx.fire("pre_llm_call", session_id=session_id, turn_id=f"t{turn}", user_message="hi")
        ctx.fire("pre_api_request", session_id=session_id, turn_id=f"t{turn}", api_request_id=f"r{turn}")
        ctx.fire("post_api_request", session_id=session_id, turn_id=f"t{turn}", api_request_id=f"r{turn}")
        ctx.fire("pre_tool_call", session_id=session_id, tool_name="shell")
        ctx.fire("post_tool_call", session_id=session_id, tool_name="shell")
        ctx.fire("post_llm_call", session_id=session_id, turn_id=f"t{turn}", assistant_response="ok")
        ctx.fire("on_session_end", session_id=session_id, turn_id=f"t{turn}")
    ctx.fire("on_session_finalize", session_id=session_id)


def test_no_exception_escapes_a_throwing_hook(exploding, ctx):
    """The fake ctx does not swallow exceptions; the plugin must not need it to."""
    _drive_session(ctx, turns=4)  # ~29 hook firings, all raising


def test_exactly_one_plugin_degraded_per_session(exploding, ctx, av):
    _drive_session(ctx, turns=4)
    collector = exploding._COLLECTOR
    events = av.read_buffer(collector)
    degraded = [e for e in events if e["event_type"] == "plugin.degraded"]
    assert len(degraded) == 1, av.types_of(events)
    payload = degraded[0]["payload"]
    assert payload["error_count"] == 10
    assert payload["scope"] == "session"
    assert payload["hook"] in exploding.HOOK_BODIES
    assert sum(payload["errors_by_hook"].values()) == 10


def test_remaining_hooks_are_no_ops_after_degrading(exploding, ctx, av):
    _drive_session(ctx, turns=4)
    collector = exploding._COLLECTOR
    state = collector.sessions["sess-1"]
    assert state.degraded is True
    before = len(av.read_buffer(collector))
    # Everything from here is inert: no counting, no events, no exceptions.
    for _ in range(20):
        ctx.fire("pre_tool_call", session_id="sess-1", tool_name="shell")
    assert state.failure_count == 10
    assert len(av.read_buffer(collector)) == before


def test_degrading_is_scoped_to_the_session(exploding, ctx):
    collector = exploding._COLLECTOR
    _drive_session(ctx, session_id="sess-1", turns=4)
    assert collector.sessions["sess-1"].degraded is True
    # A different session is a different breaker, and is unaffected.
    ctx.fire("on_session_start", session_id="sess-2", model="m", platform="telegram")
    assert collector.sessions["sess-2"].degraded is False


def test_the_degraded_event_carries_no_exception_message(exploding, ctx, av):
    """The message can quote the prompt or tool argument that caused the fault."""
    _drive_session(ctx, turns=4)
    events = av.read_buffer(exploding._COLLECTOR)
    degraded = [e for e in events if e["event_type"] == "plugin.degraded"][0]
    assert degraded["payload"]["last_error"] == "RuntimeError"
    assert "sk-ant-" not in __import__("json").dumps(degraded)


def test_a_slow_hook_is_counted_not_blocked(plugin, ctx, monkeypatch):
    """The 50 ms budget is observed, never enforced — aborting mid-hook is worse."""
    import time

    def slow(collector, **kwargs):
        time.sleep(0.06)

    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setattr(plugin, "HOOK_BODIES", {"pre_tool_call": slow})
    plugin.register(ctx)
    ctx.fire("pre_tool_call", session_id="s", tool_name="shell")
    assert plugin._COLLECTOR.overruns.get("pre_tool_call") == 1
    assert plugin._COLLECTOR.max_hook_ms >= 50


def test_pre_tool_call_never_returns_a_directive(plugin, ctx, monkeypatch):
    """A dict return from `pre_tool_call` would block the tool (plugins.py:6648)."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    results = ctx.fire("pre_tool_call", session_id="s", tool_name="shell", args={"a": 1})
    assert results == []


def test_pre_llm_call_never_injects_context(plugin, ctx, monkeypatch):
    """A str or {"context": ...} return would be appended to the user message."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    results = ctx.fire("pre_llm_call", session_id="s", user_message="hi", turn_id="t0")
    assert results == []
