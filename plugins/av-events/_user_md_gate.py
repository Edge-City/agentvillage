"""The USER.md gate, av-events' copy (review-b #558 S1, S2): installed from av-events `register()` too, so the
gate never depends on the village-memory provider loading, plus the memory tool's `transform_tool_result`.

The block below is byte-identical to the one in `plugins/village-memory/__init__.py` (a test holds them
together); read the block's own header for what it does.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import sys
import threading
from typing import Any, List, Optional

# ==== USER.md GATE: one block, byte-identical in plugins/village-memory/__init__.py and ==================
# ==== plugins/av-events/_user_md_gate.py (tests/test_user_md_gate.py holds the two together) =============
#
# Hermes core puts `memories/USER.md` into EVERY session's prompt (agent/system_prompt.py:515-525, 776:
# `_memory_parts` -> `MemoryStore.format_for_system_prompt("user")`, a snapshot frozen at `load_from_disk`).
# Two of its entries are Private (PRIVATE_ENTRY_MARKS): the app's raw setup profile (L31622) and the control
# plane's God Constitution conversation note (a ballot, rated statements, and a DM-only "ask your human one
# at a time"). The village vote note is village data and stays.
# - The seam: `install_user_md_gate()` wraps `_memory_parts` once per process (looked up by bare name at :776,
#   so the module attribute is the seam). A session that is not private gets the USER.md block without those
#   entries; a private one gets it byte for byte. Both village-memory (the provider) and av-events (a general
#   plugin, loaded in gateway and cron processes) install it, so it never depends on the provider loading.
# - Fail closed (review-b #558 S1): a Hermes without that seam gets the snapshot gate instead: the store's
#   USER.md block leaves those entries out for EVERY session (a private DM still has the setup text under
#   `_profile.md` "## Setup profile").
# - The memory tool (review-b #558 S2): its results carry whole entries (`current_entries`, `matches`,
#   `replaced_entry`, `removed_entry`, ...). `transform_memory_result` (av-events' `transform_tool_result`)
#   leaves Private entries out of them outside a private session, and `memory_write_directive` (av-events'
#   `pre_tool_call`) refuses there every USER.md write, so a group can neither strip a mark nor probe the
#   text. A DM keeps Hermes's own memory tool, unchanged. "Private" needs positive evidence
#   (`session_is_private_now`): a direct chat or an explicit local surface.
# - Outside a private session the memory tool's answers key only on the call's target and action, never on
#   its content (review-b ov#563 S1-d): every USER.md write (add, replace, remove, a batch op on USER.md)
#   is refused with one message, every MEMORY.md write goes through whatever it holds; a USER.md result is
#   redacted on marks and fingerprints, a MEMORY.md result on marks only. So no answer differs between a
#   right and a wrong guess of a Private line, whether the call carries the guess or an earlier call stored
#   it in MEMORY.md. A call whose target is unknown (args missing or malformed) counts as USER.md.
# - A Private entry is known by its mark, or by a fingerprint (the sha256 of each of its lines of at least
#   FINGERPRINT_MIN_CHARS) taken whenever this process sees it marked (`MemoryStore.load_from_disk`, the
#   prompt gate), so text derived from one is still known after its mark has gone (the prompt gate and
#   USER.md results). One fingerprint set per process, on Hermes's `MemoryStore` class, read by both copies
#   of this block (review-b ov#563 N4-d).
# Standard library only; logs carry codes, never text.

GATE_LOGGER = logging.getLogger("av-user-md-gate")
#: The Private USER.md entries, by the control plane's own marks (control-plane memory-entry.js CP_ENTRY_MARKS;
#: tenants.js PROFILE_ENTRY_MARK, godconst-elicitation.js NOTE_MARK). A test pins each to cp's text.
SETUP_PROFILE_MARK = "[Edge City profile, written at setup]"
GODCONST_NOTE_MARK = "[God Constitution conversation, kept by the Agent Village control plane]"
PRIVATE_ENTRY_MARKS = (SETUP_PROFILE_MARK, GODCONST_NOTE_MARK)
#: Hermes's entry delimiter, block separator and USER.md block title (tools/memory_tool_store.py:20-23, :483-489).
ENTRY_DELIMITER = "\n§\n"
USER_BLOCK_SEPARATOR = "═" * 46
USER_BLOCK_TITLE = "USER PROFILE (who the user is)"
#: Set on the wrapped `agent.system_prompt._memory_parts`: `gate(agent, user_block) -> block`, so F1
#: (av-events/_prompt_refresh.py) renders the USER.md block exactly as the prompt carries it.
USER_GATE_ATTR = "village_user_gate"
#: Set on the fail-closed `MemoryStore.format_for_system_prompt` (no `_memory_parts` seam).
SNAPSHOT_GATE_ATTR = "village_user_snapshot_gate"
GATE_PROVIDER_NAME = "village-memory"
GATE_DIRECT_CHAT_TYPES = frozenset({"dm", "private", "direct", "c2c"})
GATE_LOCAL_SURFACES = frozenset({"cli", "tui", "desktop", "local"})
#: What a memory-tool result holds in place of a Private entry outside a private session.
LEFT_OUT = "[left out: a private USER.md entry; this is not a private chat with your human]"
#: The memory tool's one refusal outside a private session: any USER.md write (never echoes an entry; true
#: for an add, a replace and a remove alike, review-b ov#563 N3-d).
MEMORY_WRITE_REFUSAL = ("Your human's profile notes (USER.md) can only be changed in your private chat with them. "
                        "You can still note this in MEMORY.md.")
#: Set on the wrapped `MemoryStore.load_from_disk` (fingerprints taken at load).
LOAD_GATE_ATTR = "village_user_load_gate"
FINGERPRINT_MIN_CHARS = 24
#: Set on Hermes's `tools.memory_tool_store.MemoryStore` class: the process's one fingerprint set, whichever
#: copy of this block installed the gates (review-b ov#563 N4-d).
DIGESTS_ATTR = "village_private_line_digests"
#: This copy's own set, only while Hermes's store is not loaded (outside Hermes: the tests).
_PRIVATE_LINE_DIGESTS: set = set()

_GATE_LATCHED: set = set()
_GATE_LATCH_LOCK = threading.Lock()
_GATE_INSTALL_LOCK = threading.Lock()


def _gate_log_once(key: str, message: str, *args: Any) -> None:
    """WARNING the first time `key` fires in this process, DEBUG after."""
    with _GATE_LATCH_LOCK:
        level = logging.DEBUG if key in _GATE_LATCHED else logging.WARNING
        _GATE_LATCHED.add(key)
    try:
        GATE_LOGGER.log(level, message, *args)
    except Exception:  # noqa: BLE001 - a log line never costs a turn
        pass


def _gate_reset_for_tests() -> None:
    _private_line_digests().clear()
    with _GATE_LATCH_LOCK:
        _GATE_LATCHED.clear()
        _PRIVATE_LINE_DIGESTS.clear()


def _private_line_digests() -> set:
    """The process's fingerprint set: one set on Hermes's `MemoryStore` class, so the village-memory and
    av-events copies of this block fill and read the same one; this copy's own set only while that class is
    not loaded (folded into the shared one as soon as it is)."""
    try:
        store = getattr(sys.modules.get("tools.memory_tool_store"), "MemoryStore", None)
        if not isinstance(store, type):
            return _PRIVATE_LINE_DIGESTS
        with _GATE_LATCH_LOCK:
            shared = getattr(store, DIGESTS_ATTR, None)
            if not isinstance(shared, set):
                setattr(store, DIGESTS_ATTR, set())
                shared = getattr(store, DIGESTS_ATTR)
            if _PRIVATE_LINE_DIGESTS:
                shared.update(_PRIVATE_LINE_DIGESTS)
                _PRIVATE_LINE_DIGESTS.clear()
        return shared
    except Exception:  # noqa: BLE001 - this copy's own set; the marks still hold
        return _PRIVATE_LINE_DIGESTS


def _gate_norm(value: Any) -> str:
    return str(value or "").strip().lower()


def is_private_session(chat_type: str, platform: str, agent_context: str) -> bool:
    """A one-to-one chat, or no chat type on the owner's own machine; never a cron run (normalised
    values, as village-memory's `initialize` stores them)."""
    if agent_context == "cron" or platform == "cron":
        return False
    if chat_type in GATE_DIRECT_CHAT_TYPES:
        return True
    return not chat_type and (not platform or platform in GATE_LOCAL_SURFACES)


