"""DATA-82: `memory.snapshot` — the memory files backed up at session finalize.

What is packed (and what never is), determinism, "unchanged uploads nothing",
fail-open on every upload failure, the event against ingest's registered
schema, and the single-flight thread and atexit drain.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

TENANT = "t_Dogfood-1"
TOKEN = "backup-token-for-tests-0123456789"
NOW = 1_790_000_000.0  # 2026-09-21T14:13:20Z

#: Files the snapshot must contain, relative to $HERMES_HOME.
ALLOWED = {
    "MEMORY.md": b"# Long-term\n- likes jazz\n",
    "USER.md": b"# Landing profile\nName: A.\n",
    "memories/MEMORY.md": b"tool memory \xc2\xa7 entry\n",
    "memories/USER.md": b"tool user profile\n",
    "memory/2026-09-20.md": b"- met B at the cafe\n",
    "memory/2026-09-21.md": b"- [gate] index-network: ok\n",
}

#: Things that sit beside them and must never leave in a snapshot.
DISTRACTORS = {
    ".recall/index.sqlite": b"SQLite format 3\x00RECALL-INDEX",
    ".recall/query-hash.key": b"RECALL-KEY-" + b"a" * 64,
    "av-events/hash.key": b"b" * 64,
    "av-events/backup.json": b"{}",
    "av-events/buffer/1-1-0001.jsonl": b'{"event_type":"x"}\n',
    "memory/heartbeat-state.json": b'{"LEDGER":1}',
    "memory/welcome-state.json": b'{"LEDGER":2}',
    "memory/digest-outgoing.md": b"DRAFT-NOT-A-DAILY-NOTE\n",
    "memory/2026-09-21.md.bak": b"BACKUP-COPY\n",
    "memory/notes/2026-09-01.md": b"NESTED-NOTE\n",
    "memory/2026-9-1.md": b"BAD-DATE-SHAPE\n",
    "SOUL.md": b"SOUL\n",
    "AGENTS.md": b"AGENTS\n",
    "state.db": b"STATE-DB",
    "memories/notes.md": b"OTHER-MEMORIES-FILE\n",
}

#: The ingest schema for `memory.snapshot@1`, copied literally from
#: agentvillage-data `src/schemas/index.ts` (8f97ddb): `sha256Hex`,
#: `memoryRef`, `memoryBytes` (max INT64_SAFE), `memoryCount` (max INT32_MAX).
MEMORY_SNAPSHOT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["bytes", "file_count", "content_hash", "manifest_ref"],
    "properties": {
        "bytes": {"type": ["integer", "null"], "minimum": 0, "maximum": 9007199254740991},
        "file_count": {"type": ["integer", "null"], "minimum": 0, "maximum": 2147483647},
        "content_hash": {"type": ["string", "null"], "pattern": "^[0-9a-f]{64}$"},
        "manifest_ref": {"type": ["string", "null"], "pattern": "^[a-z0-9_-]{1,32}/[0-9a-f]{64}$"},
    },
}


def validate(schema: dict, value) -> list[str]:
    """The subset of JSON Schema the memory schemas use. Returns problems."""
    problems: list[str] = []
    types = schema.get("type")
    if types is not None:
        types = types if isinstance(types, list) else [types]
        ok = False
        for t in types:
            if t == "null" and value is None:
                ok = True
            elif t == "object" and isinstance(value, dict):
                ok = True
            elif t == "string" and isinstance(value, str):
                ok = True
            elif t == "integer" and isinstance(value, int) and not isinstance(value, bool):
                ok = True
        if not ok:
            return [f"type {types} vs {type(value).__name__}"]
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                problems.append(f"missing {key}")
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            problems += [f"extra {k}" for k in value if k not in props]
        for key, sub in props.items():
            if key in value:
                problems += [f"{key}: {p}" for p in validate(sub, value[key])]
    if isinstance(value, str) and "pattern" in schema and not re.search(schema["pattern"], value):
        problems.append("pattern")
    if isinstance(value, int) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            problems.append("minimum")
        if "maximum" in schema and value > schema["maximum"]:
            problems.append("maximum")
    return problems


def write_tree(home: Path, files: dict) -> None:
    for rel, data in files.items():
        path = home / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


class Uploads:
    """A fake uploader: records every PUT, answers from a script."""

    def __init__(self, results=None, raises: BaseException | None = None) -> None:
        self.calls: list[dict] = []
        self.results = list(results or [])
        self.raises = raises

    def __call__(self, url, token, tenant, date, name, body, content_type, timeout):
        from importlib import import_module

        core = import_module("hermes_plugins.av_events._core")
        self.calls.append(
            {"url": url, "token": token, "tenant": tenant, "date": date, "name": name, "body": body,
             "content_type": content_type, "timeout": timeout}
        )
        if self.raises is not None:
            raise self.raises
        status = self.results.pop(0) if self.results else 201
        return core.SendResult(200 <= status < 300, status)

    def by_prefix(self, prefix: str) -> list[dict]:
        return [c for c in self.calls if c["name"].startswith(prefix)]


@pytest.fixture()
def backup_env(home, monkeypatch):
    monkeypatch.setenv("AV_BACKUP_URL", "https://backup.invalid")
    monkeypatch.setenv("AV_BACKUP_TOKEN", TOKEN)
    monkeypatch.setenv("AV_TENANT_ID", TENANT)
    monkeypatch.setenv("AV_EVENTS_TOKEN", "events-token-for-tests")
    return home


@pytest.fixture()
def collector(plugin, backup_env):
    col = plugin.Collector()
    plugin._COLLECTOR = col
    col.backup_uploader = Uploads()
    yield col
    col._stop.set()
    col._wake.set()


def backup_mod():
    return sys.modules["hermes_plugins.av_events._backup"]


def tar_members(archive: bytes) -> dict[str, bytes]:
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(archive)), mode="r:") as tar:
        return {m.name: tar.extractfile(m).read() for m in tar.getmembers()}


def snapshots_in(av, col) -> list[dict]:
    return [e for e in av.read_buffer(col) if e["event_type"] == "memory.snapshot"]


# --------------------------------------------------------------------------
# What is packed
# --------------------------------------------------------------------------


def test_snapshot_holds_exactly_the_memory_files(collector, backup_env):
    write_tree(backup_env, {**ALLOWED, **DISTRACTORS})
    assert collector.snapshot_once(now=NOW) == "uploaded"
    archive = collector.backup_uploader.by_prefix("memory.")[0]["body"]
    members = tar_members(archive)
    assert members == ALLOWED
    raw = gzip.decompress(archive)
    for secret in DISTRACTORS.values():
        assert secret not in raw


def test_recall_index_and_ledgers_are_never_included_even_through_links(collector, backup_env):
    write_tree(backup_env, {**ALLOWED, **DISTRACTORS})
    # A daily-note name that is a symlink to the recall index, and one that is
    # a hard link to the plugin's HMAC key: neither may be read.
    os.symlink(backup_env / ".recall" / "index.sqlite", backup_env / "memory" / "2026-09-22.md")
    os.link(backup_env / "av-events" / "hash.key", backup_env / "memory" / "2026-09-23.md")
    os.symlink(backup_env / ".recall" / "query-hash.key", backup_env / "memories" / "USER.md.tmp")
    assert collector.snapshot_once(now=NOW) == "uploaded"
    members = tar_members(collector.backup_uploader.by_prefix("memory.")[0]["body"])
    assert set(members) == set(ALLOWED)
    assert collector.counters.get("backup_skipped_unreadable") == 1  # the symlink (O_NOFOLLOW)
    assert collector.counters.get("backup_skipped_hard_linked") == 1


def test_a_symlinked_memory_directory_is_not_followed(collector, backup_env):
    write_tree(backup_env, {"MEMORY.md": b"top\n", ".recall/2026-09-20.md": b"RECALL-DERIVED\n"})
    os.symlink(backup_env / ".recall", backup_env / "memory")
    (backup_env / "real").mkdir()
    (backup_env / "real" / "USER.md").write_bytes(b"ELSEWHERE\n")
    os.symlink(backup_env / "real", backup_env / "memories")
    assert collector.snapshot_once(now=NOW) == "uploaded"
    members = tar_members(collector.backup_uploader.by_prefix("memory.")[0]["body"])
    assert members == {"MEMORY.md": b"top\n"}


def test_a_fifo_or_directory_named_like_a_memory_file_is_skipped(collector, backup_env):
    write_tree(backup_env, {"USER.md": b"u\n"})
    os.mkfifo(backup_env / "MEMORY.md")
    (backup_env / "memory").mkdir()
    (backup_env / "memory" / "2026-09-20.md").mkdir()
    assert collector.snapshot_once(now=NOW) == "uploaded"
    members = tar_members(collector.backup_uploader.by_prefix("memory.")[0]["body"])
    assert members == {"USER.md": b"u\n"}
    assert collector.counters.get("backup_skipped_not_regular") == 2


def test_an_oversized_file_is_skipped_not_truncated(collector, backup_env, monkeypatch):
    monkeypatch.setattr(backup_mod(), "MAX_FILE_BYTES", 16)
    write_tree(backup_env, {"MEMORY.md": b"x" * 17, "USER.md": b"small\n"})
    assert collector.snapshot_once(now=NOW) == "uploaded"
    members = tar_members(collector.backup_uploader.by_prefix("memory.")[0]["body"])
    assert members == {"USER.md": b"small\n"}
    assert collector.counters.get("backup_skipped_too_large") == 1


def test_manifest_lists_every_file_with_hash_size_and_mtime(collector, backup_env):
    write_tree(backup_env, ALLOWED)
    os.utime(backup_env / "MEMORY.md", ns=(1_780_000_000_123_000_000, 1_780_000_000_123_000_000))
    assert collector.snapshot_once(now=NOW) == "uploaded"
    uploads = collector.backup_uploader
    archive_call = uploads.by_prefix("memory.")[0]
    manifest_call = uploads.by_prefix("manifest.")[0]
    manifest = json.loads(manifest_call["body"])
    archive_sha = hashlib.sha256(archive_call["body"]).hexdigest()
    assert archive_call["name"] == f"memory.{archive_sha}.tar.gz"
    assert manifest_call["name"] == f"manifest.{hashlib.sha256(manifest_call['body']).hexdigest()}.json"
    assert manifest["schema"] == "memory_manifest.v1"
    assert manifest["tenant_id"] == TENANT
    assert manifest["date"] == "2026-09-21" == archive_call["date"] == manifest_call["date"]
    assert manifest["created_at"] == "2026-09-21T14:13:20.000Z"
    assert manifest["plugin_version"] == "0.1.0"
    assert manifest["archive"] == {"name": archive_call["name"], "sha256": archive_sha, "bytes": len(archive_call["body"])}
    assert manifest["file_count"] == len(ALLOWED)
    assert manifest["partial"] is False
    assert manifest["skipped"] == {"count": 0, "reasons": {}}
    assert manifest["total_bytes"] == sum(len(v) for v in ALLOWED.values())
    by_path = {f["path"]: f for f in manifest["files"]}
    assert [f["path"] for f in manifest["files"]] == sorted(ALLOWED)
    for rel, data in ALLOWED.items():
        assert by_path[rel]["sha256"] == hashlib.sha256(data).hexdigest()
        assert by_path[rel]["bytes"] == len(data)
    assert by_path["MEMORY.md"]["mtime_ms"] == 1_780_000_000_123
    # Archive before the manifest that names it; tenant used exactly as given.
    assert [c["name"].split(".")[0] for c in uploads.calls] == ["memory", "manifest"]
    assert {c["tenant"] for c in uploads.calls} == {TENANT}
    assert {c["token"] for c in uploads.calls} == {TOKEN}
    assert archive_call["content_type"] == "application/gzip"


# --------------------------------------------------------------------------
# Determinism and "unchanged uploads nothing"
# --------------------------------------------------------------------------


def test_same_files_give_the_same_archive_whatever_the_mtimes_or_the_clock(plugin, tmp_path):
    b = backup_mod()
    write_tree(tmp_path / "c", ALLOWED)
    files = b.collect(str(tmp_path / "c")).files
    a_second_apart = [b.build_snapshot(files, TENANT, NOW), b.build_snapshot(files, TENANT, NOW + 1)]
    assert a_second_apart[0].archive == a_second_apart[1].archive
    assert a_second_apart[0].created_at != a_second_apart[1].created_at
    one, two = tmp_path / "one", tmp_path / "two"
    write_tree(one, ALLOWED)
    write_tree(two, dict(reversed(list(ALLOWED.items()))))
    for path in two.rglob("*.md"):
        os.utime(path, (1_600_000_000, 1_600_000_000))
    first = b.build_snapshot(b.collect(str(one)).files, TENANT, NOW)
    second = b.build_snapshot(b.collect(str(two)).files, TENANT, NOW + 86_400 * 3)
    assert first.archive == second.archive
    assert first.content_hash == second.content_hash
    write_tree(two, {"memory/2026-09-21.md": ALLOWED["memory/2026-09-21.md"] + b"!"})
    third = b.build_snapshot(b.collect(str(two)).files, TENANT, NOW)
    assert third.content_hash != first.content_hash


def test_an_unchanged_workspace_uploads_nothing_and_emits_nothing(collector, backup_env, av):
    write_tree(backup_env, ALLOWED)
    assert collector.snapshot_once(now=NOW) == "uploaded"
    assert len(collector.backup_uploader.calls) == 2
    assert len(snapshots_in(av, collector)) == 1
    os.utime(backup_env / "MEMORY.md", (NOW + 5, NOW + 5))  # touched, not changed
    assert collector.snapshot_once(now=NOW + 3600) == "unchanged"
    assert collector.snapshot_once(now=NOW + 7200) == "unchanged"
    assert len(collector.backup_uploader.calls) == 2
    assert len(snapshots_in(av, collector)) == 1
    write_tree(backup_env, {"memory/2026-09-22.md": b"- a new day\n"})
    assert collector.snapshot_once(now=NOW + 86_400) == "uploaded"
    assert len(collector.backup_uploader.calls) == 4
    events = snapshots_in(av, collector)
    assert len(events) == 2
    assert events[0]["payload"]["content_hash"] != events[1]["payload"]["content_hash"]
    assert collector.backup_uploader.calls[-1]["date"] == "2026-09-22"


def test_a_new_destination_is_not_unchanged(collector, backup_env, monkeypatch):
    write_tree(backup_env, ALLOWED)
    assert collector.snapshot_once(now=NOW) == "uploaded"
    monkeypatch.setenv("AV_BACKUP_URL", "https://other-backup.invalid")
    collector.reload_config()
    assert collector.snapshot_once(now=NOW + 60) == "uploaded"
    assert len(collector.backup_uploader.calls) == 4


def test_an_empty_workspace_uploads_nothing(collector, backup_env):
    write_tree(backup_env, DISTRACTORS)
    assert collector.snapshot_once(now=NOW) == "empty"
    assert collector.backup_uploader.calls == []
    assert collector.counters.get("backup_empty") == 1
    assert not (backup_env / "av-events" / "backup.json").exists() or json.loads(
        (backup_env / "av-events" / "backup.json").read_text()
    ) == {}


def test_an_archive_over_the_cap_is_not_uploaded(collector, backup_env, monkeypatch):
    monkeypatch.setenv("AV_BACKUP_MAX_BYTES", "64")
    collector.reload_config()
    write_tree(backup_env, ALLOWED)
    assert collector.snapshot_once(now=NOW) == "too_large"
    assert collector.backup_uploader.calls == []
    assert collector.counters.get("backup_too_large") == 1


# --------------------------------------------------------------------------
# The event
# --------------------------------------------------------------------------


def test_event_payload_validates_against_the_ingest_schema(collector, backup_env, av):
    write_tree(backup_env, ALLOWED)
    assert collector.snapshot_once(now=NOW) == "uploaded"
    (event,) = snapshots_in(av, collector)
    assert validate(MEMORY_SNAPSHOT_SCHEMA, event["payload"]) == []
    manifest_call = collector.backup_uploader.by_prefix("manifest.")[0]
    archive_call = collector.backup_uploader.by_prefix("memory.")[0]
    assert event["payload"] == {
        "bytes": sum(len(v) for v in ALLOWED.values()),
        "file_count": len(ALLOWED),
        "content_hash": hashlib.sha256(archive_call["body"]).hexdigest(),
        "manifest_ref": "backup/" + hashlib.sha256(manifest_call["body"]).hexdigest(),
    }
    assert event["event_type"] == "memory.snapshot"
    assert event["schema_version"] == 1
    assert event["evidence_class"] == "agent_report"
    assert event["occurred_at"] == "2026-09-21T14:13:20.000Z"


def test_the_validator_would_catch_a_wrong_payload():
    good = {"bytes": 1, "file_count": 1, "content_hash": "a" * 64, "manifest_ref": "backup/" + "b" * 64}
    assert validate(MEMORY_SNAPSHOT_SCHEMA, good) == []
    assert validate(MEMORY_SNAPSHOT_SCHEMA, {**good, "files": ["MEMORY.md"]}) == ["extra files"]
    assert validate(MEMORY_SNAPSHOT_SCHEMA, {**good, "manifest_ref": "backup/2026-09-21/manifest.json"})
    assert validate(MEMORY_SNAPSHOT_SCHEMA, {**good, "bytes": -1})
    assert validate(MEMORY_SNAPSHOT_SCHEMA, {k: v for k, v in good.items() if k != "content_hash"})


def test_an_inert_emit_is_owed_and_sent_later_without_a_second_upload(plugin, backup_env, monkeypatch, av):
    monkeypatch.delenv("AV_EVENTS_TOKEN")
    col = plugin.Collector()
    col.backup_uploader = Uploads()
    try:
        write_tree(backup_env, ALLOWED)
        assert col.snapshot_once(now=NOW) == "uploaded"  # the backup does not need the events token
        assert len(col.backup_uploader.calls) == 2
        state = json.loads((backup_env / "av-events" / "backup.json").read_text())
        assert state["emitted"] is False
        assert av.read_buffer(col) == []
        monkeypatch.setenv("AV_EVENTS_TOKEN", "events-token-for-tests")
        col.reload_config()
        assert col.snapshot_once(now=NOW + 60) == "emitted"
        assert len(col.backup_uploader.calls) == 2
        (event,) = snapshots_in(av, col)
        assert event["occurred_at"] == state["created_at"]
        assert event["payload"]["manifest_ref"] == "backup/" + state["manifest_sha256"]
        assert col.snapshot_once(now=NOW + 120) == "unchanged"
        assert len(snapshots_in(av, col)) == 1
    finally:
        col._stop.set()


def test_the_backup_token_never_lands_on_disk(collector, backup_env):
    write_tree(backup_env, ALLOWED)
    assert collector.snapshot_once(now=NOW) == "uploaded"
    for path in (backup_env / "av-events").rglob("*"):
        if path.is_file():
            assert TOKEN.encode() not in path.read_bytes()
    assert collector.config.backup_url not in (backup_env / "av-events" / "backup.json").read_text()


# --------------------------------------------------------------------------
# Fail-open
# --------------------------------------------------------------------------


@pytest.mark.parametrize("statuses", [[500], [201, 503], [413]])
def test_a_failed_upload_is_counted_and_retried_next_time(collector, backup_env, av, statuses):
    write_tree(backup_env, ALLOWED)
    collector.backup_uploader = Uploads(results=statuses)
    assert collector.snapshot_once(now=NOW) == "failed"
    assert collector.counters.get("backup_upload_failed") == 1
    assert snapshots_in(av, collector) == []
    assert not (backup_env / "av-events" / "backup.json").exists()
    assert collector.snapshot_once(now=NOW + 60) == "uploaded"
    assert len(snapshots_in(av, collector)) == 1


def test_an_uploader_that_raises_never_escapes(collector, backup_env, av):
    write_tree(backup_env, ALLOWED)
    collector.backup_uploader = Uploads(raises=RuntimeError("boom"))
    assert collector.snapshot_once(now=NOW) == "error"
    assert collector.counters.get("backup_error") == 1
    assert snapshots_in(av, collector) == []


def test_an_unreachable_route_over_real_http_is_a_failure_not_an_exception(collector, backup_env, monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = server.server_address[1]
    server.server_close()  # nothing listens there now
    monkeypatch.setenv("AV_BACKUP_URL", f"http://127.0.0.1:{port}")
    collector.reload_config()
    collector.backup_uploader = None
    write_tree(backup_env, ALLOWED)
    assert collector.snapshot_once(now=NOW, timeout=2.0) == "failed"
    assert collector.counters.get("backup_upload_failed") == 1


@pytest.mark.parametrize(("status", "counter", "cooldown"), [(401, "backup_upload_401", 3600), (403, "backup_forbidden", 86400)])
def test_an_auth_refusal_backs_off(collector, backup_env, status, counter, cooldown):
    write_tree(backup_env, ALLOWED)
    collector.backup_uploader = Uploads(results=[status])
    assert collector.snapshot_once(now=NOW) == "failed"
    assert collector.counters.get(counter) == 1
    left = collector.backup_blocked_until - time.monotonic()
    assert cooldown - 5 < left <= cooldown
    assert collector.snapshot_once(now=NOW + 60) == "blocked"
    assert len(collector.backup_uploader.calls) == 1


def test_finalize_with_a_raising_uploader_still_ends_the_session(plugin, ctx, backup_env, av):
    plugin.register(ctx)
    col = plugin._COLLECTOR
    col.backup_uploader = Uploads(raises=MemoryError())
    write_tree(backup_env, ALLOWED)
    ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
    assert ctx.fire("on_session_finalize", session_id="s1") == []
    thread = col._backup_thread
    if thread is not None:
        thread.join(5)
    assert "session.ended" in av.types_of(av.read_buffer(col))
    assert col.counters.get("backup_error") == 1
    assert col.total_failures == 0  # never counted against the hook breaker


def test_a_request_that_raises_is_swallowed(collector, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("no threads")

    monkeypatch.setattr(threading, "Thread", boom)
    assert collector.request_snapshot() is False
    assert collector.counters.get("backup_error") == 1


# --------------------------------------------------------------------------
# Switches
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "setting",
    [
        ("AV_BACKUP_URL", None),
        ("AV_BACKUP_TOKEN", None),
        ("AV_BACKUP_URL", ""),
        ("AV_TENANT_ID", "a/../b"),
        ("AV_EVENTS_ENABLED", "0"),
        ("AV_HOOKS_DISABLED", "memory_snapshot"),
    ],
)
def test_snapshots_are_off_unless_fully_configured(plugin, ctx, backup_env, monkeypatch, av, setting):
    name, value = setting
    if value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, value)
    plugin.register(ctx)
    col = plugin._COLLECTOR
    col.backup_uploader = Uploads()
    write_tree(backup_env, ALLOWED)
    ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
    ctx.fire("on_session_finalize", session_id="s1")
    assert col._backup_thread is None
    assert col.snapshot_once(now=NOW) == "unconfigured"
    assert col.backup_uploader.calls == []
    assert not (backup_env / "av-events" / "backup.json").exists()


def test_the_tenant_comes_from_tenant_id_when_av_tenant_id_is_unset(collector, backup_env, monkeypatch):
    monkeypatch.delenv("AV_TENANT_ID")
    monkeypatch.setenv("TENANT_ID", "Tenant-UPPER")
    collector.reload_config()
    write_tree(backup_env, ALLOWED)
    assert collector.snapshot_once(now=NOW) == "uploaded"
    assert {c["tenant"] for c in collector.backup_uploader.calls} == {"Tenant-UPPER"}


# --------------------------------------------------------------------------
# The thread: finalize → one pass; coalescing; atexit drain
# --------------------------------------------------------------------------


def test_finalize_snapshots_on_a_background_thread(plugin, ctx, backup_env, av):
    plugin.register(ctx)
    col = plugin._COLLECTOR
    started = threading.Event()
    release = threading.Event()
    inner = Uploads()

    def slow(*args):
        started.set()
        release.wait(5)
        return inner(*args)

    col.backup_uploader = slow
    write_tree(backup_env, ALLOWED)
    ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
    t0 = time.perf_counter()
    ctx.fire("on_session_finalize", session_id="s1")
    assert time.perf_counter() - t0 < 1.0  # the hook did not wait for the upload
    assert started.wait(5)
    thread = col._backup_thread
    assert thread is not None and thread.name == "av-events-backup" and thread.daemon
    # Two more finalizes while the pass runs: coalesced into one more pass.
    ctx.fire("on_session_start", session_id="s2", model="m", platform="telegram")
    ctx.fire("on_session_finalize", session_id="s2")
    ctx.fire("on_session_start", session_id="s3", model="m", platform="telegram")
    ctx.fire("on_session_finalize", session_id="s3")
    assert col._backup_thread is thread
    release.set()
    thread.join(5)
    assert not thread.is_alive()
    assert col._backup_thread is None
    assert len(inner.calls) == 2  # first pass uploaded; the coalesced pass found it unchanged
    assert len(snapshots_in(av, col)) == 1


def test_shutdown_drains_a_pending_snapshot_before_the_final_flush(plugin, backup_env, av, monkeypatch):
    with av.StubIngest() as ingest:
        monkeypatch.setenv("AV_EVENTS_URL", ingest.url)
        col = plugin.Collector()
        col.backup_uploader = Uploads()
        write_tree(backup_env, ALLOWED)
        with col._backup_lock:
            col._backup_pending = True  # requested, thread not yet run (e.g. died with the process)
        col._ensure_buffer()
        col.shutdown()
        assert len(col.backup_uploader.calls) == 2
        assert "memory.snapshot" in [e["event_type"] for e in ingest.received]


def test_plugin_version_is_one_string(plugin, av):
    manifest = (av.PLUGIN_DIR / "plugin.yaml").read_text()
    assert re.search(r"^version: (\S+)$", manifest, re.M).group(1) == plugin.__version__
    assert backup_mod().PLUGIN_VERSION == plugin.__version__


# --------------------------------------------------------------------------
# End to end over HTTP, against a stub of the DATA-93 route
# --------------------------------------------------------------------------


class StubBackupRoute:
    """The PUT half of the DATA-93 contract: bearer, name shapes, body hash,
    idempotent (201 new, 200 already held), manifest refused before its archive."""

    NAME = re.compile(r"^(memory\.([0-9a-f]{64})\.tar\.gz|manifest\.([0-9a-f]{64})\.json)$")

    def __init__(self, token: str) -> None:
        self.objects: dict[str, bytes] = {}
        self.statuses: list[int] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):  # noqa: N802
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                status = outer.handle(self.path, self.headers.get("Authorization") or "", body)
                outer.statuses.append(status)
                self.send_response(status)
                self.end_headers()

            def log_message(self, *args):  # noqa: A003
                return

        self.token = token
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def handle(self, path: str, auth: str, body: bytes) -> int:
        if auth != f"Bearer {self.token}":
            return 401
        parts = path.split("/")
        if len(parts) != 6 or parts[1:3] != ["v1", "backup"] or not re.match(r"^\d{4}-\d{2}-\d{2}$", parts[4]):
            return 404
        match = self.NAME.match(parts[5])
        if not match:
            return 400
        if hashlib.sha256(body).hexdigest() != (match.group(2) or match.group(3)):
            return 400
        key = f"backup/{parts[3]}/{parts[4]}/{parts[5]}"
        if match.group(3):
            doc = json.loads(body)
            if f"backup/{parts[3]}/{parts[4]}/{doc['archive']['name']}" not in self.objects:
                return 409
        if key in self.objects:
            return 200
        self.objects[key] = body
        return 201

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"


def test_end_to_end_over_http(plugin, ctx, backup_env, monkeypatch, av):
    with StubBackupRoute(TOKEN) as route:
        monkeypatch.setenv("AV_BACKUP_URL", route.url + "/v1/backup/")  # the route form is accepted too
        plugin.register(ctx)
        col = plugin._COLLECTOR
        write_tree(backup_env, {**ALLOWED, **DISTRACTORS})
        ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
        ctx.fire("on_session_finalize", session_id="s1")
        col._backup_thread.join(10)
        assert route.statuses == [201, 201]
        keys = sorted(route.objects)
        assert len(keys) == 2
        assert all(k.startswith(f"backup/{TENANT}/") for k in keys)
        manifest_key = next(k for k in keys if "/manifest." in k)
        manifest = json.loads(route.objects[manifest_key])
        archive = route.objects[f"backup/{TENANT}/{manifest['date']}/{manifest['archive']['name']}"]
        assert tar_members(archive) == ALLOWED
        (event,) = snapshots_in(av, col)
        assert event["payload"]["manifest_ref"] == "backup/" + manifest_key.rsplit(".", 2)[1]
        # Lose the local record (a recreate): the next pass re-PUTs, the route
        # answers 200 for what it already holds, and nothing is stored twice.
        (backup_env / "av-events" / "backup.json").unlink()
        ctx.fire("on_session_start", session_id="s2", model="m", platform="telegram")
        ctx.fire("on_session_finalize", session_id="s2")
        col._backup_thread.join(10)
        assert route.statuses[2] == 200  # same archive bytes
        assert len([k for k in route.objects if "/memory." in k]) == 1


# --------------------------------------------------------------------------
# Refutation fixes (DATA-82 review)
# --------------------------------------------------------------------------

VECTORS = json.loads((Path(__file__).parent / "vectors" / "daily_note_names.json").read_text(encoding="utf-8"))

#: The literal accept vector from agentvillage-data `tests/chain-schemas.test.ts`
#: (`memory.snapshot`: `H = "ab".repeat(32)`, `REF = backup/${"cd".repeat(32)}`),
#: and three of its reject vectors.
DATA_REPO_ACCEPT = {"bytes": 18_432, "file_count": 7, "content_hash": "ab" * 32, "manifest_ref": "backup/" + "cd" * 32}
DATA_REPO_REJECT = [
    {"bytes": -1, "file_count": 7, "content_hash": "ab" * 32, "manifest_ref": "backup/" + "cd" * 32},
    {"bytes": 1, "file_count": 1, "content_hash": "AB" * 32, "manifest_ref": "backup/" + "cd" * 32},
    {"bytes": 1, "file_count": 1, "content_hash": "ab" * 32, "manifest_ref": "memories/bob_salary_120k.md"},
]


def test_the_data_repo_vectors_agree_with_the_pasted_schema():
    assert validate(MEMORY_SNAPSHOT_SCHEMA, DATA_REPO_ACCEPT) == []
    for payload in DATA_REPO_REJECT:
        assert validate(MEMORY_SNAPSHOT_SCHEMA, payload) != []


@pytest.mark.parametrize("name", VECTORS["accept"])
def test_daily_note_vectors_accept(plugin, name):
    assert backup_mod().DAILY_NOTE.fullmatch(name)


@pytest.mark.parametrize("name", VECTORS["reject"])
def test_daily_note_vectors_reject(plugin, name):
    assert not backup_mod().DAILY_NOTE.fullmatch(name)


def test_oddly_named_notes_on_disk_are_never_collected(plugin, tmp_path):
    for name in VECTORS["accept"] + VECTORS["reject"]:
        if name and "/" not in name and name not in (".", ".."):
            write_tree(tmp_path, {f"memory/{name}": b"x\n"})
    paths = [f.path for f in backup_mod().collect(str(tmp_path)).files]
    assert paths == sorted(f"memory/{n}" for n in VECTORS["accept"])


def test_a_tenant_with_a_trailing_newline_is_not_a_tenant(plugin):
    assert backup_mod().TENANT_SEGMENT.fullmatch("abc\n") is None
    assert backup_mod().TENANT_SEGMENT.fullmatch("t_Dogfood-1")


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://ingest.example.com", True),
        ("https://ingest.example.com/v1/backup", True),
        ("http://ingest.railway.internal:8080", True),
        ("http://127.0.0.1:9", True),
        ("http://localhost", True),
        ("http://ingest.example.com", False),
        ("http://railway.internal.evil.com", False),
        ("https://user:pw@ingest.example.com", False),
        ("https://ingest.example.com/?x=1", False),
        ("ftp://ingest.example.com", False),
        ("https://", False),
        ("https://host:notaport", False),
    ],
)
def test_backup_url_rule(plugin, url, ok):
    assert backup_mod().backup_url_allowed(url) is ok


def test_a_refused_url_disables_snapshots_and_is_counted(plugin, backup_env, monkeypatch):
    monkeypatch.setenv("AV_BACKUP_URL", "http://ingest.example.com")
    col = plugin.Collector()
    assert col.config.backup_configured is False
    assert col.request_snapshot() is False
    assert col.counters.get("backup_url_refused") == 1


def test_the_backup_url_is_never_read_from_the_dotenv(plugin, backup_env, monkeypatch):
    monkeypatch.delenv("AV_BACKUP_URL")
    (backup_env / ".env").write_text("AV_BACKUP_URL=https://attacker.example.com\n", encoding="utf-8")
    col = plugin.Collector()
    assert col.config.backup_url == ""
    assert col.config.backup_configured is False
    assert col.config.backup_token == TOKEN  # other variables still fall back as before


def test_the_gzip_header_is_pinned(plugin):
    archive = backup_mod().build_archive([backup_mod().MemoryFile("MEMORY.md", b"m\n", 1)])
    assert archive[:4] == b"\x1f\x8b\x08\x00"
    assert archive[4:8] == b"\x00\x00\x00\x00"  # mtime
    assert archive[9] == 255  # OS: unknown
    assert gzip.decompress(archive) != b""


def test_two_passes_a_second_apart_by_the_clock_are_unchanged(collector, backup_env, monkeypatch):
    b = backup_mod()
    write_tree(backup_env, ALLOWED)
    monkeypatch.setattr(b.time, "time", lambda: NOW)
    assert collector.snapshot_once() == "uploaded"
    monkeypatch.setattr(b.time, "time", lambda: NOW + 1)
    assert collector.snapshot_once() == "unchanged"
    assert len(collector.backup_uploader.calls) == 2


def test_the_byte_budget_stops_reading_and_marks_the_snapshot_partial(collector, backup_env, monkeypatch, av):
    notes = {f"memory/2026-09-{d:02d}.md": b"n" * 100 for d in range(1, 11)}
    write_tree(backup_env, {"MEMORY.md": b"m" * 100, **notes})
    monkeypatch.setenv("AV_BACKUP_MAX_BYTES", "450")
    collector.reload_config()
    reads: list[int] = []
    real_read = os.read

    def counting_read(fd, n):
        data = real_read(fd, n)
        reads.append(len(data))
        return data

    monkeypatch.setattr(backup_mod().os, "read", counting_read)
    assert collector.snapshot_once(now=NOW) == "uploaded"
    assert sum(reads) <= 450
    manifest = json.loads(collector.backup_uploader.by_prefix("manifest.")[0]["body"])
    # MEMORY.md first, then the newest notes; the oldest are left behind.
    assert [f["path"] for f in manifest["files"]] == [
        "MEMORY.md", "memory/2026-09-08.md", "memory/2026-09-09.md", "memory/2026-09-10.md"
    ]
    assert manifest["partial"] is True
    assert manifest["skipped"] == {"count": 7, "reasons": {"over_budget": 7}}
    assert collector.counters.get("backup_skipped") == 7
    assert collector.counters.get("backup_skipped_over_budget") == 7
    (event,) = snapshots_in(av, collector)
    assert validate(MEMORY_SNAPSHOT_SCHEMA, event["payload"]) == []  # still the closed key set
    assert json.loads((backup_env / "av-events" / "backup.json").read_text())["partial"] is True


def test_skip_reasons_reach_the_manifest_as_codes(collector, backup_env):
    write_tree(backup_env, {**ALLOWED, "av-events/hash.key": b"k" * 64})
    os.link(backup_env / "av-events" / "hash.key", backup_env / "memory" / "2026-09-23.md")
    assert collector.snapshot_once(now=NOW) == "uploaded"
    manifest = json.loads(collector.backup_uploader.by_prefix("manifest.")[0]["body"])
    assert manifest["partial"] is True
    assert manifest["skipped"] == {"count": 1, "reasons": {"hard_linked": 1}}
    assert "2026-09-23" not in json.dumps(manifest["skipped"])


@pytest.mark.parametrize(("status", "blocked"), [("error", True), ("restored", False), ("none", False)])
def test_a_failed_restore_blocks_uploads(collector, backup_env, status, blocked):
    write_tree(backup_env, {**ALLOWED, "av-events/restore.json": json.dumps({"status": status}).encode()})
    result = collector.snapshot_once(now=NOW)
    if blocked:
        assert result == "blocked_by_restore"
        assert collector.backup_uploader.calls == []
        assert collector.counters.get("backup_blocked_by_restore") == 1
    else:
        assert result == "uploaded"


def test_a_bad_created_at_in_the_state_file_never_reaches_the_envelope(collector, backup_env, av):
    write_tree(backup_env, ALLOWED)
    b = backup_mod()
    snap = b.build_snapshot(b.collect(str(backup_env)).files, TENANT, NOW)
    state = {
        "content_hash": snap.content_hash,
        "manifest_sha256": "c" * 64,
        "target": b.target_id(collector.config.backup_url, TENANT),
        "created_at": "yesterday, roughly",
        "bytes": 1,
        "file_count": 1,
        "emitted": False,
    }
    write_tree(backup_env, {"av-events/backup.json": json.dumps(state).encode()})
    assert collector.snapshot_once(now=NOW) == "uploaded"  # not "emitted" from the bad record
    (event,) = snapshots_in(av, collector)
    assert event["occurred_at"] == "2026-09-21T14:13:20.000Z"
    assert b.valid_iso("2026-09-21T14:13:20.000Z") and not b.valid_iso("2026-13-40T99:99:99.000Z")


# -- turns without a finalize; the rate limit; the exit drain ---------------


def test_a_gateway_that_never_finalizes_still_backs_up_every_interval(plugin, ctx, backup_env, monkeypatch):
    monkeypatch.setenv("AV_BACKUP_MIN_INTERVAL_S", "0.3")
    plugin.register(ctx)
    col = plugin._COLLECTOR
    col.backup_uploader = Uploads()
    passes: list[float] = []
    real = col.snapshot_once

    def timed(*a, **k):
        passes.append(time.monotonic())
        return real(*a, **k)

    col.snapshot_once = timed
    write_tree(backup_env, ALLOWED)
    ctx.fire("on_session_start", session_id="tg-1", model="m", platform="telegram")
    turns = 40
    for turn in range(turns):  # a conversation that goes quiet: no on_session_finalize, ever
        write_tree(backup_env, {"memory/2026-09-21.md": f"- turn {turn}\n".encode()})
        ctx.fire("on_session_end", session_id="tg-1", completed=True)
        time.sleep(0.05)
    deadline = time.monotonic() + 3
    while col._backup_thread is not None and time.monotonic() < deadline:
        time.sleep(0.05)
    assert col._backup_thread is None
    assert 3 <= len(passes) <= 12
    gaps = [b - a for a, b in zip(passes, passes[1:])]
    assert min(gaps) >= 0.25
    last_archive = col.backup_uploader.by_prefix("memory.")[-1]["body"]
    assert tar_members(last_archive)["memory/2026-09-21.md"] == f"- turn {turns - 1}\n".encode()


def test_a_finalize_is_not_held_to_the_rate_limit(plugin, ctx, backup_env, monkeypatch):
    monkeypatch.setenv("AV_BACKUP_MIN_INTERVAL_S", "300")
    plugin.register(ctx)
    col = plugin._COLLECTOR
    col.backup_uploader = Uploads()
    write_tree(backup_env, ALLOWED)
    ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
    ctx.fire("on_session_end", session_id="s1")
    time.sleep(0.3)
    assert len(col.backup_uploader.calls) == 2  # the first request runs at once
    write_tree(backup_env, {"MEMORY.md": b"changed\n"})
    ctx.fire("on_session_end", session_id="s1")
    time.sleep(0.3)
    assert len(col.backup_uploader.calls) == 2  # held: within the interval
    ctx.fire("on_session_finalize", session_id="s1")
    deadline = time.monotonic() + 3
    while len(col.backup_uploader.calls) < 4 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert len(col.backup_uploader.calls) == 4


class TrickleServer:
    """Accepts, reads the request head, then answers one byte a second."""

    def __init__(self) -> None:
        import socket as _socket

        self.sock = _socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self) -> None:
        self.sock.settimeout(0.2)
        while not self.stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                continue
            threading.Thread(target=self._trickle, args=(conn,), daemon=True).start()

    def _trickle(self, conn) -> None:
        try:
            conn.settimeout(10)
            conn.recv(65536)
            for byte in b"HTTP/1.1 201 Created\r\nX-Pad: " + b"a" * 60:
                if self.stop.is_set():
                    break
                conn.send(bytes([byte]))
                time.sleep(1.0)
        except OSError:
            pass
        finally:
            conn.close()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.sock.getsockname()[1]}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.sock.close()


def test_put_object_is_bounded_by_its_timeout_against_a_trickling_server(plugin):
    with TrickleServer() as server:
        start = time.monotonic()
        result = backup_mod().put_object(
            server.url, "tok", TENANT, "2026-09-21", "memory." + "0" * 64 + ".tar.gz", b"x" * 10, "application/gzip", 1.5
        )
        elapsed = time.monotonic() - start
    assert result.ok is False
    assert elapsed <= 2.5


@pytest.mark.parametrize("started", [True, False])
def test_the_exit_drain_is_bounded_by_its_budget(plugin, backup_env, monkeypatch, started):
    with TrickleServer() as server:
        monkeypatch.setenv("AV_BACKUP_URL", server.url)
        monkeypatch.setattr(backup_mod(), "EXIT_BUDGET_S", 1.5)
        col = plugin.Collector()
        write_tree(backup_env, ALLOWED)
        if started:
            assert col.request_snapshot(urgent=True)  # the pass is already hanging on the server
            time.sleep(0.2)
        else:
            with col._backup_lock:
                col._backup_pending = True  # requested, no thread (it died with the process)
        start = time.monotonic()
        col.shutdown()
        elapsed = time.monotonic() - start
    assert elapsed <= 1.5 + 1.0


def test_the_exit_drain_skips_when_no_thread_can_start(collector, backup_env, monkeypatch):
    write_tree(backup_env, ALLOWED)
    with collector._backup_lock:
        collector._backup_pending = True

    def refuse(*a, **k):
        raise RuntimeError("can't create new thread at interpreter shutdown")

    monkeypatch.setattr(collector, "_start_backup_thread", refuse)
    start = time.monotonic()
    collector.shutdown()
    assert time.monotonic() - start < 0.5
    assert collector.backup_uploader.calls == []
    assert collector.counters.get("backup_exit_skipped") == 1
