"""Memory snapshot (DATA-82): the agent's memory files, backed up off the product path.

A Railway sandbox has no volume, so a recreate loses `MEMORY.md`, both
`USER.md` files and the daily notes. Every turn (`on_session_end`, rate-limited)
and every session finalize the plugin asks for a snapshot; a daemon thread
(never the hook) collects those files, packs them into a deterministic `tar.gz`,
and PUTs it and a manifest to the ingest service's backup route, which stores
them in the archive bucket under `backup/<tenant>/<YYYY-MM-DD>/`.
`install/restore-memory.ts` puts them back on a recreated sandbox before the
gateway starts.

What is backed up is a fixed allowlist, never a directory walk:

- `MEMORY.md` and `USER.md` at `$HERMES_HOME` (the workspace files: the agent's
  curated memory, and the profile the landing's enrichment wrote);
- `memories/MEMORY.md` and `memories/USER.md` (Hermes's memory tool,
  `tools/memory_tool.py` `get_memory_dir()`);
- `memory/YYYY-MM-DD.md`, daily notes only, ASCII digits, the whole name —
  `install/restore-memory.ts` applies the identical rule, and both suites read
  one vector file (`tests/vectors/daily_note_names.json`).

Nothing else can be included: not `.recall/` (derived, rebuilt from these
files), not `av-events/` (this plugin's state, the HMAC key among it), not a
JSON ledger, not a symlink, a hard-linked file, a FIFO or a file over
`MAX_FILE_BYTES`. The allowlist is positive, so a new file type is excluded
until someone adds it here.

The archive is content-addressed: the same files give the same bytes and the
same SHA-256 (sorted entries, zeroed tar metadata, gzip `mtime=0` and OS byte
255), so an unchanged workspace uploads nothing and emits nothing.

Python 3.11, standard library only.
"""

from __future__ import annotations

import gzip
import hashlib
import http.client
import io
import json
import os
import re
import socket
import stat
import tarfile
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from ._core import PLUGIN_VERSION, SendResult, canonical_json

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

#: The fixed files, relative to `$HERMES_HOME`, in the order they are collected.
MEMORY_FILES = ("MEMORY.md", "USER.md", "memories/MEMORY.md", "memories/USER.md")

#: The daily-notes directory, and the only names in it that are backed up.
#: `fullmatch` and `[0-9]`: `$` would accept a trailing newline and `\d` any
#: Unicode digit, and restore (which uses the same rule) would then refuse the
#: whole snapshot over one oddly named file.
DAILY_DIR = "memory"
DAILY_NOTE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\.md")

#: A file larger than this is skipped (counted, never truncated). Hermes caps
#: MEMORY.md and USER.md at a few KiB; a daily note is a day of bullets.
MAX_FILE_BYTES = 4 * 1024 * 1024

#: Cap on the bytes collected (uncompressed) and on the compressed archive,
#: overridable by `AV_BACKUP_MAX_BYTES`. Collection stops reading at the cap.
DEFAULT_MAX_BYTES = 32 * 1024 * 1024

#: The least time between two passes requested from `on_session_end` (every
#: turn), overridable by `AV_BACKUP_MIN_INTERVAL_S`. A finalize is not held to it.
DEFAULT_MIN_INTERVAL_S = 300.0

#: How long after a request its pass may start at the earliest, overridable by
#: `AV_BACKUP_GRACE_S`. Hermes's background memory review writes
#: `memories/MEMORY.md` / `USER.md` a few seconds after `on_session_end`; a pass
#: that ran at once would miss them whenever the chat then went quiet.
DEFAULT_GRACE_S = 90.0

#: Backoff after consecutive failed passes: 5 min, doubling, capped at 6 h,
#: reset by a success. A 401/403 cooldown applies when it is longer.
BACKOFF_BASE_S = 300.0
BACKOFF_MAX_S = 6 * 3600.0

#: A failed restore on an empty workspace blocks uploads for at most this long.
RESTORE_BLOCK_S = 24 * 3600.0