def _line_digest(line: str) -> str:
    return hashlib.sha256(line.strip().encode("utf-8")).hexdigest()


def _fingerprint_lines(text: str) -> List[str]:
    return [line for line in text.split("\n") if len(line.strip()) >= FINGERPRINT_MIN_CHARS]


def remember_private_entries(entries: Any) -> None:
    """Fingerprint every marked entry among `entries` (its lines of FINGERPRINT_MIN_CHARS or more)."""
    for entry in list(entries or []):
        if isinstance(entry, str) and any(mark in entry for mark in PRIVATE_ENTRY_MARKS):
            digests = {_line_digest(line) for line in _fingerprint_lines(entry) if line.strip() not in PRIVATE_ENTRY_MARKS}
            shared = _private_line_digests()
            with _GATE_LATCH_LOCK:
                shared.update(digests)


def holds_private_mark(text: Any) -> bool:
    """A Private mark (a public constant) in `text`: what a MEMORY.md result is judged on outside a private
    session (the session cannot learn anything from it that it did not already know)."""
    return isinstance(text, str) and any(mark in text for mark in PRIVATE_ENTRY_MARKS)


def holds_private_entry(text: Any) -> bool:
    """A Private mark in `text`, or a line of an entry this process has seen marked (the prompt gate and
    USER.md results; never a MEMORY.md result or the write check)."""
    if not isinstance(text, str):
        return False
    if holds_private_mark(text):
        return True
    digests = _private_line_digests()
    if not digests:
        return False
    return any(_line_digest(line) in digests for line in _fingerprint_lines(text))


