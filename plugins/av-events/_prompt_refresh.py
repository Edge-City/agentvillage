"""F1 PROMPT REFRESH: a long session's system prompt catches up with USER.md, MEMORY.md, AGENTS.md
and the skills index, once per change, at the start of a turn.

Why. Hermes v2026.9.24 builds a session's system prompt once and replays the stored bytes on every
later turn (`agent/conversation_loop.py:729-744`; the gateway also keeps the agent itself cached).
The memory blocks are a snapshot frozen at `load_from_disk` (`tools/memory_tool_store.py:132-163,
463-466`). So a USER.md entry the control plane, the app or a vote note writes reaches a resident's
open DM only at the next compaction or `/new`, and with the 1M window (`threshold_tokens` 256k)
compaction is rare. Rebuilding needs more than `_invalidate_system_prompt()`: the next turn's
restore would replay the stored row (:729-744). It has to rebuild and persist, as compaction and
Hermes's own Bot Chat branch (:705-728) do.

How (design option (c), private/handover/lanes-float/PROMPT-REFRESH-design.md). `install()` rebinds
`agent.conversation_loop.build_turn_context`, which `run_conversation` calls by bare name once per
user turn (:36 import, :1489 call), before the tool loop. The wrapper:

1. Gate: on per the switch below; the turn carries history; not a review / side-question fork
   (`_persist_disabled`, `_turn_origin`), not a subagent (`_delegate_depth`), not cron
   (`platform == "cron"` or a `cron_` session); the agent has a session DB and the two rebuild
   methods. Anything else delegates untouched.
2. Pre-filter: sha256 of USER.md, MEMORY.md (`MemoryStore._path_for`, :210-212) and, with
   `AV_PROMPT_REFRESH_FILES=all`, AGENTS.md in the context cwd (`resolve_context_cwd`, gateway `terminal.cwd = $HERMES_HOME`). Equal to the digests
   verified for this session id (in-process, LRU 512) -> delegate untouched. A session first seen in
   this process (a restart, an rc roll) always gets step 3.
3. Exact test, in Hermes's restore slot (`restore_or_build_system_prompt`, called at
   `agent/turn_context.py:1085-1087` only when `_cached_system_prompt` is None): a cached gateway
   agent's prompt is set aside so the slot runs and is put back as is; a fresh agent gets Hermes's
   own restore first. Then the current blocks are rendered from disk the way Hermes renders them: a
   throwaway `MemoryStore` with the agent's limits (same `[BLOCKED: ...]` placeholders, same usage
   header) and, with `all`, `system_prompt._context_files_part` (AGENTS.md) and
   `system_prompt._skills_prompt` (the skills index, the in-process cache Hermes itself builds through). Stale iff a current block is
   not in the session's prompt, or a memory block emptied on disk is still in it.
4. Refresh on stale, exactly the Bot Chat sequence (:716-727) with compaction's reload in front
   (`agent/conversation_compression.py:3138-3171`): `_invalidate_system_prompt()` (reloads memory,
   `agent/system_prompt.py:802-820`), `_build_system_prompt(system_message)`,
   `stage_surface_switch_note`, `_persist_system_prompt`. The conversation, the tools[] pin (already
   restored, `_restore_pinned_tools`) and `on_session_start` (not re-fired) are untouched. Unlike Bot
   Chat it does not clear the skills index cache (or its disk snapshot): step 3 rendered the index
   through that same cache, so the rebuild carries what the test saw. One INFO line:
   `av-events: prompt_refresh reason=<user_md|memory_md|agents_md|skills> session=<sha8>`. A persist
   that did not land (read back from the row) is not recorded, so the next turn checks again.

The agent's own memory writes do not refresh (Hermes keeps them out of the frozen prompt on purpose,
they are in the transcript): `with_memory_write_ack` chains onto `post_tool_call` and, after a
`memory` tool call, re-records that session's USER.md / MEMORY.md digests. A later external write
changes them again and the refresh then carries both.

Switch: `AV_PROMPT_REFRESH` = `team` (default; also unset, blank or unknown): on only where
`AV_TEAM_TENANT` is exactly `1` (the control plane writes it per tenant into `$HERMES_HOME/.env`,
control-plane/src/team-tenant-env.js) | `1` (on|true|yes) everywhere | `0` (off|false|no). Plus
`prompt_refresh` in `AV_HOOKS_DISABLED`, which wins. Sub-switch `AV_PROMPT_REFRESH_FILES` = `memory`
(default; also unset or unknown: only USER.md and MEMORY.md trigger) | `all` (AGENTS.md and the
skills index trigger too; steps 2 and 3 above). A refresh always rebuilds the whole prompt, so a
memory-triggered one also carries a newer AGENTS.md. Read every turn (`_core.env`, process env then
`.env`), so no restart is needed.

Fail-open: any exception in the gate, the check or the rebuild leaves the turn as today (the stored
bytes go back into `_cached_system_prompt`) with one WARNING naming the exception class only. A
missing seam (renamed in a later Hermes) is one INFO line at install and nothing else. Never inside
the tool loop: every API call of the turn uses the prompt fixed here, and messages are not touched.
Standard library only; no content is ever logged.
"""

