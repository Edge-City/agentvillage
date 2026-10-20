"""Credential custody (`_custody.py`, approval code-gap lane 2): the strip list, the three levers, the probe,
the switch, the inventory.

Fake Hermes modules stand in for the real ones; the Hermes-backed test at the end runs the real builders
when Hermes is importable (it skips in CI, as the other Hermes-backed suites do). Every value here is the
placeholder `example-not-a-key`.
"""

from __future__ import annotations

import abc
import json
import logging
import os
import re
import sys
import types
from pathlib import Path

import pytest

from .conftest import PLUGIN_DIR, ExplodingCtx, FakeCtx, load_plugin, write_gate

REPO = PLUGIN_DIR.parents[1]
PH = "example-not-a-key"
STRIP = {"INDEX_API_KEY", "INDEX_SESSION_TOKEN", "AV_EVENTS_TOKEN", "AV_BACKUP_TOKEN", "ADMIN_TOKEN",
         "MORALMOD_LLM_API_KEY"}


def custody():
    plugin = load_plugin()
    return __import__(f"{plugin.__name__}._custody", fromlist=["_custody"])


# ---------------------------------------------------------------------------
# Fake Hermes: the registry, the provider base, the two builders and their callers, the config
# ---------------------------------------------------------------------------

class FakeProviderBase(abc.ABC):
    @property
    @abc.abstractmethod
    def name(self) -> str: ...

    @property
    def strip_env_keys(self) -> frozenset:
        return frozenset()

    @abc.abstractmethod
    def is_available(self) -> bool: ...

    @abc.abstractmethod
    def create_environment(self, **kwargs): ...


SOURCE = {"PATH": "/usr/bin:/bin", "INDEX_API_KEY": PH, "index_api_key": PH, "AV_EVENTS_TOKEN": PH,
          "AV_BACKUP_TOKEN": PH, "INDEX_SESSION_TOKEN": PH, "EDGEOS_API_KEY": PH, "AV_POPUP_ID": PH,
          "TELEGRAM_BOT_TOKEN": PH}


def _run_bash_calls_the_builder(self, command):
    return _make_run_env({})  # noqa: F821 - only its code's names are read


def _run_bash_calls_another_builder(self, command):
    return _another_builder({})  # noqa: F821


def _build_child_env_calls_the_scrub(**kwargs):
    return _scrub_child_env({})  # noqa: F821


def fake_hermes(*, registry=True, local=True, code=True, config=None, version="0.21.5",
                run_bash=_run_bash_calls_the_builder, leaky=False):
    providers: list = []
    modules: dict[str, types.ModuleType] = {}
    reg = types.ModuleType("agent.terminal_env_registry")
    if registry:
        reg.register_provider = lambda p: providers.append(p)
        reg.plugin_strip_env_keys = lambda: frozenset().union(*(p.strip_env_keys for p in providers))
    modules["agent.terminal_env_registry"] = reg
    base = types.ModuleType("agent.terminal_env_provider")
    base.TerminalEnvironmentProvider = FakeProviderBase
    modules["agent.terminal_env_provider"] = base
    loc = types.ModuleType("tools.environments.local")
    if local:
        loc._make_run_env = lambda env: {**SOURCE, **env}
        loc.LocalEnvironment = type("LocalEnvironment", (), {"_run_bash": run_bash})
    modules["tools.environments.local"] = loc
    ce = types.ModuleType("tools.code_execution_env")
    if code:
        ce._scrub_child_env = lambda source_env, is_passthrough=None, is_windows=None: dict(source_env)
        ce._build_child_env = _build_child_env_calls_the_scrub
    modules["tools.code_execution_env"] = ce
    cfg = types.ModuleType("hermes_cli.config")
    cfg.read_raw_config = lambda: dict(config or {})
    cfg.cfg_get = lambda c, *keys, default=None: _cfg_get(c, keys, default)
    modules["hermes_cli.config"] = cfg
    cli = types.ModuleType("hermes_cli")
    cli.__version__ = version
    modules["hermes_cli"] = cli

    def importer(name: str):
        if name not in modules:
            raise ImportError(name)
        return modules[name]

    if leaky:  # a Hermes whose builder re-adds the name after the wrap (a reroute behind the name)
        def wrap_again():
            wrapped = loc._make_run_env
            loc._make_run_env = lambda env: {**wrapped(env), "INDEX_API_KEY": "re-added"}
        importer.wrap_again = wrap_again  # type: ignore[attr-defined]
    return importer, modules, providers


