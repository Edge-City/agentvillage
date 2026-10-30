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

# The memory tool (review-b #558 S2): Hermes's own no-match result carries every USER.md entry; through the
# gate's transform_tool_result in a group it carries no Private one, in a DM it is Hermes's own.
import os, importlib.util
from tools.memory_tool import memory_tool
store = MemoryStore(memory_char_limit=2200, user_char_limit=24000)
store.load_from_disk()
miss = memory_tool(action="replace", target="user", old_text="no such text", content="x", store=store)
spec = importlib.util.spec_from_file_location("av_user_md_gate_probe", home + "/plugins/av-events/_user_md_gate.py")
av_gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(av_gate)
os.environ["HERMES_SESSION_PLATFORM"] = "telegram"
os.environ["HERMES_SESSION_CHAT_TYPE"] = "group"
report["miss_raw_has_setup"] = "kelp sensors" in miss
report["miss_group"] = av_gate.transform_memory_result(tool_name="memory", result=miss, session_id="tg-group")
report["strip_block"] = av_gate.memory_write_directive(tool_name="memory", args={
    "action": "replace", "target": "user", "old_text": "[Edge City profile, written at setup]", "content": "x"})
os.environ["HERMES_SESSION_CHAT_TYPE"] = "dm"
report["miss_dm"] = av_gate.transform_memory_result(tool_name="memory", result=miss, session_id="tg-dm")

# Review-b ov#563 S1-d on Hermes's own tool and result shapes: a group notes a right guess of a setup line
# in MEMORY.md and a wrong one of the same length; the write check lets both through and every answer reads
# the same with the guess swapped; a USER.md add goes through whatever it holds (ov#565 N1-r3); a read-back
# of a line no group wrote still loses the fingerprinted line (after a restart, the group's own one too).
# The probe copy sees the provider's load-time fingerprints (N4-d: one set).
os.environ["HERMES_SESSION_CHAT_TYPE"] = "group"
right, wrong = "Synthetic Resident, Tidepool Bay. Builds kelp sensors.", "Synthetic Resident, Tidepool Bay. Builds kelp sensers."
report["s1d_fingerprints"] = [av_gate.holds_private_entry(right), av_gate.holds_private_entry(wrong)]
memory_tool(action="add", target="memory", content="placeholder note", store=store)
memory_tool(action="remove", target="memory", old_text="placeholder note", store=store)
answers = {}
for name, guess in (("right", right), ("wrong", wrong)):
    seen = []
    for args in ({"action": "add", "target": "memory", "content": guess},
                 {"action": "remove", "target": "memory", "old_text": "x\n" + guess + "\ny"},
                 {"action": "replace", "target": "memory", "old_text": guess, "content": "Likes kites."},
                 {"action": "remove", "target": "memory", "old_text": "Likes kites."}):
        directive = av_gate.memory_write_directive(tool_name="memory", args=args, session_id="tg-group")
        raw = memory_tool(store=store, **args)
        out = av_gate.transform_memory_result(tool_name="memory", args=args, result=raw, session_id="tg-group")
        seen.append([directive, (raw if out is None else out).replace(guess, "<guess>")])
    answers[name] = seen
report["s1d_answers"] = answers
report["s1d_user_add"] = [av_gate.memory_write_directive(tool_name="memory", session_id="tg-group",
                                                         args={"action": "add", "target": "user", "content": g})
                          for g in (right, wrong)]
report["s1d_user_view_own"] = av_gate.transform_memory_result(tool_name="memory", args={"action": "view", "target": "user"},
                                                              result=json.dumps({"current_entries": [right]}), session_id="tg-group")
