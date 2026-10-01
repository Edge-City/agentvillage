"""av-approval: the documented stub registers nothing, sends nothing, logs its state once, never raises."""

from __future__ import annotations

import logging
import time
from pathlib import Path

import pytest
import yaml

from .conftest import PLUGIN_DIR, ExplodingCtx, FakeCtx, load_plugin


def _lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "av-approval"]


def _settle(facade) -> None:
    # Anything the plugin might have sent asynchronously would land well within this.
    time.sleep(0.2)


def test_manifest_is_a_backend_plugin_that_declares_its_env():
    manifest = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    assert manifest["name"] == "av-approval"
    assert manifest["kind"] == "backend"
    assert set(manifest["optional_env"]) == {"AV_APPROVAL_ENABLED", "AV_APPROVAL_URL", "AV_APPROVAL_TOKEN"}
    assert manifest["provides_hooks"] == []


@pytest.mark.parametrize("value", [None, "", "  "])
def test_unset_is_silent_and_registers_nothing(clean_env, facade, caplog, value, tmp_path):
    if value is not None:
        clean_env.setenv("AV_APPROVAL_ENABLED", value)
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    plugin = load_plugin()
    ctx = FakeCtx()
    with caplog.at_level(logging.DEBUG, logger="av-approval"):
        plugin.register(ctx)
    assert _lines(caplog) == []
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
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(FakeCtx())
    assert _lines(caplog) == [plugin.STILL_GATED_LINE]


def test_off_with_unreadable_config_reads_as_ungated(clean_env, caplog, tmp_path):
    clean_env.setenv("AV_APPROVAL_ENABLED", "off")
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text("hooks: [unclosed\n", encoding="utf-8")
    plugin = load_plugin()
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(FakeCtx())
    assert _lines(caplog) == [plugin.DISABLED_LINE]


@pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
def test_on_logs_receipts_disabled_once_registers_nothing_and_sends_nothing(clean_env, facade, caplog, value):
    clean_env.setenv("AV_APPROVAL_ENABLED", value)
    clean_env.setenv("AV_APPROVAL_URL", facade.url)
    clean_env.setenv("AV_APPROVAL_TOKEN", "agent-token-for-tests")
    plugin = load_plugin()
    ctx = FakeCtx()
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        plugin.register(ctx)
        plugin.register(ctx)
    assert _lines(caplog) == [
        "av-approval: receipts disabled (no facade receipt surface at approval-md 6b74ca72)"
    ]
    assert plugin.HOOKS == ()
    assert ctx.hooks == {} and ctx.tools == []
    _settle(facade)
    assert facade.requests == []


def test_once_survives_a_module_reload(clean_env, caplog):
    clean_env.setenv("AV_APPROVAL_ENABLED", "1")
    with caplog.at_level(logging.WARNING, logger="av-approval"):
        load_plugin().register(FakeCtx())
        load_plugin().register(FakeCtx())
    assert len(_lines(caplog)) == 1


def test_register_never_touches_ctx_and_never_raises(clean_env):
    for value in ("1", "0", ""):
        clean_env.setenv("AV_APPROVAL_ENABLED", value)
        load_plugin().register(ExplodingCtx())


def test_register_never_raises_when_logging_breaks(clean_env, monkeypatch):
    clean_env.setenv("AV_APPROVAL_ENABLED", "1")
    plugin = load_plugin()

    def boom(*_a, **_k):
        raise RuntimeError("logging is broken")

    monkeypatch.setattr(plugin.logger, "warning", boom)
    plugin.register(FakeCtx())


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
    for needle in ("6b74ca72", "DATA-43b", "extra.tool_call_id", "tool_use_id"):
        assert needle in text, needle
    assert Path(PLUGIN_DIR / "tests" / "conftest.py").exists()