def _cfg_get(cfg, keys, default):
    node = cfg
    for key in keys:
        if not isinstance(node, dict) or key not in node:
            return default
        node = node[key]
    return node


# ---------------------------------------------------------------------------
# The decisions file and the floor
# ---------------------------------------------------------------------------

def test_the_manifest_loads_and_every_entry_has_a_decision_and_a_reason():
    c = custody()
    data = c.load_manifest()
    assert data["version"] == "av_custody_keys_v1"
    for name, entry in data["names"].items():
        assert re.fullmatch(r"[A-Z][A-Z0-9_]*", name), name
        assert entry["decision"] in c.DECISIONS and entry["reason"].strip(), name


def test_the_strip_list_is_the_one_this_lane_decided_and_equals_the_floor():
    c = custody()
    assert c.strip_names() == STRIP == c.FLOOR
    assert c.effective_names() == (frozenset(STRIP), frozenset())


def test_provider_keys_hermes_strips_are_not_on_the_overlay_list():
    # The plugin's keys are Hermes's tier 1: stripped even where a child is meant to inherit LLM
    # credentials (codex, claude CLIs). Provider keys must stay Hermes's own tier 2.
    names = custody().load_manifest()["names"]
    for name in ("OPENROUTER_API_KEY", "GROQ_API_KEY", "TELEGRAM_BOT_TOKEN", "BROWSERBASE_API_KEY"):
        assert names[name]["decision"] == "hermes", name


@pytest.mark.parametrize("bad", [
    {"names": {}},
    {"names": {"X_TOKEN": {"decision": "maybe", "reason": "r"}}},
    {"names": {"X_TOKEN": {"decision": "strip", "reason": " "}}},
])
def test_a_malformed_manifest_is_refused(tmp_path, bad):
    path = tmp_path / "custody_keys.json"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError):
        custody().load_manifest(path)


@pytest.mark.parametrize("edit", ["emptied", "unreadable"])
def test_an_edited_or_unreadable_manifest_cannot_shrink_the_list_and_says_so(monkeypatch, caplog, tmp_path, edit):
    c = custody()
    path = tmp_path / "custody_keys.json"
    if edit == "emptied":
        data = c.load_manifest()
        for entry in data["names"].values():
            entry["decision"] = "hermes"
        path.write_text(json.dumps(data), encoding="utf-8")
    else:
        path.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(c, "MANIFEST_PATH", path)
    monkeypatch.setattr(c.load_manifest, "__defaults__", (path,))
    importer, modules, providers = fake_hermes()
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        covered = c.install(importer=importer)
    assert covered == {"provider": True, "foreground": True, "execute_code": True}
    assert providers[0].strip_env_keys == STRIP
    assert not STRIP & set(modules["tools.environments.local"]._make_run_env({}))
    warnings = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1 and "does not mark" in warnings[0] and "stripped anyway" in warnings[0]


# ---------------------------------------------------------------------------
# The levers and the probe
# ---------------------------------------------------------------------------

def test_install_covers_all_three_surfaces_and_strips_case_folded(caplog):
    c = custody()
    importer, modules, providers = fake_hermes()
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        covered = c.install(importer=importer)
    assert covered == {"provider": True, "foreground": True, "execute_code": True}
    lines = [(r.levelno, r.getMessage()) for r in caplog.records]
    assert lines == [(logging.INFO, "av-approval: custody: 6 names withheld from agent-run code "
                                    "(provider, foreground, execute_code)")]

    fg = modules["tools.environments.local"]._make_run_env({"AV_BACKUP_TOKEN": PH, "EXTRA": "1"})
    assert not {k.upper() for k in fg} & STRIP
    assert fg["EDGEOS_API_KEY"] == PH and fg["AV_POPUP_ID"] == PH and fg["EXTRA"] == "1"

    ec = modules["tools.code_execution_env"]._scrub_child_env(SOURCE, is_passthrough=lambda _n: True)
    assert not {k.upper() for k in ec} & STRIP
    assert ec["EDGEOS_API_KEY"] == PH

    assert len(providers) == 1
    provider = providers[0]
    assert provider.name == c.PROVIDER_NAME and provider.strip_env_keys == STRIP
    assert provider.is_available() is False and "do not select" in provider.description
    with pytest.raises(RuntimeError):
        provider.create_environment(cwd="/", timeout=1)


