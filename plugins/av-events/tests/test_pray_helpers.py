"""The shared helpers in `_pray.py` (PRAY-RETIRED, lead RULING L42776).

The `pray` tool is retired (`ask_odin` supersedes it; the control plane removes `AV_PRAY` from every
box). `_pray.py` keeps only the helpers the control-plane tools share: the direct-messages-only session
rule (`session_kind`, `cron_delivers_privately`, `register_lineage`), the host pin (`cp_origin`,
`CP_HOSTS`), `Attempt`, `_header`, the contact net and `invisible`. These are the old `test_pray.py`
cases on the helpers, called directly instead of through the tool, plus the retirement itself: no
tool is registered from the module, whatever `AV_PRAY` says, and every helper another module reads
from it is still there.
"""

from __future__ import annotations

import ast
import json
import os
import sys
import types
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

REPO = Path(__file__).resolve().parents[3]
PLUGIN_DIR = REPO / "plugins" / "av-events"
TENANT = "aa9a5de3-0000-4000-8000-000000000001"
CP = "https://control-plane-production-606c.up.railway.app"
SESSION = "sess-helpers"
HOME_DM = "123456789"
SESSION_ENV = ("HERMES_SESSION_CHAT_TYPE", "HERMES_CRON_SESSION", "HERMES_PLATFORM", "HERMES_SESSION_PLATFORM",
               "HERMES_SESSION_SOURCE", "HERMES_SESSION_ID", "HERMES_CRON_AUTO_DELIVER_PLATFORM",
               "HERMES_CRON_AUTO_DELIVER_CHAT_ID", "TELEGRAM_HOME_CHANNEL")


#: Hermes's cron task id for the fake job below (`cron:{job_id}:{execution_id}`, scheduler.py:2302).
CRON_TASK_ID = "cron:job1:e1"


class FakeCron:
    """Hermes's `get_job` and `_resolve_delivery_targets`, faked: `lanes[job_id] = (deliver, failure)`,
    each a list of resolved targets (or an exception / non-list to return)."""

    def __init__(self) -> None:
        home = {"platform": "telegram", "chat_id": HOME_DM, "thread_id": None}
        self.lanes: dict = {"job1": ([home], [home])}

    def get_job(self, job_id: str):
        return {"id": job_id} if job_id in self.lanes else None

    def resolve(self, job: dict, *, for_failure: bool = False):
        value = self.lanes[job["id"]][1 if for_failure else 0]
        if isinstance(value, BaseException):
            raise value
        return value



# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------


class ToolFireCtx:
    """A `PluginContext` that takes hooks and tools, and fires hooks like Hermes."""

    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.tools: dict[str, dict] = {}

    def register_hook(self, hook_name, callback):  # noqa: ANN001
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                      is_async=False, description="", emoji="", override=False):  # noqa: ANN001
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "description": description}
        return object()

    def fire(self, hook_name: str, **kwargs: Any) -> None:
        for callback in self.hooks.get(hook_name, []):
            callback(**kwargs)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture()
def pr(plugin, av, monkeypatch):
    module = sys.modules[f"{av.MODULE_NAME}._pray"]
    cron = FakeCron()
    monkeypatch.setattr(module, "_hermes_cron", lambda: (cron.get_job, cron.resolve))
    module.fake_cron = cron  # tests reach it as <fixture>.fake_cron
    for name in SESSION_ENV:
        monkeypatch.delenv(name, raising=False)
    return module


@pytest.fixture()
def on(monkeypatch, home):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    # Only read in cron sessions: the job reports to the resident's own DM (fail-closed cron rule).
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", HOME_DM)
    monkeypatch.setenv("HERMES_CRON_AUTO_DELIVER_PLATFORM", "telegram")
    monkeypatch.setenv("HERMES_CRON_AUTO_DELIVER_CHAT_ID", HOME_DM)


