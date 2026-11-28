"""POST-VILLAGE SETTING GUARD, the code that enforces the setting (review-b ov#633 M1, M2, S1; lead's ruling).

M1: the guard and its registration (the av-events plugin folder, `plugins/`, config.yaml's plugin lists,
`HERMES_SAFE_MODE`, `hermes plugins disable|remove ... av-events`). M2: every installed script that holds a
post-village check (the zzz runners and proactive shims in `$HERMES_HOME/scripts/`, the index-network and zzzbot
skill scripts, the village-bridge plugin) and the cron resume of a covered job while the setting keeps it off.
S1: globs for the policy scripts and `--enabled` with a policy key, whatever the script is called. One case per
path, negative controls for each. Synthetic paths and text only.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

import pytest

REFUSAL = ("Refused by Agent Village: this call touches the operator's post-village setting, a scheduled job it "
           "keeps off, or the code that enforces it. You cannot change those. If the person wants a scheduled job "
           "back on, tell them to contact the Agent Village team.")

REPO = Path(__file__).resolve().parents[3]
HOME = "/opt/data"
AUTONOMY, DIGEST, PAIRS, REMINDER = "aut0001", "dig0001", "par0001", "rem0001"
JOBS = {"jobs": [
    {"id": AUTONOMY, "name": "Edge — zzz event autonomy", "enabled": False},
    {"id": DIGEST, "name": "Edge — daily digest", "enabled": False},
    {"id": PAIRS, "name": "Edge — zzz pairs", "enabled": False},
    {"id": REMINDER, "name": "Water the plants", "enabled": False},
]}
CONFIG = ("model:\n  default: some/model\nplugins:\n  enabled:\n  - av-approval\n  - av-events\n  - village-bridge\n"
          "  disabled: []\n")


def t(command, **extra):
    return ("terminal", {"command": command, "background": False, **extra})


def cron(action, ref=None, **extra):
    args = {"action": action, **extra}
    if ref is not None:
        args["job_id"] = ref
    return ("cronjob_manage", args)


REFUSED = {
    # M1: the av-events plugin itself.
    "guard_write_file": ("write_file", {"path": f"{HOME}/plugins/av-events/_setting_guard.py", "content": "x = 1\n"}),
    "init_write_file": ("write_file", {"path": "$HERMES_HOME/plugins/av-events/__init__.py", "content": "x = 1\n"}),
    "other_module_write_file": ("write_file", {"path": "~/.hermes/plugins/av-events/_core.py", "content": "x = 1\n"}),
    "plugin_yaml_write_file": ("write_file", {"path": f"{HOME}/plugins/av-events/plugin.yaml", "content": "name: x\n"}),
    "init_patch": ("patch", {"path": f"{HOME}/plugins/av-events/__init__.py", "old_string": "setting_block =",
                             "new_string": "setting_block = None and"}),
    "init_patch_v4a": ("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Update File: plugins/av-events/__init__.py\n"
                                 "@@\n-a\n+b\n*** End Patch"}),
    "init_redirect": t("echo 'x = 1' > ~/.hermes/plugins/av-events/__init__.py"),
    "guard_heredoc": t(f"cat > {HOME}/plugins/av-events/_setting_guard.py <<'EOF'\nx = 1\nEOF"),
    "guard_rm": t("rm $HERMES_HOME/plugins/av-events/_setting_guard.py"),
    "guard_cp_onto": t(f"cp /tmp/g.py {HOME}/plugins/av-events/_setting_guard.py"),
    "guard_sed_i": t(f"sed -i 's/return True/return False/' {HOME}/plugins/av-events/_setting_guard.py"),
    "guard_truncate": t(f"truncate -s 0 {HOME}/plugins/av-events/_setting_guard.py"),
    "init_ln": t(f"ln -sf /tmp/x.py {HOME}/plugins/av-events/__init__.py"),
    "relative_after_cd_into_plugin": t("cd ~/.hermes/plugins/av-events && rm __init__.py"),
    "relative_with_workdir_plugin": t("echo 'x = 1' > _core.py", workdir=f"{HOME}/plugins/av-events"),
    "glob_in_plugin": t(f"rm {HOME}/plugins/av-events/*.py"),
    "plugin_folder_rm": t("rm -rf ~/.hermes/plugins/av-events"),
    "plugin_folder_mv": t(f"mv {HOME}/plugins/av-events /tmp/old"),
    "plugins_folder_mv": t(f"mv {HOME}/plugins /tmp/p"),
    "plugins_folder_rm": t("rm -rf $HERMES_HOME/plugins"),
    "plugins_folder_relative": t(f"cd {HOME} && mv plugins plugins.old"),
    "plugins_glob_into_plugin": t(f"rm {HOME}/plugins/*/__init__.py"),
    "python_c_onto_init": t(f"python3 -c \"open('{HOME}/plugins/av-events/__init__.py', 'w').write('')\""),
    "execute_code_onto_guard": ("execute_code", {"code": f"open('{HOME}/plugins/av-events/_setting_guard.py', 'w').write('')"}),
    "skill_manage_content_onto_guard": ("skill_manage", {"action": "write_file", "name": "helper", "file_path": "scripts/x.sh",
                                                         "file_content": f"rm {HOME}/plugins/av-events/_setting_guard.py\n"}),
    "hermes_plugins_disable": t("hermes plugins disable av-events"),
    "hermes_plugins_disable_underscore": t("hermes plugins disable av_events"),
    "hermes_plugins_remove": t("hermes plugins remove av-events"),
    "hermes_plugins_rm": t("hermes plugins rm av-events"),
    "hermes_plugins_uninstall_underscore": t("hermes plugins uninstall av_events"),
    "hermes_plugins_update": t("hermes plugins update av-events"),
    "config_write_drops_av_events": ("write_file", {"path": "$HERMES_HOME/config.yaml",
                                                    "content": CONFIG.replace("  - av-events\n", "")}),
    "config_write_disables_av_events": ("write_file", {"path": f"{HOME}/config.yaml",
                                                       "content": CONFIG.replace("disabled: []", "disabled: [av_events]")}),
    "config_write_no_plugins": ("write_file", {"path": "config.yaml", "content": "model:\n  default: x\n"}),
    "config_write_unparseable": ("write_file", {"path": f"{HOME}/config.yaml", "content": "plugins: [\n"}),
    "config_patch_v4a": ("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Update File: config.yaml\n@@\n- - av-events\n"
                                   "*** End Patch"}),
    "config_sed_drop": t("sed -i '/av-events/d' ~/.hermes/config.yaml"),
    "config_sed_rename_key": t(f"sed -i 's/^  enabled:/  enabledx:/' {HOME}/config.yaml"),
    "config_set_plugins": t("hermes config set plugins.enabled '[]'"),
    "config_replace_whole": t(f"mv /tmp/c.yaml {HOME}/config.yaml"),
    "config_cp_onto": t("cp /tmp/c.yaml $HERMES_HOME/config.yaml"),
    "config_rm": t("rm ~/.hermes/config.yaml"),
    "safe_mode_env_append": t("echo HERMES_SAFE_MODE=1 >> ~/.hermes/.env"),
    "safe_mode_env_write_file": ("write_file", {"path": f"{HOME}/.env", "content": "HERMES_SAFE_MODE=1\n"}),
    "safe_mode_execute_code": ("execute_code", {"code": "open('.env', 'a').write('HERMES_SAFE_MODE=1')"}),
    # M2: the installed scripts that hold a post-village check, and the cron store's covered jobs.
    "runner_patch": ("patch", {"path": "$HERMES_HOME/scripts/zzz_autonomy_runner.py",
                               "old_string": "def _post_village_allowed(home: Path, key: str = \"zzz_event_autonomy\"):\n",
                               "new_string": "def _post_village_allowed(home, key='x'):\n    return True\n"}),
    "runner_write_file": ("write_file", {"path": f"{HOME}/scripts/zzz_autonomy_runner.py", "content": "print(1)\n"}),
    "runner_sed_i": t(f"sed -i 's/return False/return True/' {HOME}/scripts/zzz_autonomy_runner.py"),
    "runner_sed_after_cd": t("cd ~/.hermes/scripts && sed -i 's/return False/return True/' zzz_autonomy_runner.py"),
    "runner_cp_onto": t("cp /tmp/r.py ~/.hermes/scripts/zzz_autonomy_runner.py"),
    "runner_redirect": t(f"printf 'x' > {HOME}/scripts/zzz_autonomy_runner.py"),
    "runner_glob_after_cd": t("rm *.py", workdir=f"{HOME}/scripts"),
    "scripts_glob": t(f"rm {HOME}/scripts/*"),
    "managed_runner_write": ("write_file", {"path": f"{HOME}/scripts/zzz_managed_runner.py", "content": "x"}),
    "legacy_pairs_shim_write": ("write_file", {"path": f"{HOME}/scripts/agentvillage_zzz_pairs.sh", "content": "x"}),
    "proactive_shim_write": ("write_file", {"path": f"{HOME}/scripts/agentvillage_proactive_brief.sh", "content": "x"}),
    "proactive_shim_sed": t(f"sed -i 's/silent/true/' {HOME}/scripts/agentvillage_proactive_pending.sh"),
    "scripts_folder_mv": t("mv ~/.hermes/scripts /tmp/s"),
    "proactive_patch": ("patch", {"path": f"{HOME}/skills/index-network/scripts/proactive.ts",
                                  "old_string": "postVillageAllowed(home, policyKey)", "new_string": "true"}),
    "welcome_write": ("write_file", {"path": f"{HOME}/skills/index-network/scripts/welcome.ts", "content": "x"}),
    "pause_job_sed": t("sed -i 's/post-village-disabled/ok/' skills/index-network/scripts/pause-job.ts", workdir=HOME),
    "runnable_write": ("write_file", {"path": f"{HOME}/skills/index-network/scripts/post-village-runnable.ts", "content": "x"}),
    "job_holds_write": ("write_file", {"path": f"{HOME}/skills/index-network/scripts/job-holds.ts", "content": "x"}),
    "pending_alert_cp": t(f"cp /tmp/p.ts {HOME}/skills/index-network/scripts/pending-alert.ts"),
    "skill_runner_source_write": ("write_file", {"path": f"{HOME}/skills/zzzbot/scripts/zzz_autonomy_runner.py", "content": "x"}),
    "skill_scripts_folder_rm": t("rm -rf ~/.hermes/skills/index-network"),
    "skill_manage_index_script": ("skill_manage", {"action": "write_file", "name": "index-network",
                                                   "file_path": "scripts/proactive.ts", "file_content": "x"}),
    "skill_manage_zzzbot_delete": ("skill_manage", {"action": "delete", "name": "zzzbot"}),
    "bridge_gate_write": ("write_file", {"path": f"{HOME}/plugins/village-bridge/_zzz_managed.py", "content": "x"}),
    "execute_code_runner": ("execute_code", {"code": f"p = '{HOME}/scripts/zzz_autonomy_runner.py'\n"
                                             "s = open(p).read().replace('return False', 'return True')\nopen(p, 'w').write(s)"}),
    "cron_resume_by_id": cron("resume", AUTONOMY),
    "cron_resume_by_name": cron("resume", "Edge — zzz event autonomy"),
    "cron_resume_by_name_any_case": cron("resume", "edge — ZZZ EVENT AUTONOMY"),
    "cron_resume_digest": cron("resume", DIGEST),
    "cron_resume_pairs": cron("resume", PAIRS),
    "cron_run": cron("run", AUTONOMY),
    "cron_run_now": cron("run_now", AUTONOMY),
    "cron_trigger": cron("trigger", AUTONOMY),
    "cron_update": cron("update", AUTONOMY, prompt="post now"),
    "cron_enable_word": cron("enable", AUTONOMY),
    "cron_create_covered_name": cron("create", name="Edge — zzz event autonomy", schedule="every 5m", prompt="x"),
    "hermes_cron_resume": t(f"hermes cron resume {AUTONOMY}"),
    "hermes_cron_resume_name": t("hermes cron resume 'Edge — daily digest'"),
    "hermes_cron_run": t(f"hermes cron run {AUTONOMY}"),
    "hermes_cron_edit": t(f"hermes cron edit {AUTONOMY} --prompt 'post now'"),
    "hermes_cron_resume_run_now": t(f"cd {HOME} && hermes cron resume --run-now {PAIRS}"),
    # S1: globs for the policy scripts, and the allow list whatever carries it.
    "operator_by_glob": t(f"bun /srv/overlay/install/post_vill*.ts set --home {HOME} --job zzz_pairs --enabled true"),
    "operator_by_dash_glob": t("bun install/post-village-*.ts set --job zzz_event_autonomy --enabled true"),
    "renamed_operator": t(f"bun /tmp/x.ts set --home {HOME} --job zzz_event_autonomy --enabled true"),
    "enabled_flag_execute_code": ("execute_code", {"code": "import subprocess\nsubprocess.run(['bun', s, 'set', '--job', "
                                                   "'zzz_pairs', '--enabled', 'true'])"}),
    "allow_list_json_elsewhere": t("echo '{\"version\":1,\"enabled\":[\"zzz_event_autonomy\"]}' > /tmp/p.json"),
    "allow_list_json_write_file": ("write_file", {"path": "/tmp/p.json",
                                                  "content": '{"version": 1, "enabled": ["daily_digest"]}'}),
    "execute_code_glob_setting": ("execute_code", {"code": "import glob, os\nfor p in glob.glob(os.environ['HERMES_HOME'] + "
                                                   "'/av-events/*.json'):\n    open(p, 'w').write('{}')"}),
}

ALLOWED = {
    "read_guard": t(f"cat {HOME}/plugins/av-events/_setting_guard.py"),
    "read_guard_tool": ("read_file", {"path": f"{HOME}/plugins/av-events/_setting_guard.py"}),
    "grep_runner": t("grep -n _post_village_allowed ~/.hermes/scripts/zzz_autonomy_runner.py"),
    "copy_runner_out": t(f"cp {HOME}/scripts/zzz_autonomy_runner.py /tmp/runner-copy.py"),
    "copy_plugin_out": t("cp ~/.hermes/plugins/av-events/__init__.py /tmp/init-copy.py"),
    "run_skill_script": t("bun skills/index-network/scripts/passes.ts --limit 5", workdir=HOME),
    "run_welcome": t(f"bun {HOME}/skills/index-network/scripts/welcome.ts"),
    "resident_pause": t('bun skills/index-network/scripts/pause-job.ts pause --label "Daily digest"', workdir=HOME),
    "resident_resume": t('bun skills/index-network/scripts/pause-job.ts resume --label "Daily digest"', workdir=HOME),
    "own_cron_script": ("write_file", {"path": f"{HOME}/scripts/water_plants.py", "content": "print('water the plants')\n"}),
    "own_cron_script_terminal": t("echo 'print(1)' > ~/.hermes/scripts/water_plants.py"),
    "own_skill_script": ("skill_manage", {"action": "write_file", "name": "garden", "file_path": "scripts/run.py",
                                          "file_content": "print(1)\n"}),
    "bare_glob_unplaced": t("rm *.py"),
    "bare_ts_glob_unplaced": t("rm *.ts"),
    "config_write_keeps_av_events": ("write_file", {"path": f"{HOME}/config.yaml",
                                                    "content": CONFIG.replace("some/model", "other/model")}),
    "config_sed_model": t("sed -i 's/^  default: .*/  default: other\\/model/' $HERMES_HOME/config.yaml"),
    "config_read": t("cat ~/.hermes/config.yaml"),
    "config_copy_out": t(f"cp {HOME}/config.yaml /tmp/config-copy.yaml"),
    "other_project_config": ("write_file", {"path": "/tmp/project/config.yaml", "content": "a: 1\n"}),
    "hermes_plugins_list": t("hermes plugins list"),
    "hermes_plugins_disable_other": t("hermes plugins disable some-other-plugin"),
    "env_other_line": t("echo 'TZ=Asia/Kolkata' >> ~/.hermes/.env"),
    "cron_pause_covered": cron("pause", AUTONOMY),
    "cron_pause_covered_by_name": cron("pause", "Edge — daily digest"),
    "cron_remove_covered": cron("remove", DIGEST),
    "cron_resume_own": cron("resume", REMINDER),
    "cron_run_own": cron("run", REMINDER),
    "cron_create_own": cron("create", name="Water the plants", schedule="every day at 9am", prompt="Remind me."),
    "cron_list": cron("list"),
    "cron_resume_unknown": cron("resume", "zzz9999"),
    "hermes_cron_pause_covered": t(f"hermes cron pause {AUTONOMY}"),
    "hermes_cron_resume_own": t(f"hermes cron resume {REMINDER}"),
    "hermes_cron_list": t("hermes cron list"),
    "operator_status_glob_read": t("ls /srv/overlay/install/post_vill*.ts"),
    "enabled_word_alone": t("grep -n enabled ~/.hermes/config.yaml"),
    "scripts_glob_elsewhere": t("rm -rf /tmp/build/scripts/*"),
    "skill_script_read_with_sed": t("sed -n 1,40p skills/index-network/scripts/proactive.ts", workdir=HOME),
    "own_skill_script_terminal": t("mkdir -p ~/.hermes/skills/garden/scripts && echo 'print(1)' > ~/.hermes/skills/garden/scripts/run.py"),
}


@pytest.fixture
def box(plugin, ctx, home):
    (home / "cron").mkdir()
    (home / "cron" / "jobs.json").write_text(json.dumps(JOBS), encoding="utf-8")
    (home / "config.yaml").write_text(CONFIG, encoding="utf-8")
    plugin.register(ctx)
    return ctx


def fire(ctx, tool, args):
    return ctx.fire("pre_tool_call", tool_name=tool, args=args, session_id="s", task_id="t", tool_call_id="c",
                    turn_id="u")


def _fix_home(args, home):
    """Point the config.yaml cases that the guard must read at the test's own home."""
    out = json.loads(json.dumps(args).replace(f"{HOME}/config.yaml", f"{home}/config.yaml"))
    return out