def test_install_is_idempotent():
    c = custody()
    importer, modules, _ = fake_hermes()
    c.install(importer=importer)
    first = modules["tools.environments.local"]._make_run_env
    c.install(importer=importer)
    assert modules["tools.environments.local"]._make_run_env is first
    assert getattr(first, c.WRAPPED_MARK) is True


def test_wrapped_builders_keep_their_arguments_and_pass_non_dicts_through():
    c = custody()
    mod = types.ModuleType("m")
    seen = []
    mod.build = lambda *a, **k: (seen.append((a, k)), None)[1]
    assert c.wrap(mod, "build", frozenset(STRIP))
    assert mod.build(1, x=2) is None and seen == [((1,), {"x": 2})]
    assert c.wrap(mod, "missing", frozenset(STRIP)) is False


def test_the_probe_spawns_a_real_child_through_the_foreground_builder(monkeypatch):
    c = custody()
    importer, modules, _ = fake_hermes()
    spawned = []
    real = c._spawn_sees_canary
    monkeypatch.setattr(c, "_spawn_sees_canary", lambda env: (spawned.append(dict(env)), real(env))[1])
    assert c.install(importer=importer)["foreground"] is True
    assert len(spawned) == 1 and c.CANARY_NAME not in spawned[0]


def test_a_child_that_still_sees_the_canary_is_not_covered():
    c = custody()
    assert c._spawn_sees_canary({"PATH": "/usr/bin:/bin", c.CANARY_NAME: c.CANARY_VALUE}) is True
    assert c._spawn_sees_canary({"PATH": "/usr/bin:/bin"}) is False


def test_a_reroute_behind_the_name_is_caught(caplog):
    # Hermes keeps `_make_run_env` but LocalEnvironment._run_bash builds its env elsewhere.
    c = custody()
    importer, _, _ = fake_hermes(run_bash=_run_bash_calls_another_builder)
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        covered = c.install(importer=importer)
    assert covered == {"provider": True, "foreground": False, "execute_code": True}
    assert "av-approval: custody: NOT covered: foreground; those children still receive the service keys" in [
        r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]


def test_a_builder_that_re_adds_the_name_is_caught():
    c = custody()
    importer, modules, _ = fake_hermes(leaky=True)
    c.install(importer=importer)
    importer.wrap_again()
    assert c.probe(importer, "foreground") is False


def test_another_hermes_version_is_said(caplog):
    c = custody()
    importer, _, _ = fake_hermes(version="0.22.0")
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        covered = c.install(importer=importer)
    assert all(covered.values())
    assert any("measured at Hermes 0.21.5, running 0.22.0" in r.getMessage() for r in caplog.records
               if r.levelno >= logging.WARNING)


def test_a_missing_lever_is_reported_and_the_others_still_apply(caplog):
    c = custody()
    importer, modules, providers = fake_hermes(local=False)
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        covered = c.install(importer=importer)
    assert covered == {"provider": True, "foreground": False, "execute_code": True}
    lines = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert lines == ["av-approval: custody: NOT covered: foreground; those children still receive the service keys"]


def test_without_hermes_nothing_raises_and_everything_is_uncovered():
    def importer(name):
        raise ImportError(name)

    assert custody().install(importer=importer) == {"provider": False, "foreground": False, "execute_code": False}


# ---------------------------------------------------------------------------
# The switch: config.yaml only, never the environment
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", [False, "false", "off", "0", " No "])
def test_config_yaml_turns_it_off_and_touches_nothing(caplog, value):
    c = custody()
    importer, modules, providers = fake_hermes(config={"av_approval": {"custody": value}})
    original = modules["tools.environments.local"]._make_run_env
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        covered = c.install(importer=importer)
    assert covered == {"provider": False, "foreground": False, "execute_code": False}
    assert modules["tools.environments.local"]._make_run_env is original and providers == []
    assert [r.getMessage() for r in caplog.records] == [c.OFF_LINE]


@pytest.mark.parametrize("config", [None, {}, {"av_approval": {}}, {"av_approval": {"custody": True}},
                                    {"av_approval": {"custody": "yes"}}, {"av_approval": "off"}])
def test_anything_else_in_config_is_on(config):
    c = custody()
    importer, _, _ = fake_hermes(config=config)
    assert c.switch(importer) == "on"


