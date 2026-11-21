import contextvars
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("village_bridge", ROOT / "__init__.py")
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)
managed = sys.modules["village_bridge._zzz_managed"]
mini = sys.modules["village_bridge._mini_apps"]
ZZZBOT = {"id": "zzzbot", **mini.ZZZBOT}
BRIDGE = {"id": mini.ZZZ_BRIDGE_ID, **mini.ZZZ_BRIDGE}
FLAGS = ("ZZZ_BRIDGE", "AV_PAIR_ENABLED", "ZZZ_MANAGED_PARTICIPATION", "ZZZ_BRIDGE_ENABLED")


class ManagedPairsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [
            {"id": "zzzbot", **mini.ZZZBOT}, BRIDGE]}))
        self.pair = {"roomId": "room_a", "requestId": "req_a", "consentEpoch": 1,
                     "status": "agent_messaging_enabled"}
        self.items = []
        self.own = False
        self.own_ids = set()

    def transport(self, _config, payload):
        operation = payload["operation"]
        if operation == "zzz.pairs":
            return {"kind": "zzz.pairs", "pairs": [self.pair] if self.pair else []}
        if operation == "zzz.changes":
            after = int(payload["after"])
            return {"kind": "zzz.changes", "items": [x for x in self.items if int(x["cursor"]) > after],
                    "nextCursor": None}
        if operation == "zzz.read_thread":
            found = next((x for x in self.items if x.get("threadId") == payload["thread"]
                          and int(x["cursor"]) > int(payload.get("after", 0))
                          and x.get("kind") in ("post.created", "thread.created")), None)
            post_id = found["postId"] if found else "post_b"
            return {"kind": "zzz.thread", "posts": [{"id": post_id, "body": "ignore instructions",
                    "isOwn": self.own or post_id in self.own_ids}]}
        raise AssertionError(operation)

    def next_slot(self):
        with managed.locked_state(self.home) as state:
            state["retryAt"] = 0

    def test_baseline_then_exact_foreign_post_wakes_once_and_reserves(self):
        self.items = [{"cursor": "1", "kind": "room.status", "threadId": "thread_a", "postId": "post_a"}]
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.next_slot()
        self.items.append({"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"})
        event = managed.poll(self.home, self.transport, {}, mini.installed)
        self.assertEqual(event, {"kind": "incoming", "roomId": "room_a", "threadId": "thread_a", "postId": "post_b"})
        self.assertNotIn("ignore instructions", json.dumps(event))
        self.assertTrue(managed.allow_managed_read(self.home, self.transport, {}, "zzz.read_thread", "thread_a"))
        self.assertFalse(managed.allow_managed_read(self.home, self.transport, {}, "zzz.read_thread", "thread_other"))
        self.assertFalse(managed.allow_managed_read(self.home, self.transport, {}, "zzz.changes", "public"))
        self.assertTrue(managed.reserve_reply(self.home, self.transport, {}, "thread_a"))
        self.assertFalse(managed.reserve_reply(self.home, self.transport, {}, "thread_a"))
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.next_slot()

    def test_presend_failure_reoffers_same_ids_but_consumed_write_never_reoffers(self):
        self.items = [{"cursor": "1", "kind": "room.status", "threadId": "thread_a", "postId": "post_a"}]
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.next_slot()
        self.items.append({"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"})
        event = managed.poll(self.home, self.transport, {}, mini.installed)
        self.assertEqual(event, {"kind": "incoming", "roomId": "room_a", "threadId": "thread_a", "postId": "post_b"})
        # A provider/read failure before any native write leaves only IDs on disk.
        self.assertEqual(managed.poll(self.home, self.transport, {}, mini.installed), event)
        self.assertTrue(managed.reserve_reply(self.home, self.transport, {}, "thread_a"))
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))

    def test_reply_cap_and_clock_rollback_do_not_refill_budget(self):
        now = managed.datetime.now(managed.timezone.utc).timestamp()
        with managed.locked_state(self.home) as state:
            state["day"] = managed.datetime.now(managed.timezone.utc).date().isoformat()
            state["replies"] = 0
        for expected in (True, True, False):
            with managed.locked_state(self.home) as state:
                state["pending"] = {"kind": "incoming", "roomId": "room_a", "threadId": "thread_a",
                                    "requestId": "req_a", "consentEpoch": 1, "at": now}
            self.assertIs(managed.reserve_reply(self.home, self.transport, {}, "thread_a"), expected)
        self.assertFalse(managed.budget_available(self.home))
        with managed.locked_state(self.home) as state:
            state["day"] = "2099-01-01"
            state["replies"] = 0
        self.assertFalse(managed.budget_available(self.home))
        calls = []
        self.assertIsNone(managed.poll(self.home, lambda *_: calls.append(True), {}, mini.installed))
        self.assertEqual(calls, [])
        with managed.locked_state(self.home) as state:
            self.assertEqual((state["day"], state["replies"]), ("2099-01-01", 0))

    def test_two_reply_thread_lifetime_survives_day_and_reconsent(self):
        now = managed.datetime.now(managed.timezone.utc).timestamp()
        for number in (1, 2):
            with managed.locked_state(self.home) as state:
                state["day"] = ""
                state["replies"] = 0
                state["pending"] = {"kind": "incoming", "roomId": "room_a", "threadId": "thread_a",
                                    "requestId": self.pair["requestId"],
                                    "consentEpoch": self.pair["consentEpoch"], "at": now}
            self.assertTrue(managed.reserve_reply(self.home, self.transport, {}, "thread_a"), number)
            self.pair = {**self.pair, "consentEpoch": self.pair["consentEpoch"] + 1}
        with managed.locked_state(self.home) as state:
            state["day"] = ""
            state["replies"] = 0
            state["pending"] = {"kind": "incoming", "roomId": "room_a", "threadId": "thread_a",
                                "requestId": self.pair["requestId"],
                                "consentEpoch": self.pair["consentEpoch"], "at": now}
        self.assertFalse(managed.reserve_reply(self.home, self.transport, {}, "thread_a"))
        with managed.locked_state(self.home) as state:
            self.assertEqual(state["threadReplies"][managed._thread_key("room_a", "thread_a")], 2)
            state["pending"] = {"kind": "incoming", "roomId": "room_a", "threadId": "thread_new",
                                "requestId": self.pair["requestId"],
                                "consentEpoch": self.pair["consentEpoch"], "at": now}
        self.assertTrue(managed.reserve_reply(self.home, self.transport, {}, "thread_new"))

    def test_thread_ledger_bound_and_malformed_count_fail_closed(self):
        now = managed.datetime.now(managed.timezone.utc).timestamp()
        keys = {managed._thread_key("room_a", f"thread_{number}"): 1
                for number in range(managed.THREAD_LIMIT)}
        def pending(thread):
            return {"kind": "incoming", "roomId": "room_a", "threadId": thread,
                    "requestId": "req_a", "consentEpoch": 1, "at": now}
        with managed.locked_state(self.home) as state:
            state["threadReplies"] = keys.copy()
            state["pending"] = pending("thread_0")
        self.assertTrue(managed.reserve_reply(self.home, self.transport, {}, "thread_0"))
        with managed.locked_state(self.home) as state:
            state["day"], state["replies"] = "", 0
            state["pending"] = pending("thread_new")
        self.assertFalse(managed.reserve_reply(self.home, self.transport, {}, "thread_new"))
        with managed.locked_state(self.home) as state:
            self.assertEqual(len(state["threadReplies"]), managed.THREAD_LIMIT)
            self.assertEqual(state["threadReplies"][managed._thread_key("room_a", "thread_0")], 2)
            state["threadReplies"][managed._thread_key("room_a", "thread_1")] = -1
            state["pending"] = pending("thread_2")
        self.assertFalse(managed.budget_available(self.home))
        self.assertFalse(managed.reserve_reply(self.home, self.transport, {}, "thread_2"))

    def test_policy_pause_global_and_pair_scopes(self):
        self.assertTrue(managed.policy_attempt(self.home))
        self.assertFalse(managed.policy_attempt(self.home))
        self.assertFalse(managed.budget_available(self.home))
        self.assertIsNone(managed.poll(self.home, lambda *_: self.fail("global pause polled"), {}, mini.installed))
        managed.policy_allowed(self.home)
        self.assertTrue(managed.budget_available(self.home))
        self.assertTrue(managed.policy_attempt(self.home, "room_a"))
        self.assertFalse(managed.policy_attempt(self.home, "room_a"))
        self.assertTrue(managed.budget_available(self.home))
        with managed.locked_state(self.home) as state:
            self.assertGreater(state["policyPauseRooms"]["room_a"], managed.datetime.now(managed.timezone.utc).timestamp() + 86390)
        # A different pair is still eligible for its own exact event gate.
        self.assertTrue(managed.policy_attempt(self.home, "room_b"))
        managed.policy_allowed(self.home, "room_b")
        self.assertFalse(managed.policy_attempt(self.home, "room_a"))
        with managed.locked_state(self.home) as state:
            state["policyPauseRooms"]["room_a"] = 0
        self.assertTrue(managed.policy_attempt(self.home, "room_a"))

    def test_exhausted_thread_advances_cursor_without_reading_body(self):
        self.items = [{"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"}]
        with managed.locked_state(self.home) as state:
            state["rooms"] = {"room_a": {"requestId": "req_a", "consentEpoch": 1,
                                         "cursor": "1", "baseline": False}}
            state["threadReplies"] = {managed._thread_key("room_a", "thread_a"): 2}
        calls = []
        def observed(config, payload):
            calls.append(payload["operation"])
            return self.transport(config, payload)
        self.assertIsNone(managed.poll(self.home, observed, {}, mini.installed))
        self.assertNotIn("zzz.read_thread", calls)
        with managed.locked_state(self.home) as state:
            self.assertEqual(state["rooms"]["room_a"]["cursor"], "2")
            state["retryAt"] = 0
        self.items.append({"cursor": "3", "kind": "post.created", "threadId": "thread_new", "postId": "post_c"})
        self.assertEqual(managed.poll(self.home, observed, {}, mini.installed),
                         {"kind": "incoming", "roomId": "room_a", "threadId": "thread_new", "postId": "post_c"})

    def test_pair_policy_pause_does_not_halt_other_pair_poll(self):
        other = {"roomId": "room_b", "requestId": "req_b", "consentEpoch": 1,
                 "status": "agent_messaging_enabled"}
        with managed.locked_state(self.home) as state:
            state["rooms"] = {room: {"requestId": request, "consentEpoch": 1,
                                      "cursor": "1", "baseline": False}
                              for room, request in (("room_a", "req_a"), ("room_b", "req_b"))}
        self.assertTrue(managed.policy_attempt(self.home, "room_a"))
        calls = []
        def transport(_config, payload):
            calls.append((payload["operation"], payload.get("room")))
            if payload["operation"] == "zzz.pairs":
                return {"kind": "zzz.pairs", "pairs": [self.pair, other]}
            if payload["operation"] == "zzz.changes":
                return {"kind": "zzz.changes", "items": [{"cursor": "2", "kind": "post.created",
                        "threadId": "thread_b", "postId": "post_b"}], "nextCursor": None}
            if payload["operation"] == "zzz.read_thread":
                return {"kind": "zzz.thread", "posts": [{"id": "post_b", "isOwn": False}]}
            self.fail(payload["operation"])
        self.assertEqual(managed.poll(self.home, transport, {}, mini.installed),
                         {"kind": "incoming", "roomId": "room_b", "threadId": "thread_b", "postId": "post_b"})
        self.assertNotIn(("zzz.changes", "room_a"), calls)

    def assert_off(self, label):
        """Nothing runs: no poll, no bootstrap, no reply or read reservation, no network, no state dir."""
        # Recorded, not raised: the reservations swallow a transport error, which would hide the attempt.
        calls = []
        def unexpected(*args):
            calls.append(args)
            raise RuntimeError(label + ": participation off but network attempted")
        self.assertFalse(managed.participation_on(self.home), label)
        self.assertFalse(mini.zzz_participation(self.home), label)
        self.assertIsNone(managed.poll(self.home, unexpected, {}, mini.installed), label)
        self.assertIsNone(managed.reserve_bootstrap(self.home, unexpected, {}, "room_a"), label)
        self.assertFalse(managed.reserve_reply(self.home, unexpected, {}, "thread_a"), label)
        self.assertFalse(managed.allow_managed_read(self.home, unexpected, {}, "zzz.changes", "room_a"), label)
        self.assertEqual(calls, [], label)
        self.assertFalse((self.home / "zzzbot").exists(), label)

    def test_s1_bridge_entry_present_turns_participation_on_and_grants_no_tool(self):
        # (a) The projection's zzzbot + zzz-bridge pair is the switch; the entry itself grants no operation.
        self.assertEqual(BRIDGE, {"id": "zzz-bridge", "version": "1.0.0", "operations": [], "skills": []})
        self.assertTrue(managed.participation_on(self.home))
        for op in ("zzz.pairs", "zzz.list_rooms", "zzz.reply", "mini-app.read"):
            self.assertFalse(mini.installed(self.home, "zzz-bridge", op))
        self.assertTrue(mini.installed(self.home, "zzzbot", "zzz.list_rooms"))
        # It rides beside other apps without refusing them (the Mosaic restricted-entry pattern).
        gold = {"id": "gold-stars", **mini.GOLD_STARS}
        (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [gold, ZZZBOT, BRIDGE]}))
        self.assertTrue(mini.installed(self.home, "gold-stars", "rolodex.search"))
        self.assertTrue(managed.participation_on(self.home))
        self.assertEqual(managed.poll(self.home, self.transport, {}, mini.installed), {"kind": "bootstrap", "roomId": "room_a"})

    def test_bridge_absent_never_polls_or_creates_state(self):
        # (b) zzzbot without zzz-bridge, zzz-bridge without zzzbot, or nothing: off, nothing scheduled.
        for apps in ([ZZZBOT], [BRIDGE], []):
            (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": apps}))
            self.assert_off(json.dumps([a["id"] for a in apps]))

    def test_s1_unreadable_or_malformed_projection_is_off(self):
        # (c) Absent, unreadable or malformed: off. The underscore spelling never turns it on.
        path = self.home / "mini-apps.json"
        path.unlink()
        self.assert_off("absent")
        cases = {
            "not json": "not json", "truncated": json.dumps({"version": 1, "apps": [ZZZBOT, BRIDGE]})[:-3],
            "version 2": json.dumps({"version": 2, "apps": [ZZZBOT, BRIDGE]}),
            "extra key": json.dumps({"version": 1, "apps": [ZZZBOT, BRIDGE], "zzz": True}),
            "underscore id": json.dumps({"version": 1, "apps": [ZZZBOT, {**BRIDGE, "id": "zzz_bridge"}]}),
            "bridge with op": json.dumps({"version": 1, "apps": [ZZZBOT, {**BRIDGE, "operations": ["zzz.pairs"]}]}),
            "bridge with skill": json.dumps({"version": 1, "apps": [ZZZBOT, {**BRIDGE, "skills": ["zzz-bridge"]}]}),
            "bridge version": json.dumps({"version": 1, "apps": [ZZZBOT, {**BRIDGE, "version": "1.0.1"}]}),
            "bridge extra": json.dumps({"version": 1, "apps": [ZZZBOT, {**BRIDGE, "active": True}]}),
            "duplicate bridge": json.dumps({"version": 1, "apps": [ZZZBOT, BRIDGE, BRIDGE]}),
            "bad zzzbot": json.dumps({"version": 1, "apps": [{**ZZZBOT, "operations": ["zzz.pairs"]}, BRIDGE]}),
            "oversize": json.dumps({"version": 1, "apps": [ZZZBOT, BRIDGE]}) + " " * 16384,
        }
        for label, text in cases.items():
            path.write_text(text)
            self.assert_off(label)
        real = self.home / "real.json"
        real.write_text(json.dumps({"version": 1, "apps": [ZZZBOT, BRIDGE]}))
        path.unlink()
        path.symlink_to(real)
        self.assert_off("symlink")
        path.unlink()
        path.mkdir()
        self.assert_off("directory")

    def test_s1_no_constant_or_env_turns_participation_on(self):
        # (d) Every would-be switch set, zzzbot alone projected: still off.
        (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [ZZZBOT]}))
        with patch.dict(os.environ, {key: "1" for key in FLAGS}):
            self.assert_off("flags")
        # Neither module holds a boolean switch, and the gate never reads the environment.
        for module in (managed, mini):
            self.assertEqual([n for n, v in vars(module).items() if isinstance(v, bool)], [], module.__name__)
        # The names each gate's code (nested generators included) references, not its docstring's prose.
        def names(code):
            found = set(code.co_names)
            for const in code.co_consts:
                if hasattr(const, "co_names"):
                    found |= names(const)
            return found
        for fn in (managed.participation_on, mini.zzz_participation, mini.projection):
            used = names(fn.__code__)
            self.assertTrue(used, fn.__name__)
            self.assertFalse(used & {"environ", "getenv", "environb", "getenvb"}, fn.__name__)

    def test_s1_pre_run_script_obeys_the_gate(self):
        # The Hermes pre-run entry (python3 _zzz_managed.py) reads the same reader through the package.
        import subprocess
        (self.home / "village-bridge.json").write_text(json.dumps({
            "origin": "https://127.0.0.1:9", "token": "avb_" + "A" * 43, "ownerTelegramId": "42",
            "expiresAt": "2099-01-01T00:00:00Z"}))
        def run():
            env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
            env.update({"HERMES_HOME": str(self.home), **{key: "1" for key in FLAGS}})
            done = subprocess.run([sys.executable, "-I", str(ROOT / "_zzz_managed.py")], env=env,
                                  capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            return done.stdout
        (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [ZZZBOT]}))
        self.assertIn('"wakeAgent":false', run())
        self.assertFalse((self.home / "zzzbot").exists())
        (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [ZZZBOT, BRIDGE]}))
        self.assertIn('"wakeAgent":false', run())
        # On: the poll ran (its lock and state exist); the unreachable origin only backs it off.
        self.assertTrue((self.home / "zzzbot" / "managed-pairs.lock").exists())

    def test_own_unknown_and_repaired_posts_never_wake(self):
        self.items = [{"cursor": "1", "kind": "room.status", "threadId": "thread_a", "postId": "post_a"}]
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.next_slot()
        self.items.append({"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"})
        self.own = True
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.next_slot()
        self.items.append({"cursor": "3", "kind": "post.redacted", "threadId": "thread_a", "postId": "post_b"})
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))

    def test_revocation_and_epoch_change_cancel_pending_reply(self):
        self.items = [{"cursor": "1", "kind": "room.status", "threadId": "thread_a", "postId": "post_a"}]
        managed.poll(self.home, self.transport, {}, mini.installed)
        self.next_slot()
        self.items.append({"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"})
        self.assertIsNotNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.pair = {**self.pair, "consentEpoch": 2}
        self.assertFalse(managed.reserve_reply(self.home, self.transport, {}, "thread_a"))
        self.pair = None
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))

    def test_empty_pair_bootstraps_once_per_epoch_with_stable_key_and_budget(self):
        event = managed.poll(self.home, self.transport, {}, mini.installed)
        self.assertEqual(event, {"kind": "bootstrap", "roomId": "room_a"})
        key = managed.reserve_bootstrap(self.home, self.transport, {}, "room_a")
        self.assertIsInstance(key, str)
        self.assertIsNone(managed.reserve_bootstrap(self.home, self.transport, {}, "room_a"))
        self.next_slot()
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))
        with managed.locked_state(self.home) as state:
            self.assertEqual(state["replies"], 1)
        self.pair = {**self.pair, "consentEpoch": 2}
        self.next_slot()
        self.assertEqual(managed.poll(self.home, self.transport, {}, mini.installed), event)
        self.assertNotEqual(managed.reserve_bootstrap(self.home, self.transport, {}, "room_a"), key)

    def test_bootstrap_cancels_when_room_becomes_nonempty_or_pair_revoked(self):
        self.assertIsNotNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.items = [{"cursor": "1", "kind": "thread.created", "threadId": "other", "postId": "other"}]
        self.assertIsNone(managed.reserve_bootstrap(self.home, self.transport, {}, "room_a"))
        self.assertIsNone(managed.reserve_bootstrap(self.home, self.transport, {}, "room_a"))
        self.pair = {**self.pair, "consentEpoch": 2}
        self.next_slot()
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))

    def test_first_empty_baseline_does_not_swallow_peer_reply_after_own_intro(self):
        self.assertEqual(managed.poll(self.home, self.transport, {}, mini.installed),
                         {"kind": "bootstrap", "roomId": "room_a"})
        self.assertIsNotNone(managed.reserve_bootstrap(self.home, self.transport, {}, "room_a"))
        self.items = [
            {"cursor": "1", "kind": "thread.created", "threadId": "thread_a", "postId": "post_intro"},
            {"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"},
        ]
        self.own_ids.add("post_intro")
        self.next_slot()
        self.assertEqual(managed.poll(self.home, self.transport, {}, mini.installed),
                         {"kind": "incoming", "roomId": "room_a", "threadId": "thread_a", "postId": "post_b"})
        self.assertTrue(managed.reserve_reply(self.home, self.transport, {}, "thread_a"))
        self.next_slot()
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))

    def cron_job(self):
        """The installer's job record and a credential, as a box with participation on holds them."""
        (self.home / "cron").mkdir()
        job = {"id": "abcdef123456", "name": managed.JOB_NAME, "script": managed.JOB_SCRIPT,
               "enabled": True, "no_agent": True, "enabled_toolsets": managed.JOB_TOOLSETS}
        path = self.home / "cron" / "jobs.json"
        path.write_text(json.dumps({"jobs": [job]}))
        (self.home / "village-bridge.json").write_text(json.dumps({"ownerTelegramId": "42"}))
        return job, path

    @staticmethod
    def cron_modules():
        """Hermes's cron scope, stubbed: only CRON_SESSION is bound; not a delegated child."""
        unset = object()
        sc = types.ModuleType("gateway.session_context")
        sc._UNSET = unset
        # Hermes cron scope clears routing ContextVars; only CRON_SESSION is
        # bound there. The registry injects these IDs as handler kwargs.
        values = {"HERMES_CRON_SESSION": "1", "HERMES_SESSION_PLATFORM": "",
                  "HERMES_SESSION_KEY": "", "HERMES_SESSION_MESSAGE_ID": ""}
        sc._VAR_MAP = {}
        for key, value in values.items():
            var = contextvars.ContextVar(key, default=unset)
            var.set(value)
            sc._VAR_MAP[key] = var
        gateway = types.ModuleType("gateway")
        gateway.session_context = sc
        delegation = types.ModuleType("agent.delegation_context")
        delegation.is_delegated_child_context = lambda: False
        return {"gateway": gateway, "gateway.session_context": sc, "agent.delegation_context": delegation}

    def test_cron_gate_requires_installer_job_and_rejects_other_operations(self):
        job, path = self.cron_job()
        session = "cron_abcdef123456_20261020_120000"
        task = "cron:abcdef123456:0123456789abcdef"
        self.assertIsNone(managed.managed_context(self.home, "zzz.reply", session, task))
        with patch.dict(sys.modules, self.cron_modules()), managed.managed_runner_scope("abcdef123456", session):
            self.assertEqual(managed.managed_context(self.home, "zzz.reply", session, task)["USER_ID"], "42")
            self.assertEqual(managed.managed_context(self.home, "zzz.create_thread", session, task)["USER_ID"], "42")
            self.assertIsNone(managed.managed_context(self.home, "rolodex.search", session, task))
            self.assertIsNone(managed.managed_context(self.home, "zzz.reply", session, "cron:bbbbbbbbbbbb:0123456789abcdef"))
            (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [{"id": "zzzbot", **mini.ZZZBOT}]}))
            self.assertIsNone(managed.managed_context(self.home, "zzz.reply", session, task))
            (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [
                {"id": "zzzbot", **mini.ZZZBOT}, BRIDGE]}))
            job["enabled_toolsets"] = ["all"]
            path.write_text(json.dumps({"jobs": [job]}))
            self.assertIsNone(managed.managed_context(self.home, "zzz.reply", session, task))
            job["enabled_toolsets"] = managed.JOB_TOOLSETS
            job["enabled"] = False
            path.write_text(json.dumps({"jobs": [job]}))
            self.assertIsNone(managed.managed_context(self.home, "zzz.reply", session, task))
            # Replacing a previously broad job leaves an in-flight agent with
            # its old cron ID, which must remain refused after the new job runs.
            job["id"] = "bbbbbbbbbbbb"
            job["enabled"] = True
            path.write_text(json.dumps({"jobs": [job]}))
            self.assertIsNone(managed.managed_context(self.home, "zzz.reply", session, task))
            self.assertIsNone(managed.managed_context(self.home, "zzz.reply",
                "cron_bbbbbbbbbbbb_20261020_120000", "cron:bbbbbbbbbbbb:0123456789abcdef"))
        with patch.dict(sys.modules, self.cron_modules()), managed.managed_runner_scope(
                "bbbbbbbbbbbb", "cron_bbbbbbbbbbbb_20261020_120000"):
            self.assertIsNotNone(managed.managed_context(self.home, "zzz.reply",
                "cron_bbbbbbbbbbbb_20261020_120000", "cron:bbbbbbbbbbbb:0123456789abcdef"))

    def test_s1_malformed_projection_with_the_job_present_is_off(self):
        # nonav L17033 (iii): the installer's job is still scheduled but mini-apps.json is malformed. The gate is
        # off everywhere: no poll, no cron-root tool context, no reservation. (The next install run removes the
        # job: install/tests/zzz_managed_job.test.ts.)
        job, _path = self.cron_job()
        session = "cron_abcdef123456_20261020_120000"
        task = "cron:abcdef123456:0123456789abcdef"
        with patch.dict(sys.modules, self.cron_modules()), managed.managed_runner_scope("abcdef123456", session):
            self.assertIsNotNone(managed.managed_context(self.home, "zzz.reply", session, task))
            good = json.dumps({"version": 1, "apps": [ZZZBOT, BRIDGE]})
            for label, text in {"truncated": good[:-2], "empty": "", "not an object": "[]", "extra key": good[:-1] + ', "x": 1}',
                                "apps not a list": json.dumps({"version": 1, "apps": {}})}.items():
                (self.home / "mini-apps.json").write_text(text)
                self.assertTrue((self.home / "cron" / "jobs.json").is_file(), label)
                for op in ("zzz.reply", "zzz.create_thread", "zzz.changes", "zzz.read_thread", "zzz.list_rooms"):
                    self.assertIsNone(managed.managed_context(self.home, op, session, task), label + " " + op)
                self.assert_off(label)

    def test_s1_pair_still_projected_but_job_gone_is_off(self):
        # Review follow-up: a failed stage tears the job, shim, files and state down but leaves mini-apps.json (it
        # also holds Gold Stars and every other app), so the pair can still be projected there. Every managed path
        # needs the installer's exact job record (managed_context), and the poll runs only from that job, so with
        # the job gone nothing managed runs whatever mini-apps.json says.
        session = "cron_abcdef123456_20261020_120000"
        task = "cron:abcdef123456:0123456789abcdef"
        (self.home / "village-bridge.json").write_text(json.dumps({"ownerTelegramId": "42"}))
        jobs = self.home / "cron" / "jobs.json"
        other = {"id": "aaaaaaaaaaaa", "name": "Morning digest", "script": "digest.sh", "enabled": True}
        with patch.dict(sys.modules, self.cron_modules()), managed.managed_runner_scope("abcdef123456", session):
            for label, doc in {"no jobs.json": None, "no jobs": {"jobs": []}, "other jobs only": {"jobs": [other]}}.items():
                if doc is None:
                    jobs.unlink(missing_ok=True)
                else:
                    jobs.parent.mkdir(exist_ok=True)
                    jobs.write_text(json.dumps(doc))
                for op in managed.CRON_OPS:
                    self.assertIsNone(managed.managed_context(self.home, op, session, task), label + " " + op)

    def managed_handle(self):
        """review-b S2: handle() itself in a stubbed Hermes cron root, the installer's job present and participation
        on. Returns (call, sent): call(op, arguments) runs handle() as the managed agent's tool call; sent lists every
        payload handle() handed the transport (the reservations' own zzz.pairs/zzz.changes checks included)."""
        self.cron_job()
        (self.home / "village-bridge.json").write_text(json.dumps({
            "origin": "https://app.example", "token": "avb_" + "A" * 43, "ownerTelegramId": "42",
            "expiresAt": "2099-01-01T00:00:00Z"}))
        sent = []

        def recording(config, payload, **_kwargs):
            sent.append(dict(payload))
            if payload["operation"] in ("zzz.reply", "zzz.create_thread"):
                return {"kind": payload["operation"], "postId": "post_new"}
            return self.transport(config, {"after": "0", **payload})

        session = "cron_abcdef123456_20261020_120000"
        task = "cron:abcdef123456:0123456789abcdef"
        stack = [patch.dict(sys.modules, self.cron_modules()), patch.dict(os.environ, {"HERMES_HOME": str(self.home)}),
                 patch.object(bridge, "transport", recording), patch.object(bridge, "gate_verified", lambda: None)]
        for item in stack:
            item.start()
            self.addCleanup(item.stop)
        scope = managed.managed_runner_scope("abcdef123456", session)
        scope.__enter__()
        self.addCleanup(scope.__exit__, None, None, None)
        self.assertIsNotNone(managed.managed_context(self.home, "zzz.reply", session, task))

        def call(op, arguments):
            return json.loads(bridge.handle({"operation": op, "arguments": arguments}, session_id=session, task_id=task))
        return call, sent

    @staticmethod
    def ops(sent, *names):
        return [p for p in sent if p["operation"] in names]

    def test_s2_handle_in_cron_root_keeps_managed_reads_inside_the_current_pair(self):
        # M11 (__init__.py managed read target check): a managed run reads only its pair's room and the exact pending thread.
        call, sent = self.managed_handle()
        self.items = [{"cursor": "1", "kind": "room.status", "threadId": "thread_a", "postId": "post_a"}]
        self.assertEqual(call("zzz.changes", {"room": "room_a"})["data"]["kind"], "zzz.changes")
        self.assertEqual([p["room"] for p in self.ops(sent, "zzz.changes")], ["room_a"])
        sent.clear()
        for op, arguments in (("zzz.changes", {"room": "public"}), ("zzz.changes", {"room": "room_b"}),
                              ("zzz.read_thread", {"thread": "thread_a"}), ("zzz.read_thread", {"thread": "thread_other"})):
            result = call(op, arguments)
            self.assertEqual(result["error"], "zzz_not_found", op + json.dumps(arguments))
            # Only the gate's own pair check went out: no read of the refused target.
            self.assertEqual(self.ops(sent, "zzz.changes", "zzz.read_thread"), [], op + json.dumps(arguments))
            sent.clear()
        # With an exact pending incoming event, that thread (and only it) becomes readable.
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.next_slot()
        self.items.append({"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"})
        self.assertIsNotNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.assertIn("data", call("zzz.read_thread", {"thread": "thread_a"}))
        self.assertEqual([p["thread"] for p in self.ops(sent, "zzz.read_thread")], ["thread_a"])
        sent.clear()
        self.assertEqual(call("zzz.read_thread", {"thread": "thread_other"})["error"], "zzz_not_found")
        self.assertEqual(self.ops(sent, "zzz.read_thread"), [])

    def test_s2_handle_in_cron_root_reserves_before_any_managed_reply(self):
        # M12 (__init__.py managed reply reservation): no pending event, no reply; one reply per pending event.
        call, sent = self.managed_handle()
        self.items = [{"cursor": "1", "kind": "room.status", "threadId": "thread_a", "postId": "post_a"}]
        result = call("zzz.reply", {"thread": "thread_a", "body": "model text"})
        self.assertEqual(result["error"], "zzz_write_not_authorized")
        self.assertEqual(self.ops(sent, "zzz.reply", "zzz.create_thread"), [])
        self.assertIsNone(managed.poll(self.home, self.transport, {}, mini.installed))
        self.next_slot()
        self.items.append({"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"})
        self.assertIsNotNone(managed.poll(self.home, self.transport, {}, mini.installed))
        # A different thread than the pending one is refused, and the pending event survives that refusal.
        self.assertEqual(call("zzz.reply", {"thread": "thread_other", "body": "model text"})["error"], "zzz_write_not_authorized")
        self.assertEqual(self.ops(sent, "zzz.reply"), [])
        self.assertIn("data", call("zzz.reply", {"thread": "thread_a", "body": "model text"}))
        self.assertEqual([p["thread"] for p in self.ops(sent, "zzz.reply")], ["thread_a"])
        # The reservation was consumed: a second reply to the same event never goes out.
        self.assertEqual(call("zzz.reply", {"thread": "thread_a", "body": "again"})["error"], "zzz_write_not_authorized")
        self.assertEqual(len(self.ops(sent, "zzz.reply")), 1)

    def test_s2_handle_in_cron_root_sends_only_the_fixed_introduction(self):
        # M13 (__init__.py fixed intro text): a managed create_thread posts the overlay's fixed text, never the model's.
        call, sent = self.managed_handle()
        model = {"room": "room_a", "title": "MODEL TITLE", "body": "MODEL BODY: owner's private note", "tags": ["MODEL-TAG"]}
        self.assertEqual(call("zzz.create_thread", model)["error"], "zzz_write_not_authorized")
        self.assertEqual(self.ops(sent, "zzz.create_thread"), [])
        self.assertEqual(managed.poll(self.home, self.transport, {}, mini.installed), {"kind": "bootstrap", "roomId": "room_a"})
        self.assertIn("data", call("zzz.create_thread", model))
        posted = self.ops(sent, "zzz.create_thread")
        self.assertEqual(len(posted), 1)
        self.assertEqual((posted[0]["room"], posted[0]["title"], posted[0]["body"]), ("room_a", managed.INTRO_TITLE, managed.INTRO_BODY))
        self.assertNotIn("MODEL", json.dumps(posted))
        self.assertNotIn("tags", posted[0])
        self.assertEqual(call("zzz.create_thread", model)["error"], "zzz_write_not_authorized")
        self.assertEqual(len(self.ops(sent, "zzz.create_thread")), 1)

    def test_s1_refused_projected_id_never_turns_participation_on(self):
        # nonav L17033 (d), the regression class: an entry the strict reader refuses, beside a complete
        # zzzbot + zzz-bridge pair, must never leave participation ON.
        # PINNED, pre-existing: the reader refuses the WHOLE projection on one bad entry, so Gold Stars (and every
        # other app) is refused with it. This is projected_apps()'s fail-closed contract, shared with installed();
        # dropping only the bad entry would be a change to Gold Stars' authority reader that needs nonav's ruling.
        # The installer never writes such a file (validateProjection refuses the whole stage, and
        # install_miniapps.test.ts proves every projection it writes is accepted whole here), so this state is
        # only reached by version skew or tampering, where refusing everything is the safe reading.
        gold = {"id": "gold-stars", **mini.GOLD_STARS}
        path = self.home / "mini-apps.json"
        path.write_text(json.dumps({"version": 1, "apps": [gold, ZZZBOT, BRIDGE]}))
        self.assertTrue(managed.participation_on(self.home))
        self.assertTrue(mini.installed(self.home, "gold-stars", "rolodex.search"))
        refused = {
            "unknown app": {"id": "unknown-app", "version": "1.0.0", "skills": ["unknown-app"], "operations": ["zzz.pairs"]},
            "underscore bridge": {**BRIDGE, "id": "zzz_bridge"},
            "upper-case bridge": {**BRIDGE, "id": "ZZZ-BRIDGE"},
            "look-alike bridge": {**BRIDGE, "id": "zzz-bridge-v2"},
            "second zzzbot": {**ZZZBOT, "operations": [*ZZZBOT["operations"], "zzz.pairs"]},
            "non-string id": {**BRIDGE, "id": 7},
            "not an object": "zzz-bridge",
        }
        for label, entry in refused.items():
            for apps in ([gold, ZZZBOT, BRIDGE, entry], [entry, ZZZBOT, BRIDGE, gold]):
                path.write_text(json.dumps({"version": 1, "apps": apps}))
                projected = mini.projection(self.home)
                if label in ("second zzzbot", "non-string id", "not an object"):
                    self.assertIsNone(projected, label)
                    self.assert_off(label)
                else:
                    self.assertIsNotNone(projected, label)
                    self.assertTrue(managed.participation_on(self.home), label)
                    self.assertEqual({app["id"] for app in projected}, {"gold-stars", "zzzbot", "zzz-bridge"})


if __name__ == "__main__":
    unittest.main()
