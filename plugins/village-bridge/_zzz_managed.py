"""Bounded, box-local ZZZ pair polling for the installer-owned Hermes cron.

The app and ZZZ remain the authority for the current pair and every operation.
This file keeps only cursors, IDs and a short reply reservation; no post text.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import stat
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path

JOB_NAME = "Edge — zzz pairs"
JOB_SCRIPT = "zzz_managed_runner.py"
JOB_TOOLSETS = ["village", "no_mcp"]
STATE_LIMIT = 65536
THREAD_LIMIT = 256
POLICY_PAUSE_SECONDS = 86400
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")
CRON_SESSION = re.compile(r"cron_([0-9a-f]{12})_[0-9]{8}_[0-9]{6}\Z")
CRON_TASK = re.compile(r"cron:([0-9a-f]{12}):[0-9a-f-]{8,80}\Z")
CRON_OPS = frozenset(("zzz.pairs", "zzz.changes", "zzz.read_thread", "zzz.reply", "zzz.create_thread"))
INTRO_TITLE = "Hello from this side"
INTRO_BODY = "Hello! I'm this resident's agent. What would be useful to coordinate here?"
_SAFE_MANAGED_RUN: ContextVar[tuple[str, str] | None] = ContextVar("zzz_safe_managed_run", default=None)


@contextmanager
def managed_runner_scope(job_id: str, session_id: str):
    """Bound only around the reviewed no_agent runner's native read/write path."""
    if not re.fullmatch(r"[0-9a-f]{12}", job_id) or not CRON_SESSION.fullmatch(session_id):
        raise ValueError("runner-identity")
    if CRON_SESSION.fullmatch(session_id)[1] != job_id:
        raise ValueError("runner-identity")
    from gateway.session_context import _VAR_MAP
    cron = _VAR_MAP["HERMES_CRON_SESSION"]
    token = cron.set("1")
    marker = _SAFE_MANAGED_RUN.set((job_id, session_id))
    try:
        yield
    finally:
        cron.reset(token)
        _SAFE_MANAGED_RUN.reset(marker)


def _plain_json(path: Path, limit: int):
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("symlink")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_size > limit:
            raise ValueError("size")
        return json.load(stream)


def participation_on(home: Path) -> bool:
    """ov#441 S1 (lead L16696): the cp projection's zzzbot + zzz-bridge entries, read by the one projection reader.

    Fails closed: any error (including an import outside the package) is off. No constant or env var is read.
    """
    try:
        from ._mini_apps import zzz_participation
        return zzz_participation(home) is True
    except Exception:
        return False


def managed_context(home: Path, operation: str, session_id: object, task_id: object):
    """A Hermes-created cron root for our enabled job; IDs are handler kwargs, never model fields.

    Hermes v2026.9.24 cron/scheduler.py _CronRunScope deliberately clears
    HERMES_SESSION_KEY/PLATFORM; model_tools.py injects session_id and task_id
    into registry handler kwargs from the live agent/tool executor.
    """
    if operation not in CRON_OPS:
        return None
    try:
        if not participation_on(home):
            return None
        from gateway import session_context as sc
        from agent.delegation_context import is_delegated_child_context
        if is_delegated_child_context():
            return None
        if sc._VAR_MAP["HERMES_CRON_SESSION"].get() != "1":
            return None
        match = CRON_SESSION.fullmatch(session_id) if isinstance(session_id, str) else None
        task = CRON_TASK.fullmatch(task_id) if isinstance(task_id, str) else None
        if not match or not task or match[1] != task[1]:
            return None
        # Tool kwargs and job identity alone cannot authorize the native path.
        # The bounded no_agent runner binds this execution-local marker only
        # after checking the current exact job and projection.
        if _SAFE_MANAGED_RUN.get() != (match[1], session_id):
            return None
        jobs = _plain_json(home / "cron" / "jobs.json", 1024 * 1024)
        if not isinstance(jobs, dict) or not isinstance(jobs.get("jobs"), list):
            return None
        good = [job for job in jobs["jobs"] if isinstance(job, dict) and job.get("id") == match[1]
                and job.get("name") == JOB_NAME and job.get("script") == JOB_SCRIPT
                and job.get("enabled") is True and job.get("no_agent") is True
                and not job.get("workdir") and job.get("enabled_toolsets") == JOB_TOOLSETS]
        if len(good) != 1:
            return None
        config = _plain_json(home / "village-bridge.json", 2048)
        owner = config.get("ownerTelegramId") if isinstance(config, dict) else None
        if not isinstance(owner, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", owner):
            return None
        return {"SESSION_KEY": session_id, "MESSAGE_ID": task_id, "USER_ID": owner,
                "MANAGED_ZZZ": True}
    except Exception:
        return None


def _state_path(home: Path) -> Path:
    return home / "zzzbot" / "managed-pairs.json"


@contextmanager
def locked_state(home: Path):
    folder = home / "zzzbot"
    if any(p.is_symlink() for p in (folder, *folder.parents)):
        raise ValueError("symlink")
    folder.mkdir(mode=0o700, exist_ok=True)
    lock = folder / "managed-pairs.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        path = _state_path(home)
        try:
            state = _plain_json(path, STATE_LIMIT)
            if not isinstance(state, dict) or state.get("version") != 1:
                raise ValueError("state")
        except FileNotFoundError:
            state = {"version": 1, "rooms": {}, "pending": None, "day": "", "replies": 0,
                     "failures": 0, "retryAt": 0}
        yield state
        data = json.dumps(state, separators=(",", ":")).encode()
        if len(data) > STATE_LIMIT:
            raise ValueError("state-size")
        temp = folder / (".managed-" + str(os.getpid()))
        tfd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(tfd, "wb") as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp, path)
        finally:
            if temp.exists():
                temp.unlink()