def test_an_unreadable_config_is_on():
    def importer(name):
        raise RuntimeError(name)

    assert custody().switch(importer) == "on"


@pytest.mark.parametrize("name", ["AV_CUSTODY", "AV_APPROVAL_CUSTODY"])
def test_no_environment_variable_turns_it_off(monkeypatch, name):
    # A project .env (~/.hermes/hermes-agent/.env) or ~/.hermes/.op.env is loaded into the gateway's
    # environment and the hook allows the agent to write both (refuter M1): nothing there may count.
    monkeypatch.setenv(name, "0")
    c = custody()
    importer, _, _ = fake_hermes()
    assert c.install(importer=importer) == {"provider": True, "foreground": True, "execute_code": True}
    assert "environ" not in c.switch.__code__.co_names


# ---------------------------------------------------------------------------
# register(): custody on every box, the gate half only with the switch on
# ---------------------------------------------------------------------------

def test_register_applies_custody_in_every_gate_state_without_touching_ctx(clean_env, tmp_path, monkeypatch):
    calls = []
    home = tmp_path / ".hermes"
    home.mkdir()
    clean_env.setenv("HERMES_HOME", str(home))
    for state in (None, "0", "1"):
        if state is None:
            clean_env.delenv("AV_APPROVAL_ENABLED", raising=False)
        else:
            clean_env.setenv("AV_APPROVAL_ENABLED", state)
        plugin = load_plugin()
        c = __import__(f"{plugin.__name__}._custody", fromlist=["_custody"])
        monkeypatch.setattr(c, "install", lambda: calls.append(state) or {})
        ctx = ExplodingCtx() if state != "1" else types.SimpleNamespace(register_hook=lambda *a, **k: None)
        plugin.register(ctx)
    assert calls == [None, "0", "1"]


@pytest.mark.parametrize("gate", ["absent", "broken", "healthy"])
def test_with_the_switch_unset_custody_runs_and_the_gate_half_blocks_nothing(clean_env, tmp_path, monkeypatch, gate):
    # The config step lists av-approval on every box (install/config.ts configureAvApproval); on a box
    # that never opted into the gate, the integrity check must not block any tool, whatever is on disk.
    home = tmp_path / ".hermes"
    home.mkdir()
    clean_env.setenv("HERMES_HOME", str(home))
    clean_env.delenv("AV_APPROVAL_ENABLED", raising=False)
    plugin = load_plugin()
    if gate != "absent":
        write_gate(home, plugin.GATED_MATCHERS)
        if gate == "broken":
            (home / "agent-hooks" / "hermes-hook-shim.sh").write_text("#!/bin/sh\necho tampered\n", encoding="utf-8")
    c = __import__(f"{plugin.__name__}._custody", fromlist=["_custody"])
    ran = []
    monkeypatch.setattr(c, "install", lambda: ran.append(True) or {})
    ctx = FakeCtx()
    plugin.register(ctx)
    assert ran == [True]
    # No pre_tool_call callback is registered, so Hermes has nothing of this plugin's to call before any
    # tool: the backstop is the only part that can block, and it stays off.
    assert ctx.hooks == {} and ctx.tools == []


def test_a_custody_module_that_cannot_load_is_loud(clean_env, caplog, monkeypatch):
    plugin = load_plugin()
    monkeypatch.setitem(sys.modules, f"{plugin.__name__}._custody", None)  # import raises ImportError
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        assert plugin.apply_custody() == {}
    assert [(r.levelno, r.getMessage()) for r in caplog.records if r.name == "av-approval.custody"] == [
        (logging.WARNING, plugin.CUSTODY_UNCOVERED_LINE)]


def test_an_install_that_raises_is_loud(clean_env, caplog, monkeypatch):
    plugin = load_plugin()
    c = __import__(f"{plugin.__name__}._custody", fromlist=["_custody"])
    monkeypatch.setattr(c, "install", lambda: 1 / 0)
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        plugin.apply_custody()
    assert plugin.CUSTODY_UNCOVERED_LINE in [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert plugin.CUSTODY_UNCOVERED_LINE == c.UNCOVERED_FMT.format(missing=", ".join(c.SURFACES))


# ---------------------------------------------------------------------------
# The inventory: every credential-shaped name the overlay reads has a decision
# ---------------------------------------------------------------------------

#: The substrings Hermes's execute_code scrub treats as secret (tools/code_execution_env.py).
SECRET_SUBSTRINGS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PASSWD", "AUTH", "DSN", "WEBHOOK",
                     "CREDS", "BEARER", "APIKEY")
