"""Refutation fixes for DATA-83: main-session rule, result marker, flags, key file, hashing, budget."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import types
from contextvars import ContextVar, copy_context
from pathlib import Path

import pytest

QUERY = "Priya battery enclosure"
HERMES_SRC = Path(os.environ.get("HERMES_AGENT_SRC") or Path.home() / ".hermes" / "hermes-agent")


def parse(text: str) -> dict:
    marker, _, body = text.partition("\n")
    assert marker == "[recall]"
    return json.loads(body)


def call(ctx, args, session_id="sess-1") -> dict:
    return parse(ctx.call(args, task_id="t", session_id=session_id, user_task="u"))


class NeverRun:
    def __init__(self):
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        raise AssertionError("the CLI must not run")


def ok_runner(payload: dict, seen: dict | None = None):
    def runner(argv, env, stdin, timeout, cwd):
        if seen is not None:
            seen.update(argv=argv, env=env, stdin=stdin)
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(payload), stderr="")

    return runner


def fake_gateway(monkeypatch, *, engaged: bool, bound: dict):
    unset = object()
    names = (
        "HERMES_SESSION_CHAT_TYPE",
        "HERMES_SESSION_PLATFORM",
        "HERMES_SESSION_SOURCE",
        "HERMES_CRON_SESSION",
        "HERMES_SESSION_ID",
    )
    var_map = {name: ContextVar(f"hardening_{name}", default=unset) for name in names}
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


def bound(chat_type="", platform="", source="", cron="", session_id=""):
    return {
        "HERMES_SESSION_CHAT_TYPE": chat_type,
        "HERMES_SESSION_PLATFORM": platform,
        "HERMES_SESSION_SOURCE": source,
        "HERMES_CRON_SESSION": cron,
        "HERMES_SESSION_ID": session_id,
    }


# --------------------------------------------------------------------------
# HIGH 1 — the main-session rule
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "binding"),
    [
        ("cron delivering to a group (empty chat type)", bound(cron="1")),
        ("cron bound as a DM", bound(chat_type="dm", platform="telegram", cron="1")),
        ("cron_ session id", bound(session_id="cron_job_1")),
        ("cron platform", bound(platform="cron")),
        ("api_server turn", bound(platform="api_server")),
        ("ACP editor turn", bound(source="acp")),
        ("webhook", bound(chat_type="webhook", platform="webhook")),
        ("messaging platform without a chat type", bound(platform="telegram")),
        ("gateway turn with nothing bound", bound()),
        ("telegram group", bound(chat_type="group", platform="telegram")),
    ],
)
def test_not_the_main_session(recall, ctx, home, monkeypatch, label, binding):
    fake_gateway(monkeypatch, engaged=True, bound=binding)
    runner = NeverRun()
    recall.register(ctx)
    recall._RECALL.runner = runner
    result = call(ctx, {"query": QUERY})
    assert result == {"status": "unavailable", "reason": "unavailable in group sessions", "hit_count": 0, "hits": []}
    assert runner.calls == []
    assert ctx.emitted == []


def test_a_cron_session_id_passed_by_the_dispatcher_is_refused(recall, ctx, home, monkeypatch):
    fake_gateway(monkeypatch, engaged=True, bound=bound(platform="cli"))
    recall.register(ctx)
    recall._RECALL.runner = NeverRun()
    assert call(ctx, {"query": QUERY}, session_id="cron_abc_20260922")["status"] == "unavailable"


@pytest.mark.parametrize(
    "binding",
    [
        bound(chat_type="dm", platform="telegram"),
        bound(source="cli"),
        bound(source="desktop"),
        bound(platform="tui"),
    ],
)
def test_the_main_session(recall, monkeypatch, binding):
    fake_gateway(monkeypatch, engaged=True, bound=binding)
    assert recall.is_private_session() is True


def test_the_plain_cli_still_works_end_to_end(recall, ctx, home, bun_available, monkeypatch):
    fake_gateway(monkeypatch, engaged=False, bound={})
    recall.register(ctx)
    result = call(ctx, {"query": QUERY})
    assert result["status"] == "ok"
    assert result["hit_count"] == 2


@pytest.fixture()
def real_session_context(monkeypatch):
    """The real `gateway.session_context`, imported read-only and unloaded after.

    `set_session_vars` latches a process-wide "engaged" flag; it is restored,
    and the modules removed, so no later test sees a gateway process.
    """
    if not (HERMES_SRC / "gateway" / "session_context.py").is_file():
        pytest.skip("Hermes source not available (set HERMES_AGENT_SRC)")
    before = set(sys.modules)
    sys.path.insert(0, str(HERMES_SRC))
    try:
        from gateway import session_context as sc  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Hermes gateway not importable: {exc}")
    finally:
        sys.path.remove(str(HERMES_SRC))
    monkeypatch.setattr(sc, "_session_context_engaged", sc._session_context_engaged)
    yield sc
    for name in set(sys.modules) - before:
        if name == "gateway" or name.startswith("gateway."):
            del sys.modules[name]


def test_real_hermes_cron_binding_delivering_to_a_group_is_refused(recall, ctx, home, real_session_context):
    """The refuter's probe: a real cron binding that auto-delivers to -100123."""
    sc = real_session_context
    recall.register(ctx)
    runner = NeverRun()
    recall._RECALL.runner = runner

    def cron_turn():
        sc.set_session_vars(platform="", chat_id="", chat_name="", async_delivery=False)
        sc._VAR_MAP["HERMES_CRON_SESSION"].set("1")
        sc._VAR_MAP["HERMES_CRON_AUTO_DELIVER_PLATFORM"].set("telegram")
        sc._VAR_MAP["HERMES_CRON_AUTO_DELIVER_CHAT_ID"].set("-100123")
        return call(ctx, {"query": QUERY})

    assert copy_context().run(cron_turn)["status"] == "unavailable"

    def api_turn():
        sc.set_session_vars(platform="api_server", chat_id="x", cron_session="", async_delivery=False)
        return call(ctx, {"query": QUERY})

    assert copy_context().run(api_turn)["status"] == "unavailable"

    def group_turn():
        sc.set_session_vars(platform="telegram", chat_type="group", chat_id="-100123", cron_session="")
        return call(ctx, {"query": QUERY})

    assert copy_context().run(group_turn)["status"] == "unavailable"
    assert runner.calls == []

    def dm_turn():
        sc.set_session_vars(platform="telegram", chat_type="dm", chat_id="1", cron_session="")
        return recall.is_private_session()

    assert copy_context().run(dm_turn) is True