@pytest.mark.parametrize("name", sorted(REFUSED))
def test_refused(box, home, name):
    tool, args = REFUSED[name]
    assert fire(box, tool, _fix_home(args, home)) == [{"action": "block", "message": REFUSAL}], name


@pytest.mark.parametrize("name", sorted(ALLOWED))
def test_allowed(box, home, name):
    tool, args = ALLOWED[name]
    results = fire(box, tool, _fix_home(args, home))
    assert all(r.get("action") != "block" for r in results), (name, results)


def _allow(home, *keys):
    (home / "av-events").mkdir(exist_ok=True)
    (home / "av-events" / "post-village-policy.json").write_text(json.dumps({"version": 1, "enabled": list(keys)}),
                                                                   encoding="utf-8")


@pytest.mark.parametrize("call", [cron("resume", AUTONOMY), cron("run", AUTONOMY), cron("resume", "Edge — zzz event autonomy"),
                                  t(f"hermes cron resume {AUTONOMY}")])
def test_cron_resume_passes_when_the_setting_allows_the_job(box, home, call):
    _allow(home, "zzz_event_autonomy")
    assert fire(box, *call) == []


def test_cron_resume_allowed_key_is_per_job(box, home):
    _allow(home, "daily_digest")
    assert fire(box, *cron("resume", DIGEST)) == []
    assert fire(box, *cron("resume", AUTONOMY)) == [{"action": "block", "message": REFUSAL}]