_NAME = r"([A-Z][A-Z0-9_]*[A-Z0-9])"
_Q = r"[\"'`]"
#: Helpers that take a variable name: the overlay's own (envOrDotenv, setting, dotenvValue, ...) and Python's.
_HELPERS = (r"envOrDotenv|readPersistedEnvVar|persistedEnvVar|upsertEnvVar|setting|dotenvValue|"
            r"read_dotenv_value|env_or_dotenv|getenv|env")
CODE_READS = [re.compile(p) for p in (
    r"process\.env\." + _NAME,
    r"process\.env\[\s*" + _Q + _NAME + _Q,
    r"\b(?:" + _HELPERS + r")\(\s*(?:[^\"'`\n]*?,\s*)?" + _Q + _NAME + _Q,
    r"\benv\." + _NAME + r"\b",
    r"\benviron(?:\.get|\.setdefault|\.pop)?[\[(]\s*" + _Q + _NAME + _Q,
    r"\bBun\.env\." + _NAME,
    r"\bDeno\.env\.get\(\s*" + _Q + _NAME + _Q,
)]
#: `const { A, B: b, C = "" } = process.env` (or Bun.env)
DESTRUCTURE = re.compile(r"\{([^{}]*)\}\s*=\s*(?:process|Bun)\.env\b")
TEXT_READS = [re.compile(r"\$\{?" + _NAME), re.compile(r"^\s*-\s*(?:name:\s*)?" + _NAME + r"\s*$", re.M)]
#: The second net: a quoted credential-shaped literal on a line that talks about the environment.
NEAR_ENV = re.compile(r"env|environ|dotenv", re.I)
QUOTED = re.compile(_Q + _NAME + _Q)
CODE_SUFFIXES = {".ts", ".js", ".mjs", ".cjs", ".mts", ".cts", ".tsx", ".jsx", ".py"}
TEXT_SUFFIXES = {".sh", ".bash", ".zsh", ".md", ".json", ".yaml", ".yml", ".example", ".toml", ".env"}
SCANNED = ("install", "plugins", "skills", "scripts", "workspace")
SKIPPED_PARTS = {"tests", "node_modules", "__pycache__", "fixtures"}
#: Names on a village sandbox that no overlay file reads (APPROVAL-DEPLOYED.md section 5; the control
#: plane's tenantEnv and .env writes), and names a plugin the overlay installs writes into .env
#: (INDEX_SESSION_TOKEN: indexnetwork/hermes-plugin auth_login.py). They need a decision too.
ON_THE_BOX = ("OPENROUTER_API_KEY", "GROQ_API_KEY", "TELEGRAM_BOT_TOKEN", "INDEX_API_KEY", "EDGEOS_API_KEY",
              "EDGEOS_BEARER_TOKEN", "AV_EVENTS_TOKEN", "AV_BACKUP_TOKEN", "BROWSERBASE_API_KEY",
              "BROWSERBASE_PROJECT_ID", "AV_APPROVAL_TOKEN_FILE", "APPROVAL_HOOK_TOKEN_ENV", "HERMES_MAX_TOKENS",
              "INDEX_SESSION_TOKEN")


def credential_shaped(name: str) -> bool:
    return any(s in name for s in SECRET_SUBSTRINGS)


def kind(path: Path, head: str) -> set[str]:
    """`code`, `text`, or both (an extensionless script with a shebang is read both ways)."""
    if path.suffix in CODE_SUFFIXES:
        return {"code"}
    if path.suffix in TEXT_SUFFIXES:
        return {"text"}
    if not path.suffix and head.startswith("#!"):
        return {"code", "text"}
    return set()


def names_in(text: str, kinds: set[str]) -> list[tuple[str, int]]:
    found: list[tuple[str, int]] = []
    if "code" in kinds:
        for pattern in CODE_READS:
            found += [(m.group(1), m.start()) for m in pattern.finditer(text)]
        for m in DESTRUCTURE.finditer(text):
            for part in m.group(1).split(","):
                name = part.split(":")[0].split("=")[0].strip()
                if re.fullmatch(_NAME, name):
                    found.append((name, m.start()))
        offset = 0
        for line in text.splitlines(keepends=True):
            if NEAR_ENV.search(line):
                found += [(m.group(1), offset + m.start()) for m in QUOTED.finditer(line)]
            offset += len(line)
    if "text" in kinds:
        for pattern in TEXT_READS:
            found += [(m.group(1), m.start()) for m in pattern.finditer(text)]
    return [(n, pos) for n, pos in found if credential_shaped(n)]


