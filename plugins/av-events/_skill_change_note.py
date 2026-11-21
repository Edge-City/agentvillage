"""SKILL-CHANGE-NOTE: no /new after a mini-app, its SKILL.md or its `village` operations change.

Why. MINIAPP-PICKUP (`_miniapp_epoch.py`) rebuilds an open chat's system prompt at its next turn
after a mini-app is installed, removed or its staged `skills/<app>/SKILL.md` changes, so the agent
sees the new skill. But the chat's own history still holds what the agent said and saw before: an
earlier refusal ("I can't open team rooms"), or a tool result from before the change, and the model
follows its own transcript over the new prompt (Carter's box, 28 Oct, CLAIMS L30662: refused
`zzz.open_team_room` in an old chat, called it at once after /new). And Hermes keeps the chat's saved
tool bytes. Two things are added:

1. **The chat's saved overlay tools are re-saved** (`resave_tools`), once per chat per process on its
   first restored turn (a roll restarts the gateway, so every continuing chat passes through once),
   whatever changed, and again on a `miniapps` rebuild. Hermes keeps a continuing chat's tools[] BYTES
   while its own code sha is unchanged (`tools/mcp_tool_agent.py:151-157` `tool_pin_version`,
   :194-215 `_pinned_def` returns the pinned item verbatim when `same_code`; restored for every
   continuing chat at `agent/conversation_loop.py:744`). An overlay roll never changes Hermes's sha,
   so a chat begun before ov#531 still sends a `village` enum without `zzz.open_team_room`. Each of
   the village toolset's tools the chat sends (`_village_visible.VISIBLE_TOOLS`: `village`,
   `ask_village`, `search_village`, `query_village`, `ask_odin`, `elicitation_record`) whose bytes
   differ from Hermes's current build of it (`model_tools.get_tool_definitions`) is swapped in its slot
   (same name set), and the pin is persisted once (`persist_agent_tool_names`). Same bytes: nothing.

2. **One note** on the user message of the turn a `miniapps` rebuild runs (Hermes `pre_llm_call`
   context), naming each app that changed since the chat's stamp, in product's words (CLAIMS L30672):

       <app> was updated: <what it can do now>. Anything said earlier in this chat about what <app>
       can't do may be out of date, so check with the tool before answering.

   Several apps: one "was updated" sentence each, then one closing sentence naming them all. Hermes
   persists the turn's context in the user row's `api_content` and replays it byte for byte
   (`agent/turn_context.py:884-922`), so the prompt cache breaks only on that turn, which the rebuild
   already breaks. Not given in a group, channel or thread chat (the re-save still runs).

   - What moves an app: its projection entry, its SKILL.md digest, and the `village` operations of
     its operation families (`_miniapp_epoch._surface`), so a bridge-only change is noticed too.
   - `<app>` / `<what it can do now>` for a reviewed app (`REVIEWED`, the installer's table): the
     SKILL.md front matter `display_name`, else its first `# ` heading outside code fences, else the
     id; the front matter `update_note` while `update_note_for` is the app's projection version and
     the note is new for this chat, else the first sentence of `description`. A cp-offered generic app
     (or any app not reviewed): its id and a fixed line, never its author's text (review-b S1). Author
     text loses `[`, `]` and the note's label words, so it cannot forge a second note.
   - Which apps: those whose per-app digest differs from the record of the chat's stamp
     (`_miniapp_epoch.remembered`). No stamp = no app installed then = every app now is new. A stamp
     with no record (stamped by an older overlay, e.g. the roll that ships this): the reviewed apps
     with a current `update_note`; with none, one unnamed line (`UNNAMED`). Removed apps and apps
     without a skill (zzz-bridge) are never named; when none is left there is no note.
   - Once: the rebuild persists the new stamp, so the next turn (cached agent, fresh agent, or after a
     gateway restart) does not rebuild; in-process a (session, fingerprint) pair is noted at most once.

Switch: none of its own. It runs only with MINIAPP-PICKUP, so `AV_MINIAPP_REFRESH=0` or
`miniapp_refresh` in `AV_HOOKS_DISABLED` (read as it is now) turns both off. Never raises into the turn;
no content is ever logged. Standard library only.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import re
import threading
import unicodedata
from collections import OrderedDict
from pathlib import Path
from typing import Any, List, Optional, Tuple

from . import _miniapp_epoch
from ._core import hermes_home
from ._village_visible import VISIBLE_TOOLS

logger = logging.getLogger("av-events")

#: Labels the note as not the resident's words (Hermes appends plugin context raw), as DATA-444 does.
LABEL = "[Agent Village note, not from the resident] "
#: Product's words (CLAIMS L30672).
UPDATED = "{app} was updated: {summary}."
CLOSING = ("Anything said earlier in this chat about what {apps} can't do may be out of date, "
           "so check with the tool before answering.")
#: A stamp with no record and no current `update_note`: which apps moved is unknown (review-b N1).
#: True for every chat that reads it (review-b N-a); product to confirm the words.
UNNAMED = ("Mini-apps may have changed since this chat began. Anything said earlier in this chat about what a "
           "mini-app can't do may be out of date, so check with the tool before answering.")
#: A generic app's line, or a reviewed skill with neither an `update_note` nor a `description`.
NO_SUMMARY = "check the tool for what it can do now"

#: The installer's reviewed apps with a skill (`install/install_miniapps.ts` REVIEWED_MINI_APPS; a test
#: holds the two equal). Only their SKILL.md text is shown; any other app is named by its id.
REVIEWED = frozenset({"gold-stars", "dizko", "forkicks", "zzzbot", "slopfolio", "mosaic", "dreamstarter", "kismet", "library", "favorloop", "eci-volunteers"})
#: The installer's record of the cp-offered generic apps it staged (`GENERIC_STATE`).
GENERIC_STATE = "mini-apps-generic.json"
MAX_GENERIC_BYTES = 65536

MAX_NAME_CHARS = 60
MAX_SUMMARY_CHARS = 240
#: Sessions with a staged note / (session, fingerprint) pairs noted / sessions re-saved this process.
MAX_SESSIONS = 512
#: Chat types a note is given in ("" = Hermes does not say: a CLI or a test).
NOTE_CHAT_TYPES = frozenset({"", "dm", "private"})

_LOCK = threading.Lock()
_PENDING: "OrderedDict[str, str]" = OrderedDict()
_NOTED: "OrderedDict[Tuple[str, str], None]" = OrderedDict()
_RESAVED: "OrderedDict[str, None]" = OrderedDict()
#: Sessions whose saved tools were actually swapped in this process.
_SWAPPED: "OrderedDict[str, None]" = OrderedDict()
_LATCHED: set = set()
_INTERRUPTS = (KeyboardInterrupt, SystemExit)

_HEADING = re.compile(r"#[ \t]+(.+?)[ \t\r]*")
_FENCE = re.compile(r"[ \t]{0,3}(```|~~~)")
#: The label's words with anything but letters between them (hyphens, look-alike spaces), after NFKC.
_LABEL_WORDS = re.compile(r"agent[\W_]*village[\W_]*note|not[\W_]*from[\W_]*the[\W_]*resident", re.IGNORECASE)


# ---- what the SKILL.md says --------------------------------------------------------------------


def _clean(text: Any, cap: int) -> str:
    """One line of author text: no control or format characters, no `[` / `]`, none of the note's
    label words, single spaces, at most `cap` characters (cut at a word, with an ellipsis), no closing
    punctuation (the sentence adds its own full stop)."""
    if not isinstance(text, str):
        return ""
    # NFKC first (review-b N-c): fullwidth brackets and letters fold to the ones stripped below.
    text = unicodedata.normalize("NFKC", text)
    kept = "".join(" " if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") else ch for ch in text)
    kept = _LABEL_WORDS.sub(" ", kept.replace("[", " ").replace("]", " "))
    line = " ".join(kept.split())
    if len(line) > cap:
        line = line[:cap].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"
    return line.rstrip(" .!;:,")


def _first_sentence(text: str) -> str:
    sentence = re.split(r"(?<=[.!?])\s+", text.strip(), maxsplit=1)[0]
    # "Always send ..." reads as "was updated: always send ...", but "UPI ..." keeps its case.
    if len(sentence) > 1 and sentence[0].isupper() and sentence[1].islower():
        sentence = sentence[0].lower() + sentence[1:]
    return sentence


def heading(body: str) -> Optional[str]:
    """The first `# ` heading outside a fenced code block."""
    fenced = None
    for line in body.split("\n"):
        fence = _FENCE.match(line)
        if fence:
            fenced = None if fenced == fence.group(1) else (fenced or fence.group(1))
            continue
        if fenced is None:
            found = _HEADING.fullmatch(line)
            if found:
                return found.group(1)
    return None


def generic_ids(home: Path) -> Optional[frozenset]:
    """The generic app ids the installer recorded; empty when there is no record; None when a record
    exists but cannot be read (every app is then treated as generic)."""
    path = home / GENERIC_STATE
    try:
        raw = _miniapp_epoch._read_nofollow(path, MAX_GENERIC_BYTES)
        if raw is None:
            return frozenset()
        doc = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, RecursionError):
        return None
    skills = doc.get("skills") if isinstance(doc, dict) else None
    return frozenset(skills) if isinstance(skills, dict) else None


def app_line(app_id: str, info: dict, home: Optional[Path] = None, *, trusted: bool = True,
             fresh_note: bool = True) -> Optional[Tuple[str, str, bool]]:
    """(display name, what it can do now, whether a current `update_note` was used) for an app with a
    readable SKILL.md; None when it has none. Untrusted (generic) apps: the id and `NO_SUMMARY`.
    `fresh_note` False: the chat already had this `update_note`, so the description is used."""
    home = Path(home) if home is not None else Path(hermes_home())
    for name in info.get("skills") or []:
        text = _miniapp_epoch.skill_text(home, name)
        if text is None:
            continue
        if not trusted:
            return app_id, NO_SUMMARY, False
        fields, body = _miniapp_epoch.front_matter(text)
        display = _clean(fields.get("display_name"), MAX_NAME_CHARS) or _clean(heading(body), MAX_NAME_CHARS) or app_id
        bound = fields.get("update_note_for") == info.get("version") and isinstance(info.get("version"), str)
        note = _clean(fields.get("update_note"), MAX_SUMMARY_CHARS) if bound and fresh_note else ""
        summary = note or _clean(_first_sentence(fields.get("description") or ""), MAX_SUMMARY_CHARS) or NO_SUMMARY
        return display, summary, bool(note)
    return None


def render(lines: List[Tuple[str, str]]) -> str:
    """The note for (display name, summary) pairs, in order."""
    names = [name for name, _ in lines]
    joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " or " + names[-1]
    sentences = " ".join(UPDATED.format(app=name, summary=summary) for name, summary in lines)
    return f"{LABEL}{sentences} {CLOSING.format(apps=joined)}"


def note_for(old_stamp: str, home: Optional[Path] = None, *, swapped: bool = False) -> Optional[Tuple[str, str]]:
    """(fingerprint now, the note) for a chat stamped `old_stamp`; None when no installed app with a
    skill changed since (or the projection cannot be read). `swapped`: this chat's saved tools were
    re-saved in this process."""
    root = Path(home) if home is not None else Path(hermes_home())
    found = _miniapp_epoch.current_apps(root)
    if found is None or not found[0]:
        return None
    current, apps = found
    before = _miniapp_epoch.remembered(old_stamp, root)
    generic = generic_ids(root)
    lines = {}
    for app_id, info in sorted(apps.items()):
        if not info["skills"]:
            continue
        trusted = app_id in REVIEWED and generic is not None and app_id not in generic
        old = (before or {}).get(app_id)
        fresh_note = before is None or not isinstance(old, dict) or old.get("n") != info["note"]
        line = app_line(app_id, info, root, trusted=trusted, fresh_note=fresh_note)
        if line is not None:
            lines[app_id] = line
    if before is None:
        # review-b N-a: a stamp with no record that is exactly the unfolded fingerprint of the disk now
        # (a chat begun after the last change, stamped by the overlay before this one), and no tool of
        # its re-saved: nothing changed for this chat, so no note.
        if not swapped and old_stamp and old_stamp == _miniapp_epoch.legacy_fingerprint(root):
            return None
        chosen = [app_id for app_id, line in lines.items() if line[2]]
        if not chosen:
            return (current, LABEL + UNNAMED) if lines else None
    else:
        chosen = [app_id for app_id in lines if not isinstance(before.get(app_id), dict)
                  or before[app_id].get("d") != apps[app_id]["digest"]]
    if not chosen:
        return None
    return current, render([lines[app_id][:2] for app_id in chosen])


# ---- the turn ----------------------------------------------------------------------------------


def _bounded_put(table: "OrderedDict", key: Any, value: Any) -> None:
    table[key] = value
    table.move_to_end(key)
    while len(table) > MAX_SESSIONS:
        table.popitem(last=False)


def stage(session_id: str, old_stamp: str, home: Optional[Path] = None) -> bool:
    """After a `miniapps` rebuild: stage the note for this session's `pre_llm_call` in the same turn.
    True when one was staged. At most once per (session, fingerprint) in this process."""
    if not isinstance(session_id, str) or not session_id:
        return False
    with _LOCK:
        swapped = session_id in _SWAPPED
    found = note_for(old_stamp or "", home, swapped=swapped)
    if found is None:
        return False
    current, note = found
    with _LOCK:
        if (session_id, current) in _NOTED:
            return False
        _bounded_put(_NOTED, (session_id, current), None)
        _bounded_put(_PENDING, session_id, note)
    return True


def take(session_id: Any) -> Optional[str]:
    """The staged note for this session, once."""
    if not isinstance(session_id, str) or not session_id:
        return None
    with _LOCK:
        return _PENDING.pop(session_id, None)


def gives_note(chat_type: str) -> bool:
    """The note goes only to an owner's private chat (review-b N2); the re-save goes everywhere."""
    return chat_type in NOTE_CHAT_TYPES


