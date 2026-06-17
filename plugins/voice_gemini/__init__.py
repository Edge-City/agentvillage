"""voice-gemini — transcribe inbound Telegram voice notes via OpenRouter.

When ``stt.enabled: false`` the Hermes gateway hands the agent a cached path to
the raw voice attachment instead of a transcript:

    [The user sent a voice message: /home/<user>/.hermes/cache/audio/<hash>.ogg]

This plugin exposes a ``transcribe_voice`` tool the agent calls with that path.
It base64-encodes the file and sends it to an audio-capable model on OpenRouter
(default ``google/gemini-3.5-flash`` — the same model/key the fleet already runs
on) via the ``input_audio`` content type, returning the transcript.

Stdlib-only (urllib) so it carries no dependency beyond the Hermes venv.
"""

import base64
import json
import os
import urllib.error
import urllib.request

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-3.5-flash"
REQUEST_TIMEOUT_SECONDS = 90

# Map file extensions to the `format` token OpenRouter's input_audio expects.
# Telegram voice notes arrive as Opus-in-Ogg (.oga / .ogg).
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
    ".aiff": "aiff",
}

_TRANSCRIBE_PROMPT = (
    "Transcribe this voice note verbatim into text. "
    "Reply with only the transcript and nothing else."
)


def check_requirements() -> bool:
    """Gate loading: needs the OpenRouter key the model provider already uses."""
    return bool(os.getenv("OPENROUTER_API_KEY"))


def _audio_format(path: str) -> str:
    _, ext = os.path.splitext(path.lower())
    return _FORMAT_BY_EXT.get(ext, "ogg")


def _err(message: str) -> str:
    return json.dumps({"success": False, "transcript": "", "error": message})


def transcribe_voice(path: str, task_id: str = None) -> str:
    """Transcribe a cached voice note at ``path`` via OpenRouter audio-in."""
    del task_id  # not used; accepted for handler-signature parity

    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        return _err("OPENROUTER_API_KEY is not set")

    if not path or not os.path.isfile(path):
        return _err(f"audio file not found: {path!r}")

    try:
        with open(path, "rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("ascii")
    except OSError as exc:
        return _err(f"could not read audio file: {exc}")

    model = os.getenv("VOICE_TRANSCRIBE_MODEL", DEFAULT_MODEL)
    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _TRANSCRIBE_PROMPT},
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": encoded,
                                "format": _audio_format(path),
                            },
                        },
                    ],
                }
            ],
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
        return _err(f"openrouter http {exc.code}: {detail}")
    except (urllib.error.URLError, TimeoutError) as exc:
        return _err(f"openrouter request failed: {exc}")
    except json.JSONDecodeError as exc:
        return _err(f"openrouter returned non-JSON: {exc}")

    try:
        transcript = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return _err(f"unexpected openrouter response shape: {json.dumps(body)[:500]}")

    if isinstance(transcript, list):
        # Some providers return content parts; concatenate any text parts.
        transcript = "".join(
            part.get("text", "") for part in transcript if isinstance(part, dict)
        )

    return json.dumps(
        {"success": True, "transcript": (transcript or "").strip(), "model": model}
    )


_SCHEMA = {
    "name": "transcribe_voice",
    "description": (
        "Transcribe a cached inbound voice note (e.g. a Telegram .ogg) to text. "
        "Call this when an incoming message contains a path to a cached audio "
        "file (a voice message) instead of text. Pass the absolute file path."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path to the cached audio file to transcribe.",
            }
        },
        "required": ["path"],
    },
}


def register(ctx):
    ctx.register_tool(
        name="transcribe_voice",
        toolset="voice",
        schema=_SCHEMA,
        handler=lambda args, **kwargs: transcribe_voice(
            args.get("path", ""), kwargs.get("task_id")
        ),
        check_fn=check_requirements,
        requires_env=["OPENROUTER_API_KEY"],
        description="Transcribe a cached inbound voice note via OpenRouter audio-in.",
    )
