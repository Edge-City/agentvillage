"""Credential custody: keep service keys out of the code the agent runs (approval code-gap lane 2).

The gateway needs its service keys: the Index MCP client and av-events run inside it and read them
from its environment (Hermes loads `$HERMES_HOME/.env` into it at start). The code the agent runs
does not: a `terminal` command, a skill script, a cron script, an `execute_code` program. Hermes
v2026.9.24 (0.21.5) already removes provider and messaging keys from those children (its provider
blocklist, the execute_code substring scrub), but not the overlay's own: measured against the real
builders, INDEX_API_KEY, AV_EVENTS_TOKEN and AV_BACKUP_TOKEN reach every foreground and background
terminal child and the terminal's session snapshot file on disk. With INDEX_API_KEY agent code
could publish to Index around the approval gate.

`install()` removes the strip names (`FLOOR`, plus any more `custody_keys.json` marks `strip`) from
every agent-run child, by three levers, each fail-soft and each reported:

1. **provider**: a `TerminalEnvironmentProvider` whose `strip_env_keys` is the list, registered in
   Hermes's terminal environment registry. Hermes strips the union of every provider's keys from
   the background/PTY terminal, cron and user scripts, search workers and every non-terminal spawn
   (`_sanitize_subprocess_env`, `hermes_subprocess_env`). It is never a backend: `is_available()`
   is False and `create_environment()` raises.
2. **foreground**: at 0.21.5 the foreground terminal (`tools.environments.local._make_run_env`,
   which `LocalEnvironment._run_bash` calls for every command and for the session snapshot) passes
   an EMPTY plugin key set, so lever 1 does not reach it. The function is wrapped to drop the same
   names from what it returns.
3. **execute_code**: `tools.code_execution_env._scrub_child_env` drops names by substring but lets a
   name a skill declared (`required_environment_variables`, registered at `skill_view`) back in. It
   is wrapped the same way, so a declaration cannot re-admit a stripped name.

After wrapping, a probe checks the real path, not just the names: one child is spawned through the
foreground builder with a canary under a strip name and must not see it, `_scrub_child_env` must drop
the canary even when it is declared passthrough, and `LocalEnvironment._run_bash` and
`_build_child_env` must still call the wrapped names. A surface that fails is reported NOT covered.

An edit of `custody_keys.json` cannot shrink the list: `FLOOR` is always stripped, and a decisions
file that drops a floor name (or cannot be read) is logged as a warning. An edit of this module can:
the plugin directory is writable by the agent's user, and the approval hook classifies a write there
as `files.write.workspace` until approval-md APRV-511 (0.4.5) makes it `policy.core`.

Switch: custody is always on unless `$HERMES_HOME/config.yaml` says `av_approval: {custody: false}`
(read with Hermes's raw config loader, no environment expansion); an operator sets it with
`hermes config set av_approval.custody false` from a sandbox shell. The approval hook classifies a
write to that file as `policy.core` (human-only) when the command spells it `~/.hermes/config.yaml`
or `$HOME/.hermes/config.yaml`, but not when it spells it `$HERMES_HOME/config.yaml`: that spelling,
like the plugin directory, is covered by approval-md APRV-511 (0.4.5), and until then an agent can
reach both through those spellings. No environment variable is consulted: Hermes loads dotenv files
the agent can write (the project `.env`, `.op.env`) into the gateway's environment.

What this does not do, stated plainly: `$HERMES_HOME/.env` stays readable by the agent's user, and
so does `/proc/<gateway pid>/environ`. Agent-written code that opens either file still gets the keys;
closing that needs a second unix user for agent-run code (APPROVAL-CUSTODY's proposal).

Python 3.11, standard library. Never raises out of `install()`.
"""

from __future__ import annotations

import functools
import importlib
import json
import logging
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

logger = logging.getLogger("av-approval.custody")

MANIFEST_PATH = Path(__file__).resolve().with_name("custody_keys.json")
#: The names stripped whatever the decisions file says (it lives where the agent's user can write).
FLOOR: frozenset[str] = frozenset({
    "INDEX_API_KEY", "INDEX_SESSION_TOKEN", "AV_EVENTS_TOKEN", "AV_BACKUP_TOKEN", "ADMIN_TOKEN",
})
#: config.yaml: `av_approval: {custody: false}` turns custody off. Anything else, or absent, is on.
CONFIG_KEYS = ("av_approval", "custody")
PROVIDER_NAME = "av_custody"
WRAPPED_MARK = "_av_custody_wrapped"
DECISIONS = frozenset({"strip", "hermes", "agent_readable", "not_secret"})
MEASURED_HERMES = "0.21.5"
CANARY_NAME = "INDEX_API_KEY"
CANARY_VALUE = "av-custody-canary"
_LIST_ENV = "import os, sys; sys.stdout.write(chr(10).join(os.environ))"
_OFF = frozenset({"false", "0", "no", "off"})