def inventory(root: Path = REPO) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for top in SCANNED:
        for path in sorted((root / top).rglob("*")):
            rel = path.relative_to(root)
            if not path.is_file() or SKIPPED_PARTS & set(rel.parts):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            kinds = kind(path, text[:2])
            for name, pos in names_in(text, kinds):
                found.setdefault(name, []).append(f"{rel}:{text.count(chr(10), 0, pos) + 1}")
    return found


def test_the_scan_finds_the_known_readers():
    found = inventory()
    assert any(loc.startswith("skills/mcp.json:") for loc in found["INDEX_API_KEY"])
    assert any(loc.startswith("plugins/av-events/_collector.py:") for loc in found["AV_EVENTS_TOKEN"])
    assert any(loc.startswith("install/restore-memory.ts:") for loc in found["AV_BACKUP_TOKEN"])
    assert any(loc.startswith("skills/edgeos/SKILL.md:") for loc in found["EDGEOS_API_KEY"])
    assert any(loc.startswith("skills/edgeos/scripts/events.ts:") for loc in found["EDGEOS_API_KEY"])
    assert any(loc.startswith("skills/agent-plaza/scripts/") for loc in found["TELEGRAM_BOT_TOKEN"])


def test_the_scan_sees_every_reader_form_the_refuter_slipped_past(tmp_path):
    # Refuter S1: each of these read a new name the first scan never saw.
    probes = {
        "skills/x/a.ts": 'setting("SLIP_ONE_TOKEN", env);\nconst { SLIP_TWO_TOKEN, OTHER: o = "" } = process.env;\n'
                         'dotenvValue(join(home, ".env"), "SLIP_TEN_TOKEN");\n',
        "skills/x/b.py": 'from os import environ, getenv\nenviron["SLIP_THREE_TOKEN"]\ngetenv("SLIP_FOUR_TOKEN")\n'
                         'os.environ.setdefault("SLIP_FIVE_TOKEN", "")\n',
        "skills/x/run": '#!/bin/sh\ncurl -H "Authorization: Bearer $SLIP_SIX_TOKEN" https://x\n',
        "skills/x/c.mts": "process.env.SLIP_SEVEN_TOKEN;\n",
        "skills/x/d.tsx": "process.env.SLIP_EIGHT_TOKEN;\n",
        "skills/x/e.cjs": "process.env.SLIP_NINE_TOKEN;\n",
        "skills/x/f.py": 'NAME = "SLIP_TWELVE_TOKEN"  # read from the environment below\n',
        "skills/x/g.py": 'os.environ.get("SLIP_ELEVEN_TOKEN")\n',
    }
    for rel, body in probes.items():
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    found = set(inventory(tmp_path))
    want = {f"SLIP_{n}_TOKEN" for n in ("ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
                                        "TEN", "ELEVEN", "TWELVE")}
    assert want <= found, sorted(want - found)


def test_every_credential_shaped_name_the_overlay_reads_has_a_decision():
    names = custody().load_manifest()["names"]
    found = inventory()
    missing = {n: locs[:3] for n, locs in found.items() if n not in names}
    assert not missing, (
        "credential-shaped names with no custody decision (add each to plugins/av-approval/custody_keys.json "
        f"with strip, hermes, agent_readable or not_secret, and a reason): {missing}")


def test_every_key_on_the_box_has_a_decision():
    names = custody().load_manifest()["names"]
    assert [n for n in ON_THE_BOX if n not in names] == []


def test_no_stale_decisions():
    # A decision for a name nothing reads and no box carries is a leftover; remove it with the reader.
    names = set(custody().load_manifest()["names"])
    assert names - set(inventory()) - set(ON_THE_BOX) == set()


# ---------------------------------------------------------------------------
# The skills: no literal key pasted into a command
# ---------------------------------------------------------------------------

def skill_files():
    """What the agent reads: every SKILL.md (operator setup docs keep their <YOUR_KEY> placeholders)."""
    return sorted(p for p in (REPO / "skills").rglob("SKILL.md") if "tests" not in p.parts)


