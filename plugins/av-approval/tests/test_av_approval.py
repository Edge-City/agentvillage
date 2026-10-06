"""av-approval: the receipts stub sends nothing; the backstop (DATA-234) blocks gated calls while the gate is unverified."""

from __future__ import annotations

import builtins
import json
import logging
import os
import re
import subprocess
import time
from pathlib import Path

import pytest
import yaml

from .conftest import PLUGIN_DIR, ExplodingCtx, FakeCtx, load_plugin

REPO = PLUGIN_DIR.parents[1]


def _lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "av-approval" and r.levelno >= logging.WARNING]


def _settle(facade) -> None:
    # Anything the plugin might have sent asynchronously would land well within this.
    time.sleep(0.2)


def _callback(ctx: FakeCtx):
    assert list(ctx.hooks) == ["pre_tool_call"] and len(ctx.hooks["pre_tool_call"]) == 1
    return ctx.hooks["pre_tool_call"][0]


GATED_SAMPLE = ("terminal", "write_file", "patch", "read_file", "search_files", "execute_code", "process",
                "process_manage", "web_extract", "browser_exec", "browser_navigate", "skill_manage",
                "delegate_task", "cronjob_manage", "cronjob", "send_message",
                # R3b (DATA-344): the side-effecting tools the policy's tools: list judges.
                "mcp__index__create_intent", "mcp__index__update_intent", "mcp__index__archive_intent",
                "mcp__index__pause_intent", "mcp__index__resume_intent", "mcp__index__accept_opportunity",
                "mcp__index__reject_opportunity", "mcp__index__update_my_profile", "mcp__index__enrich_my_profile",
                "index_create_intent", "index_update_opportunity", "index_research_profile",
                "image_generate", "video_generate", "text_to_speech", "web_search", "x_search")
UNGATED_SAMPLE = ("memory", "todo_list", "mcp_index_search", "cronjob_manager", "mcp__index__list_intents",
                  "mcp__index__get_opportunity", "index_read_intents", "skill_view", "record_intention", "recall",
                  "vision_analyze", "index_accept_opportunity", "index_open_app", None)


# ---------------------------------------------------------------------------
# The manifest and the off/unset states (unchanged behaviour)
# ---------------------------------------------------------------------------

def test_manifest_is_a_backend_plugin_that_declares_its_env_and_hook():
    manifest = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    assert manifest["name"] == "av-approval"
    assert manifest["kind"] == "backend"
    assert set(manifest["optional_env"]) == {"AV_APPROVAL_ENABLED", "AV_APPROVAL_URL", "AV_APPROVAL_TOKEN"}
    assert manifest["provides_hooks"] == ["pre_tool_call"]
    assert manifest["version"] == load_plugin().PLUGIN_VERSION


@pytest.mark.parametrize("value", [None, "", "  "])
def test_unset_is_silent_and_registers_nothing(clean_env, facade, caplog, value, tmp_path):
    if value is not None:
        clean_env.setenv("AV_APPROVAL_ENABLED", value)
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    plugin = load_plugin()
    ctx = FakeCtx()
    with caplog.at_level(logging.DEBUG, logger="av-approval"):
        plugin.register(ctx)
    assert [r.getMessage() for r in caplog.records if r.name == "av-approval"] == []
    assert ctx.hooks == {} and ctx.tools == []
    _settle(facade)
    assert facade.requests == []


@pytest.mark.parametrize("value", ["0", "off", "false", "no", "disabled"])
def test_off_with_no_gate_entries_logs_fail_open_once(clean_env, facade, caplog, value, tmp_path):
    clean_env.setenv("AV_APPROVAL_ENABLED", value)
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.setenv("AV_APPROVAL_URL", facade.url)
    clean_env.setenv("AV_APPROVAL_TOKEN", "agent-token-for-tests")
    (tmp_path / "config.yaml").write_text(
        "hooks:\n  pre_tool_call:\n    - matcher: terminal\n      command: /usr/local/bin/other.sh\n", encoding="utf-8"
    )
    plugin = load_plugin()
    ctx = FakeCtx()
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(ctx)
        plugin.register(ctx)
    assert _lines(caplog) == [plugin.DISABLED_LINE]
    assert plugin.DISABLED_LINE == "av-approval: disabled (fail-open)"
    # The backstop belongs to the enforced-on mode only: off registers nothing.
    assert ctx.hooks == {} and ctx.tools == []
    _settle(facade)
    assert facade.requests == []


