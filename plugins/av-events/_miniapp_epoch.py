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
import json
import logging
import os
import re
import stat
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
    if not apps:
        return ""
    surface = []
    for app in sorted(apps, key=lambda entry: entry["id"]):
        skills = app.get("skills") if isinstance(app.get("skills"), list) else []
        surface.append({"app": app, "skill_files": [[str(name), _skill_digest(home, name)] for name in skills]})
    try:
        canonical = json.dumps(surface, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()[:12]


def digest() -> str:
    """The pre-filter's value: the fingerprint, `-` for none installed, `?` for unreadable."""
    current = fingerprint()
    return "?" if current is None else (current or "-")


# ---- the stamp -----------------------------------------------------------------------------------


def section_text(_session_info: Any = None) -> str:
    """What the section renders: the stamp, or empty (no app, unreadable file, switch off)."""
    try:
        if not enabled(None):
            return ""
        current = fingerprint()
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


__all__ = [
    "MODE_VAR",
    "SECTION_ID",
    "SWITCH",
    "active",
    "confirm_rebuilt",
    "digest",
    "enabled",
    "fingerprint",
    "register_section",
    "reset",
    "section_text",
    "stale",
    "stamp_in",
    "unregister",
]
