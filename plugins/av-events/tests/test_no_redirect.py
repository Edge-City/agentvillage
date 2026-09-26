"""DATA-172: no bearer ever follows a redirect.

The plugin sends a bearer to exactly two configured destinations,
`AV_EVENTS_URL` (the events poster and the consent fetch) and `AV_BACKUP_URL`
(the memory snapshot). urllib's default opener follows a 301/302/303 and
re-sends `Authorization` to whatever host `Location` names, so every urllib
call goes through `_core.NO_REDIRECT_OPENER`; the backup uploader speaks
`http.client`, which never follows a redirect.

Every test here puts a real HTTP stub on 127.0.0.1 that answers with a 3xx
whose `Location` is a second local stub, and asserts the second stub receives
no connection at all: not merely no `Authorization` header.
"""

from __future__ import annotations

import logging
import re
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

import pytest

EVENTS_TOKEN = "events-token-for-redirect-tests-0123456789"
BACKUP_TOKEN = "backup-token-for-redirect-tests-0123456789"
TENANT = "t_Dogfood-1"
NOW = 1_790_000_000.0  # 2026-09-21T14:13:20Z

#: Every redirect status urllib's default handler knows.
REDIRECTS = [301, 302, 303, 307, 308]

MEMORY = {"MEMORY.md": b"# Long-term\n- likes jazz\n", "memory/2026-09-21.md": b"- met B\n"}


class Stub:
    """A local HTTP server that answers every method with one fixed status.

    `connections` counts accepted connections before any request is parsed,
    so "the target was never contacted" means exactly that. `requests` records
    method, path and whether a bearer came with it (never its value).
    """

    def __init__(self, status: int = 200, location: Optional[str] = None) -> None:
        self.connections = 0
        self.requests: list[dict] = []
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def handle(self) -> None:
                with outer._lock:
                    outer.connections += 1
                super().handle()

            def _answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                with outer._lock:
                    outer.requests.append({
                        "method": self.command,
                        "path": self.path,
                        "bearer": (self.headers.get("Authorization") or "").startswith("Bearer "),
                    })
                self.send_response(status)
                if location is not None:
                    self.send_header("Location", location + self.path)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            do_GET = do_POST = do_PUT = do_HEAD = do_DELETE = _answer  # noqa: N815

            def log_message(self, *args):  # noqa: A003
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )

    def __enter__(self) -> "Stub":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"


@pytest.fixture()
def pair():
    """(redirector, target): the redirector answers 3xx pointing at the target."""

    def make(status: int):
        target = Stub(200)
        target.__enter__()
        redirector = Stub(status, location=target.url)
        redirector.__enter__()
        made.append((redirector, target))
        return redirector, target

    made: list = []
    yield make
    for redirector, target in made:
        redirector.__exit__()
        target.__exit__()