def test_off_with_gate_entries_still_present_does_not_claim_fail_open(clean_env, caplog, tmp_path):
    clean_env.setenv("AV_APPROVAL_ENABLED", "0")
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    shim = tmp_path / "agent-hooks" / "hermes-hook-shim.sh"
    (tmp_path / "config.yaml").write_text(
        f"hooks:\n  pre_tool_call:\n    - matcher: terminal\n      command: {shim}\n      fail_closed: true\n",
        encoding="utf-8",
    )
    plugin = load_plugin()
    ctx = FakeCtx()
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(ctx)
    assert _lines(caplog) == [plugin.STILL_GATED_LINE]
    assert ctx.hooks == {}


def test_off_with_unreadable_config_reads_as_ungated(clean_env, caplog, tmp_path):
    clean_env.setenv("AV_APPROVAL_ENABLED", "off")
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text("hooks: [unclosed\n", encoding="utf-8")
    plugin = load_plugin()
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(FakeCtx())
    assert _lines(caplog) == [plugin.DISABLED_LINE]


# ---------------------------------------------------------------------------
# On, healthy: the backstop is registered and never blocks
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
def test_on_and_healthy_logs_receipts_once_registers_the_backstop_and_sends_nothing(gate, facade, caplog, value):
    mp, home, plugin = gate
    mp.setenv("AV_APPROVAL_ENABLED", value)
    mp.setenv("AV_APPROVAL_TOKEN", "agent-token-for-tests")
    ctx = FakeCtx()
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(ctx)
    assert _lines(caplog) == [
        "av-approval: receipts disabled (no facade receipt surface at approval-md 6b74ca72)"
    ]
    assert plugin.HOOKS == ("pre_tool_call",)
    cb = _callback(ctx)
    for tool in GATED_SAMPLE + UNGATED_SAMPLE:
        assert cb(tool_name=tool, args={"command": "ls"}, session_id="s") is None
    assert ctx.tools == []
    _settle(facade)
    assert facade.requests == []


def test_healthy_never_blocks_even_after_many_rechecks(gate, monkeypatch):
    mp, home, plugin = gate
    clock = [1000.0]
    monkeypatch.setattr(plugin.time, "monotonic", lambda: clock[0])
    ctx = FakeCtx()
    plugin.register(ctx)
    cb = _callback(ctx)
    for _ in range(5):
        clock[0] += 61
        for tool in GATED_SAMPLE:
            assert cb(tool_name=tool) is None


def test_matchers_are_full_match_and_equal_the_installers():
    plugin = load_plugin()
    for tool in GATED_SAMPLE:
        assert plugin.is_gated(tool), tool
    for tool in UNGATED_SAMPLE:
        assert not plugin.is_gated(tool), tool
    source = (REPO / "install" / "install_approval.ts").read_text(encoding="utf-8")
    block = re.search(r"export const APPROVAL_GATED_TOOLS = \[(.*?)\] as const;", source, re.S)
    assert block is not None
    assert tuple(re.findall(r'"([^"]+)"', block.group(1))) == plugin.GATED_MATCHERS


# ---------------------------------------------------------------------------
# On, broken: every gated call raises, every ungated one passes
# ---------------------------------------------------------------------------

