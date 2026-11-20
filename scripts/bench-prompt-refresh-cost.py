"""V2112 cost measurement: one F1 static-prefix rebuild on the real Hermes v2026.9.24 prompt builder,
with the overlay's real SOUL.md / AGENTS.md / staged skills and near-limit synthetic memory files.

Usage: python3 -I scripts/bench-prompt-refresh-cost.py <hermes_ref_dir> <overlay_checkout> [reps]
  e.g. python3 -I scripts/bench-prompt-refresh-cost.py ~/dev/hermes-agent-ref-v2026.9.24 . 30
Needs a Hermes source checkout whose `agent.system_prompt` imports under the python3 you run it
with (the v2026.9.24 ref does under a plain Python 3.11 with PyYAML). Runs in a throwaway HERMES_HOME it deletes at the end. Synthetic memory text only;
nothing from a real box. Not a test (not collected by pytest); numbers go into the av-events README
"Cost (measured for v2.1.12)" paragraph.
"""
import hashlib
import importlib
import os
import shutil
import statistics
import sys
import tempfile
import time
import types
from pathlib import Path

REF, OV = Path(sys.argv[1]).expanduser().resolve(), Path(sys.argv[2]).expanduser().resolve()
REPS = int(sys.argv[3]) if len(sys.argv) > 3 else 30

home = Path(tempfile.mkdtemp(prefix="v2112-bench-")) / ".hermes"
home.mkdir()
os.environ["HERMES_HOME"] = str(home)
os.environ["TERMINAL_CWD"] = str(home)
for var in ("AV_PROMPT_REFRESH", "AV_PROMPT_REFRESH_FILES", "AV_HOOKS_DISABLED"):
    os.environ.pop(var, None)
(home / "config.yaml").write_text(f"terminal:\n  cwd: {home}\n", encoding="utf-8")
shutil.copy(OV / "workspace" / "SOUL.md", home / "SOUL.md")
shutil.copy(OV / "workspace" / "AGENTS.md", home / "AGENTS.md")
staged = []
for skill in sorted((OV / "skills").iterdir()):
    if (skill / "SKILL.md").is_file():
        shutil.copytree(skill, home / "skills" / skill.name)
        staged.append(skill.name)
(home / "memories").mkdir()
user_entries = [f"Resident fact {i}: prefers short replies about the village schedule and the weekly vote." for i in range(14)]
mem_entries = [f"Note {i}: followed up on the For Kicks RSVP and the mini-app list for the resident today." for i in range(22)]
(home / "memories" / "USER.md").write_text("\n§\n".join(user_entries), encoding="utf-8")
(home / "memories" / "MEMORY.md").write_text("\n§\n".join(mem_entries), encoding="utf-8")
os.chdir(home)

sys.path.insert(0, str(REF))
from agent import prompt_builder as pb  # noqa: E402
from agent import system_prompt as sp  # noqa: E402
from tools.memory_tool_store import MemoryStore  # noqa: E402

# The real F1 module, loaded as a submodule of a stub package (no av-events __init__ side effects).
pkg = types.ModuleType("avbench")
pkg.__path__ = [str(OV / "plugins" / "av-events")]
sys.modules["avbench"] = pkg
f1 = importlib.import_module("avbench._prompt_refresh")

TOOLS = ["memory", "terminal", "skills_list", "skill_view", "skill_manage", "web_search", "web_extract",
         "read_file", "write_file", "patch", "search_files", "execute_code", "todo", "session_search", "clarify",
         "send_message", "cronjob", "vision_analyze"]


def make_agent():
    store = MemoryStore()
    store.load_from_disk()
    agent = types.SimpleNamespace(
        load_soul_identity=True, skip_context_files=False, valid_tool_names=set(TOOLS),
        _task_completion_guidance=False, _tool_use_enforcement=False, _environment_probe=False,
        _kanban_worker_guidance="", _memory_store=store, _memory_manager=None, _memory_enabled=True,
        _user_profile_enabled=True, model="anthropic/claude-sonnet", provider="openrouter",
        platform="telegram", pass_session_id=False, session_id="bench-session", _session_db=None,
        _emit_status=lambda *a, **k: None, _emit_diagnostic_status=lambda *a, **k: None,
        _cached_system_prompt=None, _cached_system_prompt_static=None,
    )
    agent._invalidate_system_prompt = lambda: sp.invalidate_system_prompt(agent)
    agent._build_system_prompt = lambda system_message=None: sp.build_system_prompt(agent, system_message)
    return agent


def clear_cache():
    pb.clear_skills_system_prompt_cache(clear_snapshot=True)