@pytest.fixture()
def core(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._core"]


@pytest.fixture(autouse=True)
def no_proxy(monkeypatch):
    """A developer's proxy variables must not route the stubs' traffic elsewhere."""
    for name in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")


def event() -> dict:
    return {"event_type": "session.started", "payload": {}}


# --------------------------------------------------------------------------
# The opener
# --------------------------------------------------------------------------


def test_the_shared_opener_has_no_redirect_handler_but_the_refusing_one(core):
    handlers = [h for h in core.NO_REDIRECT_OPENER.handlers if isinstance(h, urllib.request.HTTPRedirectHandler)]
    assert len(handlers) == 1
    assert type(handlers[0]) is core.NoRedirect


def test_the_consent_tool_uses_the_shared_opener(plugin, av, core):
    consent = sys.modules[f"{av.MODULE_NAME}._consent"]
    assert consent.NO_REDIRECT_OPENER is core.NO_REDIRECT_OPENER
    assert not hasattr(consent, "_NoRedirect")
    assert not hasattr(consent, "_OPENER")


def test_no_module_opens_a_url_any_other_way(av):
    """Regression guard: a later `urllib.request.urlopen` (or a second opener)
    would silently bring redirect-following back."""
    for path in sorted(av.PLUGIN_DIR.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        assert "urlopen(" not in source, path.name
        if path.name != "_core.py":
            assert "build_opener(" not in source, path.name
            assert "HTTPRedirectHandler" not in source, path.name


# --------------------------------------------------------------------------
# The events poster
# --------------------------------------------------------------------------


@pytest.mark.parametrize("status", REDIRECTS)
def test_the_poster_refuses_a_redirect_and_the_target_is_never_contacted(core, pair, no_proxy, status):
    redirector, target = pair(status)
    result = core.post_events(redirector.url, EVENTS_TOKEN, [event()])

    assert redirector.requests == [{"method": "POST", "path": "/v1/events", "bearer": True}]
    assert target.connections == 0
    assert target.requests == []
    assert result.ok is False
    assert result.status == status
    assert result.reason == "redirect"
    assert result.redirect_refused is True
    assert result.retryable is True
    assert result.auth_refused is False


@pytest.mark.parametrize("status", [300, 304, 305, 399])
def test_any_other_3xx_is_refused_the_same_way(core, pair, no_proxy, status):
    redirector, target = pair(status)
    result = core.post_events(redirector.url, EVENTS_TOKEN, [event()])
    assert target.connections == 0
    assert (result.ok, result.status, result.reason, result.retryable) == (False, status, "redirect", True)


def test_a_2xx_and_a_4xx_are_not_called_redirects(core, no_proxy):
    with Stub(202) as ok, Stub(403) as refused:
        good = core.post_events(ok.url, EVENTS_TOKEN, [event()])
        bad = core.post_events(refused.url, EVENTS_TOKEN, [event()])
    assert (good.ok, good.status, good.redirect_refused) == (True, 202, False)
    assert (bad.ok, bad.status, bad.reason, bad.redirect_refused, bad.retryable) == (False, 403, "http_error", False, False)


def make_collector(plugin, monkeypatch, url: str):
    monkeypatch.setenv("AV_EVENTS_TOKEN", EVENTS_TOKEN)
    monkeypatch.setenv("AV_EVENTS_URL", url)
    collector_mod = sys.modules[f"{plugin.__name__}._collector"]
    collector = collector_mod.Collector()
    collector._ensure_buffer()
    return collector


def ready_files(collector) -> list[str]:
    import os

    root = collector.config.buffer_dir
    return sorted(n for n in os.listdir(root) if n.endswith(".jsonl") and not n.startswith("current-"))


@pytest.mark.parametrize("status", [302, 307])
def test_the_flusher_keeps_a_redirected_batch_queued_and_logs_only_a_code(
    plugin, monkeypatch, home, pair, no_proxy, caplog, status
):
    redirector, target = pair(status)
    collector = make_collector(plugin, monkeypatch, redirector.url)
    for index in range(50):
        collector.emit("session.started", {"n": index}, session_id="s-redirect")
    queued = ready_files(collector)
    assert len(queued) == 1

    with caplog.at_level(logging.WARNING, logger="av-events"):
        collector.tick()
        name = queued[0]
        collector._backoff[name] = (0.0, 1)  # expire the backoff: a second attempt
        collector.tick()

    assert len(redirector.requests) == 2
    assert target.connections == 0
    # Retryable: still queued, backing off, not quarantined.
    assert ready_files(collector) == queued
    assert not (home / "av-events" / "buffer" / "rejected").exists()
    assert name in collector._backoff
    assert collector.counters.get("ingest_redirect_refused") == 2
    assert "ingest_auth_rejected" not in collector.counters

    lines = [r.getMessage() for r in caplog.records if "redirect" in r.getMessage()]
    assert lines == ["av-events: ingest_redirect_refused=1"], "logged once per process, a name and a count"
    port = redirector.url.rsplit(":", 1)[1]
    for text in (caplog.text, *lines):
        assert "127.0.0.1" not in text
        assert port not in text
        assert target.url.rsplit(":", 1)[1] not in text
        assert "http://" not in text
        assert EVENTS_TOKEN not in text
        assert not re.search(r"Location|/v1/events", text)


# --------------------------------------------------------------------------
# The backup uploader
# --------------------------------------------------------------------------


@pytest.fixture()
def backup_collector(plugin, home, monkeypatch):
    monkeypatch.setenv("AV_BACKUP_TOKEN", BACKUP_TOKEN)
    monkeypatch.setenv("AV_TENANT_ID", TENANT)
    monkeypatch.setenv("AV_EVENTS_TOKEN", EVENTS_TOKEN)
    monkeypatch.setenv("AV_BACKUP_GRACE_S", "0")
    for rel, data in MEMORY.items():
        path = home / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def make(url: str):
        monkeypatch.setenv("AV_BACKUP_URL", url)
        col = plugin.Collector()
        plugin._COLLECTOR = col
        col.backup_uploader = None  # the real `_backup.put_object`
        made.append(col)
        return col

    made: list = []
    yield make
    for col in made:
        col._stop.set()
        col._wake.set()


@pytest.mark.parametrize("status", REDIRECTS)
def test_the_backup_upload_refuses_a_redirect_and_the_target_is_never_contacted(
    backup_collector, pair, no_proxy, caplog, status
):
    redirector, target = pair(status)
    collector = backup_collector(redirector.url)
    with caplog.at_level(logging.WARNING, logger="av-events"):
        assert collector.snapshot_once(now=NOW, timeout=5.0) == "failed"

    # The archive PUT went to the configured host, with its bearer; the
    # manifest never followed, and nothing at all reached the target.
    assert [(r["method"], r["bearer"]) for r in redirector.requests] == [("PUT", True)]
    assert redirector.requests[0]["path"].startswith(f"/v1/backup/{TENANT}/")
    assert target.connections == 0
    assert collector.counters.get("backup_upload_failed") == 1
    assert collector.counters.get("backup_redirect_refused") == 1
    assert "127.0.0.1" not in caplog.text
    assert BACKUP_TOKEN not in caplog.text


@pytest.mark.parametrize("status", [302, 308])
def test_put_object_reports_a_redirect(plugin, av, pair, no_proxy, status):
    backup = sys.modules[f"{av.MODULE_NAME}._backup"]
    redirector, target = pair(status)
    body = b"not really a tarball"
    name = f"memory.{backup.sha256_hex(body)}.tar.gz"
    result = backup.put_object(
        redirector.url, BACKUP_TOKEN, TENANT, "2026-09-21", name, body, "application/gzip", 5.0
    )
    assert (result.ok, result.status, result.reason) == (False, status, "redirect")
    assert target.connections == 0


# --------------------------------------------------------------------------
# The consent fetch (import moved to `_core`)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("status", [302, 307])
def test_the_consent_fetch_still_refuses_a_redirect(plugin, av, pair, no_proxy, status):
    consent = sys.modules[f"{av.MODULE_NAME}._consent"]
    redirector, target = pair(status)
    result = consent.fetch_consent_status(redirector.url, EVENTS_TOKEN)
    assert isinstance(result, consent.ConsentUnavailable)
    assert result.reason == "redirect"
    assert [(r["method"], r["path"], r["bearer"]) for r in redirector.requests] == [("GET", "/v1/consent", True)]
    assert target.connections == 0
