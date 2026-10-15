"""F1 PROMPT REFRESH: a long session's system prompt catches up with USER.md, MEMORY.md and AGENTS.md
(and the skills index, see `all` below), once per change, at the start of a turn.

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
   methods. Anything else delegates untouched. A gate exception logs one WARNING per process, then
   DEBUG (it would otherwise repeat every turn).
2. Pre-filter: sha256 of USER.md, MEMORY.md (`MemoryStore._path_for`, :210-212) and, with
   `AV_PROMPT_REFRESH_FILES=all`, AGENTS.md in the context cwd (`resolve_context_cwd`, gateway `terminal.cwd = $HERMES_HOME`). Equal to the digests
   verified for this session id (in-process, LRU 512) -> delegate untouched. A session first seen in
   this process (a restart, an rc roll), or one whose last refresh did not reach the row, always
   gets step 3.
3. Exact test, in Hermes's restore slot (`restore_or_build_system_prompt`, called at
   `agent/turn_context.py:1085-1087` only when `_cached_system_prompt` is None): a cached gateway
   agent's prompt is set aside so the slot runs and is put back as is; a fresh agent gets Hermes's
   own restore first. Then the current blocks are rendered from disk the way Hermes renders them: a
   throwaway `MemoryStore` with the agent's limits (same `[BLOCKED: ...]` placeholders, same usage
   header) and, with `all`, `system_prompt._context_files_part` (AGENTS.md) and
   `system_prompt._skills_prompt` (the skills index, the in-process cache Hermes itself builds through). Stale iff a current block is
   not in the session's prompt, or a memory block emptied on disk is still in it. The skills index is
   not hashed: a skills change alone is seen at a session's first turn in a process (a restart, an
   rc roll) or with the next change to a hashed file. No verdict when an enabled memory file or the
   cwd's AGENTS.md exists but cannot be read strictly (Hermes would render it empty): the prompt is
   kept, nothing is recorded or refreshed, and one WARNING per process names the file kind.
4. Refresh on stale, exactly the Bot Chat sequence (:716-727) with compaction's reload in front
   (`agent/conversation_compression.py:3138-3171`): `_invalidate_system_prompt()` (reloads memory,
   `agent/system_prompt.py:802-820`), `_build_system_prompt(system_message)`,
   `stage_surface_switch_note`, `_persist_system_prompt`. The conversation, the tools[] pin (already
   restored, `_restore_pinned_tools`) and `on_session_start` (not re-fired) are untouched. Unlike Bot
   Chat it does not clear the skills index cache (or its disk snapshot): step 3 rendered the index
   through that same cache, so the rebuild carries what the test saw. One INFO line:
   `av-events: prompt_refresh reason=<user_md|memory_md|agents_md|skills> session=<sha8>`. A persist
   that did not land (read back from the row) marks the session unpersisted: it is not recorded,
   it skips the pre-filter, and a later turn whose check finds nothing stale (the cached agent
   already holds the rebuilt prompt) writes the prompt to the row again and reads it back. Only a
   match clears the mark and records the session.

The agent's own memory writes do not refresh (Hermes keeps them out of the frozen prompt on purpose,
they are in the transcript): `with_memory_write_ack` chains onto `post_tool_call` and, after a
`memory` tool call, re-records the digest of the one file the call wrote (`args.target`: `memory`,
the default, is MEMORY.md; `user` is USER.md; anything else, or a batch op naming another target,
acknowledges nothing). Only a call whose result says it wrote (`success: true`, not staged for
approval; a failed or staged call acknowledges nothing). Only when the change on disk is explained by the call's own arguments: the
file's entries are compared with the entries verified for this session, and every added entry must
be a `content` / `new_text` of the call, every removed one must be selected by an `old_text`, and
the kept entries must keep their order. Anything else (an external USER.md write landing in the same
turn, or in a background review fork, which shares the parent's session id) is not acknowledged, so
the next turn's exact test refreshes and carries both. The other file's digest is never touched.

Switch: `AV_PROMPT_REFRESH` = `team` (default; also unset or blank): on only where
`AV_TEAM_TENANT` is exactly `1` (the control plane writes it per tenant into `$HERMES_HOME/.env`,
control-plane/src/team-tenant-env.js) | `1` (on|true|yes) everywhere | `0` (off|false|no). Any other
value is off, with one WARNING per process (a mistyped off must not leave it on). Plus
`prompt_refresh` in `AV_HOOKS_DISABLED`, which wins. Sub-switch `AV_PROMPT_REFRESH_FILES` = `memory`
(default; also unset or unknown: only USER.md and MEMORY.md trigger) | `all` (AGENTS.md triggers
too, and the exact test also compares the skills index, which is not hashed: a skills change alone
is caught at a session's first turn in a process or with the next hashed change; steps 2 and 3). A refresh always rebuilds the whole prompt, so a
memory-triggered one also carries a newer AGENTS.md. Read every turn (`_core.env`, process env then
`.env`), so no restart is needed.

D3 / D7: with the `village-memory` memory provider active (`agent._memory_manager` holds a provider of
that name), the cp's `knowledge/agentvillage/_profile.md` is hashed in
the pre-filter too, in both files modes, through the provider's own safe reader
(`profile_digest()`: no plain open, so a FIFO, symlink, directory or oversized file never blocks a
turn; `?<reason>` for a file it refuses). The exact test renders the provider block the way Hermes
does (`MemoryManager.build_system_prompt`, behind the same `memory_provider_tools_exposed` gate as
`agent/system_prompt.py:515-540`): stale iff that block is not in the session's prompt, or it is
empty now while the prompt still holds its marker lines (the cp removed the file). Reason
`profile_md`. A profile the provider cannot read is an empty block, never "no verdict": it never
holds back a USER.md / MEMORY.md change (a vote note). The refresh is the same rebuild + persist, so
the provider block and the built-in snapshot move together.

Fail-open: any exception in the gate, the check or the rebuild leaves the turn as today (the stored
bytes go back into `_cached_system_prompt`) naming the exception class only. A failed check or
rebuild is tried again for the same change at the next turn, up to 3 turns (DEBUG), then given up
with one WARNING; `KeyboardInterrupt` and `SystemExit` are never swallowed. A
missing seam (renamed in a later Hermes) is one INFO line at install and nothing else: `install()`
checks the loop's seams, `MemoryStore._path_for`, `MEMORY_BLOCK_HEADERS`, the two put-back helpers
in `agent.system_prompt` and, when `AV_PROMPT_REFRESH_FILES=all` at install, `resolve_context_cwd`
and the three context renderers. Never inside
the tool loop: every API call of the turn uses the prompt fixed here, and messages are not touched.
Standard library only; no content is ever logged.
"""