def shared_user_block(block: Any) -> Any:
    """Hermes's USER.md block without the Private entries (PRIVATE_ENTRY_MARKS), the header (and its usage
    figure, which is the file's) kept. "" when nothing else is left. Fail closed: a block that holds a mark
    in a shape this does not know is dropped whole."""
    if not holds_private_entry(block):
        return block
    lines = block.split("\n", 3)
    if (len(lines) < 4 or lines[0] != USER_BLOCK_SEPARATOR or lines[2] != USER_BLOCK_SEPARATOR
            or not lines[1].startswith(USER_BLOCK_TITLE)):
        return ""
    entries = lines[3].split(ENTRY_DELIMITER)
    remember_private_entries(entries)
    kept = [entry for entry in entries if not holds_private_entry(entry)]
    if not [entry for entry in kept if entry.strip()]:
        return ""
    return "\n".join(lines[:3]) + "\n" + ENTRY_DELIMITER.join(kept)


def _village_provider(agent: Any) -> Any:
    manager = getattr(agent, "_memory_manager", None)
    for provider in list(getattr(manager, "providers", None) or []) if manager is not None else []:
        if (getattr(provider, "name", None) == GATE_PROVIDER_NAME and callable(getattr(provider, "private_session", None))
                and callable(getattr(provider, "session_known", None))):
            return provider
    return None


def agent_is_private(agent: Any) -> bool:
    """The agent's own village-memory provider decides (`private_session`), once it knows the session.
    Before `initialize` its `private_session()` says True for tool routing, so the gate never asks it then.
    An agent without an initialised provider (a subagent, a review fork, a provider not yet initialised)
    is judged on the same facts Hermes hands a provider (agent/agent_init.py:1221-1248: platform defaults
    to cli, agent_context from platform)."""
    provider = _village_provider(agent)
    if provider is not None and provider.session_known():
        return bool(provider.private_session())
    platform = _gate_norm(getattr(agent, "platform", None)) or "cli"
    context = platform if platform in ("cron", "subagent") else "primary"
    return is_private_session(_gate_norm(getattr(agent, "_chat_type", None)), platform, context)