av_gate._self_written_digests().clear()  # a restart: the self-written set is gone, the fingerprints are retaken at load
report["s1d_user_view"] = av_gate.transform_memory_result(tool_name="memory", args={"action": "view", "target": "user"},
                                                          result=json.dumps({"current_entries": [right]}), session_id="tg-group")
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
        "Prefers calls before noon.\n§\n"
        "[God Constitution conversation, kept by the Agent Village control plane]\nA ballot was submitted.\n§\n"
        "[Village vote, kept by the Agent Village app]\nThe weekly theme vote closes Friday.", encoding="utf-8")
    staged_av = home / "plugins" / "av-events"
    staged_av.mkdir(parents=True)
    shutil.copy(h.AV_EVENTS_DIR / "_user_md_gate.py", staged_av / "_user_md_gate.py")

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
        assert "A ballot was submitted." not in user and "weekly theme vote closes Friday" in user, name
    assert "A ballot was submitted." in dm_user
    # The memory tool through the gate's hooks, on Hermes's own store and tool.
    assert report["miss_raw_has_setup"] is True
    assert "kelp sensors" not in report["miss_group"] and "A ballot" not in report["miss_group"]
    assert "Prefers calls before noon." in report["miss_group"]
    assert report["miss_dm"] is None
    assert report["strip_block"]["action"] == "block"
    # S1-d on Hermes's own memory tool: a right and a wrong MEMORY.md guess get the same answers (the group
    # wrote the line itself), a USER.md add goes through either way (ov#565 N1-r3), and a USER.md read-back
    # of the line keeps it while the group's write is remembered, loses it after a restart.
    assert report["s1d_fingerprints"] == [True, False]
    right, wrong = report["s1d_answers"]["right"], report["s1d_answers"]["wrong"]
    assert right == wrong, (right, wrong)
    assert [directive for directive, _ in right] == [None] * 4
    assert '"Entry added."' in right[0][1] and "No entry matched" in right[1][1] and "<guess>" in right[2][1]
    assert report["s1d_user_add"] == [None, None]
    assert report["s1d_user_view_own"] is None
    assert json.loads(report["s1d_user_view"])["current_entries"] == []


_MATRIX_DRIVER = r'''
import json, os, sys, importlib.util
from types import SimpleNamespace
home, spec_path = sys.argv[1], sys.argv[2]
try:
    from tools.memory_tool import memory_tool, MemoryStore
except Exception as exc:
    print(json.dumps({"import_error": f"{type(exc).__name__}: {exc}"}))
    sys.exit(0)
spec = json.loads(open(spec_path, encoding="utf-8").read())
mod = importlib.util.spec_from_file_location("av_user_md_gate_matrix", home + "/plugins/av-events/_user_md_gate.py")
gate = importlib.util.module_from_spec(mod)
mod.loader.exec_module(gate)
report = {"installed": gate.install_user_md_gate(), "matrix": {}}
TOKEN, SETUP, NOTE = spec["token"], spec["setup"], spec["note"]
group_agent = SimpleNamespace(platform="telegram", _chat_type="group", _memory_manager=None)


def fill(value, guess):
    if isinstance(value, str):
        return value.replace(TOKEN, guess)
    if isinstance(value, list):
        return [fill(v, guess) for v in value]
    if isinstance(value, dict):
        return {k: fill(v, guess) for k, v in value.items()}
    return value


def load(user=None, memory=None):
    """A fresh pair of files, then Hermes's own load (the gate's load hook takes the fingerprints)."""
    if user is not None:
        open(home + "/memories/USER.md", "w", encoding="utf-8").write("\n§\n".join(user))
        open(home + "/memories/MEMORY.md", "w", encoding="utf-8").write("\n§\n".join(memory))
    store = MemoryStore(memory_char_limit=400, user_char_limit=600)
    store.load_from_disk()
    return store


def set_session(env):
    for name in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_TYPE", "HERMES_CRON_SESSION", "HERMES_PLATFORM"):
        os.environ.pop(name, None)
    os.environ.update(env)


def run(store, session_id, calls):
    seen = []
    for args in calls:
        directive = gate.memory_write_directive(tool_name="memory", args=args, session_id=session_id)
        if directive is not None:
            seen.append(["blocked", directive])
            continue
        raw = memory_tool(store=store, **args)
        out = gate.transform_memory_result(tool_name="memory", args=args, result=raw, session_id=session_id)
        seen.append(["ran", raw if out is None else out])
    prompt = gate.user_block_for(group_agent, load().format_for_system_prompt("user"))
    return seen, prompt


for seed, (user, memory) in spec["seeds"].items():
    for kind, (env, session_id) in spec["sessions"].items():
        set_session(env)
        for shape, calls in spec["shapes"].items():
            runs = []
            for guess in (spec["right"], spec["wrong"]):
                gate._self_written_digests().clear()
                store = load(user, memory)
                seen, prompt = run(store, session_id, fill(calls, guess))
                runs.append(json.dumps([seen, prompt], ensure_ascii=False).replace(guess, "<guess>"))
            report["matrix"].setdefault(seed, {}).setdefault(kind, {})[shape] = runs

# S1-r3: a DM copies the unmarked setup line into MEMORY.md; a group's no-match edit does not carry it.
set_session({"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_TYPE": "dm"})
gate._self_written_digests().clear()
store = load([SETUP, NOTE], ["Likes kites."])
report["dm_copy"] = run(store, "tg-dm", [{"action": "add", "target": "memory", "content": spec["right"]}])[0]
set_session({"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_TYPE": "group"})
report["s1r3_group"] = run(store, "tg-group", [{"action": "remove", "target": "memory", "old_text": "no such note here"}])[0]

# The restart residual: a group's own right guess reads back until the set is gone, then it is hidden.
residual = {}
for name, guess in (("right", spec["right"]), ("wrong", spec["wrong"])):
    gate._self_written_digests().clear()
    store = load([SETUP, NOTE], ["Likes kites."])
    before = run(store, "tg-group", [{"action": "add", "target": "memory", "content": guess},
                                     {"action": "add", "target": "user", "content": guess},
                                     {"action": "remove", "target": "memory", "old_text": "no such note here"}])
    gate._self_written_digests().clear()  # the restart
    after = run(load(), "tg-group", [{"action": "remove", "target": "memory", "old_text": "no such note here"}])
    residual[name] = [guess in json.dumps(before[0][-1], ensure_ascii=False), guess in before[1],
                      guess in json.dumps(after[0], ensure_ascii=False), guess in after[1]]
report["residual"] = residual
print(json.dumps(report))
'''