#: (surface, module, attribute) for the two wrapped builders, and (module, class or None, function)
#: whose code must still call them.
FOREGROUND = ("foreground", "tools.environments.local", "_make_run_env")
EXECUTE_CODE = ("execute_code", "tools.code_execution_env", "_scrub_child_env")
CALLERS = {
    "foreground": ("tools.environments.local", "LocalEnvironment", "_run_bash"),
    "execute_code": ("tools.code_execution_env", None, "_build_child_env"),
}
SURFACES = ("provider", FOREGROUND[0], EXECUTE_CODE[0])

OFF_LINE = ("av-approval: custody off (config.yaml av_approval.custody: false); INDEX_API_KEY, "
            "AV_EVENTS_TOKEN and AV_BACKUP_TOKEN reach agent-run code")
APPLIED_FMT = "av-approval: custody: {n} names withheld from agent-run code ({covered})"
UNCOVERED_FMT = "av-approval: custody: NOT covered: {missing}; those children still receive the service keys"
SHRUNK_FMT = ("av-approval: custody: custody_keys.json does not mark {names} strip (edited or unreadable); "
              "they are stripped anyway")
VERSION_FMT = ("av-approval: custody: measured at Hermes {measured}, running {running}; "
               "the probe below is what was checked")


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    """The decisions file. Raises on a missing or malformed file (tests pin it; install() catches)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    names = data.get("names")
    if not isinstance(names, dict) or not names:
        raise ValueError("custody_keys.json: 'names' must be a non-empty object")
    for name, entry in names.items():
        if not isinstance(entry, dict) or entry.get("decision") not in DECISIONS:
            raise ValueError(f"custody_keys.json: {name}: decision must be one of {sorted(DECISIONS)}")
        if not str(entry.get("reason") or "").strip():
            raise ValueError(f"custody_keys.json: {name}: a reason is required")
    return data


def strip_names(manifest: Optional[Mapping[str, Any]] = None) -> frozenset[str]:
    """The names the decisions file marks `strip` (without the floor)."""
    data = manifest if manifest is not None else load_manifest()
    return frozenset(n for n, e in data["names"].items() if e["decision"] == "strip")


def effective_names() -> tuple[frozenset[str], frozenset[str]]:
    """(names to strip, floor names the decisions file failed to mark). Never raises."""
    try:
        marked = strip_names()
    except Exception:  # noqa: BLE001 - an unreadable file must not shrink the list
        marked = frozenset()
    return marked | FLOOR, FLOOR - marked


def switch(importer: Callable[[str], Any] = importlib.import_module) -> str:
    """`off` only when Hermes's raw config.yaml has av_approval.custody false; `on` otherwise."""
    try:
        config = importer("hermes_cli.config")
        raw = config.read_raw_config()
        value = config.cfg_get(raw, *CONFIG_KEYS, default=None)
    except Exception:  # noqa: BLE001 - no readable config is the default: on
        return "on"
    if value is False or (isinstance(value, str) and value.strip().lower() in _OFF):
        return "off"
    return "on"


def scrub(env: Any, names: frozenset[str]) -> Any:
    """`env` without `names`, matched case-folded as Hermes matches them (Windows env blocks are
    case-insensitive). Anything that is not a dict passes through untouched."""
    if not isinstance(env, dict):
        return env
    folded = {n.upper() for n in names}
    return {k: v for k, v in env.items() if not (isinstance(k, str) and k.upper() in folded)}


def wrap(module: Any, attr: str, names: frozenset[str]) -> bool:
    """Wrap `module.attr` (a function returning an env dict) so its result never carries `names`.
    Idempotent. False when the attribute is missing or not callable."""
    original = getattr(module, attr, None)
    if not callable(original):
        return False
    if getattr(original, WRAPPED_MARK, False):
        return True

    @functools.wraps(original)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        return scrub(original(*args, **kwargs), names)

    setattr(wrapped, WRAPPED_MARK, True)
    setattr(module, attr, wrapped)
    return True


def make_provider(names: frozenset[str], base: type) -> Any:
    """A `TerminalEnvironmentProvider` that only declares `strip_env_keys`; never a backend."""

    class CustodyProvider(base):  # type: ignore[misc, valid-type]
        is_remote = False
        is_container = False

        @property
        def name(self) -> str:
            return PROVIDER_NAME

        @property
        def display_name(self) -> str:
            return "Agent Village credential custody (not a terminal backend)"

        @property
        def description(self) -> str:
            return "Not a terminal backend: do not select. av-approval registers it only to strip service keys."

        @property
        def strip_env_keys(self) -> frozenset:
            return names

        def is_available(self) -> bool:
            return False

        def probe(self):
            return ("unavailable", "not a terminal backend: av-approval registers it only to strip keys")

        def create_environment(self, **kwargs: Any) -> Any:
            raise RuntimeError("av_custody is not a terminal backend")

    return CustodyProvider()