def current_pairs(transport, config):
    result = transport(config, {"operation": "zzz.pairs"})
    if not isinstance(result, dict) or result.get("kind") != "zzz.pairs" or not isinstance(result.get("pairs"), list):
        raise ValueError("pairs")
    if len(result["pairs"]) > 20:
        raise ValueError("pairs-limit")
    pairs = {}
    for pair in result["pairs"]:
        if not isinstance(pair, dict) or pair.get("status") != "agent_messaging_enabled":
            raise ValueError("pair")
        room, request, epoch = pair.get("roomId"), pair.get("requestId"), pair.get("consentEpoch")
        if not isinstance(room, str) or not ID.fullmatch(room) or not isinstance(request, str) or not ID.fullmatch(request) or type(epoch) is not int or epoch < 1:
            raise ValueError("pair")
        if room in pairs:
            raise ValueError("pair-duplicate")
        pairs[room] = {"requestId": request, "consentEpoch": epoch}
    return pairs


def _budget_open(state: dict) -> bool:
    """A backwards UTC clock never refills the durable two-write budget."""
    today = datetime.now(timezone.utc).date().isoformat()
    day = state.get("day", "")
    if not isinstance(day, str) or (day and (len(day) != 10 or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", day))):
        return False
    if day:
        try:
            if datetime.fromisoformat(day).date().isoformat() != day:
                return False
        except ValueError:
            return False
    if day > today:
        return False
    if day < today:
        state["day"], state["replies"] = today, 0
    replies = state.get("replies")
    return type(replies) is int and 0 <= replies < 2 and _thread_ledger_valid(state)


def _thread_key(room: str, thread: str) -> str:
    return hashlib.sha256(json.dumps([room, thread], separators=(",", ":")).encode()).hexdigest()


def _thread_ledger_valid(state: dict) -> bool:
    counts = state.get("threadReplies", {})
    if not isinstance(counts, dict) or len(counts) > THREAD_LIMIT:
        return False
    return all(isinstance(key, str) and re.fullmatch(r"[0-9a-f]{64}", key)
               and type(value) is int and value in (1, 2) for key, value in counts.items())


def _thread_open(state: dict, room: str, thread: str) -> bool:
    if not _thread_ledger_valid(state):
        return False
    counts = state.get("threadReplies", {})
    key = _thread_key(room, thread)
    return counts.get(key, 0) < 2 and (key in counts or len(counts) < THREAD_LIMIT)


def _pause_open(state: dict, room: str | None = None) -> bool:
    now = datetime.now(timezone.utc).timestamp()
    global_until = state.get("policyPauseUntil", 0)
    rooms = state.get("policyPauseRooms", {})
    if (type(global_until) not in (int, float) or not 0 <= global_until < 10**12
            or not isinstance(rooms, dict) or len(rooms) > 20
            or any(not isinstance(key, str) or not ID.fullmatch(key)
                   or type(value) not in (int, float) or not 0 <= value < 10**12
                   for key, value in rooms.items())):
        return False
    return now >= global_until and (room is None or now >= rooms.get(room, 0))


def policy_attempt(home: Path, room: str | None = None) -> bool:
    """Reserve a 24-hour refusal window before entering the owner policy hook."""
    if room is not None and (not isinstance(room, str) or not ID.fullmatch(room)):
        return False
    try:
        with locked_state(home) as state:
            if not _pause_open(state, room):
                return False
            until = datetime.now(timezone.utc).timestamp() + POLICY_PAUSE_SECONDS
            if room is None:
                state["policyPauseUntil"] = until
            else:
                pauses = state.setdefault("policyPauseRooms", {})
                # Expired room refusals need no history. A full live set fails closed.
                now = datetime.now(timezone.utc).timestamp()
                for key in list(pauses):
                    if pauses[key] <= now:
                        del pauses[key]
                if room not in pauses and len(pauses) >= 20:
                    return False
                pauses[room] = until
            return True
    except Exception:
        return False


def policy_allowed(home: Path, room: str | None = None) -> None:
    """Only an explicit allow from the real shim clears a reserved pause."""
    with locked_state(home) as state:
        if room is None:
            state["policyPauseUntil"] = 0
        else:
            state.setdefault("policyPauseRooms", {}).pop(room, None)


def policy_refused(home: Path, room: str | None = None) -> None:
    """Start the full pause after a returned non-allow, including hook latency."""
    with locked_state(home) as state:
        until = datetime.now(timezone.utc).timestamp() + POLICY_PAUSE_SECONDS
        if room is None:
            state["policyPauseUntil"] = max(state.get("policyPauseUntil", 0), until)
        else:
            pauses = state.setdefault("policyPauseRooms", {})
            pauses[room] = max(pauses.get(room, 0), until)


def budget_available(home: Path) -> bool:
    """Check the local cap before polling or exposing a pair post to a model."""
    if not participation_on(home):
        return False
    try:
        with locked_state(home) as state:
            return _budget_open(state) and _pause_open(state)
    except Exception:
        return False


def finish_pending(home: Path, event: dict) -> None:
    """Forget only the event this run saw (silence or terminal pre-send denial)."""
    with locked_state(home) as state:
        pending = state.get("pending")
        keys = ("kind", "roomId", "threadId", "postId")
        if isinstance(pending, dict) and all(pending.get(key) == event.get(key) for key in keys):
            state["pending"] = None
            state["retryAt"] = 0


def reserve_reply(home: Path, transport, config, thread: str) -> bool:
    """Reserve the exact pending reply against current pair, daily and thread caps."""
    if not isinstance(thread, str) or not ID.fullmatch(thread) or not participation_on(home):
        return False
    try:
        pairs = current_pairs(transport, config)
        with locked_state(home) as state:
            pending = state.get("pending")
            if not _budget_open(state):
                return False
            if (not isinstance(pending, dict) or pending.get("kind") != "incoming"
                    or pending.get("threadId") != thread):
                return False
            room = pending.get("roomId")
            if not _pause_open(state, room) or not _thread_open(state, room, thread):
                state["pending"] = None
                return False
            if pairs.get(room) != {"requestId": pending.get("requestId"), "consentEpoch": pending.get("consentEpoch")}:
                state["pending"] = None
                return False
            if datetime.now(timezone.utc).timestamp() - pending.get("at", 0) > 1800:
                state["pending"] = None
                return False
            state["pending"] = None  # consume before network; uncertain writes are never repeated
            state["replies"] += 1
            key = _thread_key(room, thread)
            counts = state.setdefault("threadReplies", {})
            counts[key] = counts.get(key, 0) + 1
            return True
    except Exception:
        return False


def reserve_bootstrap(home: Path, transport, config, room: str):
    """Consume one empty-room invitation before writing; return a stable epoch key.

    A timeout after reservation sacrifices delivery rather than duplicating an
    introduction. The app also deduplicates the deterministic turn ID.
    """
    if not isinstance(room, str) or not ID.fullmatch(room) or not participation_on(home):
        return None
    try:
        pairs = current_pairs(transport, config)
        with locked_state(home) as state:
            pending = state.get("pending")
            if not _budget_open(state):
                return None
            if (not isinstance(pending, dict) or pending.get("kind") != "bootstrap"
                    or pending.get("roomId") != room):
                return None
            identity = {"requestId": pending.get("requestId"), "consentEpoch": pending.get("consentEpoch")}
            if pairs.get(room) != identity or datetime.now(timezone.utc).timestamp() - pending.get("at", 0) > 1800:
                state["pending"] = None
                return None
            changes = transport(config, {"operation": "zzz.changes", "room": room, "after": "0", "limit": 1})
            if (not isinstance(changes, dict) or changes.get("kind") != "zzz.changes"
                    or changes.get("items") != [] or changes.get("nextCursor")):
                state["pending"] = None
                return None
            state["pending"] = None
            state["replies"] += 1
            return str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(
                ["zzz-pair-intro", room, identity["requestId"], identity["consentEpoch"]])))
    except Exception:
        return None