def _gate_paths_module(h):
    """The matrix's call shapes, from test_user_md_gate_paths.py (importlib mode: not importable by name)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("av_test_user_md_gate_paths_shapes",
                                                  Path(__file__).with_name("test_user_md_gate_paths.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(not ((_SRC / "plugins" / "memory" / "__init__.py").is_file() and _PY),
                    reason="no Hermes source tree + interpreter (AV_HERMES_SRC / AV_HERMES_PYTHON)")
def test_real_hermes_oracle_matrix_and_the_self_written_exemption(tmp_path, h):
    """Review-b ov#565 Q1, the round-3 fold and ROUND 4 on Hermes's own memory tool and store: for a group,
    a cron run, an unknown chat type and no session metadata, every call shape gives a right guess of a
    setup line and a same-length wrong one byte-identical answers and next-load group prompts (guess
    normalised out) on seeds A, B and C (S1-r4: Hermes's dedupe reply, and a DM-made USER.md copy alone or
    beside a DM-only line); on seed D only N2-r4's MEMORY.md substring replace/remove differs. A Private
    line a DM copied into MEMORY.md stays out of a group's results (S1-r3); the restart residual is what
    the PR says it is."""
    paths = _gate_paths_module(h)
    token = "\u0000GUESS\u0000"
    home = tmp_path / ".hermes"
    (home / "plugins" / "av-events").mkdir(parents=True)
    (home / "memories").mkdir()
    shutil.copy(h.AV_EVENTS_DIR / "_user_md_gate.py", home / "plugins" / "av-events" / "_user_md_gate.py")
    (home / "config.yaml").write_text("memory:\n  user_char_limit: 600\n  memory_char_limit: 400\n", encoding="utf-8")
    right = "Synthetic Resident, Tidepool Bay. Builds kelp sensors for the Goa coast."
    wrong = "Synthetic Resident, Tidepool Bay. Builds kelp sensors for the Gox coast."
    setup, note = "[Edge City profile, written at setup]\n" + right, "Prefers calls before noon."
    seeds = {"A": [[setup, note], ["Likes kites."]],
             "B": [[setup, note, right], ["Likes kites."]],
             "C": [[setup, note, f"{right}\n{paths.DM_ONLY}"], ["Likes kites."]],
             "D": [[setup, note], ["Likes kites.", f"{right}\n{paths.DM_ONLY}"]]}
    spec = {"token": token, "right": right, "wrong": wrong, "note": note, "setup": setup, "seeds": seeds,
            "sessions": {kind: [env, sid] for kind, (env, sid) in paths.SESSION_KINDS.items()},
            "shapes": {shape: make(token) for shape, make in paths.MATRIX.items()}}
    spec_path = tmp_path / "matrix.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AV_", "HERMES_"))}
    env.update(PYTHONPATH=str(_SRC), PYTHONDONTWRITEBYTECODE="1", HERMES_HOME=str(home))
    out = subprocess.run([_PY, "-c", _MATRIX_DRIVER, str(home), str(spec_path)], capture_output=True, text=True,
                         env=env, timeout=600, cwd=str(tmp_path))
    assert out.returncode == 0, out.stderr[-3000:]
    report = json.loads(out.stdout.strip().splitlines()[-1])
    if "import_error" in report:
        pytest.skip(f"Hermes not importable with {_PY}: {report['import_error']}")
    assert report["installed"] is True
    assert sorted(report["matrix"]) == sorted(seeds)
    differences = {seed: sorted({shape for kind, shapes in kinds.items() for shape, (r, w) in shapes.items() if r != w})
                   for seed, kinds in report["matrix"].items()}
    assert differences == {"A": [], "B": [], "C": [], "D": sorted(paths.SEED_D_KNOWN)}
    for seed, kinds in report["matrix"].items():
        assert sorted(kinds) == sorted(paths.SESSION_KINDS), seed
        for kind, shapes in kinds.items():
            assert sorted(shapes) == sorted(paths.MATRIX), kind
            if seed == "D":  # N2-r4 in every session kind alike
                assert sorted(s for s, (r, w) in shapes.items() if r != w) == sorted(paths.SEED_D_KNOWN), kind
            for shape, runs in shapes.items():
                seen, prompt = json.loads(runs[0])
                assert seen[0][0] == ("blocked" if shape in paths.REFUSED else "ran"), (seed, kind, shape)
                for r in runs:
                    assert "kelp sensors for the Goa" not in r and "Tidepool" not in r.replace("<guess>", ""), (seed, kind, shape)
                    assert "lighthouse" not in r or shape in paths.CARRIES_DM_ONLY, (seed, kind, shape)
                    assert "already exists" not in r and '\\"usage\\"' not in r and "entry_count" not in r, (seed, kind, shape)
            # the read-backs are not vacuous: the group's own line comes back on both stores and in the prompt
            assert "<guess>" in json.dumps(json.loads(json.loads(shapes["read-back-memory"][0])[0][-1][1])["current_entries"])
            assert "<guess>" in json.dumps(json.loads(json.loads(shapes["over-limit-user"][0])[0][-1][1])["current_entries"])
            assert "<guess>" in json.loads(shapes["add-user"][0])[1]
    assert json.loads(report["dm_copy"][0][1])["success"] is True
    (s1r3,) = report["s1r3_group"]
    assert s1r3[0] == "ran" and json.loads(s1r3[1])["current_entries"] == ["Likes kites."]
    assert report["residual"] == {"right": [True, True, False, False], "wrong": [True, True, True, True]}


_CANARY = Path(__file__).resolve().parents[3] / "scripts" / "check-user-md-gate.py"


@pytest.mark.skipif(not ((_SRC / "plugins" / "memory" / "__init__.py").is_file() and _PY),
                    reason="no Hermes source tree + interpreter (AV_HERMES_SRC / AV_HERMES_PYTHON)")
def test_the_release_canary_finds_the_gate_by_both_paths(tmp_path, h):
    """Review-b #558 S1: the roll's check. Both paths (the provider, av-events) put the per-session gate on
    the seam the prompt build reaches by bare name: exit 0, `provider=seam av-events=seam`."""
    home = tmp_path / ".hermes"
    shutil.copytree(h.PLUGIN_DIR, home / "plugins" / "village-memory", ignore=shutil.ignore_patterns("tests", "__pycache__"))
    (home / "plugins" / "av-events").mkdir(parents=True)
    shutil.copy(h.AV_EVENTS_DIR / "_user_md_gate.py", home / "plugins" / "av-events" / "_user_md_gate.py")
    (home / "config.yaml").write_text("memory:\n  provider: village-memory\n", encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AV_", "HERMES_"))}
    env.update(PYTHONPATH=str(_SRC), PYTHONDONTWRITEBYTECODE="1", HERMES_HOME=str(home))
    out = subprocess.run([_PY, str(_CANARY)], capture_output=True, text=True, env=env, timeout=300, cwd=str(tmp_path))
    assert out.stdout.strip().splitlines()[-1] == "user_md_gate provider=seam av-events=seam", out.stderr[-2000:]
    assert out.returncode == 0
    # Without the plugins staged, both paths say none: exit 2.
    shutil.rmtree(home / "plugins")
    out = subprocess.run([_PY, str(_CANARY)], capture_output=True, text=True, env=env, timeout=300, cwd=str(tmp_path))
    assert out.stdout.strip().splitlines()[-1] == "user_md_gate provider=none av-events=none"
    assert out.returncode == 2
