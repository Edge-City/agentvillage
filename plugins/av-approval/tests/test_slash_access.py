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


def write_config(home: Path, admin_ids: str | None, before: dict | None = None) -> dict:
    """Run the real installer step into `home` (over `before`, if given); return the parsed config.yaml."""
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun not installed")
    env = {k: v for k, v in os.environ.items() if k != "AV_SLASH_ADMIN_IDS"}
    env["HERMES_HOME"] = str(home)
    if before is not None:
        (home / "config.yaml").write_text(yaml.safe_dump(before))
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


def test_env_admin_ids_are_ignored(tmp_path, monkeypatch):
    """Fix round 1, S1: AV_SLASH_ADMIN_IDS names nobody admin; the roll's .env autoload cannot either."""
    doc = write_config(tmp_path, RESIDENT)
    for policy in policies(doc, tmp_path, monkeypatch):
        assert policy.enabled is True
        assert policy.can_run(RESIDENT, "model") is False


def test_competing_blocks_cannot_ungate(tmp_path, monkeypatch):
    """Fix round 1, S2: blocks Hermes reads over platforms.telegram lose the four keys."""
    ungate = {"allow_admin_from": [], "group_allow_admin_from": [], "user_allowed_commands": ["model"]}
    before = {
        "telegram": {**ungate, "extra": {"group_user_allowed_commands": ["model"]}},
        "gateway": {
            "telegram": {"extra": dict(ungate)},
            "platforms": {"telegram": dict(ungate)},
        },
    }
    doc = write_config(tmp_path, None, before)
    for policy in policies(doc, tmp_path, monkeypatch):
        assert policy.enabled is True
        assert policy.can_run(RESIDENT, "model") is False
        assert policy.can_run(RESIDENT, "new") is True
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    loaded = gateway_config.load_gateway_config()
    for chat_type in ("", None, "supergroup"):
        source = SimpleNamespace(platform=gateway_config.Platform.TELEGRAM, chat_type=chat_type, user_id=RESIDENT)
        assert slash_access.policy_for_source(loaded, source).can_run(RESIDENT, "model") is False


def test_merge_key_shape_fails_closed_where_hermes_would_be_ungated(tmp_path, monkeypatch):
    """Fix round 2 (M1): a top-level `<<` hands Hermes (PyYAML merges it) a root telegram block that
    ungates DMs, while the `yaml` package sees only a key named "<<". The step must refuse it."""
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun not installed")
    text = "tdef: &t {telegram: {allow_admin_from: []}}\n<<: *t\n"
    (tmp_path / "config.yaml").write_text(text)
    env = {k: v for k, v in os.environ.items() if k != "AV_SLASH_ADMIN_IDS"}
    env["HERMES_HOME"] = str(tmp_path)
    script = 'import { configureSlashAccess } from "./install/config.ts"; console.log("RET=" + JSON.stringify(configureSlashAccess()));'
    run = subprocess.run([bun, "-e", script], cwd=REPO, env=env, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    assert 'RET="YAML merge key \\"<<\\" under the top level"' in run.stdout
    assert (tmp_path / "config.yaml").read_text() == text
    # Why refusing matters: this is the file Hermes reads, and its DM scope is ungated.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    loaded = gateway_config.load_gateway_config()
    source = SimpleNamespace(platform=gateway_config.Platform.TELEGRAM, chat_type="dm", user_id=RESIDENT)
    assert slash_access.policy_for_source(loaded, source).can_run(RESIDENT, "model") is True