def user_block_for(agent: Any, block: Any) -> Any:
    """The USER.md block as this agent's prompt carries it (F1 renders through this too)."""
    return block if agent_is_private(agent) else shared_user_block(block)


def _is_user_part(agent: Any, part: Any) -> bool:
    if not isinstance(part, str):
        return False
    if part.startswith(f"{USER_BLOCK_SEPARATOR}\n{USER_BLOCK_TITLE}"):
        return True
    store = getattr(agent, "_memory_store", None)
    try:
        return store is not None and part == store.format_for_system_prompt("user")
    except Exception:  # noqa: BLE001
        return False


def gate_memory_parts(original: Any) -> Any:
    """`_memory_parts` with the USER.md block passed through `user_block_for`."""

    def _memory_parts(agent: Any) -> List[str]:
        parts = original(agent)
        try:
            if agent_is_private(agent):
                return parts
            gated = [shared_user_block(p) if _is_user_part(agent, p) else p for p in parts]
            return [p for p in gated if p]
        except Exception as exc:  # noqa: BLE001 - never cost a prompt build; fail closed on the entries
            _gate_log_once(f"user_gate:error_{type(exc).__name__}",
                           "USER.md gate failed (%s); private entries left out", type(exc).__name__)
            return [p for p in parts if not holds_private_entry(p)]

    _memory_parts.__wrapped__ = original  # type: ignore[attr-defined]
    setattr(_memory_parts, USER_GATE_ATTR, user_block_for)
    return _memory_parts


def gate_snapshot(original: Any) -> Any:
    """`MemoryStore.format_for_system_prompt` with the Private entries left out of the USER.md block, for
    every session: the fail-closed path when Hermes has no `_memory_parts` seam."""

    def format_for_system_prompt(self: Any, target: str) -> Any:
        block = original(self, target)
        if target != "user":
            return block
        try:
            return shared_user_block(block) or None
        except Exception:  # noqa: BLE001 - fail closed
            return None if holds_private_entry(block) else block

    format_for_system_prompt.__wrapped__ = original  # type: ignore[attr-defined]
    setattr(format_for_system_prompt, SNAPSHOT_GATE_ATTR, True)
    return format_for_system_prompt


def gate_load(original: Any) -> Any:
    """`MemoryStore.load_from_disk`, then a fingerprint of every marked USER.md entry it loaded."""

    def load_from_disk(self: Any, *args: Any, **kwargs: Any) -> Any:
        out = original(self, *args, **kwargs)
        try:
            remember_private_entries(getattr(self, "user_entries", None))
        except Exception:  # noqa: BLE001 - the marks still hold
            pass
        return out

    load_from_disk.__wrapped__ = original  # type: ignore[attr-defined]
    setattr(load_from_disk, LOAD_GATE_ATTR, True)
    return load_from_disk


def _install_load_gate() -> None:
    try:
        store = importlib.import_module("tools.memory_tool_store").MemoryStore
        load = store.load_from_disk
    except Exception:  # noqa: BLE001 - the marks still hold
        return
    if not getattr(load, LOAD_GATE_ATTR, False):
        store.load_from_disk = gate_load(load)


def install_user_md_gate() -> bool:
    """Wrap `agent.system_prompt._memory_parts` once per process. A Hermes without that seam gets the
    snapshot gate on `MemoryStore` instead (one WARNING). True when either gate is in place; False only
    when neither seam exists (one WARNING), Hermes is not importable (outside Hermes: the tests), or its
    prompt module fails to import for any other reason (one WARNING naming the exception class; review-b
    ov#563 N7-d)."""
    try:
        sp = importlib.import_module("agent.system_prompt")
    except ImportError:  # outside Hermes: nothing to gate
        GATE_LOGGER.debug("USER.md gate not installed (no agent.system_prompt)")
        return False
    except Exception as exc:  # noqa: BLE001 - never raise into register(); say so once
        _gate_log_once(f"user_gate:import_{type(exc).__name__}",
                       "USER.md gate not installed (agent.system_prompt import failed: %s)", type(exc).__name__)
        return False
    with _GATE_INSTALL_LOCK:
        _install_load_gate()
        current = getattr(sp, "_memory_parts", None)
        if callable(current):
            if not callable(getattr(current, USER_GATE_ATTR, None)):
                sp._memory_parts = gate_memory_parts(current)
            return True
        try:
            store = importlib.import_module("tools.memory_tool_store").MemoryStore
            render = store.format_for_system_prompt
        except Exception:  # noqa: BLE001
            _gate_log_once("user_gate:no_seam", "USER.md gate not installed (no _memory_parts, no MemoryStore)")
            return False
        if not getattr(render, SNAPSHOT_GATE_ATTR, False):
            store.format_for_system_prompt = gate_snapshot(render)
        _gate_log_once("user_gate:snapshot", "USER.md gate: no _memory_parts; private entries left out for every session")
        return True


