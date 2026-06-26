import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "agent_plaza_selfie.py"
SPEC = importlib.util.spec_from_file_location("agent_plaza_selfie", SCRIPT)
selfie = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["agent_plaza_selfie"] = selfie
SPEC.loader.exec_module(selfie)


def run_script(root: Path, *extra: str, env: dict[str, str] | None = None) -> tuple[str, dict]:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), "--json-only", *extra],
        text=True,
        capture_output=True,
        check=True,
        env=child_env,
    )
    lines = [line for line in completed.stdout.strip().splitlines() if line]
    return completed.stdout, json.loads(lines[-1])


class FakeTelegramResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, _size: int = -1) -> bytes:
        return b'{"ok":true,"result":{"message_id":1}}'


class FakeHttpResponse:
    def __init__(self, body: bytes, content_type: str = "application/json"):
        self._body = body
        self.headers = {"content-type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, _size: int = -1) -> bytes:
        return self._body


class AgentPlazaSelfieTests(unittest.TestCase):
    def test_unconfigured_packet_self_silences_and_uses_ops_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, payload = run_script(root)

            self.assertEqual(payload["wakeAgent"], False)
            self.assertEqual(payload["reason"], "packet_unconfigured")
            self.assertTrue((root / "ops/agentvillage/state/agent-plaza-selfie.json").exists())
            self.assertTrue((root / "ops/agentvillage/events/agent-plaza-selfie.jsonl").exists())
            self.assertFalse((root / "memory").exists())

    def test_packet_with_only_image_url_self_silences_without_local_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            packet = {
                "packet_type": "agent_plaza_spatial_selfie",
                "id": "selfie-1",
                "safety": {"user_opted_in": True},
                "selfie": {
                    "image_url": "https://plaza.example/selfie-1.png",
                    "url": "https://plaza.example/spot/selfie-1",
                },
            }
            packet_path = root / "packet.json"
            packet_path.write_text(json.dumps(packet), encoding="utf-8")

            _, payload = run_script(root, "--packet-file", str(packet_path), "--cooldown-hours", "0")

            self.assertFalse(payload["wakeAgent"])
            self.assertEqual(payload["nudgeId"], "selfie-1")
            self.assertEqual(payload["reason"], "missing_local_image")
            event_path = root / "ops/agentvillage/events/agent-plaza-selfie.jsonl"
            event = json.loads(event_path.read_text(encoding="utf-8").strip())
            self.assertEqual(event["event"], "selfie_silenced")
            self.assertEqual(event["reason"], "missing_local_image")

    def test_idless_local_image_packets_use_image_content_in_fallback_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "handoff.png"
            packet = {
                "packet_type": "agent_plaza_spatial_selfie",
                "title": "Agent Plaza selfie",
                "telegram_send_photo": {"photo_path": str(image)},
            }

            image.write_bytes(b"\x89PNG\r\n\x1a\nfirst")
            first_id = selfie.packet_id(root, packet)
            image.write_bytes(b"\x89PNG\r\n\x1a\nsecond")
            second_id = selfie.packet_id(root, packet)

            self.assertNotEqual(first_id, second_id)

    def test_local_image_without_telegram_config_self_silences_without_secret_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "source.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            packet_path = root / "packet.json"
            packet_path.write_text(json.dumps({"id": "local", "image_path": str(image), "safety": {"user_opted_in": True}}), encoding="utf-8")

            _, payload = run_script(root, "--packet-file", str(packet_path), "--cooldown-hours", "0")

            self.assertFalse(payload["wakeAgent"])
            self.assertEqual(payload["reason"], "missing_telegram_bot_token")
            self.assertTrue((root / "ops/agentvillage/media/agent-plaza-selfies/local.png").exists())
            event_text = (root / "ops/agentvillage/events/agent-plaza-selfie.jsonl").read_text(encoding="utf-8")
            self.assertIn("missing_telegram_bot_token", event_text)
            self.assertNotIn("TELEGRAM_HOME_CHANNEL", event_text)

    def test_read_dotenv_value_reads_telegram_config_without_printing_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text(
                "export TELEGRAM_BOT_TOKEN='secret-token'\nTELEGRAM_HOME_CHANNEL=-100123\n",
                encoding="utf-8",
            )

            self.assertEqual(selfie.read_dotenv_value(root, "TELEGRAM_BOT_TOKEN"), "secret-token")
            self.assertEqual(selfie.read_dotenv_value(root, "TELEGRAM_HOME_CHANNEL"), "-100123")

    def test_send_telegram_photo_uses_bot_api_multipart(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "selfie.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            captured = {}

            def fake_urlopen(req, timeout):
                captured["url"] = req.full_url
                captured["timeout"] = timeout
                captured["headers"] = dict(req.header_items())
                captured["body"] = req.data
                return FakeTelegramResponse()

            ok, reason = selfie.send_telegram_photo(
                token="secret-token",
                chat_id="-100123",
                image_path=image,
                caption=selfie.CAPTION,
                timeout_seconds=1.5,
                urlopen=fake_urlopen,
            )

            self.assertTrue(ok)
            self.assertEqual(reason, "telegram_photo_sent")
            self.assertEqual(captured["url"], "https://api.telegram.org/botsecret-token/sendPhoto")
            self.assertEqual(captured["timeout"], 1.5)
            self.assertIn("multipart/form-data", captured["headers"]["Content-type"])
            body = captured["body"]
            self.assertIn(b'name="chat_id"', body)
            self.assertIn(b"-100123", body)
            self.assertIn(b'name="caption"', body)
            self.assertIn(selfie.CAPTION.encode("utf-8"), body)
            self.assertIn(b'name="photo"; filename="selfie.png"', body)

    def test_send_telegram_photo_url_uses_bot_api_form_for_trusted_turing_url(self) -> None:
        captured = {}

        def fake_urlopen(req, timeout):
            captured["url"] = req.full_url
            captured["timeout"] = timeout
            captured["headers"] = dict(req.header_items())
            captured["body"] = req.data
            return FakeTelegramResponse()

        ok, reason = selfie.send_telegram_photo_url(
            token="secret-token",
            chat_id="-100123",
            photo_url="https://turingfalls.com/api/agents/agent-123/selfie",
            caption=selfie.CAPTION,
            timeout_seconds=1.5,
            urlopen=fake_urlopen,
        )

        self.assertTrue(ok)
        self.assertEqual(reason, "telegram_photo_sent")
        self.assertEqual(captured["url"], "https://api.telegram.org/botsecret-token/sendPhoto")
        self.assertEqual(captured["timeout"], 1.5)
        self.assertEqual(captured["headers"]["Content-type"], "application/x-www-form-urlencoded")
        body = captured["body"].decode("utf-8")
        self.assertIn("chat_id=-100123", body)
        self.assertIn("photo=https%3A%2F%2Fturingfalls.com%2Fapi%2Fagents%2Fagent-123%2Fselfie", body)

    def test_send_telegram_photo_url_rejects_untrusted_remote_url(self) -> None:
        ok, reason = selfie.send_telegram_photo_url(
            token="secret-token",
            chat_id="-100123",
            photo_url="https://example.com/selfie.png",
            caption=selfie.CAPTION,
            timeout_seconds=1.5,
            urlopen=lambda req, timeout: FakeTelegramResponse(),
        )

        self.assertFalse(ok)
        self.assertEqual(reason, "untrusted_remote_image")

    def test_followup_context_is_bounded_and_sanitized(self) -> None:
        long_summary = " ".join(["closeout"] * 80)
        packet = {
            "packet_type": "agent_plaza_spatial_selfie",
            "title": "  Pond   group  ",
            "summary": long_summary,
            "prompt": "Take the real photo too",
            "plaza_url": "https://plaza.example/spot/pond",
            "image_base64": "do-not-store",
            "telegram_send_photo": {"photo_path": "/tmp/selfie.png"},
            "neighbors": [
                {"display": "Maya", "human_summary": "builder"},
                {"display_name": "Sam"},
                "Kai",
                "Kai",
                {"shared_signal": "agent memory"},
                {"name": "Nia"},
                "Extra",
                "Overflow",
            ],
        }

        context = selfie.followup_context(
            packet=packet,
            nudge_id="nudge-1",
            packet_type="agent_plaza_spatial_selfie",
            delivered_at="2026-06-24T12:00:00Z",
            caption=selfie.CAPTION,
        )

        self.assertEqual(context["nudgeId"], "nudge-1")
        self.assertEqual(context["title"], "Pond group")
        self.assertLessEqual(len(context["summary"]), selfie.MAX_CONTEXT_STRING)
        self.assertEqual(context["plazaUrl"], "https://plaza.example/spot/pond")
        self.assertEqual(context["peopleHints"], ["Maya", "Sam", "Kai", "agent memory", "Nia", "Extra"])
        self.assertNotIn("image_base64", context)
        self.assertNotIn("telegram_send_photo", context)

    def test_followup_context_omits_unsafe_url(self) -> None:
        context = selfie.followup_context(
            packet={"plaza_url": "https://plaza.example/bad path"},
            nudge_id="nudge-1",
            packet_type="agent_plaza_spatial_selfie",
            delivered_at="2026-06-24T12:00:00Z",
            caption=selfie.CAPTION,
        )

        self.assertNotIn("plazaUrl", context)

    def test_store_local_image_rejects_paths_outside_hermes_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside_tmp:
            root = Path(tmp)
            outside = Path(outside_tmp) / "private.png"
            outside.write_bytes(b"\x89PNG\r\n\x1a\n")

            result = selfie.store_local_image(
                root,
                root / "ops/agentvillage/media/agent-plaza-selfies",
                "nudge-1",
                {"image_path": str(outside)},
                allow_local_paths=True,
            )

            self.assertEqual(result, "")

    def test_store_local_image_ignores_local_paths_from_url_packets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "source.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")

            result = selfie.store_local_image(
                root,
                root / "ops/agentvillage/media/agent-plaza-selfies",
                "nudge-1",
                {"image_path": str(image)},
                allow_local_paths=False,
            )

            self.assertEqual(result, "")

    def test_packet_without_plaza_opt_in_self_silences(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "source.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            packet_path = root / "packet.json"
            packet_path.write_text(json.dumps({"id": "no-opt-in", "image_path": str(image)}), encoding="utf-8")

            _, payload = run_script(root, "--packet-file", str(packet_path), "--cooldown-hours", "0")

            self.assertFalse(payload["wakeAgent"])
            self.assertEqual(payload["reason"], "plaza_not_opted_in")

    def test_turing_falls_credentials_build_packet_with_downloaded_selfie(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text(
                "TURING_FALLS_AGENT_ID=agent-123\nTURING_FALLS_CLAIM_TOKEN=secret-claim\n",
                encoding="utf-8",
            )
            calls: list[tuple[str, bytes | None, str | None]] = []

            def fake_urlopen(req, timeout):
                calls.append((req.full_url, req.data, req.get_header("Authorization")))
                if req.full_url.endswith("/api/agents/agent-123/tick"):
                    return FakeHttpResponse(json.dumps({
                        "your_location": "pond",
                        "world_hour": 14.5,
                        "is_night": False,
                        "world_url": "https://turingfalls.com/world/agent-123",
                        "visible_neighbors": [{"display_name": "Maya"}, {"name": "Sam"}],
                        "social_prompt": "A few agents are lingering by the pond.",
                    }).encode("utf-8"))
                if req.full_url.endswith("/api/agents/agent-123/action"):
                    return FakeHttpResponse(json.dumps({
                        "selfie_url": "https://turingfalls.com/selfies/agent-123.png",
                        "world_url": "https://turingfalls.com/world/agent-123",
                    }).encode("utf-8"))
                if req.full_url == "https://turingfalls.com/selfies/agent-123.png":
                    return FakeHttpResponse(b"\x89PNG\r\n\x1a\nselfie", "image/png")
                raise AssertionError(f"unexpected URL {req.full_url}")

            packet, reason = selfie.read_turing_falls_packet(
                root,
                root / "ops/agentvillage/media/agent-plaza-selfies",
                1.0,
                urlopen=fake_urlopen,
            )

            self.assertEqual(reason, "ok")
            self.assertEqual(packet["packet_type"], "agent_plaza_spatial_selfie")
            self.assertEqual(packet["source"], "turing_falls")
            self.assertEqual(packet["safety"]["plaza_opted_in"], True)
            self.assertEqual(packet["plaza_url"], "https://turingfalls.com/world/agent-123")
            self.assertEqual(packet["peopleHints"], ["Maya", "Sam"])
            self.assertTrue(Path(packet["image_path"]).exists())
            self.assertTrue(str(packet["image_path"]).startswith(str(root)))
            self.assertEqual(len(calls), 3)
            action_body = json.loads(calls[1][1].decode("utf-8"))
            self.assertEqual(action_body["action"], "selfie")
            self.assertNotIn("claim_token", action_body)
            self.assertEqual(calls[1][2], "Bearer secret-claim")

    def test_turing_falls_packet_keeps_remote_selfie_when_download_times_out(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text(
                "TURING_FALLS_AGENT_ID=agent-123\nTURING_FALLS_CLAIM_TOKEN=secret-claim\n",
                encoding="utf-8",
            )

            def fake_urlopen(req, timeout):
                if req.full_url.endswith("/api/agents/agent-123/tick"):
                    return FakeHttpResponse(json.dumps({
                        "your_location": "pond",
                        "world_url": "https://turingfalls.com/world/agent-123",
                    }).encode("utf-8"))
                if req.full_url.endswith("/api/agents/agent-123/action"):
                    return FakeHttpResponse(json.dumps({
                        "selfie_url": "https://turingfalls.com/api/agents/agent-123/selfie",
                        "world_url": "https://turingfalls.com/world/agent-123",
                    }).encode("utf-8"))
                if req.full_url == "https://turingfalls.com/api/agents/agent-123/selfie":
                    raise TimeoutError("renderer still warming")
                raise AssertionError(f"unexpected URL {req.full_url}")

            packet, reason = selfie.read_turing_falls_packet(
                root,
                root / "ops/agentvillage/media/agent-plaza-selfies",
                1.0,
                urlopen=fake_urlopen,
            )

            self.assertEqual(reason, "ok")
            self.assertEqual(packet["source"], "turing_falls")
            self.assertEqual(packet["image_url"], "https://turingfalls.com/api/agents/agent-123/selfie")
            self.assertNotIn("image_path", packet)
            self.assertEqual(packet["turing_falls"]["selfie_download_reason"], "turing_falls_selfie_unavailable")

    def test_main_success_sends_photo_records_state_and_emits_structured_silence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "source.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            packet_path = root / "packet.json"
            packet_path.write_text(json.dumps({
                "id": "success-1",
                "image_path": str(image),
                "title": "Pond selfie",
                "summary": "A small group was closing loops.",
                "peopleHints": ["Maya", "Sam"],
                "plaza_url": "https://plaza.example/spot/pond",
                "safety": {"user_opted_in": True},
            }), encoding="utf-8")
            (root / ".env").write_text(
                "TELEGRAM_BOT_TOKEN=secret-token\nTELEGRAM_HOME_CHANNEL=-100123\n",
                encoding="utf-8",
            )
            calls = []
            original_send = selfie.send_telegram_photo

            def fake_send_telegram_photo(**kwargs):
                calls.append(kwargs)
                return True, "telegram_photo_sent"

            try:
                selfie.send_telegram_photo = fake_send_telegram_photo
                stdout = StringIO()
                with redirect_stdout(stdout):
                    exit_code = selfie.main([
                        "--root",
                        str(root),
                        "--packet-file",
                        str(packet_path),
                        "--cooldown-hours",
                        "0",
                    ])
            finally:
                selfie.send_telegram_photo = original_send

            self.assertEqual(exit_code, 0)
            self.assertEqual(len(calls), 1)
            self.assertNotIn("[SILENT]", stdout.getvalue())
            payload = json.loads(stdout.getvalue().strip().splitlines()[-1])
            self.assertEqual(payload["reason"], "telegram_photo_sent")
            self.assertEqual(payload["nudgeId"], "success-1")
            self.assertEqual(payload["wakeAgent"], False)

            state = json.loads((root / "ops/agentvillage/state/agent-plaza-selfie.json").read_text(encoding="utf-8"))
            self.assertEqual(state["lastReason"], "telegram_photo_sent")
            self.assertEqual(state["lastNudgeId"], "success-1")
            self.assertIn("success-1", state["deliveredNudgeIds"])
            self.assertEqual(state["lastFollowupContext"]["nudgeId"], "success-1")
            self.assertEqual(state["lastFollowupContext"]["caption"], selfie.CAPTION)
            self.assertEqual(state["lastFollowupContext"]["title"], "Pond selfie")
            self.assertEqual(state["lastFollowupContext"]["summary"], "A small group was closing loops.")
            self.assertEqual(state["lastFollowupContext"]["peopleHints"], ["Maya", "Sam"])
            self.assertEqual(state["lastFollowupContext"]["plazaUrl"], "https://plaza.example/spot/pond")

            event = json.loads((root / "ops/agentvillage/events/agent-plaza-selfie.jsonl").read_text(encoding="utf-8").strip())
            self.assertEqual(event["event"], "telegram_photo_sent")
            self.assertEqual(event["nudge_id"], "success-1")

    def test_main_success_can_send_trusted_turing_remote_photo_without_local_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            packet_path = root / "packet.json"
            packet_path.write_text(json.dumps({
                "id": "turing-url-1",
                "source": "turing_falls",
                "packet_type": "agent_plaza_spatial_selfie",
                "image_url": "https://turingfalls.com/api/agents/agent-123/selfie",
                "title": "Turing Falls selfie",
                "plaza_url": "https://turingfalls.com/world/agent-123",
                "safety": {"plaza_opted_in": True},
            }), encoding="utf-8")
            (root / ".env").write_text(
                "TELEGRAM_BOT_TOKEN=secret-token\nTELEGRAM_HOME_CHANNEL=-100123\n",
                encoding="utf-8",
            )
            calls = []
            original_send = selfie.send_telegram_photo_url

            def fake_send_telegram_photo_url(**kwargs):
                calls.append(kwargs)
                return True, "telegram_photo_sent"

            try:
                selfie.send_telegram_photo_url = fake_send_telegram_photo_url
                stdout = StringIO()
                with redirect_stdout(stdout):
                    exit_code = selfie.main([
                        "--root",
                        str(root),
                        "--packet-file",
                        str(packet_path),
                        "--cooldown-hours",
                        "0",
                    ])
            finally:
                selfie.send_telegram_photo_url = original_send

            self.assertEqual(exit_code, 0)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["photo_url"], "https://turingfalls.com/api/agents/agent-123/selfie")
            payload = json.loads(stdout.getvalue().strip().splitlines()[-1])
            self.assertEqual(payload["reason"], "telegram_photo_sent")
            state = json.loads((root / "ops/agentvillage/state/agent-plaza-selfie.json").read_text(encoding="utf-8"))
            self.assertEqual(state["lastRemotePhotoUrlHost"], "turingfalls.com")
            self.assertEqual(state["lastLocalMediaPath"], "")
            event = json.loads((root / "ops/agentvillage/events/agent-plaza-selfie.jsonl").read_text(encoding="utf-8").strip())
            self.assertEqual(event["has_local_media"], False)
            self.assertEqual(event["has_remote_photo_url"], True)


if __name__ == "__main__":
    unittest.main()