def timed(fn, reps):
    out = []
    for _ in range(reps):
        t = time.perf_counter()
        fn()
        out.append((time.perf_counter() - t) * 1000)
    out.sort()
    return statistics.median(out), out[int(len(out) * 0.95) - 1] if len(out) > 1 else out[0], out[-1]


def fmt(name, stats):
    print(f"{name:<64} median {stats[0]:8.2f} ms  p95 {stats[1]:8.2f} ms  max {stats[2]:8.2f} ms")


agent = make_agent()
clear_cache()
prompt = sp.build_system_prompt(agent)
parts = sp.build_system_prompt_parts(agent)
skills_index = sp._skills_prompt(agent)
agents_md = (home / "AGENTS.md").read_text(encoding="utf-8")
print(f"hermes ref: {REF.name}; overlay skills staged: {len(staged)} ({', '.join(staged)})")
print(f"system prompt: {len(prompt):,} chars, {len(prompt.encode()):,} bytes, ~{len(prompt) // 4:,} tokens at 4 chars/token "
      f"(~{round(len(prompt) / 3.5):,} at 3.5)")
print(f"  tiers: stable {len(parts.get('stable', '')):,} | context {len(parts.get('context', '')):,} | volatile {len(parts.get('volatile', '')):,} chars")
print(f"  of which: AGENTS.md {len(agents_md):,} chars, skills index {len(skills_index):,} chars, "
      f"USER.md+MEMORY.md blocks {sum(len(agent._memory_store.format_for_system_prompt(t) or '') for t in ('user', 'memory')):,} chars")
print()


# 1. Pre-filter, every turn: sha256 of USER.md, MEMORY.md (+ AGENTS.md in `all`).
os.environ["AV_PROMPT_REFRESH_FILES"] = "memory"
fmt("pre-filter digests, files=memory (every turn)", timed(lambda: f1.file_digests(agent), REPS * 10))
os.environ.pop("AV_PROMPT_REFRESH_FILES")
assert f1.files_mode() == "all", f1.files_mode()
fmt("pre-filter digests, files=all default (every turn)", timed(lambda: f1.file_digests(agent), REPS * 10))

# 2. Exact test (first turn of a session in a new process, or a digest change): stale_reasons.
#    Old prompt = built before one skill was added (the v2.1.12 shape: a skills-only update).
extra = home / "skills" / "zz-bench-new-skill"
clear_cache()
old_prompt = sp.build_system_prompt(make_agent())
extra.mkdir()
(extra / "SKILL.md").write_text("---\nname: zz-bench-new-skill\ndescription: A newly staged skill for the bench.\n---\n# New\n",
                                encoding="utf-8")
clear_cache()  # a new process: empty LRU; the snapshot manifest no longer matches anyway
reasons = f1.stale_reasons(make_agent(), old_prompt)
print(f"exact test on the old prompt after a skills-only change: reasons={reasons}")


def exact_cold():
    clear_cache()
    f1.stale_reasons(make_agent(), old_prompt)


def exact_warm():
    f1.stale_reasons(agent, old_prompt)


fmt("exact test, cold skills cache (first turn in a new process)", timed(exact_cold, REPS))
fmt("exact test, warm skills cache", timed(exact_warm, REPS))


# 3. The refresh itself: invalidate (memory reloaded) + full build, skills cache warm (the exact test
#    just rendered the index through the same cache), as F1's refresh() does.
def rebuild_warm():
    agent._invalidate_system_prompt()
    agent._cached_system_prompt = agent._build_system_prompt(None)


def rebuild_cold():
    clear_cache()
    rebuild_warm()


fmt("F1 rebuild (invalidate + build), warm skills cache", timed(rebuild_warm, REPS))
fmt("F1 rebuild (invalidate + build), cold skills cache", timed(rebuild_cold, REPS))
new_prompt = agent._cached_system_prompt
print(f"rebuilt prompt: {len(new_prompt):,} chars (delta {len(new_prompt) - len(old_prompt):+,} vs the old session prompt); "
      f"bench skill present: {'zz-bench-new-skill' in new_prompt}; old prompt had it: {'zz-bench-new-skill' in old_prompt}")
same_prefix = os.path.commonprefix([old_prompt, new_prompt])
print(f"common prefix old/new: {len(same_prefix):,} chars of {len(new_prompt):,} (the provider cache breaks at the first changed byte)")
print(f"sha256 old {hashlib.sha256(old_prompt.encode()).hexdigest()[:12]} new {hashlib.sha256(new_prompt.encode()).hexdigest()[:12]}")
shutil.rmtree(home.parent, ignore_errors=True)