def gate_state() -> str:
    """`seam` (the per-session gate on `_memory_parts`, reached by bare name from the prompt build),
    `snapshot` (the fail-closed store gate), or `none`. The release canary reads this."""
    try:
        sp = importlib.import_module("agent.system_prompt")
        current = getattr(sp, "_memory_parts", None)
        if callable(getattr(current, USER_GATE_ATTR, None)):
            build = getattr(sp, "build_system_prompt_parts", None) or getattr(sp, "build_system_prompt", None)
            if getattr(build, "__globals__", None) is vars(sp):
                return "seam"
        render = importlib.import_module("tools.memory_tool_store").MemoryStore.format_for_system_prompt
        if getattr(render, SNAPSHOT_GATE_ATTR, False):
            return "snapshot"
    except Exception:  # noqa: BLE001
        pass
    return "none"


def _session_value(name: str) -> str:
    try:
        from gateway.session_context import get_session_env  # type: ignore[import-not-found]

        return str(get_session_env(name, "") or "")
    except Exception:  # noqa: BLE001 - not in a gateway: the process environment
        return os.environ.get(name, "")


def _store_session(session_id: str) -> Optional[dict]:
    """Hermes's own session row (hermes_state.SessionDB, read only): `source` and `chat_type`, or None."""
    try:
        db = importlib.import_module("hermes_state").SessionDB(read_only=True)
        try:
            row = db.get_session(session_id)
        finally:
            close = getattr(db, "close", None)
            if callable(close):
                close()
        return dict(row) if row else None
    except Exception:  # noqa: BLE001 - no evidence
        return None


def session_is_private_now(session_id: Any = "") -> bool:
    """Whether the current tool call's session is private, on POSITIVE evidence only (security review):
    a direct chat type, or a local surface (cli, tui, desktop, local) set explicitly, from Hermes's session
    context (gateway/session_context.py) or, when that says nothing, Hermes's own session row for
    `session_id`. Empty or unknown is NOT private, and a cron run never is (`cron_` ids, HERMES_CRON_SESSION,
    platform or source cron)."""
    sid = str(session_id or "")
    platform = _gate_norm(_session_value("HERMES_SESSION_PLATFORM") or os.environ.get("HERMES_PLATFORM", ""))
    chat_type = _gate_norm(_session_value("HERMES_SESSION_CHAT_TYPE"))
    if sid.startswith("cron_") or _session_value("HERMES_CRON_SESSION").strip() == "1" or platform == "cron":
        return False
    if chat_type:
        return chat_type in GATE_DIRECT_CHAT_TYPES
    if platform:
        return platform in GATE_LOCAL_SURFACES
    row = _store_session(sid) if sid else None
    if not row:
        return False
    source, row_chat = _gate_norm(row.get("source")), _gate_norm(row.get("chat_type"))
    if source == "cron":
        return False
    if row_chat:
        return row_chat in GATE_DIRECT_CHAT_TYPES
    return source in GATE_LOCAL_SURFACES


def memory_call_target(args: Any) -> str:
    """The store a memory-tool call reaches, as Hermes runs it (tools/memory_tool.py `memory_tool`: `target`
    None is memory; a batch, a non-empty `operations` whatever `action` says, lands on the call's own
    target). "memory" only when the call says so; "user" for anything else, an op of a batch naming
    `target: user` and missing or malformed args included (fail closed)."""
    if not isinstance(args, dict):
        return "user"
    ops = args.get("operations")
    if isinstance(ops, list) and any(not isinstance(op, dict) or op.get("target") == "user" for op in ops):
        return "user"
    return "memory" if args.get("target") in (None, "memory") else "user"


