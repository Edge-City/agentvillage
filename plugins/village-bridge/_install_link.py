"""MINIAPP-INSTALL-LINK (v2.1.5): the `mini_app_not_installed` refusal carries the app's one-tap install link.

The code stays closed (`mini_app_not_installed`). What it gains comes only from reviewed sources:
- the link, name and one line from _install_catalog.py (generated from mini-apps/*/manifest.json), looked up by
  the app id; a caller's appId is a lookup key only, never echoed and never part of a URL;
- the words from _install_copy.py (product's strings);
- which apps this resident can open in Mini-apps from AV_MINI_APPS_OFFERED, a comma-separated list of catalog
  app ids the control plane writes into the box's env. The app's /mini-apps page is a 404 outside its
  MINI_APPS_COHORT, and a restricted app (MINI_APPS_TENANT_ALLOWLIST) has no sheet for a tenant outside its list,
  so a link is given only for an app that list names. Unset, empty or malformed: no link at all (fail closed);
  the agent still never sends the resident to the team.
- an app that comes with every agent (STAFF: the manifest's `"staff": true`, cp#322; Gold Stars, which Rolodex rides)
  never gets an install link, whatever AV_MINI_APPS_OFFERED says: the resident can neither install nor remove it.
  It answers NOT_YET's words (product L13443): installed but missing the operation, NOT_YET itself; no entry on the
  box yet (the cp's backfill has not reached it), STAFF_PENDING.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from . import _install_copy as copy
from ._install_catalog import INSTALLABLE, STAFF
from ._mini_apps import projection

OFFERED_ENV = "AV_MINI_APPS_OFFERED"
APP_ID = re.compile(r"[a-z][a-z0-9-]{0,63}")


def offered(environ=None) -> tuple:
    """The catalog entries this resident can open in Mini-apps, in catalog order; () unless the cp's list is valid."""
    raw = (os.environ if environ is None else environ).get(OFFERED_ENV)
    if not isinstance(raw, str) or not raw.strip():
        return ()
    ids = [part.strip() for part in raw.split(",")]
    if any(not APP_ID.fullmatch(part) for part in ids) or len(set(ids)) != len(ids):
        return ()
    return tuple(dict(app) for app in INSTALLABLE if app["id"] in ids)


def not_installed(home: Path, app_id: object, handling: str) -> dict:
    """The refusal for an operation whose app is not installed (or not installed with that operation)."""
    apps = projection(home)
    have = {app["id"] for app in apps} if apps else set()
    offer = offered()
    match = next((app for app in offer if app["id"] == app_id), None) if isinstance(app_id, str) else None
    out = {"error": "mini_app_not_installed"}
    installed_app = next((app for app in INSTALLABLE + STAFF if app["id"] == app_id), None) if isinstance(app_id, str) and app_id in have else None
    staff_app = next((app for app in STAFF if app["id"] == app_id), None) if isinstance(app_id, str) else None
    if staff_app is not None and installed_app is None:
        # Comes with every agent but has no entry here yet: never an install link (there is nothing to install).
        out["instruction"] = copy.STAFF_PENDING.format(name=staff_app["name"])
    elif installed_app is not None:
        # Installed, but this box's entry does not carry the operation yet (e.g. rolodex.person before the
        # control plane serves the person entry): an install link would only show "Installed".
        out["instruction"] = copy.NOT_YET.format(name=installed_app["name"])
    elif match is not None:
        out.update(appName=match["name"], installUrl=match["installUrl"], instruction=copy.NOT_INSTALLED)
    else:
        # Outside the reviewed catalog, not offered to this resident, or installed under a name the catalog lacks.
        out["instruction"] = copy.NOT_OFFERED
    out["installable"] = [app for app in offer if app["id"] not in have and app is not match]
    out["handling"] = handling
    return out