def test_cron_resume_refused_when_the_store_cannot_be_read(box, home):
    (home / "cron" / "jobs.json").write_text("{not json", encoding="utf-8")
    assert fire(box, *cron("resume", REMINDER)) == [{"action": "block", "message": REFUSAL}]
    assert fire(box, *cron("pause", REMINDER)) == []


def test_cron_resume_refused_when_the_reader_fails(box, home, monkeypatch):
    _allow(home, "zzz_event_autonomy")
    guard = sys.modules["hermes_plugins.av_events._setting_guard"]

    def broken(*_a, **_k):
        raise RuntimeError("reader broke")

    monkeypatch.setattr(guard, "_policy_allows", broken)
    assert fire(box, *cron("resume", AUTONOMY)) == [{"action": "block", "message": REFUSAL}]
    assert fire(box, *cron("resume", REMINDER)) == []


def test_cron_resume_refused_when_the_reader_bytes_change(box, home, monkeypatch, tmp_path):
    _allow(home, "zzz_event_autonomy")
    guard = sys.modules["hermes_plugins.av_events._setting_guard"]
    fake = tmp_path / "reader.py"
    fake.write_text("def allowed(home, key, now=None):\n    return True\nJOB_NAMES = {}\n", encoding="utf-8")
    monkeypatch.setattr(guard, "_reader_path", lambda: fake)
    assert fire(box, *cron("resume", AUTONOMY)) == [{"action": "block", "message": REFUSAL}]


