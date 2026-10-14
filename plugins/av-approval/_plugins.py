"""SEC-3: the plugin inventory and the unknown-plugin quarantine (L1), shipped in `report` mode.

Every plugin the gateway knows about is classified (SEC-3 design §4.1):

- `expected`: a `user` plugin whose key is one of ours (`expected_plugins.json`: the overlay names, which
  `install/tests/expected_plugins_parity.test.ts` pins to `readdir(plugins/)` minus `NOT_STAGED_PLUGINS`),
  in a directory of the same name and with no `.install-metadata.json` record (the installer stages ours
  by copy; a `hermes plugins install` under one of our names is an impostor); or `index-network` when its
  metadata is `pinned` at exactly `index.ref` (`INDEX_PLUGIN_REF`). A dashboard-only overlay plugin
  (`edgecity-village`, no `__init__.py`) counts when its directory is present: it has nothing to load.
- `bundled`: source `bundled` AND a manifest path under `<hermes_cli package>/../plugins`. The path is
  checked because `HERMES_BUNDLED_PLUGINS` (settable from `.env`) can point the bundled scan anywhere.
- `unknown`: everything else: a user directory overriding a bundled key, every `project` and
  `entrypoint` plugin, a bundled-sourced manifest outside Hermes's own tree (`bundled_path_mismatch`),
  `index-network` at another revision. `config.yaml` `av_approval.plugins_allow: [{name, revision}]`
  admits one: `revision` is the 40-hex `.install-metadata.json` revision, or `local` for a directory
  with NO metadata record. Any mismatch stays unknown.

When it runs: `register()` subscribes ONE `PluginManager.on_plugin_loaded` listener per process (Hermes
calls it after each discovery sweep with the discovery lock released; nothing here ever unloads from
inside `register()`) and starts a 15-minute daemon tick. The first pass is `boot`, a later sweep is
`loaded`, the tick is `tick` (an inventory only when something changed) or `daily` (every 24 h). The
listener is removed through `ctx.on_unload`; Hermes's listeners belong to the process, not the plugin.
A tick takes Hermes's discovery lock without waiting and is skipped while a sweep holds it (a forced
re-discovery unloads and reloads everything under that lock). Only the gateway process runs any of this
(`gateway run|start` in its argv, or `_HERMES_GATEWAY=1`, which Hermes sets only when `gateway/run.py` is imported,
AFTER `hermes gateway run` has started plugin discovery); the TUI and a standalone CLI do not. The marker is
inherited, so a `hermes` command the gateway's own children run also has it.

Mode (`config.yaml` `av_approval.unknown_plugins`): `report` (the default; also for an unreadable config
or a value it does not understand, with one log line), `quarantine`, or `off` (nothing subscribed,
nothing sent). YAML reads a bare `off` as false, which is taken as `off`. In `quarantine` an unknown
plugin is unlisted (`dashboard_set_agent_plugin_enabled(key, enabled=False)`: its key goes into
`plugins.disabled`) before it ever loads, and a loaded one is unloaded live (`PluginManager.unload`) and
unlisted, so the next start is clean. Its directory and metadata stay as evidence. A key that an expected
or bundled plugin also holds is never unlisted (`unlist_failed`). Never an exit, never a sticky block.

Publishing (the contract in `plugins/av-events/tests/vectors/plugin_events_contract.json`):
`ctx.emit("plugin.inventory" | "plugin.unknown", payload)`; the host namespaces it `av-approval:`. A fresh
dict per emit holding exactly the contract's fields in its order. `name`, `install_host` and
`hermes_version` are nulled here when they miss the contract's shape; `name_hash` is HMAC-SHA256 under
`$HERMES_HOME/av-approval/hash.key` (0600, this plugin's own key) over `"av-approval|plugin|" + key`.
No URL path, no tool names, no file text. `plugin.unknown` goes once per (key, source, state, action)
per process. av-events decides whether anything leaves the box (`AV_PLUGIN_EVENTS`).

Python 3.11, standard library and PyYAML. Never raises out of `start()`.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlsplit

logger = logging.getLogger("av-approval.plugins")

EXPECTED_PATH = Path(__file__).resolve().with_name("expected_plugins.json")
SELF = "av-approval"
MODES = ("report", "quarantine", "off")
DEFAULT_MODE = "report"
TICK_S = 15 * 60
DAILY_S = 24 * 60 * 60
COUNT_MAX = 10000
INVENTORY = "plugin.inventory"
UNKNOWN = "plugin.unknown"

#: The contract's field order (tests/test_plugins.py pins every name, order and shape against the file).
INVENTORY_FIELDS = ("trigger", "mode", "expected_loaded", "expected_missing", "bundled_loaded", "unknown_count",
                    "allowed_count", "expected_set_version", "hermes_version")
UNKNOWN_FIELDS = ("name", "name_hash", "source", "state", "install_host", "revision", "pinned", "tools", "hooks",
                  "action")
NAME_RE = r"^(?=[a-z0-9._/-]{1,64}$)(?!.*[.][.])[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)?$"
HOST_RE = r"^[a-z0-9.-]{1,253}$"
REVISION_RE = r"^[0-9a-f]{40}$"
SET_VERSION_RE = r"^[0-9a-f]{12}$"
#: agentvillage-data's hermesVersion, as the contract file carries it, character for character.
HERMES_VERSION_RE = (
    r"^(?:v?[0-9]{1,6}(?:\.[0-9]{1,6}){1,3}(?:(?:a|b|rc)[0-9]{1,4})?(?:\.post[0-9]{1,4})?(?:\.dev[0-9]{1,6})?"
    r"(?:[-+](?:g[0-9a-f]{7,40}|d[0-9]{8}|rc[0-9]{1,4}|dev[0-9]{1,6}|post[0-9]{1,4}|[0-9]{1,8})"
    r"(?:\.(?:g[0-9a-f]{7,40}|d[0-9]{8}|rc[0-9]{1,4}|dev[0-9]{1,6}|post[0-9]{1,4}|[0-9]{1,8})){0,3})?"
    r"|[0-9a-f]{7,40})$"
)
UNKNOWN_SOURCES = ("user", "project", "entrypoint", "bundled_path_mismatch")
#: Overlay plugins with no agent half (`__init__.py`): present when their directory is. Any other expected
#: directory without `__init__.py` is a broken stage and counts as missing. Pinned to the source tree by a test.
DASHBOARD_ONLY = ("edgecity-village",)
#: Set by Hermes at import of `gateway/run.py` and inherited by its children. NOT set yet when `hermes gateway run`
#: starts its background plugin discovery (that runs first), so the gateway's own argv is the other signal.
GATEWAY_MARKER = "_HERMES_GATEWAY"

SUMMARY_FMT = "av-approval: plugins: {n} expected, {m} bundled, {u} unknown (mode {mode})"
NOT_RUNNING_LINE = "av-approval: plugins: inventory NOT running"
EPHEMERAL_LINE = "av-approval: plugins: hash key ephemeral"
MODE_LINE = "av-approval: plugins: av_approval.unknown_plugins unreadable or not report|quarantine|off; mode report"
#: Quarantine only (never in report mode); no plugin name is logged.
UNLOADED_NOT_UNLISTED_LINE = ("av-approval: plugins: quarantine: a plugin was unloaded but not unlisted "
                              "(unlist_failed); it loads again at the next start")
UNLOAD_FAILED_LINE = "av-approval: plugins: quarantine: a plugin could not be unloaded; unlisted for the next start"
PROTECTED_LINE = ("av-approval: plugins: quarantine: an unknown plugin shares the key of an expected, bundled "
                  "or allow-listed plugin; that key is not unlisted")
TICK_SKIPPED_LINE = "av-approval: plugins: tick skipped (a discovery sweep is running)"

#: Process state lives on the `av-approval` logger, which outlives a module reload (Hermes re-imports a
#: plugin on a forced re-discovery), so "subscribed once" and "once per process" survive one.
_ANCHOR = logging.getLogger("av-approval")
_STATE_ATTR = "_av_approval_plugins"
_LOGGED_ATTR = "_av_approval_plugins_logged"


# ---------------------------------------------------------------------------
# Inputs: config, metadata, the expected set (Hermes-free)
# ---------------------------------------------------------------------------

def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", "").strip() or os.path.join(os.path.expanduser("~"), ".hermes"))


def read_config(home: Path) -> tuple[Optional[dict], bool]:
    """(config, readable). An absent file is an empty config; a parse error or a non-mapping is unreadable."""
    try:
        import yaml  # Hermes ships PyYAML

        with open(home / "config.yaml", encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh)
    except FileNotFoundError:
        return {}, True
    except Exception:  # noqa: BLE001
        return None, False
    if cfg is None:
        return {}, True
    return (cfg, True) if isinstance(cfg, dict) else (None, False)


def _block(cfg: Any) -> Any:
    return cfg.get("av_approval") if isinstance(cfg, dict) else None


def parse_mode(cfg: Optional[dict]) -> tuple[str, bool]:
    """(mode, understood). Unreadable config or an unknown value: `report`, not understood."""
    if not isinstance(cfg, dict):
        return DEFAULT_MODE, False
    block = _block(cfg)
    if block is None or (isinstance(block, dict) and block.get("unknown_plugins") is None):
        return DEFAULT_MODE, True
    if not isinstance(block, dict):
        return DEFAULT_MODE, False
    value = block["unknown_plugins"]
    if value is False:  # YAML 1.1: a bare `off`
        return "off", True
    if isinstance(value, str) and value.strip().lower() in MODES:
        return value.strip().lower(), True
    return DEFAULT_MODE, False


def parse_allow(cfg: Optional[dict]) -> tuple[tuple[str, str], ...]:
    """`av_approval.plugins_allow` as (name, revision) pairs; a revision is 40-hex or `local`, else ignored."""
    block = _block(cfg)
    entries = block.get("plugins_allow") if isinstance(block, dict) else None
    allow = []
    for entry in entries if isinstance(entries, list) else ():
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            continue
        revision = entry.get("revision")
        revision = revision.strip() if isinstance(revision, str) else ""
        revision = revision if revision == "local" else revision.lower()
        if revision == "local" or re.fullmatch(REVISION_RE, revision):
            allow.append((entry["name"].strip(), revision))
    return tuple(allow)


def read_metadata(home: Path) -> dict:
    """Hermes's `plugins/.install-metadata.json` ({dir name: {source, revision, pinned}}); {} when unreadable."""
    try:
        data = json.loads((home / "plugins" / ".install-metadata.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}


def set_version(data: Mapping[str, Any]) -> str:
    """sha256 prefix (12 hex) of the canonical JSON of the set: sorted keys, no spaces."""
    canon = json.dumps({"conditional": list(data["conditional"]), "index": {"name": data["index"]["name"],
                        "ref": data["index"]["ref"]}, "overlay": list(data["overlay"])},
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()[:12]


def load_expected(path: Path = EXPECTED_PATH) -> dict:
    """The expected set. Raises on a malformed file or a version that does not match its content."""
    data = json.loads(path.read_text(encoding="utf-8"))
    names = [*data["overlay"], *data["conditional"], data["index"]["name"]]
    if not all(isinstance(n, str) and n for n in names) or not re.fullmatch(REVISION_RE, data["index"]["ref"]):
        raise ValueError("expected_plugins.json: malformed")
    if data["expected_set_version"] != set_version(data):
        raise ValueError("expected_plugins.json: expected_set_version does not match the set")
    return data


# ---------------------------------------------------------------------------
# Classification (pure; the three seams the mutation checks switch off)
# ---------------------------------------------------------------------------

def _under(path: Any, root: Optional[Path]) -> bool:
    """True when `path` resolves inside `root` (Hermes's own bundled tree)."""
    if not path or root is None:
        return False
    try:
        return Path(path).resolve().is_relative_to(Path(root).resolve())
    except (OSError, ValueError):
        return False


def _revision_matches(meta: Any, revision: str, *, pinned: bool = False) -> bool:
    """`meta` (an install record) is at exactly `revision`, and pinned when asked."""
    return (isinstance(meta, dict) and isinstance(meta.get("revision"), str) and meta["revision"] == revision
            and (not pinned or meta.get("pinned") is True))


def _meta_for(record: Mapping[str, Any], metadata: Mapping[str, Any]) -> Any:
    """The install record of this record's own directory (Hermes keys it by the installed directory name).
    Never by the plugin key: a same-keyed directory elsewhere must not borrow another's revision."""
    return metadata.get(Path(record["path"]).name) if record.get("path") else None


def _verdict(record: Mapping[str, Any], expected: Mapping[str, Any], metadata: Mapping[str, Any],
             bundled_root: Optional[Path], bundled_keys: frozenset) -> tuple[str, str]:
    """(`expected` | `bundled` | `unknown`, unknown source)."""
    key, source = record["key"], record.get("source")
    if source == "bundled":
        return ("bundled", "") if _under(record.get("path"), bundled_root) else ("unknown", "bundled_path_mismatch")
    if source != "user":
        return "unknown", source if source in UNKNOWN_SOURCES else "user"
    if key in bundled_keys:
        return "unknown", "user"
    own_dir = bool(record.get("path")) and Path(record["path"]).name == key.rsplit("/", 1)[-1]
    meta = _meta_for(record, metadata)
    if key == expected["index"]["name"]:
        ok = own_dir and _revision_matches(meta, expected["index"]["ref"], pinned=True)
        return ("expected", "") if ok else ("unknown", "user")
    if key in expected["overlay"] and own_dir and record.get("name") == key and meta is None:
        return "expected", ""
    return "unknown", "user"


def _allowed(record: Mapping[str, Any], meta: Any, allow: tuple[tuple[str, str], ...]) -> bool:
    for name, revision in allow:
        if name not in (record["key"], record.get("name")):
            continue
        if revision == "local" and meta is None:
            return True
        if revision != "local" and _revision_matches(meta, revision):
            return True
    return False


def classify(records: list, *, expected: Mapping[str, Any], metadata: Mapping[str, Any],
             allow: tuple = (), bundled_root: Optional[Path] = None, bundled_keys: frozenset = frozenset(),
             enabled: frozenset = frozenset(), disabled: frozenset = frozenset()) -> dict:
    """Counts plus one entry per unknown record. A record: {key, name, source, path, loaded, tools, hooks,
    dashboard_only}. `protected`: keys an expected, bundled or allowed record holds (never unlisted)."""
    present: set = set()
    protected: set = {SELF}
    bundled_loaded = allowed = 0
    unknown = []
    for record in records:
        verdict, unknown_source = _verdict(record, expected, metadata, bundled_root, bundled_keys)
        key = record["key"]
        if verdict == "expected":
            protected.add(key)
            if record.get("loaded") or (record.get("dashboard_only") and key in DASHBOARD_ONLY):
                present.add(key)
            continue
        if verdict == "bundled":
            protected.add(key)
            bundled_loaded += 1 if record.get("loaded") else 0
            continue
        meta = _meta_for(record, metadata)
        if _allowed(record, meta, allow):
            protected.add(key)
            allowed += 1
            continue
        names = {key, record.get("name")}
        if record.get("loaded"):
            state = "loaded"
        elif key in bundled_keys and record.get("source") in ("user", "project"):
            state = "overrides_bundled"
        elif names & enabled and not names & disabled:
            state = "enabled_not_loaded"
        else:
            state = "dir_only"
        meta = meta if isinstance(meta, dict) else {}
        unknown.append({"key": key, "source": unknown_source, "state": state, "loaded": bool(record.get("loaded")),
                        "install_host": install_host(meta.get("source")), "revision": meta.get("revision"),
                        "pinned": meta.get("pinned"), "tools": record.get("tools", 0), "hooks": record.get("hooks", 0)})
    required = set(expected["overlay"]) - set(expected["conditional"])
    return {"expected_loaded": len(present), "expected_missing": len(required - present),
            "bundled_loaded": bundled_loaded, "unknown_count": len(unknown), "allowed_count": allowed,
            "unknown": unknown, "protected": protected}


# ---------------------------------------------------------------------------
# The payload (pure)
# ---------------------------------------------------------------------------

def install_host(source: Any) -> Optional[str]:
    """The host of an install source (`https://h/...`, `git@h:...`), lower case, in the contract's shape; else None."""
    if not isinstance(source, str):
        return None
    text, host = source.strip(), None
    if "://" in text:
        try:
            host = urlsplit(text).hostname
        except ValueError:
            host = None
    else:
        m = re.fullmatch(r"[^@/\s]+@([^:/\s]+):\S*", text)
        host = m.group(1) if m else None
    return _shape(HOST_RE, host.lower() if host else None)


def _shape(regex: str, value: Any) -> Optional[str]:
    return value if isinstance(value, str) and re.fullmatch(regex, value) else None


def _same(value: Any) -> Any:
    return value


def _count(value: Any) -> int:
    return min(max(value, 0), COUNT_MAX) if type(value) is int else 0


def _raw(value: Any) -> int:
    return value if type(value) is int and value >= 0 else 0


_RULES: dict[str, dict[str, Callable[[Any], Any]]] = {
    INVENTORY: {"trigger": _same, "mode": _same, "expected_loaded": _count, "expected_missing": _count,
                "bundled_loaded": _count, "unknown_count": _count, "allowed_count": _count,
                "expected_set_version": _same, "hermes_version": lambda v: _shape(HERMES_VERSION_RE, v)},
    UNKNOWN: {"name": lambda v: _shape(NAME_RE, v), "name_hash": _same, "source": _same, "state": _same,
              "install_host": lambda v: _shape(HOST_RE, v), "revision": lambda v: _shape(REVISION_RE, v),
              "pinned": lambda v: v if type(v) is bool else None, "tools": _raw, "hooks": _raw, "action": _same},
}
_FIELDS = {INVENTORY: INVENTORY_FIELDS, UNKNOWN: UNKNOWN_FIELDS}


def serialize(event: str, values: Mapping[str, Any]) -> dict:
    """A FRESH dict with exactly the contract's fields, in its order. Inventory counts are kept in 0..10000;
    `tools`/`hooks` go raw (av-events clamps)."""
    rules = _RULES[event]
    return {field: rules[field](values.get(field)) for field in _FIELDS[event]}


def hermes_version() -> Optional[str]:
    try:
        import hermes_cli

        return _shape(HERMES_VERSION_RE, str(getattr(hermes_cli, "__version__", "")))
    except Exception:  # noqa: BLE001
        return None


def load_or_create_key(directory: Path) -> Optional[bytes]:
    """`<directory>/hash.key`: 64 hex, 0600, created once (a complete temp file hard-linked into place, so
    two processes agree); a corrupt file is replaced once. None when it cannot be read or made."""
    path = directory / "hash.key"
    for _attempt in range(3):
        try:
            text = path.read_text(encoding="ascii", errors="replace").strip()
        except FileNotFoundError:
            text = None
        except OSError:
            return None
        if text is not None and re.fullmatch(r"[0-9a-f]{64}", text):
            return bytes.fromhex(text)
        try:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            temp = directory / f".hash.key.{os.getpid()}.{secrets.token_hex(4)}"
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="ascii") as fh:
                fh.write(secrets.token_hex(32))
            try:
                if text is None:
                    try:
                        os.link(temp, path)
                    except FileExistsError:
                        pass
                else:
                    os.replace(temp, path)
            finally:
                temp.unlink(missing_ok=True)
        except OSError:
            return None
    return None


# ---------------------------------------------------------------------------
# Hermes seams (each defensive; monkeypatched in the Hermes-free tests)
# ---------------------------------------------------------------------------

def bundled_facts() -> tuple[Optional[Path], frozenset]:
    """(Hermes's own bundled tree, its plugin keys). The tree comes from the `hermes_cli` package path, never
    from `HERMES_BUNDLED_PLUGINS`."""
    import hermes_cli
    from hermes_cli.plugins_discovery import scan_directory

    root = Path(hermes_cli.__file__).resolve().parent.parent / "plugins"
    return root, frozenset((m.key or m.name) for m in scan_directory(root, "bundled"))


def _resolved(path: Any) -> str:
    """One spelling per directory (a home under a symlinked /var is the same plugin to Hermes and to us)."""
    try:
        return str(Path(path).resolve()) if path else ""
    except (OSError, RuntimeError):
        return str(path)


def scan_user(home: Path) -> list:
    """Every manifest under `$HERMES_HOME/plugins`, read (not loaded) by Hermes's own scanner."""
    from hermes_cli.plugins_discovery import scan_directory

    return scan_directory(home / "plugins", "user")


def gather(manager: Any, home: Path) -> list:
    """Records for every plugin the manager holds (loaded or a placeholder) plus every manifest under
    `$HERMES_HOME/plugins` it does not (installed after discovery). Hermes's own scanner gives the keys."""
    counts = {p.get("key"): p for p in manager.list_plugins()}
    records: dict = {}
    for key, loaded in list(getattr(manager, "_plugins", {}).items()):
        m = loaded.manifest
        info = counts.get(key) or {}
        records[(key, _resolved(m.path))] = {
            "key": key, "name": m.name, "source": m.source, "path": m.path,
            "loaded": bool(loaded.enabled) and not loaded.error and not getattr(loaded, "deferred", False),
            "tools": info.get("tools", 0), "hooks": info.get("hooks", 0)}
    try:
        manifests = scan_user(home)
    except Exception:  # noqa: BLE001 - the manager's view still stands
        manifests = []
    for m in manifests:
        key = m.key or m.name
        records.setdefault((key, _resolved(m.path)), {"key": key, "name": m.name, "source": "user", "path": m.path,
                                                       "loaded": False, "tools": 0, "hooks": 0})
    for record in records.values():
        record["dashboard_only"] = bool(record["path"]) and not (Path(record["path"]) / "__init__.py").exists()
    return list(records.values())


def unlist(key: str) -> bool:
    from hermes_cli.plugins_cmd import dashboard_set_agent_plugin_enabled

    result = dashboard_set_agent_plugin_enabled(key, enabled=False)
    return isinstance(result, dict) and result.get("ok") is True


def quarantine(entry: Mapping[str, Any], manager: Any, protected: set) -> str:
    """L1: unload a loaded unknown, then unlist its key. The label says what happened: `unloaded_unlisted`
    only when both succeeded, `unlist_failed` whenever the key is not unlisted (whatever the unload did; a
    key a protected plugin shares is never unlisted), `unlisted` otherwise. Never raises."""
    key = entry["key"]
    unloaded = None  # None: not attempted (not loaded, or this plugin itself)
    if entry["loaded"] and key != SELF:
        try:
            unloaded = bool(manager.unload(key))
        except Exception:  # noqa: BLE001
            unloaded = False
    listed_off = False
    if key in protected:
        _log_once("q-protected:" + key, PROTECTED_LINE)
    else:
        try:
            listed_off = unlist(key)
        except Exception:  # noqa: BLE001
            listed_off = False
    if not listed_off:
        if unloaded:
            _log_once("q-unloaded:" + key, UNLOADED_NOT_UNLISTED_LINE)
        return "unlist_failed"
    if unloaded:
        return "unloaded_unlisted"
    if unloaded is False:
        _log_once("q-unload-failed:" + key, UNLOAD_FAILED_LINE)
    return "unlisted"


# ---------------------------------------------------------------------------
# Process state, the pass, the listener and the tick
# ---------------------------------------------------------------------------

def _state() -> dict:
    state = getattr(_ANCHOR, _STATE_ATTR, None)
    if not isinstance(state, dict):
        state = {"lock": threading.Lock(), "pass_lock": threading.Lock(), "sent": set(), "booted": False}
        setattr(_ANCHOR, _STATE_ATTR, state)
    return state


def _log_once(key: str, line: str, level: int = logging.WARNING) -> None:
    logged = getattr(_ANCHOR, _LOGGED_ATTR, None)
    if not isinstance(logged, set):
        logged = set()
        setattr(_ANCHOR, _LOGGED_ATTR, logged)
    if key not in logged:
        logged.add(key)
        _log(level, line)


def _log(level: int, line: str) -> None:
    try:
        logger.log(level, line)
    except Exception:  # noqa: BLE001
        pass


def _names(value: Any) -> frozenset:
    return frozenset(v for v in value if isinstance(v, str)) if isinstance(value, list) else frozenset()


def _name_hash(state: dict, key: str) -> str:
    secret = state.get("hash_key")
    if secret is None:
        secret = load_or_create_key(state["home"] / "av-approval")
        if secret is None:
            secret = secrets.token_bytes(32)
            _log_once("ephemeral", EPHEMERAL_LINE)
        state["hash_key"] = secret
    return hmac.new(secret, ("av-approval|plugin|" + key).encode("utf-8"), hashlib.sha256).hexdigest()


def _emit(state: dict, event: str, values: Mapping[str, Any]) -> None:
    try:
        state["ctx"].emit(event, serialize(event, values))
    except Exception:  # noqa: BLE001 - a bus that cannot take it changes nothing here
        pass


def run_pass(trigger: str, now: Optional[float] = None) -> Optional[dict]:
    """One classification pass (`loaded` from the listener, `tick` from the tick). Never raises."""
    state = _state()
    with state["pass_lock"]:
        held = None
        try:
            if trigger == "tick":
                # S1: never classify a half-loaded manager. A forced re-discovery unloads everything and
                # reloads under this lock; a tick that finds it busy is skipped (the next tick, or the
                # listener after a sweep that loads something new, reads the settled registry). The lock is
                # Hermes's RLock: a quarantine unload inside the pass re-enters it on this thread.
                lock = getattr(state.get("manager"), "_discovery_lock", None)
                if lock is not None:
                    if not lock.acquire(blocking=False):
                        _log(logging.DEBUG, TICK_SKIPPED_LINE)
                        return None
                    held = lock
            return _pass(state, trigger, time.time() if now is None else now)
        except Exception:  # noqa: BLE001
            return None
        finally:
            if held is not None:
                held.release()


def _pass(state: dict, trigger: str, now: float) -> Optional[dict]:
    home, manager, expected = state["home"], state["manager"], state["expected"]
    cfg, readable = read_config(home)
    mode, _ = parse_mode(cfg if readable else None)
    if mode == "off":
        return None
    cfg = cfg if readable and isinstance(cfg, dict) else {}
    plugins_cfg = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
    if state.get("bundled") is None:  # Hermes's own tree changes only with Hermes (a restart)
        state["bundled"] = bundled_facts()
    bundled_root, bundled_keys = state["bundled"]
    inv = classify(gather(manager, home), expected=expected, metadata=read_metadata(home), allow=parse_allow(cfg),
                   bundled_root=bundled_root, bundled_keys=bundled_keys,
                   enabled=_names(plugins_cfg.get("enabled")), disabled=_names(plugins_cfg.get("disabled")))
    for entry in inv["unknown"]:
        entry["action"] = quarantine(entry, manager, inv["protected"]) if mode == "quarantine" else "none"
    if not state["booted"]:
        trigger, state["booted"], state["daily_at"] = "boot", True, now
    elif trigger == "tick" and now - state.get("daily_at", now) >= DAILY_S:
        trigger, state["daily_at"] = "daily", now
    counts = {k: inv[k] for k in ("expected_loaded", "expected_missing", "bundled_loaded", "unknown_count",
                                  "allowed_count")}
    digest = (mode, tuple(sorted(counts.items())),
              tuple(sorted((e["key"], e["state"], e["action"]) for e in inv["unknown"])))
    if trigger != "tick" or digest != state.get("digest"):
        state["digest"] = digest
        _emit(state, INVENTORY, {"trigger": trigger, "mode": mode, **counts,
                                 "expected_set_version": expected["expected_set_version"],
                                 "hermes_version": hermes_version()})
    for entry in inv["unknown"]:
        once = (entry["key"], entry["source"], entry["state"], entry["action"])
        if once in state["sent"]:
            continue
        state["sent"].add(once)
        _emit(state, UNKNOWN, {**entry, "name": entry["key"], "name_hash": _name_hash(state, entry["key"])})
    if trigger in ("boot", "daily"):
        _log(logging.WARNING if inv["unknown_count"] else logging.INFO,
             SUMMARY_FMT.format(n=inv["expected_loaded"], m=inv["bundled_loaded"], u=inv["unknown_count"], mode=mode))
    return {"trigger": trigger, "mode": mode, **counts, "unknown": inv["unknown"]}


def _listener(_summaries: Any = None, *_args: Any, **_kwargs: Any) -> None:
    """The one `on_plugin_loaded` listener: runs the current module's pass (a reload swaps `run`)."""
    run = _state().get("run")
    if run is not None:
        run("loaded")


def _on_unload() -> None:
    state = _state()
    with state["lock"]:
        unsubscribe, state["unsubscribe"], state["active"] = state.get("unsubscribe"), None, False
    if unsubscribe is not None:
        try:
            unsubscribe()
        except Exception:  # noqa: BLE001
            pass


def _tick_loop(stop: threading.Event) -> None:
    while not stop.wait(TICK_S):
        state = _state()
        if state.get("active") and state.get("run") is not None:
            state["run"]("tick")


def gateway_argv(argv: Optional[list] = None) -> bool:
    """`hermes gateway run` (and `start`): the gateway's own command line (av-events' `_gateway_argv`).
    `sys.argv[1:5]` covers the unit's `python -m hermes_cli.main [-p <profile>] gateway run`."""
    args = [str(a) for a in (sys.argv if argv is None else argv)][1:5]
    if "gateway" not in args:
        return False
    rest = args[args.index("gateway") + 1:]
    return not rest or rest[0] in ("run", "start")


def gateway_process() -> bool:
    """This process is the gateway: its argv says so, or Hermes's gateway marker is set."""
    return gateway_argv() or os.environ.get(GATEWAY_MARKER) == "1"


def _default_manager() -> Any:
    from hermes_cli.plugins import get_plugin_manager

    return get_plugin_manager()


def start(ctx: Any, manager_factory: Optional[Callable[[], Any]] = None) -> bool:
    """From `register()`: subscribe the listener once per process, hook `ctx.on_unload`, start the tick.
    Never unloads, never raises. False (and `inventory NOT running` once) when it could not subscribe;
    False and silent outside the gateway process (neither `gateway run|start` in argv nor `_HERMES_GATEWAY=1`)."""
    try:
        if not gateway_process():
            return False  # N5: the gateway only, not the TUI or a standalone CLI that also discovers plugins
        home = hermes_home()
        cfg, readable = read_config(home)
        mode, understood = parse_mode(cfg if readable else None)
        if not understood:
            _log_once("mode", MODE_LINE)
        if mode == "off":
            return False
        expected = load_expected()
        manager = (manager_factory or _default_manager)()
        state = _state()
        with state["lock"]:
            state.update(ctx=ctx, home=home, expected=expected, run=run_pass, active=True)
            if state.get("unsubscribe") is None or state.get("manager") is not manager:
                if state.get("unsubscribe") is not None:
                    state["unsubscribe"]()
                state["unsubscribe"] = manager.on_plugin_loaded(_listener)
            state["manager"] = manager
            thread = state.get("thread")
            if thread is None or not thread.is_alive():
                state["stop"] = threading.Event()
                thread = threading.Thread(target=_tick_loop, args=(state["stop"],), name="av-approval-plugins",
                                          daemon=True)
                state["thread"] = thread
                thread.start()
        try:
            ctx.on_unload(_on_unload)
        except Exception:  # noqa: BLE001 - no unload hook: the listener stays until the process ends
            pass
        return True
    except Exception:  # noqa: BLE001 - the inventory must never break Hermes's plugin loading
        _log_once("not-running", NOT_RUNNING_LINE)
        return False


def _reset() -> None:
    """Tests: stop the tick, drop the listener and every once-per-process mark."""
    state = getattr(_ANCHOR, _STATE_ATTR, None)
    if isinstance(state, dict):
        if state.get("stop") is not None:
            state["stop"].set()
        if state.get("unsubscribe") is not None:
            try:
                state["unsubscribe"]()
            except Exception:  # noqa: BLE001
                pass
    for attr in (_STATE_ATTR, _LOGGED_ATTR):
        if hasattr(_ANCHOR, attr):
            delattr(_ANCHOR, attr)