from __future__ import annotations

import hashlib
import importlib
import inspect
import json
import logging
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

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
#: Parsed entry lists kept by file digest (the files the sessions were verified against; few per box).
MAX_ENTRY_LISTS = 64
#: Hermes's entry delimiter (`tools/memory_tool_store.py:23`); a different one only makes acks fail.
ENTRY_DELIMITER = "\n§\n"
#: The memory tool's `target` -> the digest key of the file it writes (`MemoryStore._path_for`).
TARGET_FILES = {"memory": "memory_md", "user": "user_md"}
#: The files the pre-filter hashes, by the reason name the log line uses.
FILE_SOURCES = ("user_md", "memory_md", "agents_md", "profile_md")
#: D3's memory provider, and the two lines its block starts with (plugins/village-memory: SEPARATOR,
#: BLOCK_TITLE). A prompt holding them while the provider renders nothing still shows a removed profile.
PROFILE_PROVIDER = "village-memory"
PROFILE_BLOCK_MARK = "═" * 46 + "\nRESIDENT PROFILE (village-memory: knowledge/agentvillage/_profile.md)"
MEMORY_SOURCES = ("user_md", "memory_md")
#: Hermes's names: the module whose global the turn loop calls, and the seams the refresh uses.
LOOP_MODULE = "agent.conversation_loop"
WRAPPED_NAME = "build_turn_context"
REQUIRED_PARAMS = ("agent", "system_message", "conversation_history", "restore_or_build_system_prompt")