def _left_out(value: Any, holds: Any = None) -> Any:
    """`value` with every string `holds` flags (default `holds_private_entry`) left out: a list drops it, a
    dict keeps the key with LEFT_OUT in its place."""
    holds = holds or holds_private_entry
    if isinstance(value, str):
        return LEFT_OUT if holds(value) else value
    if isinstance(value, list):
        return [_left_out(v, holds) for v in value if not holds(v)]
    if isinstance(value, dict):
        return {k: _left_out(v, holds) for k, v in value.items()}
    return value


def redact_memory_result(result: Any, fingerprints: bool = True) -> Optional[str]:
    """A memory-tool result without its Private entries (judged value by value, so a fingerprint inside a
    JSON string counts), or None when it holds none. A result that is not JSON but holds a mark or a
    fingerprint is replaced whole (fail closed). `fingerprints=False` judges on the marks only (a write's
    result outside a private session: review-b ov#563 S1-d)."""
    if not isinstance(result, str):
        return None
    holds = holds_private_entry if fingerprints else holds_private_mark
    try:
        payload = json.loads(result)
    except Exception:  # noqa: BLE001
        return json.dumps({"success": False, "error": LEFT_OUT}, ensure_ascii=False) if holds(result) else None
    redacted = _left_out(payload, holds)
    if redacted == payload:
        return None if not holds(result) else json.dumps({"success": False, "error": LEFT_OUT}, ensure_ascii=False)
    out = json.dumps(redacted, ensure_ascii=False)
    return json.dumps({"success": False, "error": LEFT_OUT}, ensure_ascii=False) if holds(out) else out


def transform_memory_result(tool_name: Any = None, result: Any = None, session_id: Any = "", args: Any = None,
                            **_kwargs: Any) -> Optional[str]:
    """Hermes's `transform_tool_result` (model_tools.py:848-865, which hands it the call's `args`): outside a
    private session, the memory tool's result never carries a Private USER.md entry. A USER.md call's result
    (`memory_call_target`; args missing count as one) is judged on marks and fingerprints; a MEMORY.md
    call's result on the marks only, so a group's own MEMORY.md note reads back the same whether or not it
    equals a Private line (review-b ov#563 S1-d). None leaves the result as it is."""
    try:
        if tool_name != "memory" or session_is_private_now(session_id):
            return None
        out = redact_memory_result(result, fingerprints=memory_call_target(args) == "user")
        if out is not None:
            _gate_log_once("user_gate:memory_result", "USER.md gate: private entries left out of a memory result")
        return out
    except Exception:  # noqa: BLE001 - fail closed
        return json.dumps({"success": False, "error": LEFT_OUT}, ensure_ascii=False)


def memory_write_directive(tool_name: Any = None, args: Any = None, session_id: Any = "") -> Optional[dict]:
    """Hermes's `pre_tool_call` block directive, or None. Outside a private session the memory tool may not
    write USER.md at all (an add, a replace, a remove, a batch on USER.md or with an op naming it), and may
    write MEMORY.md whatever the write holds. It decides only on the call's target and action, never on its
    content (review-b ov#563 S1-d): the answer never tells a group whether a guess is in the setup text (no
    membership oracle). One refusal, MEMORY_WRITE_REFUSAL, true in every case (N3-d). A DM is never
    refused."""
    block = {"action": "block", "message": MEMORY_WRITE_REFUSAL}
    try:
        if tool_name != "memory" or session_is_private_now(session_id):
            return None
        if not isinstance(args, dict):
            return block
        ops = args.get("operations")
        if (ops or args.get("action") == "batch") and not isinstance(ops, list):
            return block
        return block if memory_call_target(args) == "user" else None
    except Exception:  # noqa: BLE001 - fail closed
        return block

# ==== END USER.md GATE ===================================================================================