def _register_provider(names: frozenset[str], importer: Callable[[str], Any]) -> bool:
    registry = importer("agent.terminal_env_registry")
    base = getattr(importer("agent.terminal_env_provider"), "TerminalEnvironmentProvider")
    register = getattr(registry, "register_provider", None)
    if not callable(register):
        return False
    register(make_provider(names, base))
    keys = getattr(registry, "plugin_strip_env_keys", None)
    return callable(keys) and names <= set(keys())


def _calls(importer: Callable[[str], Any], surface: str, attr: str) -> bool:
    """Whether the function that builds this surface's child env still calls `attr` by name."""
    module_name, cls, func = CALLERS[surface]
    owner = importer(module_name)
    if cls is not None:
        owner = getattr(owner, cls)
    code = getattr(getattr(owner, func), "__code__")
    return attr in code.co_names


def _spawn_sees_canary(env: Mapping[str, str]) -> bool:
    """Spawn one child with `env` and report whether it sees the canary. The child is this interpreter
    by absolute path, never a PATH lookup: Hermes puts its own agent-writable bin directory first."""
    out = subprocess.run([sys.executable, "-c", _LIST_ENV], env=dict(env), capture_output=True, text=True,
                         timeout=5, check=False).stdout
    return CANARY_NAME in out.splitlines()


def probe(importer: Callable[[str], Any], surface: str) -> bool:
    """The real path still drops a strip name: True when the surface is covered."""
    if surface == "foreground":
        build = getattr(importer(FOREGROUND[1]), FOREGROUND[2])
        env = build({CANARY_NAME: CANARY_VALUE})
        return (CANARY_NAME not in env and not _spawn_sees_canary(env)
                and _calls(importer, surface, FOREGROUND[2]))
    if surface == "execute_code":
        scrub_fn = getattr(importer(EXECUTE_CODE[1]), EXECUTE_CODE[2])
        env = scrub_fn({CANARY_NAME: CANARY_VALUE, "PATH": "/usr/bin"}, is_passthrough=lambda _name: True)
        return CANARY_NAME not in env and _calls(importer, surface, EXECUTE_CODE[2])
    return True


def install(*, importer: Callable[[str], Any] = importlib.import_module) -> dict[str, bool]:
    """Apply custody; returns which surfaces are covered. Logs one line, plus a warning per problem."""
    covered = {surface: False for surface in SURFACES}
    try:
        if switch(importer) == "off":
            logger.warning(OFF_LINE)
            return covered
        names, unmarked = effective_names()
        if unmarked:
            logger.warning(SHRUNK_FMT.format(names=", ".join(sorted(unmarked))))
        try:
            covered["provider"] = _register_provider(names, importer)
        except Exception:  # noqa: BLE001 - one lever failing must not stop the others
            covered["provider"] = False
        for surface, module_name, attr in (FOREGROUND, EXECUTE_CODE):
            try:
                covered[surface] = wrap(importer(module_name), attr, names) and probe(importer, surface)
            except Exception:  # noqa: BLE001
                covered[surface] = False
        try:
            running = getattr(importer("hermes_cli"), "__version__", None)
            if running and running != MEASURED_HERMES:
                logger.warning(VERSION_FMT.format(measured=MEASURED_HERMES, running=running))
        except Exception:  # noqa: BLE001 - the version is informational
            pass
        done = [s for s in SURFACES if covered[s]]
        missing = [s for s in SURFACES if not covered[s]]
        logger.info(APPLIED_FMT.format(n=len(names), covered=", ".join(done) or "none"))
        if missing:
            logger.warning(UNCOVERED_FMT.format(missing=", ".join(missing)))
    except Exception:  # noqa: BLE001 - custody must never break Hermes's plugin loading
        try:
            logger.warning(UNCOVERED_FMT.format(missing=", ".join(SURFACES)))
        except Exception:  # noqa: BLE001
            pass
    return covered


__all__ = [
    "CONFIG_KEYS",
    "DECISIONS",
    "FLOOR",
    "MANIFEST_PATH",
    "OFF_LINE",
    "PROVIDER_NAME",
    "SURFACES",
    "UNCOVERED_FMT",
    "effective_names",
    "install",
    "load_manifest",
    "make_provider",
    "probe",
    "scrub",
    "strip_names",
    "switch",
    "wrap",
]
