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