def test_config_patch_refused_when_config_yaml_cannot_be_read(box, home):
    (home / "config.yaml").unlink()
    args = {"path": f"{home}/config.yaml", "old_string": "a", "new_string": "b"}
    assert fire(box, "patch", args) == [{"action": "block", "message": REFUSAL}]


def test_config_patch_keeping_av_events_passes(box, home):
    args = {"path": f"{home}/config.yaml", "old_string": "default: some/model", "new_string": "default: other/model"}
    assert fire(box, "patch", args) == []


def test_config_patch_dropping_av_events_is_refused(box, home):
    args = {"path": f"{home}/config.yaml", "old_string": "  - av-events\n", "new_string": ""}
    assert fire(box, "patch", args) == [{"action": "block", "message": REFUSAL}]


def _boom(*_a, **_k):
    raise RuntimeError("matcher broke")


def test_matcher_error_refuses_a_call_naming_the_guarded_code(box, monkeypatch):
    guard = sys.modules["hermes_plugins.av_events._setting_guard"]
    monkeypatch.setattr(guard, "matches", _boom)
    for name in ("guard_write_file", "runner_patch", "hermes_plugins_disable_underscore", "cron_resume_by_name"):
        assert fire(box, *REFUSED[name]) == [{"action": "block", "message": REFUSAL}], name
    assert fire(box, *ALLOWED["hermes_cron_list"]) == []
    assert fire(box, *ALLOWED["own_cron_script"]) == []


