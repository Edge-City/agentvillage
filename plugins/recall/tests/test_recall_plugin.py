"""The `recall` Hermes tool: registration, guards, the event, and the rebuild hook."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import types
from contextvars import ContextVar
from pathlib import Path

import pytest

QUERY = "Priya battery enclosure"


def snapshot(directory: Path) -> dict[str, str]:
    out = {}
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            out[str(path.relative_to(directory))] = f"{path.stat().st_mtime_ns}:{hashlib.sha256(path.read_bytes()).hexdigest()}"
    return out


def parse(text: str) -> dict:
    """Every result is the `[recall]` marker line, then one JSON object."""
    marker, _, body = text.partition("\n")
    assert marker == "[recall]", text[:40]
    return json.loads(body)


def call(ctx, args, **kwargs) -> dict:
    return parse(ctx.call(args, task_id="t", session_id="sess-1", user_task="u", **kwargs))


class NeverRun:
    def __init__(self):
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        raise AssertionError("the CLI must not run")


# --------------------------------------------------------------------------
# Registration
# --------------------------------------------------------------------------


def test_registers_one_tool_and_the_session_end_hook(recall, ctx):
    recall.register(ctx)
    assert list(ctx.tools) == ["recall"]
    tool = ctx.tools["recall"]
    assert tool["toolset"] == "recall"
    schema = tool["schema"]
    assert schema["name"] == "recall"
    assert set(schema["parameters"]["properties"]) == {"query", "since"}
    assert schema["parameters"]["required"] == ["query"]
    assert list(ctx.hooks) == ["on_session_finalize"]


def test_register_is_idempotent(recall, ctx):
    recall.register(ctx)
    recall.register(ctx)
    assert len(ctx.hooks["on_session_finalize"]) == 1


def test_manifest(recall):
    yaml = pytest.importorskip("yaml")
    manifest = yaml.safe_load((Path(recall.__file__).parent / "plugin.yaml").read_text(encoding="utf-8"))
    assert manifest["name"] == "recall"
    assert manifest["kind"] == "standalone"
    assert manifest["provides_tools"] == ["recall"]


# --------------------------------------------------------------------------
# End to end through the real CLI
# --------------------------------------------------------------------------


def test_returns_dated_snippets_with_refs(recall, ctx, home, bun_available, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    recall.register(ctx)
    result = call(ctx, {"query": QUERY})
    assert result["status"] == "ok"
    assert result["match"] == "all"
    refs = sorted(hit["ref"] for hit in result["hits"])
    assert refs == ["MEMORY.md:7-8", "memory/2026-09-20.md:3-4"]
    for hit in result["hits"]:
        assert set(hit) == {"date", "date_source", "kind", "ref", "snippet", "score"}
        assert hit["date"] in {"2026-09-19", "2026-09-20"}


def test_since_filter(recall, ctx, home, bun_available):
    recall.register(ctx)
    result = call(ctx, {"query": "Priya", "since": "2026-09-20"})
    assert [hit["ref"] for hit in result["hits"]] == ["memory/2026-09-20.md:3-4"]
    assert result["since"] == "2026-09-20"


def test_invalid_since_is_an_error_without_data_or_event(recall, ctx, home, bun_available):
    recall.register(ctx)
    result = call(ctx, {"query": "Priya", "since": "last tuesday"})
    assert result == {"status": "error", "reason": "invalid_since", "hit_count": 0, "hits": []}
    assert ctx.emitted == []


def test_never_writes_into_memory(recall, ctx, home, bun_available):
    before = snapshot(home / "memory")
    recall.register(ctx)
    call(ctx, {"query": QUERY})
    call(ctx, {"query": "microgrid", "since": "2026-09-21"})
    recall._RECALL._rebuild()
    assert snapshot(home / "memory") == before
    assert (home / ".recall" / "index.sqlite").is_file()
    assert (home / ".recall" / "query-hash.key").is_file()
    assert not any(p.name.startswith(("index", "query-hash")) for p in (home / "memory").rglob("*"))


def test_index_and_key_are_private_to_the_sandbox_user(recall, ctx, home, bun_available):
    recall.register(ctx)
    call(ctx, {"query": QUERY})
    assert stat.S_IMODE((home / ".recall").stat().st_mode) == 0o700
    assert stat.S_IMODE((home / ".recall" / "query-hash.key").stat().st_mode) == 0o600
    assert stat.S_IMODE((home / ".recall" / "index.sqlite").stat().st_mode) == 0o600


# --------------------------------------------------------------------------
# memory.recalled
# --------------------------------------------------------------------------


def test_emits_one_event_with_hash_counts_and_surface_only(recall, ctx, home, bun_available, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    recall.register(ctx)
    result = call(ctx, {"query": QUERY})

    assert len(ctx.emitted) == 1
    name, payload = ctx.emitted[0]
    assert name == "memory.recalled"
    assert set(payload) == {"query_hash", "hit_count", "top_score", "surface", "session_id"}
    assert payload["hit_count"] == result["hit_count"] == 2
    assert payload["top_score"] == result["top_score"]
    assert payload["surface"] == "telegram"
    assert payload["session_id"] == "sess-1"

    serialised = json.dumps(payload)
    for word in ("Priya", "battery", "enclosure", "memory/", "MEMORY.md", "heat sinks"):
        assert word.lower() not in serialised.lower()
    # Keyed: not the bare SHA-256 of the query, so a dictionary cannot reverse it.
    assert payload["query_hash"] != hashlib.sha256(QUERY.lower().encode()).hexdigest()
    assert len(payload["query_hash"]) == 64


def test_query_hash_is_stable_within_a_tenant_and_normalised(recall, ctx, home, bun_available):
    recall.register(ctx)
    call(ctx, {"query": "Priya  Battery"})
    call(ctx, {"query": "priya battery"})
    assert ctx.emitted[0][1]["query_hash"] == ctx.emitted[1][1]["query_hash"]


def test_a_miss_is_still_counted(recall, ctx, home, bun_available):
    recall.register(ctx)
    result = call(ctx, {"query": "zebracake"})
    assert result["hit_count"] == 0
    assert ctx.emitted[0][1]["hit_count"] == 0
    assert ctx.emitted[0][1]["top_score"] is None


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"HERMES_SESSION_PLATFORM": "telegram"}, "telegram"),
        ({"HERMES_SESSION_SOURCE": "cli"}, "desktop"),
        ({"HERMES_CRON_SESSION": "1", "HERMES_SESSION_PLATFORM": "telegram"}, "cron"),
        ({"HERMES_SESSION_PLATFORM": "Some Group Name"}, "other"),
        ({}, "unknown"),
    ],
)
def test_surface_is_a_bounded_vocabulary(recall, monkeypatch, env, expected):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert recall.surface() == expected
    assert recall.surface() in recall.SURFACES


def test_end_to_end_into_the_av_events_buffer(recall, home, bun_available, monkeypatch, rc):
    """recall publishes on the bus; av-events turns it into an envelope with no text."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    av = rc.load(rc.AV_EVENTS_DIR, "hermes_plugins.av_events")
    av._COLLECTOR = None
    av._REGISTERED = False
    bus = rc.Bus()
    try:
        av.register(rc.FakeCtx(plugin_key="av-events", bus=bus))
        ctx = rc.FakeCtx(plugin_key="recall", bus=bus)
        recall.register(ctx)
        call(ctx, {"query": QUERY})

        buffer_dir = Path(av._COLLECTOR.config.buffer_dir)
        lines = [
            json.loads(line)
            for path in sorted(buffer_dir.glob("*.jsonl"))
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        events = [e for e in lines if e["event_type"] == "memory.recalled"]
        assert len(events) == 1
        assert set(events[0]["payload"]) == {"query_hash", "hit_count", "top_score", "surface"}
        assert events[0]["session_id"] == "sess-1"
        raw = json.dumps(events[0])
        for word in ("Priya", "battery", "enclosure", "MEMORY.md"):
            assert word not in raw
    finally:
        if av._COLLECTOR is not None:
            av._COLLECTOR._stop.set()
            av._COLLECTOR._wake.set()
        av._COLLECTOR = None
        av._REGISTERED = False


# --------------------------------------------------------------------------
# Group-session refusal
# --------------------------------------------------------------------------


@pytest.mark.parametrize("chat_type", ["group", "forum", "channel", "thread", "guild", "brand-new-type"])
def test_refuses_outside_the_main_session(recall, ctx, home, monkeypatch, chat_type):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    runner = NeverRun()
    recall.register(ctx)
    recall._RECALL.runner = runner
    result = call(ctx, {"query": QUERY})
    assert result == {"status": "unavailable", "reason": "unavailable in group sessions", "hit_count": 0, "hits": []}
    assert runner.calls == []
    assert ctx.emitted == []
    assert not (home / ".recall").exists()


def _fake_gateway(monkeypatch, *, engaged: bool, bound: dict):
    """Install a stand-in for `gateway.session_context` with ContextVars."""
    unset = object()
    names = ("HERMES_SESSION_CHAT_TYPE", "HERMES_SESSION_PLATFORM", "HERMES_SESSION_SOURCE", "HERMES_CRON_SESSION")
    var_map = {name: ContextVar(f"test_{name}", default=unset) for name in names}
    for name, value in bound.items():
        var_map[name].set(value)
    sc = types.ModuleType("gateway.session_context")
    sc._UNSET = unset
    sc._VAR_MAP = var_map
    sc.session_context_engaged = lambda: engaged
    sc.get_session_env = lambda name, default="": os.environ.get(name, default)
    gateway = types.ModuleType("gateway")
    gateway.__path__ = []
    gateway.session_context = sc
    monkeypatch.setitem(sys.modules, "gateway", gateway)
    monkeypatch.setitem(sys.modules, "gateway.session_context", sc)


def bind(*, chat_type="", platform="", source="", cron=""):
    """Every session variable at once, the way `set_session_vars` binds them."""
    return {
        "HERMES_SESSION_CHAT_TYPE": chat_type,
        "HERMES_SESSION_PLATFORM": platform,
        "HERMES_SESSION_SOURCE": source,
        "HERMES_CRON_SESSION": cron,
    }


def test_task_local_group_context_wins_over_a_dm_env_mirror(recall, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")  # someone else's turn
    _fake_gateway(monkeypatch, engaged=True, bound=bind(chat_type="group", platform="telegram"))
    assert recall.is_private_session() is False


def test_task_local_dm_context_wins_over_a_group_env_mirror(recall, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    _fake_gateway(monkeypatch, engaged=True, bound=bind(chat_type="dm", platform="telegram"))
    assert recall.is_private_session() is True


def test_an_unbound_task_in_a_gateway_process_is_refused(recall, ctx, home, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    _fake_gateway(monkeypatch, engaged=True, bound={})
    runner = NeverRun()
    recall.register(ctx)
    recall._RECALL.runner = runner
    assert call(ctx, {"query": QUERY})["status"] == "unavailable"
    assert runner.calls == []


def test_a_cli_process_without_session_context_is_private(recall, monkeypatch):
    _fake_gateway(monkeypatch, engaged=False, bound={})
    assert recall.is_private_session() is True


def test_the_child_is_told_the_resolved_chat_type_and_gets_no_secrets(recall, ctx, home, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-secret")
    monkeypatch.setenv("AV_EVENTS_TOKEN", "tok")
    monkeypatch.setenv("AV_RECALL_BUN", sys.executable)  # any existing file
    seen = {}

    def runner(argv, env, stdin, timeout, cwd):
        seen.update(argv=argv, env=env, stdin=stdin)
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps({"status": "ok", "hits": [], "hit_count": 0}), stderr="")

    recall.register(ctx)
    recall._RECALL.runner = runner
    call(ctx, {"query": QUERY})
    assert seen["env"]["HERMES_SESSION_CHAT_TYPE"] == "dm"
    assert seen["env"]["HERMES_HOME"] == str(home)
    assert "OPENROUTER_API_KEY" not in seen["env"]
    assert "AV_EVENTS_TOKEN" not in seen["env"]
    # The query goes over stdin, never argv, so it is not visible in `ps`.
    assert seen["stdin"] == QUERY
    assert QUERY not in " ".join(seen["argv"])


# --------------------------------------------------------------------------
# Failure modes: whole-result status, never partial data
# --------------------------------------------------------------------------


def test_missing_skill_is_unavailable(recall, ctx, home):
    (home / "skills" / "recall" / "scripts" / "recall.ts").unlink()
    recall.register(ctx)
    result = call(ctx, {"query": QUERY})
    assert result["status"] == "unavailable"
    assert result["hits"] == []
    assert ctx.emitted == []


def test_missing_bun_is_unavailable(recall, ctx, home, monkeypatch):
    monkeypatch.setenv("AV_RECALL_BUN", str(home / "no-such-bun"))
    recall.register(ctx)
    assert call(ctx, {"query": QUERY})["status"] == "unavailable"


def test_kill_switch(recall, ctx, home, monkeypatch):
    monkeypatch.setenv("AV_RECALL_ENABLED", "off")
    runner = NeverRun()
    recall.register(ctx)
    recall._RECALL.runner = runner
    assert call(ctx, {"query": QUERY})["status"] == "unavailable"
    assert recall._RECALL.request_rebuild() is False


@pytest.mark.parametrize(
    "args",
    [{}, {"query": ""}, {"query": "   "}, {"query": 42}, {"query": "x" * 501}, {"query": "a", "since": 20260920}, None],
)
def test_bad_arguments_are_errors(recall, ctx, home, args):
    runner = NeverRun()
    recall.register(ctx)
    recall._RECALL.runner = runner
    result = parse(ctx.call(args))
    assert result["status"] == "error"
    assert result["hits"] == []


@pytest.mark.parametrize(
    "outcome",
    [
        subprocess.TimeoutExpired(cmd="bun", timeout=15),
        OSError("exec format error"),
        subprocess.CompletedProcess([], 1, stdout="", stderr="boom"),
        subprocess.CompletedProcess([], 0, stdout="not json", stderr=""),
        subprocess.CompletedProcess([], 0, stdout="[1, 2]", stderr=""),
        subprocess.CompletedProcess([], 0, stdout=json.dumps({"status": "error", "reason": "internal_error", "hits": [{"ref": "x"}]}), stderr=""),
    ],
)
def test_cli_failures_return_no_partial_data(recall, ctx, home, monkeypatch, outcome):
    monkeypatch.setenv("AV_RECALL_BUN", sys.executable)

    def runner(*args):
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    recall.register(ctx)
    recall._RECALL.runner = runner
    result = call(ctx, {"query": QUERY})
    assert result["status"] in {"error", "unavailable"}
    assert result["hits"] == []
    assert result["hit_count"] == 0
    assert ctx.emitted == []


def test_an_emit_failure_does_not_break_the_tool(recall, ctx, home, bun_available, monkeypatch):
    def broken_emit(event, payload=None):
        raise RuntimeError("event bus full")

    monkeypatch.setattr(ctx, "emit", broken_emit)
    recall.register(ctx)
    result = call(ctx, {"query": QUERY})
    assert result["status"] == "ok"
    assert result["hit_count"] == 2


# --------------------------------------------------------------------------
# Session-end rebuild
# --------------------------------------------------------------------------


def test_session_end_starts_one_background_rebuild(recall, ctx, home, monkeypatch):
    monkeypatch.setenv("AV_RECALL_BUN", sys.executable)
    calls = []

    def runner(argv, env, stdin, timeout, cwd):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout="{}", stderr="")

    recall.register(ctx)
    recall._RECALL.runner = runner
    for callback in ctx.hooks["on_session_finalize"]:
        assert callback(session_id="sess-1", platform="telegram") is None
    # Debounced: an immediate second finalize does not start another.
    for thread in [t for t in __import__("threading").enumerate() if t.name == "recall-rebuild"]:
        thread.join(timeout=5)
    assert recall._RECALL.request_rebuild() is False
    assert len(calls) == 1
    assert calls[0][-1] == "rebuild"


def test_session_end_hook_never_raises(recall, ctx, home, monkeypatch):
    recall.register(ctx)

    def explode():
        raise RuntimeError("thread limit")

    monkeypatch.setattr(recall._RECALL, "request_rebuild", explode)
    assert ctx.hooks["on_session_finalize"][0](session_id="s") is None


def test_real_rebuild_indexes_the_workspace(recall, ctx, home, bun_available):
    recall.register(ctx)
    recall._RECALL._rebuild()
    assert (home / ".recall" / "index.sqlite").is_file()