#: How many archive hashes the route has accepted are remembered, so an
#: archive it already holds is never PUT again.
MAX_ACCEPTED = 64

#: One PUT's wall-clock budget, enforced by a watchdog (`put_object`): a socket
#: timeout alone bounds each read, not the request, and a server that trickles
#: one byte a second would hold the thread indefinitely.
UPLOAD_TIMEOUT_S = 30.0

#: How long the exit drain waits for a pending or running snapshot.
EXIT_BUDGET_S = 10.0

#: After a 401 the token may be fixed by an operator; retry after an hour.
AUTH_COOLDOWN_S = 3600.0
#: After a 403 the route has refused this tenant (a withdrawn tenant, DATA-93).
FORBIDDEN_COOLDOWN_S = 24 * 3600.0

MANIFEST_SCHEMA = "memory_manifest.v1"

#: `manifest_ref` / `snapshot_ref` prefix. Ingest's `memoryRef` allows
#: `^[a-z0-9_-]{1,32}/[0-9a-f]{64}$`, and DATA-87 narrows the prefix to an enum
#: containing `backup`.
REF_PREFIX = "backup"

#: Same shape as the archive bucket's key segment (`agentvillage-data`
#: `src/archive/bucket.ts` `KEY_SEGMENT`), bounded. Always `fullmatch`.
TENANT_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")

_HEX64 = re.compile(r"[0-9a-f]{64}")
#: What `utc_iso` writes; anything else in `backup.json` is not trusted.
_ISO_MS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")

#: Names the plugin uploads. The route accepts exactly these two shapes.
ARCHIVE_NAME = "memory.{}.tar.gz"
MANIFEST_NAME = "manifest.{}.json"

#: Plain-http hosts the backup token may be sent to: Railway private networking
#: and the local machine. Everything else must be https.
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def backup_url_allowed(url: str) -> bool:
    """https anywhere; http only to `*.railway.internal` or the local machine.

    No userinfo, query or fragment. The token goes wherever this URL points.
    """
    try:
        parts = urllib.parse.urlsplit(url.strip())
        host = (parts.hostname or "").lower()
        _ = parts.port  # raises on a malformed port
    except ValueError:
        return False
    if not host or parts.username or parts.password or parts.query or parts.fragment:
        return False
    if parts.scheme == "https":
        return True
    if parts.scheme == "http":
        return host in _LOCAL_HOSTS or host.endswith(".railway.internal")
    return False


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
    #: Candidate files that exist but were not taken, by reason code. Counts only.
    skipped: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str, n: int = 1) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + n

    @property
    def skipped_count(self) -> int:
        return sum(self.skipped.values())

    @property
    def total_bytes(self) -> int:
        return sum(len(f.data) for f in self.files)