from __future__ import annotations

import hashlib
import importlib
import inspect
import logging
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from ._core import env

logger = logging.getLogger("av-events")

#: Its name in `AV_HOOKS_DISABLED`.
SWITCH = "prompt_refresh"
#: The rollout switch and the control plane's team marker.
MODE_VAR = "AV_PROMPT_REFRESH"
TEAM_VAR = "AV_TEAM_TENANT"
#: Which files trigger: `memory` (default: USER.md, MEMORY.md) or `all` (also AGENTS.md and skills).
FILES_VAR = "AV_PROMPT_REFRESH_FILES"
ON_VALUES = frozenset({"1", "true", "yes", "on"})
OFF_VALUES = frozenset({"0", "false", "no", "off"})

#: Sessions whose verified digests are remembered (a gateway holds far fewer open sessions).
MAX_SESSIONS = 512
#: The files the pre-filter hashes, by the reason name the log line uses.
FILE_SOURCES = ("user_md", "memory_md", "agents_md")
MEMORY_SOURCES = ("user_md", "memory_md")
#: Hermes's names: the module whose global the turn loop calls, and the seams the refresh uses.
LOOP_MODULE = "agent.conversation_loop"
WRAPPED_NAME = "build_turn_context"
REQUIRED_PARAMS = ("agent", "system_message", "conversation_history", "restore_or_build_system_prompt")

_MARK = "_av_prompt_refresh"
#: This module's identity on the wrapper it installs (a reload re-wraps the original, not the wrapper).
_TOKEN = object()
_SEEN: "OrderedDict[str, Dict[str, str]]" = OrderedDict()
_LOCK = threading.Lock()
_PERSIST_FAILED = (
    "av-events prompt_refresh: Session DB update_system_prompt failed (session=%s): %s. "
    "The refresh re-fires next turn."
)


# ---- switch --------------------------------------------------------------------------------------


def mode() -> str:
    """`off`, `on` or `team` from `AV_PROMPT_REFRESH` (unset, blank or unknown: `team`)."""
    value = env(MODE_VAR).strip().lower()
    if value in OFF_VALUES:
        return "off"
    if value in ON_VALUES:
        return "on"
    return "team"


def disabled_by_hooks(collector: Any) -> bool:
    """`prompt_refresh` in `AV_HOOKS_DISABLED`: the collector's parse when there is one, else the env's."""
    hooks = None
    if collector is not None:
        hooks = getattr(getattr(collector, "config", None), "disabled_hooks", None)
    if hooks is None:
        hooks = frozenset(part.strip().lower() for part in env("AV_HOOKS_DISABLED").split(",") if part.strip())
    return SWITCH in hooks


def files_mode() -> str:
    """`all` when `AV_PROMPT_REFRESH_FILES` says so, else `memory` (unset, blank or unknown)."""
    return "all" if env(FILES_VAR).strip().lower() == "all" else "memory"


