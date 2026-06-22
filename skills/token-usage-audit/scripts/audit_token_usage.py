#!/usr/bin/env python3
"""Tenant-local token usage audit for AgentVillage.

The audit is intentionally deterministic: it reads local Hermes dashboard
session summaries and cron metadata, aggregates only token/tool counts, and
prints a final JSON line that Hermes script cron can use as a wake contract.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


SCHEMA = "agentvillage.token_usage_audit.v1"
DASHBOARD_URL = "http://127.0.0.1:9119"
SESSION_HEADER = "X-Hermes-Session-Token"
STATE_RELATIVE_PATH = Path("memory/token-usage-audit.json")

INPUT_KEYS = {
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "promptTokenCount",
    "inputTokenCount",
}
OUTPUT_KEYS = {
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "completionTokenCount",
    "outputTokenCount",
}
TOTAL_KEYS = {"total_tokens", "totalTokens", "tokens", "token_count", "tokenCount"}
TOOL_COUNT_KEYS = {"tool_calls", "toolCalls", "tool_call_count", "toolCallCount"}
TIME_KEYS = {
    "timestamp",
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
    "started_at",
    "startedAt",
    "ended_at",
    "endedAt",
    "last_run_at",
    "lastRunAt",
    "time",
    "ts",
    "date",
}
SOURCE_KEYS = {"source", "platform", "channel", "surface"}
MODEL_KEYS = {"model", "model_name", "modelName", "response_model", "responseModel"}
SESSION_KEYS = {"session_id", "sessionId", "session", "conversation_id", "conversationId", "thread_id", "threadId", "id"}
USAGE_CONTAINER_KEYS = {"usage", "token_usage", "tokenUsage", "token_counts", "tokenCounts"}
CRON_NAME_KEYS = {
    "cron_name",
    "cronName",
    "job_name",
    "jobName",
    "cronJobName",
    "cron_job_name",
    "scheduled_job_name",
    "scheduledJobName",
}
CRON_ID_KEYS = {
    "cron_id",
    "cronId",
    "job_id",
    "jobId",
    "cronJobId",
    "cron_job_id",
    "scheduled_job_id",
    "scheduledJobId",
}
CRON_CONTAINER_KEYS = {
    "cron",
    "job",
    "scheduled_job",
    "scheduledJob",
    "cron_job",
    "cronJob",
    "source_details",
    "sourceDetails",
    "details",
    "metadata",
    "meta",
}
CRON_RUN_TIME_KEYS = {
    "last_run_at",
    "lastRunAt",
    "last_started_at",
    "lastStartedAt",
    "started_at",
    "startedAt",
    "last_active_at",
    "lastActiveAt",
    "updated_at",
    "updatedAt",
}
BUDGET_REMAINING_KEYS = {
    "remaining_tokens",
    "remainingTokens",
    "budget_remaining_tokens",
    "budgetRemainingTokens",
    "tokenBudgetRemaining",
}
BUDGET_LIMIT_KEYS = {"token_budget", "tokenBudget", "budget_tokens", "budgetTokens", "tokenLimit"}
BUDGET_USED_KEYS = {"used_tokens", "usedTokens", "budget_used_tokens", "budgetUsedTokens"}

CRON_MATCH_BEFORE = timedelta(minutes=5)
CRON_MATCH_AFTER = timedelta(minutes=90)
MAX_TOP = 10
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_PARSE_ERRORS = 10
SECRETISH_PATH_PARTS = {
    ".env",
    "config.yaml",
    "config.yml",
    "USER.md",
    "MEMORY.md",
    "IDENTITY.md",
    "SOUL.md",
    "profile",
    "profiles",
    "pairing",
    "auth",
    "token",
    "tokens",
    "secret",
    "secrets",
    "key",
    "keys",
    "credentials",
    "cache",
    "node_modules",
    "skills",
    ".git",
}
METADATA_NAME_HINTS = ("session", "sessions", "usage", "trace", "response", "cron", "jobs", "jsonl", "log")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 10_000_000_000:
            seconds /= 1000.0
        try:
            return datetime.fromtimestamp(seconds, timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return parse_time(float(text))
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def safe_number(value: Any) -> int:
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value) if value >= 0 else 0
    if isinstance(value, str) and re.fullmatch(r"\d+(?:\.\d+)?", value.strip()):
        return int(float(value.strip()))
    return 0


def sanitize_label(value: Any, default: str = "unknown", limit: int = 80) -> str:
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    text = re.sub(r"https?://\S+", "[url]", text)
    text = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", "[email]", text)
    text = re.sub(r"[^A-Za-z0-9._:/+ -]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return default
    return text if len(text) <= limit else text[: limit - 3] + "..."


def value_for_keys(obj: dict[str, Any], keys: set[str]) -> Any:
    for key in keys:
        if key in obj:
            return obj.get(key)
    return None


def counts_from_obj(obj: dict[str, Any]) -> dict[str, int] | None:
    input_tokens = sum(safe_number(obj.get(key)) for key in INPUT_KEYS)
    output_tokens = sum(safe_number(obj.get(key)) for key in OUTPUT_KEYS)
    total_tokens = sum(safe_number(obj.get(key)) for key in TOTAL_KEYS)
    for key in USAGE_CONTAINER_KEYS:
        usage = obj.get(key)
        if isinstance(usage, dict):
            input_tokens += sum(safe_number(usage.get(k)) for k in INPUT_KEYS)
            output_tokens += sum(safe_number(usage.get(k)) for k in OUTPUT_KEYS)
            total_tokens += sum(safe_number(usage.get(k)) for k in TOTAL_KEYS)
    if not (input_tokens or output_tokens or total_tokens):
        return None
    total_tokens = max(total_tokens, input_tokens + output_tokens)
    tool_calls = sum(safe_number(obj.get(key)) for key in TOOL_COUNT_KEYS)
    if isinstance(obj.get("tool_calls"), list):
        tool_calls = max(tool_calls, len(obj["tool_calls"]))
    if isinstance(obj.get("toolCalls"), list):
        tool_calls = max(tool_calls, len(obj["toolCalls"]))
    return {
        "records": 1,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
        "toolCalls": tool_calls,
    }


def empty_counts() -> dict[str, int]:
    return {"records": 0, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "toolCalls": 0}


def merge_counts(target: dict[str, int], counts: dict[str, int]) -> None:
    for key in ("records", "inputTokens", "outputTokens", "totalTokens", "toolCalls"):
        target[key] += counts.get(key, 0)


def first_time(obj: dict[str, Any]) -> datetime | None:
    for key in TIME_KEYS:
        parsed = parse_time(obj.get(key))
        if parsed:
            return parsed
    return None


def detect_source(obj: dict[str, Any], default: str = "unknown") -> str:
    value = value_for_keys(obj, SOURCE_KEYS)
    origin = obj.get("origin")
    if value is None and isinstance(origin, dict):
        value = value_for_keys(origin, SOURCE_KEYS)
    return sanitize_label(value, default)


def detect_model(obj: dict[str, Any], default: str = "unknown") -> str:
    return sanitize_label(value_for_keys(obj, MODEL_KEYS), default)


def detect_session_key(obj: dict[str, Any], fallback: str) -> str:
    value = value_for_keys(obj, SESSION_KEYS)
    text = str(value).strip() if value is not None else ""
    return text or fallback


def parse_sessions_list(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("data", "sessions", "items", "results"):
            value = data.get(key)
            if isinstance(value, list):
                return value
    return []


def cron_public_name(job: dict[str, Any]) -> str:
    for key in ("name", "title", "display_name", "displayName"):
        if job.get(key):
            return sanitize_label(job.get(key), "unnamed")
    return "unnamed"


def cron_id_values(job: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for key in CRON_ID_KEYS | {"id", "uuid", "key"}:
        value = job.get(key)
        if value is not None and str(value).strip():
            values.append(str(value).strip())
    return values


def cron_run_time(job: dict[str, Any]) -> datetime | None:
    for key in CRON_RUN_TIME_KEYS:
        parsed = parse_time(job.get(key))
        if parsed:
            return parsed
    return None


def cron_schedule(job: dict[str, Any]) -> str:
    schedule = job.get("schedule_display") or job.get("schedule") or ""
    if isinstance(schedule, dict):
        schedule = schedule.get("display") or schedule.get("expr") or schedule.get("kind") or ""
    return sanitize_label(schedule, "unknown")


@dataclass
class CronRun:
    name: str
    ids: list[str]
    last_run: datetime | None


def load_crons(root: Path, since: datetime, now: datetime) -> tuple[dict[str, Any], dict[str, Any]]:
    public: dict[str, Any] = {"available": False, "totalJobs": 0, "recentRuns": 0, "jobs": []}
    index: dict[str, Any] = {"byId": {}, "byName": {}, "runs": []}
    jobs_file = root / "cron" / "jobs.json"
    if not jobs_file.exists():
        return public, index
    public["available"] = True
    try:
        data = json.loads(jobs_file.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001 - error type only is emitted.
        public["error"] = f"cron_jobs_parse_error:{type(exc).__name__}"
        return public, index
    jobs = data.get("jobs") if isinstance(data, dict) else data if isinstance(data, list) else []
    if not isinstance(jobs, list):
        public["error"] = "cron_jobs_shape_error"
        return public, index
    public["totalJobs"] = len(jobs)
    for job in jobs:
        if not isinstance(job, dict):
            continue
        name = cron_public_name(job)
        last_run = cron_run_time(job)
        recent = bool(last_run and since <= last_run <= now)
        if recent:
            public["recentRuns"] += 1
        run = CronRun(name=name, ids=cron_id_values(job), last_run=last_run)
        for cron_id in run.ids:
            index["byId"][cron_id] = run
        index["byName"][name.lower()] = run
        if run.last_run:
            index["runs"].append(run)
        public["jobs"].append(
            {
                "name": name,
                "enabled": bool(job.get("enabled", True)),
                "state": sanitize_label(job.get("state"), "unknown"),
                "deliver": sanitize_label(job.get("deliver"), "none"),
                "schedule": cron_schedule(job),
                "lastRunInWindow": recent,
                "lastStatus": sanitize_label(job.get("last_status"), "unknown"),
                "scriptPresent": bool(job.get("script")),
                "promptExcluded": True,
            }
        )
    public["jobs"].sort(key=lambda row: (not row["lastRunInWindow"], row["name"]))
    return public, index


def find_cron_metadata(obj: dict[str, Any], depth: int = 0) -> dict[str, Any]:
    if depth > 3:
        return {}
    name = value_for_keys(obj, CRON_NAME_KEYS)
    cron_id = value_for_keys(obj, CRON_ID_KEYS)
    if name or cron_id:
        return {"name": name, "id": cron_id}
    for key in CRON_CONTAINER_KEYS:
        value = obj.get(key)
        if not isinstance(value, dict):
            continue
        result = find_cron_metadata(value, depth + 1)
        generic_name = value_for_keys(value, {"name", "title", "display_name", "displayName"})
        if result or generic_name:
            result = dict(result)
            if generic_name and not result.get("name"):
                result["name"] = generic_name
            return result
    return {}


def default_attribution(method: str) -> dict[str, Any]:
    return {"cronName": "unknown", "method": method, "confidence": "none", "ambiguityCount": 0}


def attribution_from_run(run: CronRun, method: str, confidence: str, candidate_count: int = 1) -> dict[str, Any]:
    return {
        "cronName": sanitize_label(run.name, "unknown"),
        "method": method,
        "confidence": confidence,
        "ambiguityCount": max(0, candidate_count - 1),
    }


def attribute_cron(session: dict[str, Any], session_time: datetime | None, cron_index: dict[str, Any]) -> dict[str, Any]:
    metadata = find_cron_metadata(session)
    raw_id = metadata.get("id")
    if raw_id is not None:
        run = cron_index["byId"].get(str(raw_id).strip())
        if run:
            return attribution_from_run(run, "metadata_id", "high")
    raw_name = metadata.get("name")
    if raw_name is not None:
        name = sanitize_label(raw_name, "unknown")
        run = cron_index["byName"].get(name.lower())
        if run:
            return attribution_from_run(run, "metadata_name", "high")
        if name != "unknown":
            return {"cronName": name, "method": "metadata_name_unverified", "confidence": "medium", "ambiguityCount": 0}
    if not session_time:
        return default_attribution("missing_session_timestamp")
    candidates: list[tuple[float, CronRun]] = []
    for run in cron_index["runs"]:
        if not run.last_run:
            continue
        if run.last_run - CRON_MATCH_BEFORE <= session_time <= run.last_run + CRON_MATCH_AFTER:
            delta = abs((session_time - run.last_run).total_seconds())
            candidates.append((delta, run))
    if not candidates:
        return default_attribution("time_window_no_match")
    candidates.sort(key=lambda item: (item[0], item[1].name))
    best_delta, best_run = candidates[0]
    confidence = "medium" if len(candidates) == 1 else "low"
    method = "time_window_nearest" if len(candidates) == 1 else "time_window_nearest_ambiguous"
    attribution = attribution_from_run(best_run, method, confidence, len(candidates))
    if best_delta > 45 * 60:
        attribution["confidence"] = "low"
    return attribution


class AuditState:
    def __init__(self) -> None:
        self.totals = empty_counts()
        self.by_source: dict[str, dict[str, int]] = defaultdict(empty_counts)
        self.by_model: dict[str, dict[str, int]] = defaultdict(empty_counts)
        self.by_cron: dict[str, dict[str, int]] = defaultdict(empty_counts)
        self.by_cron_attribution: dict[tuple[str, str], dict[str, int]] = defaultdict(empty_counts)
        self.by_session: dict[str, dict[str, int]] = defaultdict(empty_counts)
        self.session_cron: dict[str, dict[str, Any]] = {}
        self.budget_signals: list[dict[str, Any]] = []

    def add_record(
        self,
        counts: dict[str, int],
        source: str,
        model: str,
        session_key: str,
        attribution: dict[str, Any] | None,
        budget: dict[str, Any] | None = None,
    ) -> None:
        merge_counts(self.totals, counts)
        merge_counts(self.by_source[source], counts)
        merge_counts(self.by_model[model], counts)
        merge_counts(self.by_session[session_key], counts)
        if attribution:
            merge_counts(self.by_cron[attribution["cronName"]], counts)
            merge_counts(self.by_cron_attribution[(attribution["method"], attribution["confidence"])], counts)
            self.session_cron[session_key] = attribution
        if budget:
            self.budget_signals.append(budget)


def extract_budget_signal(obj: dict[str, Any]) -> dict[str, Any] | None:
    remaining = safe_number(value_for_keys(obj, BUDGET_REMAINING_KEYS))
    limit = safe_number(value_for_keys(obj, BUDGET_LIMIT_KEYS))
    used = safe_number(value_for_keys(obj, BUDGET_USED_KEYS))
    if not (remaining or limit or used):
        usage = obj.get("usage")
        if isinstance(usage, dict):
            remaining = safe_number(value_for_keys(usage, BUDGET_REMAINING_KEYS))
            limit = safe_number(value_for_keys(usage, BUDGET_LIMIT_KEYS))
            used = safe_number(value_for_keys(usage, BUDGET_USED_KEYS))
    if not (remaining or limit or used):
        return None
    return {"remainingTokens": remaining, "budgetTokens": limit, "usedTokens": used}


def dashboard_get(url: str, path: str, token: str | None = None, timeout: float = 10.0) -> str:
    request = urllib.request.Request(url.rstrip("/") + path)
    if token:
        request.add_header(SESSION_HEADER, token)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def dashboard_token(url: str) -> str | None:
    html = dashboard_get(url, "/")
    match = re.search(r'window\.__HERMES_SESSION_TOKEN__="([^"]+)"', html)
    return match.group(1) if match else None


def collect_dashboard_sessions(
    audit: AuditState,
    cron_index: dict[str, Any],
    since: datetime,
    now: datetime,
    url: str,
    sessions_file: Path | None = None,
) -> dict[str, Any]:
    details: dict[str, Any] = {
        "available": False,
        "sessionsSeen": 0,
        "sessionsInWindow": 0,
        "usageRecords": 0,
        "error": None,
    }
    try:
        if sessions_file:
            data = json.loads(sessions_file.read_text(encoding="utf-8"))
        else:
            token = dashboard_token(url)
            if not token:
                details["error"] = "dashboard_session_token_missing"
                return details
            data = json.loads(dashboard_get(url, "/api/sessions?limit=500", token=token))
        sessions = parse_sessions_list(data)
        details["available"] = True
        details["sessionsSeen"] = len(sessions)
        for idx, session in enumerate(sessions, 1):
            if not isinstance(session, dict):
                continue
            ts = first_time(session)
            if not ts or not (since <= ts <= now):
                continue
            details["sessionsInWindow"] += 1
            counts = counts_from_obj(session)
            if not counts:
                continue
            attribution = attribute_cron(session, ts, cron_index)
            audit.add_record(
                counts,
                detect_source(session),
                detect_model(session),
                detect_session_key(session, f"dashboard:{idx}"),
                attribution,
                extract_budget_signal(session),
            )
            details["usageRecords"] += 1
    except Exception as exc:  # noqa: BLE001 - sanitized error only.
        details["error"] = f"dashboard_fetch_error:{type(exc).__name__}"
    return details


def should_scan(path: Path, root: Path) -> bool:
    try:
        rel = path.relative_to(root)
    except ValueError:
        rel = path
    parts = {part.lower() for part in rel.parts}
    if any(part in SECRETISH_PATH_PARTS for part in parts):
        return False
    if path.suffix.lower() not in {".json", ".jsonl"}:
        return False
    joined = "/".join(rel.parts).lower()
    return any(hint in joined for hint in METADATA_NAME_HINTS)


def iter_json_records(path: Path) -> Any:
    if path.suffix.lower() == ".jsonl":
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                text = line.strip()
                if text:
                    yield json.loads(text)
        return
    yield json.loads(path.read_text(encoding="utf-8", errors="replace"))


def collect_file_fallback(audit: AuditState, root: Path, since: datetime, now: datetime) -> dict[str, Any]:
    details = {"enabled": True, "filesScanned": 0, "recordsParsed": 0, "usageRecords": 0, "parseErrorCount": 0}
    errors = 0
    for path in root.rglob("*"):
        if not path.is_file() or not should_scan(path, root):
            continue
        details["filesScanned"] += 1
        try:
            stat = path.stat()
        except OSError:
            continue
        if stat.st_size > MAX_FILE_BYTES:
            continue
        file_time = datetime.fromtimestamp(stat.st_mtime, timezone.utc)
        if file_time < since - timedelta(hours=12):
            continue
        try:
            for record in iter_json_records(path):
                details["recordsParsed"] += 1
                if isinstance(record, dict):
                    ts = first_time(record) or file_time
                    counts = counts_from_obj(record)
                    if counts and since <= ts <= now:
                        audit.add_record(
                            counts,
                            detect_source(record),
                            detect_model(record),
                            f"file:{details['usageRecords'] + 1}",
                            None,
                            extract_budget_signal(record),
                        )
                        details["usageRecords"] += 1
        except Exception:
            errors += 1
            details["parseErrorCount"] = min(errors, MAX_PARSE_ERRORS)
    return details


def sorted_rollup(mapping: dict[str, dict[str, int]]) -> list[dict[str, Any]]:
    rows = [{"label": sanitize_label(label), **counts} for label, counts in mapping.items()]
    rows.sort(key=lambda row: (row["totalTokens"], row["records"]), reverse=True)
    return rows[:MAX_TOP]


def sorted_attribution_rollup(mapping: dict[tuple[str, str], dict[str, int]]) -> list[dict[str, Any]]:
    rows = [
        {"method": sanitize_label(method), "confidence": sanitize_label(confidence), **counts}
        for (method, confidence), counts in mapping.items()
    ]
    rows.sort(key=lambda row: (row["totalTokens"], row["records"]), reverse=True)
    return rows[:MAX_TOP]


def session_rollup(audit: AuditState) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    items = sorted(audit.by_session.items(), key=lambda item: (item[1]["totalTokens"], item[1]["records"]), reverse=True)
    for idx, (raw_session, counts) in enumerate(items[:MAX_TOP], 1):
        row: dict[str, Any] = {"sessionRef": f"session_{idx:03d}", **counts}
        attribution = audit.session_cron.get(raw_session)
        if attribution:
            row["cronName"] = attribution["cronName"]
            row["cronAttribution"] = {
                "method": attribution["method"],
                "confidence": attribution["confidence"],
                "ambiguityCount": attribution["ambiguityCount"],
            }
        rows.append(row)
    return rows


def pct(part: int, total: int) -> float:
    return round((part / total) * 100, 1) if total else 0.0


def driver_key(driver: dict[str, Any]) -> str:
    return sanitize_label(f"{driver.get('type')}:{driver.get('name')}", "unknown", limit=120)


def driver_priority(driver: dict[str, Any]) -> int:
    priorities = {
        "low_budget": 5,
        "single_cron": 4,
        "single_session": 3,
        "unknown_cron_bucket": 2,
        "cron_share": 1,
    }
    return priorities.get(str(driver.get("type")), 0)


def load_state(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def decide_alert(
    result: dict[str, Any],
    state: dict[str, Any],
    now: datetime,
    cooldown_hours: float,
    total_threshold: int,
) -> tuple[bool, dict[str, Any] | None]:
    total = result["totals"]["totalTokens"]
    by_cron = result["byCron"]
    by_source = result["bySource"]
    top_sessions = result["topSessions"]
    budget_signals = result.get("budgetSignals", [])
    candidates: list[dict[str, Any]] = []

    if total >= total_threshold:
        cron_tokens = sum(row["totalTokens"] for row in by_source if row["label"].lower() == "cron")
        if cron_tokens >= total * 0.60:
            candidates.append(
                {
                    "type": "cron_share",
                    "name": "scheduled background work",
                    "reason": "cron_source_share",
                    "totalTokens": cron_tokens,
                    "sharePct": pct(cron_tokens, total),
                    "confidence": "medium",
                    "action": "Review scheduled jobs and pause or narrow the background driver if this spend was unexpected.",
                }
            )
        for row in by_cron:
            name = row["label"]
            share = row["totalTokens"] / total if total else 0
            if name != "unknown" and row["totalTokens"] >= 50_000 and share >= 0.40:
                attr = next((s for s in top_sessions if s.get("cronName") == name), {})
                cron_attr = attr.get("cronAttribution", {})
                if cron_attr.get("confidence") in {"high", "medium"}:
                    candidates.append(
                        {
                            "type": "single_cron",
                            "name": name,
                            "reason": "single_cron_driver",
                            "totalTokens": row["totalTokens"],
                            "sharePct": pct(row["totalTokens"], total),
                            "confidence": cron_attr.get("confidence", "medium"),
                            "attribution": cron_attr,
                            "action": "Consider pausing this cron or narrowing its prompt/script before the next run.",
                        }
                    )
            if name == "unknown" and (row["totalTokens"] >= 500_000 or share >= 0.50):
                candidates.append(
                    {
                        "type": "unknown_cron_bucket",
                        "name": "unknown scheduled work",
                        "reason": "unknown_cron_bucket",
                        "totalTokens": row["totalTokens"],
                        "sharePct": pct(row["totalTokens"], total),
                        "confidence": "none",
                        "action": "Check recently-run cron jobs; attribution was intentionally left unknown rather than guessed.",
                    }
                )
        for row in top_sessions:
            if row["totalTokens"] >= 250_000:
                name = row.get("cronName") or row["sessionRef"]
                candidates.append(
                    {
                        "type": "single_session",
                        "name": name,
                        "reason": "single_session_spike",
                        "totalTokens": row["totalTokens"],
                        "sharePct": pct(row["totalTokens"], total),
                        "confidence": row.get("cronAttribution", {}).get("confidence", "medium"),
                        "attribution": row.get("cronAttribution"),
                        "action": "Inspect the named cron if present; otherwise look for one unusually large recent session.",
                    }
                )
    for budget in budget_signals:
        remaining = safe_number(budget.get("remainingTokens"))
        limit = safe_number(budget.get("budgetTokens"))
        used = safe_number(budget.get("usedTokens"))
        if remaining and remaining <= 50_000:
            candidates.append(
                {
                    "type": "low_budget",
                    "name": "token budget",
                    "reason": "low_budget_remaining",
                    "remainingTokens": remaining,
                    "budgetTokens": limit,
                    "usedTokens": used,
                    "confidence": "high",
                    "action": "Reduce or pause scheduled background work until budget is refreshed.",
                }
            )
        elif limit and used and used >= limit * 0.80:
            candidates.append(
                {
                    "type": "low_budget",
                    "name": "token budget",
                    "reason": "budget_usage_high",
                    "remainingTokens": remaining,
                    "budgetTokens": limit,
                    "usedTokens": used,
                    "confidence": "high",
                    "action": "Reduce or pause scheduled background work until budget is refreshed.",
                }
            )

    if not candidates:
        return False, None

    if any(candidate.get("type") in {"single_cron", "single_session", "unknown_cron_bucket"} for candidate in candidates):
        candidates = [candidate for candidate in candidates if candidate.get("type") != "cron_share"]

    candidates.sort(
        key=lambda candidate: (
            driver_priority(candidate),
            safe_number(candidate.get("totalTokens")),
            safe_number(candidate.get("usedTokens")),
            safe_number(candidate.get("remainingTokens")) * -1,
        ),
        reverse=True,
    )
    last_alerts = state.get("lastAlerts", {}) if isinstance(state.get("lastAlerts"), dict) else {}
    for candidate in candidates:
        key = driver_key(candidate)
        last = parse_time(last_alerts.get(key))
        if last and now - last < timedelta(hours=cooldown_hours):
            candidate["cooldownActive"] = True
            candidate["lastAlertAt"] = last.isoformat()
            continue
        candidate["driverKey"] = key
        return True, candidate
    return False, {"suppressedByCooldown": True, "candidateCount": len(candidates)}


def run_audit(
    root: Path,
    lookback_hours: float,
    dashboard_url: str = DASHBOARD_URL,
    dashboard_sessions_file: Path | None = None,
    file_fallback: bool = True,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or now_utc()
    since = now - timedelta(hours=lookback_hours)
    cron_public, cron_index = load_crons(root, since, now)
    audit = AuditState()
    dashboard = collect_dashboard_sessions(audit, cron_index, since, now, dashboard_url, dashboard_sessions_file)
    file_details = {"enabled": False, "reason": "dashboard_usage_available"}
    if file_fallback and dashboard["usageRecords"] == 0:
        file_details = collect_file_fallback(audit, root, since, now)
    return {
        "schema": SCHEMA,
        "generatedAt": now.isoformat(),
        "lookbackHours": lookback_hours,
        "privacy": {
            "redacted": True,
            "rawContentIncluded": False,
            "rawSessionIdsIncluded": False,
            "privateHostsIncluded": False,
            "secretsIncluded": False,
            "notes": [
                "Dashboard session ids are used only for in-process grouping and emitted as ordinal session refs.",
                "Cron prompts, message text, env files, config files, profiles, secrets, and memory prose are excluded.",
            ],
        },
        "coverage": {
            "root": "HERMES_HOME",
            "dashboardLocalApi": dashboard,
            "fileFallback": file_details,
            "countingMethod": "local dashboard session token summaries; metadata JSON fallback only when dashboard usage is unavailable",
        },
        "totals": audit.totals,
        "bySource": sorted_rollup(audit.by_source),
        "byModel": sorted_rollup(audit.by_model),
        "byCron": sorted_rollup(audit.by_cron),
        "byCronAttribution": sorted_attribution_rollup(audit.by_cron_attribution),
        "topSessions": session_rollup(audit),
        "budgetSignals": audit.budget_signals[:MAX_TOP],
        "cron": cron_public,
    }


def alert_prompt(result: dict[str, Any], driver: dict[str, Any]) -> str:
    safe_payload = {
        "schema": result["schema"],
        "wakeAgent": True,
        "generatedAt": result["generatedAt"],
        "lookbackHours": result["lookbackHours"],
        "driver": driver,
        "totals": result["totals"],
        "bySource": result["bySource"][:5],
        "byModel": result["byModel"][:5],
        "byCron": result["byCron"][:5],
        "byCronAttribution": result["byCronAttribution"][:5],
        "topSessions": result["topSessions"][:5],
        "privacy": result["privacy"],
    }
    return "\n".join(
        [
            "# AgentVillage Token Usage Audit",
            "",
            "A deterministic local audit found an actionable token usage driver.",
            "Use only these sanitized facts. Do not mention raw session ids, private hosts, prompts, transcripts, or secrets.",
            "If messaging the resident, keep it brief: name the likely scheduled driver when confidence is high/medium, explain that background work drove spend, and suggest pausing or reporting the driver.",
            "",
            "```json",
            json.dumps(safe_payload, indent=2, sort_keys=True),
            "```",
            json.dumps({"wakeAgent": True, "driver": driver}, sort_keys=True, separators=(",", ":")),
        ]
    )


def update_run_state(
    state: dict[str, Any],
    result: dict[str, Any],
    now: datetime,
    wake: bool,
    driver: dict[str, Any] | None,
) -> dict[str, Any]:
    next_state = dict(state)
    next_state["schema"] = SCHEMA
    next_state["lastRunAt"] = now.isoformat()
    next_state["lastTotals"] = result["totals"]
    if wake and driver and driver.get("driverKey"):
        alerts = next_state.get("lastAlerts") if isinstance(next_state.get("lastAlerts"), dict) else {}
        alerts[driver["driverKey"]] = now.isoformat()
        next_state["lastAlerts"] = alerts
        next_state["lastAlert"] = {"at": now.isoformat(), "driver": driver}
    return next_state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.environ.get("HERMES_HOME") or os.environ.get("HOME") or ".")
    parser.add_argument("--lookback-hours", type=float, default=float(os.environ.get("TOKEN_USAGE_AUDIT_LOOKBACK_HOURS", "24")))
    parser.add_argument("--cooldown-hours", type=float, default=float(os.environ.get("TOKEN_USAGE_AUDIT_COOLDOWN_HOURS", "72")))
    parser.add_argument("--total-threshold", type=int, default=int(os.environ.get("TOKEN_USAGE_AUDIT_TOTAL_THRESHOLD", "100000")))
    parser.add_argument("--dashboard-url", default=os.environ.get("TOKEN_USAGE_AUDIT_DASHBOARD_URL", DASHBOARD_URL))
    parser.add_argument("--dashboard-sessions-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--no-file-fallback", action="store_true")
    parser.add_argument("--json-only", action="store_true", help="Print the full audit JSON and skip prompt text.")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    state_path = root / STATE_RELATIVE_PATH
    now = now_utc()
    state = load_state(state_path)
    result = run_audit(
        root=root,
        lookback_hours=args.lookback_hours,
        dashboard_url=args.dashboard_url,
        dashboard_sessions_file=args.dashboard_sessions_file,
        file_fallback=not args.no_file_fallback,
        now=now,
    )
    wake, driver = decide_alert(result, state, now, args.cooldown_hours, args.total_threshold)
    save_state(state_path, update_run_state(state, result, now, wake, driver if wake else None))

    if args.json_only:
        print(json.dumps({**result, "wakeAgent": wake, "driver": driver}, sort_keys=True, separators=(",", ":")))
    elif wake and driver:
        print(alert_prompt(result, driver))
    else:
        print(json.dumps({"wakeAgent": False}, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - sanitize failure for cron.
        safe = {
            "schema": SCHEMA,
            "generatedAt": now_utc().isoformat(),
            "error": "audit_script_failed",
            "errorType": type(exc).__name__,
            "wakeAgent": False,
        }
        print(json.dumps(safe, sort_keys=True, separators=(",", ":")))
        raise SystemExit(1)