def _def_name(tool: Any) -> str:
    function = tool.get("function") if isinstance(tool, dict) else None
    return function.get("name", "") if isinstance(function, dict) else ""


def _latched_info(key: str, message: str, *args: Any) -> None:
    with _LOCK:
        first = key not in _LATCHED
        _LATCHED.add(key)
    try:
        logger.log(logging.INFO if first else logging.DEBUG, message, *args)
    except BaseException:  # noqa: BLE001
        pass


def _seams() -> Optional[tuple]:
    """(model_tools, tools lock, persist) from Hermes, or None (one INFO line per process) when this
    Hermes lacks one of them (review-b N5): the pin is then left exactly as Hermes restored it.
    Definitions come from `model_tools` (`get_toolset_for_tool`, `get_tool_definitions`): Hermes's own
    build (dynamic schemas, sanitizer), read-only, never its tool table directly."""
    try:
        pin = importlib.import_module("tools.mcp_tool_agent")
        tools = importlib.import_module("model_tools")
        lock, persist = pin._agent_tools_lock, pin.persist_agent_tool_names
        if not callable(persist) or not callable(getattr(pin, "tool_pin_version", None)) \
                or not callable(getattr(tools, "get_tool_definitions", None)) \
                or not callable(getattr(tools, "get_toolset_for_tool", None)) or not hasattr(lock, "__enter__"):
            raise AttributeError("seam")
    except Exception:  # noqa: BLE001
        _latched_info("seams", "av-events: skill_change_note: Hermes has no tools pin seam; tools left as is")
        return None
    return tools, lock, persist


