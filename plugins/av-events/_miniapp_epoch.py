"""MINIAPP-PICKUP (v2.1.5): an open chat picks up a mini-app install or removal at its next turn, no /new.

Why. Installing or removing a mini-app stages `$HERMES_HOME/mini-apps.json` and the app's
`skills/<app>/SKILL.md` and restarts the gateway (control plane `mini-apps.js` reconcile,
`mini-apps-runtime.js` restart). Nothing refreshes a session: Hermes v2026.9.24 replays a continuing
chat's stored system prompt, skills index included (`agent/conversation_loop.py:703-731`), so the
agent did not know the new app until the resident sent /new.

How. The same shape as Hermes's Bot Chat capability epoch (`tools/bot_mode_probe.py:319-431`, checked
at `agent/conversation_loop.py:704-728`): the built prompt carries a fingerprint of the installed
apps, and a prompt whose fingerprint differs from disk is rebuilt once.

- The stamp: a Hermes plugin system-prompt section (`register_system_prompt_section`,
  `hermes_cli/plugins.py:936-960`) whose text is `Mini-apps epoch: <12 hex>`. Hermes renders it at
  each new prompt build (`agent/system_prompt.py:113-134, 779`) and freezes it in the persisted
  prompt inside its canonical plugin-sections frame (`hermes_cli/plugins_dispatch.py:75-96`). With no
  app installed (or the switch off) the section renders empty, and Hermes leaves it out
  (`plugins_dispatch.py:577-579`), so a box without mini-apps gets no new prompt bytes.
- The fingerprint (`fingerprint`): sha256 over the installed apps sorted by id, each as its whole
  `mini-apps.json` entry (id, version, skills, operations: the Gold Stars entries share version 1.1.0
  and differ only in operations) plus the sha256 of each of its `skills/<skill>/SKILL.md`, cut to 12
  hex. Read from the file `village-bridge`'s `installed()` reads, with its guards (no symlink in the
  path, `O_NOFOLLOW`, a regular file of at most 16 KiB). Catalog data only, never resident data.
  `""` when no app is installed (or the file is absent), None when the file exists but cannot be read
  (no verdict).
- The check (`stale`): the stamp in the session's prompt (`""` when it has none) against `fingerprint()`.
  A prompt from before this change carries no stamp, so on a box with an app installed it is rebuilt
  once at its next turn (which also catches the residents who installed before v2.1.5 and never sent
  /new); with no app installed it is left alone. A removal changes the fingerprint too: the next turn
  rebuilds once, the removed app's skill (unlinked by the stage helper) leaves the skills index, and
  when the last app goes the rebuilt prompt carries no stamp, which matches `""`.
- The refresh is av-events' prompt refresh (`_prompt_refresh.check_and_refresh`, reason `miniapps`),
  with the Bot Chat branch's skills-cache clear in front (`clear_skills_system_prompt_cache(
  clear_snapshot=True)`, `agent/prompt_builder.py:1129-1137`): the rebuilt prompt carries the new
  stamp, so the next turn matches and nothing rebuilds again.

Switch: `AV_MINIAPP_REFRESH` = on (default; also unset or blank) | `0` (off|false|no). Any other value
is off with one WARNING per process. Plus `miniapp_refresh` in `AV_HOOKS_DISABLED`, which wins. Off,
the section renders empty and no check runs (today's behaviour). Independent of `AV_PROMPT_REFRESH`:
this runs for every resident. Standard library only; no content is ever logged.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import re
import stat
import tempfile
import threading
from pathlib import Path
from typing import Any, Optional

from ._core import env, hermes_home

logger = logging.getLogger("av-events")

#: Its name in `AV_HOOKS_DISABLED`, and its own switch.
SWITCH = "miniapp_refresh"
MODE_VAR = "AV_MINIAPP_REFRESH"
ON_VALUES = frozenset({"1", "true", "yes", "on"})
OFF_VALUES = frozenset({"0", "false", "no", "off"})

#: The plugin section id (Hermes: 1-128 of `[a-z0-9._-]`, starting alphanumeric).
SECTION_ID = "av-events.mini-apps-epoch"
#: The stamp, the same shape as Hermes's `Capability epoch: <12 hex>`.
STAMP_PREFIX = "Mini-apps epoch: "
STAMP_RE = re.compile(r"Mini-apps epoch: ([0-9a-f]{12})")
#: Hermes v2026.9.24 `hermes_cli/plugins_dispatch.py:73-96`: the frame every section is persisted in.
SECTIONS_START = "<!-- hermes-plugin-sections:start -->"
SECTIONS_END = "<!-- hermes-plugin-sections:end -->"
SECTION_HEADING = "## Plugin Context: "
CHARS_RE = re.compile(r"<!-- hermes-plugin-section-chars:(\d{1,4}) -->\n\n")
#: Hermes accepts a persisted frame only right before the timestamp line (`agent/system_prompt.py:146-152`).
TIMESTAMP_AFTER = "\n\nConversation started:"

#: `village-bridge/_mini_apps.py` `installed()`: the projection file and its size cap.
PROJECTION = "mini-apps.json"
MAX_PROJECTION_BYTES = 16384
#: A skill name as the projection names it (`installed()` holds app ids to the same pattern).
SKILL_NAME = re.compile(r"[a-z][a-z0-9-]{0,63}")
#: A SKILL.md larger than this is fingerprinted by a marker, not read.
MAX_SKILL_BYTES = 1 << 20

_LOCK = threading.Lock()
#: True while this plugin's section is registered with Hermes (no section: no stamp, so no check).
_STATE = {"registered": False, "broken": False}
_LATCHED: set = set()


# ---- switch --------------------------------------------------------------------------------------


def _latched_log(key: str, level: int, message: str, *args: Any) -> None:
    """`level` the first time `key` fires in this process, DEBUG after that."""
    with _LOCK:
        first = key not in _LATCHED
        _LATCHED.add(key)
    try:
        logger.log(level if first else logging.DEBUG, message, *args)
    except BaseException:  # noqa: BLE001 - a log line must not cost the turn
        pass


def _hooks_disabled(collector: Any) -> bool:
    hooks = None
    if collector is not None:
        hooks = getattr(getattr(collector, "config", None), "disabled_hooks", None)
    if hooks is None:
        hooks = frozenset(part.strip().lower() for part in env("AV_HOOKS_DISABLED").split(",") if part.strip())
    return SWITCH in hooks


def enabled(collector: Any = None) -> bool:
    """On unless `AV_MINIAPP_REFRESH` says off or `miniapp_refresh` is in `AV_HOOKS_DISABLED`."""
    if _hooks_disabled(collector):
        return False
    value = env(MODE_VAR).strip().lower()
    if not value or value in ON_VALUES:
        return True
    if value not in OFF_VALUES:
        _latched_log("mode", logging.WARNING, "av-events: miniapp_refresh: %s has an unknown value; off (use 1 or 0)",
                     MODE_VAR)
    return False


def active(collector: Any = None) -> bool:
    """The check runs: the section is registered (so rebuilt prompts carry the stamp), the stamp has
    not been found missing from a rebuild in this process, and the switch is on."""
    with _LOCK:
        ready = _STATE["registered"] and not _STATE["broken"]
    return ready and enabled(collector)


# ---- fingerprint ---------------------------------------------------------------------------------


def _read_nofollow(path: Path, cap: int) -> Optional[bytes]:
    """The file's bytes; None when absent. Raises OSError when it is a symlink, not a regular file,
    or over `cap` (the guards of `installed()`)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as handle:
        st = os.fstat(handle.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_size > cap:
            raise OSError("not a small regular file")
        return handle.read(cap + 1)


def _no_symlink_below(root: Path, path: Path) -> bool:
    """No component from `root` (itself included) down to `path` is a symlink."""
    current = path
    while True:
        if current.is_symlink():
            return False
        if current == root or current.parent == current:
            return True
        current = current.parent


def _skill_digest(home: Path, name: Any) -> str:
    """sha256 of `skills/<name>/SKILL.md`; `-` absent, `?` unreadable or not a plain file under home."""
    if not isinstance(name, str) or not SKILL_NAME.fullmatch(name):
        return "?"
    path = home / "skills" / name / "SKILL.md"
    try:
        if not _no_symlink_below(home, path):
            return "?"
        raw = _read_nofollow(path, MAX_SKILL_BYTES)
    except OSError:
        return "?"
    return "-" if raw is None else hashlib.sha256(raw).hexdigest()


def fingerprint(home: Optional[Path] = None) -> Optional[str]:
    """12 hex of the installed apps (sorted ids, each whole entry and its SKILL.md digests); `""`
    when none is installed or the file is absent; None when the file exists but cannot be read (a
    symlink, not a regular file, over 16 KiB, not JSON, not `{"apps": [{"id": ...}, ...]}`). Never
    raises: any other failure (a `RecursionError` from a deeply nested file under the cap) is None
    too, no verdict, so it can neither fail a turn nor stop F1 at the gate (fold round 1, S1)."""
    try:
        return _fingerprint(home)
    except Exception:  # noqa: BLE001 - no verdict
        return None


def _fingerprint(home: Optional[Path]) -> Optional[str]:
    surface = _surface(home)
    if surface is None:
        return None
    if not surface:
        return ""
    return _hash12(surface)


def _hash12(value: Any) -> Optional[str]:
    """12 hex of the canonical JSON of `value`; None when it does not serialise."""
    try:
        canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()[:12]


def legacy_fingerprint(home: Optional[Path] = None) -> Optional[str]:
    """The fingerprint without the `village` fold (what the overlay before SKILL-CHANGE-NOTE stamped)."""
    try:
        surface = _surface(home, fold=False)
    except Exception:  # noqa: BLE001 - no verdict
        return None
    if surface is None:
        return None
    return _hash12(surface) if surface else ""


def _surface(home: Optional[Path], *, fold: bool = True) -> Optional[list]:
    """The installed apps sorted by id, each `{"app": <entry>, "skill_files": [[skill, digest], ...]}`
    (plus `village_ops` under Hermes); `[]` when none is installed or the file is absent; None when
    the file cannot be read, or Hermes's `village` tool cannot be read (review-b N-b: no verdict, never
    a stamp change because the bridge did not register this restart)."""
    home = Path(home) if home is not None else Path(hermes_home())
    path = home / PROJECTION
    try:
        if any(p.is_symlink() for p in (path, *path.parents)):
            return None
        raw = _read_nofollow(path, MAX_PROJECTION_BYTES)
    except OSError:
        return None
    if raw is None:
        return ""
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    apps = doc.get("apps") if isinstance(doc, dict) else None
    if not isinstance(apps, list) or not all(isinstance(app, dict) and isinstance(app.get("id"), str) for app in apps):
        return None
    surface = []
    village = _village_operations() if apps and fold else None
    if village is UNREADABLE:
        return None
    for app in sorted(apps, key=lambda entry: entry["id"]):
        skills = app.get("skills") if isinstance(app.get("skills"), list) else []
        item = {"app": app, "skill_files": [[str(name), _skill_digest(home, name)] for name in skills]}
        if village is not None:
            # SKILL-CHANGE-NOTE (review-b M1): the `village` operations this app's operation families name
            # (zzzbot's `zzz.*`), so a bridge-only change (ov#531 added zzz.open_team_room) moves the app.
            families = {op.split(".", 1)[0] for op in app.get("operations") or [] if isinstance(op, str)}
            item["village_ops"] = [op for op in village if op.split(".", 1)[0] in families]
        surface.append(item)
    return surface


#: `_village_operations` under Hermes when its `village` tool cannot be read: no verdict.
UNREADABLE = object()


def hermes_tool_definitions(tools: Any, toolsets: list) -> list:
    """`model_tools.get_tool_definitions` for these toolsets as Hermes builds them (quiet, memoised, no
    tool-search assembly), leaving no trace: every call also rebinds the process-global
    `model_tools._last_resolved_tool_names` (`execute_code`'s fallback tool list), so it is put back
    as it was, the way Hermes guards it around a child build (`tools/delegate_tool_results.py:300-311`;
    review-b N-e)."""
    had = hasattr(tools, "_last_resolved_tool_names")
    saved = getattr(tools, "_last_resolved_tool_names", None)
    try:
        return tools.get_tool_definitions(enabled_toolsets=list(toolsets), quiet_mode=True,
                                          skip_tool_search_assembly=True)
    finally:
        if had:
            tools._last_resolved_tool_names = saved


#: The fold's last read and the Hermes tool-table generation it was read at (review-b N-e: once per
#: registration change, not several times per turn).
_FOLD_MEMO: dict = {"key": None, "value": None}


def _generation() -> Optional[tuple]:
    """Hermes's tool-table generation and scope (`toolsets._registry_generation`, `_registry_call`), the
    key `model_tools` memoises on; None when this Hermes has no such helpers (then no memo)."""
    try:
        toolsets = importlib.import_module("toolsets")
        return (tuple(toolsets._registry_generation()), toolsets._registry_call("current_scope_key", ""))
    except Exception:  # noqa: BLE001
        return None


def _village_operations() -> Any:
    """The `operation` enum of the `village` tool as Hermes builds it now (`model_tools`
    `get_toolset_for_tool` + `get_tool_definitions`, the public read the gated-tools scan accepts),
    sorted, memoised per tool-table generation. None when not under Hermes (no `model_tools`: the
    fingerprint is the unfolded one); `UNREADABLE` under Hermes when the tool is not registered or has
    another shape."""
    try:
        tools = importlib.import_module("model_tools")
    except Exception:  # noqa: BLE001 - not under Hermes
        return None
    key = _generation()
    with _LOCK:
        if key is not None and _FOLD_MEMO["key"] == key:
            return _FOLD_MEMO["value"]
    value = _read_village_operations(tools)
    if key is not None:
        with _LOCK:
            _FOLD_MEMO["key"], _FOLD_MEMO["value"] = key, value
    return value


def _read_village_operations(tools: Any) -> Any:
    try:
        toolset = tools.get_toolset_for_tool("village")
        if not toolset:
            return UNREADABLE
        defs = hermes_tool_definitions(tools, [toolset])
        village = [d for d in defs if (d.get("function") or {}).get("name") == "village"]
        enum = village[0]["function"]["parameters"]["properties"]["operation"]["enum"]
    except Exception:  # noqa: BLE001 - no tool, another shape: no verdict
        return UNREADABLE
    if not isinstance(enum, list):
        return UNREADABLE
    return sorted({op for op in enum if isinstance(op, str)})


def digest() -> str:
    """The pre-filter's value: the fingerprint, `-` for none installed, `?` for unreadable."""
    current = fingerprint()
    return "?" if current is None else (current or "-")


# ---- what each stamp meant (SKILL-CHANGE-NOTE) -----------------------------------------------------
#
# A stamp is a hash, so it cannot say which app changed. Each fingerprint a prompt is stamped with is
# recorded once with, per app, its digest (the same surface, one app each) and the key of its SKILL.md
# `update_note` (so a note already given for an older stamp is not given again). Catalog data only, no
# resident data. Bounded by count and by size (the oldest go first); an unreadable or foreign file is
# read as empty and replaced at the next new fingerprint.

#: Relative to `$HERMES_HOME`, beside av-events' other state.
EPOCHS_FILE = os.path.join("av-events", "miniapp-epochs.json")
MAX_EPOCHS = 64
#: A full projection (16 KiB) yields far less per epoch than this; trimmed oldest first to fit (review-b N3).
MAX_EPOCHS_BYTES = 1 << 20
#: Fingerprints this process has recorded (or found recorded); a write happens once per new one.
_KNOWN: set = set()

_FENCE_END = re.compile(r"\n---[ \t\r]*\n")
_FIELD = re.compile(r"([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t\r]*$")


def front_matter(text: str) -> tuple:
    """(plain top-level `key: value` fields, body), the block Hermes finds (`agent/skill_utils.py`
    `parse_frontmatter`: BOM stripped, a leading `---`, closed by the next `---` line). Only plain
    one-line values are read (a block scalar, flow value, anchor, alias or tag is left out); a repeated
    key keeps its last value, as YAML does."""
    text = text[1:] if text.startswith("\ufeff") else text
    if not text.startswith("---"):
        return {}, text
    end = _FENCE_END.search(text, 3)
    if end is None:
        return {}, text
    fields: dict = {}
    for line in text[3:end.start()].split("\n"):
        found = _FIELD.fullmatch(line)
        if not found:
            continue
        key, value = found.groups()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif not value or value[0] in "|>&*!{[\"'":
            fields.pop(key, None)
            continue
        fields[key] = value
    return fields, text[end.end():]


def skill_text(home: Path, name: Any) -> Optional[str]:
    """`skills/<name>/SKILL.md` as text, read with the fingerprint's guards (no symlink below home,
    `O_NOFOLLOW`, a regular file under the cap); None when absent or refused."""
    if not isinstance(name, str) or not SKILL_NAME.fullmatch(name):
        return None
    path = home / "skills" / name / "SKILL.md"
    try:
        if not _no_symlink_below(home, path):
            return None
        raw = _read_nofollow(path, MAX_SKILL_BYTES)
    except OSError:
        return None
    if raw is None:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def note_key(home: Path, skills: list, version: Any) -> str:
    """12 hex of the first readable SKILL.md's `update_note` while its `update_note_for` is the app's
    projection `version`; `""` when it has none, or one bound to another version."""
    for name in skills:
        text = skill_text(home, name)
        if text is None:
            continue
        fields, _ = front_matter(text)
        note = fields.get("update_note")
        if not note or not isinstance(version, str) or fields.get("update_note_for") != version:
            return ""
        return _hash12([version, note]) or ""
    return ""


def current_apps(home: Optional[Path] = None) -> Optional[tuple]:
    """(fingerprint, {app id: {"digest", "skills", "version", "note"}}) for the apps on disk now, the
    fingerprint recorded with its per-app digests and note keys (`remember`). None when the projection
    cannot be read. Never raises."""
    try:
        root = Path(home) if home is not None else Path(hermes_home())
        surface = _surface(root)
        if surface is None:
            return None
        current = _hash12(surface) if surface else ""
        if current is None:
            return None
        apps = {}
        for item in surface:
            app_digest = _hash12(item)
            if app_digest is None:
                return None
            skills = [name for name, _ in item["skill_files"]]
            version = item["app"].get("version")
            apps[item["app"]["id"]] = {"digest": app_digest, "skills": skills, "version": version,
                                       "note": note_key(root, skills, version)}
        if current:
            remember(current, {app_id: {"d": info["digest"], "n": info["note"]} for app_id, info in apps.items()},
                     root)
        return current, apps
    except Exception:  # noqa: BLE001 - no verdict
        return None


def _epochs_path(home: Optional[Path]) -> Path:
    return (Path(home) if home is not None else Path(hermes_home())) / EPOCHS_FILE


def _record_ok(value: Any) -> bool:
    return isinstance(value, dict) and all(
        isinstance(v, dict) and isinstance(v.get("d"), str) and isinstance(v.get("n"), str) for v in value.values())


def _load_epochs(home: Optional[Path]) -> list:
    """[[fingerprint, {app id: {"d": digest, "n": note key}}], ...] oldest first; [] when absent or not ours.
    Read with `O_NOFOLLOW`: a symlink there reads as empty (and is replaced by the next write)."""
    try:
        raw = _read_nofollow(_epochs_path(home), MAX_EPOCHS_BYTES)
        doc = json.loads(raw.decode("utf-8")) if raw is not None else None
    except (OSError, ValueError, RecursionError):
        return []
    epochs = doc.get("epochs") if isinstance(doc, dict) else None
    if not isinstance(epochs, list):
        return []
    return [item for item in epochs if isinstance(item, list) and len(item) == 2 and isinstance(item[0], str)
            and _record_ok(item[1])]


def _encode(epochs: list) -> bytes:
    return json.dumps({"v": 1, "epochs": epochs}, separators=(",", ":"), sort_keys=True).encode("utf-8")


def remember(current: str, apps: dict, home: Optional[Path] = None) -> None:
    """Record `current` with its per-app records unless this process already has. At most `MAX_EPOCHS`,
    trimmed oldest first to stay under `MAX_EPOCHS_BYTES`. Temp file + rename, 0600; a failure only
    costs a later note its precision (`remembered` then returns None)."""
    with _LOCK:
        if current in _KNOWN:
            return
    epochs = _load_epochs(home)
    if not any(item[0] == current for item in epochs):
        epochs = (epochs + [[current, dict(apps)]])[-MAX_EPOCHS:]
        data = _encode(epochs)
        while len(data) > MAX_EPOCHS_BYTES and len(epochs) > 1:
            epochs = epochs[1:]
            data = _encode(epochs)
        if len(data) > MAX_EPOCHS_BYTES:
            return
        path = _epochs_path(home)
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".miniapp-epochs.", dir=str(path.parent))
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                os.replace(tmp, path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError:
            return
    with _LOCK:
        _KNOWN.add(current)


def remembered(stamp: str, home: Optional[Path] = None) -> Optional[dict]:
    """{app id: {"d": digest, "n": note key}} recorded for `stamp`; `{}` for no stamp (no app installed);
    None when unknown (a stamp from before this record existed, or one that fell off the end)."""
    if not stamp:
        return {}
    for item in reversed(_load_epochs(home)):
        if item[0] == stamp:
            return dict(item[1])
    return None


# ---- the stamp -----------------------------------------------------------------------------------


def section_text(_session_info: Any = None) -> str:
    """What the section renders: the stamp, or empty (no app, unreadable file, switch off)."""
    try:
        if not enabled(None):
            return ""
        # SKILL-CHANGE-NOTE: the stamp is recorded with its per-app digests as it is rendered.
        found = current_apps()
        current = found[0] if found is not None else None
        if current is None:
            # review-b N-g: the `village` fold unreadable (the bridge did not register this restart) but
            # the projection readable: the unfolded stamp, so the chat is not later read as stampless
            # ("every app is new") once the bridge is back.
            current = legacy_fingerprint()
    except Exception:  # noqa: BLE001 - an empty section is today's prompt
        return ""
    return f"{STAMP_PREFIX}{current}" if current else ""


def stamp_in(prompt: Any) -> str:
    """The stamp in a prompt's last plugin-sections frame, read the way Hermes restores it (the last
    frame, ending right before the timestamp line); `""` when the prompt has none (or only a
    malformed one). A frame quoted earlier in the prompt (AGENTS.md, a skill) is not read. A resident
    whose USER.md ends in a forged frame on a box with no app installed can at most cost their own
    box one rebuild and switch this check off until the next restart (`confirm_rebuilt`)."""
    if not isinstance(prompt, str):
        return ""
    start = prompt.rfind(SECTIONS_START)
    if start < 0:
        return ""
    end = prompt.find(SECTIONS_END, start)
    if end < 0 or not prompt[end + len(SECTIONS_END):].startswith(TIMESTAMP_AFTER):
        return ""
    frame = prompt[start:end]
    heading = f"{SECTION_HEADING}{SECTION_ID}\n"
    at = frame.find(heading)
    if at < 0:
        return ""
    after = at + len(heading)
    chars = CHARS_RE.match(frame, after)
    if chars is None:
        return ""
    content = frame[chars.end():chars.end() + int(chars.group(1))]
    found = STAMP_RE.fullmatch(content)
    return found.group(1) if found else ""


def stale(prompt: str) -> bool:
    """The prompt's stamp differs from the installed apps now. No verdict (False) when the
    projection cannot be read."""
    current = fingerprint()
    if current is None:
        return False
    return stamp_in(prompt) != current


def confirm_rebuilt(prompt: str, before: Optional[str]) -> bool:
    """After a `miniapps` rebuild: the new prompt carries the stamp the check expects (the fingerprint
    before the rebuild, or now, if the projection moved meanwhile). When it does not (the section was
    not rendered: a render error, Hermes's section budget), the check stops for this process, with one
    WARNING, so a missing stamp never rebuilds every turn."""
    found = stamp_in(prompt)
    if found == (before or "") or found == (fingerprint() or ""):
        return True
    with _LOCK:
        _STATE["broken"] = True
    _latched_log("broken", logging.WARNING,
                 "av-events: miniapp_refresh: the rebuilt prompt has no current %s section; check off until restart",
                 SECTION_ID)
    return False


# ---- registration --------------------------------------------------------------------------------


def register_section(ctx: Any) -> bool:
    """Register the stamp section. A Hermes without `register_system_prompt_section` (or one that
    refuses it) gets one INFO line and no check: without the stamp a rebuild could not be confirmed."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if not callable(register):
        logger.info("av-events: miniapp_refresh: Hermes has no register_system_prompt_section; left as is")
        return False
    try:
        register(SECTION_ID, section_text, max_chars=64)
    except Exception as exc:  # noqa: BLE001 - optional: the hooks and tools are not
        logger.info("av-events: miniapp_refresh: section not registered (%s); left as is", type(exc).__name__)
        return False
    with _LOCK:
        _STATE["registered"] = True
    return True


def unregister() -> None:
    """Plugin unload: Hermes drops the section with the plugin's other registrations."""
    with _LOCK:
        _STATE["registered"] = False


def reset() -> None:
    """Forget the registration, the broken latch and log latches (tests)."""
    with _LOCK:
        _STATE["registered"] = False
        _STATE["broken"] = False
        _LATCHED.clear()
        _KNOWN.clear()
        _FOLD_MEMO["key"] = _FOLD_MEMO["value"] = None


__all__ = [
    "MODE_VAR",
    "SECTION_ID",
    "SWITCH",
    "active",
    "confirm_rebuilt",
    "current_apps",
    "digest",
    "enabled",
    "fingerprint",
    "front_matter",
    "legacy_fingerprint",
    "note_key",
    "register_section",
    "remember",
    "remembered",
    "reset",
    "section_text",
    "skill_text",
    "stale",
    "stamp_in",
    "unregister",
]
