#!/usr/bin/env python3
"""Render Hermes/Codex-style session JSON/JSONL files into near-raw Markdown transcripts."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SECRET_PATTERNS = [
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-+/=]{16,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(x-api-key['\"\s:=]+)[A-Za-z0-9._\-+/=]{12,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(api[_-]?key['\"\s:=]+)[A-Za-z0-9._\-+/=]{12,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(secret['\"\s:=]+)[A-Za-z0-9._\-+/=]{12,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(token['\"\s:=]+)[A-Za-z0-9._\-+/=]{16,}"), r"\1[REDACTED]"),
    (re.compile(r"sk-[A-Za-z0-9]{16,}"), "sk-[REDACTED]"),
]


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_ts(value: Any) -> Optional[dt.datetime]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # Accept seconds or milliseconds.
        if value > 10_000_000_000:
            value = value / 1000
        try:
            return dt.datetime.fromtimestamp(value, tz=dt.timezone.utc)
        except Exception:
            return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except Exception:
        return None


def iso(ts: Optional[dt.datetime]) -> str:
    if not ts:
        return "unknown-time"
    return ts.isoformat(timespec="seconds").replace("+00:00", "Z")


def wikilink_date(ts: Optional[dt.datetime], fallback_mtime: float) -> str:
    if not ts:
        ts = dt.datetime.fromtimestamp(fallback_mtime, tz=dt.timezone.utc)
    return f"[[{ts.date().isoformat()}]]"


def date_from_wikilink(value: str) -> str:
    if value.startswith("[[") and value.endswith("]]"):
        return value[2:-2]
    return value.strip("[]")


def yaml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    text = str(value)
    text = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{text}"'


def redact(text: str, enabled: bool = True) -> str:
    if not enabled:
        return text
    for pattern, repl in SECRET_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def stringify_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: List[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif isinstance(item.get("content"), str):
                    parts.append(item["content"])
                elif item.get("type") == "text" and isinstance(item.get("value"), str):
                    parts.append(item["value"])
                else:
                    parts.append(json.dumps(item, ensure_ascii=False, sort_keys=True))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p is not None)
    if isinstance(value, dict):
        if isinstance(value.get("text"), str):
            return value["text"]
        if isinstance(value.get("content"), str):
            return value["content"]
        return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    return str(value)


def normalize_record(raw: Dict[str, Any], idx: int) -> Dict[str, Any]:
    # Pi/Codex JSONL can nest message fields under "message".
    msg = raw.get("message") if isinstance(raw.get("message"), dict) else raw
    role = msg.get("role") or raw.get("role") or raw.get("type") or "unknown"
    content = msg.get("content", raw.get("content"))
    return {
        "index": idx,
        "role": str(role),
        "timestamp": parse_ts(msg.get("timestamp") or raw.get("timestamp") or msg.get("created_at") or raw.get("created_at")),
        "content": stringify_content(content),
        "tool_calls": msg.get("tool_calls") or raw.get("tool_calls") or msg.get("toolCalls") or raw.get("toolCalls"),
        "tool_call_id": msg.get("tool_call_id") or raw.get("tool_call_id") or msg.get("toolCallId") or raw.get("toolCallId"),
        "name": msg.get("name") or raw.get("name") or msg.get("toolName") or raw.get("toolName"),
        "raw_keys": sorted(raw.keys()),
    }


def load_json_session(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    obj = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("top-level JSON is not an object")
    messages = obj.get("messages")
    if messages is None and isinstance(obj.get("items"), list):
        messages = obj.get("items")
    if not isinstance(messages, list):
        # Treat single JSON object as one JSONL-like record.
        messages = [obj]
    meta = {k: v for k, v in obj.items() if k != "messages"}
    return meta, [normalize_record(m if isinstance(m, dict) else {"content": m}, i) for i, m in enumerate(messages, 1)]


def load_jsonl_session(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    messages: List[Dict[str, Any]] = []
    meta: Dict[str, Any] = {}
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as e:
                raw = {"role": "parse_error", "timestamp": None, "content": f"JSON parse error on line {line_no}: {e}"}
            if isinstance(raw, dict) and (raw.get("role") == "session_meta" or raw.get("type") == "session"):
                meta.update(raw)
            messages.append(normalize_record(raw if isinstance(raw, dict) else {"content": raw}, len(messages) + 1))
    return meta, messages


def discover_inputs(input_path: Path) -> List[Path]:
    if input_path.is_file():
        return [input_path]
    files: List[Path] = []
    for pattern in ("*.jsonl", "*.json"):
        files.extend(input_path.rglob(pattern))
    def keep(p: Path) -> bool:
        name = p.name.lower()
        if name == "sessions.json" or name.startswith("request_dump"):
            return False
        return True
    return sorted(p for p in files if keep(p))


def load_state(path: Optional[Path]) -> Dict[str, Any]:
    if not path or not path.exists():
        return {"files": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"files": {}}


def save_state(path: Optional[Path], state: Dict[str, Any]) -> None:
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def file_fingerprint(path: Path) -> Dict[str, Any]:
    st = path.stat()
    return {"mtime_ns": st.st_mtime_ns, "size": st.st_size}


def stable_slug(text: str, max_len: int = 80) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-._").lower()
    return (text[:max_len] or "session")


def infer_source(meta: Dict[str, Any], path: Path) -> str:
    for key in ("source", "platform", "origin", "channel", "job_name", "cron_name"):
        val = meta.get(key)
        if isinstance(val, str) and val:
            return stable_slug(val, 32)
    name = path.name.lower()
    if "cron" in name:
        return "cron"
    if "telegram" in name:
        return "telegram"
    return "hermes"


def session_id(meta: Dict[str, Any], path: Path) -> str:
    for key in ("session_id", "sessionId", "id"):
        val = meta.get(key)
        if isinstance(val, str) and val:
            return val
    return path.stem


def first_timestamp(meta: Dict[str, Any], messages: List[Dict[str, Any]], path: Path) -> Optional[dt.datetime]:
    for key in ("session_start", "created_at", "timestamp", "last_updated"):
        ts = parse_ts(meta.get(key))
        if ts:
            return ts
    for m in messages:
        if m.get("timestamp"):
            return m["timestamp"]
    return dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc)


def render_json_block(obj: Any, redact_enabled: bool, max_chars: int) -> str:
    text = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)
    text = redact(text, redact_enabled)
    if max_chars >= 0 and len(text) > max_chars:
        return f"```json\n{str(text[:max_chars])}\n... [collapsed {len(text) - max_chars} chars, sha256:{sha256_text(text)}]\n```"
    return f"```json\n{text}\n```"


def render_content(content: str, role: str, redact_enabled: bool, max_tool_chars: int, include_full_tool_output: bool) -> str:
    content = redact(content or "", redact_enabled).strip("\n")
    if role == "tool" and not include_full_tool_output and max_tool_chars >= 0 and len(content) > max_tool_chars:
        prefix = content[:max_tool_chars]
        return f"{prefix}\n\n> Tool output collapsed: {len(content) - max_tool_chars} chars omitted; sha256:{sha256_text(content)}"
    return content


def render_markdown(path: Path, rel_path: str, meta: Dict[str, Any], messages: List[Dict[str, Any]], args: argparse.Namespace) -> Tuple[str, str, str]:
    sid = session_id(meta, path)
    ts = first_timestamp(meta, messages, path)
    created = wikilink_date(ts, path.stat().st_mtime)
    source = infer_source(meta, path)
    date_dir = date_from_wikilink(created)
    out_name = f"{date_dir}--{source}--{stable_slug(sid, 40)}.md"

    frontmatter = {
        "created": created,
        "rendered_at": utc_now(),
        "session_id": sid,
        "source_kind": "hermes-jsonl" if path.suffix == ".jsonl" else "hermes-json",
        "source_file": rel_path,
        "message_count": len(messages),
        "privacy": "private-local",
        "derived_observations": False,
    }
    lines: List[str] = ["---"]
    for k, v in frontmatter.items():
        lines.append(f"{k}: {yaml_scalar(v)}")
    lines.extend(["---", "", f"# Hermes Session {sid}", ""])
    lines.extend([
        f"- Created: {created}",
        f"- Source file: `{rel_path}`",
        f"- Source kind: `{frontmatter['source_kind']}`",
        f"- Messages: {len(messages)}",
        f"- Derived observations: `false`",
        "",
        "## Messages",
        "",
    ])
    for i, m in enumerate(messages, 1):
        role = stable_slug(str(m.get("role") or "unknown"), 24)
        lines.append(f"### m{i:04d} · {role} · {iso(m.get('timestamp'))}")
        lines.append("")
        if m.get("name"):
            lines.append(f"- Name/tool: `{m['name']}`")
        if m.get("tool_call_id"):
            lines.append(f"- Tool call id: `{m['tool_call_id']}`")
        if m.get("name") or m.get("tool_call_id"):
            lines.append("")
        body = render_content(str(m.get("content") or ""), role, args.redact, args.max_tool_chars, args.include_full_tool_output)
        lines.append(body if body else "_(empty)_")
        lines.append("")
        if m.get("tool_calls"):
            lines.append("#### Tool calls")
            lines.append("")
            lines.append(render_json_block(m["tool_calls"], args.redact, args.max_metadata_chars))
            lines.append("")
    return "\n".join(lines).rstrip() + "\n", date_dir, out_name


def write_enzyme_config(output: Path) -> None:
    config = """# Generated by Hermes agent memory workspace session renderer.
