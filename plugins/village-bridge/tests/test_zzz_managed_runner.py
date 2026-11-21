"""The no_agent responder sends only its fixed instruction and current post."""
import importlib.util
import contextvars
import hashlib
import json
import os
from pathlib import Path
import shutil
import socketserver
import sys
import tempfile
import threading
import types
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler


RUNNER = Path(__file__).parents[3] / "skills/zzzbot/scripts/zzz_managed_runner.py"
# Resolve the platform temp root so the runner's symlink-safe file reads are
# exercised under a real path on macOS and Linux alike.
SAFE_TEMP_PARENT = Path(tempfile.gettempdir()).resolve(strict=True)
spec = importlib.util.spec_from_file_location("zzz_managed_runner_test", RUNNER)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class _Client:
    def __init__(self, content="A useful reply.", tool_calls=None):
        self.calls = []
        self.content = content
        self.tool_calls = tool_calls
        self.options = None
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))

    def __enter__(self): return self

    def __exit__(self, *_args): pass

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = types.SimpleNamespace(content=self.content, tool_calls=self.tool_calls, function_call=None)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message, finish_reason="stop")])


class ManagedRunnerTest(unittest.TestCase):
    def provider(self, client):
        class Http:
            def __init__(self, **kwargs): self.options = kwargs
            def __enter__(self): return self
            def __exit__(self, *_args): pass

        openai = types.ModuleType("openai")
        openai.OpenAI = lambda **kwargs: setattr(client, "options", kwargs) or client
        httpx = types.ModuleType("httpx")
        httpx.Client = Http
        return patch.dict(sys.modules, {"openai": openai, "httpx": httpx})

    @staticmethod
    def config(home, provider="openrouter"):
        (home / "config.yaml").write_text(f"model:\n  provider: {provider}\n  default: configured-model\n")

    def test_actual_completion_request_excludes_every_private_context_source(self):
        with tempfile.TemporaryDirectory(dir=SAFE_TEMP_PARENT) as tmp:
            home = Path(tmp)
            markers = ["MEMORY_PRIVATE", "USER_PRIVATE", "SOUL_PRIVATE", "AGENTS_PRIVATE",
                       "PROFILE_PRIVATE", "PREFILL_PRIVATE", "PLATFORM_PRIVATE", "PLUGIN_PRIVATE"]
            for name, marker in zip(("MEMORY.md", "USER.md", "SOUL.md", "AGENTS.md", "profile.md",
                                     "prefill.json", "platform_hints.txt", "plugins.txt"), markers):
                (home / name).write_text(marker)
            self.config(home)
            client = _Client()
            bridge = types.SimpleNamespace(installed=lambda *_args: True, transport=lambda *_args, **_kw: {})
            native = []
            event = {"kind": "incoming", "roomId": "room_a", "threadId": "thread_a", "postId": "post_b"}

            class Managed:
                @staticmethod
                def participation_on(_home): return True

                @staticmethod
                def budget_available(_home): return True

                @staticmethod
                def poll(*_args): return event

                @staticmethod
                @contextmanager
                def managed_runner_scope(_job, _session):
                    yield

            with (self.provider(client), patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"}),
                  patch.object(runner, "_bridge", return_value=(bridge, Managed)),
                  patch.object(runner, "_job", return_value="abcdef123456"),
                  patch.object(runner, "_config", return_value={}),
                  patch.object(runner, "_approval_gate", return_value=object()),
                  patch.object(runner, "_runner_turn", side_effect=lambda _home: self.accepted_turn()),
                  patch.object(runner, "_policy_allowed", return_value=True),
                  patch.object(runner, "_pending_post", return_value="Can we meet at three?"),
                  patch.object(runner, "_native", side_effect=lambda *args: native.append(args[-1]) or {})):
                runner.run(home)
            self.assertEqual(native, [{"operation": "zzz.reply", "thread": "thread_a", "body": "A useful reply."}])
            self.assertEqual(len(client.calls), 1)
            self.assertEqual(client.options["base_url"], "https://openrouter.ai/api/v1")
            self.assertEqual(client.options["max_retries"], 0)
            self.assertFalse(client.options["http_client"].options["trust_env"])
            request = client.calls[0]
            self.assertEqual(set(request), {"model", "messages", "max_tokens", "timeout"})
            self.assertEqual(request["max_tokens"], 512)
            self.assertEqual(request["timeout"], 30)
            self.assertEqual(request["messages"], [
                {"role": "system", "content": runner.SYSTEM},
                {"role": "user", "content": "Can we meet at three?"},
            ])
            self.assertTrue(all(marker not in json.dumps(request) for marker in markers))

    def test_tool_call_and_unbounded_completion_cannot_become_native_reply(self):
        with tempfile.TemporaryDirectory(dir=SAFE_TEMP_PARENT) as tmp:
            home = Path(tmp)
            self.config(home)
            for client in (_Client("reply", tool_calls=[{"name": "village"}]), _Client("x" * 8001), _Client("")):
                with self.provider(client), patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"}), self.assertRaises(ValueError):
                    runner._reply("one current post", home)
                self.assertEqual(len(client.calls), 1)

    def test_external_agent_provider_is_rejected_before_client_construction(self):
        with tempfile.TemporaryDirectory(dir=SAFE_TEMP_PARENT) as tmp:
            home = Path(tmp)
            self.config(home, "copilot-acp")
            client = _Client()
            with self.provider(client), self.assertRaises(ValueError):
                runner._reply("one current post", home)
            self.assertIsNone(client.options)

    def test_provider_key_is_bound_to_this_home(self):
        with tempfile.TemporaryDirectory(dir=SAFE_TEMP_PARENT) as tmp:
            home = Path(tmp)
            self.config(home)
            (home / ".env").write_text("OPENROUTER_API_KEY=profile-key\n")
            with patch.dict("os.environ", {"OPENROUTER_API_KEY": "other-profile-key"}):
                endpoint, key, model = runner._model_route(home)
            self.assertEqual((endpoint, key, model),
                ("https://openrouter.ai/api/v1", "profile-key", "configured-model"))

    def test_control_plane_model_without_provider_uses_only_bound_openrouter_route(self):
        with tempfile.TemporaryDirectory(dir=SAFE_TEMP_PARENT) as tmp:
            home = Path(tmp)
            (home / ".env").write_text("OPENROUTER_API_KEY=profile-key\n")
            for provider_line in ("", "  provider: auto\n"):
                (home / "config.yaml").write_text(
                    "model:\n  default: openai/gpt-6-luna\n  max_tokens: 4096\n" + provider_line)
                with patch.dict("os.environ", {"OPENROUTER_API_KEY": "other-profile-key"}):
                    self.assertEqual(runner._model_route(home),
                        ("https://openrouter.ai/api/v1", "profile-key", "openai/gpt-6-luna"))
            (home / ".env").unlink()
            with patch.dict("os.environ", {"OPENROUTER_API_KEY": "other-profile-key"}), self.assertRaises(ValueError):
                runner._model_route(home)

    def test_bootstrap_supplies_the_real_bridge_required_fields(self):
        bridge_spec = importlib.util.spec_from_file_location("village_bridge", Path(__file__).parents[1] / "__init__.py")
        bridge = importlib.util.module_from_spec(bridge_spec)
        with patch.dict(sys.modules, {"village_bridge": bridge}):
            bridge_spec.loader.exec_module(bridge)
        calls = []
        fake_bridge = types.SimpleNamespace(installed=lambda *_args: True, transport=lambda *_args, **_kw: {})

        class Managed:
            INTRO_TITLE, INTRO_BODY = bridge.INTRO_TITLE, bridge.INTRO_BODY

            @staticmethod
            def participation_on(_home): return True

            @staticmethod
            def budget_available(_home): return True

            @staticmethod
            def poll(*_args): return {"kind": "bootstrap", "roomId": "room_a"}

            @staticmethod
            @contextmanager
            def managed_runner_scope(_job, _session): yield

        with (patch.object(runner, "_bridge", return_value=(fake_bridge, Managed)),
              patch.object(runner, "_job", return_value="abcdef123456"),
              patch.object(runner, "_config", return_value={}),
              patch.object(runner, "_approval_gate", return_value=object()),
              patch.object(runner, "_runner_turn", side_effect=lambda _home: self.accepted_turn()),
              patch.object(runner, "_policy_allowed", return_value=True),
              patch.object(runner, "_native", side_effect=lambda *args: calls.append(args[-1]) or {})):
            runner.run(SAFE_TEMP_PARENT)
        self.assertEqual(len(calls), 1)
        args = {"operation": calls[0]["operation"], "arguments": {
            key: value for key, value in calls[0].items() if key != "operation"}}
        payload = bridge.zzz_payload("zzz.create_thread", args, {"SESSION_KEY": "s", "MESSAGE_ID": "m"})
        self.assertEqual(payload["room"], "room_a")
        self.assertEqual(payload["title"], bridge.INTRO_TITLE)
        self.assertEqual(payload["body"], bridge.INTRO_BODY)

    def test_native_call_uses_reviewed_bridge_argument_envelope(self):
        calls = []
        bridge = types.SimpleNamespace(handle=lambda args, **kwargs:
            calls.append((args, kwargs)) or json.dumps({"data": {"kind": "zzz.thread", "posts": []}}))
        result = runner._native(bridge, "cron_abcdef123456_20261023_120000", "cron:abcdef123456:0123456789abcdef",
                                {"operation": "zzz.read_thread", "thread": "thread_a", "after": "7", "limit": 1})
        self.assertEqual(result, {"kind": "zzz.thread", "posts": []})
        self.assertEqual(calls[0][0], {"operation": "zzz.read_thread", "arguments":
            {"thread": "thread_a", "after": "7", "limit": 1}})

    @staticmethod
    @contextmanager
    def accepted_turn():
        yield True

    def test_runner_failure_exposes_only_nonzero_status(self):
        with patch.object(runner, "run", side_effect=ValueError("private-pair-body")), \
             patch.object(runner.os, "_exit", side_effect=SystemExit(1)) as stop:
            try:
                with self.assertRaises(SystemExit):
                    runner.main()
            finally:
                runner.signal.alarm(0)
        stop.assert_called_once_with(1)

    def test_installed_gate_and_native_bridge_allow_only_policy_admitted_reply(self):
        """Exercise the actual backstop and native gate; fake only policy/model/ZZZ transport."""
        import yaml
        repo = RUNNER.parents[3]
        with tempfile.TemporaryDirectory(dir=SAFE_TEMP_PARENT) as tmp:
            home = Path(tmp)
            plugin = home / "plugins" / "av-approval"
            plugin.mkdir(parents=True)
            shutil.copyfile(repo / "plugins/av-approval/__init__.py", plugin / "__init__.py")
            shim = home / "agent-hooks" / "hermes-hook-shim.sh"
            shim.parent.mkdir()
            shim.write_bytes((repo / "skills/approval/scripts/hermes-hook-shim.sh").read_bytes())
            shim.chmod(0o700)
            (shim.parent / "approval-surface.json").write_text(json.dumps({
                "shim_sha256": hashlib.sha256(shim.read_bytes()).hexdigest()}))
            source_spec = importlib.util.spec_from_file_location("av_approval_matchers", plugin / "__init__.py")
            source = importlib.util.module_from_spec(source_spec)
            source_spec.loader.exec_module(source)
            config = {"model": {"provider": "openrouter", "default": "configured-model"},
                      "hooks_auto_accept": True, "hooks": {"pre_tool_call": [
                          {"matcher": matcher, "command": str(shim), "timeout": 300, "fail_closed": True}
                          for matcher in source.GATED_MATCHERS]}}
            (home / "config.yaml").write_text(yaml.safe_dump(config))
            (home / ".env").write_text("AV_APPROVAL_ENABLED=1\nHERMES_ACCEPT_HOOKS=1\n"
                                       "AV_APPROVAL_URL=unix:/tmp/synthetic-approval.sock\n"
                                       "AV_APPROVAL_TOKEN=synthetic-token\nOPENROUTER_API_KEY=synthetic-model-key\n")
            bridge_spec = importlib.util.spec_from_file_location("village_bridge", repo / "plugins/village-bridge/__init__.py")
            bridge = importlib.util.module_from_spec(bridge_spec)
            sys.modules["village_bridge"] = bridge
            bridge_spec.loader.exec_module(bridge)
            managed = sys.modules["village_bridge._zzz_managed"]
            mini = sys.modules["village_bridge._mini_apps"]
            (home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [
                {"id": "zzzbot", **mini.ZZZBOT}, {"id": mini.ZZZ_BRIDGE_ID, **mini.ZZZ_BRIDGE}]}))
            (home / "village-bridge.json").write_text(json.dumps({
                "origin": "https://agent.example", "token": "avb_" + "a" * 43,
                "ownerTelegramId": "1234", "expiresAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}))
            (home / "cron").mkdir()
            prompt = (repo / "skills/zzzbot/prompts/participate.md").read_text().rstrip()
            (home / "cron/jobs.json").write_text(json.dumps({"jobs": [{
                "id": "abcdef123456", "name": runner.JOB_NAME, "script": runner.JOB_SCRIPT,
                "no_agent": True, "enabled": True, "enabled_toolsets": runner.JOB_TOOLSETS,
                "deliver": "local", "failure_deliver": "local", "prompt": prompt}]}))
            self.assertEqual(hashlib.sha256(prompt.encode()).hexdigest(), runner.JOB_PROMPT_SHA256)
            with managed.locked_state(home) as state:
                state["rooms"] = {"room_a": {"requestId": "req_a", "consentEpoch": 1,
                                             "cursor": "1", "baseline": False}}
            pair = {"roomId": "room_a", "requestId": "req_a", "consentEpoch": 1,
                    "status": "agent_messaging_enabled"}
            writes = []
            transport_calls = []
            write_mode = ["ok"]
            def zzz_transport(_cfg, payload, **_kwargs):
                op = payload["operation"]
                transport_calls.append(op)
                if op == "zzz.pairs":
                    return {"kind": "zzz.pairs", "pairs": [pair]}
                if op == "zzz.changes":
                    items = [{"cursor": "2", "kind": "post.created", "threadId": "thread_a", "postId": "post_b"}]
                    return {"kind": "zzz.changes", "items": [item for item in items
                        if int(item["cursor"]) > int(payload["after"])], "nextCursor": None}
                if op == "zzz.read_thread":
                    return {"kind": "zzz.thread", "posts": [{"id": "post_b", "body": "Can we meet?",
                        "isOwn": False, "redacted": False}]}
                if op == "zzz.reply":
                    writes.append(payload)
                    if write_mode[0] == "timeout":
                        raise TimeoutError("uncertain ZZZ transport")
                    return {"kind": "zzz.post", "id": "post_c"}
                raise AssertionError(op)
            requests = []
            policy_mode = ["allow"]
            def policy_call(_argv, **kwargs):
                envelope = json.loads(kwargs["input"])
                requests.append(envelope)
                operation = envelope["tool_input"]["operation"]
                if policy_mode[0] == "crash":
                    raise RuntimeError("owner policy hook failed")
                if policy_mode[0] == "deny-all" or (policy_mode[0] == "deny-reply" and operation == "zzz.reply"):
                    return types.SimpleNamespace(returncode=2, stdout='{"action":"block"}', stderr="")
                return types.SimpleNamespace(returncode=0, stdout="{}", stderr="")
            client = _Client("Yes, three works.")
            # The bridge and approval code are real. Only the Hermes runtime
            # ContextVars are supplied here because Hermes is an external install.
            unset = object()
            session = types.ModuleType("gateway.session_context")
            session._UNSET = unset
            session._VAR_MAP = {name: contextvars.ContextVar(name, default=unset) for name in (
                "HERMES_CRON_SESSION", "HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_TYPE",
                "HERMES_SESSION_CHAT_ID", "HERMES_SESSION_USER_ID", "HERMES_SESSION_KEY",
                "HERMES_SESSION_MESSAGE_ID")}
            gateway = types.ModuleType("gateway")
            gateway.session_context = session
            delegation = types.ModuleType("agent.delegation_context")
            delegation.is_delegated_child_context = lambda: False
            agent = types.ModuleType("agent")
            agent.delegation_context = delegation
            def execute():
                with (patch.dict(os.environ, {"HERMES_HOME": str(home)}),
                      patch.dict(sys.modules, {"gateway": gateway, "gateway.session_context": session,
                                               "agent": agent, "agent.delegation_context": delegation}),
                      patch.object(runner, "_bridge", return_value=(bridge, managed)),
                      patch.object(bridge, "transport", side_effect=zzz_transport),
                      patch.object(runner.subprocess, "run", side_effect=policy_call), self.provider(client)):
                    runner.run(home)
            def ready_again(replies=0):
                with managed.locked_state(home) as state:
                    state["rooms"]["room_a"].update(cursor="1", baseline=False)
                    state["replies"] = replies
                    state["retryAt"] = 0
                    state["pending"] = None
                    # Each independent fixture scenario starts after the
                    # previous refusal window has expired.
                    state["policyPauseUntil"] = 0
                    state["policyPauseRooms"] = {}
                    state["threadReplies"] = {}
            execute()
            self.assertEqual(len(client.calls), 1)
            self.assertEqual(len(writes), 1)
            self.assertEqual(writes[0]["body"], "Yes, three works.")
            self.assertEqual([x["tool_input"]["operation"] for x in requests],
                             ["zzz.pairs", "zzz.pairs", "zzz.reply"])
            self.assertEqual(requests[-1]["tool_input"]["arguments"],
                             {"thread": "thread_a", "body": "Yes, three works."})
            with managed.locked_state(home) as state:
                self.assertEqual(state["replies"], 1)
                self.assertIsNone(state["pending"])
            # A second cron child while this turn holds its nonblocking lock
            # reaches neither ZZZ nor the owner policy/model, even with a
            # pending post in the same thread.
            ready_again()
            before_overlap = (len(transport_calls), len(requests), len(client.calls), len(writes))
            with runner._runner_turn(home) as acquired:
                self.assertTrue(acquired)
                execute()
            self.assertEqual((len(transport_calls), len(requests), len(client.calls), len(writes)), before_overlap)
            # The lifetime thread cap blocks a third inference even when the
            # UTC-day budget is fresh and an incoming post is still visible.
            ready_again()
            with managed.locked_state(home) as state:
                state["threadReplies"] = {managed._thread_key("room_a", "thread_a"): 2}
            before_thread_cap = (len(client.calls), len(writes))
            execute()
            self.assertEqual((len(client.calls), len(writes)), before_thread_cap)
            # A third reply is stopped before cursor polling or another model call.
            ready_again(replies=2)
            before = (len(client.calls), len(requests), len(writes))
            execute()
            self.assertEqual((len(client.calls), len(requests), len(writes)), before)
            # A denied class-level owner policy check also spends no inference.
            ready_again()
            policy_mode[0] = "deny-all"
            execute()
            self.assertEqual(len(client.calls), before[0])
            self.assertEqual(len(writes), before[2])
            self.assertEqual(requests[-1]["tool_input"]["operation"], "zzz.pairs")
            # A manual or denied owner verdict is asked only once in the
            # durable 24-hour window, even during idle cron ticks.
            refused = (len(transport_calls), len(requests), len(client.calls), len(writes))
            for _ in range(6):
                execute()
            self.assertEqual((len(transport_calls), len(requests), len(client.calls), len(writes)), refused)
            with managed.locked_state(home) as state:
                self.assertGreater(state["policyPauseUntil"], datetime.now(timezone.utc).timestamp() + 86390)
            ready_again()
            policy_mode[0] = "crash"
            with self.assertRaises(RuntimeError):
                execute()
            crashed_calls = len(requests)
            execute()
            self.assertEqual(len(requests), crashed_calls)
            # An exact-body denial can cost one model call, then suppresses the
            # event without a write or a reusable approval identity.
            ready_again()
            policy_mode[0] = "deny-reply"
            execute()
            self.assertEqual(len(client.calls), before[0] + 1)
            self.assertEqual(len(writes), before[2])
            with managed.locked_state(home) as state:
                self.assertIsNone(state["pending"])
                self.assertEqual(state["replies"], 0)
                self.assertIn("room_a", state["policyPauseRooms"])
                self.assertEqual(state.get("policyPauseUntil", 0), 0)
            # A valid silence response likewise consumes no write.
            ready_again()
            policy_mode[0] = "allow"
            client.content = "[SILENT]"
            execute()
            self.assertEqual(len(writes), before[2])
            with managed.locked_state(home) as state:
                self.assertIsNone(state["pending"])
            # An off or unverified installed backstop refuses before polling,
            # owner policy, or model inference.
            ready_again()
            before = (len(client.calls), len(requests), len(writes))
            env_path = home / ".env"
            good_env = env_path.read_text()
            env_path.write_text(good_env.replace("AV_APPROVAL_ENABLED=1", "AV_APPROVAL_ENABLED=0"))
            with self.assertRaises(ValueError):
                execute()
            self.assertEqual((len(client.calls), len(requests), len(writes)), before)
            env_path.write_text(good_env)
            config_path = home / "config.yaml"
            good_config = config_path.read_text()
            broken = yaml.safe_load(good_config)
            broken["hooks"]["pre_tool_call"] = []
            config_path.write_text(yaml.safe_dump(broken))
            with self.assertRaises(ValueError):
                execute()
            self.assertEqual((len(client.calls), len(requests), len(writes)), before)
            config_path.write_text(good_config)
            # A failure before the native reservation keeps only the event IDs
            # so a later run can answer. An uncertain transport after the
            # reservation is terminal and cannot be reoffered.
            client.content = "Yes, three works."
            with patch.object(runner, "_reply", side_effect=RuntimeError("provider failed")), self.assertRaises(RuntimeError):
                execute()
            with managed.locked_state(home) as state:
                self.assertEqual(state["pending"]["postId"], "post_b")
                self.assertEqual(state["replies"], 0)
            execute()
            self.assertEqual(len(writes), before[2] + 1)
            ready_again()
            write_mode[0] = "timeout"
            with self.assertRaises(ValueError):
                execute()
            with managed.locked_state(home) as state:
                self.assertIsNone(state["pending"])
                self.assertEqual(state["replies"], 1)
            model_calls = len(client.calls)
            write_calls = len(writes)
            execute()
            self.assertEqual((len(client.calls), len(writes)), (model_calls, write_calls))

    @unittest.skipUnless(sys.platform == "linux", "vendored owner shim requires Linux /proc and GNU stat")
    def test_real_owner_shim_accepts_only_facade_allow(self):
        """The installed shim, not a Python approval substitute, handles the native envelope."""
        repo = RUNNER.parents[3]
        with tempfile.TemporaryDirectory(prefix="za", dir=SAFE_TEMP_PARENT) as tmp:
            home = Path(tmp)
            sock = home / "approval.sock"
            outcomes = [b'{"exit_code":0,"stdout":"{}","stderr":""}',
                        b'{"exit_code":2,"stdout":"{\\"action\\":\\"block\\"}","stderr":""}']
            seen = []
            class Handler(BaseHTTPRequestHandler):
                def do_POST(self):
                    seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                    body = outcomes.pop(0)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *_args): pass

            class Server(socketserver.UnixStreamServer):
                allow_reuse_address = True

            with Server(str(sock), Handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    shim = home / "agent-hooks" / "hermes-hook-shim.sh"
                    shim.parent.mkdir()
                    shutil.copyfile(repo / "skills/approval/scripts/hermes-hook-shim.sh", shim)
                    shim.chmod(0o700)
                    (home / ".env").write_text(f"AV_APPROVAL_URL=unix:{sock}\n"
                                               f"AV_APPROVAL_DAEMON_UID={os.geteuid()}\n"
                                               "AV_APPROVAL_TOKEN=synthetic-token\n")
                    gate = types.SimpleNamespace(switch=lambda: "on", current_codes=lambda: ())
                    session = "cron_abcdef123456_20261023_120000"
                    self.assertTrue(runner._shim_allowed(home, gate, session, "cron:abcdef123456:allow",
                                                         "zzz.pairs", {}))
                    self.assertFalse(runner._shim_allowed(home, gate, session, "cron:abcdef123456:deny",
                                                          "zzz.reply", {"thread": "thread_a", "body": "No"}))
                    self.assertEqual([row["tool_input"]["operation"] for row in seen],
                                     ["zzz.pairs", "zzz.reply"])
                    self.assertEqual(seen[1]["tool_input"]["arguments"]["body"], "No")
                finally:
                    server.shutdown()
                    thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