def test_no_skill_recipe_asks_for_a_key_to_be_pasted():
    placeholder = re.compile(r"<(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)>")
    hits = [f"{p.relative_to(REPO)}:{t.count(chr(10), 0, m.start()) + 1}"
            for p in skill_files() for t in [p.read_text(encoding="utf-8")] for m in placeholder.finditer(t)]
    assert hits == []


def test_every_authorization_header_in_a_skill_names_a_variable():
    header = re.compile(r"Authorization:\s*Bearer\s+([^\"'\s\\`]+)")
    bad = []
    for path in skill_files():
        text = path.read_text(encoding="utf-8")
        for m in header.finditer(text):
            if not re.fullmatch(r"\$\{?[A-Z][A-Z0-9_]*\}?|<token>", m.group(1)):
                bad.append(f"{path.relative_to(REPO)}:{text.count(chr(10), 0, m.start()) + 1}: {m.group(1)}")
    assert bad == []


def test_no_skill_recipe_names_a_stripped_variable():
    # A recipe that names a stripped variable would run with it empty. Every fenced block, any language.
    names = custody().effective_names()[0]
    pattern = re.compile(r"\$\{?(" + "|".join(sorted(names)) + r")\b")
    hits = []
    for path in skill_files():
        text = path.read_text(encoding="utf-8")
        for block in re.findall(r"^\s*(?:```|~~~)[^\n]*\n(.*?)^\s*(?:```|~~~)", text, re.S | re.M):
            hits += [f"{path.relative_to(REPO)}: {m.group(1)}" for m in pattern.finditer(block)]
    assert hits == []


# ---------------------------------------------------------------------------
# Hermes-backed: the real builders at the fleet's build (skips without Hermes)
# ---------------------------------------------------------------------------

def test_against_real_hermes(monkeypatch, tmp_path):
    local = pytest.importorskip("tools.environments.local")
    pytest.importorskip("hermes_cli.config")
    from hermes_cli.env_loader import load_hermes_dotenv  # noqa: PLC0415
    from tools import code_execution_env, env_passthrough  # noqa: PLC0415

    home = tmp_path / ".hermes"
    (home / "cache" / "terminal").mkdir(parents=True)
    project = home / "hermes-agent"
    project.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_TEMP_DIR", str(home / "cache" / "terminal"))
    monkeypatch.delenv("OP_SERVICE_ACCOUNT_TOKEN", raising=False)
    watched = sorted(STRIP | {"EDGEOS_API_KEY", "EDGEOS_BEARER_TOKEN", "OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"})
    (home / ".env").write_text("".join(f"{n}={PH}\n" for n in watched), encoding="utf-8")
    # Refuter M1: the two dotenv files the hook lets the agent write. The old switch must change nothing.
    (project / ".env").write_text("AV_CUSTODY=0\n", encoding="utf-8")
    (home / ".op.env").write_text("AV_CUSTODY=0\n", encoding="utf-8")
    load_hermes_dotenv(hermes_home=str(home), project_env=str(project / ".env"))
    assert os.environ.get("AV_CUSTODY") == "0"  # it did reach the gateway's environment

    def present(env):
        return {n for n in watched if env.get(n) == PH}

    covered = custody().install()
    assert covered == {"provider": True, "foreground": True, "execute_code": True}

    hermes_strips = {"OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"}
    readable = {"EDGEOS_API_KEY", "EDGEOS_BEARER_TOKEN"}
    assert present(local._make_run_env({})) == readable
    assert present(local._sanitize_subprocess_env(dict(os.environ))) == readable
    assert present(local.hermes_subprocess_env()) == readable
    env_passthrough.register_env_passthrough(["EDGEOS_API_KEY", "INDEX_API_KEY", "AV_EVENTS_TOKEN"])
    try:
        assert present(code_execution_env._scrub_child_env(dict(os.environ))) == {"EDGEOS_API_KEY"}
    finally:
        env_passthrough.clear_env_passthrough()
    assert not hermes_strips & present(local._make_run_env({}))

    shell = local.LocalEnvironment(cwd=str(home), timeout=30)
    try:
        out = shell.execute("env").get("output", "")
        names = {line.split("=", 1)[0] for line in out.splitlines() if "=" in line}
        assert not names & STRIP and readable <= names
        snapshot = Path(shell._snapshot_path)
        text = snapshot.read_text(encoding="utf-8") if snapshot.exists() else ""
        assert not [n for n in STRIP if f"{n}=" in text]
    finally:
        shell.cleanup()