_MARK = "_av_prompt_refresh"
#: This module's identity on the wrapper it installs (a reload re-wraps the original, not the wrapper).
_TOKEN = object()
_SEEN: "OrderedDict[str, Dict[str, str]]" = OrderedDict()
#: Entries of a memory file by its sha256 (the "verified entry list" an acknowledgement diffs against).
_ENTRIES: "OrderedDict[str, Tuple[str, ...]]" = OrderedDict()
#: Sessions whose rebuilt prompt did not reach the row: re-persisted and read back before recording.
_UNPERSISTED: "OrderedDict[str, None]" = OrderedDict()
_LOCK = threading.Lock()
#: One WARNING per process for each repeating failure, then DEBUG.
_LATCHED: set = set()
#: Turns a failed check or rebuild of one change is tried on before it is given up (recorded).
RETRY_TURNS = 3
#: Per session: (the digests of the change that failed, how many turns it has failed on).
_FAILURES: "OrderedDict[str, Tuple[Tuple[Tuple[str, str], ...], int]]" = OrderedDict()
#: Never swallowed (an operator's Ctrl-C in the CLI, an interpreter exit).
_INTERRUPTS = (SystemExit, KeyboardInterrupt)
#: Hermes's `failure_message` for `_persist_system_prompt` (it adds the session id and the error).
_PERSIST_FAILED = (
    "av-events prompt_refresh: Session DB update_system_prompt failed (session=%s): %s. "
    "The session is checked again next turn and the prompt written to the row again."
)


# ---- switch --------------------------------------------------------------------------------------


def mode() -> str:
    """`off`, `on` or `team` from `AV_PROMPT_REFRESH`. Unset or blank: `team`. Any other unknown value:
    `off` with one WARNING per process (the other av-events switches read unknown as off too)."""
    value = env(MODE_VAR).strip().lower()
    if not value or value == "team":
        return "team"
    if value in OFF_VALUES:
        return "off"
    if value in ON_VALUES:
        return "on"
    _latched_log("mode", "av-events: prompt_refresh: %s has an unknown value; off (use team, 1 or 0)", MODE_VAR)
    return "off"


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


def _parse_entries(raw: bytes) -> Optional[Tuple[str, ...]]:
    """A memory file's entries the way Hermes reads them (`_read_raw_checked` + `_parse_entries` +
    the load's dedup): utf-8-sig, strict; None when undecodable."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    return tuple(dict.fromkeys(e for e in (part.strip() for part in text.split(ENTRY_DELIMITER)) if e))


def _keep_entries(digest: str, raw: bytes) -> None:
    with _LOCK:
        if digest in _ENTRIES:
            _ENTRIES.move_to_end(digest)
            return
    entries = _parse_entries(raw)
    if entries is None:
        return
    with _LOCK:
        _ENTRIES[digest] = entries
        while len(_ENTRIES) > MAX_ENTRY_LISTS:
            _ENTRIES.popitem(last=False)


def _entries_for(digest: Optional[str]) -> Optional[Tuple[str, ...]]:
    """The entries of the file with this digest (`-`: absent, so none); None when unknown."""
    if digest == "-":
        return ()
    with _LOCK:
        return _ENTRIES.get(digest) if digest else None


def _digest(path: Optional[Path], *, entries: bool = False) -> str:
    """sha256 of the file's bytes; `-` when absent, `?` when unreadable. With `entries`, the file's
    parsed entries are kept by that digest (parsed only for a digest not seen before)."""
    if path is None:
        return "-"
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return "-"
    except OSError:
        return "?"
    digest = hashlib.sha256(raw).hexdigest()
    if entries:
        _keep_entries(digest, raw)
    return digest


def _memory_store_class(agent: Any = None) -> Any:
    store = getattr(agent, "_memory_store", None) if agent is not None else None
    if store is not None:
        return type(store)
    return importlib.import_module("tools.memory_tool_store").MemoryStore


def _agents_md_path(agent: Any = None) -> Path:
    """The cwd's AGENTS.md as `system_prompt._context_files_part` picks the cwd (`None` for a launch
    artifact, so the launch dir). Hermes's git-root chain and `AGENTS.override.md` are not followed."""
    launch_artifact = getattr(agent, "_context_cwd_is_launch_artifact", False) if agent is not None else False
    cwd = None if launch_artifact else importlib.import_module("agent.runtime_cwd").resolve_context_cwd()
    return Path(cwd if cwd is not None else os.getcwd()) / "AGENTS.md"