def _canonical(tool: Any) -> Optional[str]:
    """The bytes a definition is sent as (review-b N-d: a tuple and a list are the same JSON)."""
    try:
        return json.dumps(tool, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, ValueError):
        return None


def resave_tools(agent: Any) -> List[str]:
    """Swap each `VISIBLE_TOOLS` definition the chat sends whose saved bytes differ from Hermes's current
    build of it, in its slot, and persist the pin once. The names swapped (empty: nothing changed or
    nothing to do). Never adds or drops a tool."""
    sent = {_def_name(tool) for tool in (getattr(agent, "tools", None) or [])} & set(VISIBLE_TOOLS)
    if not sent:
        return []
    seams = _seams()
    if seams is None:
        return []
    tools_api, lock, persist = seams
    toolsets = sorted({ts for ts in (tools_api.get_toolset_for_tool(name) for name in sent) if isinstance(ts, str) and ts})
    if not toolsets:
        return []
    fresh_defs = _miniapp_epoch.hermes_tool_definitions(tools_api, toolsets)
    fresh = {_def_name(tool): tool for tool in fresh_defs or [] if _def_name(tool) in sent}
    swapped = []
    with lock:
        tools = list(getattr(agent, "tools", None) or [])
        for index, tool in enumerate(tools):
            name = _def_name(tool)
            if name in fresh and name not in swapped:
                current, wanted = _canonical(tool), _canonical(fresh[name])
                if wanted is not None and current != wanted:
                    tools[index] = fresh[name]
                    swapped.append(name)
        if swapped:
            agent.tools = tools
    if swapped:
        persist(agent)
        session_id = getattr(agent, "session_id", None)
        if isinstance(session_id, str) and session_id:
            with _LOCK:
                _bounded_put(_SWAPPED, session_id, None)
    return sorted(swapped)


