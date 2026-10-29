"""village-memory against the real Hermes (v2026.9.24): discovery, activation, prompt block, tools.

Runs in a subprocess with `PYTHONPATH` = a Hermes source tree and a Python that has Hermes's
dependencies: `AV_HERMES_SRC` (or `HERMES_AGENT_SRC`, default `~/dev/hermes-agent-ref-v2026.9.24`)
and `AV_HERMES_PYTHON` (default `<src>/venv/bin/python`, then `~/.hermes/hermes-agent/venv/bin/python`).
Skips when either is missing (CI). The plugin is staged into `$HERMES_HOME/plugins/village-memory/`
as the installer stages it, `config.yaml` says `memory.provider: village-memory`, and Hermes's own
code does the rest:

- `plugins.memory.find_provider_dir` / `load_memory_provider` (plugins/memory/__init__.py:124-136,
  192-217, 332-358) find and build it through `register(ctx)`;
- the general plugin scan sees `kind: exclusive` and records it without importing it
  (hermes_cli/plugins_discovery.py:253-257);
- `MemoryManager.add_provider` / `initialize_all` / `build_system_prompt` / `handle_tool_call`
  (agent/memory_manager.py:350-436, 643-652, 896-902) and `system_prompt._memory_parts` (:515-540)
  carry the block (whole in a DM on a 1M window, reduced in a group or cron run),
  `inject_memory_provider_tools` (:112-158) the two tools (DM only); neither name is a
  reserved core tool (toolsets._HERMES_CORE_TOOLS).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

_SRC = Path(os.environ.get("AV_HERMES_SRC") or os.environ.get("HERMES_AGENT_SRC")
            or Path.home() / "dev" / "hermes-agent-ref-v2026.9.24")
_PY_CANDIDATES = [os.environ.get("AV_HERMES_PYTHON") or "", str(_SRC / "venv" / "bin" / "python"),
                  str(Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python")]
_PY = next((c for c in _PY_CANDIDATES if c and Path(c).is_file()), "")

_DRIVER = r'''
import json, sys
from types import SimpleNamespace
home = sys.argv[1]
try:
    from plugins.memory import find_provider_dir, load_memory_provider, list_memory_provider_names
    from agent.memory_manager import MemoryManager, inject_memory_provider_tools
    from agent.system_prompt import _memory_parts
    from hermes_cli.plugins_discovery import scan_directory, gate_manifest
    from toolsets import _HERMES_CORE_TOOLS
except Exception as exc:
    print(json.dumps({"import_error": f"{type(exc).__name__}: {exc}"}))
    sys.exit(0)

report = {"names": list_memory_provider_names(), "dir": str(find_provider_dir("village-memory"))}
manifests = [m for m in scan_directory(__import__("pathlib").Path(home) / "plugins", "user") if m.name == "village-memory"]
report["kind"] = [m.kind for m in manifests]
report["gate"] = [gate_manifest(m, set(), {"village-memory"}).action for m in manifests] if manifests else []

def agent_for(chat_type, platform="telegram"):
    provider = load_memory_provider("village-memory")
    manager = MemoryManager()
    assert provider is not None and provider.is_available()
    manager.add_provider(provider)
    kwargs = {"chat_type": chat_type} if chat_type else {}
    manager.initialize_all(session_id="s-" + (chat_type or platform), platform=platform, **kwargs)
    agent = SimpleNamespace(tools=[], enabled_toolsets=None, disabled_toolsets=None, valid_tool_names=set(),
                            _memory_manager=manager, _memory_store=None, _memory_enabled=False,
                            _user_profile_enabled=False)
    added = inject_memory_provider_tools(agent)
    return provider, manager, agent, added

provider, manager, agent, added = agent_for("dm")
report["class"] = type(provider).__name__
report["provider_name"] = provider.name
report["added"] = added
report["tool_names"] = sorted(t["function"]["name"] for t in agent.tools)
report["routed"] = sorted(manager.get_all_tool_names())
report["core_clash"] = sorted(set(report["tool_names"]) & set(_HERMES_CORE_TOOLS))
report["parts"] = _memory_parts(agent)
report["profile"] = json.loads(manager.handle_tool_call("resident_profile", {}))
report["context"] = json.loads(manager.handle_tool_call("resident_context", {"query": "aquaponics"}))
for name, args in (("group", ("group",)), ("cron", (None, "cron"))):
    _p, other_manager, other_agent, other_added = agent_for(*args)
    report[name] = {"added": other_added, "parts": _memory_parts(other_agent),
                    "profile": json.loads(other_manager.handle_tool_call("resident_profile", {}))}

# The built-in USER.md (review-b L32588): Hermes's real MemoryStore, through the seam the prompt build
# calls by bare name (system_prompt.py:776), which register() wrapped.
import agent.system_prompt as sp
from tools.memory_tool import MemoryStore
report["seam_is_module_global"] = sp.build_system_prompt.__globals__ is vars(sp)
report["user_gate"] = callable(getattr(sp._memory_parts, "village_user_gate", None))
users = {}
for name, args in (("dm", ("dm",)), ("group", ("group",)), ("cron", (None, "cron"))):
    _p, _m, user_agent, _a = agent_for(*args)
    store = MemoryStore(memory_char_limit=2200, user_char_limit=24000)
    store.load_from_disk()
    user_agent._memory_store, user_agent._user_profile_enabled = store, True
    users[name] = sp._memory_parts(user_agent)
report["user_parts"] = users
print(json.dumps(report))
'''


@pytest.mark.skipif(not ((_SRC / "plugins" / "memory" / "__init__.py").is_file() and _PY),
                    reason="no Hermes source tree + interpreter (AV_HERMES_SRC / AV_HERMES_PYTHON)")
def test_real_hermes_discovers_activates_and_serves_the_provider(tmp_path, h):
    home = tmp_path / ".hermes"
    staged = home / "plugins" / "village-memory"
    shutil.copytree(h.PLUGIN_DIR, staged, ignore=shutil.ignore_patterns("tests", "__pycache__"))
    shutil.copytree(h.KNOWLEDGE_FIXTURE, home / "knowledge")
    (home / "knowledge" / "agentvillage" / "_profile.md").write_text(h.profile_text(), encoding="utf-8")
    (home / "config.yaml").write_text("model:\n  context_length: 1000000\nmemory:\n  provider: village-memory\n  user_char_limit: 24000\n", encoding="utf-8")
    (home / "memories").mkdir()
    (home / "memories" / "USER.md").write_text(
        "[Edge City profile, written at setup]\nSynthetic Resident, Tidepool Bay. Builds kelp sensors.\n§\n"
        "Prefers calls before noon.", encoding="utf-8")

    env = {k: v for k, v in os.environ.items() if not k.startswith(("AV_", "HERMES_"))}
    env.update(PYTHONPATH=str(_SRC), PYTHONDONTWRITEBYTECODE="1", HERMES_HOME=str(home))
    out = subprocess.run([_PY, "-c", _DRIVER, str(home)], capture_output=True, text=True, env=env, timeout=300,
                         cwd=str(tmp_path))
    assert out.returncode == 0, out.stderr[-3000:]
    report = json.loads(out.stdout.strip().splitlines()[-1])
    if "import_error" in report:
        pytest.skip(f"Hermes not importable with {_PY}: {report['import_error']}")

    assert "village-memory" in report["names"]
    assert report["dir"] == str(staged)
    assert report["kind"] == ["exclusive"] and report["gate"] == ["placeholder"]
    assert report["class"] == "VillageMemoryProvider" and report["provider_name"] == "village-memory"
    assert report["added"] == 2
    assert report["tool_names"] == report["routed"] == ["resident_context", "resident_profile"]
    assert report["core_clash"] == []
    (block,) = report["parts"]
    assert block.startswith("═" * 46 + "\nRESIDENT PROFILE (village-memory")
    assert "Build a courtyard garden (you)" in block and "agentvillage-profile v1" not in block
    assert report["profile"]["status"] == "ok" and "courtyard" in report["profile"]["profile"]
    assert "lighthouse restoration" in block  # private session, 1M window: the whole profile
    assert report["context"]["status"] == "ok", report["context"]
    assert [hit["ref"] for hit in report["context"]["hits"]] == ["knowledge/agentvillage/upload-1758100000000.md:13"]
    # PRIVACY (lead L32315): a group or cron session gets NO profile block through real Hermes either.
    for name in ("group", "cron"):
        shared = report[name]
        assert shared["parts"] == [], name
        assert shared["added"] == 0 and shared["profile"]["status"] == "unavailable", name
    # The built-in USER.md: whole in the DM; without the raw setup profile in a group or cron run.
    assert report["seam_is_module_global"] and report["user_gate"]
    users = report["user_parts"]
    (dm_user,) = [p for p in users["dm"] if "USER PROFILE" in p]
    assert "kelp sensors" in dm_user and "Prefers calls before noon." in dm_user
    for name in ("group", "cron"):
        (user,) = users[name]
        assert user.startswith("═" * 46 + "\nUSER PROFILE (who the user is) ["), name
        assert "Prefers calls before noon." in user, name
        assert "kelp sensors" not in user and "written at setup" not in user, name