def test_a_plain_cli_verdict_is_passed_to_the_child_as_platform_cli(recall, ctx, home, monkeypatch):
    fake_gateway(monkeypatch, engaged=False, bound={})
    monkeypatch.setenv("AV_RECALL_BUN", sys.executable)
    seen: dict = {}
    recall.register(ctx)
    recall._RECALL.runner = ok_runner({"status": "ok", "hits": [], "hit_count": 0}, seen)
    call(ctx, {"query": QUERY})
    assert seen["env"]["HERMES_SESSION_CHAT_TYPE"] == ""
    assert seen["env"]["HERMES_SESSION_PLATFORM"] == "cli"


def test_query_terms_are_cut_at_64_code_points(recall):
    term = recall.query_terms("\U0001D49C" * 70)[0]
    assert len(term) == 64


def test_the_child_gets_the_resolved_surface(recall, ctx, home, monkeypatch):
    fake_gateway(monkeypatch, engaged=True, bound=bound(chat_type="dm", platform="telegram"))
    monkeypatch.setenv("AV_RECALL_BUN", sys.executable)
    seen: dict = {}
    recall.register(ctx)
    recall._RECALL.runner = ok_runner({"status": "ok", "hits": [], "hit_count": 0}, seen)
    call(ctx, {"query": QUERY})
    assert seen["env"]["HERMES_SESSION_CHAT_TYPE"] == "dm"
    assert seen["env"]["HERMES_SESSION_PLATFORM"] == "telegram"


# --------------------------------------------------------------------------
# MEDIUM 2 — the result marker
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "setup",
    ["ok", "refused", "error", "crash"],
)
def test_every_result_starts_with_the_marker_line(recall, ctx, home, monkeypatch, setup):
    monkeypatch.setenv("AV_RECALL_BUN", sys.executable)
    recall.register(ctx)
    args = {"query": QUERY}
    if setup == "ok":
        recall._RECALL.runner = ok_runner({"status": "ok", "hits": [], "hit_count": 0})
    elif setup == "refused":
        monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    elif setup == "error":
        args = {"query": ""}
    else:
        monkeypatch.setattr(recall, "hermes_home", lambda: (_ for _ in ()).throw(RuntimeError("x")))
    text = ctx.call(args)
    assert text.startswith("[recall]\n")
    json.loads(text.split("\n", 1)[1])