def memory_digests(agent: Any = None) -> Dict[str, str]:
    store_cls = _memory_store_class(agent)
    return {
        "user_md": _digest(store_cls._path_for("user"), entries=True),
        "memory_md": _digest(store_cls._path_for("memory"), entries=True),
    }


def _profile_provider(agent: Any) -> Any:
    """The agent's `village-memory` provider (D3), or None."""
    manager = getattr(agent, "_memory_manager", None) if agent is not None else None
    if manager is None:
        return None
    try:
        providers = list(getattr(manager, "providers", None) or [])
    except Exception:  # noqa: BLE001
        return None
    for provider in providers:
        if getattr(provider, "name", None) == PROFILE_PROVIDER and callable(getattr(provider, "profile_digest", None)):
            return provider
    return None


def file_digests(agent: Any) -> Dict[str, str]:
    digests = memory_digests(agent)
    if files_mode() == "all":
        digests["agents_md"] = _digest(_agents_md_path(agent))
    provider = _profile_provider(agent)
    if provider is not None:
        digests["profile_md"] = str(provider.profile_digest())
    return digests


def _recorded(session_id: str) -> Optional[Dict[str, str]]:
    with _LOCK:
        found = _SEEN.get(session_id)
        if found is not None:
            _SEEN.move_to_end(session_id)
        return dict(found) if found is not None else None


def _record(session_id: str, digests: Dict[str, str]) -> None:
    with _LOCK:
        _FAILURES.pop(session_id, None)
        _SEEN[session_id] = dict(digests)
        _SEEN.move_to_end(session_id)
        while len(_SEEN) > MAX_SESSIONS:
            _SEEN.popitem(last=False)


def _acknowledge(session_id: str, key: str, verified: str, current: str) -> bool:
    """Move one file's recorded digest from `verified` to `current`, unless it changed meanwhile."""
    with _LOCK:
        found = _SEEN.get(session_id)
        if found is None or found.get(key) != verified:
            return False
        found[key] = current
        _SEEN.move_to_end(session_id)
        return True


def _unpersisted(session_id: str) -> bool:
    with _LOCK:
        return session_id in _UNPERSISTED


def _mark_unpersisted(session_id: str, marked: bool) -> None:
    with _LOCK:
        if not marked:
            _UNPERSISTED.pop(session_id, None)
            return
        _UNPERSISTED[session_id] = None
        _UNPERSISTED.move_to_end(session_id)
        while len(_UNPERSISTED) > MAX_SESSIONS:
            _UNPERSISTED.popitem(last=False)


