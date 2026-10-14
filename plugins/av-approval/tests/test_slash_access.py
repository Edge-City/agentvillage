"""SEC-6, Hermes-backed: the config the installer's `configureSlashAccess` writes gates /model.

The installer step runs for real (bun, into a temporary HERMES_HOME); Hermes then reads that
config.yaml with its own gateway loader and `gateway.slash_access`. Skips without Hermes on
PYTHONPATH (e.g. PYTHONPATH=/Users/carter/dev/hermes-agent-ref-v2026.9.24) or without bun.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

slash_access = pytest.importorskip("gateway.slash_access")
gateway_config = pytest.importorskip("gateway.config")
yaml = pytest.importorskip("yaml")

REPO = Path(__file__).resolve().parents[3]
RESIDENT = "123456"


def write_config(home: Path, admin_ids: str | None) -> dict:
    """Run the real installer step into `home`; return the parsed config.yaml."""
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun not installed")
    env = {k: v for k, v in os.environ.items() if k != "AV_SLASH_ADMIN_IDS"}
    env["HERMES_HOME"] = str(home)
    if admin_ids is not None:
        env["AV_SLASH_ADMIN_IDS"] = admin_ids
    script = 'import { configureSlashAccess } from "./install/config.ts"; configureSlashAccess();'
    run = subprocess.run([bun, "-e", script], cwd=REPO, env=env, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    assert "/model and config commands are admin-only" in run.stdout
    return yaml.safe_load((home / "config.yaml").read_text())


def policies(doc: dict, home: Path, monkeypatch) -> list:
    """Both scopes, twice: from the written `extra` dict, and through Hermes's own config loader."""
    extra = doc["platforms"]["telegram"]["extra"]
    monkeypatch.setenv("HERMES_HOME", str(home))
    loaded = gateway_config.load_gateway_config()
    out = []
    for scope, chat_type in (("dm", "dm"), ("group", "group")):
        out.append(slash_access.policy_from_extra(extra, scope))
        source = SimpleNamespace(platform=gateway_config.Platform.TELEGRAM, chat_type=chat_type, user_id=RESIDENT)
        out.append(slash_access.policy_for_source(loaded, source))
    return out


def test_resident_cannot_run_model_but_keeps_session_commands(tmp_path, monkeypatch):
    monkeypatch.delenv("AV_SLASH_ADMIN_IDS", raising=False)
    doc = write_config(tmp_path, None)
    for policy in policies(doc, tmp_path, monkeypatch):
        assert policy.enabled is True
        assert policy.can_run(RESIDENT, "model") is False
        assert policy.can_run(RESIDENT, "reasoning") is False
        assert policy.can_run(RESIDENT, "fast") is False
        assert policy.can_run(RESIDENT, "config") is False
        assert policy.can_run(RESIDENT, "new") is True
        assert policy.can_run(RESIDENT, "help") is True
        assert policy.can_run(RESIDENT, "whoami") is True


def test_admin_override_env_restores_every_command(tmp_path, monkeypatch):
    doc = write_config(tmp_path, RESIDENT)
    for policy in policies(doc, tmp_path, monkeypatch):
        assert policy.enabled is True
        assert policy.can_run(RESIDENT, "model") is True
        assert policy.can_run("654321", "model") is False