# --------------------------------------------------------------------------
# 4 — flags accept only 1|true|yes|on
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["disabled", "n", "none", "null", "0", "off", "", "enable"])
def test_kill_switch_values_that_are_not_on(recall, ctx, home, monkeypatch, value):
    monkeypatch.setenv("AV_RECALL_ENABLED", value)
    recall.register(ctx)
    recall._RECALL.runner = NeverRun()
    assert call(ctx, {"query": QUERY})["status"] == "unavailable"


@pytest.mark.parametrize("value", ["1", "true", "YES", " On "])
def test_kill_switch_values_that_are_on(recall, monkeypatch, value):
    monkeypatch.setenv("AV_RECALL_ENABLED", value)
    assert recall.enabled() is True


def test_kill_switch_unset_means_the_loaded_plugin_is_on(recall, monkeypatch):
    monkeypatch.delenv("AV_RECALL_ENABLED", raising=False)
    assert recall.enabled() is True


# --------------------------------------------------------------------------
# 5 — the key file
# --------------------------------------------------------------------------


def test_key_file_is_64_hex_mode_0600_and_stable(recall, home):
    first = recall.query_hash(home, "priya")
    key = (home / ".recall" / "query-hash.key").read_text()
    assert len(key) == 64 and all(c in "0123456789abcdef" for c in key)
    assert stat.S_IMODE((home / ".recall" / "query-hash.key").stat().st_mode) == 0o600
    assert recall.query_hash(home, "priya") == first
    assert not [p for p in (home / ".recall").iterdir() if p.name.startswith(".query-hash")]


@pytest.mark.parametrize("content", ["", "zz-not-hex", "a" * 63, "A" * 64, "a" * 65])
def test_a_malformed_key_is_regenerated_and_counted(recall, home, content, caplog):
    (home / ".recall").mkdir(mode=0o700)
    (home / ".recall" / "query-hash.key").write_text(content)
    before = recall.KEY_REGENERATIONS
    with caplog.at_level("INFO"):
        digest = recall.query_hash(home, "priya")
    key = (home / ".recall" / "query-hash.key").read_text()
    assert len(key) == 64 and key != content
    assert recall.KEY_REGENERATIONS == before + 1
    assert stat.S_IMODE((home / ".recall" / "query-hash.key").stat().st_mode) == 0o600
    # The log line carries a count, never the key or the query.
    assert key not in caplog.text and "priya" not in caplog.text
    assert len(digest) == 64


def test_concurrent_first_use_agrees_on_one_key(recall, home):
    import threading

    digests = []
    barrier = threading.Barrier(8)

    def worker():
        barrier.wait()
        digests.append(recall.query_hash(home, "priya"))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(set(digests)) == 1


# --------------------------------------------------------------------------
# 11 — hashing normalises with the CLI's term extraction
# --------------------------------------------------------------------------


def test_query_hash_uses_the_search_terms(recall, home):
    assert recall.query_terms("Priya's  BATTERY, battery!") == ["priya", "s", "battery"]
    assert recall.query_hash(home, "Priya's  BATTERY, battery!") == recall.query_hash(home, "priya s battery")
    assert recall.query_hash(home, "priya battery") != recall.query_hash(home, "battery priya")


# --------------------------------------------------------------------------
# 7 — `partial` reaches the model, never the event
# --------------------------------------------------------------------------


def test_partial_is_in_the_result_and_not_in_the_event(recall, ctx, home, monkeypatch):
    monkeypatch.setenv("AV_RECALL_BUN", sys.executable)
    recall.register(ctx)
    recall._RECALL.runner = ok_runner(
        {"status": "ok", "hits": [], "hit_count": 0, "top_score": None, "partial": True, "match": "none"}
    )
    result = call(ctx, {"query": QUERY})
    assert result["partial"] is True
    assert "partial" not in ctx.emitted[0][1]


def test_since_is_validated_before_it_reaches_argv(recall, ctx, home, monkeypatch):
    monkeypatch.setenv("AV_RECALL_BUN", sys.executable)
    recall.register(ctx)
    recall._RECALL.runner = NeverRun()
    for bad in ("--no-rebuild", "../../etc/passwd", "2026-09-20T../../x", "2026/09/20"):
        assert call(ctx, {"query": QUERY, "since": bad})["reason"] == "invalid_since"
    seen: dict = {}
    recall._RECALL.runner = ok_runner({"status": "ok", "hits": [], "hit_count": 0}, seen)
    call(ctx, {"query": QUERY, "since": "2026-09-20T08:00:00Z"})
    assert seen["argv"][-2:] == ["--since", "2026-09-20"]
