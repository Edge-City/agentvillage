#!/usr/bin/env python3
"""OpenRouter Whisper STT backend for Hermes' command-type STT provider.

Invoked by the gateway as:

    python3 openrouter_transcribe.py <input_audio_path> <output_transcript_path>

Reads the cached inbound voice note, base64-encodes it, and POSTs it to
OpenRouter's /audio/transcriptions endpoint using the tenant's own
OPENROUTER_API_KEY (already present in $HERMES_HOME/.env). Writes the plain
transcript to the output path (Hermes reads it back with `format: txt`).

Stdlib-only (urllib) so it carries no dependency beyond the Hermes image.
Exits non-zero on failure so Hermes treats the transcription as failed rather
than injecting a partial/empty transcript.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.request

OPENROUTER_URL = "https://openrouter.ai/api/v1/audio/transcriptions"
DEFAULT_MODEL = "openai/whisper-large-v3-turbo"
REQUEST_TIMEOUT_SECONDS = 110  # under the provider's 120s command timeout

# Telegram voice notes are Opus-in-Ogg (.oga/.ogg). Map extension -> the
# `format` token OpenRouter expects.
_FORMAT_BY_EXT = {
    ".oga": "ogg",
    ".ogg": "ogg",
    ".opus": "ogg",
    ".mp3": "mp3",
    ".m4a": "m4a",
    ".wav": "wav",
    ".flac": "flac",
    ".aac": "aac",
    ".webm": "webm",
}


def _fail(message: str) -> "NoReturn":  # type: ignore[name-defined]
    sys.stderr.write(f"openrouter_transcribe: {message}\n")
    sys.exit(1)


def _audio_format(path: str) -> str:
    _, ext = os.path.splitext(path.lower())
    return _FORMAT_BY_EXT.get(ext, "ogg")


def transcribe(input_path: str) -> str:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        _fail("OPENROUTER_API_KEY is not set")
    if not input_path or not os.path.isfile(input_path):
        _fail(f"audio file not found: {input_path!r}")

    try:
        with open(input_path, "rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("ascii")
    except OSError as exc:
        _fail(f"could not read audio file: {exc}")

    model = os.getenv("OPENROUTER_STT_MODEL", DEFAULT_MODEL)
    payload = json.dumps(
        {
            "model": model,
            "input_audio": {"data": encoded, "format": _audio_format(input_path)},
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        OPENROUTER_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        _fail(f"openrouter http {exc.code}: {detail}")
    except (urllib.error.URLError, TimeoutError) as exc:
        _fail(f"openrouter request failed: {exc}")
    except json.JSONDecodeError as exc:
        _fail(f"openrouter returned non-JSON: {exc}")

    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str):
        _fail(f"unexpected openrouter response shape: {json.dumps(body)[:300]}")
    return text.strip()


def main(argv: list) -> None:
    if len(argv) < 3:
        _fail("usage: openrouter_transcribe.py <input_audio> <output_transcript>")
    transcript = transcribe(argv[1])
    try:
        with open(argv[2], "w", encoding="utf-8") as out:
            out.write(transcript)
    except OSError as exc:
        _fail(f"could not write transcript: {exc}")


if __name__ == "__main__":
    main(sys.argv)