def allow_managed_read(home: Path, transport, config, operation: str, target: str) -> bool:
    """Managed cron reads stay in current pairs; a thread read is exact-pending."""
    if not participation_on(home):
        return False
    try:
        pairs = current_pairs(transport, config)
        if operation == "zzz.changes":
            return target in pairs
        if operation != "zzz.read_thread":
            return False
        with locked_state(home) as state:
            pending = state.get("pending")
            if not isinstance(pending, dict) or pending.get("threadId") != target:
                return False
            room = pending.get("roomId")
            return (pairs.get(room) == {"requestId": pending.get("requestId"),
                                        "consentEpoch": pending.get("consentEpoch")}
                    and datetime.now(timezone.utc).timestamp() - pending.get("at", 0) <= 1800)
    except Exception:
        return False


def poll(home: Path, transport, config, installed):
    """Return at most one ID-only wake. First encounter drains history as baseline."""
    if not participation_on(home) or not installed(home, "zzzbot", "zzz.list_rooms"):
        return None
    with locked_state(home) as state:
        now = datetime.now(timezone.utc).timestamp()
        if not _budget_open(state) or not _pause_open(state):
            return None
        if state.get("retryAt", 0) > now:
            return None
        try:
            pairs = current_pairs(transport, config)
            rooms = state.get("rooms", {})
            if not isinstance(rooms, dict):
                raise ValueError("rooms")
            # A removed or newly consented pair cannot inherit an old cursor or pending reply.
            rooms = {room: value for room, value in rooms.items()
                     if room in pairs and isinstance(value, dict)
                     and value.get("requestId") == pairs[room]["requestId"]
                     and value.get("consentEpoch") == pairs[room]["consentEpoch"]}
            pending = state.get("pending")
            if isinstance(pending, dict) and (pending.get("roomId") not in pairs or
                pairs[pending["roomId"]] != {"requestId": pending.get("requestId"), "consentEpoch": pending.get("consentEpoch")}):
                state["pending"] = None
            elif isinstance(pending, dict):
                age = now - pending.get("at", 0)
                if (0 <= age <= 1800 and pending.get("kind") in ("incoming", "bootstrap")
                        and _pause_open(state, pending.get("roomId"))
                        and (pending.get("kind") == "bootstrap" or _thread_open(state, pending.get("roomId"), pending.get("threadId")))):
                    state["rooms"] = rooms
                    keys = ("kind", "roomId") if pending["kind"] == "bootstrap" else ("kind", "roomId", "threadId", "postId")
                    return {key: pending[key] for key in keys}
                state["pending"] = None
            event = None
            saw_item = False
            inspected = 0
            all_pairs = list(pairs.items())
            offset = state.get("nextPair", 0)
            if type(offset) is not int or offset < 0:
                offset = 0
            selected = [all_pairs[(offset + i) % len(all_pairs)] for i in range(min(2, len(all_pairs)))] if all_pairs else []
            state["nextPair"] = (offset + len(selected)) % len(all_pairs) if all_pairs else 0
            for room, identity in selected:
                if not _pause_open(state, room):
                    continue
                entry = rooms.get(room)
                baseline = entry is None or entry.get("baseline") is True
                first = entry is None
                if first:
                    entry = {**identity, "cursor": "0", "baseline": True}
                    rooms[room] = entry
                response = transport(config, {"operation": "zzz.changes", "room": room,
                                              "after": entry["cursor"], "limit": 20})
                if not isinstance(response, dict) or response.get("kind") != "zzz.changes" or not isinstance(response.get("items"), list):
                    raise ValueError("changes")
                items = response["items"][:20]
                saw_item = saw_item or bool(items)
                if first and not items and not response.get("nextCursor") and not state.get("pending"):
                    entry["bootstrapAttempted"] = True
                    # The empty first page is a complete baseline. A peer post
                    # arriving after our introduction must be examined normally.
                    entry["baseline"] = False
                    event = {"kind": "bootstrap", "roomId": room, **identity, "at": now}
                    break
                for change in items:
                    if inspected >= 3 or event:
                        break
                    if not isinstance(change, dict) or not isinstance(change.get("cursor"), (str, int)) or not str(change["cursor"]).isdigit():
                        raise ValueError("cursor")
                    entry["cursor"] = str(change["cursor"])
                    if baseline or event or state.get("pending") or change.get("kind") not in ("post.created", "thread.created"):
                        continue
                    post, thread = change.get("postId"), change.get("threadId")
                    if not isinstance(post, str) or not ID.fullmatch(post) or not isinstance(thread, str) or not ID.fullmatch(thread):
                        continue
                    if not _thread_open(state, room, thread):
                        continue
                    inspected += 1
                    # ZZZ read_thread's after cursor shares the room change
                    # sequence. Read only this new post, even in a long thread.
                    detail = transport(config, {"operation": "zzz.read_thread", "thread": thread,
                                                "after": str(max(0, int(entry["cursor"]) - 1)), "limit": 1})
                    posts = detail.get("posts") if isinstance(detail, dict) else None
                    if not isinstance(posts, list):
                        continue
                    target = next((p for p in posts if isinstance(p, dict) and p.get("id") == post), None)
                    if target is None or target.get("isOwn") is not False or target.get("redacted") is True:
                        continue
                    event = {"kind": "incoming", "roomId": room, **identity, "threadId": thread, "postId": post, "at": now}
                entry["baseline"] = bool(response.get("nextCursor")) if baseline else False
                if event or inspected >= 3:
                    break
            state["rooms"] = rooms
            state["failures"] = 0
            state["retryAt"] = now if saw_item else now + (1200 if pairs else 3600)
            if event:
                # Current authority again immediately before offering an agent turn.
                if current_pairs(transport, config).get(event["roomId"]) == {"requestId": event["requestId"], "consentEpoch": event["consentEpoch"]}:
                    state["pending"] = event
                    keys = ("kind", "roomId") if event["kind"] == "bootstrap" else ("kind", "roomId", "threadId", "postId")
                    return {key: event[key] for key in keys}
            return None
        except Exception:
            state["failures"] = min(int(state.get("failures", 0)) + 1, 8)
            state["retryAt"] = now + min(21600, 60 * 2 ** state["failures"])
            return None


if __name__ == "__main__":
    # The Hermes pre-run script invokes this file. No body or credential is printed.
    import importlib.util
    import sys
    package = "village_bridge"
    spec = importlib.util.spec_from_file_location(package, Path(__file__).with_name("__init__.py"))
    bridge = importlib.util.module_from_spec(spec)
    sys.modules[package] = bridge
    spec.loader.exec_module(bridge)
    home = bridge.hermes_home()
    try:
        config = _plain_json(home / "village-bridge.json", 2048)
        # The package's own copy of this module (loaded by __init__), so its gate reads the shared projection reader.
        managed = sys.modules[package + "._zzz_managed"]
        event = managed.poll(home, lambda cfg, payload: bridge.transport(cfg, payload, timeout=10), config, bridge.installed)
    except Exception:
        event = None
    if event:
        print(json.dumps({"event": event}, separators=(",", ":")))
        print('{"wakeAgent":true}')
    else:
        print('{"wakeAgent":false,"reason":"idle"}')
