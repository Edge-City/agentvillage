"""Offline contract check against a named, real Hermes source checkout.

Run with Hermes's interpreter and the runtime checkout as the only argument.
No credential file, server or Telegram account is used.
"""
import importlib.util
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from gateway import session_context as sc
from agent.delegation_context import delegated_child_context

spec = importlib.util.spec_from_file_location("village_canary", Path(__file__).parents[1] / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)

def refused():
    try:
        plugin.bound_context()
    except (ValueError, KeyError):
        return
    raise AssertionError("Context unexpectedly authorized")

sc.reset_session_vars()
refused()
args = dict(platform="telegram", chat_type="private", chat_id="123", user_id="123",
            session_key="telegram:123", message_id="456", cron_session="")
sc.set_session_vars(**args)
assert plugin.bound_context()["USER_ID"] == "123"
for override in [dict(chat_type="group"), dict(user_id="999"), dict(message_id=""), dict(cron_session="1")]:
    sc.set_session_vars(**(args | override))
    refused()
sc.set_session_vars(**args)
with delegated_child_context():
    refused()
sc.reset_session_vars()
print("Pinned native runtime: owner DM accepted; unbound, group, other user, missing message, cron and delegate refused")