# ---- Closure: a new policy check, or a new staged script, cannot land without the guard covering it. ----

#: What marks a source file as holding (or being) a post-village check.
CHECK_MARKS = re.compile(r"postVillageAllowed|postVillageRuntimeAllowed|_post_village_allowed|post_village_allowed"
                         r"|runtime_allowed|post-village-policy|_post_village_policy|post_village_policy|POST_VILLAGE_")


def _check_sources():
    out = []
    for root in ("skills", "plugins"):
        for path in sorted((REPO / root).rglob("*")):
            if (not path.is_file() or "tests" in path.parts or "__pycache__" in path.parts
                    or path.suffix not in (".ts", ".py", ".sh", ".json", ".js")):
                continue
            if CHECK_MARKS.search(path.read_text(encoding="utf-8", errors="replace")):
                out.append(path.relative_to(REPO).as_posix())
    return out


def test_closure_every_installed_policy_check_is_guarded(plugin):
    """Every skill or plugin file that holds a post-village check is installed at the same path under the Hermes
    home (install/install.ts copySkillBundles, install/install_approval.ts stagePlugins); a write there is refused.
    A new check in a file the guard does not cover fails here."""
    guard = sys.modules["hermes_plugins.av_events._setting_guard"]
    sources = _check_sources()
    assert "skills/zzzbot/scripts/zzz_autonomy_runner.py" in sources and "skills/index-network/scripts/welcome.ts" in sources
    missing = [rel for rel in sources
               if not guard.matches("write_file", {"path": f"{HOME}/{rel}", "content": "x"}, {"HERMES_HOME": HOME})]
    assert missing == []