def _set_entries(home: Path, mutate) -> None:
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    mutate(cfg)
    (home / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")


def _entry(cfg, matcher):
    return next(e for e in cfg["hooks"]["pre_tool_call"] if e["matcher"] == matcher)


def _without(cfg, matcher) -> None:
    cfg["hooks"]["pre_tool_call"] = [e for e in cfg["hooks"]["pre_tool_call"] if e["matcher"] != matcher]


def _break(name: str, home: Path, mp) -> None:
    shim = home / "agent-hooks" / "hermes-hook-shim.sh"
    marker = home / "agent-hooks" / "approval-surface.json"
    lock = home / "shell-hooks-allowlist.json.lock"
    allow = home / "shell-hooks-allowlist.json"
    if name == "hook-missing:terminal":
        _set_entries(home, lambda c: _without(c, "terminal"))
    elif name == "hook-missing:cronjob(_manage)?":
        _set_entries(home, lambda c: _without(c, "cronjob(_manage)?"))
    elif name == "fail-closed-off:terminal":
        _set_entries(home, lambda c: _entry(c, "terminal").__setitem__("fail_closed", False))
    elif name == "fail-closed-off:patch(string)":
        _set_entries(home, lambda c: _entry(c, "patch").__setitem__("fail_closed", "true"))
    elif name == "entry-timeout:browser_.*":
        _set_entries(home, lambda c: _entry(c, "browser_.*").__setitem__("timeout", 60))
    elif name == "entry-timeout:delegate_task(missing)":
        _set_entries(home, lambda c: _entry(c, "delegate_task").pop("timeout"))
    elif name == "hooks-missing":
        _set_entries(home, lambda c: c.pop("hooks"))
    elif name == "consent-missing:config":
        _set_entries(home, lambda c: c.__setitem__("hooks_auto_accept", False))
    elif name == "config-unreadable":
        (home / "config.yaml").write_text("hooks: [unclosed\n", encoding="utf-8")
    elif name == "config-missing":
        (home / "config.yaml").unlink()
    elif name == "consent-missing:env-file":
        (home / ".env").write_text("AV_EVENTS_TOKEN=keep\n# HERMES_ACCEPT_HOOKS=1\n", encoding="utf-8")
    elif name == "consent-missing:env":
        mp.delenv("HERMES_ACCEPT_HOOKS")
    elif name == "allowlist-lock-unusable(000)":
        lock.write_text("", encoding="utf-8")
        lock.chmod(0)
    elif name == "allowlist-lock-unusable(dir)":
        lock.mkdir()
    elif name == "allowlist-lock-unusable(link)":
        (home / "elsewhere").write_text("", encoding="utf-8")
        lock.symlink_to(home / "elsewhere")
    elif name == "allowlist-lock-unusable(read-only)":
        lock.write_text("", encoding="utf-8")
        lock.chmod(0o400)
    elif name == "allowlist-unusable(000)":
        allow.write_text('{"approvals": []}', encoding="utf-8")
        allow.chmod(0)
    elif name == "allowlist-lock-uncreatable":
        home.chmod(0o500)
    elif name == "shim-missing":
        shim.unlink()
    elif name == "shim-not-executable":
        shim.chmod(0o600)
    elif name == "shim-hash-mismatch":
        shim.write_text(shim.read_text(encoding="utf-8") + "# planted\n", encoding="utf-8")
    elif name == "manifest-missing":
        marker.unlink()
    elif name == "manifest-missing(no digest)":
        marker.write_text('{"prior": {}}', encoding="utf-8")
    elif name == "url-missing":
        mp.delenv("AV_APPROVAL_URL")
    else:  # pragma: no cover
        raise AssertionError(name)


BROKEN = [
    "hook-missing:terminal",
    "hook-missing:cronjob(_manage)?",
    "fail-closed-off:terminal",
    "fail-closed-off:patch(string)",
    "entry-timeout:browser_.*",
    "entry-timeout:delegate_task(missing)",
    "hooks-missing",
    "consent-missing:config",
    "config-unreadable",
    "config-missing",
    "consent-missing:env-file",
    "consent-missing:env",
    "allowlist-lock-unusable(000)",
    "allowlist-lock-unusable(dir)",
    "allowlist-lock-unusable(link)",
    "allowlist-lock-unusable(read-only)",
    "allowlist-unusable(000)",
    "allowlist-lock-uncreatable",
    "shim-missing",
    "shim-not-executable",
    "shim-hash-mismatch",
    "manifest-missing",
    "manifest-missing(no digest)",
    "url-missing",
]

#: Every case whose fixture name is not its code.
_CODES = {
    "hook-missing:cronjob(_manage)?": "hook-missing:cronjob(_manage)?",
    "fail-closed-off:patch(string)": "fail-closed-off:patch",
    "entry-timeout:delegate_task(missing)": "entry-timeout:delegate_task",
    "config-missing": "config-unreadable",
    "manifest-missing(no digest)": "manifest-missing",
    "allowlist-lock-unusable(000)": "allowlist-lock-unusable",
    "allowlist-lock-unusable(dir)": "allowlist-lock-unusable",
    "allowlist-lock-unusable(link)": "allowlist-lock-unusable",
    "allowlist-lock-unusable(read-only)": "allowlist-lock-unusable",
    "allowlist-unusable(000)": "allowlist-unusable",
}


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads and writes past every mode bit")
@pytest.mark.parametrize("name", BROKEN)
def test_each_broken_state_blocks_every_gated_call_and_never_an_ungated_one(gate, caplog, name):
    mp, home, plugin = gate
    _break(name, home, mp)
    ctx = FakeCtx()
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(ctx)
    cb = _callback(ctx)
    code = _CODES.get(name, name)
    codes = plugin.current_codes()
    assert code in codes, codes
    for tool in GATED_SAMPLE:
        with pytest.raises(plugin.GateUnverified) as err:
            cb(tool_name=tool, args={"command": "ls"})
        assert str(err.value) == f"av-approval: gate unverified ({codes[0]})"
    for tool in UNGATED_SAMPLE:
        assert cb(tool_name=tool) is None
    start_lines = [line for line in _lines(caplog) if "unverified at start" in line]
    assert len(start_lines) == 1 and code in start_lines[0]


def test_a_raising_callback_is_hermes_s_block(gate):
    """What Hermes's invoke_hook does with it (hermes_cli/plugins_dispatch.py at v2026.9.24, lines 226-242):
    a fail-closed hook's callback that raises appends a block directive naming the error."""
    mp, home, plugin = gate
    _break("shim-hash-mismatch", home, mp)
    ctx = FakeCtx()
    plugin.register(ctx)
    cb = _callback(ctx)
    results = []
    try:
        cb(tool_name="terminal", args={})
    except (Exception, SystemExit) as exc:  # the replica of invoke_hook's except clause
        results.append({"action": "block",
                        "message": f"pre_tool_call plugin callback {cb.__name__} raised {type(exc).__name__}: {str(exc)[:200]}"})
    assert results == [{"action": "block", "message": "pre_tool_call plugin callback _pre_tool_call raised GateUnverified: "
                                                      "av-approval: gate unverified (shim-hash-mismatch)"}]


# ---------------------------------------------------------------------------
# Timing: sticky at start, re-checked at most once a minute after
# ---------------------------------------------------------------------------

def test_a_failure_found_at_start_is_sticky_until_restart(gate, monkeypatch):
    mp, home, plugin = gate
    clock = [1000.0]
    monkeypatch.setattr(plugin.time, "monotonic", lambda: clock[0])
    lock = home / "shell-hooks-allowlist.json.lock"
    lock.write_text("", encoding="utf-8")
    lock.chmod(0)
    ctx = FakeCtx()
    plugin.register(ctx)
    cb = _callback(ctx)
    with pytest.raises(plugin.GateUnverified):
        cb(tool_name="terminal")
    # Repairing the lock after start does not register the hooks Hermes skipped: still blocked.
    lock.chmod(0o600)
    clock[0] += 3600
    with pytest.raises(plugin.GateUnverified, match=r"allowlist-lock-unusable"):
        cb(tool_name="terminal")
    # A restart (a fresh load and register) with the gate intact clears it.
    fresh = load_plugin()
    ctx2 = FakeCtx()
    fresh.register(ctx2)
    assert _callback(ctx2)(tool_name="terminal") is None


def test_a_later_failure_is_found_within_a_minute_and_clears_when_repaired(gate, monkeypatch, caplog):
    mp, home, plugin = gate
    clock = [1000.0]
    monkeypatch.setattr(plugin.time, "monotonic", lambda: clock[0])
    ctx = FakeCtx()
    plugin.register(ctx)
    cb = _callback(ctx)
    shim = home / "agent-hooks" / "hermes-hook-shim.sh"
    original = shim.read_bytes()
    shim.write_bytes(original + b"# planted\n")
    clock[0] += 30
    assert cb(tool_name="terminal") is None  # inside the minute: not re-checked yet
    clock[0] += 31
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        with pytest.raises(plugin.GateUnverified, match=r"shim-hash-mismatch"):
            cb(tool_name="terminal")
        assert cb(tool_name="memory") is None
        shim.write_bytes(original)
        clock[0] += 10
        with pytest.raises(plugin.GateUnverified):
            cb(tool_name="write_file")  # still inside the minute of the failing check
        clock[0] += 60
        assert cb(tool_name="terminal") is None
    assert any("gate unverified (shim-hash-mismatch); gated tool calls are blocked while it lasts" in line
               for line in _lines(caplog))
    assert plugin.RECOVERED_LINE in _lines(caplog)


def test_the_check_runs_at_most_once_a_minute_and_reparses_config_only_on_change(gate, monkeypatch):
    mp, home, plugin = gate
    clock = [1000.0]
    monkeypatch.setattr(plugin.time, "monotonic", lambda: clock[0])
    checks = []
    real = plugin.integrity_problems
    monkeypatch.setattr(plugin, "integrity_problems", lambda *a, **k: checks.append(1) or real(*a, **k))
    parses = []
    real_load = yaml.safe_load
    monkeypatch.setattr(yaml, "safe_load", lambda *a, **k: parses.append(1) or real_load(*a, **k))
    ctx = FakeCtx()
    plugin.register(ctx)
    cb = _callback(ctx)
    assert (len(checks), len(parses)) == (1, 1)
    for _ in range(100):
        cb(tool_name="terminal")
        clock[0] += 0.5
    assert len(checks) == 1  # 50 s of calls: no re-check
    clock[0] += 11
    cb(tool_name="terminal")
    assert (len(checks), len(parses)) == (2, 1)  # re-checked; config unchanged, not re-parsed
    for _ in range(10):
        cb(tool_name="memory")  # ungated calls never check
        clock[0] += 61
    assert len(checks) == 2
    _set_entries(home, lambda c: c.__setitem__("model", {"default": "other"}))
    parses.clear()
    cb(tool_name="terminal")
    assert (len(checks), len(parses)) == (3, 1)


# ---------------------------------------------------------------------------
# The token, the ctx, the log
# ---------------------------------------------------------------------------

class _RecordingEnviron(dict):
    def __init__(self, data, seen):
        super().__init__(data)
        self._seen = seen

    def get(self, key, default=None):
        self._seen.append(key)
        return super().get(key, default)

    def __getitem__(self, key):
        self._seen.append(key)
        return super().__getitem__(key)

    def __contains__(self, key):
        self._seen.append(key)
        return super().__contains__(key)


@pytest.mark.parametrize("broken", [None, "shim-hash-mismatch", "consent-missing:env-file"])
def test_the_check_never_reads_the_token(gate, monkeypatch, caplog, broken):
    mp, home, plugin = gate
    sentinel = "agent-token-SENTINEL-4242"
    # Both token shapes present: the hosted dogfood's .env line and the co-located file.
    (home / ".env").write_text(
        ("" if broken == "consent-missing:env-file" else "HERMES_ACCEPT_HOOKS=1\n") + f"AV_APPROVAL_TOKEN={sentinel}\n",
        encoding="utf-8")
    token_dir = home / "approval"
    token_dir.mkdir(mode=0o700)
    token_file = token_dir / "agent-token"
    token_file.write_text(sentinel + "\n", encoding="utf-8")
    token_file.chmod(0o600)
    mp.setenv("AV_APPROVAL_TOKEN", sentinel)
    mp.setenv("AV_APPROVAL_TOKEN_FILE", str(token_file))
    if broken == "shim-hash-mismatch":
        _break(broken, home, mp)
    opened: list[str] = []
    real_open = builtins.open
    monkeypatch.setattr(builtins, "open", lambda f, *a, **k: opened.append(str(f)) or real_open(f, *a, **k))
    real_read_bytes = Path.read_bytes
    monkeypatch.setattr(Path, "read_bytes", lambda self: opened.append(str(self)) or real_read_bytes(self))
    real_read_text = Path.read_text
    monkeypatch.setattr(Path, "read_text", lambda self, *a, **k: opened.append(str(self)) or real_read_text(self, *a, **k))
    seen: list[str] = []
    monkeypatch.setattr(os, "environ", _RecordingEnviron(dict(os.environ), seen))
    ctx = FakeCtx()
    with caplog.at_level(logging.DEBUG):
        plugin.register(ctx)
        cb = _callback(ctx)
        message = ""
        try:
            cb(tool_name="terminal")
        except plugin.GateUnverified as exc:
            message = str(exc)
    assert opened, "the check reads the config and the marker"
    assert not any("approval/agent-token" in path for path in opened)
    assert "AV_APPROVAL_TOKEN" not in seen and "AV_APPROVAL_TOKEN_FILE" not in seen
    assert sentinel not in caplog.text and sentinel not in message
    assert (message != "") == (broken is not None)


def test_once_survives_a_module_reload(gate, caplog):
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        load_plugin().register(FakeCtx())
        load_plugin().register(FakeCtx())
    assert len(_lines(caplog)) == 1


@pytest.mark.parametrize("value", ["1", "0", ""])
def test_register_never_raises_even_when_the_ctx_does(clean_env, caplog, value, tmp_path):
    clean_env.setenv("AV_APPROVAL_ENABLED", value)
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    plugin = load_plugin()
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(ExplodingCtx())
    if value == "1":
        assert plugin.UNREGISTERED_LINE in _lines(caplog)


def test_register_never_raises_when_logging_or_the_check_breaks(gate, monkeypatch):
    mp, home, plugin = gate

    def boom(*_a, **_k):
        raise RuntimeError("broken")

    monkeypatch.setattr(plugin.logger, "warning", boom)
    monkeypatch.setattr(plugin.logger, "info", boom)
    plugin.register(FakeCtx())
    monkeypatch.setattr(plugin, "integrity_problems", boom)
    ctx = FakeCtx()
    plugin.register(ctx)
    # A check that cannot run verifies nothing: gated calls are blocked with its own code.
    with pytest.raises(plugin.GateUnverified, match=r"check-error"):
        _callback(ctx)(tool_name="terminal")


def test_token_never_reaches_the_log(clean_env, caplog):
    clean_env.setenv("AV_APPROVAL_ENABLED", "1")
    clean_env.setenv("AV_APPROVAL_TOKEN", "agent-token-SENTINEL")
    with caplog.at_level(logging.DEBUG):
        load_plugin().register(FakeCtx())
    assert "SENTINEL" not in caplog.text


def test_stub_documents_the_gap_it_stands_for():
    # The README and the module name the core version and the follower, so the
    # stub cannot outlive the reason for it unnoticed.
    text = (PLUGIN_DIR / "README.md").read_text(encoding="utf-8") + (PLUGIN_DIR / "__init__.py").read_text(
        encoding="utf-8"
    )
    for needle in ("6b74ca72", "DATA-43b", "extra.tool_call_id", "tool_use_id", "DATA-234", "allowlist-lock-unusable"):
        assert needle in text, needle
    assert Path(PLUGIN_DIR / "tests" / "conftest.py").exists()


# ---------------------------------------------------------------------------
# Opt-in: the backstop inside a real Hermes (not run in CI)
# ---------------------------------------------------------------------------

_HERMES_SRC = os.environ.get("AV_HERMES_SRC", "")
_HERMES_PY = os.environ.get("AV_HERMES_PYTHON", "")

_REAL_HERMES = r'''
import hashlib, json, os, shutil, sys
home, plugin_dir, scenario, matchers = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
os.environ.update(HERMES_HOME=home, HERMES_ACCEPT_HOOKS="1", AV_APPROVAL_ENABLED="1",
                  AV_APPROVAL_URL="http://127.0.0.1:4682")
hooks = os.path.join(home, "agent-hooks")
os.makedirs(hooks)
shim = os.path.join(hooks, "hermes-hook-shim.sh")
with open(shim, "w") as fh:
    fh.write("#!/bin/sh\ncat >/dev/null\necho '{}'\n")  # a stand-in that ALLOWS: any block is the plugin's
os.chmod(shim, 0o700)
with open(os.path.join(hooks, "approval-surface.json"), "w") as fh:
    json.dump({"shim_sha256": hashlib.sha256(open(shim, "rb").read()).hexdigest()}, fh)
import yaml
cfg = {"hooks": {"pre_tool_call": [{"matcher": m, "command": shim, "timeout": 300, "fail_closed": True}
                                   for m in matchers]},
       "hooks_auto_accept": True, "plugins": {"enabled": ["av-approval"], "hook_callback_timeout": 600}}
with open(os.path.join(home, "config.yaml"), "w") as fh:
    fh.write(yaml.safe_dump(cfg))
with open(os.path.join(home, ".env"), "w") as fh:
    fh.write("HERMES_ACCEPT_HOOKS=1\nAV_APPROVAL_ENABLED=1\nAV_APPROVAL_URL=http://127.0.0.1:4682\n")
shutil.copytree(plugin_dir, os.path.join(home, "plugins", "av-approval"),
                ignore=shutil.ignore_patterns("tests", "__pycache__"))
if scenario == "lock000":
    lock = os.path.join(home, "shell-hooks-allowlist.json.lock")
    open(lock, "w").close()
    os.chmod(lock, 0)
from hermes_cli.plugins import discover_plugins, resolve_pre_tool_block
discover_plugins()  # the gateway's order: plugins first ...
from hermes_cli.config import load_config
from agent.shell_hooks import register_from_config
try:
    register_from_config(load_config(), accept_hooks=False)  # ... then the shell hooks
    raised = None
except Exception as exc:  # the gateway swallows this (gateway/run_startup.py _register_config_hooks)
    raised = type(exc).__name__
print(json.dumps({"raised": raised, "terminal": resolve_pre_tool_block("terminal", {"command": "ls"}),
                  "memory": resolve_pre_tool_block("memory", {})}))
'''


@pytest.mark.skipif(not (_HERMES_SRC and _HERMES_PY),
                    reason="set AV_HERMES_SRC (a Hermes source tree) and AV_HERMES_PYTHON (its interpreter)")
@pytest.mark.parametrize("scenario", ["healthy", "lock000"])
def test_backstop_in_a_real_hermes(tmp_path, scenario):
    home = tmp_path / ".hermes"
    home.mkdir()
    env = {**os.environ, "PYTHONPATH": _HERMES_SRC, "PYTHONDONTWRITEBYTECODE": "1"}
    out = subprocess.run([_HERMES_PY, "-c", _REAL_HERMES, str(home), str(PLUGIN_DIR), scenario,
                          json.dumps(list(load_plugin().GATED_MATCHERS))],
                         capture_output=True, text=True, env=env, timeout=300, cwd=str(tmp_path))
    assert out.returncode == 0, out.stderr[-2000:]
    result = json.loads(out.stdout.strip().splitlines()[-1])
    if scenario == "healthy":
        assert result == {"raised": None, "terminal": None, "memory": None}
    else:
        assert result["raised"] == "PermissionError"  # Hermes registered no shell hook at all
        assert result["terminal"] == ("pre_tool_call plugin callback _pre_tool_call raised GateUnverified: "
                                      "av-approval: gate unverified (allowlist-lock-unusable)")
        assert result["memory"] is None
