"""av-approval — the receipts half of approval.md for Agent Village (DATA-43),
and the gate's fail-closed backstop at every gateway start (DATA-234).

THE BACKSTOP (enforced-on mode only, `AV_APPROVAL_ENABLED=1|true|yes|on`).
Hermes registers the approval shim's shell hooks once, at gateway start, from
`config.yaml`, and only with consent. Several states at that moment leave the
tenant UNGATED without a word: consent missing from both channels, the hooks
block edited, the shim replaced, or a consent allowlist lock Hermes cannot
open (`register_from_config` then raises and the gateway swallows it, so no
hook registers). Hermes loads plugins BEFORE it registers shell hooks, so
`register()` runs a gate-integrity check first:

  - `$HERMES_HOME/config.yaml`: a `hooks.pre_tool_call` entry running the
    shim for every gated matcher, each `fail_closed: true` and `timeout: 300`,
    and `hooks_auto_accept` on;
  - `$HERMES_HOME/.env` assigns `HERMES_ACCEPT_HOOKS=1` (only that line is
    looked at), and this process's environment has it;
  - `shell-hooks-allowlist.json` and its `.lock` absent, or regular files owned
    by this uid that it can read (the lock: read and write), and a writable
    home when the lock is absent;
  - the shim present, executable, and its sha256 equal to the one the
    installer recorded in `agent-hooks/approval-surface.json` (`shim_sha256`);
  - `AV_APPROVAL_URL` set.

It registers a `pre_tool_call` callback that, for every GATED tool (the same
full-match matchers the installer writes, `GATED_MATCHERS`), RAISES
`GateUnverified("av-approval: gate unverified (<code>)")` while the check
fails. Hermes turns a raising `pre_tool_call` callback into a block directive
(hermes_cli/plugins_dispatch.py `invoke_hook`, `_policy_error_block_directive`
at v2026.9.24), so the call does not run. Ungated tools are never touched.
The check re-runs at most once a minute on a gated call (the config is
re-parsed only when its sha256 changed). A failure found at START is sticky
for the life of the process: the shell hooks were registered, or not, at
start, and only a restart registers them again. A later failure blocks only
while it lasts. Codes only are logged; the agent token is never read (the
check never opens the token file and never reads `AV_APPROVAL_TOKEN`).

Unset (never opted in) does nothing. Off is the kill switch, fail-open as
documented below; the backstop belongs to the enforced-on mode only.

RECEIPTS: still a documented stub. approval-md-hosted docs/03 section 3.3
gives this plugin one more job beside the gate: on `post_tool_call`, post a
receipt (tool, outcome, execution token id) to the tenant's facade, so the
daemon closes the `execution.started` record the gate opened and AV's
`action.receipted` has its rows.

Why no receipt is posted: the facade (`approval serve`, approval-md core at
6b74ca72) has no receipt endpoint. Its routes are `/verbs`, `/verb/<name>`,
`/hook/<harness>`, `/log/follow`, `/export` and `/status`, and the agent
credential reaches only the catalog, the hook route and five verbs
(instructions, hook_classify, request, wait, withdraw). A `post_tool_call` envelope posted to
`/hook/hermes` reaches the core's post half, but that half joins a receipt to
its `execution.started` by the envelope's top-level `tool_use_id`, while
Hermes puts the call id in `extra.tool_call_id` (and the result in
`extra.result`, where the core reads `tool_response`). The pre half therefore
mints a random task id for every Hermes call and the post half appends nothing.
Posting receipts that are guaranteed to record nothing would be traffic with
no effect, so the plugin says so once and sends nothing. The DATA-43b
follower derives receipts from the daemon log instead; once the core reads
Hermes's call id, this plugin is where the receipt post goes.

Kill switch: `AV_APPROVAL_ENABLED`. The fail-open line tracks the GATE, not
the plugin: `av-approval: disabled (fail-open)` is logged once only when the
switch is explicitly off (set, and not `1|true|yes|on`) AND `config.yaml`
carries no hook entry running the approval shim, i.e. the tenant really runs
ungated. Off with the entries still present logs that the gate is still in
force until the installer runs. Unset (never opted in) logs nothing. Unlike
`av-events` this plugin belongs to a gate, so the gap is logged as fail-open.

Python 3.11, standard library and PyYAML (Hermes ships it). Never raises out
of `register`; the pre-call callback raises only to block a gated call.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import stat
import threading
import time
from pathlib import Path
from typing import Any, Optional

PLUGIN_VERSION = "0.2.0"
__version__ = PLUGIN_VERSION

#: The core version whose facade was read for a receipt surface.
CORE_VERSION = "approval-md 6b74ca72"

DISABLED_LINE = "av-approval: disabled (fail-open)"
STILL_GATED_LINE = ("av-approval: AV_APPROVAL_ENABLED is off but config.yaml still runs the approval shim; "
                    "the gate stays in force until the installer runs")
SHIM_SUFFIX = "/agent-hooks/hermes-hook-shim.sh"
RECEIPTS_DISABLED_LINE = f"av-approval: receipts disabled (no facade receipt surface at {CORE_VERSION})"
VERIFIED_LINE = "av-approval: gate verified at start"
UNVERIFIED_START_FMT = ("av-approval: gate unverified at start ({codes}); every gated tool call is blocked "
                        "until the gateway restarts with the gate intact")
UNVERIFIED_LATER_FMT = "av-approval: gate unverified ({codes}); gated tool calls are blocked while it lasts"
RECOVERED_LINE = "av-approval: gate verified again"
UNREGISTERED_LINE = "av-approval: the backstop could not be registered (gated calls rely on the shell hook alone)"
#: The message a blocked gated call carries (Hermes prefixes the callback name and exception type).
UNVERIFIED_FMT = "av-approval: gate unverified ({code})"

#: The installer's gated matchers (install/install_approval.ts APPROVAL_GATED_TOOLS), full-match regexes.
GATED_MATCHERS: tuple[str, ...] = (
    "terminal",
    "write_file",
    "patch",
    "read_file",
    "search_files",
    "execute_code",
    "process(_manage)?",
    "web_extract",
    "browser_.*",
    "skill_manage",
    "delegate_task",
    "cronjob(_manage)?",
    "send_message",
    # R3b (DATA-344): the side-effecting tools the policy's tools: list judges (install_approval.ts says why).
    "mcp__index__create_intent",
    "mcp__index__update_intent",
    "mcp__index__archive_intent",
    "mcp__index__pause_intent",
    "mcp__index__resume_intent",
    "mcp__index__accept_opportunity",
    "mcp__index__reject_opportunity",
    "mcp__index__update_my_profile",
    "mcp__index__enrich_my_profile",
    "index_create_intent",
    "index_update_intent",
    "index_add_intent_to_network",
    "index_create_network",
    "index_update_network",
    "index_join_network",
    "index_update_opportunity",
    "index_research_profile",
    "image_generate",
    "video_generate",
    "text_to_speech",
    "web_search",
    "x_search",
)
#: The installer's per-entry timeout.
ENTRY_TIMEOUT_S = 300
SHIM_RELPATH = "agent-hooks/hermes-hook-shim.sh"
MARKER_RELPATH = "agent-hooks/approval-surface.json"
ALLOWLIST_FILE = "shell-hooks-allowlist.json"
ALLOWLIST_LOCK_FILE = ALLOWLIST_FILE + ".lock"
#: A gated call re-runs the check at most this often.
RECHECK_S = 60.0

#: Hooks registered when the switch is on.
HOOKS: tuple[str, ...] = ("pre_tool_call",)

_TRUTHY = frozenset({"1", "true", "yes", "on"})
_GATED = tuple(re.compile(m) for m in GATED_MATCHERS)
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?HERMES_ACCEPT_HOOKS\s*=(.*)$")

logger = logging.getLogger("av-approval")

#: Kept on the logger, which outlives a module reload, so "once" means once per process.
_LOGGED_ATTR = "_av_approval_logged"


class GateUnverified(RuntimeError):
    """Raised by the pre-call backstop for a gated tool while the gate cannot be verified."""


def switch() -> str:
    """`unset`, `on` (`1|true|yes|on`, any case) or `off`. Hermes has already loaded `.env` into the environment."""
    raw = os.environ.get("AV_APPROVAL_ENABLED", "").strip().lower()
    if not raw:
        return "unset"
    return "on" if raw in _TRUTHY else "off"


def enabled() -> bool:
    return switch() == "on"


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", "").strip() or os.path.join(os.path.expanduser("~"), ".hermes"))


def gate_entries_present() -> bool:
    """True when `$HERMES_HOME/config.yaml` has a `pre_tool_call` entry running the approval shim.

    Unreadable or unparseable reads as absent: the line this feeds is the
    fail-open warning, and a config nobody can read is no evidence of a gate.
    """
    home = str(hermes_home())
    try:
        import yaml  # Hermes ships PyYAML

        with open(os.path.join(home, "config.yaml"), encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh)
        entries = ((cfg or {}).get("hooks") or {}).get("pre_tool_call") or []
        return any(isinstance(e, dict) and str(e.get("command", "")).strip().endswith(SHIM_SUFFIX) for e in entries)
    except Exception:  # noqa: BLE001
        return False


def is_gated(tool_name: Any) -> bool:
    """True when the installer's matchers send `tool_name` to the shim (Hermes's `re.fullmatch`)."""
    return isinstance(tool_name, str) and any(p.fullmatch(tool_name) for p in _GATED)


# ---------------------------------------------------------------------------
# The integrity check
# ---------------------------------------------------------------------------

#: (config sha256, codes from the config) of the last parse, so a re-check re-parses only on change.
_config_cache: dict[str, Any] = {"sha": None, "codes": ()}


def _config_codes(text: bytes, shim: str) -> tuple[str, ...]:
    """The config's codes: the hooks block, every gated matcher's entries, the config consent channel."""
    import yaml  # Hermes ships PyYAML; it also resolves YAML merge keys the way Hermes's loader does

    try:
        cfg = yaml.safe_load(text.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return ("config-unreadable",)
    if not isinstance(cfg, dict):
        return ("config-unreadable",)
    codes: list[str] = []
    hooks = cfg.get("hooks")
    pre = hooks.get("pre_tool_call") if isinstance(hooks, dict) else None
    if not isinstance(pre, list):
        codes.append("hooks-missing")
        pre = []
    # Commands and matchers compared after Python's strip(), as Hermes's parser does.
    ours = [e for e in pre if isinstance(e, dict) and isinstance(e.get("command"), str) and e["command"].strip() == shim]
    for matcher in GATED_MATCHERS:
        mine = [e for e in ours if isinstance(e.get("matcher"), str) and e["matcher"].strip() == matcher]
        if not mine:
            codes.append(f"hook-missing:{matcher}")
            continue
        for entry in mine:
            # Hermes: `fail_closed` (else `failClosed`) must be a real bool.
            if entry.get("fail_closed", entry.get("failClosed", False)) is not True:
                codes.append(f"fail-closed-off:{matcher}")
            timeout = entry.get("timeout")
            if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout != ENTRY_TIMEOUT_S:
                codes.append(f"entry-timeout:{matcher}")
    auto = cfg.get("hooks_auto_accept", False)
    if not (auto is True or (isinstance(auto, str) and auto.strip().lower() in _TRUTHY)):
        codes.append("consent-missing:config")
    return tuple(dict.fromkeys(codes))


def _env_file_consent(path: Path) -> bool:
    """True when `.env` assigns HERMES_ACCEPT_HOOKS a truthy value (last assignment wins).

    Only that line is matched; no other line is kept or parsed, so the token a
    hosted-dogfood `.env` carries is never read into a value.
    """
    value: Optional[str] = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = _ENV_LINE.match(line)
            if m:
                value = m.group(1).strip().strip("'\"").strip()
    return value is not None and value.lower() in _TRUTHY


def _allowlist_codes(home: Path) -> list[str]:
    codes: list[str] = []
    uid = os.geteuid()
    for name, mode, code in ((ALLOWLIST_FILE, os.R_OK, "allowlist-unusable"),
                             (ALLOWLIST_LOCK_FILE, os.R_OK | os.W_OK, "allowlist-lock-unusable")):
        path = home / name
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            # Hermes creates the lock with open("a+"): it needs a home this uid can write.
            if name == ALLOWLIST_LOCK_FILE and not os.access(home, os.W_OK | os.X_OK):
                codes.append("allowlist-lock-uncreatable")
            continue
        except OSError:
            codes.append(code)
            continue
        if (stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or st.st_uid != uid
                or not os.access(path, mode)):
            codes.append(code)
    return codes


def _shim_codes(home: Path) -> list[str]:
    shim = home / SHIM_RELPATH
    try:
        st = os.lstat(shim)
    except OSError:
        return ["shim-missing"]
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        return ["shim-missing"]
    if not os.access(shim, os.X_OK):
        return ["shim-not-executable"]
    try:
        with open(home / MARKER_RELPATH, encoding="utf-8") as fh:
            recorded = json.load(fh).get("shim_sha256")
    except Exception:  # noqa: BLE001
        recorded = None
    if not isinstance(recorded, str) or not recorded:
        return ["manifest-missing"]
    try:
        digest = hashlib.sha256(shim.read_bytes()).hexdigest()
    except OSError:
        return ["shim-missing"]
    return [] if digest == recorded else ["shim-hash-mismatch"]


def integrity_problems(home: Optional[Path] = None) -> tuple[str, ...]:
    """Codes naming why the installed gate cannot be trusted at this moment; empty when it can.

    File and environment state only. Never reads the agent token.
    """
    home = home or hermes_home()
    codes: list[str] = []
    try:
        text = (home / "config.yaml").read_bytes()
    except OSError:
        codes.append("config-unreadable")
    else:
        sha = hashlib.sha256(text).hexdigest()
        if _config_cache["sha"] != sha:
            _config_cache["codes"] = _config_codes(text, str(home / SHIM_RELPATH))
            _config_cache["sha"] = sha
        codes.extend(_config_cache["codes"])
    try:
        if not _env_file_consent(home / ".env"):
            codes.append("consent-missing:env-file")
    except OSError:
        codes.append("consent-missing:env-file")
    if os.environ.get("HERMES_ACCEPT_HOOKS", "").strip().lower() not in _TRUTHY:
        codes.append("consent-missing:env")
    codes.extend(_allowlist_codes(home))
    codes.extend(_shim_codes(home))
    if not os.environ.get("AV_APPROVAL_URL", "").strip():
        codes.append("url-missing")
    return tuple(dict.fromkeys(codes))


# ---------------------------------------------------------------------------
# The backstop
# ---------------------------------------------------------------------------

_state_lock = threading.Lock()
_state: dict[str, Any] = {"start": (), "codes": (), "checked_at": None}


def _check() -> tuple[str, ...]:
    try:
        return integrity_problems()
    except Exception:  # noqa: BLE001 - a check that cannot run verifies nothing
        return ("check-error",)


def current_codes(now: Optional[float] = None) -> tuple[str, ...]:
    """The codes in force for a gated call: the start's (sticky), else the last check's, re-run at most once a minute."""
    now = time.monotonic() if now is None else now
    with _state_lock:
        if _state["start"]:
            return _state["start"]
        checked = _state["checked_at"]
        if checked is None or now - checked >= RECHECK_S:
            before = _state["codes"]
            codes = _check()
            _state["codes"], _state["checked_at"] = codes, now
            if codes and codes != before:
                _log_once("later:" + ",".join(codes), UNVERIFIED_LATER_FMT.format(codes=", ".join(codes)))
            elif before and not codes:
                _log_once("recovered:" + ",".join(before), RECOVERED_LINE)
        return _state["codes"]


def _pre_tool_call(tool_name: Any = None, **_kwargs: Any) -> None:
    """Hermes `pre_tool_call` callback: raise for a gated tool while the gate is unverified; else nothing."""
    if not is_gated(tool_name):
        return None
    codes = current_codes()
    if codes:
        raise GateUnverified(UNVERIFIED_FMT.format(code=codes[0]))
    return None


def _start(now: Optional[float] = None) -> tuple[str, ...]:
    """The start-time check; its failure is sticky for this process."""
    codes = _check()
    with _state_lock:
        _state["start"] = codes
        _state["codes"] = codes
        _state["checked_at"] = time.monotonic() if now is None else now
    return codes


def _log_once(key: str, line: str) -> None:
    logged = getattr(logger, _LOGGED_ATTR, None)
    if not isinstance(logged, set):
        logged = set()
        setattr(logger, _LOGGED_ATTR, logged)
    if key in logged:
        return
    logged.add(key)
    try:
        logger.warning(line)
    except Exception:  # noqa: BLE001 - a log that cannot be written changes no verdict
        pass


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint. Off/unset: logs the state once. On: the start-time check, then the backstop."""
    try:
        state = switch()
        if state == "unset":
            return
        if state == "off":
            if gate_entries_present():
                _log_once("still-gated", STILL_GATED_LINE)
            else:
                _log_once("disabled", DISABLED_LINE)
            return
        # The check and the registration first: nothing that only logs may stand between them.
        codes = _start()
        try:
            ctx.register_hook("pre_tool_call", _pre_tool_call)
        except Exception:  # noqa: BLE001
            _log_once("unregistered", UNREGISTERED_LINE)
        _log_once("receipts-disabled", RECEIPTS_DISABLED_LINE)
        if codes:
            _log_once("start:" + ",".join(codes), UNVERIFIED_START_FMT.format(codes=", ".join(codes)))
        else:
            try:
                logger.info(VERIFIED_LINE)
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001 - a plugin must never break Hermes's plugin loading
        return


__all__ = [
    "CORE_VERSION",
    "DISABLED_LINE",
    "GATED_MATCHERS",
    "GateUnverified",
    "HOOKS",
    "PLUGIN_VERSION",
    "RECEIPTS_DISABLED_LINE",
    "STILL_GATED_LINE",
    "current_codes",
    "enabled",
    "gate_entries_present",
    "integrity_problems",
    "is_gated",
    "switch",
    "register",
]