@pytest.fixture()
def tctx(pr, on):
    """The lineage listeners the cron rule reads, registered as each cp tool registers them."""
    ctx = ToolFireCtx()
    pr.register_lineage(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return ctx


def kind(pr, *, session: str = SESSION, task_id: str = CRON_TASK_ID) -> Optional[str]:
    """`session_kind` as a tool calls it: Hermes passes `task_id` to every handler; a cron run's is `cron:{job}:{execution}`."""
    return pr.session_kind(session, task_id)


# --------------------------------------------------------------------------
# PRAY-RETIRED: the tool is gone, the helpers stay
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, "1", "true", "YES", " on "])
def test_no_pray_tool_is_registered_whatever_av_pray_says(plugin, pr, home, monkeypatch, value):
    if value is not None:
        monkeypatch.setenv("AV_PRAY", value)
    for switch in ("AV_ASK_VILLAGE", "AV_ASK_ODIN", "AV_SEARCH_VILLAGE", "AV_RECORD_INTENTION"):
        monkeypatch.setenv(switch, "1")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert "pray" not in ctx.tools
    assert {"ask_village", "ask_odin", "search_village", "query_village"} <= set(ctx.tools)


def test_the_module_holds_no_tool_and_reads_no_av_pray(pr):
    for name in ("TOOL_NAME", "TOOL_SCHEMA", "TOOL_DESCRIPTION", "SWITCH", "register_pray_tool", "pray_answer",
                 "make_handler", "switch_on", "PRAYERS_PATH"):
        assert not hasattr(pr, name), name
    code = (PLUGIN_DIR / "_pray.py").read_text(encoding="utf-8")
    body = code.split('"""', 2)[2]  # past the module docstring
    assert "AV_PRAY" not in body and "/prayers" not in body
    for path in PLUGIN_DIR.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        if path.name != "_pray.py":
            assert "AV_PRAY" not in text and "register_pray_tool" not in text, path.name


def test_the_manifest_lists_no_pray(av):
    import yaml  # noqa: PLC0415

    manifest = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    assert "pray" not in manifest["provides_tools"]
    assert "AV_PRAY" not in manifest.get("optional_env", []) and "AV_PRAY" not in manifest.get("requires_env", [])
    assert "CONTROL_PLANE_URL" in manifest["optional_env"] and "TELEGRAM_HOME_CHANNEL" in manifest["optional_env"]


