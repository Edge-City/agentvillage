"""Loaders for the plugin under test.

The plugin is a package (`__init__.py` imports `._archive`), loaded the way Hermes's plugin
loader does it: `spec_from_file_location(..., submodule_search_locations=[plugin_dir])`.
`_archive` alone is standard library only, so the Hermes-free tests load just that file.
"""
import importlib.util
import itertools
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).parents[1]

_serial = itertools.count()


@pytest.fixture
def load_plugin():
    """Callable returning a fresh copy of the whole plugin package (needs Hermes importable)."""
    loaded = []

    def load():
        pytest.importorskip("hermes_cli.dashboard_auth")
        name = f"edgecity_test_plugin_{next(_serial)}"
        spec = importlib.util.spec_from_file_location(
            name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        loaded.append(name)
        spec.loader.exec_module(module)
        return module

    yield load
    for name in loaded:
        for key in [k for k in sys.modules if k == name or k.startswith(name + ".")]:
            sys.modules.pop(key, None)


@pytest.fixture
def load_archive_copy():
    """Callable returning a fresh copy of `_archive` alone, under its own module name; no Hermes."""
    loaded = []

    def load():
        name = f"edgecity_test_archive_{next(_serial)}"
        spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "_archive.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        loaded.append(name)
        spec.loader.exec_module(module)
        return module

    yield load
    for name in loaded:
        sys.modules.pop(name, None)


@pytest.fixture
def archive(load_archive_copy):
    """A fresh copy of `_archive` alone; no Hermes needed."""
    return load_archive_copy()
