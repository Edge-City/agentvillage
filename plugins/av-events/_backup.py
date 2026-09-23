"""Memory snapshot (DATA-82): the agent's memory files, backed up off the product path.

A Railway sandbox has no volume, so a recreate loses `MEMORY.md`, both
`USER.md` files and the daily notes. At session finalize the plugin asks for a
snapshot; a daemon thread (never the hook) collects those files, packs them into
a deterministic `tar.gz`, and PUTs it and a manifest to the ingest service's
backup route, which stores them in the archive bucket under
`backup/<tenant>/<YYYY-MM-DD>/`. `install/restore-memory.ts` puts them back on a
recreated sandbox before the gateway starts.

What is backed up is a fixed allowlist, never a directory walk:

- `MEMORY.md` and `USER.md` at `$HERMES_HOME` (the workspace files: the agent's
  curated memory, and the profile the landing's enrichment wrote);
- `memories/MEMORY.md` and `memories/USER.md` (Hermes's memory tool,
  `tools/memory_tool.py` `get_memory_dir()`);
- `memory/YYYY-MM-DD.md`, daily notes only — the same rule as
  `skills/recall/scripts/recall.ts` `DAILY_NOTE_RE`, so drafts such as
  `memory/digest-outgoing.md` and the JSON ledgers under `memory/` are not.

Nothing else can be included: not `.recall/` (derived, rebuilt from these
files), not `av-events/` (this plugin's state, the HMAC key among it), not a
JSON ledger, not a symlink, a hard-linked file, a FIFO or a file over
`MAX_FILE_BYTES`. The allowlist is positive, so a new file type is excluded
until someone adds it here.

The archive is content-addressed: the same files give the same bytes and the
same SHA-256 (sorted entries, zeroed tar metadata, gzip `mtime=0`), so an
unchanged workspace uploads nothing and emits nothing.

Python 3.11, standard library only.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import re
import stat
import tarfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from ._core import PLUGIN_VERSION, SendResult, canonical_json

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

#: The fixed files, relative to `$HERMES_HOME`, in the order they are listed.
MEMORY_FILES = ("MEMORY.md", "USER.md", "memories/MEMORY.md", "memories/USER.md")

#: The daily-notes directory, and the only names in it that are backed up.
DAILY_DIR = "memory"
DAILY_NOTE = re.compile(r"^\d{4}-\d{2}-\d{2}\.md$")

#: A file larger than this is skipped (counted, never truncated). Hermes caps
#: MEMORY.md and USER.md at a few KiB; a daily note is a day of bullets.
MAX_FILE_BYTES = 4 * 1024 * 1024

#: Cap on the compressed archive, overridable by `AV_BACKUP_MAX_BYTES`. The
#: upload route enforces its own cap; this keeps a runaway workspace from
#: costing a PUT that will be refused anyway.
DEFAULT_MAX_BYTES = 32 * 1024 * 1024

#: One PUT's timeout. The snapshot runs on its own daemon thread, so this bounds
#: that thread, not a hook.
UPLOAD_TIMEOUT_S = 30.0

#: How long the atexit drain may spend on a pending snapshot.
EXIT_BUDGET_S = 10.0

#: After a 401 or 403 the route will not change its mind on its own (a wrong or
#: rotated token, a withdrawn tenant): stop trying for this long.
AUTH_COOLDOWN_S = 3600.0

MANIFEST_SCHEMA = "memory_manifest.v1"

#: `manifest_ref` / `snapshot_ref` prefix. Ingest's `memoryRef` allows
#: `^[a-z0-9_-]{1,32}/[0-9a-f]{64}$`, and DATA-87 narrows the prefix to an enum
#: containing `backup`.
REF_PREFIX = "backup"

#: Same shape as the archive bucket's key segment (`agentvillage-data`
#: `src/archive/bucket.ts` `KEY_SEGMENT`), bounded.
TENANT_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

_HEX64 = re.compile(r"^[0-9a-f]{64}$")

#: Names the plugin uploads. The route accepts exactly these two shapes.
ARCHIVE_NAME = "memory.{}.tar.gz"
MANIFEST_NAME = "manifest.{}.json"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# Collecting the files
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class MemoryFile:
    path: str  # relative to $HERMES_HOME, '/'-separated
    data: bytes
    mtime_ms: int


@dataclass
class Collected:
    files: list[MemoryFile] = field(default_factory=list)
    #: Candidate files that exist but were not taken, by reason. Counts only.
    skipped: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1


def _is_plain_dir(path: str) -> bool:
    """A real directory, not a symlink to one."""
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def _read_one(home: str, rel: str, out: Collected) -> None:
    parts = rel.split("/")
    # Every parent below $HERMES_HOME must be a real directory: `memory -> /`
    # or `memories -> .recall` must not route the read anywhere else.
    for depth in range(1, len(parts)):
        parent = os.path.join(home, *parts[:depth])
        if not _is_plain_dir(parent):
            if os.path.lexists(parent):
                out.skip("parent_not_directory")
            return
    path = os.path.join(home, *parts)
    try:
        # O_NOFOLLOW: a symlink fails to open. O_NONBLOCK: a FIFO does not hang
        # the thread on open (it is then refused as not a regular file).
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return
    except OSError:
        out.skip("unreadable")  # a symlink (ELOOP), permissions, I/O
        return
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            out.skip("not_regular")
            return
        if info.st_nlink > 1:
            # A hard link could be another file entirely (`av-events/hash.key`),
            # as recall also assumes; it is not taken.
            out.skip("hard_linked")
            return
        if info.st_size > MAX_FILE_BYTES:
            out.skip("too_large")
            return
        chunks: list[bytes] = []
        remaining = MAX_FILE_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > MAX_FILE_BYTES:
            out.skip("too_large")  # grew while we read it
            return
        out.files.append(MemoryFile(rel, data, int(info.st_mtime_ns // 1_000_000)))
    except OSError:
        out.skip("unreadable")
    finally:
        os.close(fd)


def candidate_paths(home: str) -> list[str]:
    """The allowlisted relative paths that could exist, daily notes sorted."""
    paths = list(MEMORY_FILES)
    daily = os.path.join(home, DAILY_DIR)
    if _is_plain_dir(daily):
        try:
            names = sorted(os.listdir(daily))
        except OSError:
            names = []
        paths.extend(f"{DAILY_DIR}/{name}" for name in names if DAILY_NOTE.match(name))
    return paths


def collect(home: str) -> Collected:
    """Read every allowlisted memory file that exists. Never raises for a file."""
    out = Collected()
    for rel in candidate_paths(home):
        _read_one(home, rel, out)
    out.files.sort(key=lambda f: f.path)
    return out


# --------------------------------------------------------------------------
# Building the snapshot
# --------------------------------------------------------------------------


def build_archive(files: list[MemoryFile]) -> bytes:
    """A deterministic `tar.gz` of `files`.

    USTAR (no pax headers), entries sorted by path, every per-entry fact that
    is not the path and the bytes zeroed (mtime, uid/gid, owner names, a fixed
    mode), and gzip written with `mtime=0` and no file name. The same files
    therefore give the same archive bytes, which is what makes the upload
    content-addressed. File mtimes live in the manifest instead.
    """
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for item in sorted(files, key=lambda f: f.path):
            info = tarfile.TarInfo(item.path)
            info.size = len(item.data)
            info.mtime = 0
            info.mode = 0o600
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.type = tarfile.REGTYPE
            tar.addfile(info, io.BytesIO(item.data))
    return gzip.compress(raw.getvalue(), compresslevel=9, mtime=0)


def utc_date(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d")


def utc_iso(epoch: float) -> str:
    stamp = datetime.fromtimestamp(epoch, tz=timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class Snapshot:
    tenant: str
    date: str
    created_at: str
    archive: bytes
    content_hash: str
    files: tuple[MemoryFile, ...]

    @property
    def archive_name(self) -> str:
        return ARCHIVE_NAME.format(self.content_hash)

    @property
    def total_bytes(self) -> int:
        return sum(len(f.data) for f in self.files)

    @property
    def file_count(self) -> int:
        return len(self.files)

    def manifest(self) -> dict:
        return {
            "schema": MANIFEST_SCHEMA,
            "tenant_id": self.tenant,
            "date": self.date,
            "created_at": self.created_at,
            "plugin_version": PLUGIN_VERSION,
            "archive": {"name": self.archive_name, "sha256": self.content_hash, "bytes": len(self.archive)},
            "file_count": self.file_count,
            "total_bytes": self.total_bytes,
            "files": [
                {"path": f.path, "sha256": sha256_hex(f.data), "bytes": len(f.data), "mtime_ms": f.mtime_ms}
                for f in self.files
            ],
        }

    def manifest_bytes(self) -> bytes:
        return canonical_json(self.manifest()).encode("utf-8")


def build_snapshot(files: list[MemoryFile], tenant: str, now: float) -> Snapshot:
    archive = build_archive(files)
    return Snapshot(
        tenant=tenant,
        date=utc_date(now),
        created_at=utc_iso(now),
        archive=archive,
        content_hash=sha256_hex(archive),
        files=tuple(sorted(files, key=lambda f: f.path)),
    )


def snapshot_payload(total_bytes: int, file_count: int, content_hash: str, manifest_sha: str) -> dict:
    """`memory.snapshot@1`, exactly the registered (closed) key set.

    `bytes` is the total of the files' own sizes — the same quantity
    `memory.restored.bytes` reports for what was put back — not the compressed
    archive's size, which the manifest carries.
    """
    return {
        "bytes": total_bytes,
        "file_count": file_count,
        "content_hash": content_hash,
        "manifest_ref": f"{REF_PREFIX}/{manifest_sha}",
    }


# --------------------------------------------------------------------------
# Upload
# --------------------------------------------------------------------------


def backup_base(url: str) -> str:
    """`AV_BACKUP_URL` is the ingest service's base URL. A value that already
    ends in the route (`…/v1/backup`) is accepted too."""
    base = url.strip().rstrip("/")
    if base.endswith("/v1/backup"):
        base = base[: -len("/v1/backup")]
    return base


Uploader = Callable[[str, str, str, str, str, bytes, str, float], SendResult]


def put_object(
    url: str, token: str, tenant: str, date: str, name: str, body: bytes, content_type: str, timeout: float
) -> SendResult:
    """`PUT {base}/v1/backup/<tenant>/<date>/<name>` with the tenant's backup token.

    The name carries the body's SHA-256, which the route recomputes; the header
    repeats it so a proxy that mangles the body is caught before it is stored.
    """
    request = urllib.request.Request(
        f"{backup_base(url)}/v1/backup/{tenant}/{date}/{name}",
        data=body,
        headers={
            "Content-Type": content_type,
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Content-SHA256": sha256_hex(body),
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 0) or 0)
            response.read()
            return SendResult(200 <= status < 300, status)
    except urllib.error.HTTPError as exc:
        try:
            exc.read()
        except Exception:  # noqa: BLE001 - draining the body must never raise
            pass
        return SendResult(False, exc.code, "http_error")
    except Exception as exc:  # noqa: BLE001 - URLError, timeouts, TLS, DNS
        return SendResult(False, None, type(exc).__name__)


# --------------------------------------------------------------------------
# One pass
# --------------------------------------------------------------------------


def target_id(url: str, tenant: str) -> str:
    """Which destination a recorded snapshot went to. A changed URL or tenant is
    a new destination, so the next pass uploads rather than calling it unchanged.
    Hashed so `backup.json` never holds the URL."""
    return sha256_hex(f"{backup_base(url)}|{tenant}".encode("utf-8"))[:16]


def _valid_state(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    ok = (
        isinstance(raw.get("content_hash"), str)
        and _HEX64.match(raw["content_hash"])
        and isinstance(raw.get("manifest_sha256"), str)
        and _HEX64.match(raw["manifest_sha256"])
        and isinstance(raw.get("target"), str)
        and isinstance(raw.get("bytes"), int)
        and isinstance(raw.get("file_count"), int)
        and isinstance(raw.get("created_at"), str)
        and isinstance(raw.get("emitted"), bool)
    )
    return raw if ok else None


def run_once(collector: Any, now: Optional[float] = None, timeout: float = UPLOAD_TIMEOUT_S) -> str:
    """One snapshot pass. Returns a status word; never raises.

    `collector` supplies `config`, `emit`, `count`, `_read_json`,
    `_write_json` and the `backup_uploader` test seam. Statuses:
    `unconfigured`, `blocked`, `empty`, `unchanged`, `emitted` (an earlier
    upload's event, owed because the emit was inert then), `too_large`,
    `failed`, `uploaded`, `error`.
    """
    try:
        return _run_once(collector, time.time() if now is None else now, timeout)
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - off the product path, by contract
        collector.count("backup_error")
        return "error"


def _run_once(collector: Any, now: float, timeout: float) -> str:
    config = collector.config
    if not config.backup_configured:
        return "unconfigured"
    if collector.backup_blocked_until > time.monotonic():
        return "blocked"
    state_path = os.path.join(config.state_dir, "backup.json")
    target = target_id(config.backup_url, config.backup_tenant)

    collected = collect(config.home)
    for reason, n in collected.skipped.items():
        collector.count(f"backup_skipped_{reason}", n)
    if not collected.files:
        # Nothing to back up. Never upload an empty snapshot: it would become
        # "latest" and a recreate would restore nothing over a real backup.
        collector.count("backup_empty")
        return "empty"

    snapshot = build_snapshot(collected.files, config.backup_tenant, now)
    previous = _valid_state(collector._read_json(state_path))
    if previous is not None and previous["content_hash"] == snapshot.content_hash and previous["target"] == target:
        if previous["emitted"]:
            return "unchanged"
        # Uploaded before, but the event was inert then (no events token, the
        # plugin disabled): owe it now, stamped when the snapshot was taken.
        event = collector.emit(
            "memory.snapshot",
            snapshot_payload(previous["bytes"], previous["file_count"], previous["content_hash"], previous["manifest_sha256"]),
            occurred_at=previous["created_at"],
        )
        if event is None:
            return "unchanged"
        collector._write_json(state_path, {**previous, "emitted": True})
        return "emitted"

    if len(snapshot.archive) > config.backup_max_bytes:
        collector.count("backup_too_large")
        return "too_large"

    uploader: Uploader = collector.backup_uploader or put_object
    manifest = snapshot.manifest_bytes()
    manifest_sha = sha256_hex(manifest)
    # Archive first, then the manifest that names it: a manifest is the commit
    # point, and the route refuses one whose archive it does not hold.
    for name, body, content_type in (
        (snapshot.archive_name, snapshot.archive, "application/gzip"),
        (MANIFEST_NAME.format(manifest_sha), manifest, "application/json"),
    ):
        result = uploader(
            config.backup_url, config.backup_token, snapshot.tenant, snapshot.date, name, body, content_type, timeout
        )
        if not result.ok:
            collector.count("backup_upload_failed")
            if result.status in (401, 403):
                collector.count(f"backup_upload_{result.status}")
                collector.backup_blocked_until = time.monotonic() + AUTH_COOLDOWN_S
            return "failed"

    event = collector.emit(
        "memory.snapshot",
        snapshot_payload(snapshot.total_bytes, snapshot.file_count, snapshot.content_hash, manifest_sha),
        occurred_at=snapshot.created_at,
    )
    collector._write_json(
        state_path,
        {
            "content_hash": snapshot.content_hash,
            "manifest_sha256": manifest_sha,
            "target": target,
            "date": snapshot.date,
            "created_at": snapshot.created_at,
            "bytes": snapshot.total_bytes,
            "file_count": snapshot.file_count,
            "emitted": event is not None,
        },
    )
    collector.count("backup_uploaded")
    return "uploaded"


def manifest_json(snapshot: Snapshot) -> dict:
    """Test and tooling convenience: the manifest as the route stores it."""
    return json.loads(snapshot.manifest_bytes())
