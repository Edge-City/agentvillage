#!/usr/bin/env python3
"""Deterministic Agent Plaza selfie nudge gate.

Reads an Agent Plaza packet from a configured URL/file or local ops handoff,
copies local media into ops storage, sends the image directly through Telegram,
records ops-only events/state, and emits {"wakeAgent": false} so Hermes does
not duplicate delivery with a text reply.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA = "agentvillage.agent_plaza_selfie.v1"
CAPTION = (
    "Your agent sent proof of life from Plaza. "
    "Your move: send a real-world selfie, screenshot, table photo, or demo moment. "
    "I'll ask the agent bureaucracy what it thinks is happening. No need to make it dignified."
)
DEFAULT_COOLDOWN_HOURS = 20
MAX_PACKET_BYTES = 512 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_CONTEXT_STRING = 240
MAX_CONTEXT_LIST_ITEMS = 6
IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
}
ALLOWED_TELEGRAM_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
TRUE_VALUES = {"1", "true", "yes", "on"}
TURING_FALLS_ORIGIN = "https://turingfalls.com"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return now_utc().isoformat().replace("+00:00", "Z")


def hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME", "").strip()
    return Path(raw) if raw else Path.cwd()


def resolve_path(root: Path, value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else root / path


def path_within(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except ValueError:
        return False


def read_json(path: Path) -> dict[str, Any]:
    try:
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def append_event(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")


def record_silence(
    state_path: Path,
    events_path: Path,
    state: dict[str, Any],
    reason: str,
    *,
    nudge_id: str = "",
    packet_type: str = "",
) -> None:
    state["lastCheckAt"] = iso_now()
    state["lastReason"] = reason
    if nudge_id:
        state["lastNudgeId"] = nudge_id
    atomic_write_json(state_path, state)
    append_event(
        events_path,
        {
            "schema": SCHEMA,
            "event": "selfie_silenced",
            "experiment": "agent_plaza_selfie",
            "world": "plaza",
            "nudge_id": nudge_id,
            "packet_type": packet_type[:80],
            "reason": reason,
            "ts": iso_now(),
        },
    )


def nested_get(obj: dict[str, Any], dotted: str) -> Any:
    cur: Any = obj
    for part in dotted.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def first_string(obj: dict[str, Any], paths: list[str]) -> str:
    for path in paths:
        value = nested_get(obj, path)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def looks_like_url(value: str) -> bool:
    return value.startswith("https://") or value.startswith("http://")


def safe_url(value: str) -> str:
    if not looks_like_url(value):
        return ""
    # Avoid surprising whitespace/control characters in user-facing text.
    if any(ord(ch) < 32 for ch in value) or any(ch.isspace() for ch in value):
        return ""
    return value


def clean_context_string(value: Any, limit: int = MAX_CONTEXT_STRING) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = " ".join(value.replace("\x00", " ").split())
    if not cleaned:
        return ""
    return cleaned[:limit]


def first_context_string(obj: dict[str, Any], paths: list[str], limit: int = MAX_CONTEXT_STRING) -> str:
    for path in paths:
        cleaned = clean_context_string(nested_get(obj, path), limit=limit)
        if cleaned:
            return cleaned
    return ""


def truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in TRUE_VALUES
    return False


def plaza_selfie_enabled(packet: dict[str, Any]) -> bool:
    if truthy(os.environ.get("AGENT_PLAZA_SELFIE_ENABLED", "")):
        return True
    for path in (
        "safety.user_opted_in",
        "safety.plaza_opted_in",
        "consent.user_opted_in",
        "consent.plaza_opted_in",
        "user_opted_in",
        "plaza_opted_in",
    ):
        if truthy(nested_get(packet, path)):
            return True
    return False


def context_list_item(value: Any) -> str:
    if isinstance(value, str):
        return clean_context_string(value)
    if isinstance(value, dict):
        for key in ("display", "display_name", "name", "human_summary", "shared_signal", "title"):
            cleaned = clean_context_string(value.get(key))
            if cleaned:
                return cleaned
    return ""


def first_context_list(obj: dict[str, Any], paths: list[str]) -> list[str]:
    for path in paths:
        value = nested_get(obj, path)
        if not isinstance(value, list):
            continue
        items: list[str] = []
        seen: set[str] = set()
        for entry in value:
            cleaned = context_list_item(entry)
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            items.append(cleaned)
            if len(items) >= MAX_CONTEXT_LIST_ITEMS:
                break
        if items:
            return items
    return []


def followup_context(
    *,
    packet: dict[str, Any],
    nudge_id: str,
    packet_type: str,
    delivered_at: str,
    caption: str,
) -> dict[str, Any]:
    context: dict[str, Any] = {
        "schema": SCHEMA,
        "nudgeId": nudge_id,
        "packetType": packet_type[:80],
        "deliveredAt": delivered_at,
        "caption": clean_context_string(caption, limit=512),
    }
    optional_fields = {
        "title": first_context_string(packet, ["title", "selfie.title", "scene.title"]),
        "summary": first_context_string(packet, ["summary", "selfie.summary", "scene.summary", "topic_hint", "scene.topic_hint"]),
        "prompt": first_context_string(packet, ["prompt", "selfie.prompt", "scene.prompt"]),
        "plazaUrl": safe_url(first_string(packet, ["plaza_url", "deep_link", "url", "selfie.url"])),
    }
    for key, value in optional_fields.items():
        if value:
            context[key] = value
    people_hints = first_context_list(packet, ["peopleHints", "people_hints", "neighbors", "nearby_agents", "scene.nearby"])
    if people_hints:
        context["peopleHints"] = people_hints
    return context


def read_dotenv_value(root: Path, key: str) -> str:
    env_value = os.environ.get(key, "").strip()
    if env_value:
        return env_value
    env_path = root / ".env"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    prefix = f"{key}="
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or not stripped.startswith(prefix):
            continue
        value = stripped[len(prefix) :].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        return value.strip()
    return ""


def turing_falls_credentials(root: Path) -> tuple[str, str, str]:
    origin = read_dotenv_value(root, "TURING_FALLS_ORIGIN") or TURING_FALLS_ORIGIN
    origin = origin.rstrip("/")
    agent_id = read_dotenv_value(root, "TURING_FALLS_AGENT_ID")
    claim_token = read_dotenv_value(root, "TURING_FALLS_CLAIM_TOKEN")
    if agent_id and claim_token:
        return origin, agent_id, claim_token

    for relative in (
        "ops/agentvillage/state/turing-falls.json",
        ".config/turing-falls/credentials.json",
        "memory/turing-falls-state.json",
    ):
        data = read_json(root / relative)
        agent_id = str(data.get("agent_id") or data.get("agentId") or "").strip()
        claim_token = str(data.get("claim_token") or data.get("claimToken") or "").strip()
        stored_origin = str(data.get("origin") or "").strip().rstrip("/")
        if agent_id and claim_token:
            return stored_origin or origin, agent_id, claim_token
    return origin, "", ""


def turing_people_hints(tick: dict[str, Any]) -> list[str]:
    return first_context_list(tick, ["visible_neighbors", "neighbors", "nearby_agents"])


def turing_summary(tick: dict[str, Any]) -> str:
    location = clean_context_string(tick.get("your_location") or tick.get("location"), limit=80)
    neighbors = turing_people_hints(tick)
    if location and neighbors:
        return f"Your agent is at {location} with {', '.join(neighbors[:3])}."
    if location:
        return f"Your agent is at {location}."
    if neighbors:
        return f"Your agent is near {', '.join(neighbors[:3])}."
    return "Your agent is present in Turing Falls."


def read_turing_json(req: urllib.request.Request, timeout: float, urlopen=urllib.request.urlopen) -> tuple[dict[str, Any], str]:
    try:
        with urlopen(req, timeout=timeout) as res:
            raw = res.read(MAX_PACKET_BYTES + 1)
            content_type = res.headers.get("content-type", "")
    except (urllib.error.URLError, TimeoutError, OSError):
        return {}, "turing_falls_unavailable"
    if len(raw) > MAX_PACKET_BYTES:
        return {}, "turing_falls_packet_too_large"
    if content_type and "json" not in content_type.lower():
        return {}, "turing_falls_not_json"
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {}, "turing_falls_invalid_json"
    return (data if isinstance(data, dict) else {}), "ok"


def download_turing_image(
    media_dir: Path,
    nudge_id: str,
    image_url: str,
    timeout_seconds: float,
    urlopen=urllib.request.urlopen,
) -> tuple[str, str]:
    if not safe_url(image_url):
        return "", "turing_falls_missing_selfie"
    req = urllib.request.Request(image_url, headers={"Accept": "image/png,image/jpeg,image/webp"})
    try:
        with urlopen(req, timeout=timeout_seconds) as res:
            raw = res.read(MAX_IMAGE_BYTES + 1)
            content_type = res.headers.get("content-type", "")
    except (urllib.error.URLError, TimeoutError, OSError):
        return "", "turing_falls_selfie_unavailable"
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        return "", "turing_falls_selfie_size_invalid"
    ext = mime_extension(content_type)
    if not ext:
        return "", "turing_falls_selfie_type_invalid"
    media_dir.mkdir(parents=True, exist_ok=True)
    safe_id = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in nudge_id)[:120] or "turing-falls"
    target = media_dir / f"{safe_id}-source{ext}"
    try:
        target.write_bytes(raw)
    except OSError:
        return "", "turing_falls_selfie_write_failed"
    return str(target), "ok"


def trusted_turing_image_url(value: str) -> str:
    url = safe_url(value)
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "turingfalls.com":
        return ""
    return url


def read_turing_falls_packet(
    root: Path,
    media_dir: Path,
    timeout_seconds: float,
    urlopen=urllib.request.urlopen,
) -> tuple[dict[str, Any], str]:
    origin, agent_id, claim_token = turing_falls_credentials(root)
    if not agent_id or not claim_token:
        return {}, "turing_falls_unconfigured"
    if not safe_url(origin):
        return {}, "turing_falls_invalid_origin"

    safe_agent_id = urllib.parse.quote(agent_id, safe="")
    tick_req = urllib.request.Request(
        f"{origin}/api/agents/{safe_agent_id}/tick",
        headers={"Accept": "application/json"},
    )
    tick, reason = read_turing_json(tick_req, timeout_seconds, urlopen=urlopen)
    if reason != "ok":
        return {}, reason

    action_body = json.dumps({"action": "selfie"}).encode("utf-8")
    action_req = urllib.request.Request(
        f"{origin}/api/agents/{safe_agent_id}/action",
        data=action_body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {claim_token}",
        },
        method="POST",
    )
    selfie_response, reason = read_turing_json(action_req, timeout_seconds, urlopen=urlopen)
    if reason != "ok":
        return {}, reason

    selfie_url = safe_url(first_string(selfie_response, ["selfie_url", "latest_selfie_url", "selfie.url"]))
    world_url = safe_url(first_string(selfie_response, ["world_url"]) or first_string(tick, ["world_url"]))
    if not selfie_url:
        return {}, "turing_falls_missing_selfie"

    nudge_id = f"turing-falls-{hashlib.sha256(f'{agent_id}:{selfie_url}:{iso_now()}'.encode('utf-8')).hexdigest()[:24]}"
    image_path, image_reason = download_turing_image(media_dir, nudge_id, selfie_url, timeout_seconds, urlopen=urlopen)

    packet = {
        "packet_type": "agent_plaza_spatial_selfie",
        "id": nudge_id,
        "source": "turing_falls",
        "title": "Turing Falls selfie",
        "summary": turing_summary(tick),
        "prompt": clean_context_string(tick.get("social_prompt"), limit=MAX_CONTEXT_STRING),
        "peopleHints": turing_people_hints(tick),
        "plaza_url": world_url,
        "image_url": selfie_url,
        "safety": {
            "plaza_opted_in": True,
            "credential_source": "turing_falls",
        },
        "turing_falls": {
            "agent_id": agent_id,
            "your_location": clean_context_string(tick.get("your_location") or tick.get("location"), limit=80),
            "world_hour": tick.get("world_hour"),
            "is_night": tick.get("is_night"),
            "selfie_download_reason": image_reason,
        },
    }
    if image_path:
        packet["image_path"] = image_path
    return packet, "ok"


def read_packet_from_url(url: str, timeout: float) -> tuple[dict[str, Any], str]:
    if not safe_url(url):
        return {}, "invalid_packet_url"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            content_type = res.headers.get("content-type", "")
            raw = res.read(MAX_PACKET_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        return {}, "packet_url_unavailable"
    if len(raw) > MAX_PACKET_BYTES:
        return {}, "packet_too_large"
    if content_type and "json" not in content_type.lower():
        return {}, "packet_not_json"
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {}, "packet_invalid_json"
    return (data if isinstance(data, dict) else {}), "ok"


def read_packet(root: Path, args: argparse.Namespace) -> tuple[dict[str, Any], str]:
    url = (args.packet_url or os.environ.get("AGENT_PLAZA_SELFIE_PACKET_URL", "")).strip()
    if url:
        return read_packet_from_url(url, args.timeout_seconds)

    file_value = (args.packet_file or os.environ.get("AGENT_PLAZA_SELFIE_PACKET_FILE", "")).strip()
    packet_file = resolve_path(root, file_value) if file_value else root / "ops/agentvillage/state/agent-plaza-selfie-packet.json"
    if not packet_file.exists():
        return {}, "packet_unconfigured"
    try:
        raw = packet_file.read_bytes()
    except OSError:
        return {}, "packet_file_unreadable"
    if len(raw) > MAX_PACKET_BYTES:
        return {}, "packet_too_large"
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {}, "packet_invalid_json"
    return (data if isinstance(data, dict) else {}), "ok"


def packet_id(root: Path, packet: dict[str, Any]) -> str:
    explicit = first_string(packet, ["nudge_id", "selfie.nudge_id", "id", "selfie.id", "packet_id"])
    if explicit:
        return explicit[:120]
    image_url = first_string(packet, ["image_url", "selfie.image_url", "image.url", "media.url"])
    image_path = first_string(
        packet,
        [
            "telegram_send_photo.photo_path",
            "files.telegram_photo",
            "files.png",
            "image_path",
            "selfie.image_path",
            "image.path",
            "media.path",
        ],
    )
    image_base64 = first_string(packet, ["image_base64", "selfie.image_base64", "image.base64", "media.base64"])
    image_path_hash = ""
    if image_path:
        try:
            source = resolve_path(root, image_path)
            if source.exists() and source.is_file() and source.stat().st_size <= MAX_IMAGE_BYTES:
                image_path_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        except OSError:
            image_path_hash = ""
    plaza_url = first_string(packet, ["plaza_url", "deep_link", "url", "selfie.url"])
    basis = json.dumps(
        {
            "packet_type": packet.get("packet_type"),
            "image_url": image_url,
            "image_path": image_path,
            "image_path_hash": image_path_hash,
            "image_base64_hash": hashlib.sha256(image_base64.encode("utf-8")).hexdigest() if image_base64 else "",
            "plaza_url": plaza_url,
            "title": packet.get("title"),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:24]


def hours_since(value: Any, now: datetime) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None
    return (now - parsed).total_seconds() / 3600


def should_suppress(state: dict[str, Any], nudge_id: str, now: datetime, cooldown_hours: int) -> str:
    if nudge_id and nudge_id in state.get("deliveredNudgeIds", []):
        return "duplicate_nudge"
    elapsed = hours_since(state.get("lastDeliveredAt"), now)
    if elapsed is not None and elapsed < cooldown_hours:
        return "cooldown"
    return ""


def mime_extension(content_type: str) -> str:
    return IMAGE_EXTENSIONS.get(content_type.lower().split(";")[0].strip(), "")


def store_local_image(
    root: Path,
    media_dir: Path,
    nudge_id: str,
    packet: dict[str, Any],
    *,
    allow_local_paths: bool,
) -> str:
    path_value = first_string(
        packet,
        [
            "telegram_send_photo.photo_path",
            "files.telegram_photo",
            "files.png",
            "image_path",
            "selfie.image_path",
            "image.path",
            "media.path",
        ],
    )
    b64_value = first_string(packet, ["image_base64", "selfie.image_base64", "image.base64", "media.base64"])
    content_type = first_string(packet, ["image_content_type", "selfie.content_type", "image.content_type", "media.content_type"])

    media_dir.mkdir(parents=True, exist_ok=True)
    safe_id = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in nudge_id)[:120] or "selfie"

    if path_value and allow_local_paths:
        source = resolve_path(root, path_value)
        if not path_within(source, root):
            return ""
        if not source.exists() or not source.is_file():
            return ""
        try:
            if source.stat().st_size > MAX_IMAGE_BYTES:
                return ""
            ext = source.suffix.lower()
            if ext not in ALLOWED_TELEGRAM_IMAGE_EXTENSIONS:
                guessed = mimetypes.guess_type(str(source))[0] or ""
                ext = mime_extension(guessed)
            if ext not in ALLOWED_TELEGRAM_IMAGE_EXTENSIONS:
                return ""
            target = media_dir / f"{safe_id}{'.jpg' if ext == '.jpeg' else ext}"
            shutil.copyfile(source, target)
            return str(target)
        except OSError:
            return ""

    if b64_value:
        ext = mime_extension(content_type)
        if not ext:
            return ""
        try:
            raw = base64.b64decode(b64_value, validate=True)
        except Exception:
            return ""
        if len(raw) > MAX_IMAGE_BYTES:
            return ""
        target = media_dir / f"{safe_id}{ext}"
        target.write_bytes(raw)
        return str(target)

    return ""


def multipart_form_data(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = f"----agentvillage-{hashlib.sha256(os.urandom(16)).hexdigest()[:24]}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )
    for name, (filename, content, content_type) in files.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode("utf-8"),
                f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
                content,
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def send_telegram_photo(
    *,
    token: str,
    chat_id: str,
    image_path: Path,
    caption: str,
    timeout_seconds: float,
    urlopen=urllib.request.urlopen,
) -> tuple[bool, str]:
    ext = image_path.suffix.lower()
    if ext not in ALLOWED_TELEGRAM_IMAGE_EXTENSIONS:
        return False, "unsupported_image_type"
    try:
        content = image_path.read_bytes()
    except OSError:
        return False, "image_unreadable"
    if not content or len(content) > MAX_IMAGE_BYTES:
        return False, "image_size_invalid"
    content_type = mimetypes.guess_type(str(image_path))[0] or "application/octet-stream"
    if content_type not in IMAGE_EXTENSIONS:
        return False, "unsupported_image_type"

    body, body_content_type = multipart_form_data(
        {"chat_id": chat_id, "caption": caption},
        {"photo": (image_path.name, content, content_type)},
    )
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendPhoto",
        data=body,
        headers={"Content-Type": body_content_type},
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout_seconds) as res:
            raw = res.read(128 * 1024)
    except (urllib.error.URLError, TimeoutError, OSError):
        return False, "telegram_send_failed"
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return False, "telegram_invalid_response"
    if isinstance(parsed, dict) and parsed.get("ok") is True:
        return True, "telegram_photo_sent"
    return False, "telegram_rejected_photo"


def send_telegram_photo_url(
    *,
    token: str,
    chat_id: str,
    photo_url: str,
    caption: str,
    timeout_seconds: float,
    urlopen=urllib.request.urlopen,
) -> tuple[bool, str]:
    if not trusted_turing_image_url(photo_url):
        return False, "untrusted_remote_image"
    body = urllib.parse.urlencode({"chat_id": chat_id, "caption": caption, "photo": photo_url}).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendPhoto",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout_seconds) as res:
            raw = res.read(128 * 1024)
    except (urllib.error.URLError, TimeoutError, OSError):
        return False, "telegram_send_failed"
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return False, "telegram_invalid_response"
    if isinstance(parsed, dict) and parsed.get("ok") is True:
        return True, "telegram_photo_sent"
    return False, "telegram_rejected_photo"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Gate and prepare the Agent Plaza selfie nudge")
    parser.add_argument("--root", default="")
    parser.add_argument("--packet-url", default="")
    parser.add_argument("--packet-file", default="")
    parser.add_argument("--state-file", default="ops/agentvillage/state/agent-plaza-selfie.json")
    parser.add_argument("--events-file", default="ops/agentvillage/events/agent-plaza-selfie.jsonl")
    parser.add_argument("--media-dir", default="ops/agentvillage/media/agent-plaza-selfies")
    parser.add_argument("--cooldown-hours", type=int, default=DEFAULT_COOLDOWN_HOURS)
    parser.add_argument("--timeout-seconds", type=float, default=3.0)
    parser.add_argument("--json-only", action="store_true")
    args = parser.parse_args(argv)

    root = resolve_path(Path.cwd(), args.root) if args.root else hermes_home()
    state_path = resolve_path(root, args.state_file)
    events_path = resolve_path(root, args.events_file)
    media_dir = resolve_path(root, args.media_dir)
    now = now_utc()

    state = read_json(state_path)
    packet_url_configured = bool((args.packet_url or os.environ.get("AGENT_PLAZA_SELFIE_PACKET_URL", "")).strip())
    packet, reason = read_packet(root, args)
    if reason == "packet_unconfigured":
        turing_packet, turing_reason = read_turing_falls_packet(root, media_dir, args.timeout_seconds)
        if turing_reason != "turing_falls_unconfigured":
            packet, reason = turing_packet, turing_reason
    if reason != "ok" or not packet:
        record_silence(state_path, events_path, state, reason)
        emit({"wakeAgent": False, "reason": reason})
        return 0

    nudge_id = packet_id(root, packet)
    packet_type = str(packet.get("packet_type") or "unknown")
    if not plaza_selfie_enabled(packet):
        record_silence(state_path, events_path, state, "plaza_not_opted_in", nudge_id=nudge_id, packet_type=packet_type)
        emit({"wakeAgent": False, "reason": "plaza_not_opted_in", "nudgeId": nudge_id})
        return 0

    suppressed = should_suppress(state, nudge_id, now, max(0, args.cooldown_hours))
    if suppressed:
        record_silence(state_path, events_path, state, suppressed, nudge_id=nudge_id, packet_type=packet_type)
        emit({"wakeAgent": False, "reason": suppressed, "nudgeId": nudge_id})
        return 0

    local_media_path = store_local_image(root, media_dir, nudge_id, packet, allow_local_paths=not packet_url_configured)
    remote_photo_url = ""
    if not local_media_path and packet.get("source") == "turing_falls":
        remote_photo_url = trusted_turing_image_url(first_string(packet, ["image_url", "selfie.image_url", "image.url"]))
    if not local_media_path and not remote_photo_url:
        record_silence(state_path, events_path, state, "missing_local_image", nudge_id=nudge_id, packet_type=packet_type)
        emit({"wakeAgent": False, "reason": "missing_local_image", "nudgeId": nudge_id})
        return 0

    bot_token = read_dotenv_value(root, "TELEGRAM_BOT_TOKEN")
    chat_id = read_dotenv_value(root, "TELEGRAM_HOME_CHANNEL")
    if not bot_token:
        record_silence(state_path, events_path, state, "missing_telegram_bot_token", nudge_id=nudge_id, packet_type=packet_type)
        emit({"wakeAgent": False, "reason": "missing_telegram_bot_token", "nudgeId": nudge_id})
        return 0
    if not chat_id:
        record_silence(state_path, events_path, state, "missing_telegram_home_channel", nudge_id=nudge_id, packet_type=packet_type)
        emit({"wakeAgent": False, "reason": "missing_telegram_home_channel", "nudgeId": nudge_id})
        return 0

    if local_media_path:
        sent, send_reason = send_telegram_photo(
            token=bot_token,
            chat_id=chat_id,
            image_path=Path(local_media_path),
            caption=CAPTION,
            timeout_seconds=args.timeout_seconds,
        )
    else:
        sent, send_reason = send_telegram_photo_url(
            token=bot_token,
            chat_id=chat_id,
            photo_url=remote_photo_url,
            caption=CAPTION,
            timeout_seconds=args.timeout_seconds,
        )
    if not sent:
        record_silence(state_path, events_path, state, send_reason, nudge_id=nudge_id, packet_type=packet_type)
        emit({"wakeAgent": False, "reason": send_reason, "nudgeId": nudge_id})
        return 0

    delivered_ids = state.get("deliveredNudgeIds")
    if not isinstance(delivered_ids, list):
        delivered_ids = []
    delivered_ids = [entry for entry in delivered_ids if isinstance(entry, str)]
    delivered_ids.append(nudge_id)
    delivered_at = iso_now()
    state.update(
        {
            "schema": SCHEMA,
            "lastCheckAt": delivered_at,
            "lastDeliveredAt": delivered_at,
            "lastReason": "telegram_photo_sent",
            "lastNudgeId": nudge_id,
            "lastLocalMediaPath": local_media_path,
            "lastRemotePhotoUrlHost": urllib.parse.urlparse(remote_photo_url).netloc if remote_photo_url else "",
            "lastFollowupContext": followup_context(
                packet=packet,
                nudge_id=nudge_id,
                packet_type=packet_type,
                delivered_at=delivered_at,
                caption=CAPTION,
            ),
            "deliveredNudgeIds": delivered_ids[-50:],
        }
    )
    atomic_write_json(state_path, state)

    event = {
        "schema": SCHEMA,
        "event": "telegram_photo_sent",
        "experiment": "agent_plaza_selfie",
        "world": "plaza",
        "nudge_id": nudge_id,
        "packet_type": packet_type[:80],
        "grounded_on": "world_packet" if "spatial" in packet_type else "social_packet",
        "has_local_media": bool(local_media_path),
        "has_remote_photo_url": bool(remote_photo_url),
        "ts": iso_now(),
    }
    append_event(events_path, event)

    payload = {
        "wakeAgent": False,
        "schema": SCHEMA,
        "nudgeId": nudge_id,
        "reason": "telegram_photo_sent",
    }
    emit(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