def _is_plain_dir(path: str) -> bool:
    """A real directory, not a symlink to one."""
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def _read_one(home: str, rel: str, out: Collected, budget: int) -> bool:
    """Read one candidate into `out`. False when it did not fit in `budget`
    (the caller then stops reading)."""
    parts = rel.split("/")
    # Every parent below $HERMES_HOME must be a real directory: `memory -> /`
    # or `memories -> .recall` must not route the read anywhere else.
    for depth in range(1, len(parts)):
        parent = os.path.join(home, *parts[:depth])
        if not _is_plain_dir(parent):
            if os.path.lexists(parent):
                out.skip("parent_not_directory")
            return True
    path = os.path.join(home, *parts)
    try:
        # O_NOFOLLOW: a symlink fails to open. O_NONBLOCK: a FIFO does not hang
        # the thread on open (it is then refused as not a regular file).
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return True
    except OSError:
        out.skip("unreadable")  # a symlink (ELOOP), permissions, I/O
        return True
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            out.skip("not_regular")
            return True
        if info.st_nlink > 1:
            # A hard link could be another file entirely (`av-events/hash.key`),
            # as recall also assumes; it is not taken.
            out.skip("hard_linked")
            return True
        if info.st_size > MAX_FILE_BYTES:
            out.skip("too_large")
            return True
        if out.total_bytes + info.st_size > budget:
            return False
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
            return True
        if out.total_bytes + len(data) > budget:
            return False
        out.files.append(MemoryFile(rel, data, int(info.st_mtime_ns // 1_000_000)))
    except OSError:
        out.skip("unreadable")
    finally:
        os.close(fd)
    return True


def candidate_paths(home: str) -> list[str]:
    """The allowlisted relative paths that could exist, in collection order:
    the four fixed files, then daily notes newest first — so when the byte
    budget runs out it is the oldest notes that are left behind."""
    paths = list(MEMORY_FILES)
    daily = os.path.join(home, DAILY_DIR)
    if _is_plain_dir(daily):
        try:
            names = sorted(os.listdir(daily), reverse=True)
        except OSError:
            names = []
        paths.extend(f"{DAILY_DIR}/{name}" for name in names if DAILY_NOTE.fullmatch(name))
    return paths


def collect(home: str, budget: int = DEFAULT_MAX_BYTES) -> Collected:
    """Read every allowlisted memory file that exists, up to `budget` bytes in
    total. Once a file does not fit, nothing more is read and every remaining
    candidate counts as `over_budget`. Never raises for a file."""
    out = Collected()
    candidates = candidate_paths(home)
    for index, rel in enumerate(candidates):
        if not _read_one(home, rel, out, budget):
            remaining = [r for r in candidates[index:] if os.path.lexists(os.path.join(home, *r.split("/")))]
            out.skip("over_budget", len(remaining))
            break
    out.files.sort(key=lambda f: f.path)
    return out


# --------------------------------------------------------------------------
# Building the snapshot
# --------------------------------------------------------------------------


def build_archive(files: list[MemoryFile]) -> bytes:
    """A deterministic `tar.gz` of `files`.

    USTAR (no pax headers), entries sorted by path, every per-entry fact that
    is not the path and the bytes zeroed (mtime, uid/gid, owner names, a fixed
    mode), and gzip with `mtime=0` and the OS byte pinned to 255 ("unknown":
    Python 3.12+ may take the platform's value from zlib). The same files
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
    archive = bytearray(gzip.compress(raw.getvalue(), compresslevel=9, mtime=0))
    archive[9] = 255  # OS byte; not covered by the gzip CRC
    return bytes(archive)


def utc_date(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d")


def utc_iso(epoch: float) -> str:
    stamp = datetime.fromtimestamp(epoch, tz=timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def valid_iso(value: Any) -> bool:
    """An ISO-8601 UTC timestamp as `utc_iso` writes it, and a real instant."""
    if not isinstance(value, str) or not _ISO_MS.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class Snapshot:
    tenant: str
    date: str
    created_at: str
    archive: bytes
    content_hash: str
    files: tuple[MemoryFile, ...]
    skipped: tuple[tuple[str, int], ...] = ()

    @property
    def archive_name(self) -> str:
        return ARCHIVE_NAME.format(self.content_hash)

    @property
    def total_bytes(self) -> int:
        return sum(len(f.data) for f in self.files)

    @property
    def file_count(self) -> int:
        return len(self.files)

    @property
    def skipped_count(self) -> int:
        return sum(n for _, n in self.skipped)

    @property
    def partial(self) -> bool:
        """Some allowlisted file exists and is not in this snapshot."""
        return self.skipped_count > 0

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
            "partial": self.partial,
            # Reason codes and counts only: never a skipped file's name.
            "skipped": {"count": self.skipped_count, "reasons": dict(sorted(self.skipped))},
            "files": [
                {"path": f.path, "sha256": sha256_hex(f.data), "bytes": len(f.data), "mtime_ms": f.mtime_ms}
                for f in self.files
            ],
        }

    def manifest_bytes(self) -> bytes:
        return canonical_json(self.manifest()).encode("utf-8")


def build_snapshot(
    files: list[MemoryFile], tenant: str, now: float, skipped: Optional[dict[str, int]] = None
) -> Snapshot:
    archive = build_archive(files)
    return Snapshot(
        tenant=tenant,
        date=utc_date(now),
        created_at=utc_iso(now),
        archive=archive,
        content_hash=sha256_hex(archive),
        files=tuple(sorted(files, key=lambda f: f.path)),
        skipped=tuple(sorted((skipped or {}).items())),
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


def _abort(conn: http.client.HTTPConnection) -> None:
    """Watchdog: wake a thread blocked on this connection's socket."""
    sock = conn.sock
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def put_object(
    url: str, token: str, tenant: str, date: str, name: str, body: bytes, content_type: str, timeout: float
) -> SendResult:
    """`PUT {base}/v1/backup/<tenant>/<date>/<name>` with the tenant's backup token.

    `timeout` bounds the whole request, not each socket read: a watchdog shuts
    the socket down when it expires. The name carries the body's SHA-256, which
    the route recomputes; the header repeats it so a proxy that mangles the body
    is caught before it is stored. Redirects are not followed.
    """
    if not backup_url_allowed(url):
        return SendResult(False, None, "url_not_allowed")
    parts = urllib.parse.urlsplit(backup_base(url))
    path = f"{parts.path}/v1/backup/{tenant}/{date}/{name}"
    cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = cls(parts.hostname, parts.port, timeout=timeout)
    timer = threading.Timer(timeout, _abort, (conn,))
    timer.daemon = True
    timer.start()
    try:
        conn.request(
            "PUT",
            path,
            body=body,
            headers={
                "Content-Type": content_type,
                "Accept": "application/json",
                "Authorization": f"Bearer {token}",
                "X-Content-SHA256": sha256_hex(body),
            },
        )
        response = conn.getresponse()
        status = int(response.status)
        response.read(64 * 1024)
        return SendResult(200 <= status < 300, status, "" if 200 <= status < 300 else "http_error")
    except Exception as exc:  # noqa: BLE001 - refused, reset, watchdog, TLS, DNS
        return SendResult(False, None, type(exc).__name__)
    finally:
        timer.cancel()
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# One pass
# --------------------------------------------------------------------------


def target_id(url: str, tenant: str) -> str:
    """Which destination a recorded snapshot went to. A changed URL or tenant is
    a new destination, so the next pass uploads rather than calling it unchanged.
    Hashed so `backup.json` never holds the URL."""
    return sha256_hex(f"{backup_base(url)}|{tenant}".encode("utf-8"))[:16]


def _valid_state(raw: Any) -> Optional[dict]:
    """The last snapshot recorded in `backup.json`, or None if any field is off."""
    if not isinstance(raw, dict):
        return None

    def count(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and value >= 0

    ok = (
        isinstance(raw.get("content_hash"), str)
        and _HEX64.fullmatch(raw["content_hash"])
        and isinstance(raw.get("manifest_sha256"), str)
        and _HEX64.fullmatch(raw["manifest_sha256"])
        and isinstance(raw.get("target"), str)
        and count(raw.get("bytes"))
        and count(raw.get("file_count"))
        # It becomes `occurred_at` on an owed event: only a real timestamp.
        and valid_iso(raw.get("created_at"))
        and isinstance(raw.get("emitted"), bool)
        and isinstance(raw.get("skipped"), dict)
    )
    return raw if ok else None


def skipped_signature(skipped: Any) -> dict:
    """`{count, reasons}` as the manifest writes it; the second half of "unchanged"."""
    if isinstance(skipped, dict):
        reasons = {str(k): int(v) for k, v in sorted(skipped.items()) if isinstance(v, int)}
    else:
        reasons = {}
    return {"count": sum(reasons.values()), "reasons": reasons}


def accepted_hashes(raw: Any, target: str, date: str) -> list[str]:
    """Archive hashes the route at `target` has already accepted **under `date`'s
    prefix** (`backup.json`).

    Per date because the route stores `backup/<tenant>/<date>/<name>` and a
    manifest names an archive in its own date's prefix (restore fetches from
    there, and the route answers 409 `archive_missing` otherwise). An archive
    accepted yesterday is not one today's manifest can name: after UTC
    midnight, or on a revert to an earlier day's content, it is PUT again.
    """
    if (
        not isinstance(raw, dict)
        or raw.get("accepted_target") != target
        or raw.get("accepted_date") != date
    ):
        return []
    hashes = raw.get("accepted")
    if not isinstance(hashes, list):
        return []
    return [h for h in hashes if isinstance(h, str) and _HEX64.fullmatch(h)][-MAX_ACCEPTED:]


def _parse_iso_epoch(value: Any) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp.timestamp() if stamp.tzinfo is not None else None


def restore_blocks(collector: Any, now: float) -> bool:
    """Whether `av-events/restore.json` blocks uploads.

    It blocks only when a restore **failed on an empty workspace**
    (`status: error`, `workspace_empty: true`). Then the sandbox does not hold
    the tenant's memory, and a snapshot of what is here now would become
    "latest" over the real backup. A refusal on a populated workspace (a
    re-run on a live sandbox, say) blocks nothing: what is here is the
    memory. The block expires 24 h after the marker's `at`
    (`backup_block_expired`), so a forgotten marker cannot stop backups for
    good. A marker with no readable `at`, or one from the future, counts as
    expired. The agent can write this file too; that only ever affects its
    own tenant's backups.
    """
    marker = collector._read_json(os.path.join(collector.config.state_dir, "restore.json"))
    if not isinstance(marker, dict) or marker.get("status") != "error" or marker.get("workspace_empty") is not True:
        return False
    at = _parse_iso_epoch(marker.get("at"))
    if at is None or at > now + 300 or now - at >= RESTORE_BLOCK_S:
        collector.count("backup_block_expired")
        return False
    return True


def _record_failure(collector: Any, status: Optional[int], state_path: str) -> None:
    """Exponential backoff over consecutive failures; a 401/403 cooldown when longer.

    A 403 also forgets everything `backup.json` says the route holds (the last
    upload and the accepted archive hashes). The route refuses a withdrawn
    tenant, and withdrawal deletes the tenant's bucket prefix, so none of it
    is true any more. Without this, a tenant who re-consents keeps an
    "unchanged" workspace forever un-uploaded and `latest` stays 404. The first
    pass after the cooldown then uploads whatever is there, in full.
    """
    failures = getattr(collector, "backup_failures", 0) + 1
    collector.backup_failures = failures
    cooldown = min(BACKOFF_BASE_S * (2 ** (failures - 1)), BACKOFF_MAX_S)
    collector.count("backup_upload_failed")
    if status == 401:
        collector.count("backup_upload_401")
        cooldown = max(cooldown, AUTH_COOLDOWN_S)
    elif status == 403:
        collector.count("backup_forbidden")
        cooldown = max(cooldown, FORBIDDEN_COOLDOWN_S)
        collector._write_json(state_path, {})
    collector.backup_blocked_until = time.monotonic() + cooldown


def run_once(collector: Any, now: Optional[float] = None, timeout: float = UPLOAD_TIMEOUT_S) -> str:
    """One snapshot pass. Returns a status word; never raises.

    `collector` supplies `config`, `emit`, `count`, `_read_json`,
    `_write_json` and the `backup_uploader` test seam. Statuses:
    `unconfigured`, `blocked`, `blocked_by_restore`, `empty`, `unchanged`,
    `emitted` (an earlier upload's event, owed because the emit was inert
    then), `too_large`, `failed`, `uploaded`, `error`.
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
    if restore_blocks(collector, now):
        collector.count("backup_blocked_by_restore")
        return "blocked_by_restore"
    state_path = os.path.join(config.state_dir, "backup.json")
    target = target_id(config.backup_url, config.backup_tenant)

    collected = collect(config.home, config.backup_max_bytes)
    if collected.skipped:
        collector.count("backup_skipped", collected.skipped_count)
        for reason, n in collected.skipped.items():
            collector.count(f"backup_skipped_{reason}", n)
    if not collected.files:
        # Nothing to back up. Never upload an empty snapshot: it would become
        # "latest" and a recreate would restore nothing over a real backup.
        collector.count("backup_empty")
        return "empty"

    snapshot = build_snapshot(collected.files, config.backup_tenant, now, collected.skipped)
    skipped = skipped_signature(collected.skipped)
    raw_state = collector._read_json(state_path)
    previous = _valid_state(raw_state)
    accepted = accepted_hashes(raw_state, target, snapshot.date)
    # "Unchanged" is the archive and what was left out of it: a new file that
    # is skipped (too large, unreadable) changes nothing in the archive but
    # makes the snapshot partial, and the latest manifest must say so.
    same = (
        previous is not None
        and previous["content_hash"] == snapshot.content_hash
        and previous["target"] == target
        and skipped_signature(previous["skipped"].get("reasons")) == skipped
    )
    if same:
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
        collector._write_json(state_path, {**raw_state, "emitted": True})
        return "emitted"

    if len(snapshot.archive) > config.backup_max_bytes:
        collector.count("backup_too_large")
        return "too_large"

    uploader: Uploader = collector.backup_uploader or put_object
    manifest = snapshot.manifest_bytes()
    manifest_sha = sha256_hex(manifest)
    base_state = dict(raw_state) if isinstance(raw_state, dict) else {}

    def remember(hashes: list[str]) -> None:
        base_state.update({"accepted": hashes, "accepted_target": target, "accepted_date": snapshot.date})
        collector._write_json(state_path, base_state)

    def put_archive() -> SendResult:
        nonlocal accepted
        sent = uploader(
            config.backup_url, config.backup_token, snapshot.tenant, snapshot.date,
            snapshot.archive_name, snapshot.archive, "application/gzip", timeout,
        )
        if sent.ok:
            accepted = (accepted + [snapshot.content_hash])[-MAX_ACCEPTED:]
            remember(accepted)
        return sent

    def put_manifest() -> SendResult:
        return uploader(
            config.backup_url, config.backup_token, snapshot.tenant, snapshot.date,
            MANIFEST_NAME.format(manifest_sha), manifest, "application/json", timeout,
        )

    # Archive first, then the manifest that names it: a manifest is the commit
    # point, and the route refuses one whose archive it does not hold under the
    # same date. An archive the route has already accepted under this date is
    # never PUT again.
    if snapshot.content_hash not in accepted:
        result = put_archive()
        if not result.ok:
            _record_failure(collector, result.status, state_path)
            return "failed"
    result = put_manifest()
    if result.status == 409:
        # `archive_missing`: our memory of what the route holds was wrong (a
        # purged prefix, a record from before per-date keys). Forget the hash,
        # re-send the archive and the manifest once, now; a second failure
        # takes the normal backoff.
        collector.count("backup_archive_missing")
        accepted = [h for h in accepted if h != snapshot.content_hash]
        remember(accepted)
        result = put_archive()
        if result.ok:
            result = put_manifest()
    if not result.ok:
        _record_failure(collector, result.status, state_path)
        return "failed"
    collector.backup_failures = 0

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
            "partial": snapshot.partial,
            "skipped": skipped,
            "emitted": event is not None,
            "accepted": accepted,
            "accepted_target": target,
            "accepted_date": snapshot.date,
        },
    )
    collector.count("backup_uploaded")
    return "uploaded"


def manifest_json(snapshot: Snapshot) -> dict:
    """Test and tooling convenience: the manifest as the route stores it."""
    return json.loads(snapshot.manifest_bytes())