def _staged_script_names():
    """Every file name the installers stage into `$HERMES_HOME/scripts/`."""
    install = REPO / "install"
    names = set()
    for path in install.glob("*.ts"):
        text = path.read_text(encoding="utf-8")
        names |= set(re.findall(r'scriptInstallName:\s*"([^"$`]+)"', text))
        names |= set(re.findall(r'(?:AUTONOMY_JOB_SCRIPT|ZZZ_JOB_SCRIPT|LEGACY_JOB_SCRIPT)\s*=\s*"([^"]+)"', text))
    shim = (REPO / "skills/index-network/scripts/shims/agentvillage_proactive.sh").read_text(encoding="utf-8")
    case = re.search(r'case "\$ACTION" in(.*?)\*\)', shim, re.S).group(1)
    for action in re.findall(r"[a-z][a-z-]*(?:-[a-z]+)*", case):
        names.add(f"agentvillage_proactive_{action}.sh")
    return sorted(names)


def test_closure_every_staged_script_is_guarded(plugin):
    """The installers stage the zzz runners, the legacy pairs shim and the proactive shims (one name per action)
    into `$HERMES_HOME/scripts/`, where Hermes runs a cron script fresh on every tick: each name is refused."""
    guard = sys.modules["hermes_plugins.av_events._setting_guard"]
    names = _staged_script_names()
    assert {"zzz_autonomy_runner.py", "zzz_managed_runner.py", "agentvillage_zzz_pairs.sh",
            "agentvillage_proactive_brief.sh", "agentvillage_proactive_pending.sh"} <= set(names)
    missing = [n for n in names if not guard.matches("write_file", {"path": f"{HOME}/scripts/{n}", "content": "x"},
                                                     {"HERMES_HOME": HOME})]
    assert missing == []