def enabled(collector: Any = None) -> bool:
    if disabled_by_hooks(collector):
        return False
    current = mode()
    if current == "team":
        return env(TEAM_VAR).strip() == "1"
    return current == "on"


# ---- digests -------------------------------------------------------------------------------------


def _digest(path: Optional[Path]) -> str:
    """sha256 of the file's bytes; `-` when absent, `?` when unreadable."""
    if path is None:
        return "-"
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except FileNotFoundError:
        return "-"
    except OSError:
        return "?"


def _memory_store_class(agent: Any = None) -> Any:
    store = getattr(agent, "_memory_store", None) if agent is not None else None
    if store is not None:
        return type(store)
    return importlib.import_module("tools.memory_tool_store").MemoryStore


def _agents_md_path() -> Path:
    cwd = importlib.import_module("agent.runtime_cwd").resolve_context_cwd()
    return Path(cwd if cwd is not None else os.getcwd()) / "AGENTS.md"


def memory_digests(agent: Any = None) -> Dict[str, str]:
    store_cls = _memory_store_class(agent)
    return {"user_md": _digest(store_cls._path_for("user")), "memory_md": _digest(store_cls._path_for("memory"))}


def file_digests(agent: Any) -> Dict[str, str]:
    digests = memory_digests(agent)
    if files_mode() == "all":
        digests["agents_md"] = _digest(_agents_md_path())
    return digests


def _recorded(session_id: str) -> Optional[Dict[str, str]]:
    with _LOCK:
        found = _SEEN.get(session_id)
        if found is not None:
            _SEEN.move_to_end(session_id)
        return dict(found) if found is not None else None


def _record(session_id: str, digests: Dict[str, str]) -> None:
    with _LOCK:
        _SEEN[session_id] = dict(digests)
        _SEEN.move_to_end(session_id)
        while len(_SEEN) > MAX_SESSIONS:
            _SEEN.popitem(last=False)