def _resave_logged(agent: Any) -> None:
    try:
        swapped = resave_tools(agent)
        if swapped:
            logger.info("av-events: skill_change_note tools re-saved %s", ",".join(swapped))
    except BaseException as exc:  # noqa: BLE001 - the pin stays as it was
        if isinstance(exc, _INTERRUPTS):
            raise
        logger.debug("av-events: skill_change_note re-save skipped (%s)", type(exc).__name__)


def _switch_on() -> bool:
    """The switch as read now (the stamp's own read): a collector's `AV_HOOKS_DISABLED` is re-read only
    at a session boundary, and an off switch must stop this at once."""
    try:
        return _miniapp_epoch.enabled(None)
    except BaseException as exc:  # noqa: BLE001
        if isinstance(exc, _INTERRUPTS):
            raise
        return False


def first_restore(agent: Any) -> None:
    """Called in Hermes's restore slot of a continuing chat's turn (MINIAPP-PICKUP's wrapper), before
    the stale check: the tools re-save, once per session per process (review-b M1 (a)). Never raises."""
    session_id = getattr(agent, "session_id", None)
    if not isinstance(session_id, str) or not session_id or not _switch_on():
        return
    with _LOCK:
        if session_id in _RESAVED:
            return
        _bounded_put(_RESAVED, session_id, None)
    _resave_logged(agent)


def after_rebuild(agent: Any, old_prompt: str) -> None:
    """Called by `_prompt_refresh.check_and_refresh` right after a `miniapps` rebuild, in Hermes's
    restore slot (before `pre_llm_call` and before any API call of the turn). Never raises."""
    if not _switch_on():
        return
    _resave_logged(agent)
    try:
        stage(getattr(agent, "session_id", None), _miniapp_epoch.stamp_in(old_prompt))
    except BaseException as exc:  # noqa: BLE001 - no note
        if isinstance(exc, _INTERRUPTS):
            raise
        logger.debug("av-events: skill_change_note not staged (%s)", type(exc).__name__)


def reset() -> None:
    """Forget staged and given notes, re-saved sessions and log latches (tests; a restart)."""
    with _LOCK:
        _PENDING.clear()
        _NOTED.clear()
        _RESAVED.clear()
        _SWAPPED.clear()
        _LATCHED.clear()


__all__ = [
    "CLOSING",
    "LABEL",
    "REVIEWED",
    "UNNAMED",
    "UPDATED",
    "after_rebuild",
    "app_line",
    "first_restore",
    "generic_ids",
    "gives_note",
    "heading",
    "note_for",
    "render",
    "resave_tools",
    "reset",
    "stage",
    "take",
]
