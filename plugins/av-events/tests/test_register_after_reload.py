"""DATA-183: `register()` after a force reload wires the hooks again.

`PluginManager.discover_and_load(force=True)` calls `unload()`, which runs the
plugin's `on_unload` callbacks and clears every hook list, then calls
`register()` again. The Hermes checkout in use re-imports a directory plugin
(`_load_directory_module` evicts it from `sys.modules`), but a loader that
reuses the module (an entry-point plugin, a predeclared module, an older
Hermes) hands `register()` a module whose `_REGISTERED` is still set. It must
not return early then: the hooks it registered are gone.
"""

from __future__ import annotations

from typing import Any, Callable


class UnloadingCtx:
    """A `PluginContext` with `on_unload`, and a manager-style `unload()`.

    Standalone rather than a `FakeCtx` subclass: importlib mode keeps
    `conftest` off `sys.path` (see `Helpers`).
    """

    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.subscriptions: dict[str, list[Callable]] = {}
        self.unload_callbacks: list[Callable[[], None]] = []

    def register_hook(self, hook_name: str, callback: Callable):
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def subscribe(self, event: str, callback: Callable) -> None:
        self.subscriptions.setdefault(event, []).append(callback)

    def fire(self, hook_name: str, **kwargs: Any) -> None:
        for callback in self.hooks.get(hook_name, []):
            callback(**kwargs)

    def on_unload(self, callback: Callable[[], None]):
        self.unload_callbacks.append(callback)
        return object()

    def unload(self) -> None:
        """Like `_unload_scoped(None)`: run the callbacks in reverse, clear the hooks."""
        for callback in reversed(self.unload_callbacks):
            callback()
        self.unload_callbacks.clear()
        self.hooks.clear()
        self.subscriptions.clear()


def test_hooks_are_present_and_firing_after_unload_and_reregister(plugin, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = UnloadingCtx()
    plugin.register(ctx)
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)

    ctx.unload()
    assert ctx.hooks == {}

    # Same module object, as a module-reusing loader would hand back.
    reloaded = UnloadingCtx()
    plugin.register(reloaded)
    assert set(reloaded.hooks) == set(plugin.HOOK_BODIES)
    assert all(len(callbacks) == 1 for callbacks in reloaded.hooks.values())
    assert set(reloaded.subscriptions) == set(plugin.SUBSCRIPTION_BODIES)

    reloaded.fire("on_session_start", session_id="sess-reload", model="m", platform="telegram")
    events = av.read_buffer(plugin._COLLECTOR)
    assert "session.started" in av.types_of(events)


def test_a_second_register_without_unload_still_adds_nothing(plugin):
    ctx = UnloadingCtx()
    plugin.register(ctx)
    plugin.register(ctx)
    assert all(len(callbacks) == 1 for callbacks in ctx.hooks.values())
    assert len(ctx.unload_callbacks) == 1


def test_a_ctx_without_on_unload_still_registers(plugin, ctx):
    """An older Hermes without `on_unload`: register as before, fail open."""
    plugin.register(ctx)
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)


def test_an_unload_stops_the_old_collectors_threads(plugin, monkeypatch, av):
    """On the Hermes in use a force reload re-imports the plugin, so the old
    module's collector must not keep flushing beside the new one (every event
    posted twice). Its flusher and backup threads stop, its exit flush is
    unregistered, and nothing it still holds is sent."""
    import atexit
    import sys
    import time

    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("AV_BACKUP_GRACE_S", "3600")
    core = sys.modules[f"{plugin.__name__}._core"]
    ctx = UnloadingCtx()
    plugin.register(ctx)
    old = plugin._COLLECTOR
    sent = []
    old.sender = lambda url, token, events: (sent.append(events), core.SendResult(True, 202))[1]

    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    flusher = old._thread
    assert flusher is not None and flusher.is_alive()
    with old._backup_lock:
        old._backup_pending = True
        old._backup_first_req = time.monotonic()
        backup = old._start_backup_thread()
    assert backup.is_alive()

    unregistered = []
    monkeypatch.setattr(atexit, "unregister", lambda fn: unregistered.append(fn))
    ctx.unload()

    flusher.join(3)
    backup.join(3)
    assert not flusher.is_alive() and not backup.is_alive()
    assert unregistered == [old.shutdown]
    assert plugin._COLLECTOR is None, "a re-register builds a fresh collector"

    before = len(sent)
    old.buffer.rotate_if_due(force=True)
    time.sleep(core.TICK_INTERVAL_S * 2 + 0.2)
    assert len(sent) == before, "no thread of the old collector sends"

    reloaded = UnloadingCtx()
    plugin.register(reloaded)
    assert plugin._COLLECTOR is not None and plugin._COLLECTOR is not old
    plugin._COLLECTOR._stop.set()
    plugin._COLLECTOR._wake.set()


def test_the_new_buffer_owns_the_lock_after_unload_and_register(plugin, monkeypatch):
    """The old collector's buffer held `current-<pid>.lock`; left open, the
    new buffer found it held and ran with no owner lock, so after gc another
    process could take the gateway's lock and adopt its live current file."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = UnloadingCtx()
    plugin.register(ctx)
    old = plugin._COLLECTOR
    old_buffer = old._ensure_buffer()
    old_handle = old_buffer._owner_lock
    assert old_handle is not None

    ctx.unload()
    assert old_handle.closed and old_buffer._owner_lock is None

    plugin.register(UnloadingCtx())
    new = plugin._COLLECTOR
    try:
        assert new._ensure_buffer()._owner_lock is not None, "the new buffer holds the lock"
    finally:
        new._stop.set()
        new._wake.set()