def _session_tag(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8", "replace")).hexdigest()[:8]


def _warn(what: str, exc: BaseException) -> None:
    try:
        logger.warning("av-events: prompt_refresh %s failed (%s); left as is", what, type(exc).__name__)
    except BaseException:  # noqa: BLE001 - a log line must not cost the turn
        pass


# ---- the exact staleness test --------------------------------------------------------------------


def _memory_header(target: str) -> Optional[str]:
    """How a non-empty memory block starts (`MemoryStore._render_block`), or None when unknown."""
    try:
        headers = importlib.import_module("tools.memory_tool_store").MEMORY_BLOCK_HEADERS
        return f"{'═' * 46}\n{headers['user' if target == 'user' else 'memory']} ["
    except Exception:  # noqa: BLE001 - only the emptied-block check is lost
        return None


def _memory_reasons(agent: Any, prompt: str) -> list:
    store = getattr(agent, "_memory_store", None)
    if store is None:
        return []
    fresh = type(store)(
        memory_char_limit=store.memory_char_limit, user_char_limit=store.user_char_limit,
        memory_enabled=getattr(store, "memory_enabled", True),
        user_profile_enabled=getattr(store, "user_profile_enabled", True),
    )
    fresh.load_from_disk()
    reasons = []
    for target, flag, reason in (("user", "_user_profile_enabled", "user_md"), ("memory", "_memory_enabled", "memory_md")):
        if not getattr(agent, flag, False):
            continue
        block = (fresh.format_for_system_prompt(target) or "").strip()
        if block:
            if block not in prompt:
                reasons.append(reason)
        else:
            header = _memory_header(target)
            if header and header in prompt:
                reasons.append(reason)
    return reasons


def _context_length(agent: Any) -> Optional[int]:
    length = getattr(getattr(agent, "context_compressor", None), "context_length", None)
    return length if isinstance(length, int) and not isinstance(length, bool) and length > 0 else None


def _render_quietly(render: Callable[[], Any]) -> Any:
    """Run a context-file render without leaving its truncation warnings for the next real build
    (`prompt_builder._truncation_warnings`, drained and shown in chat by `build_system_prompt`)."""
    try:
        queue = importlib.import_module("agent.prompt_builder")._truncation_warnings.get()
    except Exception:  # noqa: BLE001
        queue = None
    before = len(queue) if isinstance(queue, list) else None
    try:
        return render()
    finally:
        try:
            after = importlib.import_module("agent.prompt_builder")._truncation_warnings.get()
            if isinstance(after, list):
                del after[(before if after is queue and before is not None else 0):]
        except Exception:  # noqa: BLE001
            pass


def _context_reasons(agent: Any, prompt: str) -> list:
    sp = importlib.import_module("agent.system_prompt")
    reasons = []
    length = _context_length(agent)

    def context_parts() -> list:
        _identity, soul_loaded = sp._identity_parts(agent, length)
        return list(sp._context_files_part(agent, length, soul_loaded))

    for part in _render_quietly(context_parts):
        text = part.strip() if isinstance(part, str) else ""
        if text and text not in prompt:
            reasons.append("agents_md")
            break
    skills = sp._skills_prompt(agent)
    text = skills.strip() if isinstance(skills, str) else ""
    if text and text not in prompt:
        reasons.append("skills")
    return reasons


def stale_reasons(agent: Any, prompt: str) -> list:
    """Which of USER.md, MEMORY.md (and with `AV_PROMPT_REFRESH_FILES=all`, AGENTS.md and the skills
    index) the prompt is behind on."""
    reasons = _memory_reasons(agent, prompt)
    if files_mode() == "all":
        reasons += _context_reasons(agent, prompt)
    return reasons


# ---- the refresh ---------------------------------------------------------------------------------


def _put_back(agent: Any, prompt: str, system_message: Any) -> None:
    """Today's state: the stored bytes, their plugin sections and the static prefix for caching."""
    agent._cached_system_prompt = prompt
    try:
        sp = importlib.import_module("agent.system_prompt")
        sp.restore_plugin_prompt_sections(agent, prompt)
        sp.reconstruct_static_prefix(agent, system_message=system_message)
    except Exception:  # noqa: BLE001 - the prompt itself is back; caching falls back as Hermes would
        pass


def refresh(agent: Any, loop: Any, system_message: Any, history: Any) -> bool:
    """The Bot Chat branch (conversation_loop.py:716-727), memory reloaded first. True when persisted."""
    agent._invalidate_system_prompt()
    rebuilt = agent._build_system_prompt(system_message)
    if not isinstance(rebuilt, str) or not rebuilt.strip():
        raise ValueError("empty rebuild")
    agent._cached_system_prompt = rebuilt
    loop.stage_surface_switch_note(agent, rebuilt, history)
    loop._persist_system_prompt(agent, _PERSIST_FAILED)
    try:
        row = agent._session_db.get_session(agent.session_id)
        return bool(row) and row.get("system_prompt") == rebuilt
    except Exception:  # noqa: BLE001 - unknown: check again next turn
        return False


def check_and_refresh(agent: Any, loop: Any, system_message: Any, history: Any, digests: Dict[str, str]) -> None:
    prompt = getattr(agent, "_cached_system_prompt", None)
    session_id = getattr(agent, "session_id", None)
    if not isinstance(prompt, str) or not prompt or not isinstance(session_id, str) or not session_id:
        return
    try:
        reasons = stale_reasons(agent, prompt)
    except BaseException as exc:  # noqa: BLE001 - no verdict: today's prompt, no retry until a file changes
        if isinstance(exc, SystemExit):
            raise
        _warn("check", exc)
        _record(session_id, digests)
        return
    if not reasons:
        _record(session_id, digests)
        return
    try:
        persisted = refresh(agent, loop, system_message, history)
    except BaseException as exc:  # noqa: BLE001
        if isinstance(exc, SystemExit):
            raise
        _put_back(agent, prompt, system_message)
        _warn("rebuild", exc)
        _record(session_id, digests)
        return
    if persisted:
        _record(session_id, digests)
    try:
        logger.info("av-events: prompt_refresh reason=%s session=%s", ",".join(reasons), _session_tag(session_id))
    except BaseException:  # noqa: BLE001
        pass


# ---- the wrapper ---------------------------------------------------------------------------------


def _int_attr(agent: Any, name: str) -> int:
    value = getattr(agent, name, 0)
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _turn_agent(bound: Any) -> Optional[Any]:
    """The agent when this is a resident session's turn (the gate, step 1), else None: not a review or
    side-question fork, not a subagent, not cron, with a session DB and the two rebuild methods."""
    args = bound.arguments
    agent = args.get("agent")
    if agent is None:
        return None
    if getattr(agent, "_persist_disabled", False) or getattr(agent, "_turn_origin", None):
        return None
    if _int_attr(agent, "_delegate_depth") > 0:
        return None
    session_id = getattr(agent, "session_id", None)
    if not isinstance(session_id, str) or not session_id or session_id.startswith("cron_"):
        return None
    if str(getattr(agent, "platform", "") or "").strip().lower() == "cron":
        return None
    if not getattr(agent, "_session_db", None) or not callable(args.get("restore_or_build_system_prompt")):
        return None
    if not callable(getattr(agent, "_invalidate_system_prompt", None)) or not callable(getattr(agent, "_build_system_prompt", None)):
        return None
    return agent


def _wrap(original: Callable, signature: inspect.Signature, loop: Any, collector_ref: Callable[[], Any]) -> Callable:
    def _plan(args: tuple, kwargs: dict) -> Optional[tuple]:
        """(bound arguments, agent, digests) when this turn needs the exact test, else None."""
        if not enabled(collector_ref()):
            return None
        bound = signature.bind(*args, **kwargs)
        agent = _turn_agent(bound)
        if agent is None:
            return None
        digests = file_digests(agent)
        if not bound.arguments.get("conversation_history"):
            # A session's first turn: Hermes builds the prompt from these files in a moment. Record
            # them, so an own memory write in this turn is acknowledged rather than refreshed next turn.
            if getattr(agent, "_cached_system_prompt", None) is None:
                _record(agent.session_id, digests)
            return None
        if _recorded(agent.session_id) == digests:
            return None
        return bound, agent, digests

    def build_turn_context(*args: Any, **kwargs: Any) -> Any:
        try:
            plan = _plan(args, kwargs)
        except BaseException as exc:  # noqa: BLE001 - the gate never costs the turn
            if isinstance(exc, SystemExit):
                raise
            _warn("gate", exc)
            plan = None
        if plan is None:
            return original(*args, **kwargs)

        bound, agent, digests = plan
        hermes_restore = bound.arguments["restore_or_build_system_prompt"]
        cached = getattr(agent, "_cached_system_prompt", None)
        held = cached if isinstance(cached, str) and cached else None
        held_session = agent.session_id
        state = {"ran": False}

        def restore_or_build_system_prompt(agent_: Any, system_message: Any, conversation_history: Any) -> None:
            state["ran"] = True
            if held is not None and agent_ is agent and agent_.session_id == held_session:
                agent_._cached_system_prompt = held  # a cached agent: exactly the bytes it had
            else:
                hermes_restore(agent_, system_message, conversation_history)
            check_and_refresh(agent_, loop, system_message, conversation_history, digests)

        if held is not None:
            agent._cached_system_prompt = None  # so build_turn_context calls the restore slot (:1085)
        bound.arguments["restore_or_build_system_prompt"] = restore_or_build_system_prompt
        try:
            return original(*bound.args, **bound.kwargs)
        finally:
            if held is not None and not state["ran"] and getattr(agent, "_cached_system_prompt", None) is None \
                    and getattr(agent, "session_id", None) == held_session:
                agent._cached_system_prompt = held

    setattr(build_turn_context, _MARK, _TOKEN)
    build_turn_context.__wrapped__ = original  # type: ignore[attr-defined]
    return build_turn_context


def install(collector_ref: Callable[[], Any]) -> bool:
    """Wrap `agent.conversation_loop.build_turn_context`. False (one log line, nothing touched) when
    Hermes is not importable or a seam is missing or reshaped. Idempotent; a reloaded av-events
    re-wraps the original rather than its predecessor's wrapper."""
    try:
        loop = importlib.import_module(LOOP_MODULE)
    except Exception:  # noqa: BLE001 - not under Hermes, or a broken import: today's behaviour
        logger.info("av-events: prompt_refresh: %s not importable; left as is", LOOP_MODULE)
        return False
    current = getattr(loop, WRAPPED_NAME, None)
    if getattr(current, _MARK, None) is _TOKEN:
        return True
    original = getattr(current, "__wrapped__", None) if getattr(current, _MARK, None) is not None else current
    try:
        signature = inspect.signature(original) if callable(original) else None
    except (TypeError, ValueError):
        signature = None
    seams = callable(getattr(loop, "_persist_system_prompt", None)) and callable(getattr(loop, "stage_surface_switch_note", None))
    if signature is None or not seams or any(name not in signature.parameters for name in REQUIRED_PARAMS):
        logger.info(
            "av-events: prompt_refresh: %s has no %s(%s) / _persist_system_prompt / stage_surface_switch_note; left as is",
            LOOP_MODULE, WRAPPED_NAME, ", ".join(REQUIRED_PARAMS),
        )
        return False
    setattr(loop, WRAPPED_NAME, _wrap(original, signature, loop, collector_ref))
    logger.info("av-events: prompt_refresh: %s.%s wrapped (mode %s)", LOOP_MODULE, WRAPPED_NAME, mode())
    return True


def uninstall() -> None:
    """Put Hermes's own function back (plugin unload). Only ever removes this module's wrapper."""
    try:
        loop = importlib.import_module(LOOP_MODULE)
        current = getattr(loop, WRAPPED_NAME, None)
        if getattr(current, _MARK, None) is _TOKEN:
            setattr(loop, WRAPPED_NAME, current.__wrapped__)
    except Exception:  # noqa: BLE001 - an unload never fails on us
        pass


# ---- the agent's own memory writes ---------------------------------------------------------------


def acknowledge_memory_write(kwargs: Dict[str, Any]) -> bool:
    """After the agent's own `memory` call, re-record that session's USER.md / MEMORY.md digests so
    the write does not refresh. Only a session already verified in this process; AGENTS.md's digest
    is kept, so an external change to it still refreshes."""
    if kwargs.get("tool_name") != "memory":
        return False
    session_id = kwargs.get("session_id")
    if type(session_id) is not str or not session_id:
        return False
    recorded = _recorded(session_id)
    if recorded is None:
        return False
    recorded.update(memory_digests())
    _record(session_id, recorded)
    return True


def with_memory_write_ack(telemetry: Callable) -> Callable:
    """`post_tool_call` = the telemetry body (`guarded`), then the acknowledgement. Outside the
    telemetry guard (works with telemetry off); never raises."""

    def post_tool_call(*args: Any, **kwargs: Any) -> Any:
        result = telemetry(*args, **kwargs)
        try:
            acknowledge_memory_write(kwargs)
        except BaseException as exc:  # noqa: BLE001 - an acknowledgement never costs the tool call
            if isinstance(exc, SystemExit):
                raise
            _warn("memory ack", exc)
        return result

    post_tool_call.av_hook_name = getattr(telemetry, "av_hook_name", "post_tool_call")  # type: ignore[attr-defined]
    return post_tool_call


def reset() -> None:
    """Forget every verified session (tests)."""
    with _LOCK:
        _SEEN.clear()


__all__ = [
    "MAX_SESSIONS",
    "MODE_VAR",
    "SWITCH",
    "FILES_VAR",
    "TEAM_VAR",
    "acknowledge_memory_write",
    "check_and_refresh",
    "enabled",
    "file_digests",
    "files_mode",
    "install",
    "mode",
    "refresh",
    "reset",
    "stale_reasons",
    "uninstall",
    "with_memory_write_ack",
]
