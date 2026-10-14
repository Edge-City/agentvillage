"""Pinned-Hermes isolation test. No live model call is made."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
import importlib
import os
import sys

import pytest


def _snapshot(root: Path) -> dict[str, bytes]:
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def _persistent_snapshot(root: Path) -> dict[str, bytes]:
    return {name: data for name, data in _snapshot(root).items()
            if name == "state.db" or name.startswith(("sessions/", "memories/", "memory/")) or name.endswith("MEMORY.md")}


def test_real_pinned_hermes_turn_has_no_tools_or_resident_persistence(plugin, monkeypatch, tmp_path):
    source_value = os.environ.get("AV_TEST_HERMES_SOURCE")
    if not source_value:
        pytest.skip("set AV_TEST_HERMES_SOURCE to opt into the pinned Hermes integration test")
    source = Path(source_value)
    if not (source / "run_agent.py").is_file():
        pytest.skip("set AV_TEST_HERMES_SOURCE to the pinned Hermes 0.21.5 checkout")
    assert 'version = "0.21.5"' in (source / "pyproject.toml").read_text(encoding="utf-8")
    monkeypatch.chdir(source)
    monkeypatch.syspath_prepend(str(source))
    sys.modules.pop("plugins", None)

    prediction = importlib.import_module(f"{plugin.__name__}.referendum_predict")
    resident = tmp_path / "resident"
    scratch = tmp_path / "scratch"
    resident.mkdir()
    scratch.mkdir()
    (resident / "USER.md").write_text("private resident source", encoding="utf-8")
    # Import the pinned runtime with the disposable home already selected.
    monkeypatch.setenv("HERMES_HOME", str(scratch))

    import agent.agent_init
    import hermes_cli.config
    import hermes_cli.oneshot
    import hermes_cli.runtime_provider
    monkeypatch.setenv("HERMES_HOME", str(resident))
    resident_before = _snapshot(resident)
    monkeypatch.setattr(agent.agent_init, "fetch_model_metadata", lambda *args, **kwargs: None)
    choice = SimpleNamespace(provider="custom", model="fixture/model", base_url="http://127.0.0.1:9/v1",
                             api_key="test-key-123456789", api_mode="chat_completions")
    runtime = {"api_key": choice.api_key, "base_url": choice.base_url, "provider": choice.provider,
               "requested_provider": choice.provider, "api_mode": choice.api_mode}
    monkeypatch.setattr(hermes_cli.config, "load_config_readonly", lambda: {})
    monkeypatch.setattr(hermes_cli.oneshot, "_resolve_model_and_provider", lambda *args: choice)
    monkeypatch.setattr(hermes_cli.runtime_provider, "resolve_runtime_with_fallback", lambda *args, **kwargs: (runtime, None))

    class KeptTemporaryDirectory:
        def __init__(self, *args, **kwargs):
            pass
        def __enter__(self):
            return str(scratch)
        def __exit__(self, *args):
            return False

    monkeypatch.setattr(prediction.tempfile, "TemporaryDirectory", KeptTemporaryDirectory)
    original_build = prediction.build_isolated_agent
    captured = {}

    def build_and_fake_model(runtime_arg, choice_arg):
        built = original_build(runtime_arg, choice_arg)
        assert built.tools == []
        assert built.valid_tool_names == set()
        assert built._session_db is None
        assert built._memory_manager is None
        assert built.skip_background_review is True
        assert built._persist_disabled is True
        assert built._fallback_chain == []
        captured["after_constructor"] = _persistent_snapshot(scratch)
        response = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="{}", tool_calls=None), finish_reason="stop")],
            model="fixture/model", usage=None,
        )
        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = response
        built._create_request_openai_client = lambda **kwargs: fake_client
        captured["create"] = fake_client.chat.completions.create
        return built

    monkeypatch.setattr(prediction, "build_isolated_agent", build_and_fake_model)
    raw, result = prediction.isolated_runner("sealed prediction")

    assert raw == "{}"
    assert result["completed"] is True
    assert result["provider"] == "custom"
    assert result["model"] == "fixture/model"
    captured["create"].assert_called_once()
    assert not captured["create"].call_args.kwargs.get("tools")
    assert _snapshot(resident) == resident_before
    assert _persistent_snapshot(scratch) == captured["after_constructor"]
    assert os.environ["HERMES_HOME"] == str(resident)