def _session_tag(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8", "replace")).hexdigest()[:8]


def _latched_log(key: str, message: str, *args: Any) -> None:
    """WARNING the first time `key` fires in this process, DEBUG after that."""
    with _LOCK:
        level = logging.DEBUG if key in _LATCHED else logging.WARNING
        _LATCHED.add(key)
    try:
        logger.log(level, message, *args)
    except BaseException:  # noqa: BLE001 - a log line must not cost the turn
        pass


def _warn(what: str, exc: BaseException, *, once: bool = False) -> None:
    """One WARNING naming the exception class only. `once`: per process, then DEBUG (the gate runs
    every turn and records nothing, so a seam renamed after install would repeat it)."""
    message = "av-events: prompt_refresh %s failed (%s); left as is"
    if once:
        _latched_log(what, message, what, type(exc).__name__)
        return
    try:
        logger.warning(message, what, type(exc).__name__)
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


def _provider_reasons(agent: Any, prompt: str) -> list:
    """D3: the memory provider's block as Hermes would render it now, against the session's prompt."""
    if _profile_provider(agent) is None:
        return []
    try:
        exposed = importlib.import_module("agent.memory_manager").memory_provider_tools_exposed
    except Exception:  # noqa: BLE001 - an older Hermes: ungated, as system_prompt._memory_parts falls back
        exposed = None
    if exposed is not None and not exposed(agent):
        return []
    block = agent._memory_manager.build_system_prompt()
    text = block.strip() if isinstance(block, str) else ""
    if text:
        return [] if text in prompt else ["profile_md"]
    return ["profile_md"] if PROFILE_BLOCK_MARK in prompt else []


class Unreadable(Exception):
    """A file the prompt is built from exists but cannot be read the way Hermes reads it. Hermes
    would render it as empty (`MemoryStore._read_file` and `prompt_builder._read_context_file` return
    nothing on a read or decode error), so neither the exact test nor a rebuild can be trusted."""


def _strictly_readable(path: Optional[Path], encoding: str) -> bool:
    """Absent (a real empty block) or readable and decodable as Hermes decodes it."""
    if path is None:
        return True
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    try:
        raw.decode(encoding)
    except UnicodeDecodeError:
        return False
    return True


def unreadable_sources(agent: Any) -> List[str]:
    """The reason names of the prompt's files that exist but cannot be read strictly: the enabled
    memory files (utf-8-sig, `_read_raw_checked`) and the cwd's AGENTS.md (utf-8, `_read_context_file`).
    AGENTS.md is checked in both files modes, because any refresh rebuilds it. In `memory` mode a
    Hermes without `resolve_context_cwd` skips that check (install only requires it for `all`)."""
    store_cls = _memory_store_class(agent)
    found = []
    for target, flag, reason in (("user", "_user_profile_enabled", "user_md"), ("memory", "_memory_enabled", "memory_md")):
        if getattr(agent, flag, False) and not _strictly_readable(store_cls._path_for(target), "utf-8-sig"):
            found.append(reason)
    try:
        agents_md = _agents_md_path(agent)
    except Exception:  # noqa: BLE001
        if files_mode() == "all":
            raise
        agents_md = None
    if not _strictly_readable(agents_md, "utf-8"):
        found.append("agents_md")
    return found


def stale_reasons(agent: Any, prompt: str) -> list:
    """Which of USER.md, MEMORY.md (and with `AV_PROMPT_REFRESH_FILES=all`, AGENTS.md and the skills
    index) the prompt is behind on. Raises `Unreadable` when a file it is built from cannot be read:
    an undecodable USER.md would otherwise read as emptied, and the refresh would persist a prompt
    without the profile into every live session."""
    unreadable = unreadable_sources(agent)
    if unreadable:
        raise Unreadable(",".join(unreadable))
    reasons = _memory_reasons(agent, prompt) + _provider_reasons(agent, prompt)
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
    return _row_holds(agent, rebuilt)


def _row_holds(agent: Any, prompt: str) -> bool:
    """The session row's stored prompt is exactly `prompt` (read back; unknown counts as no)."""
    try:
        row = agent._session_db.get_session(agent.session_id)
        return bool(row) and row.get("system_prompt") == prompt
    except Exception:  # noqa: BLE001 - unknown: check again next turn
        return False


def persist_again(agent: Any, loop: Any, prompt: str) -> bool:
    """An unpersisted session's prompt is current: write it to the row (unless it is there already)
    and read it back. True when the row now holds it."""
    if _row_holds(agent, prompt):
        return True
    loop._persist_system_prompt(agent, _PERSIST_FAILED)
    return _row_holds(agent, prompt)


def _failed(session_id: str, digests: Dict[str, str], what: str, exc: BaseException, *, once: bool = False) -> None:
    """A check or rebuild that raised. The same change (these digests) is tried again at the next
    turn, up to `RETRY_TURNS` turns, with a DEBUG line each; then it is given up (recorded, so the
    pre-filter skips it until a file changes again) with one WARNING. A transient error therefore
    does not freeze a vote note out of the session, and a persistent one costs a bounded retry."""
    key = tuple(sorted(digests.items()))
    with _LOCK:
        previous = _FAILURES.get(session_id)
        count = previous[1] + 1 if previous is not None and previous[0] == key else 1
        _FAILURES[session_id] = (key, count)
        _FAILURES.move_to_end(session_id)
        while len(_FAILURES) > MAX_SESSIONS:
            _FAILURES.popitem(last=False)
    if count < RETRY_TURNS:
        try:
            logger.debug("av-events: prompt_refresh %s failed (%s); tried again next turn", what, type(exc).__name__)
        except BaseException:  # noqa: BLE001
            pass
        return
    _warn(what, exc, once=once)
    _record(session_id, digests)


def check_and_refresh(agent: Any, loop: Any, system_message: Any, history: Any, digests: Dict[str, str]) -> None:
    prompt = getattr(agent, "_cached_system_prompt", None)
    session_id = getattr(agent, "session_id", None)
    if not isinstance(prompt, str) or not prompt or not isinstance(session_id, str) or not session_id:
        return
    try:
        reasons = stale_reasons(agent, prompt)
    except Unreadable as exc:
        # No verdict: today's prompt, nothing recorded (so the next turn checks again and a fixed
        # file refreshes normally), nothing refreshed. Reason names only, never content.
        _latched_log("unreadable", "av-events: prompt_refresh: %s could not be read strictly; prompt left as is",
                     str(exc))
        return
    except BaseException as exc:  # noqa: BLE001 - no verdict: today's prompt, retried for a few turns
        if isinstance(exc, _INTERRUPTS):
            raise
        # A marked session skips the pre-filter, so a check that keeps raising would WARN every turn.
        _failed(session_id, digests, "check", exc, once=_unpersisted(session_id))
        return
    if not reasons:
        if _unpersisted(session_id):
            # A cached agent kept the rebuilt prompt while its row kept the old bytes (a persist
            # that did not land): the row is what a fresh agent replays after an idle eviction.
            try:
                landed = persist_again(agent, loop, prompt)
            except BaseException as exc:  # noqa: BLE001
                if isinstance(exc, _INTERRUPTS):
                    raise
                _warn("persist", exc)
                landed = False
            if not landed:
                return  # still marked, not recorded: checked again next turn
            _mark_unpersisted(session_id, False)
        _record(session_id, digests)
        return
    try:
        persisted = refresh(agent, loop, system_message, history)
    except BaseException as exc:  # noqa: BLE001
        _put_back(agent, prompt, system_message)
        if isinstance(exc, _INTERRUPTS):
            raise
        _failed(session_id, digests, "rebuild", exc)
        return
    _mark_unpersisted(session_id, not persisted)
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
        if _recorded(agent.session_id) == digests and not _unpersisted(agent.session_id):
            return None
        return bound, agent, digests

    def build_turn_context(*args: Any, **kwargs: Any) -> Any:
        try:
            plan = _plan(args, kwargs)
        except BaseException as exc:  # noqa: BLE001 - the gate never costs the turn
            if isinstance(exc, _INTERRUPTS):
                raise
            _warn("gate", exc, once=True)
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


def _module_or_none(name: str) -> Any:
    try:
        return importlib.import_module(name)
    except Exception:  # noqa: BLE001 - reported as a missing seam
        return None


def missing_seams() -> List[str]:
    """The seams outside the loop module the refresh uses, by name, that this Hermes lacks. With
    `AV_PROMPT_REFRESH_FILES=all` at install, also the AGENTS.md / skills renderers and the cwd."""
    missing = []
    store = _module_or_none("tools.memory_tool_store")
    if not callable(getattr(getattr(store, "MemoryStore", None), "_path_for", None)):
        missing.append("tools.memory_tool_store.MemoryStore._path_for")
    try:
        headers = store.MEMORY_BLOCK_HEADERS  # type: ignore[union-attr]
        ok = all(isinstance(headers[target], str) for target in ("user", "memory"))
    except Exception:  # noqa: BLE001
        ok = False
    if not ok:
        missing.append("tools.memory_tool_store.MEMORY_BLOCK_HEADERS")
    names = ["restore_plugin_prompt_sections", "reconstruct_static_prefix"]
    if files_mode() == "all":
        names += ["_identity_parts", "_context_files_part", "_skills_prompt"]
        if not callable(getattr(_module_or_none("agent.runtime_cwd"), "resolve_context_cwd", None)):
            missing.append("agent.runtime_cwd.resolve_context_cwd")
    system_prompt = _module_or_none("agent.system_prompt")
    missing += [f"agent.system_prompt.{name}" for name in names if not callable(getattr(system_prompt, name, None))]
    return missing


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
    missing = missing_seams()
    if missing:
        logger.info("av-events: prompt_refresh: Hermes has no %s; left as is", ", ".join(missing))
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


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def call_succeeded(kwargs: Dict[str, Any]) -> bool:
    """The call wrote: its result parses to `success: true` and is not staged for approval. Hermes's
    shapes (v2026.9.24): `_success_response` `{"success": true, "done": true, ...}`
    (`tools/memory_tool_store.py:468-481`); errors `{"success": false, "error": ...}` (`_error`, :32) or
    `tool_error` `{"error": ...}`; staged `{"success": true, "staged": true, "pending_id": ...}` from the
    approval gate (`tools/memory_tool.py:99`) or, with `proposal_staged`, from a background review fork's
    replace / remove (:195). A failed or staged call can still name an entry another writer removed,
    so its args must not explain that change. No result, or one that does not parse: False."""
    if kwargs.get("status") not in (None, "ok"):
        return False
    result = kwargs.get("result")
    if isinstance(result, (str, bytes, bytearray)):
        try:
            result = json.loads(result)
        except ValueError:
            return False
    if not isinstance(result, dict) or result.get("success") is not True or "error" in result:
        return False
    return not any(result.get(key) for key in ("staged", "proposal_staged", "pending_id"))


def call_target(args: Any) -> Optional[str]:
    """The file a `memory` call writes: `memory` (also an omitted or null target, as Hermes reads it,
    `tools/memory_tool.py:217, 412`) or `user`. None when unknown, or when a batch op names another."""
    if not isinstance(args, dict):
        return None
    target = args.get("target")
    target = "memory" if target is None else target
    if target not in TARGET_FILES:
        return None
    operations = args.get("operations")
    if operations:
        if not isinstance(operations, list) or not all(isinstance(op, dict) for op in operations):
            return None
        if any(op.get("target", target) != target for op in operations):
            return None  # mixed: Hermes ignores it, but it is not a call this can explain
    return target


def call_changes(args: Dict[str, Any]) -> Optional[Tuple[List[str], List[str]]]:
    """(entries the call may add, old_texts that may select removed entries), read the way Hermes
    applies them (`memory_tool.py:216`, `memory_tool_store.py:427`). None for an unknown action."""
    operations = args.get("operations")
    if operations:
        shaped = [(op.get("action"), _text(op.get("content")) or _text(op.get("new_text")), _text(op.get("old_text")))
                  for op in operations]
    else:
        content = args.get("content")
        shaped = [(args.get("action"), _text(args.get("new_text") if content is None else content), _text(args.get("old_text")))]
    added, selectors = [], []
    for action, content, old_text in shaped:
        if action not in ("add", "replace", "remove"):
            return None
        if action != "remove" and content:
            added.append(content)
        if action != "add" and old_text:
            selectors.append(old_text)
    return added, selectors


def explained(before: Tuple[str, ...], after: Tuple[str, ...], added: List[str], selectors: List[str]) -> bool:
    """Is the change from `before` to `after` the call's own: every new entry one the call wrote,
    every gone entry one an `old_text` selects, at most one of each per op, the rest in order."""
    before_set, after_set = set(before), set(after)
    new = [entry for entry in after if entry not in before_set]
    gone = [entry for entry in before if entry not in after_set]
    if [e for e in before if e in after_set] != [e for e in after if e in before_set]:
        return False
    if len(new) > len(added) or len(gone) > len(selectors):
        return False
    if any(entry not in added for entry in new):
        return False
    return all(any(old_text in entry for old_text in selectors) for entry in gone)


def acknowledge_memory_write(kwargs: Dict[str, Any]) -> bool:
    """After the agent's own `memory` call, re-record the digest of the one file it wrote, so the
    write does not refresh. Only a call that wrote (`call_succeeded`), only a session already
    verified in this process, and only when the file's change since then is explained by the call's arguments (`explained`); otherwise nothing is
    acknowledged and the next turn's exact test refreshes. The other files' digests are kept, so an
    external change to them still refreshes. True when the session's record is current for it."""
    if kwargs.get("tool_name") != "memory":
        return False
    session_id = kwargs.get("session_id")
    if type(session_id) is not str or not session_id:
        return False
    recorded = _recorded(session_id)
    if recorded is None or not call_succeeded(kwargs):
        return False
    args = kwargs.get("args")
    target = call_target(args)
    changes = call_changes(args) if target is not None else None
    if changes is None:
        return False
    key = TARGET_FILES[target]
    verified = recorded.get(key)
    current = _digest(_memory_store_class()._path_for(target), entries=True)
    if current == verified:
        return True  # nothing to acknowledge (a failed or no-op call)
    before, after = _entries_for(verified), _entries_for(current)
    if before is None or after is None or not explained(before, after, *changes):
        return False
    return _acknowledge(session_id, key, verified, current)


def with_memory_write_ack(telemetry: Callable) -> Callable:
    """`post_tool_call` = the telemetry body (`guarded`), then the acknowledgement. Outside the
    telemetry guard (works with telemetry off); never raises."""

    def post_tool_call(*args: Any, **kwargs: Any) -> Any:
        result = telemetry(*args, **kwargs)
        try:
            acknowledge_memory_write(kwargs)
        except BaseException as exc:  # noqa: BLE001 - an acknowledgement never costs the tool call
            if isinstance(exc, _INTERRUPTS):
                raise
            _warn("memory ack", exc)
        return result

    post_tool_call.av_hook_name = getattr(telemetry, "av_hook_name", "post_tool_call")  # type: ignore[attr-defined]
    return post_tool_call


def reset() -> None:
    """Forget every verified session, entry list, unpersisted mark and log latch (tests)."""
    with _LOCK:
        _SEEN.clear()
        _ENTRIES.clear()
        _UNPERSISTED.clear()
        _LATCHED.clear()
        _FAILURES.clear()


__all__ = [
    "MAX_SESSIONS",
    "MODE_VAR",
    "SWITCH",
    "FILES_VAR",
    "TEAM_VAR",
    "acknowledge_memory_write",
    "call_changes",
    "call_succeeded",
    "call_target",
    "check_and_refresh",
    "enabled",
    "explained",
    "file_digests",
    "files_mode",
    "install",
    "missing_seams",
    "mode",
    "persist_again",
    "refresh",
    "reset",
    "stale_reasons",
    "uninstall",
    "with_memory_write_ack",
]