vault:
  roots:
    - path: "."
      kind: "raw_session_transcripts"
frontmatter:
  created_field: "created"
  created_format: "wikilink-date"
  created_regex: '^\\[\\[\\d{4}-\\d{2}-\\d{2}\\]\\]$'
content:
  message_heading_regex: '^### m\\d{4} · (session_meta|user|assistant|tool|system|unknown|parse_error) · '
  derived_observations: false
privacy:
  raw_transcripts: true
  local_only: true
  default_redactions: true
"""
    (output / "enzyme.hermes-sessions.yaml").write_text(config, encoding="utf-8")


def write_index(output: Path) -> None:
    files = sorted(output.rglob("*.md"))
    entries = [p for p in files if p.name != "index.md"]
    lines = ["---", f'created: "[[{dt.date.today().isoformat()}]]"', f'rendered_at: "{utc_now()}"', 'kind: "hermes-sessions-index"', "---", "", "# Hermes Sessions Index", ""]
    current_dir = None
    for p in entries:
        rel = p.relative_to(output)
        if rel.parts[0] != current_dir:
            current_dir = rel.parts[0]
            lines.extend(["", f"## [[{current_dir}]]", ""])
        lines.append(f"- [{rel.as_posix()}]({rel.as_posix()})")
    (output / "index.md").write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="Hermes session file or directory containing .json/.jsonl files")
    ap.add_argument("--output", required=True, help="Output directory for Markdown files")
    ap.add_argument("--state", help="Renderer state file for --mode new")
    ap.add_argument("--mode", choices=["new", "all"], default="new", help="Render only changed/new files or all files")
    ap.add_argument("--max-tool-chars", type=int, default=4000, help="Chars of tool output to keep before collapsing; -1 disables collapse")
    ap.add_argument("--max-metadata-chars", type=int, default=12000, help="Chars of metadata/tool-call JSON to keep before collapsing")
    ap.add_argument("--include-full-tool-output", action="store_true", help="Do not collapse large tool outputs")
    ap.add_argument("--no-enzyme-config", dest="enzyme_config", action="store_false", help="Do not write enzyme.hermes-sessions.yaml")
    ap.add_argument("--no-redact", dest="redact", action="store_false", help="Disable default secret redaction (not recommended)")
    ap.set_defaults(redact=True, enzyme_config=True)
    args = ap.parse_args(argv)

    input_path = Path(args.input).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    state_path = Path(args.state).expanduser().resolve() if args.state else None
    output.mkdir(parents=True, exist_ok=True)
    state = load_state(state_path)
    state.setdefault("files", {})

    files = discover_inputs(input_path)
    rendered = 0
    skipped = 0
    errors: List[str] = []
    for f in files:
        fp = file_fingerprint(f)
        key = str(f)
        if args.mode == "new" and state["files"].get(key, {}).get("fingerprint") == fp:
            skipped += 1
            continue
        try:
            meta, messages = load_jsonl_session(f) if f.suffix == ".jsonl" else load_json_session(f)
            rel = os.path.relpath(f, input_path if input_path.is_dir() else input_path.parent)
            md, date_dir, out_name = render_markdown(f, rel, meta, messages, args)
            out_dir = output / date_dir
            out_dir.mkdir(parents=True, exist_ok=True)
            out_file = out_dir / out_name
            out_file.write_text(md, encoding="utf-8")
            state["files"][key] = {"fingerprint": fp, "output": str(out_file), "rendered_at": utc_now()}
            rendered += 1
        except Exception as e:
            errors.append(f"{f}: {e}")
    save_state(state_path, state)
    write_index(output)
    if args.enzyme_config:
        write_enzyme_config(output)
    print(json.dumps({"input": str(input_path), "output": str(output), "files_found": len(files), "rendered": rendered, "skipped": skipped, "errors": errors}, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