def test_closure_reader_pin_is_the_runners(plugin):
    """The cron rule reads the setting with the runner's own pinned Python reader: same bytes, same pin."""
    guard = sys.modules["hermes_plugins.av_events._setting_guard"]
    runner = (REPO / "skills/zzzbot/scripts/zzz_autonomy_runner.py").read_text(encoding="utf-8")
    pin = re.search(r'POLICY_READER_SHA256 = "([0-9a-f]{64})"', runner).group(1)
    reader = REPO / "plugins/village-bridge/_post_village_policy.py"
    assert guard.POLICY_READER_SHA256 == pin == hashlib.sha256(reader.read_bytes()).hexdigest()


def test_closure_covered_job_names_match_the_ts_reader(plugin):
    """The covered job names come from the pinned reader's JOB_NAMES; they equal the TypeScript reader's."""
    guard = sys.modules["hermes_plugins.av_events._setting_guard"]
    ts = (REPO / "skills/index-network/scripts/post-village-policy.ts").read_text(encoding="utf-8")
    block = re.search(r"POST_VILLAGE_JOB_NAMES[^=]*=\s*\{(.*?)\};", ts, re.S).group(1)
    ts_names = set(re.findall(r'"(Edge — [^"]+)"', block))
    assert set(guard.covered_jobs()) == ts_names
