"""Tests for the OpenRouter Whisper STT command backend.

Stdlib unittest only. Run:

    python3 -m unittest discover -s install/stt/tests
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

SCRIPT_DIR = str(Path(__file__).resolve().parent.parent)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import openrouter_transcribe as ot  # noqa: E402


def _fake_response(payload: dict):
    cm = mock.MagicMock()
    cm.__enter__.return_value = io.BytesIO(json.dumps(payload).encode("utf-8"))
    cm.__exit__.return_value = False
    return cm


class FormatTests(unittest.TestCase):
    def test_telegram_opus_maps_to_ogg(self):
        for p in ("/x/a.ogg", "/x/a.oga", "/x/a.opus"):
            self.assertEqual(ot._audio_format(p), "ogg")

    def test_unknown_defaults_to_ogg(self):
        self.assertEqual(ot._audio_format("/x/a.bin"), "ogg")


class TranscribeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="or-stt-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.audio = self.tmp / "note.ogg"
        self.audio.write_bytes(b"fake-opus")

    def test_success_returns_text_and_sends_expected_request(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return _fake_response({"text": "  hello there  "})

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True):
            with mock.patch.object(ot.urllib.request, "urlopen", fake_urlopen):
                text = ot.transcribe(str(self.audio))

        self.assertEqual(text, "hello there")
        self.assertEqual(captured["url"], ot.OPENROUTER_URL)
        self.assertEqual(captured["headers"].get("Authorization"), "Bearer secret")
        self.assertEqual(captured["body"]["model"], ot.DEFAULT_MODEL)
        self.assertEqual(captured["body"]["input_audio"]["format"], "ogg")
        self.assertTrue(captured["body"]["input_audio"]["data"])

    def test_model_override_env(self):
        def fake_urlopen(request, timeout=None):
            return _fake_response({"text": "x"})

        env = {"OPENROUTER_API_KEY": "k", "OPENROUTER_STT_MODEL": "openai/whisper-1"}
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(ot.urllib.request, "urlopen", fake_urlopen):
                # capture by re-reading inside a wrapper
                captured = {}

                def cap(request, timeout=None):
                    captured["model"] = json.loads(request.data.decode())["model"]
                    return _fake_response({"text": "x"})

                with mock.patch.object(ot.urllib.request, "urlopen", cap):
                    ot.transcribe(str(self.audio))
        self.assertEqual(captured["model"], "openai/whisper-1")

    def test_missing_key_exits_nonzero(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit) as cm:
                ot.transcribe(str(self.audio))
        self.assertEqual(cm.exception.code, 1)

    def test_missing_file_exits_nonzero(self):
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            with self.assertRaises(SystemExit):
                ot.transcribe("/tmp/does-not-exist.ogg")

    def test_http_error_exits_nonzero(self):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(
                ot.OPENROUTER_URL, 429, "Too Many Requests", {}, io.BytesIO(b'{"error":"x"}')
            )

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            with mock.patch.object(ot.urllib.request, "urlopen", fake_urlopen):
                with self.assertRaises(SystemExit):
                    ot.transcribe(str(self.audio))

    def test_bad_shape_exits_nonzero(self):
        def fake_urlopen(request, timeout=None):
            return _fake_response({"unexpected": True})

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            with mock.patch.object(ot.urllib.request, "urlopen", fake_urlopen):
                with self.assertRaises(SystemExit):
                    ot.transcribe(str(self.audio))


class MainTests(unittest.TestCase):
    def test_main_writes_transcript_to_output(self):
        tmp = Path(tempfile.mkdtemp(prefix="or-stt-main-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        audio = tmp / "in.ogg"
        audio.write_bytes(b"audio")
        out = tmp / "out.txt"

        def fake_urlopen(request, timeout=None):
            return _fake_response({"text": "transcribed words"})

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=True):
            with mock.patch.object(ot.urllib.request, "urlopen", fake_urlopen):
                ot.main(["prog", str(audio), str(out)])

        self.assertEqual(out.read_text(encoding="utf-8"), "transcribed words")


if __name__ == "__main__":
    unittest.main()