def _helpers_read_by(path: Path) -> set[str]:
    """Every `_pray.<name>` the module reads (`from . import _pray`, then attribute access)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return {node.attr for node in ast.walk(tree)
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "_pray"}


def test_every_helper_another_module_reads_is_still_there(pr):
    seen: dict[str, set[str]] = {}
    for path in sorted(PLUGIN_DIR.glob("*.py")):
        if path.name != "_pray.py":
            names = _helpers_read_by(path)
            if names:
                seen[path.name] = names
    # The tools that share the wire and the session rule, and _code_run's host list.
    assert {"_ask_village.py", "_ask_odin.py", "_search_village.py", "_query_village.py", "_code_run.py"} <= set(seen)
    for module, names in seen.items():
        for name in names:
            assert hasattr(pr, name), f"{module} reads _pray.{name}, which is gone"
    for name in pr.__all__:
        assert hasattr(pr, name), name


def test_the_shared_values_are_the_ones_the_tools_were_built_on(pr):
    assert pr.SESSION_KIND_HEADER == "X-AV-Session-Kind"
    assert pr.URL_ENV == "CONTROL_PLANE_URL"
    assert pr.TENANT.fullmatch(TENANT) and not pr.TENANT.fullmatch(TENANT.upper())
    assert not pr.invisible("\n") and pr.invisible("\u200b") and pr.invisible("\U000e0041")
    assert any(pattern.search("mail me at a@b.co") for pattern in pr.CONTACT)
    attempt = pr.Attempt(failure="transport")
    assert attempt.retryable and not pr.Attempt(failure="url_refused").retryable
    assert pr.Attempt(503).retryable and not pr.Attempt(404).retryable
    assert pr._header({"Retry-After": "5"}, "Retry-After") == "5" and pr._header(None, "x") is None


def test_the_host_pin_is_directory_ts_list(pr):
    directory = (REPO / "skills" / "edgeos" / "scripts" / "directory.ts").read_text(encoding="utf-8")
    for host in pr.CP_HOSTS:
        assert f'"{host}"' in directory


@pytest.mark.parametrize("url", [
    "https://cp.example.test",                                        # https, but not a CP_HOSTS host
    "http://control-plane-production-606c.up.railway.app",            # plain http to the real host
    "http://cp.example.test",
    "ftp://control-plane-production-606c.up.railway.app",
    "https://control-plane-production-606c.up.railway.app:8443",      # another port
    "https://user:pw@control-plane-production-606c.up.railway.app",   # credentials
    "https://control-plane-production-606c.up.railway.app/api",       # a path
    "https://control-plane-production-606c.up.railway.app/?x=1",      # a query
    "https://control-plane-production-606c.up.railway.app#f",
    "https://control-plane-production-606c.up.railway.app.evil.test",  # a suffix, not the host
    "https://cp.exa mple.test",
    "",
])
def test_only_the_pinned_cp_host_over_https_or_loopback_http(pr, url):
    assert pr.cp_origin(url) is None


@pytest.mark.parametrize("url,base", [
    ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
    ("http://localhost:9/", "http://localhost:9"),
    ("https://control-plane-production-606c.up.railway.app/", CP),
    ("https://Control-Plane-Production-606c.up.railway.app:443", CP),
])
def test_loopback_http_and_the_pinned_host_are_allowed(pr, url, base):
    assert pr.cp_origin(url) == base


def test_register_lineage_registers_the_three_listeners_and_tolerates_a_ctx_without_hooks(pr, plugin):
    ctx = ToolFireCtx()
    pr.register_lineage(ctx)
    ri = sys.modules[f"{plugin.__name__}._record_intention"]
    for name in pr.LINEAGE_HOOK_NAMES:
        assert ri.LINEAGE_HOOKS[name] in ctx.hooks[name]
    pr.register_lineage(object())  # no register_hook: nothing, no error


# --------------------------------------------------------------------------
# Who is speaking: direct messages only (the session rule)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("chat_type", ["group", "supergroup", "channel", "thread", "forum", "webhook"])
def test_group_sessions_are_refused(tctx, pr, monkeypatch, chat_type):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    assert kind(pr) is None


@pytest.mark.parametrize("chat_type", ["dm", "private", "DIRECT", "c2c"])
def test_direct_chats_are_dm(tctx, pr, monkeypatch, chat_type):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    assert kind(pr) == "dm"


def test_a_non_local_surface_with_no_chat_type_is_refused(tctx, pr, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "api_server")
    assert kind(pr) is None


@pytest.mark.parametrize("surface", ["cli", "tui", "desktop", "local", ""])
def test_an_empty_chat_type_is_refused_even_on_a_local_surface(tctx, pr, monkeypatch, surface):
    """Fail closed: only a positively bound direct chat is a DM (recall would accept the local CLI)."""
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", surface)
    assert kind(pr) is None


def test_cron_by_session_id(tctx, pr, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    assert kind(pr, session="cron_job1_20261014") == "cron"


def test_cron_by_platform_lineage_even_where_the_chat_type_says_group(tctx, pr, monkeypatch):
    tctx.fire("on_session_start", session_id="s-c", model="m", platform="cron")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    assert kind(pr, session="s-c") == "cron"


def test_cron_subagent_by_lineage(tctx, pr, monkeypatch):
    tctx.fire("subagent_start", child_session_id="child-1", parent_session_id="cron_job2_1")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "subagent")
    assert kind(pr, session="child-1") == "cron"


def test_cron_by_hermes_flag(tctx, pr, monkeypatch):
    monkeypatch.setenv("HERMES_CRON_SESSION", "1")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    assert kind(pr) == "cron"


def test_a_session_id_that_is_not_text_is_read_as_none(tctx, pr, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    for session in (None, 7, ["dm"], {"kind": "dm"}):
        assert pr.session_kind(session, CRON_TASK_ID) is None


class _Unset:
    pass


def _fake_gateway(monkeypatch, values: dict, engaged: bool) -> None:
    unset = _Unset()

    class Var:
        def __init__(self, value: Any) -> None:
            self.value = value

        def get(self) -> Any:
            return self.value

    sc = types.ModuleType("gateway.session_context")
    names = ("HERMES_SESSION_CHAT_TYPE", "HERMES_CRON_SESSION", "HERMES_SESSION_PLATFORM", "HERMES_SESSION_SOURCE",
             "HERMES_SESSION_ID")
    sc._VAR_MAP = {name: Var(values.get(name, unset)) for name in names}
    sc._UNSET = unset
    sc.session_context_engaged = lambda: engaged
    sc.get_session_env = lambda name, default="": default
    gateway = types.ModuleType("gateway")
    gateway.session_context = sc
    monkeypatch.setitem(sys.modules, "gateway", gateway)
    monkeypatch.setitem(sys.modules, "gateway.session_context", sc)


def test_gateway_task_bound_to_a_dm(tctx, pr, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")  # a stale mirror from another turn
    _fake_gateway(monkeypatch, {"HERMES_SESSION_CHAT_TYPE": "dm", "HERMES_SESSION_PLATFORM": "telegram",
                                "HERMES_SESSION_SOURCE": "telegram", "HERMES_SESSION_ID": SESSION}, engaged=True)
    assert kind(pr) == "dm"


def test_gateway_task_with_no_session_bound_is_refused(tctx, pr, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")  # someone else's turn's mirror
    _fake_gateway(monkeypatch, {}, engaged=True)
    assert kind(pr) is None


def test_gateway_task_bound_to_a_group_is_refused(tctx, pr, monkeypatch):
    _fake_gateway(monkeypatch, {"HERMES_SESSION_CHAT_TYPE": "group", "HERMES_SESSION_PLATFORM": "telegram",
                                "HERMES_SESSION_SOURCE": "telegram", "HERMES_SESSION_ID": SESSION}, engaged=True)
    assert kind(pr) is None


# ---- ov#341 fix round 1: a cron run only when it reports to the DM -------------------------


@pytest.mark.parametrize("platform,chat,allowed", [
    ("telegram", "123456789", True),          # the resident's own DM (TELEGRAM_HOME_CHANNEL)
    ("Telegram", " 123456789 ", True),
    ("", "", False),                          # local delivery: not positively the DM
    ("local", "", False),
    ("telegram", "987654321", False),         # another person's DM
    ("telegram", "-1001234567890", False),    # a supergroup / channel
    ("telegram", "-4567", False),
    ("telegram", "", False),
    ("slack", "C123", False),
    ("weird", "123456789", False),
])
def test_s3_a_cron_run_only_when_it_reports_to_the_dm(tctx, pr, monkeypatch, platform, chat, allowed):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    monkeypatch.setenv("HERMES_CRON_AUTO_DELIVER_PLATFORM", platform)
    monkeypatch.setenv("HERMES_CRON_AUTO_DELIVER_CHAT_ID", chat)
    assert kind(pr, session="cron_job_p_1") == ("cron" if allowed else None)


# ---- Fail closed: every unreadable, missing or unexpected session fact refuses ----------


class _Var:
    def __init__(self, value: Any = None, raises: bool = False) -> None:
        self.value, self.raises = value, raises

    def get(self) -> Any:
        if self.raises:
            raise RuntimeError("context var broke")
        return self.value


def _gateway(monkeypatch, values: dict, *, engaged: bool = True, var_map: bool = True,
             public_reader: Optional[Callable] = None) -> types.ModuleType:
    unset = object()
    sc = types.ModuleType("gateway.session_context")
    names = ("HERMES_SESSION_CHAT_TYPE", "HERMES_CRON_SESSION", "HERMES_SESSION_PLATFORM", "HERMES_SESSION_SOURCE",
             "HERMES_SESSION_ID", "HERMES_CRON_AUTO_DELIVER_PLATFORM", "HERMES_CRON_AUTO_DELIVER_CHAT_ID")
    if var_map:
        sc._VAR_MAP = {n: (values[n] if isinstance(values.get(n), _Var) else _Var(values.get(n, unset)))
                       for n in names}
    sc._UNSET = unset
    sc.session_context_engaged = lambda: engaged
    sc.get_session_env = public_reader or (lambda name, default="": default)
    gateway = types.ModuleType("gateway")
    gateway.session_context = sc
    monkeypatch.setitem(sys.modules, "gateway", gateway)
    monkeypatch.setitem(sys.modules, "gateway.session_context", sc)
    return sc


CRON = {"HERMES_SESSION_CHAT_TYPE": "", "HERMES_CRON_SESSION": "1", "HERMES_SESSION_PLATFORM": "cron",
        "HERMES_SESSION_SOURCE": "cron", "HERMES_SESSION_ID": "cron_job_z_1",
        "HERMES_CRON_AUTO_DELIVER_PLATFORM": "telegram", "HERMES_CRON_AUTO_DELIVER_CHAT_ID": HOME_DM}
DM = {"HERMES_SESSION_CHAT_TYPE": "dm", "HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_SOURCE": "telegram",
      "HERMES_SESSION_ID": SESSION}


def _refused(pr, session=SESSION) -> None:
    assert kind(pr, session=session) is None


def test_fc_the_two_allowed_cases_through_a_gateway(tctx, pr, monkeypatch):
    _gateway(monkeypatch, DM)
    assert kind(pr) == "dm"
    _gateway(monkeypatch, CRON)
    assert kind(pr, session="cron_job_z_1") == "cron"


@pytest.mark.parametrize("name", ["HERMES_CRON_AUTO_DELIVER_PLATFORM", "HERMES_CRON_AUTO_DELIVER_CHAT_ID"])
def test_fc_cron_target_missing_is_refused(tctx, pr, monkeypatch, name):
    _gateway(monkeypatch, {k: v for k, v in CRON.items() if k != name})  # unbound in this task
    _refused(pr, "cron_job_z_1")


@pytest.mark.parametrize("name", ["HERMES_CRON_AUTO_DELIVER_PLATFORM", "HERMES_CRON_AUTO_DELIVER_CHAT_ID"])
@pytest.mark.parametrize("value", [None, "", "   ", "unknown", "-1001234567890", "0", "+123456789", ["telegram"]])
def test_fc_cron_target_none_empty_unknown_or_wrong_type_is_refused(tctx, pr, monkeypatch, name, value):
    _gateway(monkeypatch, {**CRON, name: value})
    _refused(pr, "cron_job_z_1")


@pytest.mark.parametrize("name", ["HERMES_CRON_AUTO_DELIVER_PLATFORM", "HERMES_CRON_AUTO_DELIVER_CHAT_ID",
                                  "HERMES_SESSION_CHAT_TYPE"])
def test_fc_an_exception_reading_a_session_fact_is_refused(tctx, pr, monkeypatch, name):
    base = DM if name == "HERMES_SESSION_CHAT_TYPE" else CRON
    session = SESSION if base is DM else "cron_job_z_1"
    _gateway(monkeypatch, {**base, name: _Var(raises=True)},
             public_reader=lambda n, default="": (_ for _ in ()).throw(RuntimeError("public reader broke")))
    _refused(pr, session)


def test_fc_a_gateway_without_its_var_map_is_refused(tctx, pr, monkeypatch):
    _gateway(monkeypatch, {}, var_map=False)  # the public reader answers its default: ""
    _refused(pr)
    _refused(pr, "cron_job_z_1")


@pytest.mark.parametrize("home", [None, "", "-1001234567890", "abc"])
def test_fc_cron_without_a_positive_home_dm_is_refused(tctx, pr, monkeypatch, home):
    if home is None:
        monkeypatch.delenv("TELEGRAM_HOME_CHANNEL")
    else:
        monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", home)
    monkeypatch.setenv("HERMES_CRON_AUTO_DELIVER_CHAT_ID", home or "")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    _refused(pr, "cron_job_h_1")


@pytest.mark.parametrize("chat_type", [None, "", "  ", "unknown", "group", "channel", "dm-ish", 7])
def test_fc_unknown_missing_or_unexpected_chat_type_is_refused(tctx, pr, monkeypatch, chat_type):
    _gateway(monkeypatch, {**DM, "HERMES_SESSION_CHAT_TYPE": chat_type})
    _refused(pr)


def test_fc_a_group_target_on_a_cron_is_refused(tctx, pr, monkeypatch):
    _gateway(monkeypatch, {**CRON, "HERMES_CRON_AUTO_DELIVER_CHAT_ID": "-1001234567890"})
    _refused(pr, "cron_job_z_1")


def test_fc_any_exception_inside_the_helper_refuses(tctx, pr, monkeypatch):
    def boom(_name):  # noqa: ANN001
        raise RuntimeError("session store broke")

    monkeypatch.setattr(pr, "_session_value", boom)
    _refused(pr)
    _refused(pr, "cron_job_z_1")
    monkeypatch.setattr(pr, "env", lambda _n: (_ for _ in ()).throw(RuntimeError("env broke")))
    assert pr.cron_delivers_privately() is False


def test_fc_the_allow_condition_is_the_one_line(pr):
    import inspect  # noqa: PLC0415

    source = inspect.getsource(pr.cron_delivers_privately)
    assert source.count('return targets == [("telegram", home, "")] and platform == "telegram" and chat == home') == 1
    assert "return True" not in source
    assert "return True" not in inspect.getsource(pr._session_kind)


# ---- ov#341 fix round 2: the job's FULL delivery spec (recheck S1) ------------------------

HOME = {"platform": "telegram", "chat_id": HOME_DM, "thread_id": None}
GROUP = {"platform": "telegram", "chat_id": "-1001234567890", "thread_id": None}


def _cron_kind(pr, *, task_id: str = CRON_TASK_ID) -> Optional[str]:
    return kind(pr, session="cron_job1_1", task_id=task_id)


@pytest.mark.parametrize("deliver,failure,allowed", [
    ([HOME], [HOME], True),                                     # `telegram` / `telegram:<home>` / `origin`
    ([HOME], [], True),                                         # failure_deliver: local
    ([HOME, GROUP], [HOME, GROUP], False),                      # home first, then a group
    ([GROUP, HOME], [GROUP, HOME], False),                      # home last
    ([HOME, HOME], [HOME, HOME], True),                         # home twice: Hermes dedups, one DM target
    ([HOME], [GROUP], False),                                   # the failure lane goes to a group
    ([], [], False),                                            # local delivery: an empty list
    ([HOME, {**HOME, "chat_id": "987654321"}], [HOME], False),  # home plus another DM
    ([{**HOME, "thread_id": 7}], [{**HOME, "thread_id": 7}], False),  # a thread, not the DM itself
    ([{**HOME, "platform": "discord"}], [{**HOME, "platform": "discord"}], False),
])
def test_r2_a_cron_is_allowed_only_when_its_whole_spec_is_the_home_dm(tctx, pr, monkeypatch, deliver, failure, allowed):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    pr.fake_cron.lanes["job1"] = (deliver, failure)
    assert _cron_kind(pr) == ("cron" if allowed else None)


@pytest.mark.parametrize("lanes", [
    (RuntimeError("jobs.json unreadable"), [HOME]),   # the resolver raises
    ([HOME], RuntimeError("failure lane broke")),
    ("telegram:123456789", [HOME]),                    # not a list
    ([HOME, "telegram"], [HOME]),                      # a target that is not a dict
    ([{"chat_id": HOME_DM}], [HOME]),                  # no platform
    (None, None),
])
def test_r2_an_unreadable_or_unparseable_spec_is_refused(tctx, pr, monkeypatch, lanes):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    pr.fake_cron.lanes["job1"] = lanes
    assert _cron_kind(pr) is None


@pytest.mark.parametrize("task_id", ["task-1", "", "cron:", "cron:job1", "cron:nojob:e1", "cron:job1:e1:x",
                                     "CRON:job1:e1", "cron:../job1:e1"])
def test_r2_no_readable_cron_task_or_job_is_refused(tctx, pr, monkeypatch, task_id):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    assert _cron_kind(pr, task_id=task_id) is None


def test_r2_hermes_itself_missing_is_refused(tctx, pr, monkeypatch):
    def missing():
        raise ImportError("no module named cron")

    monkeypatch.setattr(pr, "_hermes_cron", missing)
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    assert _cron_kind(pr) is None


def test_r2_the_published_target_must_also_be_the_home_dm(tctx, pr, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    monkeypatch.setenv("HERMES_CRON_AUTO_DELIVER_CHAT_ID", "-1001234567890")
    assert _cron_kind(pr) is None


def test_r2_n3_a_non_numeric_home_is_refused_even_when_everything_matches(tctx, pr, monkeypatch):
    odd = {"platform": "telegram", "chat_id": "123:456", "thread_id": None}
    pr.fake_cron.lanes["job1"] = ([odd], [odd])
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", "123:456")
    monkeypatch.setenv("HERMES_CRON_AUTO_DELIVER_CHAT_ID", "123:456")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "")
    assert _cron_kind(pr) is None


def test_r2_n3_a_refused_cron_never_falls_through_to_the_dm_rule(tctx, pr, monkeypatch):
    pr.fake_cron.lanes["job1"] = ([HOME, GROUP], [HOME, GROUP])
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")  # forced; Hermes binds "" in cron
    assert _cron_kind(pr) is None


HERMES_REF = Path(os.environ.get("HERMES_AGENT_SRC") or Path.home() / "dev" / "hermes-agent-ref-v2026.9.24")


@pytest.mark.skipif(not (HERMES_REF / "cron" / "scheduler_delivery.py").is_file(), reason="Hermes source not available")
def test_r2_the_fakes_match_hermes_own_resolver(tmp_path):
    """Hermes v2026.9.24's `_resolve_delivery_targets`, run in a child (`python -I`, a scratch HERMES_HOME),
    gives the lists the fake above uses: a multi-target spec keeps every target, a duplicate home is one."""
    import subprocess  # noqa: PLC0415

    script = (
        "import json,sys; sys.path.insert(0, sys.argv[1])\n"
        "from cron import scheduler_delivery as sd\n"
        "out = {}\n"
        "for d in ['telegram:123456789,telegram:-1001234567890', 'telegram:-1001234567890,telegram:123456789',\n"
        "          'telegram:123456789,telegram:123456789', 'telegram', 'origin', 'local', '',\n"
        "          'telegram,telegram:-1001234567890']:\n"
        "    job = {'id': 'j', 'deliver': d, 'origin': {'platform': 'telegram', 'chat_id': '123456789'}}\n"
        "    out[d] = [[t['platform'], str(t['chat_id']), t.get('thread_id')] for t in sd._resolve_delivery_targets(job)]\n"
        "print(json.dumps(out))\n"
    )
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "HERMES_HOME": str(tmp_path),
           "TELEGRAM_HOME_CHANNEL": "123456789"}
    done = subprocess.run([sys.executable, "-I", "-c", script, str(HERMES_REF)], capture_output=True, text=True,
                          env=env, timeout=120)
    assert done.returncode == 0, done.stderr[-2000:]
    got = json.loads(done.stdout.strip().splitlines()[-1])
    home, group = ["telegram", "123456789", None], ["telegram", "-1001234567890", None]
    assert got["telegram:123456789,telegram:-1001234567890"] == [home, group]
    assert got["telegram:-1001234567890,telegram:123456789"] == [group, home]
    assert got["telegram,telegram:-1001234567890"] == [home, group]
    assert got["telegram:123456789,telegram:123456789"] == [home]
    assert got["telegram"] == [home] and got["origin"] == [home]
    assert got["local"] == [] and got[""] == []
