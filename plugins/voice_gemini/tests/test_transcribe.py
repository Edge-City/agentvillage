"""Tests for the voice-gemini transcribe_voice tool.

Stdlib unittest only (no pytest dependency). Run from the plugin dir:

    python3 -m unittest discover -s plugins/voice_gemini/tests
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

# Import the plugin module (its package dir is the parent of tests/).
PLUGIN_DIR = str(Path(__file__).resolve().parent.parent)
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

import __init__ as plugin  # noqa: E402


def _fake_response(payload: dict):
    """A context-manager stand-in for urllib's urlopen() return value."""
    body = json.dumps(payload).encode("utf-8")
    cm = mock.MagicMock()
    cm.__enter__.return_value = io.BytesIO(body)
    cm.__exit__.return_value = False
    return cm


class FormatMappingTests(unittest.TestCase):
    def test_telegram_opus_variants_map_to_ogg(self):
        for path in ("/x/a.ogg", "/x/a.oga", "/x/a.opus", "/x/A.OGG"):
            self.assertEqual(plugin._audio_format(path), "ogg")

    def test_known_extensions(self):
        self.assertEqual(plugin._audio_format("/x/a.mp3"), "mp3")
        self.assertEqual(plugin._audio_format("/x/a.m4a"), "m4a")
        self.assertEqual(plugin._audio_format("/x/a.wav"), "wav")

    def test_unknown_extension_defaults_to_ogg(self):
        self.assertEqual(plugin._audio_format("/x/a.bin"), "ogg")


class GuardClauseTests(unittest.TestCase):
    def test_missing_api_key(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            result = json.loads(plugin.transcribe_voice("/tmp/whatever.ogg"))
        self.assertFalse(result["success"])
        self.assertIn("OPENROUTER_API_KEY", result["error"])

    def test_missing_file(self):
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            result = json.loads(plugin.transcribe_voice("/tmp/nope-not-here.ogg"))
        self.assertFalse(result["success"])
        self.assertIn("not found", result["error"])


class TranscribeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="voice-gemini-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.audio = self.tmp / "note.ogg"
        self.audio.write_bytes(b"fake-opus-bytes")

    def test_success_returns_transcript_and_sends_expected_request(self):
        captured = {}

        def _fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return _fake_response(
                {"choices": [{"message": {"content": "  hello world  "}}]}
            )

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True):
            with mock.patch.object(plugin.urllib.request, "urlopen", _fake_urlopen):
                result = json.loads(plugin.transcribe_voice(str(self.audio)))

        self.assertTrue(result["success"])
        self.assertEqual(result["transcript"], "hello world")
        self.assertEqual(result["model"], plugin.DEFAULT_MODEL)

        # Request shape: correct endpoint, auth, and input_audio content part.
        self.assertEqual(captured["url"], plugin.OPENROUTER_URL)
        self.assertEqual(captured["headers"].get("Authorization"), "Bearer secret")
        content = captured["body"]["messages"][0]["content"]
        audio_part = next(p for p in content if p["type"] == "input_audio")
        self.assertEqual(audio_part["input_audio"]["format"], "ogg")
        self.assertTrue(audio_part["input_audio"]["data"])  # base64 present

    def test_model_override_env(self):
        def _fake_urlopen(request, timeout=None):
            return _fake_response({"choices": [{"message": {"content": "x"}}]})

        env = {"OPENROUTER_API_KEY": "k", "VOICE_TRANSCRIBE_MODEL": "google/gemini-3-flash-preview"}
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(plugin.urllib.request, "urlopen", _fake_urlopen):
                result = json.loads(plugin.transcribe_voice(str(self.audio)))
        self.assertEqual(result["model"], "google/gemini-3-flash-preview")

    def test_content_parts_list_is_concatenated(self):
        def _fake_urlopen(request, timeout=None):
            return _fake_response(
                {"choices": [{"message": {"content": [
                    {"type": "text", "text": "part one "},
                    {"type": "text", "text": "part two"},
                ]}}]}
            )

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            with mock.patch.object(plugin.urllib.request, "urlopen", _fake_urlopen):
                result = json.loads(plugin.transcribe_voice(str(self.audio)))
        self.assertTrue(result["success"])
        self.assertEqual(result["transcript"], "part one part two")

    def test_http_error_becomes_error_envelope(self):
        def _fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(
                plugin.OPENROUTER_URL, 429, "Too Many Requests", {},
                io.BytesIO(b'{"error":"rate limited"}'),
            )

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            with mock.patch.object(plugin.urllib.request, "urlopen", _fake_urlopen):
                result = json.loads(plugin.transcribe_voice(str(self.audio)))
        self.assertFalse(result["success"])
        self.assertIn("429", result["error"])

    def test_network_error_becomes_error_envelope(self):
        def _fake_urlopen(request, timeout=None):
            raise urllib.error.URLError("connection refused")

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            with mock.patch.object(plugin.urllib.request, "urlopen", _fake_urlopen):
                result = json.loads(plugin.transcribe_voice(str(self.audio)))
        self.assertFalse(result["success"])
        self.assertIn("failed", result["error"])

    def test_unexpected_shape_becomes_error_envelope(self):
        def _fake_urlopen(request, timeout=None):
            return _fake_response({"unexpected": True})

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            with mock.patch.object(plugin.urllib.request, "urlopen", _fake_urlopen):
                result = json.loads(plugin.transcribe_voice(str(self.audio)))
        self.assertFalse(result["success"])
        self.assertIn("unexpected", result["error"])


class RegisterContractTests(unittest.TestCase):
    def test_register_wires_the_tool(self):
        calls = {}

        class Ctx:
            def register_tool(self, **kwargs):
                calls.update(kwargs)

        plugin.register(Ctx())
        self.assertEqual(calls["name"], "transcribe_voice")
        self.assertEqual(calls["toolset"], "voice")
        self.assertEqual(calls["requires_env"], ["OPENROUTER_API_KEY"])
        self.assertTrue(callable(calls["handler"]))
        self.assertEqual(calls["schema"]["parameters"]["required"], ["path"])

    def test_handler_forwards_path_argument(self):
        class Ctx:
            def register_tool(self, **kwargs):
                self.handler = kwargs["handler"]

        ctx = Ctx()
        plugin.register(ctx)
        with mock.patch.object(plugin, "transcribe_voice", return_value="{}") as spy:
            ctx.handler({"path": "/a/b.ogg"}, task_id="t1")
        spy.assert_called_once_with("/a/b.ogg", "t1")


if __name__ == "__main__":
    unittest.main()
